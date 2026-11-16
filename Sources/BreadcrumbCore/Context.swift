import Foundation

public struct WindowContext: Codable, Sendable {
    public var windowID: UInt32
    public var app: String
    public var bundleID: String
    public var title: String
    public var focused: Bool
    /// Geometric estimate after subtracting windows above it; not proof of attention.
    public var visibleFraction: Double
    public var activity: Activity { Classification.infer(bundleID: bundleID, title: title, roles: []).activity }
    public init(windowID: UInt32, app: String, bundleID: String, title: String, focused: Bool, visibleFraction: Double) {
        self.windowID = windowID; self.app = app; self.bundleID = bundleID; self.title = title
        self.focused = focused; self.visibleFraction = visibleFraction
    }
}

public struct TaskContext: Codable, Equatable, Sendable {
    public var domain: String?
    public var document: String?
    public var project: String?
    public init(domain: String? = nil, document: String? = nil, project: String? = nil) {
        self.domain = domain; self.document = document; self.project = project
    }
    public static func infer(bundleID: String, title: String, documentURL: String?) -> Self {
        var result = Self()
        if let raw = documentURL, let url = URL(string: raw) {
            if ["http", "https"].contains(url.scheme?.lowercased() ?? "") { result.domain = url.host?.lowercased() }
            if url.isFileURL {
                result.document = url.lastPathComponent
                result.project = url.deletingLastPathComponent().lastPathComponent
            }
        }
        if result.document == nil, ["com.microsoft.VSCode", "com.apple.dt.Xcode", "dev.zed.Zed", "com.todesktop.230313mzl4w4u92"].contains(bundleID) {
            let parts = title.components(separatedBy: CharacterSet(charactersIn: "—–")).map { $0.trimmingCharacters(in: .whitespaces) }
            if let file = parts.first, file.range(of: #"\.[A-Za-z0-9]{1,8}$"#, options: .regularExpression) != nil {
                result.document = file
                if parts.count > 1 { result.project = parts[1] }
            }
        }
        return result
    }
    public var label: String? { project ?? domain ?? document }
}

public struct ActivitySession: Identifiable, Sendable {
    public var id: UUID { captures[0].id }
    public var captures: [CaptureRecord]
    public var start: Date { captures[0].date }
    public var end: Date { captures[captures.count - 1].date }
    public var title: String { captures.compactMap { $0.context?.label }.first ?? captures[0].app }
    public var activities: [Activity] { Array(Set(captures.flatMap { [$0.activity] + ($0.visibleWindows ?? []).filter { !$0.focused }.map(\.activity) })).sorted { $0.rawValue < $1.rawValue } }
    public var apps: [String] { Array(Set(captures.map(\.app))).sorted() }

    /// Consecutive context segments; gaps over three minutes always split sessions.
    /// Brief interruptions are folded in only when the original context returns within two minutes.
    public static func group(_ records: [CaptureRecord]) -> [Self] {
        let rows = records.sorted { $0.date == $1.date ? $0.id.uuidString < $1.id.uuidString : $0.date < $1.date }
        func key(_ row: CaptureRecord) -> String { row.context?.project.map { "project:" + $0.lowercased() } ?? row.context?.domain.map { "domain:" + $0 } ?? row.bundleID }
        var result: [Self] = []
        var keys: [String] = []
        for row in rows {
            guard let last = result.last else { result.append(Self(captures: [row])); keys.append(key(row)); continue }
            let gap = row.date.timeIntervalSince(last.end)
            if gap <= 180, keys.last == key(row) {
                result[result.count - 1].captures.append(row)
            } else if result.count >= 2, gap <= 120, keys[result.count - 2] == key(row), row.date.timeIntervalSince(result[result.count - 2].end) <= 120 {
                let interruption = result.removeLast(); keys.removeLast()
                result[result.count - 1].captures += interruption.captures + [row]
            } else {
                result.append(Self(captures: [row])); keys.append(key(row))
            }
        }
        return result
    }
}

/// Timing decisions are independent of the native notification source and testable.
public struct CaptureCadence {
    public private(set) var lastAttempt = Date.distantPast
    public init() {}
    public func eventDelay(now: Date, minimumInterval: TimeInterval = 10) -> TimeInterval { max(2, minimumInterval - now.timeIntervalSince(lastAttempt)) }
    public mutating func attempted(at date: Date) { lastAttempt = date }
}
