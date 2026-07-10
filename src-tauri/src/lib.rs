mod llama_runtime;
mod node_runtime;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            llama_runtime::llama_stop,
            llama_runtime::llama_uninstall,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GoJS desktop application");
}
