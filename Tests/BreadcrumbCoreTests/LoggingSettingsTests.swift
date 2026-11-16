import Foundation
import Testing
@testable import BreadcrumbCore

private let loggingNow = Date(timeIntervalSince1970: 1_800_000_000)
private func loggingFrame(_ offset: Double) -> CaptureRecord {
    CaptureRecord(date: loggingNow.addingTimeInterval(offset), app: "Editor", bundleID: "example.editor", windowTitle: "Example", treeStatus: "Test", classification: .infer(bundleID: "example.editor", title: "Example", roles: []))
}
@Test func continuousHistorySurvivesExpiryRestartAndSavingOldCaptures() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    let library = try Library(directory: path, settings: .continuous)
    let old = loggingFrame(-7 * 86400)
    try await library.append(old, payload: .init(jpeg: Data([1,2,3]), tree: []), now: loggingNow)
    let result = try await library.snapshot(now: loggingNow)
    #expect(result.rolling(at: loggingNow).map(\.id) == [old.id])
    #expect(result.settings.retentionHours == 0)
    _ = try await library.save(start: old.date, end: old.date, name: "Old retained capture", now: loggingNow)
    let reopened = try Library(directory: path)
    #expect(try await reopened.snapshot(now: loggingNow).observations.map(\.id) == [old.id])
    #expect(try await reopened.snapshot(now: loggingNow).settings.storageGiB == 20)
}
@Test func continuousStoragePressureRefusesWithoutEvictingHistory() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    var config = LoggingSettings(); config.retentionHours = 0
    // Reserve the larger continuous-history manifest allowance, leaving 1000 bytes of payload budget.
    let limits = Limits(rollingBytes: 2 * 128 * 1_048_576 + 2 * 1024 + 1000, manifestBytes: 4096, frameBytes: 1024)
    let library = try Library(directory: path, limits: limits, settings: config)
    let first = loggingFrame(-120), second = loggingFrame(-60), third = loggingFrame(-10)
    let data = CapturePayload(jpeg: Data(repeating: 1, count: 300), tree: [])
    try await library.append(first, payload: data, now: loggingNow)
    try await library.append(second, payload: data, now: loggingNow)
    await #expect(throws: LibraryError.self) { try await library.append(third, payload: data, now: loggingNow) }
    #expect(try await library.snapshot(now: loggingNow).observations.map(\.id) == [first.id, second.id])
}
@Test func configurationPersistsAndShorterRetentionProtectsSavedClips() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    let library = try Library(directory: path, settings: .continuous)
    let saved = loggingFrame(-3 * 86400), unsaved = loggingFrame(-2 * 86400), recent = loggingFrame(-30)
    for item in [saved, unsaved, recent] { try await library.append(item, payload: .init(jpeg: Data([1]), tree: []), now: loggingNow) }
    _ = try await library.save(start: saved.date, end: saved.date, name: "Keep", now: loggingNow)
    var config = LoggingSettings(); config.retentionHours = 24; config.intervalSeconds = 120
    config.captureChanges = false; config.recognizeText = false; config.maximumWidth = 1920; config.jpegQuality = 0.45
    try await library.updateSettings(config)
    let reopened = try Library(directory: path)
    let result = try await reopened.snapshot(now: loggingNow)
    #expect(result.settings == config)
    #expect(result.observations.map(\.id) == [saved.id, recent.id])
    #expect(result.rolling(at: loggingNow).map(\.id) == [recent.id])
    #expect(!FileManager.default.fileExists(atPath: path.appendingPathComponent(unsaved.id.uuidString + ".json").path))
}

@Test func renamedLibraryMigrationPreservesDataAndNeverOverwritesExistingLibrary() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let old = root.appendingPathComponent("Rewind")
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    try Data("preserved".utf8).write(to: old.appendingPathComponent("fixture"))
    let current = try LibraryLocation.resolve(in: root)
    #expect(current.lastPathComponent == "Breadcrumb")
    #expect(try Data(contentsOf: current.appendingPathComponent("fixture")) == Data("preserved".utf8))
    #expect(!FileManager.default.fileExists(atPath: old.path))
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    try Data("other".utf8).write(to: old.appendingPathComponent("fixture"))
    #expect(try LibraryLocation.resolve(in: root) == current)
    #expect(try Data(contentsOf: old.appendingPathComponent("fixture")) == Data("other".utf8))
}
