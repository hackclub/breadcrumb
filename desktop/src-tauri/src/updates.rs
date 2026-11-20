use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    checked_at: Option<u64>,
    failed: bool,
}
struct UpdateCache(Mutex<UpdateStatus>);

pub fn start(app: tauri::AppHandle, enabled: bool) {
    app.manage(UpdateCache(Mutex::new(UpdateStatus {
        current_version: app.package_info().version.to_string(),
        version: None,
        notes: None,
        checked_at: None,
        failed: false,
    })));
    if enabled {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
            loop {
                let _ = tauri::async_runtime::block_on(check_updates(app.clone()));
                std::thread::sleep(Duration::from_secs(4 * 60 * 60));
            }
        });
    }
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    app.state::<UpdateCache>()
        .0
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "Update status is unavailable".into())
}

async fn available(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    if std::env::args().any(|arg| arg == "--demo") {
        return Err("Updates are disabled in the synthetic preview".into());
    }
    match app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
    {
        Ok(update) => Ok(update),
        Err(
            tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_),
        ) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn check_updates(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let result = available(&app).await;
    let mut status = update_status(app.clone())?;
    status.checked_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    );
    status.failed = result.is_err();
    if let Ok(update) = &result {
        status.version = update.as_ref().map(|u| u.version.clone());
        status.notes = update.as_ref().and_then(|u| u.body.clone());
    }
    *app.state::<UpdateCache>()
        .0
        .lock()
        .map_err(|_| "Update status is unavailable")? = status.clone();
    let _ = app.emit("update-checked", &status);
    result.map(|_| status)
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let mut update = available(&app)
        .await?
        .ok_or("No update is available. Check again before installing.")?;
    if update.version != version {
        return Err("The update changed. Check again before installing.".into());
    }
    if update.download_url.scheme() != "https" {
        return Err("Update downloads require HTTPS".into());
    }
    // The short manifest timeout must not truncate downloads on slow connections.
    update.timeout = Some(Duration::from_secs(60 * 60));
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(
                    "update-progress",
                    serde_json::json!({"downloaded":downloaded,"total":total}),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
