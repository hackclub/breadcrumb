import SwiftUI
import Observation
import ApplicationServices
import CryptoKit
import ServiceManagement
import BreadcrumbCore
import BreadcrumbCaptureSupport

@MainActor @Observable
final class Recorder {
    var snapshot = LibrarySnapshot()
    var settings = LoggingSettings.continuous
    var wantsRecording: Bool
    var status = "Starting…"
    var notice: String?
    var screenGranted = false
    var accessibilityGranted = false
    var isCapturing = false
    var exporting = false
    var exportProgress = 0.0
    var selectedTab = PanelTab.now
    var preview: NSImage?
    var previewID: UUID?
    var tree: [AccessibilityNode] = []
    var exclusionsText: String {
        didSet {
            UserDefaults.standard.set(exclusionsText, forKey: "excludedBundles")
            captureTask?.cancel()
        }
    }
    let demo = ProcessInfo.processInfo.arguments.contains("--demo")
    @ObservationIgnored private(set) var library: Library?
    @ObservationIgnored private var focusMonitor = FocusMonitor()
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var cadence = CaptureCadence()
    @ObservationIgnored private var lastFingerprint: String?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var captureTask: Task<Void, Never>?
    @ObservationIgnored private var nextMaintenance = Date.distantPast
    @ObservationIgnored private var lowDisk = false
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var loadingLibrary = false
    @ObservationIgnored private var attemptedLibraryLoad = false
    @ObservationIgnored private var retryLibraryLoad = true

    var exclusions: Set<String> {
        Set(exclusionsText.split(whereSeparator: { $0 == "\n" || $0 == "," }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }
    var rolling: [CaptureRecord] { snapshot.rolling() }

    init() {
        wantsRecording = UserDefaults.standard.bool(forKey: "recordingEnabled")
        exclusionsText = UserDefaults.standard.string(forKey: "excludedBundles") ?? ""
        if demo { wantsRecording = false }
        status = "Opening local history…"

        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in SessionSafety.suspended = true; self?.captureTask?.cancel(); self?.status = "Session paused" }
            })
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                // Keep the minute deadline; several wake/session notifications must not burst captures.
                Task { @MainActor in SessionSafety.suspended = false }
            })
        }
        focusMonitor.changed = { [weak self] in self?.contextChanged() }
        observers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.contextChanged() }
        })
        Task { await pulse() }
    }

    private func contextChanged() {
        captureTask?.cancel()
        eventTask?.cancel()
        focusMonitor.watch(wantsRecording && settings.captureChanges && !demo ? CaptureService.eligibleTarget(exclusions: exclusions)?.pid : nil)
        guard wantsRecording, settings.captureChanges, !demo, !SessionSafety.locked else { return }
        let delay = cadence.eventDelay(now: .now, minimumInterval: Double(settings.minimumEventInterval))
        eventTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            await self?.pulse(reason: "contextChanged", scheduleTimer: false)
        }
    }

    private func loadLibraryIfNeeded() async {
        guard library == nil, retryLibraryLoad else { return }
        loadingLibrary = true
        defer { loadingLibrary = false }
        let allowInteraction = !attemptedLibraryLoad
        attemptedLibraryLoad = true
        let demo = self.demo
        do {
            // Only the first attempt may ask for approval. Keep all Keychain work off the main actor.
            library = try await Task.detached(priority: .userInitiated) {
                let directory: URL
                var key: SymmetricKey? = nil
                if demo {
                    directory = FileManager.default.temporaryDirectory.appendingPathComponent("Breadcrumb-Demo-\(UUID())")
                } else {
                    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    directory = try LibraryLocation.resolve(in: support)
                    let hasHistory = FileManager.default.fileExists(atPath: directory.appendingPathComponent("library.sealed").path)
                    let hasPlainHistory = FileManager.default.fileExists(atPath: directory.appendingPathComponent("library.json").path)
                    if hasHistory && !hasPlainHistory {
                        key = try VaultKey.load(allowInteraction: allowInteraction, createIfMissing: false)
                    }
                }
                return try Library(directory: directory, key: key, settings: demo ? LoggingSettings() : .continuous)
            }.value
            notice = nil
            if demo { await seedDemo() }
        } catch {
            notice = error.localizedDescription
            // Corrupt/wrong-key history stays closed. A transient Keychain failure must not erase intent.
            retryLibraryLoad = (error as? VaultKey.KeyError)?.isRetryable == true
        }
    }

    func refresh() async {
        guard let library else { return }
        do { snapshot = try await library.snapshot(); settings = snapshot.settings }
        catch { notice = error.localizedDescription }
    }

    func pulse(reason: String = "interval", scheduleTimer: Bool = true) async {
        guard !loadingLibrary else { return }
        defer {
            if scheduleTimer {
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: Double(settings.intervalSeconds), repeats: false) { [weak self] _ in
                Task { @MainActor in await self?.pulse() }
            }
            // One coalescible deadline, without a second clock that can skip a minute due to jitter.
            timer?.tolerance = 2
            }
        }
        await loadLibraryIfNeeded()
        refreshPermissions()
        if Date() >= nextMaintenance {
            nextMaintenance = Date().addingTimeInterval(60)
            await refresh()
        }
        guard library != nil else { status = "Library unavailable"; return }
        if demo { status = "Demo · capture disabled"; return }
        guard wantsRecording else { status = "Paused · your history stays local"; return }
        guard !SessionSafety.locked else { status = "Paused while session is locked/asleep"; captureTask?.cancel(); return }
        guard screenGranted else { status = "Screen Recording permission needed"; captureTask?.cancel(); return }
        status = settings.captureChanges ? "Recording changes" : "Recording every \(settings.intervalSeconds) seconds"
        guard !isCapturing else { return }
        guard let target = CaptureService.eligibleTarget(exclusions: exclusions) else { status = "Waiting · excluded app or Breadcrumb in front"; return }
        cadence.attempted(at: .now)
        focusMonitor.watch(settings.captureChanges ? target.pid : nil)
        isCapturing = true
        captureTask = Task {
            defer { isCapturing = false }
            do {
                let home = URL(fileURLWithPath: NSHomeDirectory())
                let values = try home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                guard let capacity = values.volumeAvailableCapacityForImportantUsage else {
                    throw CaptureFailure.unavailable("Cannot check disk space. Capture skipped.")
                }
                let threshold = Int64((lowDisk ? 6 : 5) * Limits.GiB)
                guard capacity > threshold else { lowDisk = true; throw CaptureFailure.unavailable("Low disk space. Capture resumes when more than 6 GiB is free.") }
                lowDisk = false
                var (record, payload) = try await CaptureService.capture(target, exclusions: exclusions, settings: settings)
                try Task.checkCancellation()
                guard wantsRecording, !SessionSafety.locked, CGPreflightScreenCaptureAccess(),
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
                      !exclusions.contains(target.bundleID), let library else { return }
                record.captureReason = reason
                let signature = record.bundleID + record.windowTitle + String(record.windowID) + String(describing: record.context)
                let fingerprint = signature + SHA256.hash(data: payload.jpeg).description
                if reason == "contextChanged", fingerprint == lastFingerprint { return }
                try await library.append(record, payload: payload)
                lastFingerprint = fingerprint
                notice = nil
                await refresh()
            } catch is CancellationError { /* A pause/exclusion/session change invalidates in-flight capture. */ }
            catch {
                notice = error.localizedDescription
                if case LibraryError.full = error { status = "Storage limit reached · history preserved" }
            }
        }
    }

    func applySettings(_ value: LoggingSettings) {
        guard let library, !demo else { return }
        captureTask?.cancel(); eventTask?.cancel()
        Task {
            do {
                try await library.updateSettings(value)
                await refresh()
                contextChanged()
                await pulse(reason: "settingsChanged")
                notice = "Logging settings saved."
            } catch { notice = error.localizedDescription }
        }
    }

    func toggleRecording() {
        guard !demo, library != nil else { return }
        wantsRecording.toggle()
        UserDefaults.standard.set(wantsRecording, forKey: "recordingEnabled")
        if !wantsRecording { captureTask?.cancel(); eventTask?.cancel(); focusMonitor.watch(nil) }
        Task { await pulse() }
    }

    func requestScreenPermission() {
        _ = CGRequestScreenCaptureAccess()
        openPrivacy("ScreenCapture")
    }

    func refreshPermissions() {
        screenGranted = CGPreflightScreenCaptureAccess()
        accessibilityGranted = AXIsProcessTrusted()
    }

    func requestAccessibilityPermission() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
        openPrivacy("Accessibility")
    }

    func openPrivacy(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_\(pane)") { NSWorkspace.shared.open(url) }
    }

    func save(start: Date, end: Date, name: String = "Saved moment") {
        perform { library in
            _ = try await library.save(start: start, end: end, name: name)
            self.notice = "Clip saved. Its captures will not roll off."
        }
    }

    func addMarker(at date: Date = .now) {
        perform { library in
            try await library.addMarker(at: date)
            self.notice = "Marker added. Save a clip to keep the captures."
        }
    }

    func correct(_ frame: CaptureRecord, activity: Activity?) {
        perform { try await $0.correct(id: frame.id, activity: activity) }
    }

    func deleteClip(_ clip: Clip) { perform { try await $0.deleteClip(clip.id) } }

    func deleteRecent() {
        if wantsRecording { toggleRecording() }
        perform {
            try await $0.deleteCaptures(since: Date().addingTimeInterval(-3600))
            self.preview = nil; self.tree = []
            self.notice = "Last hour deleted, including saved references. Recording is paused."
        }
    }

    func loadPreview(_ id: UUID?) async {
        preview = nil; previewID = nil; tree = []
        guard let id, let library else { return }
        do {
            let payload = try await library.payload(for: id)
            try Task.checkCancellation()
            preview = NSImage(data: payload.jpeg); tree = payload.tree; previewID = id
        } catch is CancellationError { } catch { notice = error.localizedDescription }
    }

    private func perform(_ operation: @escaping (Library) async throws -> Void) {
        guard let library else { return }
        Task {
            do { try await operation(library); await refresh() }
            catch { notice = error.localizedDescription }
        }
    }

    func setLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch { notice = "Launch at login: \(error.localizedDescription)" }
    }

    func export(_ clip: Clip) {
        guard let library, !exporting else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.mpeg4Movie]
        panel.nameFieldStringValue = "Breadcrumb-\(clip.created.formatted(.dateTime.year().month().day())).mp4"
        panel.message = "Exports are unencrypted copies outside Breadcrumb's storage budget. Review for sensitive information before sharing."
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        let frames = snapshot.observations.filter { clip.frameIDs.contains($0.id) }.sorted { $0.date < $1.date }
        exporting = true; exportProgress = 0
        Task {
            defer { exporting = false }
            do {
                try await TimeLapseExporter.export(frames, library: library, to: destination) { value in
                    Task { @MainActor in self.exportProgress = value }
                }
                notice = "Time-lapse exported. The exported copy is not encrypted."
                NSWorkspace.shared.activateFileViewerSelecting([destination])
            } catch { notice = "Export failed: \(error.localizedDescription)" }
        }
    }

    private func seedDemo() async {
        guard let library else { return }
        let now = Date()
        for i in 0..<12 {
            let coding = i % 3 != 1
            let title = coding ? "Timeline.swift — Breadcrumb" : "Apple Developer Documentation"
            let app = coding ? "Xcode" : "Safari"
            let image = NSImage(size: NSSize(width: 960, height: 600))
            image.lockFocus()
            NSColor.windowBackgroundColor.setFill(); NSBezierPath(rect: NSRect(x: 0, y: 0, width: 960, height: 600)).fill()
            ("\(app)\n\n\(title)\n\nIllustrative demo capture\nNo real screen content is recorded in demo mode." as NSString).draw(at: NSPoint(x: 60, y: 260), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 24, weight: .regular), .foregroundColor: NSColor.labelColor])
            image.unlockFocus()
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { continue }
            let record = CaptureRecord(date: now.addingTimeInterval(Double(i - 11) * 1200 - 30), app: app,
                                     bundleID: coding ? "com.apple.dt.Xcode" : "com.apple.Safari", windowTitle: title,
                                     treeStatus: "Demo filtered tree", classification: .infer(bundleID: coding ? "com.apple.dt.Xcode" : "com.apple.Safari", title: title, roles: ["AXTextArea"]))
            try? await library.append(record, payload: CapturePayload(jpeg: jpeg, tree: [.init(role: "AXWindow", label: title, depth: 0)]))
        }
        try? await library.addMarker(at: now.addingTimeInterval(-2700))
    }
}

enum PanelTab: String, CaseIterable { case now = "Now", timeline = "Timeline", saved = "Saved", insights = "Insights", settings = "Settings" }
