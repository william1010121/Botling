import Foundation

/// The chat history and settings (model, routines), kept per bot under `~/.claudecodebot`. The bot's own
/// memory lives only in memory.md; this is just what the app shows and schedules.
public struct BotStore: Sendable {
    private static let historyLimit = 500
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    private var chatURL: URL { directory.appending(path: "chat.json") }
    private var settingsURL: URL { directory.appending(path: "bot.json") }
    private var subagentsURL: URL { directory.appending(path: "subagents.json") }

    private struct Settings: Codable {
        var model: BotModel?
        /// Routines from before they moved to routines.cron; read once to carry them over.
        var routines: [LegacyRoutine]?
        /// When each routines.cron job last ran, by job id.
        var routineRuns: [String: Date]?
        /// Tools you said it may always use.
        var alwaysAllowed: [String]?
        /// Lines the user has not looked at yet.
        var unread: Int?
    }

    private struct LegacyRoutine: Codable {
        var title: String
        var instruction: String
        var hour: Int
        var minute: Int
        var enabled: Bool
    }

    public func loadMessages() -> [ChatMessage] {
        guard let data = try? Data(contentsOf: chatURL) else { return [] }
        return (try? JSONDecoder().decode([ChatMessage].self, from: data)) ?? []
    }

    public func save(messages: [ChatMessage]) {
        write(Array(messages.suffix(Self.historyLimit)), to: chatURL)
    }

    /// The subagents it sent off, with everything they did.
    public func loadSubagents() -> [Subagent] {
        guard let data = try? Data(contentsOf: subagentsURL) else { return [] }
        return (try? JSONDecoder().decode([Subagent].self, from: data)) ?? []
    }

    public func save(subagents: [Subagent]) {
        write(subagents, to: subagentsURL)
    }

    public func loadModel() -> BotModel? {
        loadSettings().model
    }

    public func save(model: BotModel) {
        var settings = loadSettings()
        settings.model = model
        write(settings, to: settingsURL)
    }

    /// Routines saved the old way, as routines.cron lines; nil if there were none.
    public func legacyRoutineLines() -> [String]? {
        loadSettings().routines?.map { routine in
            let pause = routine.enabled ? "" : "#"
            // The old daily summary had no written task; give it the one the new file uses.
            // Older builds saved its title in Chinese; the literal below matches that saved data.
            if routine.title == "每日摘要", routine.instruction.isEmpty, routine.hour == 8, routine.minute == 15 {
                return pause + RoutineFile.dailySummary
            }
            let task = routine.instruction.isEmpty ? routine.title : "\(routine.title): \(routine.instruction)"
            return pause + "\(routine.minute) \(routine.hour) * * * \(task)"
        }
    }

    public func loadAlwaysAllowed() -> [String] {
        loadSettings().alwaysAllowed ?? []
    }

    public func save(alwaysAllowed: [String]) {
        var settings = loadSettings()
        settings.alwaysAllowed = alwaysAllowed
        write(settings, to: settingsURL)
    }

    public func loadUnread() -> Int {
        loadSettings().unread ?? 0
    }

    public func save(unread: Int) {
        var settings = loadSettings()
        settings.unread = unread
        write(settings, to: settingsURL)
    }

    public func loadRoutineRuns() -> [String: Date] {
        loadSettings().routineRuns ?? [:]
    }

    public func save(routineRuns: [String: Date]) {
        var settings = loadSettings()
        settings.routineRuns = routineRuns
        write(settings, to: settingsURL)
    }

    private func loadSettings() -> Settings {
        guard let data = try? Data(contentsOf: settingsURL) else { return Settings() }
        return (try? JSONDecoder().decode(Settings.self, from: data)) ?? Settings()
    }

    private func write(_ value: some Encodable, to url: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
