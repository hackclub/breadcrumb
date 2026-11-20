import AppKit
import ApplicationServices
import BreadcrumbCore
import BreadcrumbCaptureSupport

private struct Request: Decodable {
    var command: String
    var settings: LoggingSettings?
    var exclusions: [String]?
}

@main struct CaptureAgent {
    @MainActor static func main() async {
        NSApplication.shared.setActivationPolicy(.prohibited)
        // Keep AppKit's main run loop responsive to foreground-app changes.
        while let line = await Task.detached(operation: { readLine() }).value {
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                let response = try await perform(request)
                let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
                fflush(stdout)
            } catch {
                let data = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": error.localizedDescription, "capabilities": capabilities()])
                print(String(decoding: data, as: UTF8.self)); fflush(stdout)
            }
        }
    }
    @MainActor private static func capabilities() -> [String: Any] {
        ["screenshot": true, "accessibility": AXIsProcessTrusted(), "ocr": true, "windowContext": true,
         "exclusions": "native-filter", "backend": "ScreenCaptureKit", "permission": CGPreflightScreenCaptureAccess() ? "granted" : "required",
         "idle": true]
    }
    /// Seconds since the last keyboard, mouse, or trackpad input. Needs no extra permission
    /// and reveals only elapsed time, never which keys or events occurred.
    private static func idleSeconds() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    }
    @MainActor private static func context(_ target: CaptureTarget) -> String {
        let app = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(app, 0.05)
        var raw: CFTypeRef?
        var title: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &raw) == .success,
           let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() {
            AXUIElementCopyAttributeValue(raw as! AXUIElement, kAXTitleAttribute as CFString, &title)
        }
        return target.bundleID + ":" + (title as? String ?? "")
    }
    @MainActor private static func perform(_ request: Request) async throws -> [String: Any] {
        let exclusions = Set(request.exclusions ?? [])
        var result: [String: Any] = ["ok": true, "capabilities": capabilities(), "recordingPreference": UserDefaults(suiteName: "app.rewind.local")?.bool(forKey: "recordingEnabled") ?? false]
        if request.command.hasPrefix("icon:") {
            let bundleID = String(request.command.dropFirst(5))
            let workspace = NSWorkspace.shared
            let icon = workspace.runningApplications.first(where: { $0.bundleIdentifier == bundleID })?.icon
                ?? workspace.urlForApplication(withBundleIdentifier: bundleID).map { workspace.icon(forFile: $0.path) }
            if let icon, let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = context
                icon.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64), from: .zero, operation: .copy, fraction: 1)
                NSGraphicsContext.restoreGraphicsState()
                result["icon"] = bitmap.representation(using: .png, properties: [:]).map { "data:image/png;base64," + $0.base64EncodedString() } ?? ""
            } else { result["icon"] = "" }
            return result
        }
        if request.command == "permissions" {
            _ = CGRequestScreenCaptureAccess()
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
            _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
            return result
        }
        result["idleSeconds"] = idleSeconds()
        guard let target = CaptureService.eligibleTarget(exclusions: exclusions), !SessionSafety.locked else {
            result["contextKey"] = ""; return result
        }
        let key = context(target)
        result["contextKey"] = key
        if request.command == "probe" { return result }
        guard request.command == "capture" else { throw NSError(domain: "Breadcrumb", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown capture command"]) }
        let (record, payload) = try await CaptureService.capture(target, exclusions: exclusions, settings: request.settings ?? .continuous)
        guard key == context(target) else { throw NSError(domain: "Breadcrumb", code: 2, userInfo: [NSLocalizedDescriptionKey: "Focus changed during capture"]) }
        result["record"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record))
        result["payload"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload))
        return result
    }
}
