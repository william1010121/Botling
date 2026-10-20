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
    /// "Waiting on you" items you chose to ignore, by `Workspace.Waiting.id`. Optional so a
    /// settings file from before it still loads.
    public var ignoredWaiting: [String]?

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

/// Tokens one turn used, from the `usage` on `claude`'s result line (per turn, unlike the cost).
public struct TokenUsage: Codable, Equatable, Sendable {
    public var input = 0
    public var output = 0
    /// Prompt written to the cache, and read back from it.
    public var cacheWrite = 0
    public var cacheRead = 0

    public init(input: Int = 0, output: Int = 0, cacheWrite: Int = 0, cacheRead: Int = 0) {
        self.input = input
        self.output = output
        self.cacheWrite = cacheWrite
        self.cacheRead = cacheRead
    }

    public var total: Int { input + output + cacheWrite + cacheRead }

    public static func + (a: TokenUsage, b: TokenUsage) -> TokenUsage {
        TokenUsage(input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead)
    }

    public static func += (a: inout TokenUsage, b: TokenUsage) { a = a + b }
}

/// One past day's totals, for the usage page.
public struct DayTotal: Codable, Equatable, Sendable {
    public var day: String
    public var spent: Double
    public var tokens: TokenUsage
}

/// What the bots spent today, from the cost `claude` reports with each turn, in
/// `~/.claudecodebot/spending.json`. A new day starts from zero; the days before are kept as
/// totals (the last 30).
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
    /// Tokens used today, in all and by bot name.
    public var tokens = TokenUsage()
    public var tokensByBot: [String: TokenUsage] = [:]
    /// Earlier days, oldest first.
    public var history: [DayTotal] = []

    static let historyDays = 30

    public init(day: String, spent: Double = 0, allowance: Double = 0, byBot: [String: Double] = [:], warned: Bool = false) {
        self.day = day
        self.spent = spent
        self.allowance = allowance
        self.byBot = byBot
        self.warned = warned
    }

    private enum CodingKeys: String, CodingKey { case day, spent, allowance, byBot, warned, tokens, tokensByBot, history }

    // A file from before tokens were counted still loads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decode(String.self, forKey: .day)
        spent = try c.decode(Double.self, forKey: .spent)
        allowance = try c.decode(Double.self, forKey: .allowance)
        byBot = try c.decode([String: Double].self, forKey: .byBot)
        warned = try c.decode(Bool.self, forKey: .warned)
        tokens = try c.decodeIfPresent(TokenUsage.self, forKey: .tokens) ?? TokenUsage()
        tokensByBot = try c.decodeIfPresent([String: TokenUsage].self, forKey: .tokensByBot) ?? [:]
        history = try c.decodeIfPresent([DayTotal].self, forKey: .history) ?? []
    }

    /// A fresh `day`, with this one's totals moved into the history.
    func rolled(to day: String) -> Spending {
        var next = Spending(day: day)
        next.history = history
        if spent > 0 || tokens.total > 0 { next.history.append(DayTotal(day: self.day, spent: spent, tokens: tokens)) }
        next.history = Array(next.history.suffix(Self.historyDays))
        return next
    }

    public static func today(_ date: Date = Date()) -> String {
        date.formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits)", timeZone: .current, calendar: .current))
    }

    /// This day's record: the saved one if it is today's, else a fresh one.
    static func load(from url: URL, on date: Date = Date()) -> Spending {
        let day = today(date)
        guard let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(Spending.self, from: data) else { return Spending(day: day) }
        return saved.day == day ? saved : saved.rolled(to: day)
    }

    func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Adds what a bot spent, starting a new day first if the date moved on.
    mutating func add(_ amount: Double, tokens used: TokenUsage = TokenUsage(), by bot: String, on date: Date = Date()) {
        let day = Self.today(date)
        if day != self.day { self = rolled(to: day) }
        if used.total > 0 {
            tokens += used
            tokensByBot[bot, default: TokenUsage()] += used
        }
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
