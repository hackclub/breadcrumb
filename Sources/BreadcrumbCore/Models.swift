import Foundation

public enum Activity: String, Codable, CaseIterable, Sendable {
    case coding = "Coding", terminal = "Terminal work", reading = "Reading"
    case video = "Video page", meeting = "Meeting app"
    case messaging = "Messaging interface", assistant = "AI assistant page", social = "Social page"
    case calendar = "Calendar interface", developerPage = "Developer page", settings = "Browser settings"
    case browsing = "Browsing", music = "Music app", mail = "Email app"
    case unknown = "Unclassified"

    public var displayName: String {
        switch self {
        case .terminal: "Terminal"
        case .video: "Video"
        case .meeting: "Meetings"
        case .messaging: "Messaging"
        case .assistant: "AI assistants"
        case .social: "Social"
        case .calendar: "Calendar"
        case .developerPage: "Developer sites"
        case .settings: "Settings"
        case .music: "Music"
        case .mail: "Email"
        case .unknown: "Other apps"
        default: rawValue
        }
    }

    public var symbol: String {
        switch self {
        case .coding: "curlybraces"
        case .terminal: "terminal"
        case .reading: "doc.text"
        case .video: "play.rectangle"
        case .meeting: "person.2"
        case .messaging: "bubble.left.and.bubble.right"
        case .assistant: "sparkles"
        case .social: "person.2.wave.2"
        case .calendar: "calendar"
        case .developerPage: "chevron.left.forwardslash.chevron.right"
        case .settings: "gearshape"
        case .browsing: "globe"
        case .music: "music.note"
        case .mail: "envelope"
        case .unknown: "questionmark.circle"
        }
    }
}

public struct Classification: Codable, Sendable {
    public static let currentVersion = 4
    public var activity: Activity
    public var confidence: String
    public var reason: String
    public var version = Classification.currentVersion

    // Slick is a page container, not an app-wide purpose signal.
    static func usesPageTitles(_ bundleID: String) -> Bool {
        ["com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "org.mozilla.firefox",
         "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser",
         "net.imput.helium", "dev.slick.byoe.handoff"].contains(bundleID)
    }

    public static func infer(bundleID: String, title: String, roles: [String], domain: String? = nil) -> Self {
        let text = title.lowercased()
        if ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty"].contains(bundleID) {
            return .init(activity: .terminal, confidence: "Possible", reason: "Terminal is in front. Commands, attention, and purpose are not inferred.")
        }
        if ["com.microsoft.VSCode", "com.apple.dt.Xcode", "com.todesktop.230313mzl4w4u92", "dev.zed.Zed"].contains(bundleID) {
            let source = [".swift", ".rs", ".ts", ".py", ".go", ".js", ".cpp"].contains { text.contains($0) }
            let editor = roles.contains("AXTextArea")
            return .init(activity: .coding, confidence: source && editor ? "Likely" : "Possible", reason: source && editor ? "A source file and editor are exposed. This does not prove typing." : "An editor is in front. Editing and attention are unverified.")
        }
        if ["com.openai.chat", "com.openai.codex", "com.anthropic.claudefordesktop"].contains(bundleID) {
            return .init(activity: .assistant, confidence: "Possible", reason: "An AI assistant app is in front. Purpose and attention are unverified.")
        }
        if bundleID == "us.zoom.xos" || bundleID == "com.microsoft.teams2" {
            return .init(activity: .meeting, confidence: "Possible", reason: "A conferencing app is visible. An active call is not verified.")
        }
        if ["org.whispersystems.signal-desktop", "com.tinyspeck.slackmacgap", "com.apple.MobileSMS", "ru.keepcoder.Telegram", "com.hnc.Discord"].contains(bundleID) {
            return .init(activity: .messaging, confidence: "Possible", reason: "A messaging interface is in front. Sending messages and attention are not verified.")
        }
        if ["com.cron.electron", "com.apple.iCal"].contains(bundleID) {
            return .init(activity: .calendar, confidence: "Possible", reason: "A calendar interface is in front. Planning or attending an event is not verified.")
        }
        if ["com.spotify.client", "com.apple.Music"].contains(bundleID) {
            return .init(activity: .music, confidence: "Possible", reason: "A music app is in front. Playback and listening are unverified.")
        }
        if ["com.apple.mail", "com.readdle.smartemail-Mac"].contains(bundleID) {
            return .init(activity: .mail, confidence: "Possible", reason: "An email app is in front. Reading or sending is unverified.")
        }
        guard usesPageTitles(bundleID) else {
            return .init(activity: .unknown, confidence: "Unknown", reason: "Not enough reliable context to assign an activity.")
        }
        var page = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffixes = [" - audio playing", " - helium", " - google chrome", " - chromium", " — mozilla firefox", " - microsoft edge", " — safari", " - safari", " - brave"]
        while let suffix = suffixes.first(where: { page.hasSuffix($0) }) {
            page = String(page.dropLast(suffix.count)).trimmingCharacters(in: .whitespaces)
        }
        if page == "settings" || page == "extensions" || page.hasPrefix("extensions - ") || page.hasPrefix("settings - ") {
            return .init(activity: .settings, confidence: "Possible", reason: "The focused browser title identifies settings or extensions, not the purpose suggested by an extension's name.")
        }
        if let domain = domain?.lowercased() {
            let sites: [([String], Activity)] = [
                (["chatgpt.com", "chat.openai.com", "claude.ai"], .assistant),
                (["youtube.com", "youtu.be", "vimeo.com"], .video),
                (["github.com", "gitlab.com"], .developerPage),
                (["slack.com", "discord.com", "web.telegram.org"], .messaging),
                (["reddit.com", "x.com", "instagram.com"], .social)
            ]
            for (hosts, activity) in sites where hosts.contains(where: { domain == $0 || domain.hasSuffix("." + $0) }) {
                return .init(activity: activity, confidence: "Possible", reason: "The exposed browser document domain identifies this context. Activity and attention are unverified.")
            }
        }
        if ["youtube", "vimeo"].contains(page) || [" - youtube", " | youtube", " - vimeo", " on vimeo"].contains(where: page.hasSuffix) {
            return .init(activity: .video, confidence: "Possible", reason: "A media page is visible. Playback and watching are not verified.")
        }
        if page.hasSuffix(" / x") || [" - reddit", " | reddit", " • instagram", " - instagram"].contains(where: page.hasSuffix) {
            return .init(activity: .social, confidence: "Possible", reason: "The focused title identifies a social page. Embedded panes and attention are unverified; this is not exclusive social-use time.")
        }
        if ["chatgpt", "claude"].contains(page) || [" - chatgpt", " | chatgpt", " - claude", " | claude", " — claude"].contains(where: page.hasSuffix) {
            return .init(activity: .assistant, confidence: "Possible", reason: "The focused title identifies an assistant page. Prompting, coding, and attention are not verified.")
        }
        if [" - slack", " | slack", " - discord", " | discord"].contains(where: page.hasSuffix) {
            return .init(activity: .messaging, confidence: "Possible", reason: "The focused title identifies a messaging interface. Sending messages and attention are not verified.")
        }
        if [" · github", " - github", " · gitlab", " - gitlab"].contains(where: page.hasSuffix) {
            return .init(activity: .developerPage, confidence: "Possible", reason: "The focused title identifies a development-service page. This does not prove coding or reviewing code.")
        }
        if page.hasPrefix("transcript: ") || ["documentation", "developer.apple.com", "mdn web docs", " — docs", " - docs"].contains(where: page.contains) {
            return .init(activity: .reading, confidence: "Possible", reason: "The focused title identifies documentation or reference context. Reading and attention are not verified.")
        }
        return bundleID == "dev.slick.byoe.handoff"
            ? .init(activity: .unknown, confidence: "Unknown", reason: "The focused page does not identify an activity.")
            : .init(activity: .browsing, confidence: "Possible", reason: "A browser is in front. The page title does not identify a more specific activity.")
    }
}

public struct AccessibilityNode: Codable, Sendable {
    public var role: String
    public var label: String?
    public var depth: Int
    public init(role: String, label: String?, depth: Int) {
        self.role = role; self.label = label; self.depth = depth
    }
}

public struct CapturePayload: Codable, Sendable {
    public var jpeg: Data
    public var tree: [AccessibilityNode]
    public var screenText: String?
    public init(jpeg: Data, tree: [AccessibilityNode], screenText: String? = nil) { self.jpeg = jpeg; self.tree = tree; self.screenText = screenText }
}

/// Agent suggestions are separate from manual corrections, which always win.
public struct AgentLabel: Codable, Sendable {
    public var id: UUID
    public var activity: Activity
    public var flags: [String]
    public var reason: String
}

public struct CaptureRecord: Identifiable, Codable, Sendable {
    public var id: UUID
    public var date: Date
    public var app: String
    public var bundleID: String
    public var windowTitle: String
    public var windowID: UInt32
    public var context: TaskContext?
    public var visibleWindows: [WindowContext]?
    public var captureReason: String?
    public var captureScope: String?
    public var displayID: UInt32?
    public var treeStatus: String
    public var classification: Classification
    public var agentLabel: AgentLabel?
    public var correction: Activity?
    public var bytes: Int = 0
    public var suggestedClassification: Classification {
        if classification.version < Classification.currentVersion,
           Classification.usesPageTitles(bundleID) || classification.activity == .unknown {
            return .infer(bundleID: bundleID, title: windowTitle, roles: [], domain: context?.domain)
        }
        return classification
    }
    public var activity: Activity { correction ?? agentLabel?.activity ?? suggestedClassification.activity }

    public init(id: UUID = UUID(), date: Date, app: String, bundleID: String, windowTitle: String,
                windowID: UInt32 = 0, treeStatus: String, classification: Classification) {
        self.id = id; self.date = date; self.app = app; self.bundleID = bundleID
        self.windowTitle = windowTitle; self.windowID = windowID
        self.treeStatus = treeStatus; self.classification = classification
    }
}

public struct Clip: Identifiable, Codable, Sendable {
    public var id: UUID = UUID()
    public var name: String
    public var created: Date
    public var frameIDs: [UUID]
}

public struct Marker: Identifiable, Codable, Sendable {
    public var id: UUID = UUID()
    public var date: Date
}

public struct LibrarySnapshot: Sendable {
    public var settings = LoggingSettings()
    public var observations: [CaptureRecord] = []
    public var clips: [Clip] = []
    public var markers: [Marker] = []
    public var rollingBytes = 0
    public var savedBytes = 0
    public var diskBytes = 0
    public init() {}
    public func rolling(at date: Date = .now) -> [CaptureRecord] {
        observations.filter { (settings.retentionSeconds == nil || $0.date > date.addingTimeInterval(-(settings.retentionSeconds ?? 0))) && $0.date <= date }
    }
}

/// A bounded estimate of sampled context, not elapsed attention or working time.
public struct ActivitySummary: Sendable {
    public struct Total: Sendable {
        public var samples = 0
        public var seconds: TimeInterval = 0
    }

    public let start: Date
    public let end: Date
    public private(set) var sampleCount = 0
    public private(set) var correctedCount = 0
    public private(set) var representedSeconds: TimeInterval = 0
    public private(set) var activities: [Activity: Total] = [:]
    public private(set) var apps: [String: Total] = [:]
    public var unobservedSeconds: TimeInterval { Limits.history - representedSeconds }

    public init(observations: [CaptureRecord], now: Date = .now) {
        start = now.addingTimeInterval(-Limits.history)
        end = now
        let frames = observations.filter { $0.date > start && $0.date <= end }
            .sorted { $0.date == $1.date ? $0.id.uuidString < $1.id.uuidString : $0.date < $1.date }
        sampleCount = frames.count
        for (index, frame) in frames.enumerated() {
            // At most 30 seconds on each side; never fill gaps or count overlaps twice.
            var lower = max(start, frame.date.addingTimeInterval(-30))
            var upper = min(end, frame.date.addingTimeInterval(30))
            if index > 0 {
                lower = max(lower, frames[index - 1].date.addingTimeInterval(frame.date.timeIntervalSince(frames[index - 1].date) / 2))
            }
            if index + 1 < frames.count {
                upper = min(upper, frame.date.addingTimeInterval(frames[index + 1].date.timeIntervalSince(frame.date) / 2))
            }
            let seconds = max(0, upper.timeIntervalSince(lower))
            representedSeconds += seconds
            activities[frame.activity, default: Total()].samples += 1
            activities[frame.activity, default: Total()].seconds += seconds
            apps[frame.app, default: Total()].samples += 1
            apps[frame.app, default: Total()].seconds += seconds
            if frame.correction != nil { correctedCount += 1 }
        }
    }
}

public struct Limits: Sendable {
    public static let history: TimeInterval = 4 * 60 * 60
    public static let GiB = 1_073_741_824
    public var rollingBytes: Int
    public var savedBytes: Int
    public var manifestBytes: Int
    public var frameBytes: Int
    // Reserved inside the rolling ceiling for atomic writes, metadata, and one incoming frame.
    public var reserve: Int { manifestBytes * 2 + frameBytes * 2 }
    public init(rollingBytes: Int = 2 * GiB, savedBytes: Int = 4 * GiB,
                manifestBytes: Int = 8 * 1_048_576, frameBytes: Int = 8 * 1_048_576) {
        self.rollingBytes = rollingBytes; self.savedBytes = savedBytes
        self.manifestBytes = manifestBytes; self.frameBytes = frameBytes
    }
}
