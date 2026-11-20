//! Seconds since the last keyboard, mouse, or touch input. Only elapsed time is read;
//! no input events, keys, or positions are observed.

#[cfg(windows)]
pub fn seconds() -> Option<f64> {
    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo {
        size: std::mem::size_of::<LastInputInfo>() as u32,
        time: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // Both values are 32-bit millisecond tick counts that wrap after ~49.7 days.
    Some(unsafe { GetTickCount() }.wrapping_sub(info.time) as f64 / 1000.0)
}

/// X11 idle time from the MIT-SCREEN-SAVER extension. libXss is loaded at runtime so
/// capture still works, without idle detection, where it is not installed.
#[cfg(target_os = "linux")]
pub fn seconds() -> Option<f64> {
    use std::ffi::{c_char, c_int, c_ulong, c_void, CStr};
    use std::sync::OnceLock;
    #[repr(C)]
    struct Info {
        window: c_ulong,
        state: c_int,
        kind: c_int,
        til_or_since: c_ulong,
        idle: c_ulong,
        event_mask: c_ulong,
    }
    type Query = unsafe extern "C" fn(*mut c_void, c_ulong, *mut Info) -> c_int;
    struct Api {
        display: usize,
        root: c_ulong,
        query: Query,
    }
    static API: OnceLock<Option<Api>> = OnceLock::new();
    unsafe fn symbol(library: *mut c_void, name: &CStr) -> Option<*mut c_void> {
        let value = libc::dlsym(library, name.as_ptr());
        (!value.is_null()).then_some(value)
    }
    let api = API.get_or_init(|| unsafe {
        let x11 = libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        let xss = libc::dlopen(c"libXss.so.1".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if x11.is_null() || xss.is_null() {
            return None;
        }
        let open: unsafe extern "C" fn(*const c_char) -> *mut c_void =
            std::mem::transmute(symbol(x11, c"XOpenDisplay")?);
        let root: unsafe extern "C" fn(*mut c_void) -> c_ulong =
            std::mem::transmute(symbol(x11, c"XDefaultRootWindow")?);
        let query: Query = std::mem::transmute(symbol(xss, c"XScreenSaverQueryInfo")?);
        // A private connection, used only from this single-threaded adapter.
        let display = open(std::ptr::null());
        if display.is_null() {
            return None;
        }
        Some(Api {
            display: display as usize,
            root: root(display),
            query,
        })
    });
    let api = api.as_ref()?;
    let mut info = Info {
        window: 0,
        state: 0,
        kind: 0,
        til_or_since: 0,
        idle: 0,
        event_mask: 0,
    };
    if unsafe { (api.query)(api.display as *mut c_void, api.root, &mut info) } == 0 {
        return None;
    }
    Some(info.idle as f64 / 1000.0)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn seconds() -> Option<f64> {
    None
}
