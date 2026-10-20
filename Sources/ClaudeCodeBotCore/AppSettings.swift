import Foundation

/// ClaudeCodeBot's own settings, in `~/.claudecodebot/settings.json`.
public struct AppSettings: Codable, Equatable, Sendable {
    /// What the bots may spend in a day, in US dollars; nil for no limit. Only work nobody typed
    /// waits when it is used up (routines, handed-over work, teams); your own messages never do.
    public var dailyBudget: Double?
    /// For working on ClaudeCodeBot itself: off for everyone else.
    public var developerMode = false
    /// The project whose folder is ClaudeCodeBot's own source (developer mode only).
    public var developerProjectID: UUID?

    public init(dailyBudget: Double? = nil, developerMode: Bool = false, developerProjectID: UUID? = nil) {
        self.dailyBudget = dailyBudget
        self.developerMode = developerMode
        self.developerProjectID = developerProjectID
    }

    static func load(from url: URL) -> AppSettings {
        guard let data = try? Data(contentsOf: url) else { return AppSettings() }
        return (try? JSONDecoder().decode(AppSettings.self, from: data)) ?? AppSettings()
    }

    func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

/// What the bots spent today, from the cost `claude` reports with each turn, in
/// `~/.claudecodebot/spending.json`. A new day starts from zero.
public struct Spending: Codable, Equatable, Sendable {
    /// "2026-10-20", in the local time zone.
    public var day: String
    public var spent: Double
    /// Extra you allowed today on top of the budget.
    public var allowance: Double
    /// Spent today, by bot name.
    public var byBot: [String: Double]
    /// The "budget reached" card was shown today.
    public var warned: Bool

    public init(day: String, spent: Double = 0, allowance: Double = 0, byBot: [String: Double] = [:], warned: Bool = false) {
        self.day = day
        self.spent = spent
        self.allowance = allowance
        self.byBot = byBot
        self.warned = warned
    }

    public static func today(_ date: Date = Date()) -> String {
        date.formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits)", timeZone: .current, calendar: .current))
    }

    /// This day's record: the saved one if it is today's, else a fresh one.
    static func load(from url: URL, on date: Date = Date()) -> Spending {
        let day = today(date)
        guard let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(Spending.self, from: data),
              saved.day == day else { return Spending(day: day) }
        return saved
    }

    func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Adds what a bot spent, starting a new day first if the date moved on.
    mutating func add(_ amount: Double, by bot: String, on date: Date = Date()) {
        let day = Self.today(date)
        if day != self.day { self = Spending(day: day) }
        guard amount > 0 else { return }
        spent += amount
        byBot[bot, default: 0] += amount
    }

    /// Used up: work nobody typed waits.
    func isOver(_ budget: Double?) -> Bool {
        guard let budget, budget > 0 else { return false }
        return spent >= budget + allowance
    }
}
