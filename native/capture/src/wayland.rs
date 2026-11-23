//! Consent-backed PipeWire pixels, with native compositor context when available.
use super::{
    linux_context::{self as context, Desktop, Monitor},
    linux_state::{self, Grant},
};
use ashpd::desktop::{
    screencast::{Screencast, SelectSourcesOptions, SourceType},
    PersistMode, Session,
};
use futures_util::StreamExt;
use gstreamer::{self as gst, prelude::*};
use gstreamer_app::AppSink;
use gstreamer_video::{VideoFrameExt, VideoFrameRef, VideoInfo};
use image::RgbaImage;
use serde_json::{json, Value};
use std::{
    os::fd::{AsRawFd, OwnedFd},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
struct Frame {
    seen: Instant,
    sequence: u64,
    image: RgbaImage,
    desktop: Option<Desktop>,
}
struct Source {
    pipeline: gst::Pipeline,
    frame: Arc<Mutex<Option<Frame>>>,
    id: String,
    position: Option<(i32, i32)>,
}
impl Drop for Source {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}
struct Sharing {
    sources: Vec<Source>,
    context: bool,
    closed: Arc<AtomicBool>,
    session: Arc<Session<Screencast>>,
    runtime: tokio::runtime::Runtime,
    _remote: OwnedFd,
}
impl Drop for Sharing {
    fn drop(&mut self) {
        self.sources.clear();
        let _ = self.runtime.block_on(self.session.close());
    }
}
static SHARING: OnceLock<Mutex<Option<Sharing>>> = OnceLock::new();
fn sharing() -> &'static Mutex<Option<Sharing>> {
    SHARING.get_or_init(|| Mutex::new(None))
}
pub fn is_session() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok_and(|s| !s.is_empty())
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland"))
}
fn healthy(sharing: &Sharing) -> bool {
    !sharing.closed.load(Ordering::SeqCst)
        && sharing.sources.iter().all(|s| {
            s.pipeline.bus().is_some_and(|bus| {
                bus.pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos])
                    .is_none()
            })
        })
}
fn caps(active: bool, native: bool) -> Value {
    json!({"screenshot":active,"accessibility":native,"ocr":super::ocr::available(),"windowContext":native,
        "exclusions":if native {"skip-when-visible"} else {"unavailable-for-shared-source"},"backend":"Wayland portal + PipeWire",
        "permission":if active {"granted"} else {"portal-required"},"idle":super::idle::seconds().is_some(),"desktopIntegration":context::kind()})
}
pub fn capabilities() -> Value {
    let mut state = sharing().lock().unwrap();
    if state.as_ref().is_some_and(|s| !healthy(s)) {
        *state = None;
    }
    caps(
        state.is_some(),
        state
            .as_ref()
            .map_or_else(|| context::snapshot().is_ok(), |s| s.context),
    )
}
fn start(restore: Option<Grant>) -> Result<Sharing, String> {
    gst::init().map_err(|e| format!("GStreamer unavailable: {e}"))?;
    let native = restore
        .as_ref()
        .map_or_else(|| context::snapshot().is_ok(), |g| g.context);
    if native {
        context::snapshot()?;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let (session, remote, streams, closed, token) = runtime.block_on(async {
        let connection = zbus::Connection::session().await?;
        // Register the desktop identity where supported; older portals retain
        // their normal host-app identity and still enforce their own consent.
        if let Ok(registry) = zbus::Proxy::new(&connection, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Registry").await {
            let _ = registry.call::<_,_,()>("Register", &("app.rewind.local", std::collections::HashMap::<&str,zbus::Variant>::new())).await;
        }
        let portal = Screencast::with_connection(connection).await?;
        let session = Arc::new(portal.create_session(Default::default()).await?);
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone(); let watched = session.clone();
        let (ready, subscribed) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            match watched.receive_closed().await {
                Ok(mut signals) => { let _ = ready.send(Ok(())); signals.next().await; }
                Err(error) => { let _ = ready.send(Err(error)); }
            }
            flag.store(true, Ordering::SeqCst);
        });
        subscribed.await.map_err(|_| ashpd::Error::NoResponse)??;
        let result = async {
            let supported = portal.available_source_types().await?;
            let sources = supported & if native {SourceType::MONITOR} else {SourceType::MONITOR | SourceType::WINDOW};
            let options = SelectSourcesOptions::default().set_sources(sources).set_multiple(native)
                .set_persist_mode(PersistMode::ExplicitlyRevoked).set_restore_token(restore.as_ref().map(|g| g.token.as_str()));
            portal.select_sources(&*session, options).await?.response()?;
            let response = portal.start(&*session, None, Default::default()).await?.response()?;
            if response.streams().is_empty() || response.streams().len() > 32 { return Err(ashpd::Error::NoResponse); }
            let token = response.restore_token().map(str::to_owned);
            let streams = response.streams().iter().map(|s| (s.pipe_wire_node_id(), s.id().unwrap_or_default().to_owned(), s.position())).collect::<Vec<_>>();
            let remote = portal.open_pipe_wire_remote(&*session, Default::default()).await?;
            Ok::<_,ashpd::Error>((remote, streams, token))
        }.await;
        match result {
            Ok((remote, streams, token)) => Ok((session, remote, streams, closed, token)),
            Err(error) => { let _ = session.close().await; Err(error) }
        }
    }).map_err(|e: ashpd::Error| format!("Screen sharing was not started: {e}. Choose Share screen in Settings to try again."))?;
    let mut sharing = Sharing {
        sources: Vec::new(),
        context: native,
        closed,
        session,
        runtime,
        _remote: remote,
    };
    for (node, id, position) in streams {
        sharing.sources.push(source(
            sharing._remote.as_raw_fd(),
            node,
            id,
            position,
            native,
        )?);
    }
    if let Some(token) = token {
        linux_state::save(&Grant {
            token,
            context: native,
        })?;
    }
    Ok(sharing)
}
fn source(
    fd: i32,
    node: u32,
    id: String,
    position: Option<(i32, i32)>,
    native: bool,
) -> Result<Source, String> {
    let frame: Arc<Mutex<Option<Frame>>> = Arc::new(Mutex::new(None));
    let source = gst::ElementFactory::make("pipewiresrc")
        .property("fd", fd)
        .property("path", node.to_string())
        .property("do-timestamp", true)
        .property("keepalive-time", 1000i32)
        .build()
        .map_err(|e| format!("GStreamer PipeWire plugin unavailable: {e}"))?;
    let convert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| e.to_string())?;
    let sink = AppSink::builder()
        .caps(
            &gst::Caps::builder("video/x-raw")
                .field("format", "RGBA")
                .build(),
        )
        .max_buffers(1)
        .enable_last_sample(false)
        .drop(true)
        .sync(false)
        .build();
    let output = frame.clone();
    sink.set_callbacks(
        gstreamer_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let sequence = buffer.offset();
                {
                    let mut last = output.lock().unwrap();
                    if let Some(last) = last.as_mut() {
                        // Keepalive buffers repeat the sequence. Never replace their
                        // original inventory with newer metadata for old pixels.
                        if last.sequence == sequence {
                            last.seen = Instant::now();
                            return Ok(gst::FlowSuccess::Ok);
                        }
                        if last.seen.elapsed() < Duration::from_millis(500) {
                            return Ok(gst::FlowSuccess::Ok);
                        }
                    }
                }
                let desktop = if native && sequence != u64::MAX {
                    context::snapshot().ok()
                } else {
                    None
                };
                let info = VideoInfo::from_caps(sample.caps().ok_or(gst::FlowError::Error)?)
                    .map_err(|_| gst::FlowError::Error)?;
                let mapped = VideoFrameRef::from_buffer_ref_readable(buffer, &info)
                    .map_err(|_| gst::FlowError::Error)?;
                let image = copy_rgba(
                    mapped.plane_data(0).map_err(|_| gst::FlowError::Error)?,
                    info.width(),
                    info.height(),
                    mapped.plane_stride()[0],
                )
                .ok_or(gst::FlowError::Error)?;
                *output.lock().unwrap() = Some(Frame {
                    seen: Instant::now(),
                    sequence,
                    image,
                    desktop,
                });
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    let pipeline = gst::Pipeline::new();
    let result = Source {
        pipeline,
        frame,
        id,
        position,
    };
    result
        .pipeline
        .add_many([&source, &convert, sink.upcast_ref()])
        .map_err(|e| e.to_string())?;
    gst::Element::link_many([&source, &convert, sink.upcast_ref()]).map_err(|e| e.to_string())?;
    result
        .pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| e.to_string())?;
    Ok(result)
}

// PipeWire rows may include padding. Never interpret it as image pixels.
fn copy_rgba(data: &[u8], width: u32, height: u32, stride: i32) -> Option<RgbaImage> {
    let row = (width as usize).checked_mul(4)?;
    let stride = usize::try_from(stride).ok()?;
    if width == 0
        || height == 0
        || stride < row
        || data.len() < stride.checked_mul(height as usize - 1)?.checked_add(row)?
    {
        return None;
    }
    let mut pixels = Vec::with_capacity(row.checked_mul(height as usize)?);
    for y in 0..height as usize {
        pixels.extend_from_slice(&data[y * stride..y * stride + row]);
    }
    RgbaImage::from_raw(width, height, pixels)
}

fn fingerprint(desktop: &Desktop, monitor: &Monitor) -> String {
    let mut windows = desktop
        .windows
        .iter()
        .filter(|w| w.visible && w.rect.area(&monitor.rect) > 0)
        .map(|w| {
            format!(
                "{}:{}:{}:{:?}:{}",
                w.key(),
                w.pid,
                w.visible,
                w.rect,
                w.focused
            )
        })
        .collect::<Vec<_>>();
    windows.sort();
    format!("{}:{:?}:{:?}", desktop.locked, monitor.rect, windows)
}
fn select_source<'a>(
    sharing: &'a Sharing,
    desktop: &Desktop,
    monitor: &Monitor,
) -> Result<&'a Source, String> {
    if let Some(source) = sharing
        .sources
        .iter()
        .find(|s| !s.id.is_empty() && s.id == monitor.id)
    {
        return Ok(source);
    }
    let by_position = sharing
        .sources
        .iter()
        .filter(|s| s.position == Some((monitor.rect.x, monitor.rect.y)))
        .collect::<Vec<_>>();
    if by_position.len() == 1 {
        return Ok(by_position[0]);
    }
    // Older portals omit source metadata. It is safe to correlate only when
    // there is exactly one physical display and one shared monitor source.
    if desktop.monitors.len() == 1 && sharing.sources.len() == 1 {
        return Ok(&sharing.sources[0]);
    }
    Err("The focused display is not identifiable among the shared sources. Share all displays using a portal backend that exposes source positions or connector IDs.".into())
}
pub fn perform(request: &Value) -> Result<Value, String> {
    let command = request["command"].as_str().unwrap_or("");
    if command.starts_with("icon:") {
        return Ok(json!({"ok":true,"icon":""}));
    }
    if command == "install-linux-integration" {
        return Ok(json!({"ok":true,"message":context::install()?}));
    }
    let mut state = sharing().lock().unwrap();
    if state.as_ref().is_some_and(|s| !healthy(s)) {
        *state = None;
    }
    match command {
        "share-source" => {
            *state = None;
            linux_state::forget();
            *state = Some(start(None)?);
            return Ok(
                json!({"ok":true,"capabilities":caps(true, state.as_ref().unwrap().context)}),
            );
        }
        "resume-sharing" => {
            if state.is_none() {
                if let Some(grant) = linux_state::take() {
                    *state = Some(start(Some(grant))?);
                }
            }
            return Ok(
                json!({"ok":true,"capabilities":caps(state.is_some(), state.as_ref().is_some_and(|s| s.context))}),
            );
        }
        "stop-sharing" | "suspend-sharing" => {
            *state = None;
            if command == "stop-sharing" {
                linux_state::forget();
            }
            return Ok(json!({"ok":true,"capabilities":caps(false, context::snapshot().is_ok())}));
        }
        "permissions" => {
            return Ok(
                json!({"ok":true,"capabilities":caps(state.is_some(), state.as_ref().map_or_else(|| context::snapshot().is_ok(), |s| s.context)),"message":"Choose shared displays in Settings. Native desktop integration adds app context and exclusions. Screen-sharing grants can be restored when permitted by your desktop."}),
            )
        }
        "probe" | "capture" => {}
        _ => return Err("Unknown capture command".into()),
    }
    let shared = state
        .as_ref()
        .ok_or("Wayland needs screen sharing: open Settings → Privacy → Share screen.")?;
    let desktop = if shared.context {
        Some(context::snapshot()?)
    } else {
        None
    };
    let mut key = "wayland:shared-source".to_owned();
    let mut selected_monitor = None;
    let source = if let Some(desktop) = &desktop {
        if desktop.locked {
            return Err("Capture paused while the desktop is locked".into());
        }
        let Some(focused) = desktop.focused() else {
            return Ok(json!({"ok":true,"contextKey":"","capabilities":caps(true,true)}));
        };
        if focused.excluded(&request_exclusions(request)) {
            return Ok(json!({"ok":true,"contextKey":"","capabilities":caps(true,true)}));
        }
        key = focused.key();
        let monitor = desktop
            .monitor(focused)
            .ok_or("Focused window has no physical display")?;
        desktop.ensure_allowed(monitor, &request_exclusions(request))?;
        selected_monitor = Some(monitor);
        select_source(shared, desktop, monitor)?
    } else {
        shared.sources.first().ok_or("No shared source")?
    };
    if command == "probe" {
        return Ok(json!({"ok":true,"contextKey":key,"capabilities":caps(true, shared.context)}));
    }
    let image = {
        let frame = source.frame.lock().unwrap();
        let frame = frame.as_ref().filter(|f| f.seen.elapsed() < Duration::from_secs(5)).ok_or("Waiting for a fresh PipeWire frame. If sharing stopped, choose Share screen again.")?;
        if let (Some(desktop), Some(monitor)) = (&desktop, selected_monitor) {
            let original = frame
                .desktop
                .as_ref()
                .ok_or("Frame has no verified compositor inventory; sample discarded")?;
            original.ensure_allowed(monitor, &request_exclusions(request))?;
            if fingerprint(original, monitor) != fingerprint(desktop, monitor) {
                return Err(
                    "Compositor context changed since the frame; waiting for matching pixels"
                        .into(),
                );
            }
        }
        frame.image.clone()
    };
    let width = request["settings"]["maximumWidth"]
        .as_u64()
        .unwrap_or(0)
        .min(7680) as u32;
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
    let (screen_text, ocr_status) = super::ocr::snapshot(
        &image,
        request["settings"]["recognizeText"]
            .as_bool()
            .unwrap_or(false),
    );
    let quality = (request["settings"]["jpegQuality"]
        .as_f64()
        .unwrap_or(0.65)
        .clamp(0.3, 0.95)
        * 100.0) as u8;
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    let (mut record, tree) = if let Some(desktop) = &desktop {
        let focused = desktop.focused().unwrap();
        let monitor = selected_monitor.unwrap();
        let (tree, status) = super::tree::snapshot_for(focused.pid, &focused.title);
        let after = context::snapshot()?;
        after.ensure_allowed(monitor, &request_exclusions(request))?;
        if fingerprint(desktop, monitor) != fingerprint(&after, monitor) {
            return Err("Focus or visible windows changed during capture; sample discarded".into());
        }
        let visible = desktop.windows.iter().filter(|w| w.visible && w.rect.area(&monitor.rect) > 0).take(20).map(|w| json!({"windowID":w.id,"app":w.app,"bundleID":w.bundle_id,"title":w.title,"focused":w.focused,"visibility":"on-screen-window; occlusion unknown"})).collect::<Vec<_>>();
        (
            json!({"app":focused.app,"bundleID":focused.bundle_id,"windowTitle":focused.title,"windowID":focused.id,"captureScope":"display","displayID":monitor.id,"visibleWindows":visible,"treeStatus":status}),
            tree,
        )
    } else {
        (
            json!({"app":"Shared screen","bundleID":"wayland:shared-source","windowTitle":"Portal-selected source","captureScope":"portal-source","visibleWindows":[],"treeStatus":"No matching native desktop integration"}),
            Vec::new(),
        )
    };
    if !healthy(shared) {
        *state = None;
        return Err("Screen sharing ended; sample discarded".into());
    }
    record["ocrStatus"] = json!(ocr_status);
    Ok(
        json!({"ok":true,"contextKey":key,"capabilities":caps(true, shared.context),"record":record,"payload":{"jpeg":super::base64(&jpeg),"tree":tree,"screenText":screen_text}}),
    )
}
fn request_exclusions(request: &Value) -> Vec<String> {
    request["exclusions"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn padded_rows_and_invalid_frames() {
        let image = copy_rgba(&[1, 2, 3, 4, 99, 99, 99, 99, 5, 6, 7, 8], 1, 2, 8).unwrap();
        assert_eq!(image.into_raw(), vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(copy_rgba(&[0; 4], 2, 1, 4).is_none());
        assert!(copy_rgba(&[0; 4], 1, 2, 4).is_none());
        assert!(copy_rgba(&[], 0, 0, 0).is_none());
        assert!(copy_rgba(&[0; 4], 1, 1, -4).is_none());
    }
    #[test]
    fn unattended_capture_never_opens_portal() {
        for command in ["probe", "capture"] {
            assert!(perform(&json!({"command":command}))
                .unwrap_err()
                .contains("screen sharing"));
        }
        let response = perform(&json!({"command":"permissions"})).unwrap();
        assert_eq!(response["capabilities"]["screenshot"], false);
        assert_eq!(response["capabilities"]["windowContext"], false);
    }
}

pub fn diagnostics() -> Result<Value, String> {
    gst::init().map_err(|e| e.to_string())?;
    Ok(
        json!({"ok":true,"dependencies":{"ocr":super::ocr::available(),
        "pipewire":gst::ElementFactory::find("pipewiresrc").is_some(),
        "conversion":gst::ElementFactory::find("videoconvert").is_some()}}),
    )
}
