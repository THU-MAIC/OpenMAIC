#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

const DEFAULT_REMOTE_URL: &str = "https://open.maic.chat";
const LOCAL_DEV_URL: &str = "http://localhost:3000";

fn resolve_app_url(app: &tauri::App) -> String {
    let is_dev = cfg!(debug_assertions);

    if is_dev {
        return LOCAL_DEV_URL.to_string();
    }

    let config_url = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| {
            let config_path = dir.join("server-url.txt");
            std::fs::read_to_string(config_path).ok()
        });

    match config_url {
        Some(url) if !url.trim().is_empty() => url.trim().to_string(),
        _ => DEFAULT_REMOTE_URL.to_string(),
    }
}

#[tauri::command]
fn get_server_url(app: tauri::AppHandle) -> String {
    let is_dev = cfg!(debug_assertions);

    if is_dev {
        return LOCAL_DEV_URL.to_string();
    }

    let config_url = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| {
            let config_path = dir.join("server-url.txt");
            std::fs::read_to_string(config_path).ok()
        });

    match config_url {
        Some(url) if !url.trim().is_empty() => url.trim().to_string(),
        _ => DEFAULT_REMOTE_URL.to_string(),
    }
}

#[tauri::command]
fn set_server_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

    let config_path = config_dir.join("server-url.txt");
    std::fs::write(&config_path, url.trim()).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_server_url, set_server_url])
        .setup(|app| {
            let url = resolve_app_url(app);

            let window = app.get_webview_window("main").expect("main window missing");
            window.eval(&format!("window.location.replace('{}')", url))
                .expect("failed to navigate to app URL");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}