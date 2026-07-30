//! Native llama.cpp AI backend.
//!
//! On the web the AI assistant runs with WebLLM, which needs WebGPU. The desktop
//! webview (WKWebView on macOS, WebKitGTK on Linux) does not expose WebGPU, so
//! WebLLM can never load there. Instead, on the desktop we run inference
//! natively: we download a prebuilt `llama.cpp` release (`llama-server`) and a
//! GGUF model, start the server bound to `127.0.0.1`, and proxy chat completions
//! to it — streaming tokens back to the webview. The user does nothing: the
//! first message triggers the download + server start under the hood.
//!
//! ## Why proxy through Rust instead of `fetch`-ing the local server directly
//! The webview runs in a secure context (`tauri://localhost`). Fetching a plain
//! `http://127.0.0.1:PORT` from there is mixed content and gets blocked. Routing
//! the request through this native command sidesteps that entirely and matches
//! the streaming pattern already used by the Node runtime (`node://output`).
//!
//! ## Layout (all under `<app_data>/llama/`)
//! - `bin/`            extracted llama.cpp release (server binary + shared libs)
//! - `binary.json`     `{ "path": "…/llama-server" }` so we skip GitHub on reuse
//! - `models/*.gguf`   downloaded model weights

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// Pinned llama.cpp release. We pin a specific build instead of querying the
/// GitHub API for two reasons: (a) `api.github.com` is rate-limited to 60
/// requests/hour per IP (unauthenticated), which is trivially exhausted; and
/// (b) recent llama.cpp releases stopped shipping prebuilt macOS/Linux
/// binaries — `b6900` is the last line that publishes a `llama-server` for
/// every desktop platform. Its OpenAI-compatible server and GGUF support are
/// stable, so pinning is safe. Bump this tag to move to a newer build (only to
/// one that still ships macOS/Linux assets). Download URLs are built directly
/// from the tag, so no GitHub API call is ever made.
const LLAMA_RELEASE_TAG: &str = "b6900";
/// How long to wait for `llama-server` to answer `/health` after spawning it.
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(90);

// --- model catalog ---------------------------------------------------------

/// A downloadable GGUF model. Kept tiny and instruct-tuned so it loads on any
/// machine without a GPU. `size_bytes` is the real file size (verified against
/// Hugging Face) and drives the download progress bar before the first byte.
struct CatalogModel {
    id: &'static str,
    name: &'static str,
    url: &'static str,
    filename: &'static str,
    size_bytes: u64,
    params: &'static str,
}

// Code-specialised models: this is a JS/TS playground and the assistant is an
// action-emitting coding agent, so a coder model gives cleaner, more useful
// output than a general chat model of the same size. These are also non-"thinking"
// models — unlike the small Qwen3 hybrids, which burn the token budget on a
// <think> block and can return empty content, they answer directly.
const MODELS: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen2.5-coder-0.5b",
        name: "Qwen2.5 Coder 0.5B",
        url: "https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf?download=true",
        filename: "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
        size_bytes: 397_808_288,
        params: "0.5B",
    },
    CatalogModel {
        id: "qwen2.5-coder-1.5b",
        name: "Qwen2.5 Coder 1.5B",
        url: "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf?download=true",
        filename: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
        size_bytes: 986_048_800,
        params: "1.5B",
    },
    CatalogModel {
        id: "qwen2.5-coder-3b",
        name: "Qwen2.5 Coder 3B",
        url: "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf?download=true",
        filename: "Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
        size_bytes: 1_929_903_360,
        params: "3B",
    },
];

/// Default model: code-specialised, non-thinking, ~940MB — the best quality/size
/// balance for this coding playground that still loads on any laptop.
const DEFAULT_MODEL_ID: &str = "qwen2.5-coder-1.5b";

fn find_model(id: &str) -> Option<&'static CatalogModel> {
    MODELS.iter().find(|m| m.id == id)
}

fn resolve_model_id(id: Option<&str>) -> &'static CatalogModel {
    id.and_then(find_model)
        .unwrap_or_else(|| find_model(DEFAULT_MODEL_ID).unwrap())
}

// --- shared state ----------------------------------------------------------

/// The running `llama-server`, if any. Only one server runs at a time; switching
/// models tears down the old one first. `generation` lets an in-flight
/// `llama_generate` notice a cancel/stop and abort its streaming read.
pub struct LlamaState(pub Arc<LlamaInner>);

pub struct LlamaInner {
    server: Mutex<Option<ServerProcess>>,
    generation: AtomicU64,
    active_request_id: Mutex<Option<String>>,
}

struct ServerProcess {
    child: Child,
    port: u16,
    model_id: String,
}

impl Default for LlamaState {
    fn default() -> Self {
        LlamaState(Arc::new(LlamaInner {
            server: Mutex::new(None),
            generation: AtomicU64::new(0),
            active_request_id: Mutex::new(None),
        }))
    }
}

/// Terminate the complete server process tree. llama-server may create helper
/// processes, and leaving those behind can keep model files or ports locked.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // start_server places llama-server in its own process group.
        let pgid = child.id() as i32;
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        kill_tree(&mut self.child);
    }
}

// --- serialized types ------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    id: String,
    name: String,
    params: String,
    size_bytes: u64,
    installed: bool,
    is_default: bool,
}

#[derive(Serialize, Clone)]
pub struct LlamaInfo {
    /// Whether the llama.cpp server binary has been downloaded and extracted.
    binary_installed: bool,
    /// Model id currently served by a running server, if any.
    running_model_id: Option<String>,
    /// The catalog, annotated with which models are already on disk.
    models: Vec<ModelInfo>,
    default_model_id: String,
}

/// Download / setup progress, emitted as `llama://progress` so the UI can show
/// "Downloading model… 42%" without a blocking modal.
#[derive(Serialize, Clone)]
struct Progress {
    /// "binary" | "model" | "starting" | "ready"
    phase: &'static str,
    model_id: String,
    downloaded: u64,
    total: u64,
    message: String,
}

/// One streamed token of an assistant reply, emitted as `llama://token`. The
/// frontend matches `id` to the request it started so overlapping generations
/// (there should be at most one) can't cross wires.
#[derive(Serialize, Clone)]
struct TokenChunk {
    id: String,
    token: String,
}

// --- paths -----------------------------------------------------------------

fn llama_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let dir = base.join("llama");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create llama dir: {e}"))?;
    Ok(dir)
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = llama_dir(app)?.join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create models dir: {e}"))?;
    Ok(dir)
}

fn model_path(app: &AppHandle, model: &CatalogModel) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(model.filename))
}

/// Path to the extracted `llama-server` binary, remembered across launches in
/// `binary.json` so we only hit the GitHub API on the very first install.
fn binary_record_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(llama_dir(app)?.join("binary.json"))
}

fn read_binary_path(app: &AppHandle) -> Option<PathBuf> {
    let record = binary_record_path(app).ok()?;
    let text = fs::read_to_string(record).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let path = PathBuf::from(value.get("path")?.as_str()?);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn write_binary_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    let record = binary_record_path(app)?;
    let value = json!({ "path": path.to_string_lossy() });
    fs::write(&record, serde_json::to_vec_pretty(&value).unwrap())
        .map_err(|e| format!("cannot persist binary path: {e}"))
}

// --- http client -----------------------------------------------------------

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // GitHub rejects requests without a User-Agent; be a good citizen.
        .user_agent("GoJS-Desktop")
        .timeout(None)
        .build()
        .map_err(|e| format!("cannot build http client: {e}"))
}

// --- llama.cpp binary resolution -------------------------------------------

/// Release asset (zip) that ships `llama-server` for the current platform, and
/// its direct download URL — built from the pinned tag, no GitHub API involved.
/// CPU builds are chosen on Windows/Linux so they run without a specific
/// GPU/driver; the macOS build ships Metal acceleration out of the box.
fn asset_suffix(os: &str, arch: &str) -> Result<&'static str, String> {
    Ok(match (os, arch) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        ("linux", "x86_64") => "ubuntu-x64",
        ("windows", "x86_64") => "win-cpu-x64",
        ("windows", "aarch64") => "win-cpu-arm64",
        _ => return Err(format!("no prebuilt llama.cpp binary for {os}/{arch}")),
    })
}

fn asset_url() -> Result<String, String> {
    let suffix = asset_suffix(std::env::consts::OS, std::env::consts::ARCH)?;
    Ok(format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_RELEASE_TAG}/llama-{LLAMA_RELEASE_TAG}-bin-{suffix}.zip"
    ))
}

/// Download `url` to `dest`, emitting progress. `total_hint` is used when the
/// server doesn't report a content length (some CDNs omit it after redirects).
fn download_with_progress(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    phase: &'static str,
    model_id: &str,
    total_hint: u64,
) -> Result<(), String> {
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("download request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?;

    let total = response
        .content_length()
        .unwrap_or(total_hint)
        .max(total_hint);

    // Download to a temp file, then rename, so an interrupted download never
    // looks like a complete install.
    let tmp = dest.with_extension("part");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("cannot create {tmp:?}: {e}"))?;

    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|e| format!("download read error: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read])
            .map_err(|e| format!("cannot write download: {e}"))?;
        downloaded += read as u64;
        // Emit at most ~every 2MB to avoid flooding the event bus.
        if downloaded - last_emit >= 2 * 1024 * 1024 {
            last_emit = downloaded;
            let _ = app.emit(
                "llama://progress",
                Progress {
                    phase,
                    model_id: model_id.to_string(),
                    downloaded,
                    total,
                    message: String::new(),
                },
            );
        }
    }
    file.flush()
        .map_err(|e| format!("cannot flush download: {e}"))?;
    drop(file);
    fs::rename(&tmp, dest).map_err(|e| format!("cannot finalize download: {e}"))?;

    let _ = app.emit(
        "llama://progress",
        Progress {
            phase,
            model_id: model_id.to_string(),
            downloaded: total,
            total,
            message: String::new(),
        },
    );
    Ok(())
}

/// Extract the release zip and return the path to `llama-server[.exe]` inside it.
fn extract_server_binary(zip_path: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("cannot open archive: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("cannot read archive: {e}"))?;

    fs::create_dir_all(dest_dir).map_err(|e| format!("cannot create bin dir: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("cannot read archive entry: {e}"))?;
        // Flatten: keep only the file name, dropping the `build/bin/` prefix, so
        // the server binary and its shared libraries end up side by side.
        let Some(name) = entry
            .enclosed_name()
            .and_then(|p| p.file_name().map(|n| n.to_owned()))
        else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let out_path = dest_dir.join(&name);
        let mut out =
            fs::File::create(&out_path).map_err(|e| format!("cannot extract file: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("cannot write extracted file: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Make binaries and shared objects executable; harmless on data files.
            let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755));
        }
    }

    let server_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let server = dest_dir.join(server_name);
    if server.exists() {
        Ok(server)
    } else {
        Err("llama-server was not found in the release archive".to_string())
    }
}

/// Ensure the llama.cpp server binary exists locally, downloading + extracting
/// the latest release if needed. Returns the path to `llama-server`.
fn ensure_binary(app: &AppHandle, client: &reqwest::blocking::Client) -> Result<PathBuf, String> {
    if let Some(path) = read_binary_path(app) {
        return Ok(path);
    }

    let _ = app.emit(
        "llama://progress",
        Progress {
            phase: "binary",
            model_id: String::new(),
            downloaded: 0,
            total: 0,
            message: "Downloading llama.cpp runtime…".to_string(),
        },
    );

    let url = asset_url()?;
    let dir = llama_dir(app)?;
    let zip_path = dir.join("llama-release.zip");
    // Binary archives are ~10-40MB; total is unknown up front, hint with 0.
    download_with_progress(app, client, &url, &zip_path, "binary", "", 0)?;

    // Extraction can take a second or two and used to be a silent gap; announce it
    // so the UI keeps moving instead of looking stuck.
    let _ = app.emit(
        "llama://progress",
        Progress {
            phase: "binary",
            model_id: String::new(),
            downloaded: 0,
            total: 0,
            message: "Extracting llama.cpp runtime…".to_string(),
        },
    );

    let bin_dir = dir.join("bin");
    let server = extract_server_binary(&zip_path, &bin_dir)?;
    let _ = fs::remove_file(&zip_path);
    write_binary_path(app, &server)?;
    Ok(server)
}

// --- server lifecycle ------------------------------------------------------

fn free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("cannot find a free port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read local port: {e}"))?
        .port();
    Ok(port)
}

/// Poll `/health` until the server reports ready or we time out.
fn wait_until_ready(client: &reqwest::blocking::Client, port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    loop {
        if let Ok(resp) = client.get(&url).timeout(Duration::from_secs(2)).send() {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        if started.elapsed() >= SERVER_READY_TIMEOUT {
            return Err(
                "The local model server did not become ready within 90 seconds. Close memory-heavy apps, choose a smaller model, and try again.".to_string(),
            );
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Spawn `llama-server` for `model`, replacing any server already running.
fn start_server(
    app: &AppHandle,
    state: &LlamaInner,
    client: &reqwest::blocking::Client,
    server_bin: &Path,
    model: &CatalogModel,
    model_file: &Path,
) -> Result<u16, String> {
    // Tear down a previous server (dropping the child kills it) before starting.
    {
        let mut guard = state.server.lock().map_err(|_| "llama state poisoned")?;
        *guard = None;
    }

    let port = free_port()?;
    let bin_dir = server_bin.parent().unwrap_or(Path::new("."));

    let _ = app.emit(
        "llama://progress",
        Progress {
            phase: "starting",
            model_id: model.id.to_string(),
            downloaded: 0,
            total: 0,
            message: "Starting local model server…".to_string(),
        },
    );

    let mut command = Command::new(server_bin);
    command
        .arg("-m")
        .arg(model_file)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg("4096")
        // Keep it quiet; we only care about the HTTP API.
        .current_dir(bin_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    // The server links against shared libraries shipped next to it; point the
    // dynamic loader at that directory so it can find them.
    #[cfg(target_os = "macos")]
    command.env("DYLD_LIBRARY_PATH", bin_dir);
    #[cfg(target_os = "linux")]
    command.env("LD_LIBRARY_PATH", bin_dir);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("failed to start llama-server: {e}"))?;

    // Register before the readiness wait so a concurrent stop can kill it.
    {
        let mut guard = state.server.lock().map_err(|_| "llama state poisoned")?;
        *guard = Some(ServerProcess {
            child,
            port,
            model_id: model.id.to_string(),
        });
    }

    // Loading the GGUF weights into memory is the slowest silent step — the server
    // is up but not answering /health yet. Tell the user what the wait is for.
    let _ = app.emit(
        "llama://progress",
        Progress {
            phase: "starting",
            model_id: model.id.to_string(),
            downloaded: 0,
            total: 0,
            message: "Loading model into memory…".to_string(),
        },
    );

    if let Err(error) = wait_until_ready(client, port) {
        // Do not retain a failed or half-started server. Dropping it terminates
        // its complete process tree and releases the model file and port.
        if let Ok(mut guard) = state.server.lock() {
            *guard = None;
        }
        return Err(error);
    }

    let _ = app.emit(
        "llama://progress",
        Progress {
            phase: "starting",
            model_id: model.id.to_string(),
            downloaded: 0,
            total: 0,
            message: "Warming up the model…".to_string(),
        },
    );

    Ok(port)
}

// --- commands --------------------------------------------------------------

fn claim_generation(inner: &LlamaInner, request_id: &str) -> Result<u64, String> {
    let generation = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut active = inner
        .active_request_id
        .lock()
        .map_err(|_| "llama request state poisoned")?;
    *active = Some(request_id.to_string());
    Ok(generation)
}

fn clear_generation(inner: &LlamaInner, request_id: &str) {
    if let Ok(mut active) = inner.active_request_id.lock() {
        if active.as_deref() == Some(request_id) {
            *active = None;
        }
    }
}

fn streamed_text(value: &Value) -> &str {
    value
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("choices")
                .and_then(|choices| choices.get(0))
                .and_then(|choice| {
                    choice
                        .get("delta")
                        .and_then(|delta| delta.get("content"))
                        .or_else(|| choice.get("text"))
                })
                .and_then(Value::as_str)
        })
        .unwrap_or("")
}

fn infill_request_body(
    input_prefix: String,
    input_suffix: String,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    stop: Option<Vec<String>>,
    seed: Option<i64>,
) -> Value {
    json!({
        "input_prefix": input_prefix,
        "input_suffix": input_suffix,
        "n_predict": max_tokens.unwrap_or(96),
        "temperature": temperature.unwrap_or(0.0),
        "stop": stop.unwrap_or_default(),
        "seed": seed.unwrap_or(0),
        "cache_prompt": true,
        "stream": true,
    })
}

/// Report which models are installed and whether a server is running. Cheap:
/// only touches the filesystem, never the network.
#[tauri::command]
pub fn llama_info(app: AppHandle, state: State<'_, LlamaState>) -> Result<LlamaInfo, String> {
    let binary_installed = read_binary_path(&app).is_some();
    let running_model_id = state
        .0
        .server
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.model_id.clone()));

    let dir = models_dir(&app)?;
    let models = MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id.to_string(),
            name: m.name.to_string(),
            params: m.params.to_string(),
            size_bytes: m.size_bytes,
            installed: dir.join(m.filename).exists(),
            is_default: m.id == DEFAULT_MODEL_ID,
        })
        .collect();

    Ok(LlamaInfo {
        binary_installed,
        running_model_id,
        models,
        default_model_id: DEFAULT_MODEL_ID.to_string(),
    })
}

/// Ensure everything needed to answer is in place: the server binary, the model
/// weights, and a running server for `model_id`. Emits `llama://progress`
/// throughout. Idempotent — returns quickly if the right server already runs.
#[tauri::command]
pub async fn llama_prepare(
    app: AppHandle,
    state: State<'_, LlamaState>,
    model_id: Option<String>,
) -> Result<(), String> {
    let model = resolve_model_id(model_id.as_deref());
    let inner = state.0.clone();

    // Already serving the requested model? Nothing to do.
    {
        let guard = inner.server.lock().map_err(|_| "llama state poisoned")?;
        if guard.as_ref().is_some_and(|s| s.model_id == model.id) {
            return Ok(());
        }
    }

    let app_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = http_client()?;
        let server_bin = ensure_binary(&app_task, &client)?;

        let model_file = model_path(&app_task, model)?;
        if !model_file.exists() {
            // Announce the download up front (downloaded=0) so the UI switches to
            // "Downloading AI model…" immediately instead of after the first chunk.
            let _ = app_task.emit(
                "llama://progress",
                Progress {
                    phase: "model",
                    model_id: model.id.to_string(),
                    downloaded: 0,
                    total: model.size_bytes,
                    message: String::new(),
                },
            );
            download_with_progress(
                &app_task,
                &client,
                model.url,
                &model_file,
                "model",
                model.id,
                model.size_bytes,
            )?;
        }

        let _ = start_server(&app_task, &inner, &client, &server_bin, model, &model_file)?;

        let _ = app_task.emit(
            "llama://progress",
            Progress {
                phase: "ready",
                model_id: model.id.to_string(),
                downloaded: 0,
                total: 0,
                message: String::new(),
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("prepare task failed: {e}"))?
}

/// Proxy a chat completion to the running server, streaming tokens as
/// `llama://token` events (matched by `request_id`) and returning the full text.
#[tauri::command]
pub async fn llama_generate(
    app: AppHandle,
    state: State<'_, LlamaState>,
    request_id: String,
    messages: Value,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let inner = state.0.clone();
    let port = {
        let guard = inner.server.lock().map_err(|_| "llama state poisoned")?;
        guard
            .as_ref()
            .map(|s| s.port)
            .ok_or("the local model server is not running")?
    };

    // Claim a generation so a later stop/generate can abort this stream.
    let my_gen = claim_generation(&inner, &request_id)?;
    let app_task = app.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let result = (|| -> Result<String, String> {
            let client = http_client()?;
            let body = json!({
                "messages": messages,
                "temperature": temperature.unwrap_or(0.3),
                "max_tokens": max_tokens.unwrap_or(2048),
                "stream": true,
            });

            let response = client
                .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
                .json(&body)
                .send()
                .map_err(|e| format!("cannot reach local model server: {e}"))?
                .error_for_status()
                .map_err(|e| format!("model server error: {e}"))?;

            let mut full = String::new();
            let reader = BufReader::new(response);
            for line in reader.lines() {
                if generation_cancelled(inner.generation.load(Ordering::SeqCst), my_gen) {
                    break;
                }
                let Ok(line) = line else { break };
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                let token = streamed_text(&value);
                if token.is_empty() {
                    continue;
                }
                full.push_str(token);
                let _ = app_task.emit(
                    "llama://token",
                    TokenChunk {
                        id: request_id.clone(),
                        token: token.to_string(),
                    },
                );
            }
            Ok(full)
        })();
        clear_generation(&inner, &request_id);
        result
    })
    .await
    .map_err(|e| format!("generate task failed: {e}"))?
}

/// Fill code between a prefix and suffix through llama.cpp's dedicated infill
/// endpoint. Unlike chat completions this preserves the model's native FIM
/// template and never mutates the assistant conversation.
#[tauri::command]
pub async fn llama_complete(
    state: State<'_, LlamaState>,
    request_id: String,
    input_prefix: String,
    input_suffix: String,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    stop: Option<Vec<String>>,
    seed: Option<i64>,
) -> Result<String, String> {
    let inner = state.0.clone();
    let port = {
        let guard = inner.server.lock().map_err(|_| "llama state poisoned")?;
        guard
            .as_ref()
            .map(|server| server.port)
            .ok_or("the local model server is not running")?
    };
    let my_gen = claim_generation(&inner, &request_id)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let result = (|| -> Result<String, String> {
            let client = http_client()?;
            let body = infill_request_body(
                input_prefix,
                input_suffix,
                max_tokens,
                temperature,
                stop,
                seed,
            );
            let response = client
                .post(format!("http://127.0.0.1:{port}/infill"))
                .json(&body)
                .send()
                .map_err(|e| format!("cannot reach local model server: {e}"))?
                .error_for_status()
                .map_err(|e| format!("model server infill error: {e}"))?;

            let mut full = String::new();
            for line in BufReader::new(response).lines() {
                if generation_cancelled(inner.generation.load(Ordering::SeqCst), my_gen) {
                    break;
                }
                let Ok(line) = line else { break };
                let Some(data) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                full.push_str(streamed_text(&value));
            }
            Ok(full)
        })();
        clear_generation(&inner, &request_id);
        result
    })
    .await
    .map_err(|e| format!("completion task failed: {e}"))?
}

/// Cancel one specific inference request without stopping the model server. A
/// stale inline-completion cancellation can therefore never kill a newer chat.
#[tauri::command]
pub fn llama_cancel(state: State<'_, LlamaState>, request_id: String) -> Result<bool, String> {
    let active = state
        .0
        .active_request_id
        .lock()
        .map_err(|_| "llama request state poisoned")?;
    let should_cancel = request_matches(active.as_deref(), &request_id);
    drop(active);
    if should_cancel {
        state.0.generation.fetch_add(1, Ordering::SeqCst);
    }
    Ok(should_cancel)
}

/// Stop the running server (if any) and cancel any in-flight generation.
#[tauri::command]
pub fn llama_stop(state: State<'_, LlamaState>) -> Result<bool, String> {
    state.0.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut active) = state.0.active_request_id.lock() {
        *active = None;
    }
    let mut guard = state.0.server.lock().map_err(|_| "llama state poisoned")?;
    let was_running = guard.is_some();
    *guard = None; // Drop kills the child.
    Ok(was_running)
}

/// Delete a model's weights from disk. Stops the server first if it is the one
/// currently loaded.
#[tauri::command]
pub fn llama_uninstall(
    app: AppHandle,
    state: State<'_, LlamaState>,
    model_id: String,
) -> Result<(), String> {
    let model = find_model(&model_id).ok_or("unknown model")?;

    {
        let mut guard = state.0.server.lock().map_err(|_| "llama state poisoned")?;
        if guard.as_ref().is_some_and(|s| s.model_id == model.id) {
            state.0.generation.fetch_add(1, Ordering::SeqCst);
            *guard = None;
        }
    }

    let path = model_path(&app, model)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("cannot delete model: {e}"))?;
    }
    Ok(())
}

fn generation_cancelled(current: u64, claimed: u64) -> bool {
    current != claimed
}

fn request_matches(active_request_id: Option<&str>, requested_id: &str) -> bool {
    active_request_id == Some(requested_id)
}

#[cfg(test)]
mod tests {
    use super::{
        asset_suffix, find_model, generation_cancelled, infill_request_body, request_matches,
        resolve_model_id, streamed_text, DEFAULT_MODEL_ID, MODELS,
    };

    #[test]
    fn maps_supported_platform_assets() {
        assert_eq!(asset_suffix("macos", "aarch64").unwrap(), "macos-arm64");
        assert_eq!(asset_suffix("macos", "x86_64").unwrap(), "macos-x64");
        assert_eq!(asset_suffix("linux", "x86_64").unwrap(), "ubuntu-x64");
        assert_eq!(asset_suffix("windows", "x86_64").unwrap(), "win-cpu-x64");
        assert_eq!(asset_suffix("windows", "aarch64").unwrap(), "win-cpu-arm64");
    }

    #[test]
    fn rejects_unsupported_platform_assets() {
        assert!(asset_suffix("linux", "aarch64").is_err());
        assert!(asset_suffix("freebsd", "x86_64").is_err());
    }

    #[test]
    fn resolves_known_models_and_falls_back_to_default() {
        assert_eq!(
            resolve_model_id(Some("qwen2.5-coder-0.5b")).id,
            "qwen2.5-coder-0.5b"
        );
        assert_eq!(resolve_model_id(Some("unknown")).id, DEFAULT_MODEL_ID);
        assert_eq!(resolve_model_id(None).id, DEFAULT_MODEL_ID);
        assert!(find_model(DEFAULT_MODEL_ID).is_some());
        assert!(MODELS.iter().all(|model| !model.id.is_empty()));
    }

    #[test]
    fn detects_generation_cancellation() {
        assert!(!generation_cancelled(7, 7));
        assert!(generation_cancelled(8, 7));
        assert!(generation_cancelled(6, 7));
    }

    #[test]
    fn only_cancels_the_matching_request() {
        assert!(request_matches(Some("inline-2"), "inline-2"));
        assert!(!request_matches(Some("chat-3"), "inline-2"));
        assert!(!request_matches(None, "inline-2"));
    }

    #[test]
    fn builds_deterministic_infill_requests() {
        let body = infill_request_body(
            "const value = ".to_string(),
            "\nconsole.log(value)".to_string(),
            Some(64),
            Some(0.0),
            Some(vec!["<|fim_middle|>".to_string()]),
            Some(42),
        );
        assert_eq!(body["n_predict"], 64);
        assert_eq!(body["seed"], 42);
        assert_eq!(body["cache_prompt"], true);
        assert_eq!(body["input_suffix"], "\nconsole.log(value)");
        assert_eq!(body["stop"][0], "<|fim_middle|>");
    }

    #[test]
    fn reads_chat_and_infill_stream_chunks() {
        assert_eq!(
            streamed_text(&serde_json::json!({ "content": "value" })),
            "value"
        );
        assert_eq!(
            streamed_text(&serde_json::json!({
                "choices": [{ "delta": { "content": "next" } }]
            })),
            "next"
        );
    }
}
