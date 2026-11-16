import Testing
import Foundation
@testable import BreadcrumbCore

private let summaryNow = Date(timeIntervalSince1970: 1_800_000_000)

private func observation(_ offset: TimeInterval, activity: Activity, app: String = "Browser") -> CaptureRecord {
    CaptureRecord(date: summaryNow.addingTimeInterval(offset), app: app, bundleID: "org.example.\(app)",
                  windowTitle: "Window", treeStatus: "Unavailable",
                  classification: .init(activity: activity, confidence: "Possible", reason: "Test context"))
}

@Test func summaryClipsOverlapsAndUsesCorrectionsWithoutReadingPayloads() {
    let older = observation(-70, activity: .coding, app: "Editor")
    var recent = observation(-20, activity: .video)
    recent.correction = .reading
    let summary = ActivitySummary(observations: [recent, older], now: summaryNow)
    #expect(summary.sampleCount == 2)
    #expect(summary.correctedCount == 1)
    #expect(summary.representedSeconds == 100)
    #expect(summary.activities[.coding]?.seconds == 55)
    #expect(summary.activities[.reading]?.seconds == 45)
    #expect(summary.activities[.video] == nil)
    #expect(summary.apps["Editor"]?.seconds == 55)
    #expect(summary.apps["Browser"]?.samples == 1)
    #expect(summary.unobservedSeconds == 14_300)
}

@Test func summaryLeavesLongGapsUnknownAndExcludesSavedHistoryOutsideWindow() {
    let frames = [observation(-14_401, activity: .coding), observation(-14_400, activity: .coding),
                  observation(-14_390, activity: .unknown), observation(-120, activity: .video),
                  observation(-10, activity: .unknown), observation(1, activity: .coding)]
    let summary = ActivitySummary(observations: frames, now: summaryNow)
    #expect(summary.sampleCount == 3)
    #expect(summary.representedSeconds == 140)
    #expect(summary.unobservedSeconds == 14_260)
    #expect(summary.activities[.unknown]?.samples == 2)
    #expect(summary.activities[.unknown]?.seconds == 80)
    #expect(summary.activities[.video]?.seconds == 60)
    #expect(summary.activities[.coding] == nil)
    #expect(summary.apps.values.reduce(0) { $0 + $1.seconds } == summary.representedSeconds)
    #expect(summary.activities.values.reduce(0) { $0 + $1.seconds } == summary.representedSeconds)

    let empty = ActivitySummary(observations: [], now: summaryNow)
    #expect(empty.sampleCount == 0 && empty.activities.isEmpty && empty.apps.isEmpty)
    #expect(empty.representedSeconds == 0 && empty.unobservedSeconds == 14_400)
}

@Test func focusedPageRulesSeparatePurposeFromMentionsAndGenericTitles() {
    let cases: [(String, Activity)] = [
        ("Home / X - Audio playing - Helium", .social),
        ("X", .browsing),
        ("Extensions - YouTube Downloader - Helium", .settings),
        ("How YouTube extensions work", .browsing),
        ("Lesson - YouTube - Audio playing", .video),
        ("Transcript: A conversation - Publication", .reading),
        ("Example/Project · GitHub", .developerPage),
        ("Example/Project", .browsing),
        ("Network dashboard", .browsing),
        ("", .browsing),
        ("Project - ChatGPT", .assistant),
        ("Claude tutorial - YouTube", .video),
        ("Build an amplifier", .browsing),
        ("About Claude Shannon", .browsing)
    ]
    for (title, expected) in cases {
        let result = Classification.infer(bundleID: "net.imput.helium", title: title, roles: [])
        #expect(result.activity == expected, "Focused title: \(title)")
        #expect(result.confidence == (expected == .unknown ? "Unknown" : "Possible"))
    }
    #expect(Classification.infer(bundleID: "dev.slick.byoe.handoff", title: "Window", roles: []).activity == .unknown)
    #expect(Classification.infer(bundleID: "dev.slick.byoe.handoff", title: "Workspace - Slack", roles: []).activity == .messaging)
    #expect(Classification.infer(bundleID: "org.whispersystems.signal-desktop", title: "Conversation", roles: []).activity == .messaging)
    #expect(Classification.infer(bundleID: "com.cron.electron", title: "Calendar", roles: []).activity == .calendar)
    #expect(Classification.infer(bundleID: "com.apple.TextEdit", title: "YouTube", roles: []).activity == .unknown)
}

@Test func legacyBrowserLabelsRefreshWithoutMutatingHistoryAndCorrectionsWin() throws {
    var original = CaptureRecord(date: summaryNow, app: "Helium", bundleID: "net.imput.helium",
        windowTitle: "Extensions - YouTube Downloader", treeStatus: "Truncated",
        classification: .init(activity: .video, confidence: "Possible", reason: "Legacy media substring", version: 1))
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let before = try encoder.encode(original)
    let restored = try JSONDecoder().decode(CaptureRecord.self, from: before)
    #expect(restored.activity == .settings)
    #expect(restored.suggestedClassification.version == Classification.currentVersion)
    #expect(restored.classification.version == 1 && restored.classification.activity == .video)
    #expect(try encoder.encode(restored) == before)
    original.correction = .social
    let corrected = try JSONDecoder().decode(CaptureRecord.self, from: encoder.encode(original))
    #expect(corrected.activity == .social)
    #expect(corrected.suggestedClassification.activity == .settings)
}

@Test func knownAppsAndGenericBrowserHaveUsefulBroadLabels() {
    #expect(Classification.infer(bundleID: "net.imput.helium", title: "You", roles: []).activity == .browsing)
    #expect(Classification.infer(bundleID: "ru.keepcoder.Telegram", title: "Chat", roles: []).activity == .messaging)
    #expect(Classification.infer(bundleID: "com.spotify.client", title: "Track", roles: []).activity == .music)
    #expect(Classification.infer(bundleID: "com.apple.mail", title: "Inbox", roles: []).activity == .mail)
    let old = CaptureRecord(date: summaryNow, app: "Telegram", bundleID: "ru.keepcoder.Telegram", windowTitle: "Chat", treeStatus: "Unavailable", classification: .init(activity: .unknown, confidence: "Unknown", reason: "Old rule", version: 2))
    #expect(old.activity == .messaging)
    #expect(Activity.messaging.displayName == "Messaging")
    #expect(Activity.messaging.rawValue == "Messaging interface") // Stable saved/API values.
}
