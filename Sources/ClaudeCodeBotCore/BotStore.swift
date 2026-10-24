import Foundation

/// The chat history and settings (model, routines), kept per bot under `~/.claudecodebot`. The bot's own
/// memory lives only in memory.md; this is just what the app shows and schedules.
public struct BotStore: Sendable {
    static let historyLimit = 500
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// The files that hold a bot's chat as it shows: its lines, its subagents, its pins and its
    /// specs (its settings, bot.json, are not the chat).
    public enum ChatFile: String, CaseIterable, Sendable {
        case chat = "chat.json", subagents = "subagents.json", pins = "pins.json", specs = "specs.json"
    }

    private func url(_ file: ChatFile) -> URL { directory.appending(path: file.rawValue) }
    private var chatURL: URL { url(.chat) }
    private var settingsURL: URL { directory.appending(path: "bot.json") }
    private var subagentsURL: URL { url(.subagents) }
    private var pinsURL: URL { url(.pins) }
    private var specsURL: URL { url(.specs) }

    /// Whether it has a chat at all.
    public var hasChat: Bool { FileManager.default.fileExists(atPath: chatURL.path) }

    /// Copies its chat (every `ChatFile` it has) into `other`, to look at it without touching it.
    public func copyChat(to other: BotStore) {
        try? FileManager.default.createDirectory(at: other.directory, withIntermediateDirectories: true)
        for file in ChatFile.allCases {
            try? FileManager.default.removeItem(at: other.url(file))
            try? FileManager.default.copyItem(at: url(file), to: other.url(file))
        }
    }

    /// Puts `source` in place of its pins (`--pins file.json`).
    public func replacePins(with source: URL) {
        try? FileManager.default.removeItem(at: pinsURL)
        try? FileManager.default.copyItem(at: source, to: pinsURL)
    }

    private struct Settings: Codable {
        var model: BotModel?
        /// The model its subagents use and how hard it thinks; kept as text so a value this
        /// build does not know leaves the rest of the file readable. Missing: the defaults.
        var subagentModel: String?
        var effort: String?
        /// What its app-managed Codex workers start on; missing: follow the coordinator and
        /// Codex's config. Unknown values inside read as unset.
        var codexWorkers: CodexWorkerDefaults?
        /// The CLI it runs on, as text like the two above; missing: Claude.
        var engine: String?
        /// Its heads (engines, who messages go to); missing: one, `engine`.
        var heads: HeadsSettings?
        /// Routines from before they moved to routines.cron; read once to carry them over.
        var routines: [LegacyRoutine]?
        /// When each routines.cron job last ran, by job id.
        var routineRuns: [String: Date]?
        /// Tools you said it may always use.
        var alwaysAllowed: [String]?
        /// The components it has from the shared library; nil until first given (1.9).
        var components: [String]?
        /// Lines the user has not looked at yet.
        var unread: Int?
        /// The Codex review settings of 1.14 and before: nothing reads them now, but they stay
        /// in bot.json as written.
        var codex: JSONValue?
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
        return ((try? JSONDecoder().decode([ChatMessage].self, from: data)) ?? []).map(\.withShowTagsTakenOut)
    }

    public func save(messages: [ChatMessage]) {
        write(Array(messages.suffix(Self.historyLimit)), to: chatURL)
    }

    /// Reaction edits must report disk failure before publishing a successful UI state.
    public func saveReactionMessages(_ messages: [ChatMessage]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(Array(messages.suffix(Self.historyLimit))).write(to: chatURL, options: .atomic)
    }

    /// A decision claim must reach disk before it can dispatch an answer.
    public func saveDecisionMessages(_ messages: [ChatMessage]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(Array(messages.suffix(Self.historyLimit))).write(to: chatURL, options: .atomic)
    }

    /// The subagents it sent off, with everything they did.
    public func loadSubagents() -> [Subagent] {
        guard let data = try? Data(contentsOf: subagentsURL) else { return [] }
        return (try? JSONDecoder().decode([Subagent].self, from: data)) ?? []
    }

    public func save(subagents: [Subagent]) {
        write(subagents, to: subagentsURL)
    }

    /// The components pinned to it (its chips and Board), in order.
    public func loadPins() -> [PinnedComponent] {
        guard let data = try? Data(contentsOf: pinsURL) else { return [] }
        return (try? JSONDecoder().decode([PinnedComponent].self, from: data)) ?? []
    }

    public func save(pins: [PinnedComponent]) {
        write(pins, to: pinsURL)
    }

    /// Components being made from its replies (the chips under them), oldest first.
    public func loadSpecs() -> [ComponentSpec] {
        guard let data = try? Data(contentsOf: specsURL) else { return [] }
        return (try? JSONDecoder().decode([ComponentSpec].self, from: data)) ?? []
    }

    public func save(specs: [ComponentSpec]) {
        write(specs, to: specsURL)
    }

    public func loadModel() -> BotModel? {
        loadSettings().model
    }

    public func save(model: BotModel) {
        var settings = loadSettings()
        settings.model = model
        write(settings, to: settingsURL)
    }

    /// The model its subagents use; nil: the same as its own.
    public func loadSubagentModel() -> BotModel? {
        loadSettings().subagentModel.flatMap(BotModel.init(rawValue:))
    }

    public func save(subagentModel: BotModel?) {
        var settings = loadSettings()
        settings.subagentModel = subagentModel?.rawValue
        write(settings, to: settingsURL)
    }

    /// What its Codex workers start on; unset values follow the bot and Codex's config.
    public func loadCodexWorkerDefaults() -> CodexWorkerDefaults {
        loadSettings().codexWorkers ?? CodexWorkerDefaults()
    }

    public func save(codexWorkerDefaults: CodexWorkerDefaults) {
        var settings = loadSettings()
        settings.codexWorkers = codexWorkerDefaults == CodexWorkerDefaults() ? nil : codexWorkerDefaults
        write(settings, to: settingsURL)
    }

    /// How hard it thinks; nil: the model's default.
    public func loadEffort() -> EffortLevel? {
        loadSettings().effort.flatMap(EffortLevel.init(rawValue:))
    }

    public func save(effort: EffortLevel?) {
        var settings = loadSettings()
        settings.effort = effort?.rawValue
        write(settings, to: settingsURL)
    }

    /// The CLI it runs on; nil: never chosen (Claude).
    public func loadEngine() -> BotEngine? {
        loadSettings().engine.flatMap(BotEngine.init(rawValue:))
    }

    public func save(engine: BotEngine) {
        var settings = loadSettings()
        settings.engine = engine.rawValue
        write(settings, to: settingsURL)
    }

    public func loadHeads() -> HeadsSettings? {
        loadSettings().heads
    }

    public func save(heads: HeadsSettings) {
        var settings = loadSettings()
        settings.heads = heads
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

    /// The components it has (full usage in its briefing); nil: never set, see
    /// `Workspace.giveFirstComponents`.
    public func loadComponentList() -> [String]? {
        loadSettings().components
    }

    public func save(componentList: [String]) {
        var settings = loadSettings()
        settings.components = componentList
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
