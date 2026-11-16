import Foundation
import CryptoKit

public enum LibraryError: LocalizedError {
    case full(String), empty, corrupt, tooLarge
    public var errorDescription: String? {
        switch self {
        case .full(let area): "\(area) is full. Increase the storage allowance or explicitly delete captures or clips."
        case .empty: "There are no available captures in that range."
        case .corrupt: "The library could not be read. No data was overwritten."
        case .tooLarge: "Capture or library metadata exceeds its safety limit."
        }
    }
}

private struct Index: Codable {
    var version = 1
    var observations: [CaptureRecord] = []
    var clips: [Clip] = []
    var markers: [Marker] = []
    var pinned: Set<UUID> { Set(clips.flatMap(\.frameIDs)) }
}

/// All saves, expiry, corrections, and deletion are serialized through this actor.
public actor Library {
    private let directory: URL
    private var limits: Limits
    private let baseLimits: Limits
    private var settings: LoggingSettings
    private var index: Index
    private let fm = FileManager.default
    private var needsOrphanCleanup = true

    public init(directory: URL, key: SymmetricKey? = nil, limits: Limits = Limits(), settings defaultSettings: LoggingSettings = LoggingSettings()) throws {
        self.directory = directory; self.baseLimits = limits
        let settingsURL = directory.appendingPathComponent("settings.json")
        if FileManager.default.fileExists(atPath: settingsURL.path) {
            let data = try Data(contentsOf: settingsURL)
            guard data.count <= 64 * 1024 else { throw LibraryError.tooLarge }
            self.settings = try JSONDecoder().decode(LoggingSettings.self, from: data).normalized
        } else { self.settings = defaultSettings.normalized }
        self.limits = self.settings.limits(basedOn: limits)
        let limits = self.limits
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        var folder = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        if !FileManager.default.fileExists(atPath: settingsURL.path) {
            try JSONEncoder().encode(self.settings).write(to: settingsURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsURL.path)
        }
        let manifest = directory.appendingPathComponent("library.json")
        let legacy = directory.appendingPathComponent("library.sealed")
        if FileManager.default.fileExists(atPath: manifest.path) {
            do {
                let data = try Data(contentsOf: manifest)
                guard data.count <= limits.manifestBytes else { throw LibraryError.tooLarge }
                index = try JSONDecoder().decode(Index.self, from: data)
                guard index.version == 1 else { throw LibraryError.corrupt }
            } catch { throw LibraryError.corrupt }
        } else if FileManager.default.fileExists(atPath: legacy.path) {
            // Write every converted payload before publishing the new manifest. On failure,
            // the untouched legacy manifest remains authoritative and conversion can retry.
            guard let key else { throw LibraryError.corrupt }
            let data = try Data(contentsOf: legacy)
            guard data.count <= limits.manifestBytes else { throw LibraryError.tooLarge }
            let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key)
            var converted = try JSONDecoder().decode(Index.self, from: clear)
            guard converted.version == 1 else { throw LibraryError.corrupt }
            for i in converted.observations.indices {
                let id = converted.observations[i].id.uuidString
                let sealed = try Data(contentsOf: directory.appendingPathComponent(id + ".sealed"))
                let payload = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key)
                _ = try JSONDecoder().decode(CapturePayload.self, from: payload)
                try payload.write(to: directory.appendingPathComponent(id + ".json"), options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory.appendingPathComponent(id + ".json").path)
                converted.observations[i].bytes = payload.count
            }
            let convertedData = try JSONEncoder().encode(converted)
            guard convertedData.count <= limits.manifestBytes else { throw LibraryError.tooLarge }
            try convertedData.write(to: manifest, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path)
            index = converted
        } else { index = Index() }
    }

    private func blob(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".json") }

    private func write(_ candidate: Index) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(candidate)
        guard data.count <= limits.manifestBytes else { throw LibraryError.tooLarge }
        try data.write(to: directory.appendingPathComponent("library.json"), options: .atomic)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory.appendingPathComponent("library.json").path)
    }

    private func commit(_ candidate: Index) throws {
        try write(candidate)
        index = candidate
        try removeOrphans()
    }

    private func removeOrphans() throws {
        needsOrphanCleanup = true
        // Commit references before removing blobs: crashes may leave orphans, never dangling saved IDs.
        let keep = Set(index.observations.map { $0.id.uuidString + ".json" })
        for file in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            if file.pathExtension == "sealed" || (file.pathExtension == "json" && UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil && !keep.contains(file.lastPathComponent)) {
                try fm.removeItem(at: file)
            }
        }
        needsOrphanCleanup = false
    }

    private func expired(_ source: Index, now: Date) -> Index {
        var result = source
        let pinned = result.pinned
        if let retention = settings.retentionSeconds {
            result.observations.removeAll { !pinned.contains($0.id) && $0.date <= now.addingTimeInterval(-retention) }
            result.markers.removeAll { $0.date <= now.addingTimeInterval(-retention) }
        }
        return result
    }

    @discardableResult
    public func snapshot(now: Date = .now) throws -> LibrarySnapshot {
        try importAgentLabels()
        let candidate = expired(index, now: now)
        // Expiry only removes entries. Reading an unchanged library must not rewrite it.
        if candidate.observations.count != index.observations.count || candidate.markers.count != index.markers.count {
            try commit(candidate)
        } else if needsOrphanCleanup {
            try removeOrphans()
        }
        var result = LibrarySnapshot()
        result.settings = settings
        result.observations = index.observations.sorted { $0.date < $1.date }
        result.clips = index.clips.sorted { $0.created > $1.created }
        result.markers = index.markers
        let pinned = index.pinned
        result.rollingBytes = index.observations.filter { !pinned.contains($0.id) }.reduce(0) { $0 + $1.bytes }
        result.savedBytes = index.observations.filter { pinned.contains($0.id) }.reduce(0) { $0 + $1.bytes }
        result.diskBytes = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey]).reduce(0) {
            $0 + ((try $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return result
    }

    public func updateSettings(_ newSettings: LoggingSettings) throws {
        let next = newSettings.normalized
        let data = try JSONEncoder().encode(next)
        let path = directory.appendingPathComponent("settings.json")
        try data.write(to: path, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        settings = next
        limits = next.limits(basedOn: baseLimits)
    }

    public func append(_ observation: CaptureRecord, payload: CapturePayload, now: Date = .now) throws {
        let encrypted = try JSONEncoder().encode(payload)
        guard encrypted.count <= limits.frameBytes else { throw LibraryError.tooLarge }
        var next = expired(index, now: now)
        let pinned = next.pinned
        let budget = limits.rollingBytes - limits.reserve
        var used = next.observations.filter { !pinned.contains($0.id) }.reduce(0) { $0 + $1.bytes }
        for item in next.observations.sorted(by: { $0.date < $1.date }) where settings.retentionSeconds != nil && used + encrypted.count > budget && !pinned.contains(item.id) {
            next.observations.removeAll { $0.id == item.id }; used -= item.bytes
        }
        guard used + encrypted.count <= budget else { throw LibraryError.full("Rolling buffer") }
        var record = observation; record.bytes = encrypted.count
        next.observations.append(record)
        let path = blob(record.id)
        try encrypted.write(to: path, options: .atomic)
        do {
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            try commit(next)
        } catch {
            // Never remove an indexed blob if cleanup failed after a successful commit.
            if !index.observations.contains(where: { $0.id == record.id }) { try? fm.removeItem(at: path) }
            throw error
        }
    }

    public func payload(for id: UUID) throws -> CapturePayload {
        guard index.observations.contains(where: { $0.id == id }) else { throw LibraryError.empty }
        let data = try Data(contentsOf: blob(id))
        return try JSONDecoder().decode(CapturePayload.self, from: data)
    }

    @discardableResult
    public func save(start: Date, end: Date, name: String, now: Date = .now) throws -> UUID {
        var next = expired(index, now: now)
        let selected = next.observations.filter { $0.date >= start && $0.date <= end && (settings.retentionSeconds == nil || $0.date > now.addingTimeInterval(-(settings.retentionSeconds ?? 0))) }
        guard start <= end, !selected.isEmpty else { throw LibraryError.empty }
        let ids = next.pinned.union(selected.map(\.id))
        let bytes = next.observations.filter { ids.contains($0.id) }.reduce(0) { $0 + $1.bytes }
        guard bytes <= limits.savedBytes else { throw LibraryError.full("Saved library") }
        let clip = Clip(name: String(name.prefix(100)), created: now, frameIDs: selected.map(\.id))
        next.clips.append(clip)
        try commit(next)
        return clip.id
    }

    public func addMarker(at date: Date = .now) throws {
        var next = index
        next.markers.append(Marker(date: date))
        guard next.markers.count <= 500 else { throw LibraryError.full("Markers") }
        try commit(next)
    }

    public func correct(id: UUID, activity: Activity?) throws {
        var next = index
        guard let position = next.observations.firstIndex(where: { $0.id == id }) else { throw LibraryError.empty }
        next.observations[position].correction = activity
        try commit(next)
    }

    /// Each inbox file is one atomic batch. Invalid batches remain available for diagnosis.
    private func importAgentLabels() throws {
        let inbox = directory.appendingPathComponent("inbox", isDirectory: true)
        try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
        for file in try fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where file.pathExtension == "json" {
            let data = try Data(contentsOf: file)
            guard data.count <= limits.manifestBytes else { throw LibraryError.tooLarge }
            let labels = try JSONDecoder().decode([AgentLabel].self, from: data)
            guard labels.allSatisfy({ $0.reason.count <= 1000 && $0.flags.count <= 20 && $0.flags.allSatisfy { $0.count <= 100 } }) else { throw LibraryError.tooLarge }
            var next = index
            for label in labels {
                // Expired/deleted IDs are ignored; imports cannot resurrect captures.
                if let i = next.observations.firstIndex(where: { $0.id == label.id }) {
                    next.observations[i].agentLabel = label
                }
            }
            try commit(next)
            try fm.removeItem(at: file)
        }
    }

    public func deleteClip(_ id: UUID, now: Date = .now) throws {
        var next = index; next.clips.removeAll { $0.id == id }
        next = expired(next, now: now)
        try commit(next)
    }

    public func deleteCaptures(since date: Date) throws {
        var next = index
        let removed = Set(next.observations.filter { $0.date >= date }.map(\.id))
        next.observations.removeAll { removed.contains($0.id) }
        for i in next.clips.indices { next.clips[i].frameIDs.removeAll { removed.contains($0) } }
        next.clips.removeAll { $0.frameIDs.isEmpty }
        next.markers.removeAll { $0.date >= date }
        try commit(next)
    }
}
