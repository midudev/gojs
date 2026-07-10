//! Native Node.js runtime bridge.
//!
//! GoJS runs user code in the browser worker by default, but on the desktop we
//! can do something the web can't: execute the code against a *real* Node.js
//! runtime, with real `npm install`, native modules and the full stdlib. This
//! module is the bridge between the webview and that native runtime.
//!
//! ## How Node is resolved
//! 1. `GOJS_NODE_PATH` env var (an explicit override, mostly for tests).
//! 2. A bundled runtime shipped as a Tauri *resource* under `runtime/`
//!    (populated by `scripts/fetch-node.mjs`, Node 26). This is what ships to
//!    end users, so the version is guaranteed regardless of the host machine.
//! 3. A `node` found on the system `PATH` (used in `tauri dev` and as a
//!    graceful fallback if the bundle is missing).
//!
//! ## Workspace
//! All installs and executions happen inside a per-user workspace directory
//! (`<app_data>/workspace`) that owns its own `package.json` + `node_modules`.
//! Dependencies the user adds from Settings live there, so scripts can
//! `import`/`require` them exactly like a normal Node project.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

/// Guards concurrent npm operations: npm is not safe to run twice against the
/// same `node_modules` at once, and it keeps the UI honest (one install a time).
#[derive(Default)]
pub struct NpmLock(Mutex<()>);

/// Absolute ceiling on a single native run, so a runaway program can never
/// freeze the app even if the frontend forgets to pass a timeout.
const MAX_RUN_TIMEOUT_MS: u64 = 120_000;
/// How often the wait loop checks the deadline / cancellation flag.
const POLL_INTERVAL_MS: u64 = 40;

/// Cooperative control for native runs. GoJS runs one script at a time, but the
/// frontend's auto-run can *start* a new run before the previous one has been
/// torn down. A shared cancel flag was not enough: `node_stop` returns before
/// the old process dies and the next `node_run` would reset the flag, so the
/// previous Node process was never killed and kept emitting duplicate output.
///
/// Instead we use a monotonic generation. Every run claims a generation and
/// watches it: the moment it sees a *newer* value (a newer run started, or an
/// explicit stop bumped it) it SIGKILLs itself. This makes supersession
/// race-free — nobody can un-cancel someone else — and still recovers from an
/// infinite loop via the deadline or an explicit `node_stop`.
pub struct RunControl(pub Arc<RunControlInner>);

#[derive(Default)]
pub struct RunControlInner {
    /// Bumped by every `node_run` (on start) and every `node_stop`. A run holds
    /// its own generation and dies as soon as this differs from it.
    generation: AtomicU64,
    /// Whether a run is currently in flight (for `node_stop`'s return value).
    running: AtomicBool,
}

impl Default for RunControl {
    fn default() -> Self {
        RunControl(Arc::new(RunControlInner::default()))
    }
}

/// SIGKILL the child. On Unix we gave it its own process group, so we can take
/// down anything it spawned too (workers, `child_process`), not just the shell.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // Negative pid targets the whole process group (see `process_group(0)`).
        let pgid = child.id() as i32;
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    // Always also kill the direct child (covers Windows and any race).
    let _ = child.kill();
    let _ = child.wait();
}

/// Where Node came from, surfaced to the UI so it can show "Node 26 (bundled)".
#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum NodeSource {
    Bundled,
    System,
}

struct Resolved {
    node: PathBuf,
    /// Path to `npm-cli.js` when we control the runtime layout (bundled), so we
    /// can invoke npm as `node npm-cli.js …` without depending on a shell shim.
    npm_cli: Option<PathBuf>,
    source: NodeSource,
}

#[derive(Serialize, Clone)]
pub struct NodeInfo {
    available: bool,
    version: Option<String>,
    npm_version: Option<String>,
    source: Option<String>,
    node_path: Option<String>,
    workspace: String,
}

#[derive(Serialize, Clone)]
pub struct RunResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u128,
    timed_out: bool,
}

#[derive(Serialize, Clone)]
pub struct Dependency {
    name: String,
    /// The range as written in package.json (e.g. `^1.2.0`), if declared.
    wanted: Option<String>,
    /// The version actually present in node_modules, if installed.
    installed: Option<String>,
}

/// One streamed line of output during `node_run`, emitted as `node://output`.
#[derive(Serialize, Clone)]
struct OutputChunk {
    channel: &'static str, // "stdout" | "stderr"
    line: String,
    /// Generation of the run that produced this line. The frontend drops chunks
    /// whose run has been superseded, so a dying stale process can't leak output
    /// into the current run's panel.
    run: u64,
}

// --- resolution ------------------------------------------------------------

#[cfg(windows)]
fn bundled_node_rel() -> &'static str {
    "node.exe"
}
#[cfg(not(windows))]
fn bundled_node_rel() -> &'static str {
    "bin/node"
}

#[cfg(windows)]
fn bundled_npm_cli_rel() -> &'static str {
    "node_modules/npm/bin/npm-cli.js"
}
#[cfg(not(windows))]
fn bundled_npm_cli_rel() -> &'static str {
    "lib/node_modules/npm/bin/npm-cli.js"
}

fn resolve(app: &AppHandle) -> Option<Resolved> {
    // 1. Explicit override.
    if let Ok(p) = std::env::var("GOJS_NODE_PATH") {
        let node = PathBuf::from(&p);
        if node.exists() {
            return Some(Resolved {
                node,
                npm_cli: None,
                source: NodeSource::System,
            });
        }
    }

    // 2. Bundled runtime shipped as a resource.
    if let Ok(runtime) = app.path().resolve("runtime", tauri::path::BaseDirectory::Resource) {
        let node = runtime.join(bundled_node_rel());
        if node.exists() {
            let npm_cli = runtime.join(bundled_npm_cli_rel());
            return Some(Resolved {
                node,
                npm_cli: if npm_cli.exists() { Some(npm_cli) } else { None },
                source: NodeSource::Bundled,
            });
        }
    }

    // 3. System Node on PATH.
    if let Ok(node) = which::which("node") {
        return Some(Resolved {
            node,
            npm_cli: None,
            source: NodeSource::System,
        });
    }

    None
}

fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let ws = base.join("workspace");
    std::fs::create_dir_all(&ws).map_err(|e| format!("cannot create workspace: {e}"))?;
    let pkg = ws.join("package.json");
    if !pkg.exists() {
        let seed = serde_json::json!({
            "name": "gojs-workspace",
            "private": true,
            "version": "0.0.0",
            "type": "module",
            "description": "Dependencies installed from GoJS run natively against Node.js.",
            "dependencies": {}
        });
        std::fs::write(&pkg, serde_json::to_vec_pretty(&seed).unwrap())
            .map_err(|e| format!("cannot seed package.json: {e}"))?;
    }
    Ok(ws)
}

/// npm on Windows is a `.cmd`; going through Node's own `npm-cli.js` (bundled)
/// or the resolved `npm`/`npm.cmd` (system) keeps a single code path.
fn npm_command(resolved: &Resolved) -> Result<Command, String> {
    if let Some(cli) = &resolved.npm_cli {
        let mut cmd = Command::new(&resolved.node);
        cmd.arg(cli);
        Ok(cmd)
    } else {
        // System runtime: find npm next to node, else on PATH.
        let candidate = if cfg!(windows) { "npm.cmd" } else { "npm" };
        if let Some(dir) = resolved.node.parent() {
            let sibling = dir.join(candidate);
            if sibling.exists() {
                return Ok(Command::new(sibling));
            }
        }
        which::which(candidate)
            .map(Command::new)
            .map_err(|_| "npm not found next to Node or on PATH".to_string())
    }
}

// --- helpers ---------------------------------------------------------------

fn read_version(cmd: &mut Command) -> Option<String> {
    let out = cmd.arg("--version").output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

// --- commands --------------------------------------------------------------

#[tauri::command]
pub fn node_info(app: AppHandle) -> Result<NodeInfo, String> {
    let workspace = workspace_dir(&app)?.to_string_lossy().to_string();
    let Some(resolved) = resolve(&app) else {
        return Ok(NodeInfo {
            available: false,
            version: None,
            npm_version: None,
            source: None,
            node_path: None,
            workspace,
        });
    };

    let version = read_version(&mut Command::new(&resolved.node));
    let npm_version = npm_command(&resolved).ok().and_then(|mut c| read_version(&mut c));

    Ok(NodeInfo {
        available: version.is_some(),
        version,
        npm_version,
        source: Some(
            match resolved.source {
                NodeSource::Bundled => "bundled",
                NodeSource::System => "system",
            }
            .to_string(),
        ),
        node_path: Some(resolved.node.to_string_lossy().to_string()),
        workspace,
    })
}

/// Run `code` with the native runtime. The code is written to a temp file inside
/// the workspace so relative `import`s and installed deps resolve, then executed.
/// Output is both streamed (`node://output` events) and returned buffered.
#[tauri::command]
pub async fn node_run(
    app: AppHandle,
    control: State<'_, RunControl>,
    code: String,
    language: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<RunResult, String> {
    let resolved = resolve(&app).ok_or("No Node.js runtime available")?;
    let ws = workspace_dir(&app)?;

    // `.mjs` so top-level `import`/`await` work without a per-run package.json
    // flag. TS is stripped on the frontend before it reaches us, but we honour
    // an explicit language hint for the extension anyway.
    let ext = match language.as_deref() {
        Some("ts") | Some("typescript") => "mts",
        _ => "mjs",
    };
    // Take ownership of a cloneable handle to the run flags so the blocking
    // task can watch for supersession independently of the command's lifetime.
    let ctl = control.0.clone();
    // Claim a generation. Any run with an older generation is now superseded and
    // will kill itself when it notices. `+ 1` because fetch_add returns the
    // previous value; our generation is the post-increment one.
    let my_gen = ctl.generation.fetch_add(1, Ordering::SeqCst) + 1;
    ctl.running.store(true, Ordering::SeqCst);

    // A unique entry file per run so overlapping runs can't overwrite or delete
    // each other's source (the previous fixed name let one run's cleanup remove
    // the file another run was still executing).
    let entry = ws.join(format!(".gojs-run.{my_gen}.{ext}"));
    std::fs::write(&entry, &code).map_err(|e| format!("cannot write entry file: {e}"))?;

    // Deadline: whatever the frontend asks for, capped so nothing runs forever.
    let deadline = Duration::from_millis(timeout_ms.unwrap_or(MAX_RUN_TIMEOUT_MS).min(MAX_RUN_TIMEOUT_MS));

    let node = resolved.node.clone();
    let ctl_task = ctl.clone();
    // All the blocking work (spawn + timed wait loop + pipe joins) happens off
    // the async runtime so we never block a Tauri worker thread.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<RunResult, String> {
        let started = Instant::now();

        let mut command = Command::new(&node);
        command
            .arg("--experimental-strip-types")
            .arg(&entry)
            .current_dir(&ws)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        // Own process group so kill_tree can take down anything the script spawns.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut child = command.spawn().map_err(|e| format!("failed to spawn Node: {e}"))?;

        // Drain stdout and stderr on their own threads so a chatty program can't
        // deadlock by filling one pipe while we block reading the other.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let app_out = app.clone();
        let out_handle = std::thread::spawn(move || pump(app_out, "stdout", stdout, my_gen));
        let app_err = app.clone();
        let err_handle = std::thread::spawn(move || pump(app_err, "stderr", stderr, my_gen));

        // Poll for completion, the deadline, or supersession. This is the
        // recovery loop: on timeout or supersession we SIGKILL the process group.
        let mut timed_out = false;
        let mut superseded = false;
        let exit_code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(e) => {
                    kill_tree(&mut child);
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(format!("Node exited abnormally: {e}"));
                }
            }
            if started.elapsed() >= deadline {
                timed_out = true;
                kill_tree(&mut child);
                break None;
            }
            // A newer run (or an explicit stop) bumped the generation: this run
            // is stale, so kill it. This is the fix for duplicated output — the
            // old process can no longer survive into the next run.
            if ctl_task.generation.load(Ordering::SeqCst) != my_gen {
                superseded = true;
                kill_tree(&mut child);
                break None;
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        };

        // The pipes hit EOF once the child dies, so these joins return promptly.
        let stdout = out_handle.join().unwrap_or_default();
        let mut stderr = err_handle.join().unwrap_or_default();

        if timed_out {
            stderr.push_str(&format!(
                "\n⏱️ Execution stopped: exceeded the {}s time limit (possible infinite loop).\n",
                deadline.as_secs()
            ));
        } else if superseded {
            stderr.push_str("\n⏹️ Execution stopped.\n");
        }

        // Best-effort cleanup of the throwaway entry file.
        let _ = std::fs::remove_file(&entry);

        Ok(RunResult {
            stdout,
            stderr,
            exit_code,
            duration_ms: started.elapsed().as_millis(),
            timed_out,
        })
    })
    .await
    .map_err(|e| format!("run task failed: {e}"))?;

    // Only clear `running` if we are still the latest run. If a newer run has
    // already claimed the generation, it owns the flag and we must not touch it.
    if ctl.generation.load(Ordering::SeqCst) == my_gen {
        ctl.running.store(false, Ordering::SeqCst);
    }
    result
}

/// Cancel the currently running native execution (if any). Sets the shared flag
/// that `node_run`'s wait loop watches; the process is SIGKILLed within a poll
/// interval. Safe to call when nothing is running (no-op).
#[tauri::command]
pub fn node_stop(control: State<'_, RunControl>) -> Result<bool, String> {
    let running = control.0.running.load(Ordering::SeqCst);
    // Bump the generation so the in-flight run (if any) sees a newer value and
    // SIGKILLs itself within a poll interval.
    control.0.generation.fetch_add(1, Ordering::SeqCst);
    if running {
        control.0.running.store(false, Ordering::SeqCst);
    }
    Ok(running)
}

/// Reads a child pipe line by line: emits each line for live rendering and
/// accumulates the full text for the buffered return value.
fn pump<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    channel: &'static str,
    pipe: Option<R>,
    run: u64,
) -> String {
    let Some(pipe) = pipe else { return String::new() };
    let mut acc = String::new();
    let reader = BufReader::new(pipe);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let _ = app.emit(
            "node://output",
            OutputChunk {
                channel,
                line: line.clone(),
                run,
            },
        );
        acc.push_str(&line);
        acc.push('\n');
    }
    acc
}

// --- dependency management -------------------------------------------------

/// List declared + installed dependencies by reconciling `package.json` against
/// what is actually present in `node_modules`.
#[tauri::command]
pub fn deps_list(app: AppHandle) -> Result<Vec<Dependency>, String> {
    let ws = workspace_dir(&app)?;

    let mut wanted: std::collections::BTreeMap<String, Option<String>> = Default::default();
    if let Ok(text) = std::fs::read_to_string(ws.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<Value>(&text) {
            if let Some(deps) = pkg.get("dependencies").and_then(Value::as_object) {
                for (name, range) in deps {
                    wanted.insert(name.clone(), range.as_str().map(String::from));
                }
            }
        }
    }

    let mut deps: Vec<Dependency> = Vec::new();
    for (name, range) in &wanted {
        deps.push(Dependency {
            name: name.clone(),
            wanted: range.clone(),
            installed: installed_version(&ws, name),
        });
    }

    Ok(deps)
}

fn installed_version(ws: &Path, name: &str) -> Option<String> {
    // Handles scoped packages (@scope/name) via the join of path segments.
    let pkg = ws.join("node_modules").join(name).join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.get("version").and_then(Value::as_str).map(String::from)
}

fn run_npm(
    app: &AppHandle,
    lock: &State<'_, NpmLock>,
    args: &[&str],
) -> Result<RunResult, String> {
    let _guard = lock.0.lock().map_err(|_| "npm lock poisoned")?;
    let resolved = resolve(app).ok_or("No Node.js runtime available")?;
    let ws = workspace_dir(app)?;

    let started = Instant::now();
    let mut cmd = npm_command(&resolved)?;
    cmd.args(args)
        .arg("--no-fund")
        .arg("--no-audit")
        .current_dir(&ws)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn npm: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Generation 0: npm output is not gated by the run generation, so the
    // frontend always shows it.
    let a1 = app.clone();
    let out_handle = std::thread::spawn(move || pump(a1, "stdout", stdout, 0));
    let a2 = app.clone();
    let err_handle = std::thread::spawn(move || pump(a2, "stderr", stderr, 0));

    let status = child.wait().map_err(|e| format!("npm exited abnormally: {e}"))?;
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();

    Ok(RunResult {
        stdout,
        stderr,
        exit_code: status.code(),
        duration_ms: started.elapsed().as_millis(),
        timed_out: false,
    })
}

/// Validate a package specifier so we never hand npm something shell-ish. npm
/// receives argv directly (no shell) but we still keep names sane.
fn valid_pkg_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 214
        && !name.starts_with('.')
        && !name.starts_with('_')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '_' | '.'))
}

#[tauri::command]
pub fn deps_add(
    app: AppHandle,
    lock: State<'_, NpmLock>,
    name: String,
    version: Option<String>,
) -> Result<RunResult, String> {
    if !valid_pkg_name(&name) {
        return Err(format!("Invalid package name: {name}"));
    }
    let spec = match version.as_deref() {
        Some(v) if !v.is_empty() && v != "latest" => format!("{name}@{v}"),
        _ => name.clone(),
    };
    run_npm(&app, &lock, &["install", &spec, "--save"])
}

#[tauri::command]
pub fn deps_remove(
    app: AppHandle,
    lock: State<'_, NpmLock>,
    name: String,
) -> Result<RunResult, String> {
    if !valid_pkg_name(&name) {
        return Err(format!("Invalid package name: {name}"));
    }
    run_npm(&app, &lock, &["uninstall", &name, "--save"])
}

/// Change the installed version of an existing dependency (`name@version`).
#[tauri::command]
pub fn deps_update(
    app: AppHandle,
    lock: State<'_, NpmLock>,
    name: String,
    version: String,
) -> Result<RunResult, String> {
    if !valid_pkg_name(&name) {
        return Err(format!("Invalid package name: {name}"));
    }
    let spec = if version.is_empty() || version == "latest" {
        format!("{name}@latest")
    } else {
        format!("{name}@{version}")
    };
    run_npm(&app, &lock, &["install", &spec, "--save"])
}

/// Reveal the workspace folder so power users can inspect it.
#[tauri::command]
pub fn workspace_reveal(app: AppHandle) -> Result<String, String> {
    let ws = workspace_dir(&app)?;
    Ok(ws.to_string_lossy().to_string())
}
