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
            role == "Edit" || role == "Document" || element.is_password().unwrap_or(true);
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
pub fn snapshot() -> (Vec<Value>, String) {
    // AT-SPI is queried through its standard D-Bus interface below. Missing bus
    // access is a reported capability gap, never a fabricated empty success.
    match linux_snapshot() {
        Ok(rows) => (rows, "Filtered AT-SPI tree (bounded)".into()),
        Err(e) => (vec![], format!("AT-SPI unavailable: {e}")),
    }
}
#[cfg(target_os = "linux")]
fn linux_snapshot() -> Result<Vec<Value>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let connection = atspi::AccessibilityConnection::new()
            .await
            .map_err(|e| e.to_string())?;
        let registry = atspi::proxy::accessible::AccessibleProxy::builder(connection.connection())
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
        while let Some((reference, depth)) = stack.pop() {
            if depth > 7 || rows.len() >= 180 || std::time::Instant::now() > deadline {
                break;
            }
            let proxy = atspi::proxy::accessible::AccessibleProxy::builder(connection.connection())
                .destination(reference.name().ok_or("Missing AT-SPI bus name")?.as_str())
                .map_err(|e| e.to_string())?
                .path(reference.path().as_str())
                .map_err(|e| e.to_string())?
                .build()
                .await
                .map_err(|e| e.to_string())?;
            let states = proxy.get_state().await.map_err(|e| e.to_string())?;
            // Traverse applications but include only their active/showing windows.
            if depth == 1 && !states.contains(atspi::State::Active) {
                continue;
            }
            let role = proxy.get_role_name().await.unwrap_or_default();
            let editable =
                role.contains("text") || role.contains("entry") || role.contains("password");
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
        Ok(rows)
    })
}
#[cfg(not(any(windows, target_os = "linux")))]
pub fn snapshot() -> (Vec<Value>, String) {
    (
        vec![],
        "Use the ScreenCaptureKit Swift adapter on macOS".into(),
    )
}
