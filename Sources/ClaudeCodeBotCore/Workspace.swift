import Combine
import Foundation

/// The main bot plus one manager per project folder, and the wiring between them: the main bot
/// reads managers' memory.md for status and hands work over through their inbox.md.
@MainActor
public final class Workspace: ObservableObject {
    public struct Project: Codable, Identifiable, Equatable, Sendable {
        public var id: UUID
        public var name: String
        public var folder: URL
        /// An `AvatarKind` raw value.
        public var avatar: String
        /// Set for a bot of its own (its folder is under `~/.claudecodebot/bots/`): what it is for.
        public var job: String?
        /// The plugin that made it, for a bot a plugin made.
        public var plugin: String?

        public init(id: UUID, name: String, folder: URL, avatar: String, job: String? = nil, plugin: String? = nil) {
            self.id = id
            self.name = name
            self.folder = folder
            self.avatar = avatar
            self.job = job
            self.plugin = plugin
        }

        /// A bot of its own rather than a project folder's manager.
        public var isBot: Bool { job != nil }

        public var notesFolder: URL { folder.appending(path: ".bot") }
        public var inboxURL: URL { notesFolder.appending(path: "inbox.md") }
        /// Maintainer, the built-in project whose folder is the plugin library.
        public var isMaintainer: Bool { id == Workspace.maintainerID }
    }

    /// Maintainer's fixed id: its chat survives restarts, and it is never saved in projects.json.
    public static let maintainerID = UUID(uuidString: "DEC0DE00-0000-4000-8000-00000000DEC0")!

    /// Something a manager needs the user to decide: an open question in its chat, or else a
    /// line from its memory.md "Waiting on you" section.
    public struct Waiting: Identifiable, Equatable, Sendable {
        public var id: String { "\(projectID)-\(text)" }
        public var projectID: UUID
        public var text: String
        /// The question in the manager's chat, when there is one to answer with a button.
        public var messageID: UUID?

        public init(projectID: UUID, text: String, messageID: UUID? = nil) {
            self.projectID = projectID
            self.text = text
            self.messageID = messageID
        }
    }

    public typealias BotFactory = @MainActor (BotProfile, BotStore) -> Bot

    /// Shapes handed out to new projects, in order; the main bot is the circle.
    static let avatars = ["square", "triangle", "hexagon", "star", "diamond", "clover", "heart", "drop",
                          "pentagon", "cloud", "octagon", "moon", "pill", "ghost", "burst"]

    @Published public private(set) var projects: [Project] = []
    /// nil = the main bot.
    @Published public private(set) var selection: UUID?
    @Published public private(set) var waiting: [Waiting] = []
    /// A result page open in the widened right column.
    @Published public var openResult: Chip?
    /// Temporary teams at work right now.
    @Published public private(set) var runningTeams: [TeamRun] = []
    public private(set) var teams: [TeamSpec] = []

    public let mainBot: Bot
    /// Maintainer's project (the plugin library); not in `projects`, which are the user's own.
    public let maintainerProject: Project
    /// The plugin library's git (made a repo on first need, see `prepareLibrary`).
    private let libraryGit: PluginLibraryGit
    private var libraryTask: Task<Void, Never>?

    /// The plugin library as a git repo with everything committed; done when this finishes.
    public var pluginLibraryReady: Task<Void, Never> { prepareLibrary() }

    /// Makes the plugin library a git repo, once, in the background. The app does it at launch;
    /// handing work to Maintainer and installing a plugin do it first too.
    @discardableResult
    public func prepareLibrary() -> Task<Void, Never> {
        if let libraryTask { return libraryTask }
        let git = libraryGit
        let components = components
        let task = Task {
            await blocking { git.prepare() }
            components.forgetHistory()
        }
        libraryTask = task
        return task
    }
    public private(set) var managers: [UUID: Bot] = [:]
    public let components: ComponentLibrary
    /// Plugins for ClaudeCodeBot itself: `~/.claudecodebot/plugins/` and the ones shipped with the app.
    public let plugins: PluginRegistry
    /// Runs plugins' program parts (Node), when a script for it was given.
    public let pluginHost: PluginHostClient?
    private let root: URL
    private let makeBot: BotFactory
    /// Starts processes that are not bots: temporary teams and the component team.
    private let launcher: AgentLauncher
    private var subscriptions: Set<AnyCancellable> = []

    /// `root` is `~/.claudecodebot`: the main bot's home, each manager's chat, the project list and the
    /// plugin library. `builtInPlugins` is the folder of plugins shipped inside the app.
    public init(
        root: URL,
        builtInPlugins: URL? = nil,
        pluginHostScript: URL? = nil,
        locateNode: @escaping () -> URL? = { ClaudeExecutableLocator(command: "node").locate() },
        validateClaudePart: ((URL) async -> String?)? = nil,
        checkCommand: String? = nil,
        gitForPlugins: PluginLibraryGit? = nil,
        secrets: SecretStore = KeychainSecretStore(),
        launcher: @escaping AgentLauncher = { _ in throw CocoaError(.featureUnsupported) },
        makeBot: @escaping BotFactory
    ) {
        self.root = root
        self.makeBot = makeBot
        self.launcher = launcher
        let library = root.appending(path: "plugins")
        Self.migrateFromDeck(library: library, root: root)
        let componentFolder = Self.prepareComponentPlugin(in: library, movingFrom: root.appending(path: "components"))
        Self.prepareTeamsPlugin(in: library, movingFrom: root.appending(path: "teams"))
        Self.prepareCorePlugin(in: library)
        Self.writeLibraryGuide(in: library, builtIns: builtInPlugins)
        let git = gitForPlugins ?? PluginLibraryGit(folder: library)
        libraryGit = git
        maintainerProject = Project(id: Self.maintainerID, name: "Maintainer", folder: library, avatar: "diamond")
        plugins = PluginRegistry(library: library, builtIns: builtInPlugins, validateClaudePart: validateClaudePart, git: git, secrets: secrets)
        pluginHost = pluginHostScript.map { PluginHostClient(script: $0, locateNode: locateNode) }
        components = ComponentLibrary(folder: componentFolder)
        components.git = git.isAvailable ? git : nil
        self.checkCommand = checkCommand
        let mainHome = root.appending(path: "main")
        try? FileManager.default.createDirectory(at: mainHome, withIntermediateDirectories: true)
        mainBot = makeBot(.main(home: mainHome), BotStore(directory: mainHome))
        mainBot.wakeNote = { [weak self] in self?.projectBriefing() ?? "" }
        mainBot.extraDirectories = { [weak self] in self?.everyProject.map(\.notesFolder) ?? [] }
        giveClaudeParts(to: mainBot)
        mainBot.onReply = { [weak self] _, _ in
            guard let self else { return }
            deliverInboxes()
            refreshWaiting()
            if selection == nil { mainBot.markRead() }
        }
        mainBot.onRequests = { [weak self] requests in self?.handle(requests, from: nil) }
        mainBot.onQuestion = { [weak self] _ in self?.refreshWaiting() }
        mainBot.onQuestionSettled = { [weak self] _ in self?.refreshWaiting() }
        teams = loadTeams()
        components.otherFolders = { [weak self] in
            (self?.plugins.componentFolders() ?? []).filter { $0.standardizedFileURL != componentFolder.standardizedFileURL }
        }
        components.rescan()
        components.onCatalogChanged = { [weak self] in
            guard let self else { return }
            let note = "(App: Components were updated; here is how to use them now.)\n" + componentBriefing()
            for bot in [mainBot] + Array(managers.values) { bot.queueNote(note) }
        }
        plugins.onNotice = { [weak self] text in
            self?.mainBot.notice(text)
            if self?.selection == nil { self?.mainBot.markRead() }
        }
        plugins.onBroken = { [weak self] plugin, problem in
            self?.handToMaintainer("(App: Hot-update check) The plugin \"\(plugin)\" is broken; ClaudeCodeBot fell back to the previous version or disabled it for now. Please fix it: \(problem)")
        }
        plugins.onUpdated = { [weak self] plugin, old in
            guard let self else { return }
            mainBot.notice("Plugin \"\(plugin.manifest.title)\" updated: \(old) → \(plugin.manifest.version)")
            if selection == nil { mainBot.markRead() }
        }
        connectPlugins(to: mainBot)
        startPluginHost()
        followClaudeParts()
        prepareNotesFolder(for: maintainerProject)
        approvedFolders = loadApprovedFolders()
        removedPluginBots = Set((try? Data(contentsOf: root.appending(path: "removed-bots.json")))
            .flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? [])
        attach(maintainerProject)
        maintainer.extraDirectories = { [weak self] in self?.approvedFolders ?? [] }
        for project in loadProjects() where !project.isMaintainer {
            attach(project)
        }
        refreshWaiting()
    }

    /// The user's projects and Maintainer.
    var everyProject: [Project] { projects + [maintainerProject] }

    /// How Maintainer runs `ccb plugin check` (the ClaudeCodeBot binary with --check-plugin).
    private let checkCommand: String?

    // MARK: Installing plugins from outside

    /// Fetched plugins waiting for your "Install", by the question's message id.
    private var installQuestions: [UUID: InstallProposal] = [:]
    /// Sources being fetched right now (Settings shows them).
    @Published public private(set) var fetching: [String] = []

    /// Fetches a plugin, checks it, and asks you before installing it. A folder you picked
    /// yourself (`trusted`) is installed without asking. Returns what went wrong, if anything.
    @discardableResult
    public func proposeInstall(_ source: String, trusted: Bool = false) async -> String? {
        let source = source.trimmingCharacters(in: .whitespacesAndNewlines)
        fetching.append(source)
        defer { fetching.removeAll { $0 == source } }
        let proposal: InstallProposal
        do {
            proposal = try await PluginInstaller.fetch(source, scratch: root.appending(path: "install-staging"))
        } catch {
            mainBot.notice("Couldn't install \"\(source)\": \(error.localizedDescription)")
            return error.localizedDescription
        }
        guard proposal.problems.isEmpty else {
            let problem = proposal.problems.joined(separator: "; ")
            mainBot.notice("\"\(proposal.manifest.title)\" failed the checks and was not installed: \(problem)")
            return problem
        }
        if trusted {
            return await finishInstall(proposal)
        }
        mainBot.notice(
            proposal.summary,
            choices: [Choice(label: "Install", detail: nil, recommended: false), Choice(label: "Don't install", detail: nil, recommended: false)]
        )
        if let question = mainBot.messages.last { installQuestions[question.id] = proposal }
        if selection == nil { mainBot.markRead() }
        return nil
    }

    @discardableResult
    private func finishInstall(_ proposal: InstallProposal) async -> String? {
        await prepareLibrary().value
        let problem = await plugins.install(proposal)
        try? FileManager.default.removeItem(at: proposal.folder)
        if let problem {
            mainBot.notice("\"\(proposal.manifest.title)\" could not be installed: \(problem)")
        } else {
            mainBot.notice("Installed: \(proposal.manifest.title) \(proposal.manifest.version). You can turn it off or remove it under Plugins in Settings.")
        }
        if selection == nil { mainBot.markRead() }
        return problem
    }

    // MARK: Folders outside the library

    /// Folders you let Maintainer read (kept in `~/.claudecodebot/folders.json`).
    public private(set) var approvedFolders: [URL] = []
    /// Open "may it read this folder?" questions in the main chat, by message id.
    private var folderQuestions: [UUID: URL] = [:]
    private var foldersURL: URL { root.appending(path: "folders.json") }

    private func loadApprovedFolders() -> [URL] {
        guard let data = try? Data(contentsOf: foldersURL),
              let paths = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return paths.map { URL(filePath: $0) }
    }

    /// Maintainer asked to read `path`: ask you once (in the main chat); a folder you allowed
    /// before, or one inside it, is allowed at once.
    func requestFolder(_ path: String) {
        let folder = URL(filePath: (path as NSString).expandingTildeInPath).standardizedFileURL
        if approvedFolders.contains(where: { folder.path == $0.path || folder.path.hasPrefix($0.path + "/") }) {
            maintainer.relay("(App) \(folder.path) was already allowed before; you can read it directly.")
            return
        }
        mainBot.notice(
            "Maintainer wants to read \"\(folder.path)\". It will only read, never change files there. Allow it?",
            choices: [Choice(label: "Allow", detail: "Won't ask again", recommended: false), Choice(label: "Don't allow", detail: nil, recommended: false)],
            sourceID: Self.maintainerID
        )
        if let question = mainBot.messages.last { folderQuestions[question.id] = folder }
        if selection == nil { mainBot.markRead() }
        refreshWaiting()
    }

    /// Your answer to a folder question.
    private func answerFolder(_ folder: URL, allowed: Bool) {
        guard allowed else {
            maintainer.relay("(App) The user did not allow you to read \(folder.path). Find another way, or explain that it can't be done.")
            return
        }
        approvedFolders.append(folder)
        let data = try? JSONEncoder().encode(approvedFolders.map(\.path))
        try? data?.write(to: foldersURL, options: .atomic)
        let maintainer = maintainer
        Task {
            // A new session that can open it (--add-dir), then carry on.
            await maintainer.restart(divider: "Handoff → may read \(folder.lastPathComponent)")
            maintainer.relay("(App) The user agreed: you can now read \(folder.path) (read only, do not change files there). Carry on with what you were doing.")
        }
    }

    /// Maintainer's bot.
    public var maintainer: Bot {
        managers[Self.maintainerID]!
    }

    /// Gives Maintainer a job, the way the main bot hands work to a manager.
    public func handToMaintainer(_ text: String) {
        prepareLibrary()
        maintainer.relay(text)
    }

    public var selectedBot: Bot {
        selection.flatMap { managers[$0] } ?? mainBot
    }

    public func bot(for project: Project) -> Bot? {
        managers[project.id]
    }

    public func project(_ id: UUID) -> Project? {
        everyProject.first { $0.id == id }
    }

    public func select(_ projectID: UUID?) {
        selection = projectID
        selectedBot.markRead()
    }

    /// Makes `folder` a project with its own manager, or selects it if it already is one.
    @discardableResult
    public func addProject(folder: URL) -> Project {
        let folder = folder.standardizedFileURL
        if let existing = projects.first(where: { $0.folder.standardizedFileURL == folder }) {
            select(existing.id)
            return existing
        }
        let project = Project(id: UUID(), name: folder.lastPathComponent, folder: folder, avatar: nextAvatar())
        prepareNotesFolder(for: project)
        attach(project)
        saveProjects()
        select(project.id)
        return project
    }

    /// The first shape no project or bot has yet.
    private func nextAvatar() -> String {
        let used = Set(projects.map(\.avatar))
        return Self.avatars.first { !used.contains($0) } ?? Self.avatars[projects.count % Self.avatars.count]
    }

    // MARK: Bots of their own

    /// Bots of their own (not project managers), in the order they were made.
    public var standaloneBots: [Project] { projects.filter(\.isBot) }

    /// Makes a bot of its own: a folder under `~/.claudecodebot/bots/`, a row in the left column, and
    /// its own memory, inbox and routines like a manager. A bot with the same name (ignoring case)
    /// is returned as it is, so asking twice does not make two. `setUp` sends it its job at once,
    /// so it introduces itself and writes its routines; a plugin that adds the routines itself
    /// leaves it asleep. Nil when the name or the job is empty.
    @discardableResult
    public func createBot(name: String, job: String, avatar: String? = nil, setUp: Bool = false, by creator: String? = nil) -> Project? {
        switch makeBot(name: name, job: job, avatar: avatar, setUp: setUp, by: creator) {
        case let .made(project), let .existing(project): project
        case .empty, .taken, .removedByUser: nil
        }
    }

    /// What asking for a bot came to.
    public enum BotMaking: Equatable {
        case made(Project)
        /// One by that name was there already (for a plugin: one it made itself).
        case existing(Project)
        /// Its name or job is empty.
        case empty
        /// A plugin asked for a name another plugin or you already use.
        case taken
        /// You removed the bot this plugin made before; it is not made again.
        case removedByUser
    }

    /// `plugin` is the plugin asking, nil for you or a bot. A plugin gets back only a bot it made
    /// itself, and never one you removed.
    func makeBot(name: String, job: String, avatar: String? = nil, setUp: Bool = false, by creator: String? = nil, plugin: String? = nil) -> BotMaking {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let job = job.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !job.isEmpty else { return .empty }
        if let existing = standaloneBots.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            return plugin == nil || existing.plugin == plugin ? .existing(existing) : .taken
        }
        if let plugin, removedPluginBots.contains(Self.removalKey(plugin: plugin, name: name)) { return .removedByUser }
        let id = UUID()
        let folder = root.appending(path: "bots/\(id.uuidString)")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let shape = avatar.flatMap { Self.avatars.contains($0) ? $0 : nil } ?? nextAvatar()
        let project = Project(id: id, name: name, folder: folder, avatar: shape, job: job, plugin: plugin)
        prepareNotesFolder(for: project)
        attach(project)
        saveProjects()
        mainBot.notice("New bot \"\(name)\"\(creator.map { " (made by \($0))" } ?? ""): \(Self.firstLine(of: job))", sourceID: id)
        if selection == nil { mainBot.markRead() }
        briefAwakeMainBot()
        if setUp {
            managers[id]?.relay("""
            (App) You were just created. Your job: \(job)
            If it should happen at fixed times, add those jobs to your routines file now; if it is a report, also do the first one now. Then introduce yourself to the user in one sentence.
            """)
        }
        return .made(project)
    }

    /// An awake main bot hears about bots made or removed with its next message.
    private func briefAwakeMainBot() {
        mainBot.queueNote("(App: The list of projects and bots changed.)\n" + projectBriefing())
    }

    /// Bots plugins made that you removed (`plugin/name`, lowercased), kept so they stay removed.
    private var removedPluginBots: Set<String> = []
    private var removedBotsURL: URL { root.appending(path: "removed-bots.json") }

    static func removalKey(plugin: String, name: String) -> String {
        "\(plugin)/\(name)".lowercased()
    }

    /// Takes a bot of its own out of the left column and stops it. Its folder (memory, results)
    /// stays on disk under `~/.claudecodebot/bots/`.
    public func removeBot(_ id: UUID) {
        guard let project = projects.first(where: { $0.id == id && $0.isBot }) else { return }
        managers[id]?.stop()
        managers[id] = nil
        projects.removeAll { $0.id == id }
        if selection == id { select(nil) }
        saveProjects()
        if let plugin = project.plugin {
            removedPluginBots.insert(Self.removalKey(plugin: plugin, name: project.name))
            try? JSONEncoder().encode(removedPluginBots.sorted()).write(to: removedBotsURL, options: .atomic)
        }
        // Its questions in the main chat can no longer be answered.
        for notice in mainBot.messages where notice.role == .notice && notice.sourceID == id && notice.isOpenQuestion {
            mainBot.markAnswered(Bot.noLongerNeeded, in: notice.id)
        }
        briefAwakeMainBot()
        refreshWaiting()
        mainBot.notice("Removed the bot \"\(project.name)\". Its folder stays at \(project.folder.path).")
        if selection == nil { mainBot.markRead() }
    }

    // MARK: Routines

    private var routineTask: Task<Void, Never>?

    /// Checks every `interval` seconds for routines whose time has come. Checking a wall-clock
    /// time (rather than sleeping until it) survives the Mac sleeping, and a time missed while
    /// ClaudeCodeBot was closed still runs once later that day.
    public func startRoutines(every interval: TimeInterval = 30) {
        routineTask?.cancel()
        routineTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.checkRoutines()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    public func checkRoutines(now: Date = Date()) {
        for bot in [mainBot] + everyProject.compactMap({ managers[$0.id] }) {
            bot.reloadRoutines()
            for routine in bot.routines where bot.isDue(routine, at: now) {
                bot.run(routine, prompt: prompt(for: routine, of: bot), at: now)
            }
        }
    }

    func prompt(for routine: Routine, of bot: Bot) -> String {
        let ask = routine.file.map { "Open \($0) (relative to your working folder) and do what it says." } ?? routine.instruction
        switch bot.profile.role {
        case .main:
            return "(App: Time for the routine \"\(routine.title)\". \(ask))\n" + projectBriefing()
        case .manager:
            return "(App: Time for the routine \"\(routine.title)\": \(ask). When done, report the result in one sentence; if the user needs to decide something, attach a choices block.)"
        }
    }

    /// Lets every awake bot write memory.md before the app quits.
    public func putEveryoneToSleep() async {
        for bot in [mainBot] + Array(managers.values) {
            await bot.goToSleep()
        }
    }

    // MARK: Main bot ↔ managers

    /// The project list and the teams the main bot gets each time it wakes.
    func projectBriefing() -> String {
        let folders = projects.filter { !$0.isBot }
        let projectLines = folders.isEmpty
            ? "(No projects yet.)"
            : folders.map { project in
                "- \(project.name): memory file \(project.notesFolder.appending(path: "memory.md").path); inbox file \(project.inboxURL.path)"
            }.joined(separator: "\n")
        let bots = standaloneBots
        let botLines = bots.isEmpty ? "" : "\n(App: Bots of their own, which you reach the same way.)\n" + bots.map { bot in
            "- \(bot.name) (\(Self.firstLine(of: bot.job ?? ""))): memory file \(bot.notesFolder.appending(path: "memory.md").path); inbox file \(bot.inboxURL.path)"
        }.joined(separator: "\n")
        let maintainerLine = "- Maintainer (looks after ClaudeCodeBot itself: plugins, components): memory file \(maintainerProject.notesFolder.appending(path: "memory.md").path); inbox file \(maintainerProject.inboxURL.path)"
        let teamLines = teams.map { "- \($0.name) (\($0.title)): \($0.description)" }.joined(separator: "\n")
        return """
        (App: Project list. To check progress, read the memory file and do not wake the manager; to hand off work, append a line to the end of the inbox file.)
        \(projectLines)\(botLines)
        \(maintainerLine)
        (App: Temporary teams you can start, with <team name="name">task</team>.)
        \(teamLines)
        \(componentBriefing())
        """
    }

    /// A plugin library from when the app was called Deck: plugins named `deck-*` whose
    /// package.json has a `deck` field. Renamed to `ccb-*` with a `ccb` field, once, and committed.
    static func migrateFromDeck(library: URL, root: URL) {
        let files = FileManager.default
        var changed = false
        for folder in (try? files.contentsOfDirectory(at: library, includingPropertiesForKeys: nil)) ?? [] {
            let manifest = folder.appending(path: "package.json")
            if var text = try? String(contentsOf: manifest, encoding: .utf8), text.contains("\"deck\"") {
                text = text.replacingOccurrences(of: "\"deck\"", with: "\"ccb\"")
                    .replacingOccurrences(of: "\"name\": \"deck-", with: "\"name\": \"ccb-")
                try? Data(text.utf8).write(to: manifest)
                changed = true
            }
            let claude = folder.appending(path: "claude/.claude-plugin/plugin.json")
            if var text = try? String(contentsOf: claude, encoding: .utf8), text.contains("\"deck-") {
                text = text.replacingOccurrences(of: "\"name\": \"deck-", with: "\"name\": \"ccb-")
                try? Data(text.utf8).write(to: claude)
                changed = true
            }
            let name = folder.lastPathComponent
            if name.hasPrefix("deck-") {
                let renamed = library.appending(path: "ccb-" + name.dropFirst(5))
                if !files.fileExists(atPath: renamed.path) {
                    try? files.moveItem(at: folder, to: renamed)
                    changed = true
                }
            }
        }
        let oldGuide = library.appending(path: "DECK-PLUGINS.md")
        if files.fileExists(atPath: oldGuide.path) {
            try? files.removeItem(at: oldGuide)
            changed = true
        }
        let state = root.appending(path: "plugins.json")
        if let text = try? String(contentsOf: state, encoding: .utf8), text.contains("deck-") {
            try? Data(text.replacingOccurrences(of: "\"deck-", with: "\"ccb-").utf8).write(to: state)
        }
        guard changed, files.fileExists(atPath: library.appending(path: ".git").path) else { return }
        let git = PluginLibraryGit(folder: library)
        git.run(["add", "-A"])
        git.run(["commit", "-q", "-m", "Rename plugins for ClaudeCodeBot (deck-* → ccb-*)"])
    }

    /// The component library is the `ccb-components` plugin. Components from before plugins
    /// (`~/.claudecodebot/components`) move into it once.
    static func prepareComponentPlugin(in library: URL, movingFrom old: URL) -> URL {
        let plugin = library.appending(path: "ccb-components")
        let folder = plugin.appending(path: "components")
        let files = FileManager.default
        try? files.createDirectory(at: plugin, withIntermediateDirectories: true)
        if !files.fileExists(atPath: folder.path) {
            if files.fileExists(atPath: old.path) {
                try? files.moveItem(at: old, to: folder)
            } else {
                try? files.createDirectory(at: folder, withIntermediateDirectories: true)
            }
        }
        let manifest = plugin.appending(path: "package.json")
        if !files.fileExists(atPath: manifest.path) {
            let text = """
            {
              "name": "ccb-components",
              "displayName": "Component library",
              "version": "1.0.0",
              "description": "Components shown in the chat (choices and so on). One folder per component: template.html and about.md.",
              "license": "MIT",
              "engines": { "ccb": "^2.0.0" },
              "ccb": {
                "permissions": [],
                "contributes": { "components": "components" }
              }
            }

            """
            try? Data(text.utf8).write(to: manifest)
        }
        return folder
    }

    /// The components a bot can draw or ask to change.
    func componentBriefing() -> String {
        "(App: Components in the chat. <show name=\"name\">JSON</show> draws one; <component name=\"name\">request</component> asks Maintainer to change one.)\n" + components.catalog()
    }

    /// Someone asked for a component change: the user beside a component, or a bot with a
    /// <component> tag. Maintainer does it (or hands it to its component-editor agent).
    public func requestComponentChange(_ name: String, request: String, from asker: String) {
        let name = ComponentLibrary.safeName(name)
        guard !name.isEmpty else { return }
        components.markWorking(name, change: request)
        let exists = components.names.contains(name)
        handToMaintainer(exists
            ? "\(asker)'s request for the component \"\(name)\": \(request)"
            : "\(asker) wants a new component \"\(name)\": \(request)")
    }

    // MARK: Temporary teams

    /// Acts on the tags in a bot's reply. `project` is the manager that asked, nil for the main bot.
    func handle(_ requests: [BotRequest], from project: Project?) {
        for request in requests {
            switch request {
            case let .team(name, task):
                // Only the main bot pulls up teams; managers work in their own folder.
                if project == nil { startTeam(name, task: task) }
            case let .component(name, request):
                requestComponentChange(name, request: request, from: project?.name ?? mainBot.name)
            case let .install(source):
                Task { await proposeInstall(source) }
            case let .folder(path):
                if project?.isMaintainer == true { requestFolder(path) }
            case let .newBot(name, job):
                // The main bot makes bots when you ask it; Maintainer may too (while building one).
                if project == nil || project?.isMaintainer == true,
                   case let .existing(old) = makeBot(name: name, job: job, setUp: true, by: project?.name) {
                    mainBot.notice("There is already a bot called \"\(old.name)\"; nothing new was made. To change its job, tell it, or remove it from its menu first.", sourceID: old.id)
                }
            case let .plugin(request):
                if project?.isMaintainer != true {
                    handToMaintainer("\(project?.name ?? mainBot.name)'s request for ClaudeCodeBot: \(request)")
                }
            }
        }
    }

    /// Pulls up a team in a fresh folder, gives it the task, and brings its result back to the
    /// main bot's chat as a notice. The team ends after that one reply.
    @discardableResult
    public func startTeam(_ name: String, task: String) -> TeamRun? {
        let spec = teams.first { $0.name == name } ?? teams.first ?? TeamSpec.defaults[0]
        let stamp = Date().formatted(.verbatim(
            "\(year: .defaultDigits)\(month: .twoDigits)\(day: .twoDigits)-\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased))\(minute: .twoDigits)\(second: .twoDigits)",
            timeZone: .current,
            calendar: .current
        ))
        let folder = root.appending(path: "runs/\(stamp)-\(spec.name)")
        try? FileManager.default.createDirectory(at: folder.appending(path: "artifacts"), withIntermediateDirectories: true)
        let run = TeamRun(id: UUID(), spec: spec, task: task, folder: folder, startedAt: Date())
        let process: AgentProcess
        do {
            process = try launcher(AgentLaunch(
                model: spec.model,
                sessionID: run.id,
                workingDirectory: folder,
                systemPrompt: TeamPrompts.system(spec, folder: folder),
                tools: spec.tools,
                pluginDirectories: plugins.claudeDirectories(),
                pluginTools: plugins.claudeTools(),
                environment: plugins.secretEnvironment()
            ))
        } catch {
            mainBot.notice("\(spec.title) could not start: \(error.localizedDescription)")
            return nil
        }
        runningTeams.append(run)
        process.send(TeamPrompts.task(task))
        Task { [weak self] in
            var reported = false
            for await event in process.events {
                switch event {
                case .activity, .permission, .permissionCancelled:
                    // Teams are started without asking (asksPermission is off), so nothing waits.
                    break
                case let .reply(text, _):
                    guard !reported else { continue }
                    reported = true
                    self?.mainBot.notice("\(spec.title): \(ReplyParser.parseAll(text).body)")
                    if self?.selection == nil { self?.mainBot.markRead() }
                    process.finish()
                case let .exited(status, stderr):
                    if !reported {
                        self?.mainBot.notice("\(spec.title) did not finish: \(stderr.isEmpty ? "exit code \(status)" : stderr)")
                    }
                }
            }
            self?.runningTeams.removeAll { $0.id == run.id }
        }
        // A team that runs away is stopped after an hour.
        Task {
            try? await Task.sleep(for: .seconds(3600))
            process.stop()
        }
        return run
    }

    /// Teams are the agents in plugins' Claude parts (`claude/agents/*.md`); the built-in ones are
    /// the `ccb-teams` plugin. The first agent of a name wins.
    private func loadTeams() -> [TeamSpec] {
        var seen = Set<String>()
        // ccb-core's agents (the component editor) work for Maintainer; they are not teams.
        let specs = plugins.agentFiles().filter { $0.plugin != "ccb-core" }.compactMap { file -> TeamSpec? in
            guard let spec = (try? String(contentsOf: file.url, encoding: .utf8)).flatMap(TeamSpec.parse),
                  seen.insert(spec.name).inserted else { return nil }
            return spec
        }
        return specs.isEmpty ? TeamSpec.defaults : specs
    }

    /// What Maintainer is told on top of a manager's usual instructions.
    func maintainerInstructions() -> String {
        let library = root.appending(path: "plugins").path
        let check = checkCommand.map { "\($0) <plugin folder>" } ?? "(no check command this time; at least make sure package.json is valid JSON and every declared file exists)"
        return """
        - You are "Maintainer": you look after the plugin library of the ClaudeCodeBot app. Your working folder \(library) is the plugin library, a git repo.
        - Read \(library)/PLUGINS.md first: the plugin format, the APIs of the three parts (web, program, Claude), and the check and release steps are all there.
        - Every time you change a plugin:
          1. Edit the files (for a plugin with src/, edit src, then bundle with esbuild to the location package.json names).
          2. Bump the version in that plugin's package.json (patch for fixes, minor for new features).
          3. Run the check: \(check). If it fails, fix it, at most 3 rounds; if all 3 fail, use a choices block to tell the user where you are stuck.
          4. git add that plugin folder, git commit -m "<plugin name>: <what you did>", then git tag <plugin name>--v<version>.
          5. Report what you did in one sentence. ClaudeCodeBot hot-updates on its own; no restart needed.
        - Components live in ccb-components/components/<name>/ (template.html, about.md). After changing one, likewise bump the ccb-components version, check, and commit.
          Small jobs that only touch a component template can go to the ccb-core:component-editor agent (Haiku); you then check and commit.
        - Plugins built into the app are not here and cannot be edited directly: to change one, copy its whole folder into the plugin library; a plugin with the same name overrides the built-in one (paths in PLUGINS.md).
        - To read a folder outside the plugin library (for example to turn an existing project into a plugin): end your reply with <need-folder>full path</need-folder>, say in one sentence why you need it, then stop and wait.
          Once the user agrees you will receive "(App) The user agreed…"; only then read it. If they refuse, find another way. Only read, never change files there. Folders already allowed need no new request.
        - Turning an existing project into a plugin: first find the reusable core (a library without dependencies is best); the web part should only do the wiring (hook up ccb.composer, settings, commands).
          Bundle it with esbuild into a single ES module (use the esbuild in the original project's node_modules, or npx --yes esbuild@0.25.11).
          Copy the original project's license into the plugin (the license in package.json and the LICENSE file); GPL code may only go into a separate plugin.
        - A "Hot-update check" message means ClaudeCodeBot found a broken plugin: fix it with the steps above.
        - A bot that only needs instructions and a schedule (a morning news bot, a reading coach) is not a plugin: end your reply with <new-bot name="short name, no quotes">its job in a few sentences, including when it should work</new-bot>; ClaudeCodeBot adds it to the left column and it writes its own routines. Build a plugin with ccb.bots.create (see PLUGINS.md) only when the bot needs code of its own. Never write that tag inside code or examples.
        """
    }

    /// `ccb-core`: ClaudeCodeBot's own agents, starting with the component editor (Haiku).
    static func prepareCorePlugin(in library: URL) {
        let files = FileManager.default
        let plugin = library.appending(path: "ccb-core")
        guard !files.fileExists(atPath: plugin.path) else { return }
        try? files.createDirectory(at: plugin.appending(path: "claude/.claude-plugin"), withIntermediateDirectories: true)
        try? files.createDirectory(at: plugin.appending(path: "claude/agents"), withIntermediateDirectories: true)
        let editor = """
        ---
        name: component-editor
        description: Edits one component in the ClaudeCodeBot chat (template.html and about.md). Give it the component folder's path and what to change.
        model: haiku
        tools: Read, Write, Edit
        ---
        \(ComponentPrompts.system)

        """
        try? Data(editor.utf8).write(to: plugin.appending(path: "claude/agents/component-editor.md"))
        try? Data("""
        {
          "name": "ccb-core",
          "version": "1.0.0",
          "description": "Agents ClaudeCodeBot uses itself.",
          "author": { "name": "ClaudeCodeBot" }
        }

        """.utf8).write(to: plugin.appending(path: "claude/.claude-plugin/plugin.json"))
        try? Data("""
        {
          "name": "ccb-core",
          "displayName": "ClaudeCodeBot core",
          "version": "1.0.0",
          "description": "Agents ClaudeCodeBot uses itself: component-editor (Haiku) edits component templates.",
          "license": "MIT",
          "engines": { "ccb": "^2.0.0" },
          "ccb": {
            "permissions": ["claude"],
            "claude": "claude"
          }
        }

        """.utf8).write(to: plugin.appending(path: "package.json"))
    }

    /// PLUGINS.md in the library: how plugins are written, for Maintainer and for people.
    static func writeLibraryGuide(in library: URL, builtIns: URL?) {
        try? FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        let url = library.appending(path: "PLUGINS.md")
        let text = PluginGuide.text(builtIns: builtIns?.path ?? "(no built-in plugins this time)")
        if (try? String(contentsOf: url, encoding: .utf8)) != text {
            try? Data(text.utf8).write(to: url)
        }
    }

    /// The `ccb-teams` plugin holds the temporary teams as Claude Code agents. Team files from
    /// before plugins (`~/.claudecodebot/teams`) move into it once; the old folder is kept as
    /// `teams.v1-backup`.
    static func prepareTeamsPlugin(in library: URL, movingFrom old: URL) {
        let files = FileManager.default
        let plugin = library.appending(path: "ccb-teams")
        let agents = plugin.appending(path: "claude/agents")
        guard !files.fileExists(atPath: plugin.path) else { return }
        try? files.createDirectory(at: agents, withIntermediateDirectories: true)
        try? files.createDirectory(at: plugin.appending(path: "claude/.claude-plugin"), withIntermediateDirectories: true)
        let oldFiles = ((try? files.contentsOfDirectory(at: old, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "md" }
        if oldFiles.isEmpty {
            for spec in TeamSpec.defaults {
                try? Data(spec.fileText.utf8).write(to: agents.appending(path: "\(spec.name).md"))
            }
        } else {
            for file in oldFiles { try? files.copyItem(at: file, to: agents.appending(path: file.lastPathComponent)) }
        }
        if files.fileExists(atPath: old.path) {
            try? files.moveItem(at: old, to: old.deletingLastPathComponent().appending(path: "teams.v1-backup"))
        }
        let claudeManifest = """
        {
          "name": "ccb-teams",
          "version": "1.0.0",
          "description": "ClaudeCodeBot's temporary teams: Research team, Prototype team.",
          "author": { "name": "ClaudeCodeBot" }
        }

        """
        try? Data(claudeManifest.utf8).write(to: plugin.appending(path: "claude/.claude-plugin/plugin.json"))
        let manifest = """
        {
          "name": "ccb-teams",
          "displayName": "Temporary teams",
          "version": "1.0.0",
          "description": "Temporary teams the main bot can start. Each team is one agent file in claude/agents/.",
          "license": "MIT",
          "engines": { "ccb": "^2.0.0" },
          "ccb": {
            "permissions": ["claude"],
            "claude": "claude"
          }
        }

        """
        try? Data(manifest.utf8).write(to: plugin.appending(path: "package.json"))
    }

    /// Every bot starts with the plugins' Claude parts, their MCP tools allowed, and the secrets
    /// those servers read.
    private func giveClaudeParts(to bot: Bot) {
        bot.pluginDirectories = { [weak self] in self?.plugins.claudeDirectories() ?? [] }
        bot.pluginTools = { [weak self] in self?.plugins.claudeTools() ?? [] }
        bot.pluginEnvironment = { [weak self] in self?.plugins.secretEnvironment() ?? [:] }
    }

    /// Plugins' Claude parts changed: refresh the team list, and restart awake bots (once they
    /// are free) so they get the new skills, agents and MCP servers.
    private func followClaudeParts() {
        var loaded = plugins.claudeDirectories()
        plugins.$revision
            .dropFirst()
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    teams = loadTeams()
                    let now = plugins.claudeDirectories()
                    guard now != loaded else { return }
                    loaded = now
                    for bot in [mainBot] + Array(managers.values) where bot.phase != .asleep {
                        await bot.reloadPlugins()
                    }
                }
            }
            .store(in: &subscriptions)
    }

    /// Hands whatever the main bot wrote into a project's inbox.md to that manager.
    public func deliverInboxes() {
        for project in everyProject {
            guard let text = try? String(contentsOf: project.inboxURL, encoding: .utf8),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            try? Data().write(to: project.inboxURL)
            managers[project.id]?.relay(text)
        }
    }

    public func refreshWaiting() {
        waiting = everyProject.flatMap { project -> [Waiting] in
            if let question = managers[project.id]?.openQuestion {
                return [Waiting(projectID: project.id, text: Self.firstLine(of: question.text), messageID: question.id)]
            }
            return MemoryFile.items(at: project.notesFolder.appending(path: "memory.md"), section: "Waiting on you")
                .map { Waiting(projectID: project.id, text: $0) }
        }
    }

    /// The single place a pick is made, from either chat. A pick on a notice in the main bot's
    /// chat answers the manager; a pick in the manager's chat also settles its notice.
    @discardableResult
    public func choose(_ index: Int, in messageID: UUID, of bot: Bot) -> Bool {
        defer { refreshWaiting() }
        if bot === mainBot, let proposal = installQuestions[messageID] {
            guard let notice = mainBot.messages.first(where: { $0.id == messageID }), notice.isOpenQuestion else { return false }
            installQuestions[messageID] = nil
            mainBot.markChosen(index, in: messageID)
            if index == 0 {
                Task { await finishInstall(proposal) }
            } else {
                try? FileManager.default.removeItem(at: proposal.folder)
            }
            return true
        }
        if bot === mainBot, let folder = folderQuestions[messageID] {
            guard let notice = mainBot.messages.first(where: { $0.id == messageID }), notice.isOpenQuestion else { return false }
            folderQuestions[messageID] = nil
            mainBot.markChosen(index, in: messageID)
            answerFolder(folder, allowed: index == 0)
            return true
        }
        if bot === mainBot,
           let notice = mainBot.messages.first(where: { $0.id == messageID }),
           notice.role == .notice {
            guard notice.isOpenQuestion else { return false }
            guard let projectID = notice.sourceID,
                  let questionID = notice.sourceMessageID,
                  let manager = managers[projectID],
                  manager.choose(index, in: questionID) else {
                // The manager's question was settled or is gone: so is this copy.
                closeCopy(of: notice)
                return false
            }
            mainBot.markChosen(index, in: messageID)
            return true
        }
        guard bot.choose(index, in: messageID) else { return false }
        if let notice = mainBot.messages.first(where: { $0.role == .notice && $0.sourceMessageID == messageID }) {
            mainBot.markChosen(index, in: notice.id)
        }
        return true
    }

    /// What a component sent back in words: an answer to the question in that message (from
    /// either chat, kept in step like a pick), or, for a message that asks nothing, just a reply.
    @discardableResult
    public func answer(_ text: String, in messageID: UUID, of bot: Bot) -> Bool {
        defer { refreshWaiting() }
        guard let message = bot.messages.first(where: { $0.id == messageID }) else { return false }
        guard message.isOpenQuestion else {
            // A question already answered stays answered.
            if message.choices?.isEmpty == false { return false }
            bot.send(text)
            return true
        }
        if bot === mainBot, message.role == .notice {
            guard let projectID = message.sourceID,
                  let questionID = message.sourceMessageID,
                  let manager = managers[projectID],
                  manager.answer(text, in: questionID) else {
                closeCopy(of: message)
                return false
            }
            mainBot.markAnswered(text, in: messageID)
            return true
        }
        guard bot.answer(text, in: messageID) else { return false }
        if let notice = mainBot.messages.first(where: { $0.role == .notice && $0.sourceMessageID == messageID }) {
            mainBot.markAnswered(text, in: notice.id)
        }
        return true
    }

    /// A manager reported. Questions always go up to the main bot's chat; plain results go up when
    /// they answer work the main bot handed over.
    private func report(from project: Project, _ message: ChatMessage, answersRelay: Bool) {
        guard message.role == .bot, message.isOpenQuestion || answersRelay else { return }
        mainBot.notice(
            "\(project.name): \(message.text)",
            choices: message.choices,
            sourceID: project.id,
            sourceMessageID: message.id
        )
        if selection == nil { mainBot.markRead() }
    }

    /// A notice whose question can no longer be answered: show what became of it.
    private func closeCopy(of notice: ChatMessage) {
        let original = notice.sourceID.flatMap { managers[$0] }?.messages.first { $0.id == notice.sourceMessageID }
        if let chosen = original?.chosen {
            mainBot.markChosen(chosen, in: notice.id)
        } else {
            mainBot.markAnswered(original?.answer ?? Bot.noLongerNeeded, in: notice.id)
        }
    }

    static func firstLine(of text: String) -> String {
        text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    }

    // MARK: Plugin host

    /// What you type goes through plugins' beforeSend hooks first; one can change it or stop it.
    public func send(_ text: String, files: [URL] = [], replyingTo replyID: UUID? = nil, to bot: Bot) async {
        var text = text
        if let pluginHost, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            switch await pluginHost.beforeSend(bot: info(for: bot), text: text) {
            case let .send(changed):
                text = changed
            case let .stopped(by: plugin):
                let title = plugins.plugin(plugin)?.manifest.title ?? plugin
                bot.notice("Plugin \"\(title)\" stopped this message: \(text)")
                return
            }
        }
        bot.send(text, files: files, replyingTo: replyID)
    }

    /// Runs a plugin command in the plugin host.
    public func runCommand(_ id: String) async {
        guard let pluginHost else { return }
        do {
            _ = try await pluginHost.command(id)
        } catch {
            mainBot.notice("Command \"\(id)\" failed: \(error.localizedDescription)")
        }
    }

    /// The stable id plugins use for a bot: "main", or the project's id.
    public func pluginID(for bot: Bot) -> String {
        bot === mainBot ? "main" : managers.first { $0.value === bot }?.key.uuidString ?? bot.id.uuidString
    }

    private func bot(pluginID: String) -> Bot? {
        pluginID == "main" ? mainBot : UUID(uuidString: pluginID).flatMap { managers[$0] }
    }

    private func info(for bot: Bot) -> JSONValue {
        .object([
            "id": .string(pluginID(for: bot)),
            "name": .string(bot.name),
            "role": .string(bot === mainBot ? "main" : bot.profile.isStandalone ? "bot" : "manager"),
            "awake": .bool(bot.phase != .asleep)
        ])
    }

    private func connectPlugins(to bot: Bot) {
        guard pluginHost != nil else { return }
        bot.replyFilter = { [weak self, weak bot] in
            guard let self, let bot, let host = pluginHost, host.afterReplyHooks > 0, host.isRunning else { return nil }
            let info = info(for: bot)
            return { text in await host.afterReply(bot: info, text: text) }
        }
        bot.replyObserver = { [weak self, weak bot] message in
            guard let self, let bot else { return }
            pluginHost?.replied(bot: info(for: bot), text: message.text)
        }
    }

    private func startPluginHost() {
        guard let pluginHost else { return }
        let dataRoot = root.appending(path: "plugin-data")
        plugins.$revision
            .sink { [weak self] _ in
                // After the change is published, so the registry reads its new state.
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    pluginHost.update(plugins.hostSpecs(dataRoot: dataRoot))
                }
            }
            .store(in: &subscriptions)
        pluginHost.onPluginFailure = { [weak self] plugin, message, fatal in
            guard let self, let plugin else { return }
            plugins.recordHostFailure(plugin, message: message, fatal: fatal)
        }
        pluginHost.onNotification = { [weak self] method, params in
            guard let self else { return }
            let plugin = params["plugin"]?.string ?? ""
            let title = plugins.plugin(plugin)?.manifest.title ?? plugin
            switch method {
            case "notify":
                mainBot.notice("\(title): \(params["text"]?.string ?? "")")
                if selection == nil { mainBot.markRead() }
            case "bots.send":
                if let id = params["bot"]?.string, let text = params["text"]?.string { bot(pluginID: id)?.send(text) }
            default:
                break
            }
        }
        pluginHost.onRequest = { [weak self] method, params in
            guard let self else { return .null }
            switch method {
            case "bots.list":
                return .array(([mainBot] + everyProject.compactMap { self.managers[$0.id] }).map(info(for:)))
            case "bots.create":
                let plugin = params["plugin"]?.string ?? ""
                guard plugins.plugin(plugin)?.manifest.ccb?.permissions?.contains("bots") == true else {
                    throw HostMessage.HostError(message: "Creating bots needs the \"bots\" permission in package.json.")
                }
                let title = plugins.plugin(plugin)?.manifest.title ?? plugin
                let name = params["name"]?.string ?? ""
                let made = makeBot(name: name, job: params["job"]?.string ?? "", avatar: params["avatar"]?.string, by: "plugin \"\(title)\"", plugin: plugin)
                let project: Project, created: Bool
                switch made {
                case let .made(new): (project, created) = (new, true)
                case let .existing(old): (project, created) = (old, false)
                case .empty: throw HostMessage.HostError(message: "A bot needs a name and a job.")
                case .taken: throw HostMessage.HostError(message: "There is already a bot called \"\(name)\" that this plugin did not make.")
                case .removedByUser: throw HostMessage.HostError(message: "The user removed the bot \"\(name)\"; it is not made again.")
                }
                guard let bot = managers[project.id], case var .object(fields) = info(for: bot) else {
                    throw HostMessage.HostError(message: "The bot could not be started.")
                }
                fields["created"] = .bool(created)
                return .object(fields)
            case "routines.add":
                guard let id = params["bot"]?.string, let bot = bot(pluginID: id) else {
                    throw HostMessage.HostError(message: "No such bot.")
                }
                guard bot.addRoutine(cron: params["cron"]?.string ?? "", task: params["task"]?.string ?? "") else {
                    throw HostMessage.HostError(message: "Invalid schedule (it must be the 5 crontab fields).")
                }
                return .null
            default:
                throw HostMessage.HostError(message: "Unknown method \"\(method)\".")
            }
        }
    }

    // MARK: Setup

    private func attach(_ project: Project) {
        let store = BotStore(directory: root.appending(path: "projects/\(project.id.uuidString)"))
        let profile: BotProfile = if project.isMaintainer {
            .maintainer(folder: project.folder, instructions: maintainerInstructions())
        } else if let job = project.job {
            .standalone(name: project.name, avatar: project.avatar, folder: project.folder, job: job)
        } else {
            .manager(name: project.name, avatar: project.avatar, folder: project.folder)
        }
        let bot = makeBot(profile, store)
        bot.onRequests = { [weak self] requests in self?.handle(requests, from: project) }
        bot.wakeNote = { [weak self] in self?.componentBriefing() ?? "" }
        giveClaudeParts(to: bot)
        bot.onReply = { [weak self, weak bot] message, answersRelay in
            guard let self else { return }
            report(from: project, message, answersRelay: answersRelay)
            if project.isMaintainer { components.finishWorking() }
            refreshWaiting()
            if selection == project.id { bot?.markRead() }
        }
        // A question outside a reply (may it use a tool?) goes up like a reported question.
        bot.onQuestion = { [weak self] message in
            guard let self else { return }
            report(from: project, message, answersRelay: true)
            refreshWaiting()
        }
        bot.onQuestionSettled = { [weak self] message in
            guard let self else { return }
            if let notice = mainBot.messages.first(where: { $0.role == .notice && $0.sourceMessageID == message.id && $0.isOpenQuestion }) {
                closeCopy(of: notice)
            }
            refreshWaiting()
        }
        // Memory changes most when a manager tidies before sleeping.
        bot.$phase
            .filter { $0 == .asleep }
            .sink { [weak self] _ in self?.refreshWaiting() }
            .store(in: &subscriptions)
        managers[project.id] = bot
        if !project.isMaintainer { projects.append(project) }
        connectPlugins(to: bot)
    }

    /// `<project>/.bot/` holds the manager's memory.md and inbox.md. Its own .gitignore keeps it
    /// out of the project's git status (which would also break prompt caching).
    private func prepareNotesFolder(for project: Project) {
        let folder = project.notesFolder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ignore = folder.appending(path: ".gitignore")
        if !FileManager.default.fileExists(atPath: ignore.path) {
            try? Data("*\n".utf8).write(to: ignore)
        }
    }

    private var projectsURL: URL { root.appending(path: "projects.json") }

    private func loadProjects() -> [Project] {
        guard let data = try? Data(contentsOf: projectsURL) else { return [] }
        return (try? JSONDecoder().decode([Project].self, from: data)) ?? []
    }

    private func saveProjects() {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(projects.filter { !$0.isMaintainer }) else { return }
        try? data.write(to: projectsURL, options: .atomic)
    }
}
