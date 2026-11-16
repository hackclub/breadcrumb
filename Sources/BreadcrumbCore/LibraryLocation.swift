import Foundation

public enum LibraryLocation {
    /// Move the previous branded library once, without overwriting either directory.
    public static func resolve(in applicationSupport: URL) throws -> URL {
        let current = applicationSupport.appendingPathComponent("Breadcrumb", isDirectory: true)
        let legacy = applicationSupport.appendingPathComponent("Rewind", isDirectory: true)
        let fm = FileManager.default
        if !fm.fileExists(atPath: current.path), fm.fileExists(atPath: legacy.path) {
            try fm.moveItem(at: legacy, to: current)
        }
        return current
    }
}
