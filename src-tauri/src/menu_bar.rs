//! Native menu bar visibility (Windows and Linux).
//!
//! On Windows and Linux the menu bar is drawn inside the window, below the
//! native title bar, and clashes with the editor chrome. Users can hide it from
//! View → Hide Menu Bar or Settings → Appearance. The choice is stored as a flag
//! file in the app config dir and restored in `setup`, before the first frame,
//! so the menu does not flash on launch.
//!
//! On macOS the menu lives in the system menu bar, so the feature is reported as
//! unsupported and every call is a no-op.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

const SUPPORTED: bool = cfg!(not(target_os = "macos"));
const MAIN_WINDOW: &str = "main";
const HIDDEN_FLAG_FILE: &str = "menu-bar-hidden";

/// Tracks the current visibility. `Window::is_menu_visible` blocks on the main
/// thread, so the backend keeps its own copy instead of querying the window.
#[derive(Default)]
pub struct MenuBarState {
    hidden: AtomicBool,
}

#[derive(Clone, Serialize)]
pub struct MenuBarInfo {
    supported: bool,
    visible: bool,
}

fn info<R: Runtime>(app: &AppHandle<R>) -> MenuBarInfo {
    MenuBarInfo {
        supported: SUPPORTED,
        visible: !SUPPORTED || !app.state::<MenuBarState>().hidden.load(Ordering::Relaxed),
    }
}

fn hidden_flag_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(HIDDEN_FLAG_FILE))
}

fn persist<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let Some(path) = hidden_flag_path(app) else {
        return;
    };
    let result = if visible {
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    } else {
        path.parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, b""))
    };
    if let Err(error) = result {
        eprintln!("[menu-bar] could not persist visibility: {error}");
    }
}

/// Re-applies the persisted choice. Call from `setup`, after the main window
/// exists and before the event loop paints it.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    if !SUPPORTED {
        return;
    }
    let hidden = hidden_flag_path(app).is_some_and(|path| path.exists());
    app.state::<MenuBarState>()
        .hidden
        .store(hidden, Ordering::Relaxed);
    if hidden {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.hide_menu();
        }
    }
}

fn apply<R: Runtime>(app: &AppHandle<R>, visible: bool) -> Result<MenuBarInfo, String> {
    if !SUPPORTED {
        return Ok(info(app));
    }
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    if visible {
        window.show_menu()
    } else {
        window.hide_menu()
    }
    .map_err(|error| error.to_string())?;
    app.state::<MenuBarState>()
        .hidden
        .store(!visible, Ordering::Relaxed);
    persist(app, visible);
    Ok(info(app))
}

#[tauri::command]
pub async fn menu_bar_info(app: AppHandle) -> MenuBarInfo {
    info(&app)
}

#[tauri::command]
pub async fn menu_bar_set_visible(app: AppHandle, visible: bool) -> Result<MenuBarInfo, String> {
    apply(&app, visible)
}
