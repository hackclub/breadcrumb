//! Native compositor inventories. XWayland is never used to infer Wayland apps.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn area(&self, other: &Self) -> u64 {
        let width = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(other.x) + i64::from(other.width))
            - i64::from(self.x.max(other.x));
        let height = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(other.y) + i64::from(other.height))
            - i64::from(self.y.max(other.y));
        width.max(0) as u64 * height.max(0) as u64
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Monitor {
    pub id: String,
    pub rect: Rect,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Window {
    pub id: String,
    pub pid: u32,
    pub app: String,
    #[serde(rename = "bundleID")]
    pub bundle_id: String,
    pub title: String,
    pub rect: Rect,
    pub focused: bool,
    pub visible: bool,
}
impl Window {
    pub fn key(&self) -> String {
        format!("{}:{}:{}", self.bundle_id, self.id, self.title)
    }
    pub fn excluded(&self, exclusions: &[String]) -> bool {
        [
            self.app.as_str(),
            self.bundle_id.as_str(),
            self.bundle_id.trim_end_matches(".desktop"),
        ]
        .iter()
        .any(|name| super::excluded(name, exclusions))
            || std::fs::read_link(format!("/proc/{}/exe", self.pid))
                .ok()
                .and_then(|path| {
                    path.file_name()
                        .map(|s| super::excluded(&s.to_string_lossy(), exclusions))
                })
                .unwrap_or(false)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Desktop {
    pub windows: Vec<Window>,
    pub monitors: Vec<Monitor>,
    pub locked: bool,
}
impl Desktop {
    pub fn focused(&self) -> Option<&Window> {
        self.windows.iter().find(|w| w.focused && w.visible)
    }
    pub fn monitor(&self, window: &Window) -> Option<&Monitor> {
        self.monitors
            .iter()
            .filter(|m| m.rect.area(&window.rect) > 0)
            .max_by_key(|m| m.rect.area(&window.rect))
    }
    pub fn ensure_allowed(&self, monitor: &Monitor, exclusions: &[String]) -> Result<(), String> {
        if self.locked {
            return Err("Capture paused while the desktop is locked".into());
        }
        if self
            .windows
            .iter()
            .any(|w| w.visible && w.rect.area(&monitor.rect) > 0 && w.excluded(exclusions))
        {
            return Err("Capture skipped: an excluded app may be visible on this display".into());
        }
        Ok(())
    }
    fn validate(self) -> Result<Self, String> {
        if self.windows.len() > 4096
            || self
                .windows
                .iter()
                .filter(|w| w.focused && w.visible)
                .count()
                > 1
            || self
                .monitors
                .iter()
                .any(|m| m.id.is_empty() || m.rect.width == 0 || m.rect.height == 0)
            || self.monitors.is_empty()
            || self.monitors.len() > 32
            || self
                .windows
                .iter()
                .any(|w| w.visible && (w.id.is_empty() || w.bundle_id.is_empty()))
        {
            return Err("Incomplete compositor window inventory; capture skipped".into());
        }
        Ok(self)
    }
}
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("Linux session runtime")
    })
}
fn socket(path: PathBuf) -> Result<UnixStream, String> {
    let socket = UnixStream::connect(path).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(400)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_millis(400)))
        .map_err(|e| e.to_string())?;
    Ok(socket)
}
fn sway_message(path: &str, kind: u32) -> Result<Value, String> {
    let mut stream = socket(path.into())?;
    let mut message = b"i3-ipc".to_vec();
    message.extend(0u32.to_ne_bytes());
    message.extend(kind.to_ne_bytes());
    stream.write_all(&message).map_err(|e| e.to_string())?;
    let mut header = [0; 14];
    stream.read_exact(&mut header).map_err(|e| e.to_string())?;
    let length = u32::from_ne_bytes(header[6..10].try_into().unwrap()) as usize;
    if &header[..6] != b"i3-ipc"
        || length > 8 * 1024 * 1024
        || u32::from_ne_bytes(header[10..14].try_into().unwrap()) != kind
    {
        return Err("Invalid Sway IPC reply".into());
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}
fn rect(value: &Value) -> Result<Rect, String> {
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}
fn string(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}
fn sway(tree: &Value, outputs: &Value) -> Result<Desktop, String> {
    let outputs = outputs.as_array().ok_or("Missing Sway outputs")?;
    let monitors = outputs
        .iter()
        .filter(|o| o["active"] == true)
        .map(|o| {
            Ok(Monitor {
                id: string(&o["name"]),
                rect: rect(&o["rect"])?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let active: Vec<String> = outputs
        .iter()
        .filter_map(|o| o["current_workspace"].as_str().map(str::to_owned))
        .collect();
    fn visit(
        node: &Value,
        shown: bool,
        active: &[String],
        windows: &mut Vec<Window>,
    ) -> Result<(), String> {
        if windows.len() > 4096 {
            return Err("Too many compositor windows".into());
        }
        let shown = if node["type"] == "workspace" {
            active.contains(&string(&node["name"]))
        } else {
            shown
        };
        if let Some(pid) = node["pid"].as_u64() {
            let app = node["app_id"]
                .as_str()
                .or_else(|| node["window_properties"]["class"].as_str())
                .unwrap_or_default()
                .to_owned();
            windows.push(Window {
                id: node["id"].to_string(),
                pid: pid as u32,
                app: app.clone(),
                bundle_id: app,
                title: string(&node["name"]),
                rect: rect(&node["rect"])?,
                focused: node["focused"] == true,
                visible: (shown || node["sticky"] == true) && node["scratchpad_state"] != "fresh",
            });
        }
        for key in ["nodes", "floating_nodes"] {
            if let Some(children) = node[key].as_array() {
                for child in children {
                    visit(child, shown, active, windows)?;
                }
            }
        }
        Ok(())
    }
    let mut windows = Vec::new();
    visit(tree, true, &active, &mut windows)?;
    Ok(Desktop {
        windows,
        monitors,
        locked: false,
    })
}
fn hypr_request(path: &std::path::Path, command: &str) -> Result<Value, String> {
    let mut stream = socket(path.into())?;
    stream
        .write_all(command.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut body = Vec::new();
    stream
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > 8 * 1024 * 1024 {
        return Err("Compositor reply exceeds size limit".into());
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}
fn hypr(monitors: &Value, clients: &Value, focused: &Value) -> Result<Desktop, String> {
    let outputs = monitors.as_array().ok_or("Missing Hyprland monitors")?;
    let monitors = outputs
        .iter()
        .map(|m| {
            let scale = m["scale"].as_f64().filter(|s| *s > 0.0).unwrap_or(1.0);
            let mut w = m["width"].as_u64().unwrap_or(0);
            let mut h = m["height"].as_u64().unwrap_or(0);
            if m["transform"].as_u64().unwrap_or(0) % 2 == 1 {
                std::mem::swap(&mut w, &mut h);
            }
            Monitor {
                id: string(&m["name"]),
                rect: Rect {
                    x: m["x"].as_i64().unwrap_or(0) as i32,
                    y: m["y"].as_i64().unwrap_or(0) as i32,
                    width: (w as f64 / scale).round() as u32,
                    height: (h as f64 / scale).round() as u32,
                },
            }
        })
        .collect();
    let windows = clients
        .as_array()
        .ok_or("Missing Hyprland clients")?
        .iter()
        .map(|w| {
            let visible = outputs.iter().any(|m| {
                m["id"] == w["monitor"]
                    && (m["activeWorkspace"]["id"] == w["workspace"]["id"]
                        || m["specialWorkspace"]["id"] == w["workspace"]["id"]
                        || w["pinned"] == true)
            });
            Window {
                id: string(&w["address"]),
                pid: w["pid"].as_u64().unwrap_or(0) as u32,
                app: string(&w["class"]),
                bundle_id: string(&w["class"]),
                title: string(&w["title"]),
                rect: Rect {
                    x: w["at"][0].as_i64().unwrap_or(0) as i32,
                    y: w["at"][1].as_i64().unwrap_or(0) as i32,
                    width: w["size"][0].as_u64().unwrap_or(0) as u32,
                    height: w["size"][1].as_u64().unwrap_or(0) as u32,
                },
                focused: w["address"] == focused["address"],
                visible: visible && w["mapped"] == true && w["hidden"] != true,
            }
        })
        .collect();
    Ok(Desktop {
        monitors,
        windows,
        locked: false,
    })
}
#[derive(Clone)]
struct Receiver(Arc<Mutex<Option<String>>>);
#[zbus::interface(name = "app.breadcrumb.Desktop")]
impl Receiver {
    fn publish(&self, value: &str) {
        if value.len() <= 8 * 1024 * 1024 {
            *self.0.lock().unwrap() = Some(value.to_owned());
        }
    }
}
async fn kwin(connection: &zbus::Connection) -> Result<Desktop, String> {
    let value = Arc::new(Mutex::new(None));
    let receiver = zbus::connection::Builder::session()
        .serve_at("/app/breadcrumb/Desktop", Receiver(value.clone()))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let mut script = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    script
        .write_all(
            include_str!("../integrations/kwin/snapshot.js")
                .replace(
                    "__DESTINATION__",
                    &serde_json::to_string(receiver.unique_name().unwrap().as_str()).unwrap(),
                )
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    let proxy = zbus::Proxy::new(
        connection,
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
    )
    .await
    .map_err(|e| e.to_string())?;
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let label = format!(
        "breadcrumb-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let id: i32 = proxy
        .call(
            "loadScript",
            &(script.path().to_string_lossy().as_ref(), label.as_str()),
        )
        .await
        .map_err(|e| e.to_string())?;
    if id < 0 {
        return Err("KWin refused the desktop context script".into());
    }
    let result = async {
        let path = format!("/Scripting/Script{id}");
        let script_proxy = zbus::Proxy::new(
            connection,
            "org.kde.KWin",
            path.as_str(),
            "org.kde.kwin.Script",
        )
        .await
        .map_err(|e| e.to_string())?;
        script_proxy
            .call::<_, _, ()>("run", &())
            .await
            .map_err(|e| e.to_string())?;
        for _ in 0..40 {
            if let Some(json) = value.lock().unwrap().take() {
                return serde_json::from_str(&json).map_err(|e| e.to_string());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Err("KWin desktop context timed out".into())
    }
    .await;
    let _ = proxy.call::<_, _, bool>("unloadScript", &(label,)).await;
    result
}
pub fn snapshot() -> Result<Desktop, String> {
    let mut desktop = if let Ok(path) = std::env::var("SWAYSOCK") {
        sway(&sway_message(&path, 4)?, &sway_message(&path, 3)?)?
    } else if let Ok(instance) = std::env::var("HYPRLAND_INSTANCE_SIGNATURE") {
        if instance.is_empty()
            || !instance
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("Invalid Hyprland instance".into());
        }
        let path = PathBuf::from(std::env::var("XDG_RUNTIME_DIR").map_err(|e| e.to_string())?)
            .join("hypr")
            .join(instance)
            .join(".socket.sock");
        hypr(
            &hypr_request(&path, "j/monitors")?,
            &hypr_request(&path, "j/clients")?,
            &hypr_request(&path, "j/activewindow")?,
        )?
    } else {
        runtime().block_on(async {
            tokio::time::timeout(Duration::from_secs(2), async {
                let connection = zbus::Connection::session()
                    .await
                    .map_err(|e| e.to_string())?;
                let bus = zbus::fdo::DBusProxy::new(&connection)
                    .await
                    .map_err(|e| e.to_string())?;
                if bus
                    .name_has_owner("org.gnome.Shell".try_into().unwrap())
                    .await
                    .unwrap_or(false)
                {
                    let proxy = zbus::Proxy::new(
                        &connection,
                        "org.gnome.Shell",
                        "/app/breadcrumb/Desktop",
                        "app.breadcrumb.Desktop",
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    let json: String = proxy
                        .call("Snapshot", &())
                        .await
                        .map_err(|e| format!("Enable the Breadcrumb GNOME extension: {e}"))?;
                    if json.len() > 8 * 1024 * 1024 {
                        return Err("Compositor reply exceeds size limit".into());
                    }
                    serde_json::from_str(&json).map_err(|e| e.to_string())
                } else if bus
                    .name_has_owner("org.kde.KWin".try_into().unwrap())
                    .await
                    .unwrap_or(false)
                {
                    kwin(&connection).await
                } else {
                    Err("No native compositor context integration is available".into())
                }
            })
            .await
            .map_err(|_| "Desktop context timed out".to_owned())?
        })?
    };
    desktop.locked |= super::linux_idle::locked();
    desktop.validate()
}

pub fn kind() -> String {
    if std::env::var_os("SWAYSOCK").is_some() {
        return "Sway".into();
    }
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        return "Hyprland".into();
    }
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase();
    if desktop.contains("gnome") {
        "GNOME".into()
    } else if desktop.contains("kde") {
        "KDE".into()
    } else {
        "".into()
    }
}
pub fn install() -> Result<String, String> {
    if kind() != "GNOME" {
        return Err("GNOME integration is only needed in a GNOME session. KDE, Sway and Hyprland use native session APIs.".into());
    }
    let directory = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .ok_or("No user data directory")?
        .join("gnome-shell/extensions/breadcrumb@hackclub.com");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    for (name, data) in [
        (
            "metadata.json",
            include_str!("../integrations/gnome/breadcrumb@hackclub.com/metadata.json"),
        ),
        (
            "extension.js",
            include_str!("../integrations/gnome/breadcrumb@hackclub.com/extension.js"),
        ),
    ] {
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        file.persist(directory.join(name))
            .map_err(|e| e.to_string())?;
    }
    let enabled = runtime().block_on(async {
        tokio::time::timeout(Duration::from_secs(2), async {
            let connection = zbus::Connection::session().await.ok()?;
            let proxy = zbus::Proxy::new(
                &connection,
                "org.gnome.Shell",
                "/org/gnome/Shell/Extensions",
                "org.gnome.Shell.Extensions",
            )
            .await
            .ok()?;
            let _ = proxy
                .call::<_, _, ()>("ReloadExtension", &("breadcrumb@hackclub.com",))
                .await;
            proxy
                .call::<_, _, bool>("EnableExtension", &("breadcrumb@hackclub.com",))
                .await
                .ok()
        })
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
    });
    Ok(if enabled {"GNOME desktop integration enabled."} else {"GNOME integration installed. Log out and back in, then enable Breadcrumb desktop context in Extensions."}.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn outputs() -> Value {
        json!([{"name":"DP-1","active":true,"current_workspace":"1","rect":{"x":-800,"y":0,"width":800,"height":600}},{"name":"DP-2","active":true,"current_workspace":"2","rect":{"x":0,"y":0,"width":800,"height":600}}])
    }
    fn window(id: u64, app: &str, x: i32, focused: bool) -> Value {
        json!({"id":id,"pid":9999999,"app_id":app,"name":"Example","rect":{"x":x,"y":20,"width":300,"height":300},"focused":focused,"nodes":[],"floating_nodes":[]})
    }
    #[test]
    fn sway_uses_native_apps_workspaces_and_spanning_exclusions() {
        let tree = json!({"nodes":[{"type":"workspace","name":"1","nodes":[window(1,"Editor",-600,true)]},{"type":"workspace","name":"2","floating_nodes":[window(2,"Bitwarden",-20,false)]},{"type":"workspace","name":"3","nodes":[window(3,"Hidden",20,false)]}]});
        let desktop = sway(&tree, &outputs()).unwrap().validate().unwrap();
        let focused = desktop.focused().unwrap();
        assert_eq!(focused.bundle_id, "Editor");
        assert_eq!(desktop.monitor(focused).unwrap().id, "DP-1");
        assert!(!desktop.windows[2].visible);
        for monitor in &desktop.monitors {
            assert!(desktop.ensure_allowed(monitor, &[]).is_err());
        }
    }
    #[test]
    fn hyprland_handles_fractional_scale_and_active_workspaces() {
        let monitors = json!([{"id":0,"name":"eDP-1","x":0,"y":0,"width":2400,"height":1600,"scale":2.0,"transform":0,"activeWorkspace":{"id":1},"specialWorkspace":{"id":-1}}]);
        let clients = json!([{"address":"0x1","pid":999999,"class":"Editor","title":"Main","at":[10,20],"size":[500,300],"monitor":0,"mapped":true,"hidden":false,"workspace":{"id":1}},{"address":"0x2","pid":999999,"class":"PasswordManager","at":[10,20],"size":[500,300],"monitor":0,"mapped":true,"workspace":{"id":2}}]);
        let desktop = hypr(&monitors, &clients, &json!({"address":"0x1"}))
            .unwrap()
            .validate()
            .unwrap();
        assert_eq!(desktop.monitors[0].rect.width, 1200);
        assert_eq!(desktop.focused().unwrap().id, "0x1");
        assert!(!desktop.windows[1].visible);
        assert!(desktop
            .ensure_allowed(&desktop.monitors[0], &["editor".into()])
            .is_err());
    }
    #[test]
    fn incomplete_inventory_and_locked_desktops_fail_closed() {
        let mut desktop = sway(&json!({"nodes":[window(1,"",0,true)]}), &outputs()).unwrap();
        assert!(desktop.clone().validate().is_err());
        desktop.windows[0].bundle_id = "Editor".into();
        desktop.locked = true;
        assert!(desktop.ensure_allowed(&desktop.monitors[0], &[]).is_err());
        assert_eq!(
            Rect {
                x: i32::MAX,
                y: 0,
                width: u32::MAX,
                height: 5
            }
            .area(&Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 1
            }),
            0
        );
    }
}
