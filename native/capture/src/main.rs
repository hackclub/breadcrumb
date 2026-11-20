use image::codecs::jpeg::JpegEncoder;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
mod tree;

fn capabilities() -> Value {
    let supported = session_error().is_none();
    json!({"screenshot":supported,"accessibility":supported && cfg!(any(windows,target_os="linux")),"ocr":false,"windowContext":supported,"exclusions":if supported {"skip-when-visible"} else {"unsupported-session"},"backend":if cfg!(windows){"Windows native capture + UI Automation"}else{"X11 capture + AT-SPI"},"permission":if supported {"managed-by-desktop"} else {"unsupported-session"}})
}
fn session_error() -> Option<&'static str> {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut std::ffi::c_void;
            fn CloseDesktop(desktop: *mut std::ffi::c_void) -> i32;
        }
        // A service session, lock screen, or secure UAC desktop cannot be captured
        // by this normal, non-UIAccess app. Retry after the user desktop returns.
        let desktop = unsafe { OpenInputDesktop(0, 0, 1) };
        if desktop.is_null() {
            return Some("Screen capture is unavailable in this Windows session. Unlock Windows and run Breadcrumb in your signed-in desktop, not as a service.");
        }
        unsafe {
            CloseDesktop(desktop);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WAYLAND_DISPLAY").is_ok_and(|value| !value.is_empty())
            || std::env::var("XDG_SESSION_TYPE")
                .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
        {
            return Some("Wayland capture is not supported yet: XWayland cannot reliably identify native windows or enforce exclusions. Use an X11 login session.");
        }
        if !std::env::var("DISPLAY").is_ok_and(|value| !value.is_empty()) {
            return Some(
                "No X11 display is available. Start Breadcrumb inside an X11 desktop session.",
            );
        }
    }
    None
}
fn excluded(app: &str, exclusions: &[String]) -> bool {
    let app = app.to_lowercase();
    [
        "breadcrumb",
        "1password",
        "bitwarden",
        "keepass",
        "lastpass",
    ]
    .iter()
    .any(|s| app.contains(s))
        || exclusions.iter().any(|s| app == s.to_lowercase())
}
fn intersects(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> bool {
    i64::from(a.0) < i64::from(b.0) + i64::from(b.2)
        && i64::from(a.0) + i64::from(a.2) > i64::from(b.0)
        && i64::from(a.1) < i64::from(b.1) + i64::from(b.3)
        && i64::from(a.1) + i64::from(a.3) > i64::from(b.1)
}
fn on_display(window: &xcap::Window, monitor: &xcap::Monitor) -> xcap::XCapResult<bool> {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetClassNameW(window: *mut std::ffi::c_void, name: *mut u16, size: i32) -> i32;
        }
        let mut name = [0u16; 256];
        let length = unsafe {
            GetClassNameW(
                window.id()? as usize as *mut _,
                name.as_mut_ptr(),
                name.len() as i32,
            )
        };
        let class = String::from_utf16_lossy(&name[..length.max(0) as usize]);
        // Tao and the single-instance plugin mark their transparent event targets
        // WS_VISIBLE. They contain no pixels, but would otherwise make Breadcrumb
        // exclude its own display forever, even with the overview hidden.
        if matches!(
            class.as_str(),
            "Tao Thread Event Target" | "app.rewind.local-sic"
        ) {
            return Ok(false);
        }
    }
    Ok(intersects(
        (window.x()?, window.y()?, window.width()?, window.height()?),
        (
            monitor.x()?,
            monitor.y()?,
            monitor.width()?,
            monitor.height()?,
        ),
    ))
}
fn ensure_allowed(
    windows: &[xcap::Window],
    monitor: &xcap::Monitor,
    exclusions: &[String],
) -> Result<(), String> {
    for window in windows {
        if !window.is_minimized().unwrap_or(false)
            && excluded(&window.app_name().unwrap_or_default(), exclusions)
            && on_display(window, monitor).unwrap_or(true)
        {
            return Err("Capture skipped: an excluded app may be visible on this display".into());
        }
    }
    Ok(())
}
fn perform(request: &Value) -> Result<Value, String> {
    let command = request["command"].as_str().unwrap_or("");
    if command.starts_with("icon:") {
        return Ok(serde_json::json!({"ok":true,"icon":""}));
    }
    if command == "permissions" {
        return Ok(
            json!({"ok":true,"capabilities":capabilities(),"message":session_error().unwrap_or("Use the operating system screen-sharing/accessibility settings.")}),
        );
    }
    if let Some(error) = session_error() {
        return Err(error.into());
    }
    let exclusions: Vec<String> = request["exclusions"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let windows = xcap::Window::all().map_err(|e| format!("Window context unavailable: {e}. Linux requires an X11 session for reliable foreground metadata."))?;
    let focused = windows.iter().find(|w| w.is_focused().unwrap_or(false));
    let Some(focused) = focused else {
        return Ok(json!({"ok":true,"contextKey":"","capabilities":capabilities()}));
    };
    let app = focused.app_name().unwrap_or_default();
    let title = focused.title().unwrap_or_default();
    if excluded(&app, &exclusions) {
        return Ok(json!({"ok":true,"contextKey":"","capabilities":capabilities()}));
    }
    let id = focused.id().map_err(|e| e.to_string())?;
    let key = format!("{}:{}:{}", app, id, title);
    if command == "probe" {
        return Ok(json!({"ok":true,"contextKey":key,"capabilities":capabilities()}));
    }
    if command != "capture" {
        return Err("Unknown capture command".into());
    }
    let monitor = focused.current_monitor().map_err(|e| e.to_string())?;
    // These platforms cannot natively omit arbitrary other apps from a display image.
    // Skip a sample when an excluded on-screen window may be visible, instead of
    // claiming it was filtered. This is deliberately conservative about occlusion.
    ensure_allowed(&windows, &monitor, &exclusions)?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Screen capture unavailable: {e}"))?;
    let width = request["settings"]["maximumWidth"].as_u64().unwrap_or(0) as u32;
    let image = if width > 0 && image.width() > width {
        image::imageops::resize(
            &image,
            width,
            (image.height() as f64 * width as f64 / image.width() as f64)
                .round()
                .max(1.0) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let quality = (request["settings"]["jpegQuality"]
        .as_f64()
        .unwrap_or(0.65)
        .clamp(0.3, 0.95)
        * 100.0) as u8;
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    let (tree, tree_status) = tree::snapshot();
    // Re-read focus after pixels/tree; never pair them with a different app/window.
    let after = xcap::Window::all().map_err(|e| e.to_string())?;
    ensure_allowed(&after, &monitor, &exclusions)?;
    if !after.iter().any(|w| {
        w.id().ok() == Some(id)
            && w.is_focused().unwrap_or(false)
            && w.title().unwrap_or_default() == title
    }) {
        return Err("Focus changed during capture; sample discarded".into());
    }
    let mut visible = Vec::new();
    for window in &windows {
        if visible.len() >= 20 {
            break;
        }
        if window.is_minimized().unwrap_or(false)
            || excluded(&window.app_name().unwrap_or_default(), &exclusions)
        {
            continue;
        }
        if !on_display(window, &monitor).unwrap_or(true) {
            continue;
        }
        visible.push(json!({"windowID":window.id().unwrap_or(0),"app":window.app_name().unwrap_or_default(),"bundleID":window.app_name().unwrap_or_default(),"title":window.title().unwrap_or_default(),"focused":window.id().ok()==Some(id),"visibility":"on-screen-window; occlusion unknown"}));
    }
    Ok(
        json!({"ok":true,"contextKey":key,"capabilities":capabilities(),"record":{"app":app,"bundleID":app,"windowTitle":title,"windowID":id,"treeStatus":tree_status,"captureScope":"display","displayID":monitor.id().unwrap_or(0),"visibleWindows":visible},"payload":{"jpeg":base64(&jpeg),"tree":tree}}),
    )
}
fn base64(input: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(TABLE[(n >> 18) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(request) => perform(&request).unwrap_or_else(
                    |error| json!({"ok":false,"error":error,"capabilities":capabilities()}),
                ),
                Err(_) => json!({"ok":false,"error":"Invalid capture request"}),
            },
            Err(_) => break,
        };
        if serde_json::to_writer(&mut stdout, &response).is_err() {
            break;
        };
        if stdout.write_all(b"\n").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"a"), "YQ==");
        assert_eq!(base64(b"abc"), "YWJj");
    }
    #[test]
    fn exclusions_are_case_insensitive() {
        assert!(excluded("Bitwarden", &[]));
        assert!(excluded("Example.EXE", &["example.exe".into()]));
        assert!(!excluded("Editor", &[]));
    }
    #[test]
    fn spanning_windows_intersect_both_displays() {
        assert!(intersects((402, 590, 238, 290), (0, 0, 800, 600)));
        assert!(intersects((402, 590, 238, 290), (0, 600, 800, 600)));
        assert!(!intersects((0, 600, 100, 100), (0, 0, 800, 600)));
        assert!(intersects((-50, -20, 100, 100), (0, 0, 800, 600)));
    }
}
