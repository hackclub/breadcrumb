#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
struct EngineIO {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
}
struct Engine(Mutex<EngineIO>);
impl Engine {
    fn request(&self, command: &str, args: Value) -> Result<Value, String> {
        let mut io = self.0.lock().map_err(|_| "Engine lock failed")?;
        io.sequence += 1;
        let id = io.sequence;
        serde_json::to_writer(
            &mut io.input,
            &json!({"id":id,"command":command,"args":args}),
        )
        .map_err(|e| e.to_string())?;
        io.input.write_all(b"\n").map_err(|e| e.to_string())?;
        io.input.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        io.output.read_line(&mut line).map_err(|e| e.to_string())?;
        let response: Value =
            serde_json::from_str(&line).map_err(|_| "Desktop engine disconnected".to_string())?;
        if response["id"] != id {
            return Err("Engine response ID mismatch".into());
        }
        if let Some(error) = response["error"].as_str() {
            return Err(error.into());
        }
        Ok(response["result"].clone())
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        if let Ok(io) = self.0.get_mut() {
            let _ = io.child.kill();
            let _ = io.child.wait();
        }
    }
}
#[tauri::command]
async fn engine(
    command: String,
    args: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let commands = [
        "state",
        "toggle",
        "settings",
        "exclusions",
        "payload",
        "save",
        "deleteClip",
        "deleteRecent",
        "correct",
        "export",
        "connect",
        "upload",
        "permissions",
    ];
    if !commands.contains(&command.as_str()) {
        return Err("Unknown desktop command".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Engine>()
            .request(&command, args.unwrap_or(json!({})))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn sidecar(name: &str) -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let folder = current.parent().ok_or("Executable directory unavailable")?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let direct = folder.join(format!("{name}{suffix}"));
    if direct.is_file() {
        return Ok(direct);
    }
    // Dev binaries retain the target suffix used by Tauri's bundler.
    let target = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        }
    } else if cfg!(windows) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{target}{suffix}"));
    if dev.is_file() {
        return Ok(dev);
    }
    Err(format!(
        "Missing native binary {name}; run scripts/desktop-build.sh --prepare"
    ))
}
// Transparent menu-bar artwork: the recording indicator is independent of the Dock icon.
fn status_icon(recording: bool) -> tauri::image::Image<'static> {
    let size = 44usize;
    let mut rgba = vec![0u8; size * size * 4];
    let circles = [
        (13.0f32, 13.0f32, 6.0f32),
        (29.0, 15.0, 4.5),
        (18.0, 31.0, 4.5),
    ];
    for y in 0..size {
        for x in 0..size {
            let mut color = [0, 0, 0, 0];
            for (cx, cy, r) in circles {
                let coverage = (r + 0.5
                    - ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt())
                .clamp(0.0, 1.0);
                if coverage > 0.0 {
                    color = [245, 245, 245, (coverage * 255.0) as u8];
                }
            }
            if recording {
                let distance = ((x as f32 - 35.0).powi(2) + (y as f32 - 35.0).powi(2)).sqrt();
                if distance < 6.0 {
                    color = [
                        239,
                        85,
                        85,
                        ((6.0 - distance).clamp(0.0, 1.0) * 255.0) as u8,
                    ];
                }
            }
            rgba[(y * size + x) * 4..(y * size + x) * 4 + 4].copy_from_slice(&color);
        }
    }
    tauri::image::Image::new_owned(rgba, size as u32, size as u32)
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let binary = sidecar("breadcrumb-engine").map_err(std::io::Error::other)?;
            let capture = sidecar("breadcrumb-capture").map_err(std::io::Error::other)?;
            let mut command = Command::new(binary);
            command
                .arg("--capture-helper")
                .arg(capture)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            let demo = std::env::args().any(|a| a == "--demo");
            if demo {
                let dir =
                    std::env::temp_dir().join(format!("breadcrumb-demo-{}", std::process::id()));
                command.arg("--demo").arg("--data-dir").arg(dir);
            }
            let mut child = command.spawn()?;
            let input = child.stdin.take().ok_or("Engine stdin unavailable")?;
            let output = BufReader::new(child.stdout.take().ok_or("Engine stdout unavailable")?);
            app.manage(Engine(Mutex::new(EngineIO {
                child,
                input,
                output,
                sequence: 0,
            })));
            let show = MenuItem::with_id(app, "show", "Open Breadcrumb", true, None::<&str>)?;
            let toggle = MenuItem::with_id(
                app,
                "toggle",
                "Pause / resume recording",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit Breadcrumb", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
            let tray = TrayIconBuilder::with_id("recording-status")
                .icon(status_icon(false))
                .icon_as_template(true)
                .menu(&menu)
                .tooltip("Breadcrumb")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "toggle" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let _ = app.state::<Engine>().request("toggle", json!({}));
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            tray.build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut previous = None;
                loop {
                    let state = handle.state::<Engine>().request("status", json!({}));
                    if let Ok(state) = state {
                        let recording = state["recording"].as_bool().unwrap_or(false);
                        if let Some(tray) = handle.tray_by_id("recording-status") {
                            if previous != Some(recording) {
                                let _ = tray.set_icon_with_as_template(
                                    Some(status_icon(recording)),
                                    !recording,
                                );
                                previous = Some(recording);
                            }
                            let _ = tray.set_tooltip(Some(format!(
                                "Breadcrumb · {}",
                                state["status"].as_str().unwrap_or("Paused")
                            )));
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
            });
            if std::env::args().any(|a| a == "--smoke-test") {
                let state = app
                    .state::<Engine>()
                    .request("state", json!({}))
                    .map_err(std::io::Error::other)?;
                if let Ok(path) = std::env::var("BREADCRUMB_SMOKE_OUTPUT") {
                    std::fs::write(path, serde_json::to_vec(&state)?)?;
                }
                app.handle().exit(0);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![engine])
        .run(tauri::generate_context!())
        .expect("Breadcrumb could not start");
}
