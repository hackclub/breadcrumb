import Foundation

public struct LoggingSettings: Codable, Equatable, Sendable {
    /// Zero retains captures until explicit deletion or a storage limit stops recording.
    public var retentionHours: Int = 4
    public var storageGiB: Int? = nil
    public var savedStorageGiB: Int? = nil
    public var intervalSeconds: Int = 60
    public var captureChanges = true
    public var minimumEventInterval: Int = 10
    public var recognizeText = true
    public var jpegQuality: Double = 0.65
    /// Zero uses native display resolution.
    public var maximumWidth: Int = 0
    public init() {}
    public static var continuous: Self {
        var settings = Self(); settings.retentionHours = 0; settings.storageGiB = 20
        return settings
    }
    public var retentionSeconds: TimeInterval? { retentionHours == 0 ? nil : Double(retentionHours) * 3600 }
    public var historyLabel: String { retentionHours == 0 ? "All history" : retentionHours < 24 ? "Last \(retentionHours) hours" : "Last \(retentionHours / 24) days" }
    public var normalized: Self {
        var result = self
        result.retentionHours = min(8760, max(0, retentionHours))
        result.storageGiB = storageGiB.map { min(1000, max(1, $0)) }
        result.savedStorageGiB = savedStorageGiB.map { min(1000, max(1, $0)) }
        result.intervalSeconds = min(3600, max(15, intervalSeconds))
        result.minimumEventInterval = min(300, max(5, minimumEventInterval))
        result.jpegQuality = jpegQuality.isFinite ? min(0.95, max(0.3, jpegQuality)) : 0.65
        result.maximumWidth = maximumWidth == 0 ? 0 : min(7680, max(1280, maximumWidth))
        return result
    }
    public func limits(basedOn base: Limits) -> Limits {
        var result = base
        if let storageGiB { result.rollingBytes = storageGiB * Limits.GiB }
        if let savedStorageGiB { result.savedBytes = savedStorageGiB * Limits.GiB }
        if retentionHours == 0 || retentionHours > 4 { result.manifestBytes = max(base.manifestBytes, 128 * 1_048_576) }
        return result
    }
}
