//! Local Tesseract OCR, with an embedded language model and a recognition deadline.
use image::RgbaImage;
use std::{
    ffi::{c_char, c_int, c_void, CStr},
    ptr::NonNull,
    sync::OnceLock,
};
static ENGLISH: &[u8] = include_bytes!("../assets/eng.traineddata");
#[link(name = "tesseract")]
extern "C" {
    fn TessBaseAPICreate() -> *mut c_void;
    fn TessBaseAPIDelete(api: *mut c_void);
    fn TessBaseAPIInit5(
        api: *mut c_void,
        data: *const c_char,
        size: c_int,
        language: *const c_char,
        mode: c_int,
        configs: *mut *mut c_char,
        config_size: c_int,
        variables: *mut *mut c_char,
        values: *mut *mut c_char,
        variable_size: usize,
        debug: c_int,
    ) -> c_int;
    fn TessBaseAPISetImage(
        api: *mut c_void,
        pixels: *const u8,
        width: c_int,
        height: c_int,
        channels: c_int,
        stride: c_int,
    );
    fn TessBaseAPISetPageSegMode(api: *mut c_void, mode: c_int);
    fn TessBaseAPISetSourceResolution(api: *mut c_void, ppi: c_int);
    fn TessBaseAPIRecognize(api: *mut c_void, monitor: *mut c_void) -> c_int;
    fn TessBaseAPIGetUTF8Text(api: *mut c_void) -> *mut c_char;
    fn TessDeleteText(text: *const c_char);
    fn TessMonitorCreate() -> *mut c_void;
    fn TessMonitorDelete(monitor: *mut c_void);
    fn TessMonitorSetDeadlineMSecs(monitor: *mut c_void, milliseconds: c_int);
}
struct Api(NonNull<c_void>);
impl Drop for Api {
    fn drop(&mut self) {
        unsafe {
            TessBaseAPIDelete(self.0.as_ptr());
        }
    }
}
impl Api {
    fn new() -> Result<Self, String> {
        let api =
            Self(NonNull::new(unsafe { TessBaseAPICreate() }).ok_or("OCR allocation failed")?);
        // Init5 borrows the model during initialization. The static bytes remain
        // alive for the entire process, including every handle's lifetime.
        let result = unsafe {
            TessBaseAPIInit5(
                api.0.as_ptr(),
                ENGLISH.as_ptr().cast(),
                ENGLISH.len() as c_int,
                c"eng".as_ptr(),
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                0,
            )
        };
        if result != 0 {
            return Err("Could not initialize local OCR".into());
        }
        Ok(api)
    }
}
struct Monitor(NonNull<c_void>);
impl Drop for Monitor {
    fn drop(&mut self) {
        unsafe {
            TessMonitorDelete(self.0.as_ptr());
        }
    }
}
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| Api::new().is_ok())
}
pub fn snapshot(image: &RgbaImage, enabled: bool) -> (Option<String>, String) {
    if !enabled {
        return (None, "Disabled".into());
    }
    match recognize(image) {
        Ok(text) => (Some(text), "Local Tesseract OCR".into()),
        Err(error) => (None, error),
    }
}
fn recognize(image: &RgbaImage) -> Result<String, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("Empty OCR image".into());
    }
    let scale = (2400.0 / f64::from(image.width().max(image.height()))).min(1.0);
    let resized = image::imageops::resize(
        image,
        (f64::from(image.width()) * scale).round().max(1.0) as u32,
        (f64::from(image.height()) * scale).round().max(1.0) as u32,
        image::imageops::FilterType::Triangle,
    );
    let rgb = image::DynamicImage::ImageRgba8(resized).into_rgb8();
    let api = Api::new()?;
    let monitor = Monitor(
        NonNull::new(unsafe { TessMonitorCreate() }).ok_or("OCR monitor allocation failed")?,
    );
    unsafe {
        TessMonitorSetDeadlineMSecs(monitor.0.as_ptr(), 3000);
        TessBaseAPISetPageSegMode(api.0.as_ptr(), 11); // sparse desktop text
        TessBaseAPISetImage(
            api.0.as_ptr(),
            rgb.as_ptr(),
            rgb.width() as c_int,
            rgb.height() as c_int,
            3,
            rgb.width() as c_int * 3,
        );
        TessBaseAPISetSourceResolution(api.0.as_ptr(), 96);
        if TessBaseAPIRecognize(api.0.as_ptr(), monitor.0.as_ptr()) != 0 {
            return Err("Local OCR timed out or failed".into());
        }
        let text = TessBaseAPIGetUTF8Text(api.0.as_ptr());
        if text.is_null() {
            return Err("Local OCR returned no text".into());
        }
        let result = CStr::from_ptr(text)
            .to_string_lossy()
            .chars()
            .take(32768)
            .collect();
        TessDeleteText(text);
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_ocr_does_not_read_pixels() {
        assert_eq!(
            snapshot(&RgbaImage::new(0, 0), false),
            (None, "Disabled".into())
        );
    }
    #[test]
    fn embedded_english_initializes_without_system_data() {
        assert!(available());
    }
}
