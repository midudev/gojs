mod llama_runtime;
mod node_runtime;

use tauri::{
    menu::{AboutMetadata, Menu, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_opener::OpenerExt;

fn menu_item(
    app: &tauri::AppHandle,
    id: &str,
    text: &str,
    accelerator: &str,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    MenuItemBuilder::with_id(id, text)
        .accelerator(accelerator)
        .build(app)
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;

    let about = AboutMetadata {
        name: Some("GoJS".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        authors: Some(vec!["midudev".into()]),
        comments: Some("A modern JavaScript and TypeScript playground.".into()),
        copyright: Some("© midudev".into()),
        license: Some("MIT".into()),
        website: Some("https://gojs.app".into()),
        website_label: Some("GoJS website".into()),
        ..Default::default()
    };

    #[cfg(target_os = "macos")]
    menu.append(
        &SubmenuBuilder::new(app, "GoJS")
            .about(Some(about.clone()))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?,
    )?;

    let new_tab = menu_item(app, "new-tab", "New Tab", "CmdOrCtrl+T")?;
    let save_version = menu_item(app, "save-version", "Save Version", "CmdOrCtrl+S")?;
    let close_tab = menu_item(app, "close-tab", "Close Tab", "CmdOrCtrl+W")?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&save_version)
        .separator()
        .item(&close_tab);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();
    menu.append(&file.build()?)?;

    let undo = menu_item(app, "undo", "Undo", "CmdOrCtrl+Z")?;
    let redo = menu_item(app, "redo", "Redo", "CmdOrCtrl+Shift+Z")?;
    let format = menu_item(
        app,
        "format-document",
        "Format Document",
        "CmdOrCtrl+Shift+F",
    )?;
    menu.append(
        &SubmenuBuilder::new(app, "Edit")
            .item(&undo)
            .item(&redo)
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .separator()
            .item(&format)
            .build()?,
    )?;

    let run = menu_item(app, "run-code", "Run Code", "CmdOrCtrl+Enter")?;
    let toggle_auto_run =
        MenuItemBuilder::with_id("toggle-auto-run", "Toggle Auto-run").build(app)?;
    menu.append(
        &SubmenuBuilder::new(app, "Run")
            .item(&run)
            .separator()
            .item(&toggle_auto_run)
            .build()?,
    )?;

    let toggle_layout = MenuItemBuilder::with_id("toggle-layout", "Toggle Layout").build(app)?;
    let toggle_ai = MenuItemBuilder::with_id("toggle-ai", "Toggle AI Panel").build(app)?;
    let version_history =
        MenuItemBuilder::with_id("version-history", "Version History").build(app)?;
    let settings = menu_item(app, "settings", "Settings…", "CmdOrCtrl+,")?;
    menu.append(
        &SubmenuBuilder::new(app, "View")
            .item(&toggle_layout)
            .item(&toggle_ai)
            .separator()
            .item(&version_history)
            .item(&settings)
            .separator()
            .fullscreen()
            .build()?,
    )?;

    let close_window = menu_item(app, "close-window", "Close Window", "CmdOrCtrl+Shift+W")?;
    menu.append(
        &SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .item(&close_window)
            .build()?,
    )?;

    let website = MenuItemBuilder::with_id("open-website", "GoJS Website").build(app)?;
    let report_issue = MenuItemBuilder::with_id("report-issue", "Report an Issue…").build(app)?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&website)
        .item(&report_issue);
    #[cfg(not(target_os = "macos"))]
    let help = help.separator().about(Some(about));
    menu.append(&help.build()?)?;

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-website" => {
                let _ = app.opener().open_url("https://gojs.app", None::<&str>);
            }
            "report-issue" => {
                let _ = app.opener().open_url(
                    "https://github.com/midudev/gojs-issues/issues/new",
                    None::<&str>,
                );
            }
            "close-window" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            id => {
                let _ = app.emit("menu-action", id);
            }
        })
        // Shared lock so only one npm operation runs at a time.
        .manage(node_runtime::NpmLock::default())
        // Cooperative cancel/timeout control for the current native run.
        .manage(node_runtime::RunControl::default())
        // Native llama.cpp server lifecycle (desktop AI backend).
        .manage(llama_runtime::LlamaState::default())
        .invoke_handler(tauri::generate_handler![
            node_runtime::node_info,
            node_runtime::node_run,
            node_runtime::node_stop,
            node_runtime::deps_list,
            node_runtime::deps_add,
            node_runtime::deps_remove,
            node_runtime::deps_update,
            node_runtime::workspace_reveal,
            llama_runtime::llama_info,
            llama_runtime::llama_prepare,
            llama_runtime::llama_generate,
            llama_runtime::llama_complete,
            llama_runtime::llama_cancel,
            llama_runtime::llama_stop,
            llama_runtime::llama_uninstall,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GoJS desktop application");
}
