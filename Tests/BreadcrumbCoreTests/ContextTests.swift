import Foundation
import Testing
@testable import BreadcrumbCore

private let start = Date(timeIntervalSince1970: 1_800_000_000)
private func sample(_ seconds: Double, bundle: String, project: String? = nil) -> CaptureRecord {
    var row = CaptureRecord(date: start.addingTimeInterval(seconds), app: bundle, bundleID: bundle, windowTitle: "Window", treeStatus: "Test", classification: .infer(bundleID: bundle, title: "Window", roles: []))
    row.context = TaskContext(project: project)
    return row
}
@Test func taskContextDoesNotPersistURLSecretsOrGuessUnknownProjects() {
    let browser = TaskContext.infer(bundleID: "net.imput.helium", title: "You", documentURL: "https://user:password@chatgpt.com/c/private?token=secret#fragment")
    #expect(browser.domain == "chatgpt.com")
    #expect(browser.document == nil && browser.project == nil)
    #expect(Classification.infer(bundleID: "net.imput.helium", title: "You", roles: [], domain: browser.domain).activity == .assistant)
    #expect(Classification.infer(bundleID: "net.imput.helium", title: "Settings", roles: [], domain: "youtube.com").activity == .settings)
    #expect(Classification.infer(bundleID: "net.imput.helium", title: "Page", roles: [], domain: "youtube.com.evil.example").activity == .browsing)
    let editor = TaskContext.infer(bundleID: "com.apple.dt.Xcode", title: "Context.swift — Breadcrumb", documentURL: nil)
    #expect(editor.document == "Context.swift" && editor.project == "Breadcrumb")
    #expect(TaskContext.infer(bundleID: "example.unknown", title: "Context.swift — Breadcrumb", documentURL: nil).project == nil)
}
@Test func sessionGroupingPreservesInterruptionsAndSplitsGaps() {
    let rows = [sample(0, bundle: "editor", project: "Breadcrumb"), sample(30, bundle: "browser"), sample(60, bundle: "editor", project: "Breadcrumb"), sample(400, bundle: "editor", project: "Breadcrumb")]
    let sessions = ActivitySession.group(rows.reversed())
    #expect(sessions.count == 2)
    #expect(sessions[0].captures.map(\.id) == Array(rows.prefix(3)).map(\.id))
    #expect(sessions[0].title == "Breadcrumb")
    #expect(sessions[0].apps == ["browser", "editor"])
    #expect(sessions[1].captures.count == 1)
}
@Test func alongsideActivityDoesNotReplaceFocusedActivity() throws {
    var row = sample(0, bundle: "com.openai.chat")
    row.visibleWindows = [WindowContext(windowID: 2, app: "Browser", bundleID: "net.imput.helium", title: "Video - YouTube", focused: false, visibleFraction: 0.4)]
    let roundtrip = try JSONDecoder().decode(CaptureRecord.self, from: JSONEncoder().encode(row))
    #expect(roundtrip.activity == .assistant)
    #expect(roundtrip.visibleWindows?.first?.activity == .video)
    #expect(ActivitySession.group([roundtrip])[0].activities == [.assistant, .video])
    let summary = ActivitySummary(observations: [roundtrip], now: start.addingTimeInterval(5))
    #expect(summary.activities[.assistant]?.samples == 1)
    #expect(summary.activities[.video] == nil)
}
@Test func cadenceCoalescesChangesAndKeepsEventRateBounded() {
    var cadence = CaptureCadence()
    #expect(cadence.eventDelay(now: start) == 2)
    cadence.attempted(at: start)
    #expect(cadence.eventDelay(now: start.addingTimeInterval(1)) == 9)
    #expect(cadence.eventDelay(now: start.addingTimeInterval(20)) == 2)
}
