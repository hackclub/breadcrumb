//! Wayland has no portable foreground-window/exclusion API. Only an explicitly
//! selected portal source is captured; XWayland metadata is never used for it.
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

type Frame = Arc<Mutex<Option<(Instant, RgbaImage)>>>;
struct Sharing {
    pipeline: gst::Pipeline,
    frame: Frame,
    closed: Arc<AtomicBool>,
    session: Arc<Session<Screencast>>,
    // The portal connection, signal listener, and remote FD must outlive capture.
    runtime: tokio::runtime::Runtime,
    _remote: OwnedFd,
}
impl Drop for Sharing {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
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
        && sharing.pipeline.bus().is_some_and(|bus| {
            bus.pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos])
                .is_none()
        })
}
fn caps(active: bool) -> Value {
    json!({"screenshot":active,"accessibility":false,"ocr":false,"windowContext":false,
        "exclusions":"unavailable-for-shared-source","backend":"Wayland portal + PipeWire",
        "permission":if active {"granted"} else {"portal-required"},"idle":false})
}
pub fn capabilities() -> Value {
    let mut state = sharing().lock().unwrap();
    if state.as_ref().is_some_and(|s| !healthy(s)) {
        *state = None;
    }
    caps(state.is_some())
}
fn start() -> Result<Sharing, String> {
    gst::init().map_err(|e| format!("GStreamer unavailable: {e}"))?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let (session, remote, node, closed) = runtime.block_on(async {
        let portal = Screencast::new().await?;
        let session = Arc::new(portal.create_session(Default::default()).await?);
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let watched = session.clone();
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
            let sources = portal.available_source_types().await? & (SourceType::MONITOR | SourceType::WINDOW);
            portal.select_sources(&*session, SelectSourcesOptions::default().set_sources(sources).set_multiple(false).set_persist_mode(PersistMode::DoNot)).await?.response()?;
            let response = portal.start(&*session, None, Default::default()).await?.response()?;
            let stream = response.streams().first().ok_or(ashpd::Error::NoResponse)?;
            let node = stream.pipe_wire_node_id();
            let remote = portal.open_pipe_wire_remote(&*session, Default::default()).await?;
            Ok::<_, ashpd::Error>((remote, node))
        }.await;
        match result {
            Ok((remote, node)) => Ok((session, remote, node, closed)),
            Err(error) => { let _ = session.close().await; Err(error) }
        }
    }).map_err(|e: ashpd::Error| format!("Screen sharing was not started: {e}. Choose Share screen in Settings to try again."))?;
    // Install cleanup before constructing the pipeline, including error paths.
    let sharing = Sharing {
        pipeline: gst::Pipeline::new(),
        frame: Arc::new(Mutex::new(None)),
        closed,
        session,
        runtime,
        _remote: remote,
    };
    let source = gst::ElementFactory::make("pipewiresrc")
        .property("fd", sharing._remote.as_raw_fd())
        .property("path", node.to_string())
        .property("do-timestamp", true)
        // Static desktops may produce frames only on damage. Keep the active
        // stream ticking; Closed/EOS/error still invalidates all retained pixels.
        .property("keepalive-time", 1000i32)
        .build()
        .map_err(|e| format!("Install the GStreamer PipeWire plugin: {e}"))?;
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
        .drop(true)
        .sync(false)
        .build();
    let frame = sharing.frame.clone();
    sink.set_callbacks(
        gstreamer_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                // Retain at most one image per second, regardless of display refresh rate.
                if frame
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|(at, _)| at.elapsed() < Duration::from_secs(1))
                {
                    return Ok(gst::FlowSuccess::Ok);
                }
                let info = VideoInfo::from_caps(sample.caps().ok_or(gst::FlowError::Error)?)
                    .map_err(|_| gst::FlowError::Error)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let mapped = VideoFrameRef::from_buffer_ref_readable(buffer, &info)
                    .map_err(|_| gst::FlowError::Error)?;
                let pixels = copy_rgba(
                    mapped.plane_data(0).map_err(|_| gst::FlowError::Error)?,
                    info.width(),
                    info.height(),
                    mapped.plane_stride()[0],
                )
                .ok_or(gst::FlowError::Error)?;
                *frame.lock().unwrap() = Some((Instant::now(), pixels));
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    sharing
        .pipeline
        .add_many([&source, &convert, sink.upcast_ref()])
        .map_err(|e| e.to_string())?;
    gst::Element::link_many([&source, &convert, sink.upcast_ref()]).map_err(|e| e.to_string())?;
    sharing
        .pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| e.to_string())?;
    Ok(sharing)
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
pub fn perform(request: &Value) -> Result<Value, String> {
    let command = request["command"].as_str().unwrap_or("");
    if command.starts_with("icon:") {
        return Ok(json!({"ok":true,"icon":""}));
    }
    let mut state = sharing().lock().unwrap();
    if state.as_ref().is_some_and(|s| !healthy(s)) {
        *state = None;
    }
    match command {
        "share-source" => {
            *state = None;
            *state = Some(start()?);
            return Ok(json!({"ok":true,"capabilities":caps(true)}));
        }
        "stop-sharing" => {
            *state = None;
            return Ok(json!({"ok":true,"capabilities":caps(false)}));
        }
        "permissions" => {
            return Ok(
                json!({"ok":true,"capabilities":caps(state.is_some()),"message":"Choose Share screen in Settings. All content in the selected source is captured; app exclusions, foreground context, accessibility and idle detection are unavailable."}),
            )
        }
        "probe" | "capture" => {}
        _ => return Err("Unknown capture command".into()),
    }
    let shared = state.as_ref().ok_or("Wayland needs screen sharing: open Settings → Privacy → Share screen. App exclusions are unavailable for a shared source.")?;
    if command == "probe" {
        return Ok(
            json!({"ok":true,"contextKey":"wayland:shared-source","capabilities":caps(true)}),
        );
    }
    let image = shared
        .frame
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(5))
        .map(|(_, image)| image.clone())
        .ok_or(
            "Waiting for a fresh PipeWire frame. If sharing stopped, choose Share screen again.",
        )?;
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
    let quality = (request["settings"]["jpegQuality"]
        .as_f64()
        .unwrap_or(0.65)
        .clamp(0.3, 0.95)
        * 100.0) as u8;
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    if !healthy(shared) {
        *state = None;
        return Err("Screen sharing ended; sample discarded".into());
    }
    Ok(
        json!({"ok":true,"contextKey":"wayland:shared-source","capabilities":caps(true),
        "record":{"app":"Shared screen","bundleID":"wayland:shared-source","windowTitle":"Portal-selected source","captureScope":"portal-source","visibleWindows":[],"treeStatus":"Unavailable: Wayland shared source has no portable foreground context"},
        "payload":{"jpeg":super::base64(&jpeg),"tree":[]}}),
    )
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
        assert_eq!(response["capabilities"]["idle"], false);
    }
}
