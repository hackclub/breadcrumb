import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision
import BreadcrumbCore

struct CaptureTarget: Sendable {
    let pid: pid_t
    let bundleID: String
    let app: String
}

struct AXSnapshot: Sendable {
    var nodes: [AccessibilityNode] = []
    var status = "Accessibility not granted; screenshot only"
    var bounds: CGRect?
    var title: String?
    var documentURL: String?
}

enum CaptureFailure: LocalizedError {
    case unavailable(String)
    var errorDescription: String? { if case .unavailable(let reason) = self { reason } else { nil } }
}

enum CaptureService {
    static let excludedDefaults: Set<String> = [
        "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx",
        "com.bitwarden.desktop", "com.apple.keychainaccess", "com.apple.Passwords", "com.lastpass.LastPass",
        "com.apple.loginwindow", "com.apple.ScreenSaver.Engine", "app.rewind.local"
    ]

    @MainActor static func eligibleTarget(exclusions: Set<String>) -> CaptureTarget? {
        guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              !exclusions.contains(bundle), !excludedDefaults.contains(bundle) else { return nil }
        return CaptureTarget(pid: app.processIdentifier, bundleID: bundle, app: app.localizedName ?? bundle)
    }

    static func capture(_ target: CaptureTarget, exclusions: Set<String> = [], settings: LoggingSettings = LoggingSettings()) async throws -> (CaptureRecord, CapturePayload) {
        let date = Date()
        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureFailure.unavailable("Screen Recording permission is missing. Enable it in Settings; nothing new is captured.")
        }
        let ax = await Task.detached(priority: .utility) { readAccessibility(pid: target.pid) }.value
        try Task.checkCancellation()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let candidates = content.windows.filter { $0.owningApplication?.processID == target.pid && $0.windowLayer == 0 && $0.frame.width > 40 && $0.frame.height > 40 }
        let window: SCWindow?
        if let bounds = ax.bounds {
            window = candidates.first {
                abs($0.frame.minX - bounds.minX) < 4 && abs($0.frame.minY - bounds.minY) < 4 &&
                abs($0.frame.width - bounds.width) < 4 && abs($0.frame.height - bounds.height) < 4
            }
        } else {
            // CGWindowList gives front-to-back order; never guess from unordered shareable windows.
            let ordered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let id = ordered.first { ($0[kCGWindowOwnerPID as String] as? Int32) == target.pid && ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowNumber as String] as? UInt32
            window = candidates.first { $0.windowID == id }
        }
        guard let window else { throw CaptureFailure.unavailable("No unambiguous active window is available. This minute is a gap.") }
        // Use the display containing the largest part of the focused window.
        guard let display = content.displays.max(by: {
            let a = $0.frame.intersection(window.frame)
            let b = $1.frame.intersection(window.frame)
            return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
        }), display.frame.intersects(window.frame) else {
            throw CaptureFailure.unavailable("The active display is unavailable. This minute is a gap.")
        }
        let excluded = exclusions.union(excludedDefaults)
        let apps = content.applications.filter { excluded.contains($0.bundleIdentifier) }
        let filter = SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = max(1, Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)))
        config.height = max(1, Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
        if settings.maximumWidth > 0, config.width > settings.maximumWidth {
            let ratio = Double(settings.maximumWidth) / Double(config.width)
            config.width = settings.maximumWidth; config.height = max(1, Int(Double(config.height) * ratio))
        }
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        try Task.checkCancellation()
        let valid = await MainActor.run {
            NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid && !SessionSafety.locked
        }
        guard valid else { throw CaptureFailure.unavailable("Focus or session changed during capture. The sample was discarded.") }
        let identity = await Task.detached(priority: .utility) { focusedWindowIdentity(pid: target.pid) }.value
        if let before = ax.bounds {
            guard let after = identity.bounds, before == after, ax.title == identity.title else {
                throw CaptureFailure.unavailable("The focused window changed during capture. The sample was discarded.")
            }
        } else {
            let ordered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let id = ordered.first { ($0[kCGWindowOwnerPID as String] as? Int32) == target.pid && ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowNumber as String] as? UInt32
            guard id == window.windowID else {
                throw CaptureFailure.unavailable("The front window changed during capture. The sample was discarded.")
            }
        }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: settings.jpegQuality]) else {
            throw CaptureFailure.unavailable("The screenshot could not be compressed.")
        }
        let title = String((ax.title ?? window.title ?? "Untitled window").prefix(300))
        var record = CaptureRecord(date: date, app: target.app, bundleID: target.bundleID, windowTitle: title,
                                 windowID: window.windowID, treeStatus: ax.status,
                                 classification: .infer(bundleID: target.bundleID, title: title, roles: ax.nodes.map(\.role)))
        record.context = TaskContext.infer(bundleID: target.bundleID, title: title, documentURL: ax.documentURL)
        record.classification = .infer(bundleID: target.bundleID, title: title, roles: ax.nodes.map(\.role), domain: record.context?.domain)
        record.visibleWindows = visibleWindows(content: content, display: display, focused: window.windowID, excluded: excluded)
        record.captureScope = "display"
        record.displayID = display.displayID
        let text = settings.recognizeText ? await Task.detached(priority: .utility) { recognizeText(image) }.value : nil
        try Task.checkCancellation()
        return (record, CapturePayload(jpeg: jpeg, tree: ax.nodes, screenText: text))
    }

    private static func recognizeText(_ image: CGImage) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.minimumTextHeight = 0.008
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
            let lines = (request.results ?? []).prefix(200).compactMap { $0.topCandidates(1).first?.string }
            return String(lines.joined(separator: "\n").prefix(12_000))
        } catch { return nil } // OCR failure must not lose the capture.
    }

    private static func visibleWindows(content: SCShareableContent, display: SCDisplay, focused: UInt32, excluded: Set<String>) -> [WindowContext] {
        let ordered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let windows = Dictionary(uniqueKeysWithValues: content.windows.map { ($0.windowID, $0) })
        var occluders: [CGRect] = []
        var result: [WindowContext] = []
        for row in ordered {
            guard (row[kCGWindowLayer as String] as? Int) == 0,
                  let id = row[kCGWindowNumber as String] as? UInt32,
                  let window = windows[id], let app = window.owningApplication,
                  !excluded.contains(app.bundleIdentifier) else { continue }
            let rect = window.frame.intersection(display.frame)
            guard !rect.isNull, rect.width > 40, rect.height > 40 else { continue }
            var pieces = [rect]
            for cover in occluders {
                pieces = pieces.flatMap { subtract($0, cover) }
                if pieces.isEmpty { break }
            }
            let area = pieces.reduce(CGFloat(0)) { $0 + $1.width * $1.height }
            let fraction = Double(area / (rect.width * rect.height))
            if fraction > 0.05 || id == focused {
                result.append(WindowContext(windowID: id, app: app.applicationName, bundleID: app.bundleIdentifier,
                    title: String((window.title ?? "").prefix(300)), focused: id == focused, visibleFraction: fraction))
            }
            occluders.append(rect)
            if occluders.count >= 60 { break }
        }
        return Array(result.prefix(20))
    }

    private static func subtract(_ rect: CGRect, _ cover: CGRect) -> [CGRect] {
        let hit = rect.intersection(cover)
        if hit.isNull || hit.isEmpty { return [rect] }
        return [CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: hit.minY - rect.minY),
                CGRect(x: rect.minX, y: hit.maxY, width: rect.width, height: rect.maxY - hit.maxY),
                CGRect(x: rect.minX, y: hit.minY, width: hit.minX - rect.minX, height: hit.height),
                CGRect(x: hit.maxX, y: hit.minY, width: rect.maxX - hit.maxX, height: hit.height)].filter { !$0.isEmpty }
    }

    private static func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, 0.05)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
        return value
    }

    private static func focusedWindowIdentity(pid: pid_t) -> AXSnapshot {
        guard AXIsProcessTrusted() else { return AXSnapshot() }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        guard let raw = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            var result = AXSnapshot(); result.status = "Focused accessibility window unavailable"; return result
        }
        let window = raw as! AXUIElement
        var result = AXSnapshot()
        result.title = attribute(window, kAXTitleAttribute) as? String
        if let document = attribute(window, kAXDocumentAttribute) {
            result.documentURL = (document as? URL)?.absoluteString ?? (document as? String)
        }
        var point = CGPoint.zero, size = CGSize.zero
        if let p = attribute(window, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
           let s = attribute(window, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID(),
           AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) {
            result.bounds = CGRect(origin: point, size: size)
        }
        return result
    }

    private static func readAccessibility(pid: pid_t) -> AXSnapshot {
        var result = focusedWindowIdentity(pid: pid)
        guard AXIsProcessTrusted() else { return result }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.08)
        guard let raw = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return result }
        let window = raw as! AXUIElement
        let deadline = Date().addingTimeInterval(0.7)
        var truncated = false
        func visit(_ node: AXUIElement, depth: Int) {
            guard depth <= 7, result.nodes.count < 180, Date() < deadline else { truncated = true; return }
            let role = attribute(node, kAXRoleAttribute) as? String ?? "AXUnknown"
            let subrole = attribute(node, kAXSubroleAttribute) as? String ?? ""
            if role == "AXWebArea", result.documentURL == nil, let url = attribute(node, kAXURLAttribute) {
                result.documentURL = (url as? URL)?.absoluteString ?? (url as? String)
            }
            // Never request AXValue or read editable/secure field text, including titles/descriptions.
            let editable = role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || subrole.localizedCaseInsensitiveContains("secure")
            let label = editable ? nil : (attribute(node, kAXTitleAttribute) as? String)
            result.nodes.append(AccessibilityNode(role: role, label: label.map { String($0.prefix(120)) }, depth: depth))
            if editable { return }
            var children: CFArray?
            let status = AXUIElementCopyAttributeValues(node, kAXChildrenAttribute as CFString, 0, 60, &children)
            if status == .success, let children = children as? [AXUIElement] {
                for child in children { visit(child, depth: depth + 1); if Date() >= deadline { break } }
            }
        }
        visit(window, depth: 0)
        result.status = truncated || Date() >= deadline ? "Filtered tree (bounded/truncated)" : "Filtered accessibility tree"
        return result
    }
}

@MainActor enum SessionSafety {
    static var suspended = false
    static var locked: Bool {
        if suspended { return true }
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session[kCGSessionOnConsoleKey as String] as? Bool == true else { return true }
        return session["CGSSessionScreenIsLocked"] as? Bool == true
    }
}
