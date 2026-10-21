import Foundation

/// How much of one subscription limit is used, as `claude` last reported it.
public struct RateLimitWindow: Codable, Equatable, Sendable {
    /// 0…1 (the API's `utilization`).
    public var used: Double
    /// When the window starts over; nil if it was not said.
    public var resetsAt: Date?
    /// When this reading came in.
    public var seen: Date

    public init(used: Double, resetsAt: Date?, seen: Date) {
        self.used = used
        self.resetsAt = resetsAt
        self.seen = seen
    }

    /// The window started over since this reading, so its number no longer holds.
    public func hasReset(at now: Date) -> Bool {
        resetsAt.map { $0 <= now } ?? false
    }
}

/// The Claude subscription's 5-hour and weekly limits, from the `rate_limit_event` lines
/// `claude` writes in stream-json. Only subscription accounts get them, so with an API key
/// both stay nil. The latest value of each is kept in `~/.claudecodebot/rate-limits.json`.
public struct RateLimits: Codable, Equatable, Sendable {
    public var fiveHour: RateLimitWindow?
    public var week: RateLimitWindow?

    public init(fiveHour: RateLimitWindow? = nil, week: RateLimitWindow? = nil) {
        self.fiveHour = fiveHour
        self.week = week
    }

    public var isEmpty: Bool { fiveHour == nil && week == nil }

    /// Readings older than this get an "as of" note.
    public static let staleAfter: TimeInterval = 10 * 60

    /// When the older shown reading came in, if that is long enough ago to say so.
    public func staleSince(now: Date) -> Date? {
        let oldest = [fiveHour, week].compactMap { $0?.seen }.min()
        guard let oldest, now.timeIntervalSince(oldest) >= Self.staleAfter else { return nil }
        return oldest
    }

    /// Takes the windows a new event reports; the others keep their last value.
    public mutating func merge(_ other: RateLimits) {
        if let window = other.fiveHour { fiveHour = window }
        if let window = other.week { week = window }
    }

    static func load(from url: URL) -> RateLimits {
        guard let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(RateLimits.self, from: data) else { return RateLimits() }
        return saved
    }

    func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":…,
    /// "rateLimitType":"five_hour","utilization":0.47,"unifiedWindows":{"five_hour":
    /// {"utilization":0.47,"resetsAt":…},"seven_day":{…}}}}`. `unifiedWindows` carries both
    /// limits; older lines only name one (`rateLimitType`), sometimes without `utilization`
    /// (then only a "rejected" status says anything: the limit is used up).
    static func parse(_ object: [String: Any], seen: Date) -> RateLimits? {
        guard object["type"] as? String == "rate_limit_event",
              let info = object["rate_limit_info"] as? [String: Any] else { return nil }
        func date(_ value: Any?) -> Date? {
            (value as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
        }
        func window(_ entry: [String: Any]?) -> RateLimitWindow? {
            guard let entry, let used = (entry["utilization"] as? NSNumber)?.doubleValue else { return nil }
            return RateLimitWindow(used: min(max(used, 0), 1), resetsAt: date(entry["resetsAt"]), seen: seen)
        }
        var limits = RateLimits()
        if let windows = info["unifiedWindows"] as? [String: Any] {
            limits.fiveHour = window(windows["five_hour"] as? [String: Any])
            limits.week = window(windows["seven_day"] as? [String: Any])
        }
        var named = info
        if named["utilization"] == nil, info["status"] as? String == "rejected" { named["utilization"] = 1.0 }
        switch info["rateLimitType"] as? String {
        case "five_hour": if limits.fiveHour == nil { limits.fiveHour = window(named) }
        case "seven_day": if limits.week == nil { limits.week = window(named) }
        default: break
        }
        return limits.isEmpty ? nil : limits
    }
}

/// The words around the usage rings in the gear popover.
public enum RateLimitText {
    /// "42%", or "–" once the window has started over (what is used since is not known yet).
    public static func percent(_ window: RateLimitWindow, now: Date) -> String {
        window.hasReset(at: now) ? "–" : "\(Int((window.used * 100).rounded()))%"
    }

    /// The 5-hour window: "in 2h 13m", "in 8m".
    public static func countdown(_ window: RateLimitWindow, now: Date) -> String {
        guard let reset = window.resetsAt else { return "" }
        if reset <= now { return L("reset") }
        let minutes = max(1, Int((reset.timeIntervalSince(now) / 60).rounded(.up)))
        return minutes >= 60 ? L("in {0}h {1}m", minutes / 60, minutes % 60) : L("in {0}m", minutes)
    }

    /// The weekly window: "Thu 9:00 AM" (a time today: "9:00 PM").
    public static func resetDay(_ window: RateLimitWindow, now: Date, calendar: Calendar = .current, locale: Locale = L10n.language == .english ? .current : Locale(identifier: L10n.language.rawValue)) -> String {
        guard let reset = window.resetsAt else { return "" }
        if reset <= now { return L("reset") }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate(calendar.isDate(reset, inSameDayAs: now) ? "jmm" : "EEEjmm")
        return formatter.string(from: reset)
    }

    /// "as of 25 min ago", "as of 3 h ago", "as of 2 days ago".
    public static func asOf(_ date: Date, now: Date) -> String {
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        switch minutes {
        case ..<60: return L("as of {0} min ago", minutes)
        case ..<(48 * 60): return L("as of {0} h ago", minutes / 60)
        default: return L("as of {0} days ago", minutes / (24 * 60))
        }
    }
}
