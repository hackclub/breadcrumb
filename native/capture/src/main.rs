use image::codecs::jpeg::JpegEncoder;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
mod tree;

fn capabilities() -> Value {
    json!({"screenshot":true,"accessibility":cfg!(any(windows,target_os="linux")),"ocr":false,"windowContext":true,"exclusions":"skip-when-visible","backend":if cfg!(windows){"Windows native capture + UI Automation"}else{"X11/Wayland capture + AT-SPI"},"permission":"managed-by-desktop"})
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
fn perform(request: &Value) -> Result<Value, String> {
    let command = request["command"].as_str().unwrap_or("");
    if command == "permissions" {
        return Ok(
            json!({"ok":true,"capabilities":capabilities(),"message":"Use the operating system screen-sharing/accessibility settings. Wayland may show its own chooser."}),
        );
    }
    let exclusions: Vec<String> = request["exclusions"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let windows = xcap::Window::all().map_err(|e| format!("Window context unavailable: {e}"))?;
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
    for window in &windows {
        if !window.is_minimized().unwrap_or(true)
            && window
                .current_monitor()
                .map(|m| m.id().ok() == monitor.id().ok())
                .unwrap_or(false)
            && excluded(&window.app_name().unwrap_or_default(), &exclusions)
        {
            return Err("Capture skipped: an excluded app may be visible on this display".into());
        }
    }
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
        if window.is_minimized().unwrap_or(true)
            || excluded(&window.app_name().unwrap_or_default(), &exclusions)
        {
            continue;
        }
        if window
            .current_monitor()
            .map(|m| m.id().ok() != monitor.id().ok())
            .unwrap_or(true)
        {
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
}
