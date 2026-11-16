import Testing
import Foundation
import CryptoKit
@testable import BreadcrumbCore

private let instant = Date(timeIntervalSince1970: 1_800_000_000)

private func frame(_ offset: TimeInterval, title: String = "Private project.swift") -> CaptureRecord {
    CaptureRecord(date: instant.addingTimeInterval(offset), app: "Xcode", bundleID: "com.apple.dt.Xcode",
                windowTitle: title, treeStatus: "Filtered tree",
                classification: .infer(bundleID: "com.apple.dt.Xcode", title: title, roles: ["AXTextArea"]))
}

private func temporaryLibrary(limits: Limits = Limits()) throws -> (Library, URL, SymmetricKey) {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let key = SymmetricKey(size: .bits256)
    return (try Library(directory: path, key: key, limits: limits), path, key)
}

@Test func unchangedRefreshDoesNotRewritePlainLibrary() async throws {
    let (library, path, key) = try temporaryLibrary()
    defer { try? FileManager.default.removeItem(at: path) }
    let record = frame(-60)
    try await library.append(record, payload: .init(jpeg: Data([1, 2, 3]), tree: []), now: instant)
    let manifest = path.appendingPathComponent("library.json")
    let before = try Data(contentsOf: manifest)
    let orphan = path.appendingPathComponent(UUID().uuidString + ".json")
    try Data([4, 5, 6]).write(to: orphan)
    let reopened = try Library(directory: path, key: key)
    for _ in 0..<3 {
        let result = try await reopened.snapshot(now: instant)
        #expect(result.observations.map(\.id) == [record.id])
        #expect(try Data(contentsOf: manifest) == before)
    }
    #expect(!FileManager.default.fileExists(atPath: orphan.path))
    let expired = try await reopened.snapshot(now: instant.addingTimeInterval(Limits.history))
    #expect(expired.observations.isEmpty)
    #expect(try Data(contentsOf: manifest) != before)
    #expect(!FileManager.default.fileExists(atPath: path.appendingPathComponent(record.id.uuidString + ".json").path))
}

@Test func fourHourBoundaryAndSavedClipSurviveRestart() async throws {
    let (library, path, key) = try temporaryLibrary()
    defer { try? FileManager.default.removeItem(at: path) }
    let data = CapturePayload(jpeg: Data("private pixels".utf8), tree: [.init(role: "AXWindow", label: "private label", depth: 0)])
    let boundary = frame(-14_400), saved = frame(-14_399), recent = frame(-11)
    for item in [boundary, saved, recent] { try await library.append(item, payload: data, now: instant) }
    let initial = try await library.snapshot(now: instant)
    #expect(initial.observations.map(\.id) == [saved.id, recent.id])
    let clip = try await library.save(start: saved.date, end: saved.date, name: "Keep", now: instant)
    try await library.addMarker(at: saved.date)
    let later = try await library.snapshot(now: instant.addingTimeInterval(2))
    #expect(later.rolling(at: instant.addingTimeInterval(2)).map(\.id) == [recent.id])
    #expect(later.markers.isEmpty)
    let reopened = try Library(directory: path, key: key)
    let restored = try await reopened.snapshot(now: instant.addingTimeInterval(2))
    #expect(restored.clips.first?.id == clip)
    #expect(restored.observations.map(\.id) == [saved.id, recent.id])
    let payload = try await reopened.payload(for: saved.id)
    #expect(payload.jpeg == data.jpeg)
    #expect(payload.tree.first?.label == "private label")
    #expect(String(data: try Data(contentsOf: path.appendingPathComponent("library.json")), encoding: .utf8)!.contains("Private project.swift"))
    let manifest = path.appendingPathComponent("library.json")
    let encrypted = try Data(contentsOf: manifest)
    _ = try Library(directory: path) // No Keychain key needed.
    #expect(try Data(contentsOf: manifest) == encrypted)
    let damaged = Data(encrypted.prefix(12))
    try damaged.write(to: manifest, options: .atomic)
    #expect(throws: LibraryError.self) { try Library(directory: path, key: key) }
    #expect(try Data(contentsOf: manifest) == damaged)
    try encrypted.write(to: manifest, options: .atomic)
    let recovered = try Library(directory: path, key: key)
    let preserved = try await recovered.payload(for: saved.id)
    #expect(preserved.jpeg == data.jpeg)
}

@Test func failedManifestWritePreservesCommittedHistoryAcrossRestart() async throws {
    let (library, path, key) = try temporaryLibrary()
    let manifest = path.appendingPathComponent("library.json")
    defer {
        try? FileManager.default.setAttributes([.immutable: false], ofItemAtPath: manifest.path)
        try? FileManager.default.removeItem(at: path)
    }
    let committed = frame(-120), interrupted = frame(-60)
    let payload = CapturePayload(jpeg: Data([1, 2, 3]), tree: [])
    try await library.append(committed, payload: payload, now: instant)
    let clip = try await library.save(start: committed.date, end: committed.date, name: "Keep", now: instant)
    let before = try Data(contentsOf: manifest)
    // Real filesystem failure after the new encrypted payload is written but before index replacement.
    try FileManager.default.setAttributes([.immutable: true], ofItemAtPath: manifest.path)
    await #expect(throws: (any Error).self) {
        try await library.append(interrupted, payload: payload, now: instant)
    }
    let unchanged = try await library.snapshot(now: instant)
    #expect(unchanged.observations.map(\.id) == [committed.id])
    #expect(unchanged.clips.map(\.id) == [clip])
    #expect(try Data(contentsOf: manifest) == before)
    try FileManager.default.setAttributes([.immutable: false], ofItemAtPath: manifest.path)
    let reopened = try Library(directory: path, key: key)
    let restored = try await reopened.snapshot(now: instant)
    #expect(restored.observations.map(\.id) == [committed.id])
    #expect(restored.clips.map(\.id) == [clip])
    #expect(!FileManager.default.fileExists(atPath: path.appendingPathComponent(interrupted.id.uuidString + ".json").path))
    let saved = try await reopened.payload(for: committed.id)
    #expect(saved.jpeg == payload.jpeg)
    try await reopened.append(interrupted, payload: payload, now: instant)
    let resumed = try await reopened.snapshot(now: instant)
    #expect(resumed.observations.map(\.id) == [committed.id, interrupted.id])
}

@Test func byteEvictionKeepsPinnedAndNewestCaptures() async throws {
    let limits = Limits(rollingBytes: 11_240, savedBytes: 10_000, manifestBytes: 4096, frameBytes: 1024)
    let (library, path, _) = try temporaryLibrary(limits: limits)
    defer { try? FileManager.default.removeItem(at: path) }
    let items = [frame(-100), frame(-90), frame(-80), frame(-70)]
    for (i, item) in items.enumerated() {
        try await library.append(item, payload: .init(jpeg: Data(repeating: UInt8(i), count: 300), tree: []), now: instant)
        if i == 0 { _ = try await library.save(start: item.date, end: item.date, name: "Pinned", now: instant) }
    }
    let result = try await library.snapshot(now: instant)
    #expect(result.observations.map(\.id) == [items[0].id, items[2].id, items[3].id])
    #expect(result.rollingBytes <= 1000)
    #expect(result.savedBytes > 0)
    #expect(result.diskBytes <= limits.rollingBytes + limits.savedBytes)
}

@Test func fullSavedLibraryRefusesWithoutLosingBuffer() async throws {
    let (library, path, _) = try temporaryLibrary(limits: Limits(savedBytes: 100))
    defer { try? FileManager.default.removeItem(at: path) }
    let item = frame(-30)
    try await library.append(item, payload: .init(jpeg: Data(repeating: 4, count: 1000), tree: []), now: instant)
    await #expect(throws: LibraryError.self) {
        try await library.save(start: item.date, end: item.date, name: "Too big", now: instant)
    }
    let result = try await library.snapshot(now: instant)
    #expect(result.clips.isEmpty)
    #expect(result.observations.map(\.id) == [item.id])
}

@Test func privacyDeletionRemovesSavedReferencesAndPayload() async throws {
    let (library, path, key) = try temporaryLibrary()
    defer { try? FileManager.default.removeItem(at: path) }
    let older = frame(-7200), recent = frame(-100)
    for item in [older, recent] {
        try await library.append(item, payload: .init(jpeg: Data([1, 2, 3]), tree: []), now: instant)
    }
    _ = try await library.save(start: older.date, end: recent.date, name: "Spanning", now: instant)
    try await library.correct(id: older.id, activity: .reading)
    try await library.deleteCaptures(since: instant.addingTimeInterval(-3600))
    let reopened = try Library(directory: path, key: key)
    let result = try await reopened.snapshot(now: instant)
    #expect(result.clips.first?.frameIDs == [older.id])
    #expect(result.observations.first?.activity == .reading)
    #expect(!FileManager.default.fileExists(atPath: path.appendingPathComponent(recent.id.uuidString + ".json").path))
    await #expect(throws: LibraryError.self) { try await reopened.payload(for: recent.id) }
}

@Test func activityRulesDoNotConfuseAppIdentityWithAttention() {
    let terminal = Classification.infer(bundleID: "com.apple.Terminal", title: "watch tutorial", roles: ["AXTextArea"])
    #expect(terminal.activity == .terminal)
    let video = Classification.infer(bundleID: "com.apple.Safari", title: "Swift tutorial - YouTube", roles: [])
    #expect(video.activity == .video)
    #expect(video.confidence == "Possible")
    let editor = Classification.infer(bundleID: "com.apple.dt.Xcode", title: "Welcome to Xcode", roles: [])
    #expect(editor.confidence == "Possible")
    let source = Classification.infer(bundleID: "com.apple.dt.Xcode", title: "Library.swift", roles: ["AXTextArea"])
    #expect(source.confidence == "Likely")
    let unknown = Classification.infer(bundleID: "org.example.App", title: "Window", roles: [])
    #expect(unknown.activity == .unknown)
}

@Test func agentInboxLabelsAndFlagsRespectManualCorrections() async throws {
    let (library, path, _) = try temporaryLibrary()
    defer { try? FileManager.default.removeItem(at: path) }
    let item = frame(-30)
    try await library.append(item, payload: .init(jpeg: Data([1]), tree: []), now: instant)
    try await library.correct(id: item.id, activity: .reading)
    let inbox = path.appendingPathComponent("inbox")
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    let batch = inbox.appendingPathComponent("batch.json")
    let label = AgentLabel(id: item.id, activity: .video, flags: ["review-context"], reason: "Example rule")
    try JSONEncoder().encode([label]).write(to: batch)
    let result = try await library.snapshot(now: instant)
    #expect(result.observations.first?.activity == .reading)
    #expect(result.observations.first?.agentLabel?.flags == ["review-context"])
    #expect(!FileManager.default.fileExists(atPath: batch.path))
    try await library.correct(id: item.id, activity: nil)
    let reopened = try Library(directory: path)
    #expect(try await reopened.snapshot(now: instant).observations.first?.activity == .video)
    try Data("invalid".utf8).write(to: batch)
    await #expect(throws: (any Error).self) { try await reopened.snapshot(now: instant) }
    #expect(FileManager.default.fileExists(atPath: batch.path))
}

@Test func legacyMigrationPreservesPayloadAndStopsNeedingKey() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    let key = SymmetricKey(size: .bits256)
    let item = frame(-20)
    let payload = CapturePayload(jpeg: Data([7, 8]), tree: [])
    struct LegacyIndex: Encodable {
        let version = 1
        let observations: [CaptureRecord]
        let clips: [Clip] = []
        let markers: [Marker] = []
    }
    let manifest = path.appendingPathComponent("library.sealed")
    let bytes = try AES.GCM.seal(JSONEncoder().encode(LegacyIndex(observations: [item])), using: key).combined!
    try bytes.write(to: manifest)
    try AES.GCM.seal(JSONEncoder().encode(payload), using: key).combined!.write(to: path.appendingPathComponent(item.id.uuidString + ".sealed"))
    #expect(throws: (any Error).self) { try Library(directory: path, key: SymmetricKey(size: .bits256)) }
    #expect(try Data(contentsOf: manifest) == bytes)
    let migrated = try Library(directory: path, key: key)
    #expect(try await migrated.payload(for: item.id).jpeg == payload.jpeg)
    _ = try await migrated.snapshot(now: instant)
    #expect(!FileManager.default.fileExists(atPath: manifest.path))
    let reopened = try Library(directory: path)
    #expect(try await reopened.payload(for: item.id).jpeg == payload.jpeg)
}
