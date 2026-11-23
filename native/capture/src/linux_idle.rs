//! Aggregate idle notifications only: no keyboard, pointer, or touch events.
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use wayland_client::{
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_registry, wl_seat},
    Connection, Dispatch, QueueHandle,
};
use wayland_protocols::ext::idle_notify::v1::client::{
    ext_idle_notification_v1, ext_idle_notifier_v1,
};
#[derive(Default)]
struct Status {
    connected: bool,
    since: Option<Instant>,
}
struct State(Arc<Mutex<Status>>);
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<wl_seat::WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        _: &wl_seat::WlSeat,
        _: wl_seat::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<ext_idle_notifier_v1::ExtIdleNotifierV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ext_idle_notifier_v1::ExtIdleNotifierV1,
        _: ext_idle_notifier_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<ext_idle_notification_v1::ExtIdleNotificationV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &ext_idle_notification_v1::ExtIdleNotificationV1,
        event: ext_idle_notification_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let mut status = state.0.lock().unwrap();
        match event {
            ext_idle_notification_v1::Event::Idled => {
                status.since = Some(Instant::now() - Duration::from_secs(1))
            }
            ext_idle_notification_v1::Event::Resumed => status.since = None,
            _ => {}
        }
    }
}
fn notification_seconds() -> Option<f64> {
    static STATUS: OnceLock<Arc<Mutex<Status>>> = OnceLock::new();
    let status = STATUS.get_or_init(|| {
        let shared = Arc::new(Mutex::new(Status::default()));
        let thread_status = shared.clone();
        let (ready, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = (|| {
                let connection = Connection::connect_to_env().ok()?;
                let (globals, mut queue) = registry_queue_init::<State>(&connection).ok()?;
                let handle = queue.handle();
                let seat: wl_seat::WlSeat = globals.bind(&handle, 1..=1, ()).ok()?;
                let notifier: ext_idle_notifier_v1::ExtIdleNotifierV1 =
                    globals.bind(&handle, 1..=1, ()).ok()?;
                let _notification = notifier.get_idle_notification(1000, &seat, &handle, ());
                let mut state = State(thread_status.clone());
                queue.roundtrip(&mut state).ok()?;
                thread_status.lock().unwrap().connected = true;
                let _ = ready.send(());
                while queue.blocking_dispatch(&mut state).is_ok() {}
                Some(())
            })();
            let _ = result;
            thread_status.lock().unwrap().connected = false;
        });
        let _ = receiver.recv_timeout(Duration::from_millis(700));
        shared
    });
    let status = status.lock().unwrap();
    status
        .connected
        .then(|| status.since.map_or(0.0, |at| at.elapsed().as_secs_f64()))
}
pub fn seconds() -> Option<f64> {
    if let Some(seconds) = notification_seconds() {
        return Some(seconds);
    }
    super::linux_context::runtime().block_on(async {
        tokio::time::timeout(Duration::from_millis(350), async {
            let connection = zbus::Connection::session().await.ok()?;
            if let Ok(proxy) = zbus::Proxy::new(
                &connection,
                "org.gnome.Mutter.IdleMonitor",
                "/org/gnome/Mutter/IdleMonitor/Core",
                "org.gnome.Mutter.IdleMonitor",
            )
            .await
            {
                if let Ok(milliseconds) = proxy.call::<_, _, u64>("GetIdletime", &()).await {
                    return Some(milliseconds as f64 / 1000.0);
                }
            }
            for path in ["/org/freedesktop/ScreenSaver", "/ScreenSaver"] {
                if let Ok(proxy) = zbus::Proxy::new(
                    &connection,
                    "org.freedesktop.ScreenSaver",
                    path,
                    "org.freedesktop.ScreenSaver",
                )
                .await
                {
                    if let Ok(seconds) = proxy.call::<_, _, u32>("GetSessionIdleTime", &()).await {
                        return Some(f64::from(seconds));
                    }
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    })
}
pub fn locked() -> bool {
    super::linux_context::runtime().block_on(async {
        tokio::time::timeout(Duration::from_millis(150), async {
            let connection = zbus::Connection::session().await.ok()?;
            for (name, path) in [
                ("org.freedesktop.ScreenSaver", "/ScreenSaver"),
                ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
            ] {
                let bus = zbus::fdo::DBusProxy::new(&connection).await.ok()?;
                if !bus
                    .name_has_owner(name.try_into().ok()?)
                    .await
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Ok(proxy) = zbus::Proxy::new(&connection, name, path, name).await {
                    if let Ok(active) = proxy.call::<_, _, bool>("GetActive", &()).await {
                        return Some(active);
                    }
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
    })
}
