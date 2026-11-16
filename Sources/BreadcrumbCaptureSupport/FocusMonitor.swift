import AppKit
import ApplicationServices

/// Watches only the front app/window, without polling or reading keystrokes.
@MainActor public final class FocusMonitor {
    public var changed: (() -> Void)?
    private var observer: AXObserver?
    private var pid: pid_t = 0

    public init() {}

    public func watch(_ process: pid_t?) {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        observer = nil
        guard let process, AXIsProcessTrusted() else { return }
        pid = process
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, _, pointer in
            guard let pointer else { return }
            let monitor = Unmanaged<FocusMonitor>.fromOpaque(pointer).takeUnretainedValue()
            Task { @MainActor in monitor.changed?() }
        }
        guard AXObserverCreate(process, callback, &created) == .success, let created else { return }
        observer = created
        let app = AXUIElementCreateApplication(process)
        AXUIElementSetMessagingTimeout(app, 0.05)
        let ref = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(created, app, kAXFocusedWindowChangedNotification as CFString, ref)
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
           let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
            AXObserverAddNotification(created, value as! AXUIElement, kAXTitleChangedNotification as CFString, ref)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
    }
}
