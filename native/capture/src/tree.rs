#[cfg(any(windows, target_os = "linux"))]
use serde_json::json;
use serde_json::Value;
#[cfg(windows)]
pub fn snapshot() -> (Vec<Value>, String) {
    use uiautomation::{UIAutomation, UIElement};
    fn visit(
        element: UIElement,
        walker: &uiautomation::UITreeWalker,
        depth: u32,
        rows: &mut Vec<Value>,
        deadline: std::time::Instant,
    ) {
        if depth > 7 || rows.len() >= 180 || std::time::Instant::now() > deadline {
            return;
        }
        let role = element
            .get_control_type()
            .map(|r| format!("{:?}", r))
            .unwrap_or_default();
        let editable =
            role == "Edit" || role == "ComboBox" || element.is_password().unwrap_or(true);
        let label = if editable {
            None
        } else {
            element
                .get_name()
                .ok()
                .map(|s| s.chars().take(120).collect::<String>())
        };
        rows.push(json!({"role":role,"label":label,"depth":depth}));
        if editable {
            return;
        }
        if let Ok(mut child) = walker.get_first_child(&element) {
            loop {
                visit(child.clone(), walker, depth + 1, rows, deadline);
                if rows.len() >= 180 || std::time::Instant::now() > deadline {
                    break;
                }
                match walker.get_next_sibling(&child) {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
            }
        }
    }
    let result = (|| {
        let automation = UIAutomation::new()?;
        let focused = automation.get_focused_element()?;
        let walker = automation.get_control_view_walker()?;
        let mut window = focused.clone();
        for _ in 0..20 {
            if format!("{:?}", window.get_control_type()?) == "Window" {
                break;
            }
            match walker.get_parent(&window) {
                Ok(parent) => window = parent,
                Err(_) => break,
            }
        }
        let mut rows = Vec::new();
        visit(
            window,
            &walker,
            0,
            &mut rows,
            std::time::Instant::now() + std::time::Duration::from_millis(700),
        );
        Ok::<_, uiautomation::Error>(rows)
    })();
    match result {
        Ok(rows) => (rows, "Filtered UI Automation tree (bounded)".into()),
        Err(_) => (
            vec![],
            "UI Automation unavailable for focused window".into(),
        ),
    }
}
#[cfg(target_os = "linux")]
pub fn snapshot_for(pid: u32, title: &str) -> (Vec<Value>, String) {
    match linux_snapshot(Some((pid, title))) {
        Ok(rows) => (
            rows,
            "Filtered AT-SPI tree for the matching foreground window".into(),
        ),
        Err(error) => (Vec::new(), format!("AT-SPI unavailable: {error}")),
    }
}
#[cfg(target_os = "linux")]
fn linux_snapshot(target: Option<(u32, &str)>) -> Result<Vec<Value>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        tokio::time::timeout(std::time::Duration::from_millis(900), async {
            let connection = atspi::AccessibilityConnection::new()
                .await
                .map_err(|e| e.to_string())?;
            let registry =
                atspi::proxy::accessible::AccessibleProxy::builder(connection.connection())
                    .destination("org.a11y.atspi.Registry")
                    .map_err(|e| e.to_string())?
                    .path("/org/a11y/atspi/accessible/root")
                    .map_err(|e| e.to_string())?
                    .build()
                    .await
                    .map_err(|e| e.to_string())?;
            let mut stack = registry
                .get_children()
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|r| (r, 0u32))
                .collect::<Vec<_>>();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(700);
            let mut rows = Vec::new();
            let mut matches = 0;
            while let Some((reference, depth)) = stack.pop() {
                if depth > 7 || rows.len() >= 180 || std::time::Instant::now() > deadline {
                    break;
                }
                let proxy =
                    atspi::proxy::accessible::AccessibleProxy::builder(connection.connection())
                        .destination(reference.name().ok_or("Missing AT-SPI bus name")?.as_str())
                        .map_err(|e| e.to_string())?
                        .path(reference.path().as_str())
                        .map_err(|e| e.to_string())?
                        .build()
                        .await
                        .map_err(|e| e.to_string())?;
                if let Some((pid, title)) = target {
                    if depth == 0 {
                        let bus = atspi::zbus::fdo::DBusProxy::new(connection.connection())
                            .await
                            .map_err(|e| e.to_string())?;
                        let name = reference
                            .name()
                            .ok_or("Missing application bus name")?
                            .as_str()
                            .try_into()
                            .map_err(|_| "Invalid application bus name")?;
                        if bus
                            .get_connection_unix_process_id(name)
                            .await
                            .map_err(|e| e.to_string())?
                            != pid
                        {
                            continue;
                        }
                    } else if depth == 1 {
                        if proxy.name().await.map_err(|e| e.to_string())? != title {
                            continue;
                        }
                        matches += 1;
                        if matches > 1 {
                            return Err("Accessible window identity is ambiguous".to_owned());
                        }
                    }
                }
                let states = proxy.get_state().await.map_err(|e| e.to_string())?;
                // Traverse applications but include only their active/showing windows.
                if target.is_none() && depth == 1 && !states.contains(atspi::State::Active) {
                    continue;
                }
                let role = proxy.get_role_name().await.unwrap_or_default();
                let editable = states.contains(atspi::State::Editable)
                    || role.contains("text")
                    || role.contains("entry")
                    || role.contains("password")
                    || role == "combo box";
                let label = if editable {
                    None
                } else {
                    proxy
                        .name()
                        .await
                        .ok()
                        .map(|s| s.chars().take(120).collect::<String>())
                };
                if depth > 0 {
                    rows.push(json!({"role":role,"label":label,"depth":depth-1}));
                }
                if !editable {
                    if let Ok(children) = proxy.get_children().await {
                        stack.extend(children.into_iter().rev().take(60).map(|r| (r, depth + 1)));
                    }
                }
            }
            if target.is_some() && matches != 1 {
                return Err(
                    "Focused application does not expose a matching accessible window".to_owned(),
                );
            }
            Ok(rows)
        })
        .await
        .map_err(|_| "AT-SPI query timed out".to_string())?
    })
}
#[cfg(not(any(windows, target_os = "linux")))]
pub fn snapshot() -> (Vec<Value>, String) {
    (
        vec![],
        "Use the ScreenCaptureKit Swift adapter on macOS".into(),
    )
}
