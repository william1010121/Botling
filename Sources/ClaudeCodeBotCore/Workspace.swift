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
    /// Stands for the main bot where a project's id would go (a group's members, who said a line).
    public static let mainBotID = UUID(uuidString: "6A0B0000-0000-4000-8000-000000000002")!
    /// Codex's fixed id: its chat and its reviews survive restarts.
    public static let codexID = UUID(uuidString: "C0DE0000-0000-4000-8000-00000000C0DE")!

    /// Something a manager needs the user to decide: an open question in its chat, or else a
    /// line from its memory.md "Waiting on you" section.
    public struct Waiting: Identifiable, Equatable, Sendable {
        public var id: String { "\(projectID)-\(text)" }
        public var projectID: UUID
        public var text: String
        /// The question in the manager's chat, when there is one to answer with a button.
        public var messageID: UUID?
        /// The group whose chat holds the question, when it was asked in a group.
        public var groupID: UUID?

        public init(projectID: UUID, text: String, messageID: UUID? = nil, groupID: UUID? = nil) {
            self.projectID = projectID
            self.text = text
            self.messageID = messageID
            self.groupID = groupID
        }
    }

    public typealias BotFactory = @MainActor (BotProfile, BotStore) -> Bot

    /// Shapes handed out to new projects, in order; the main bot is the circle.
    static let avatars = ["square", "triangle", "hexagon", "star", "diamond", "clover", "heart", "drop",
                          "pentagon", "cloud", "octagon", "moon", "pill", "ghost", "burst"]

    @Published public private(set) var projects: [Project] = []
    /// nil = the main bot; else a project's, a bot's, Maintainer's or a group's id.
    @Published public private(set) var selection: UUID?
    /// The subagent of the selected bot you are watching instead of its chat (its id).
    @Published public private(set) var viewingSubagent: String?
    @Published public private(set) var waiting: [Waiting] = []
    /// Temporary teams at work right now.
    @Published public private(set) var runningTeams: [TeamRun] = []
    public private(set) var teams: [TeamSpec] = []

    public let mainBot: Bot
    /// Group chats you made, in the order you made them.
    @Published public internal(set) var groups: [ChatGroup] = []
    /// Each group's chat (only its lines; nothing runs in it), by group id.
    public internal(set) var groupChats: [UUID: Bot] = [:]
    /// Who is writing in each group right now (a project's id, or `mainBotID`), by group id.
    @Published public internal(set) var groupSpeakers: [UUID: UUID] = [:]
    /// A group's rounds run one after another, by group id.
    var groupQueues: [UUID: Task<Void, Never>] = [:]
    /// The group a member is taking its turn in, by member id.
    var groupTurns: [UUID: UUID] = [:]
    /// How long a turn waits for a bot busy with its own chat, and how long it then has to
    /// answer: short when nobody named it (it just misses this one), long when you did.
    public var groupTiming = (busy: 20.0, busyNamed: 5 * 60.0, answer: 3 * 60.0, answerNamed: 15 * 60.0)
    /// Who is answering, called in with @, in a bot's own chat right now, by that chat's member id.
    @Published public internal(set) var callInSpeakers: [UUID: UUID] = [:]
    /// The turns of bots called into a bot's own chat run one after another, by its member id.
    var callInQueues: [UUID: Task<Void, Never>] = [:]
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
    /// Components whose data comes from a command: what the user allowed, and each card's run.
    public let componentCommands: ComponentCommands
    /// Plugins for ClaudeCodeBot itself: `~/.claudecodebot/plugins/` and the ones shipped with the app.
    public let plugins: PluginRegistry
    /// Runs plugins' program parts (Node), when a script for it was given.
    public let pluginHost: PluginHostClient?
    public let root: URL
    private let makeBot: BotFactory
    /// ClaudeCodeBot's own settings: developer mode, auto-approve, ignored items.
    @Published public internal(set) var settings: AppSettings
    /// What the bots spent today.
    @Published public internal(set) var spending: Spending
    var settingsURL: URL { root.appending(path: "settings.json") }
    var spendingURL: URL { root.appending(path: "spending.json") }
    /// The ClaudeCodeBot build running now; nil when not run from an app bundle (`swift run`).
    public var runningBuild: BuildInfo?
    /// Runs the install script, detached, and quits the app (the app sets it).
    public var launchInstaller: (([String]) -> Void)?
    /// A PNG of the app's window (the app sets it).
    public var captureWindow: (() async -> URL?)?
    /// Build cards waiting for a pick: the build, the project that asked, what changed.
    var buildQuestions: [UUID: (build: BuildInfo, requester: UUID, note: String)] = [:]
    /// Codex, the read-only reviewer: its chat (each message one fresh `codex exec`), where
    /// it works for the next turn, and what runs it.
    public let codexBot: Bot
    public let codexProject: Project
    let codexDesk: CodexDesk
    let codexRunner: CodexRunning
    /// Every Codex review (single ones and subagent loops), oldest first.
    @Published public internal(set) var codexReviews: [CodexReview] = []
    let codexStore: CodexReviewStore
    /// Codex runs under way, by review id.
    var codexRuns: [UUID: Task<Void, Never>] = [:]
    /// "Fix once more / Accept as is" cards, by message id: the review they are about.
    var codexQuestions: [UUID: UUID] = [:]
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
        codex: CodexRunning = CodexCLI(),
        makeBot: @escaping BotFactory
    ) {
        self.root = root
        self.makeBot = makeBot
        self.launcher = launcher
        settings = AppSettings.load(from: root.appending(path: "settings.json"))
        spending = Spending.load(from: root.appending(path: "spending.json"))
        let library = root.appending(path: "plugins")
        Self.migrateFromDeck(library: library, root: root)
        let componentFolder = Self.prepareComponentPlugin(in: library, movingFrom: root.appending(path: "components"))
        Self.prepareTeamsPlugin(in: library, movingFrom: root.appending(path: "teams"))
        Self.prepareCorePlugin(in: library)
        Self.writeLibraryGuide(in: library, builtIns: builtInPlugins)
        let git = gitForPlugins ?? PluginLibraryGit(folder: library)
        libraryGit = git
        maintainerProject = Project(id: Self.maintainerID, name: "Maintainer", folder: library, avatar: "diamond")
        let codexHome = root.appending(path: "codex")
        codexProject = Project(id: Self.codexID, name: "Codex", folder: codexHome, avatar: "codex")
        codexRunner = codex
        codexDesk = CodexDesk(folder: FileManager.default.homeDirectoryForCurrentUser)
        codexStore = CodexReviewStore(url: codexHome.appending(path: "reviews.json"))
        codexBot = Bot(profile: .codex(folder: codexHome), launcher: CodexAgentProcess.launcher(runner: codex, desk: codexDesk), store: BotStore(directory: codexHome))
        plugins = PluginRegistry(library: library, builtIns: builtInPlugins, validateClaudePart: validateClaudePart, git: git, secrets: secrets)
        pluginHost = pluginHostScript.map { PluginHostClient(script: $0, locateNode: locateNode) }
        components = ComponentLibrary(folder: componentFolder)
        componentCommands = ComponentCommands(approvalsURL: root.appending(path: "approved-commands.json"))
        components.git = git.isAvailable ? git : nil
        self.checkCommand = checkCommand
        let mainHome = root.appending(path: "main")
        try? FileManager.default.createDirectory(at: mainHome, withIntermediateDirectories: true)
        mainBot = makeBot(.main(home: mainHome), BotStore(directory: mainHome))
        Self.retireTheOneGroup(in: root, into: mainBot)
        mainBot.wakeNote = { [weak self] in
            guard let self else { return "" }
            return [projectBriefing(), codexBriefing(for: mainBot)].filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
        mainBot.extraDirectories = { [weak self] in self?.everyProject.map(\.notesFolder) ?? [] }
        giveClaudeParts(to: mainBot)
        mainBot.onReply = { [weak self] _, _ in
            guard let self else { return }
            deliverInboxes()
            refreshWaiting()
            if selection == nil { mainBot.markRead() }
        }
        mainBot.onRequests = { [weak self] requests in self?.handle(requests, from: nil) }
        mainBot.onCodexSettings = { [weak self] _ in self?.retellCodexRules(to: Self.mainBotID) }
        mainBot.onSpend = { [weak self] amount in self?.record(amount, by: "Main bot") }
        mainBot.onTokens = { [weak self] tokens in self?.record(0, tokens: tokens, by: "Main bot") }
        // Asked during a group turn, the main bot's question shows in that group too.
        mainBot.onQuestion = { [weak self] message in
            guard let self else { return }
            mirrorIntoGroup(message, from: Self.mainBotID)
            refreshWaiting()
        }
        mainBot.onQuestionSettled = { [weak self] message in self?.closeCopies(of: message) }
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
            guard let self else { return }
            tell(mainBot, text)
        }
        plugins.onBroken = { [weak self] plugin, problem in
            self?.handToMaintainer("(App: Hot-update check) The plugin \"\(plugin)\" is broken; ClaudeCodeBot fell back to the previous version or disabled it for now. Please fix it: \(problem)")
        }
        plugins.onUpdated = { [weak self] plugin, old in
            guard let self else { return }
            tell(mainBot, "Plugin \"\(plugin.manifest.title)\" updated: \(old) → \(plugin.manifest.version)")
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
        loadGroups()
        setUpCodex()
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
            tell(mainBot, "Couldn't install \"\(source)\": \(error.localizedDescription)")
            return error.localizedDescription
        }
        guard proposal.problems.isEmpty else {
            let problem = proposal.problems.joined(separator: "; ")
            tell(mainBot, "\"\(proposal.manifest.title)\" failed the checks and was not installed: \(problem)")
            return problem
        }
        if trusted {
            return await finishInstall(proposal)
        }
        let question = tell(
            mainBot,
            proposal.summary,
            choices: [Choice(label: "Install", detail: nil, recommended: false), Choice(label: "Don't install", detail: nil, recommended: false)]
        )
        installQuestions[question] = proposal
        return nil
    }

    @discardableResult
    private func finishInstall(_ proposal: InstallProposal) async -> String? {
        await prepareLibrary().value
        let problem = await plugins.install(proposal)
        try? FileManager.default.removeItem(at: proposal.folder)
        if let problem {
            tell(mainBot, "\"\(proposal.manifest.title)\" could not be installed: \(problem)")
        } else {
            tell(mainBot, "Installed: \(proposal.manifest.title) \(proposal.manifest.version). You can turn it off or remove it under Plugins in Settings.")
        }
        return problem
    }

    // MARK: Folders outside the library

    /// Folders you let Maintainer read (kept in `~/.claudecodebot/folders.json`).
    public private(set) var approvedFolders: [URL] = []
    /// Open "may it read this folder?" questions in Maintainer's chat, by message id.
    private var folderQuestions: [UUID: URL] = [:]
    /// Folders the main bot asked to make projects, waiting for your "Add", by the question's id.
    private var projectQuestions: [UUID: [(folder: URL, task: String)]] = [:]
    private var foldersURL: URL { root.appending(path: "folders.json") }

    private func loadApprovedFolders() -> [URL] {
        guard let data = try? Data(contentsOf: foldersURL),
              let paths = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return paths.map { URL(filePath: $0) }
    }

    /// Maintainer asked to read `path`: ask you once (in its chat); a folder you allowed
    /// before, or one inside it, is allowed at once.
    func requestFolder(_ path: String) {
        let folder = URL(filePath: (path as NSString).expandingTildeInPath).standardizedFileURL
        if approvedFolders.contains(where: { folder.path == $0.path || folder.path.hasPrefix($0.path + "/") }) {
            maintainer.relay("(App) \(folder.path) was already allowed before; you can read it directly.")
            return
        }
        let question = tell(
            maintainer,
            "Maintainer wants to read \"\(folder.path)\". It will only read, never change files there. Allow it?",
            choices: [Choice(label: "Allow", detail: "Won't ask again", recommended: false), Choice(label: "Don't allow", detail: nil, recommended: false)],
            sourceID: Self.maintainerID
        )
        folderQuestions[question] = folder
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
    public func handToMaintainer(_ text: String, files: [URL] = []) {
        prepareLibrary()
        maintainer.relay(text, files: files)
    }

    public var selectedBot: Bot {
        selection.flatMap { groupChats[$0] ?? managers[$0] ?? ($0 == Self.codexID ? codexBot : nil) } ?? mainBot
    }

    public func bot(for project: Project) -> Bot? {
        managers[project.id]
    }

    public func project(_ id: UUID) -> Project? {
        id == Self.codexID ? codexProject : everyProject.first { $0.id == id }
    }

    public func select(_ projectID: UUID?) {
        selection = projectID
        viewingSubagent = nil
        selectedBot.markRead()
    }

    /// Shows what `bot`'s subagent did, like a conversation; nil goes back to the bot's chat.
    public func view(subagent id: String?, of bot: Bot) {
        if selectedBot !== bot {
            select(bot === mainBot ? nil : managers.first { $0.value === bot }?.key)
        }
        viewingSubagent = id.flatMap { bot.trace.subagent($0) == nil ? nil : $0 }
    }

    /// Makes `folder` a project with its own manager, or selects it if it already is one.
    /// `select` false leaves you in the chat you are in (adding it from the main bot's chat).
    @discardableResult
    public func addProject(folder: URL, select selecting: Bool = true) -> Project {
        let folder = folder.standardizedFileURL
        if let existing = projects.first(where: { $0.folder.standardizedFileURL.path == folder.path }) {
            if selecting { select(existing.id) }
            return existing
        }
        let project = Project(id: UUID(), name: folder.lastPathComponent, folder: folder, avatar: nextAvatar())
        prepareNotesFolder(for: project)
        attach(project)
        saveProjects()
        if selecting { select(project.id) }
        return project
    }

    /// The main bot asked to make folders projects: one card in its chat asks you first, since
    /// each new manager may read and change everything in its folder. Folders that are projects
    /// already just get their task; ones that are missing or too broad are said and left out.
    func proposeProjects(_ asked: [(path: String, task: String)]) {
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        let own = root.standardizedFileURL.path
        var adding: [(folder: URL, task: String)] = []
        var missing: [String] = []
        var tooBroad: [String] = []
        var handed: [String] = []
        // "~/tool/*": every folder inside (not hidden ones); "~/tool/**": every project below,
        // however deep. Found here, so the bot need not look at the disk.
        var expanded: [(String, String)] = []
        for (path, task) in asked {
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasSuffix("/**") {
                let parent = String(trimmed.dropLast(3))
                guard let folder = Self.folderURL(parent), FileManager.default.fileExists(atPath: folder.path) else {
                    missing.append(parent)
                    continue
                }
                let found = Self.projectFolders(in: folder)
                if found.isEmpty { missing.append(trimmed) }
                expanded += found.map { ($0.path, task) }
                continue
            }
            guard trimmed.hasSuffix("/*") else {
                expanded.append((path, task))
                continue
            }
            let parent = String(trimmed.dropLast(2))
            guard let folder = Self.folderURL(parent),
                  let inside = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else {
                missing.append(parent)
                continue
            }
            let folders = inside
                .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
                .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
            if folders.isEmpty { missing.append(trimmed) }
            expanded += folders.map { ($0.path, task) }
        }
        for (path, task) in expanded {
            let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
            var isFolder: ObjCBool = false
            guard let folder = Self.folderURL(path), FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder), isFolder.boolValue else {
                missing.append(path)
                continue
            }
            if ["/", home].contains(folder.path) || folder.path == own || folder.path.hasPrefix(own + "/") {
                tooBroad.append(folder.path)
                continue
            }
            if let existing = projects.first(where: { $0.folder.standardizedFileURL.path == folder.path }) {
                if !task.isEmpty { managers[existing.id]?.relay(task) }
                handed.append(existing.name)
                continue
            }
            if !adding.contains(where: { $0.folder.path == folder.path }) { adding.append((folder, task)) }
        }
        var notes: [String] = []
        if !missing.isEmpty {
            tell(mainBot, "Couldn't add a project: there is no folder at \(missing.joined(separator: ", ")).")
            notes.append("There is no folder at \(missing.joined(separator: ", ")); nothing was added for it. Ask the user for the full path.")
        }
        if !tooBroad.isEmpty {
            tell(mainBot, "Couldn't add \(tooBroad.joined(separator: ", ")) as a project: a manager there could change far more than one project.")
            notes.append("\(tooBroad.joined(separator: ", ")) was not added: a whole disk, the home folder or ClaudeCodeBot's own folder cannot be a project. Ask for the project's own folder.")
        }
        if !handed.isEmpty {
            tell(mainBot, "\(handed.joined(separator: ", ")) \(handed.count == 1 ? "is" : "are") already a project; any task went to \(handed.count == 1 ? "its manager" : "their managers").")
        }
        guard !adding.isEmpty else {
            if !notes.isEmpty { mainBot.queueNote("(App: " + notes.joined(separator: " ") + ")") }
            return
        }

        let text: String
        let add: String
        if adding.count == 1, let only = adding.first {
            let first = only.task.isEmpty ? "" : "\n\nThen its manager starts on: \(only.task)"
            text = "Add **\(only.folder.lastPathComponent)** as a project?\n\n`\(only.folder.path)`\n\nIts manager can read and change the files in this folder.\(first)"
            add = "Add as project"
        } else {
            // The same task for all of them is said once, under the list.
            let tasks = Set(adding.map(\.task))
            let shared = tasks.count == 1 ? tasks.first ?? "" : nil
            let list = adding.map { "- **\($0.folder.lastPathComponent)** `\($0.folder.path)`" + (shared != nil || $0.task.isEmpty ? "" : " — then: \($0.task)") }
            let then = shared.map { $0.isEmpty ? "" : "\n\nThen each manager starts on: \($0)" } ?? ""
            text = "Add these \(adding.count) folders as projects?\n\n" + list.joined(separator: "\n") + then + "\n\nEach gets a manager that can read and change the files in its folder. To leave some out, tell the main bot instead."
            add = "Add all \(adding.count)"
        }
        let question = tell(mainBot, text, choices: [Choice(label: add, detail: nil, recommended: true), Choice(label: "Don't add", detail: nil, recommended: false)])
        projectQuestions[question] = adding
        // So it can answer "is that all of them?" without seeing the card.
        notes.append("The user now sees a card asking to add \(adding.count == 1 ? "this folder" : "these \(adding.count) folders") as projects: \(adding.map(\.folder.path).joined(separator: ", ")). Nothing is added until they pick.")
        mainBot.queueNote("(App: " + notes.joined(separator: " ") + ")")
    }

    /// What marks a folder as a project's own.
    static let projectMarkers: Set<String> = [".git", "package.json", "Package.swift", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "CMakeLists.txt", "Makefile", "manifest.json"]
    /// Folders never looked into for projects.
    static let skippedFolders: Set<String> = ["node_modules", "build", "dist", "target", "DerivedData", "Pods", "vendor", "venv"]

    /// The projects below `folder`: the outermost folders with a project marker (an Xcode
    /// project counts too), sorted by path. A project's own subfolders are not projects again.
    static func projectFolders(in folder: URL, depth: Int = 5) -> [URL] {
        let files = FileManager.default
        guard depth > 0, let inside = try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return [] }
        var found: [URL] = []
        for child in inside.sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }) {
            guard (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                  !skippedFolders.contains(child.lastPathComponent), child.pathExtension != "xcodeproj", child.pathExtension != "app" else { continue }
            let names = (try? files.contentsOfDirectory(atPath: child.path)) ?? []
            if names.contains(where: { projectMarkers.contains($0) || $0.hasSuffix(".xcodeproj") || $0.hasSuffix(".xcworkspace") }) {
                found.append(child.standardizedFileURL)
            } else {
                found += projectFolders(in: child, depth: depth - 1)
            }
        }
        return found
    }

    /// An absolute path, `~`, or a `file://` URL, as a folder URL; nil for anything relative.
    static func folderURL(_ path: String) -> URL? {
        var path = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("file://") { path = URL(string: path)?.path ?? path }
        path = (path as NSString).expandingTildeInPath
        guard path.hasPrefix("/") else { return nil }
        return URL(filePath: path, directoryHint: .isDirectory).standardizedFileURL
    }

    /// Forgets an app card that was answered in words, undoing what it waited to do; says what
    /// the card was about. Nil if `id` is no app card waiting for a pick.
    private func closeAppCard(_ id: UUID) -> String? {
        if let proposal = buildQuestions.removeValue(forKey: id) {
            managers[proposal.requester]?.queueNote("(App: The user did not install \(proposal.build.label); they wrote instead.)")
            return "asking to install the ClaudeCodeBot build \(proposal.build.label)"
        }
        if let folders = projectQuestions.removeValue(forKey: id) {
            return "asking to add \(folders.map(\.folder.lastPathComponent).joined(separator: ", ")) as projects"
        }
        if let proposal = installQuestions.removeValue(forKey: id) {
            try? FileManager.default.removeItem(at: proposal.folder)
            return "asking to install the plugin \"\(proposal.manifest.title)\""
        }
        if let folder = folderQuestions.removeValue(forKey: id) {
            answerFolder(folder, allowed: false)
            return "asking to let Maintainer read \(folder.path)"
        }
        if let review = codexQuestions.removeValue(forKey: id) {
            let agent = codexReviews.first { $0.id == review }?.agent ?? "the subagent"
            return "asking whether \(agent) should fix Codex's findings once more (it stays stopped at max rounds; the report still has the buttons)"
        }
        return nil
    }

    /// Your pick on a "make them projects?" card.
    private func answerProjects(_ folders: [(folder: URL, task: String)], add: Bool) {
        let paths = folders.map(\.folder.path).joined(separator: ", ")
        guard add else {
            mainBot.queueNote("(App: The user chose not to add \(paths) as projects.)")
            return
        }
        var added: [Project] = []
        for (folder, task) in folders {
            let project = addProject(folder: folder, select: false)
            if !task.isEmpty { managers[project.id]?.relay(task) }
            added.append(project)
        }
        let names = added.map(\.name).joined(separator: ", ")
        let anyTask = folders.contains { !$0.task.isEmpty }
        tell(mainBot, "Added \(names) as \(added.count == 1 ? "a project" : "projects")\(anyTask ? "; the managers with a task are on it" : "").", sourceID: added.count == 1 ? added.first?.id : nil)
        mainBot.queueNote("(App: The user added \(names) as projects (\(paths)); they are in the project list now.)")
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
        let name = Self.botName(name)
        let job = job.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !job.isEmpty else { return .empty }
        if let existing = standaloneBots.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            return plugin == nil || existing.plugin == plugin ? .existing(existing) : .taken
        }
        // A name that would pass for someone else in a group chat or in an @.
        let others = [mainBot.name, maintainer.name, "User", "App", "Notice"] + projects.filter { !$0.isBot }.map(\.name)
        if others.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { return .taken }
        if let plugin, removedPluginBots.contains(Self.removalKey(plugin: plugin, name: name)) { return .removedByUser }
        let id = UUID()
        let folder = root.appending(path: "bots/\(id.uuidString)")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let shape = avatar.flatMap { Self.avatars.contains($0) ? $0 : nil } ?? nextAvatar()
        let project = Project(id: id, name: name, folder: folder, avatar: shape, job: job, plugin: plugin)
        prepareNotesFolder(for: project)
        attach(project)
        saveProjects()
        tell(mainBot, "New bot \"\(name)\"\(creator.map { " (made by \($0))" } ?? ""): \(Self.firstLine(of: job))", sourceID: id)
        briefAwakeMainBot()
        if setUp {
            managers[id]?.relay("""
            (App) You were just created. Your job: \(job)
            If it should happen at fixed times, add those jobs to your routines file now; if it is a report, also do the first one now. Then introduce yourself to the user in one sentence.
            """)
        }
        return .made(project)
    }

    /// A bot's name as it is kept: one line, no quotes or @, at most 40 characters.
    static func botName(_ name: String) -> String {
        let line = name.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let cleaned = line.filter { !"\"@<>`".contains($0) }.trimmingCharacters(in: .whitespaces)
        return String(cleaned.prefix(40)).trimmingCharacters(in: .whitespaces)
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
        // It leaves its groups, and its questions there can no longer be answered.
        for group in groups where group.members.contains(id) {
            let rest = group.members.filter { $0 != id }
            if let chat = groupChats[group.id] { tell(chat, "\(project.name) left: the bot was removed.") }
            if rest.isEmpty {
                deleteGroup(group.id)
            } else {
                editGroup(group.id, name: group.name, members: rest)
            }
        }
        for chat in [mainBot] + Array(groupChats.values) {
            for line in chat.messages where line.sourceID == id && line.isOpenQuestion {
                chat.markAnswered(Bot.noLongerNeeded, in: line.id)
            }
        }
        briefAwakeMainBot()
        refreshWaiting()
        tell(mainBot, "Removed the bot \"\(project.name)\". Its folder stays at \(project.folder.path).")
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

    // MARK: Network and quiet runs

    private var watchTask: Task<Void, Never>?
    /// Whether Claude's API answers again (tests replace it).
    public var networkProbe: @Sendable () async -> Bool = NetworkProbe.anthropic

    /// Every `interval` seconds: bots cut off by the network carry on once it is back, and runs
    /// that went quiet for `settings.stallReminderMinutes` get a reminder in their chat.
    public func startWatching(every interval: TimeInterval = 20) {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkNetwork()
                self?.checkStalls()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    /// Asks the probe only while a bot waits for the network.
    public func checkNetwork(now: Date? = nil) async {
        let waiting = ([mainBot] + Array(managers.values)).filter { $0.outage != nil }
        guard !waiting.isEmpty, await networkProbe() else { return }
        let date = now ?? Date()
        for bot in waiting { bot.networkRestored(at: date) }
    }

    public func checkStalls(now: Date = Date()) {
        let interval = settings.stallReminderInterval
        for bot in [mainBot] + Array(managers.values) {
            bot.checkStall(now: now, after: interval)
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
                "- \(project.name) (folder \(project.folder.path)): memory file \(project.notesFolder.appending(path: "memory.md").path); inbox file \(project.inboxURL.path)\(openQuestionNote(project))"
            }.joined(separator: "\n")
        let bots = standaloneBots
        let botLines = bots.isEmpty ? "" : "\n(App: Bots of their own, which you reach the same way.)\n" + bots.map { bot in
            "- \(bot.name) (\(Self.firstLine(of: bot.job ?? ""))): memory file \(bot.notesFolder.appending(path: "memory.md").path); inbox file \(bot.inboxURL.path)\(openQuestionNote(bot))"
        }.joined(separator: "\n")
        let maintainerLine = "- Maintainer (looks after ClaudeCodeBot itself: plugins, components): memory file \(maintainerProject.notesFolder.appending(path: "memory.md").path); inbox file \(maintainerProject.inboxURL.path)\(openQuestionNote(maintainerProject))"
        let asking = everyProject.contains { managers[$0.id]?.openQuestion != nil }
        let cardLine = asking ? "\n(App: A decision marked \"open question in its chat\" already has its card there. To bring it up, write <open-question from=\"its name\"/> in your reply: the app shows that same card here. Never write a new choices block for it.)" : ""
        let teamLines = teams.map { "- \($0.name) (\($0.title)): \($0.description)" }.joined(separator: "\n")
        return """
        (App: Project list. To check progress, read the memory file and do not wake the manager; to hand off work, append a line to the end of the inbox file.)
        \(projectLines)\(botLines)
        \(maintainerLine)\(cardLine)
        (App: Temporary teams you can start, with <team name="name">task</team>.)
        \(teamLines)
        \(componentBriefing())
        """
    }

    /// "; open question in its chat: …" for a project or bot whose own chat has a card waiting.
    private func openQuestionNote(_ project: Project) -> String {
        guard let question = managers[project.id]?.openQuestion else { return "" }
        return "; open question in its chat: \(Self.firstLine(of: question.text))"
    }

    /// The main bot brings up a decision a project or bot already asked about in its own chat:
    /// that same card shows here (a copy kept in step with it), so the user is asked once. A pick
    /// or words on it go to the project, and both cards show the answer.
    private func showOpenQuestion(of name: String) {
        let wanted = name.trimmingCharacters(in: .whitespaces).lowercased()
        guard let project = everyProject.first(where: { $0.name.lowercased() == wanted }) else {
            mainBot.queueNote("(App: There is no project or bot called \"\(name)\"; no card was shown.)")
            return
        }
        guard let question = managers[project.id]?.openQuestion else {
            tell(mainBot, "\(project.name) has no question waiting in its chat now.", sourceID: project.id)
            mainBot.queueNote("(App: \(project.name) has no open card, so none was shown. Do not ask its question again yourself; if it still needs the user, it asks in its own chat.)")
            return
        }
        tell(mainBot, "\(project.name): \(question.text)", choices: question.choices, sourceID: project.id, sourceMessageID: question.id)
        refreshWaiting()
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
        "(App: Components in the chat. <show name=\"name\">JSON</show> draws one; <show name=\"name\" command=\"git diff --stat\"></show> fills it with what that command prints instead (run in your project folder once the user allows it; JSON output is used as the data, other output as one string; the card has a refresh button). A component whose usage has a \"Command:\" line needs only <show name=\"name\"></show>. <component name=\"name\">request</component> asks Maintainer to change one.)\n" + components.catalog()
    }

    /// The folder a message's component commands run in: the project of the bot that wrote it
    /// (a group chat's lines say who), else the chat's own bot's.
    public func commandFolder(for message: ChatMessage, in bot: Bot) -> URL {
        if let source = message.sourceID, let writer = member(source) { return writer.profile.workingDirectory }
        return bot.profile.workingDirectory
    }

    /// What drawing this chat's component commands needs.
    public func commandContext(for bot: Bot) -> ChatPayload.CommandContext {
        ChatPayload.CommandContext(runs: componentCommands) { [unowned self] message in commandFolder(for: message, in: bot) }
    }

    /// A component card's command: `approve` is the user allowing it (remembered for that
    /// folder); `force` runs it again (the refresh button). A command not allowed never runs.
    /// `command` and `folder` are what the card showed: allowing needs them, and nothing runs
    /// when the card's command or folder has changed since (say, its about.md was edited), so
    /// what is allowed and run is always what the user saw.
    public func runComponentCommand(messageID: UUID, index: Int, in bot: Bot, command shown: String? = nil, folder shownFolder: String? = nil, approve: Bool = false, force: Bool = false) async {
        guard let message = bot.messages.first(where: { $0.id == messageID }),
              message.shown.indices.contains(index) else { return }
        let instance = message.shown[index]
        guard let command = ChatPayload.command(of: instance, in: message, library: components) else { return }
        let folder = commandFolder(for: message, in: bot)
        if approve, shown == nil || shownFolder == nil { return }
        if let shown, shown != command { return }
        if let shownFolder, URL(filePath: shownFolder).standardizedFileURL.path != folder.standardizedFileURL.path { return }
        if approve { componentCommands.approve(command, in: folder) }
        await componentCommands.run(card: "\(message.id.uuidString)/\(index)", command: command, in: folder, force: force)
    }

    /// Someone asked for a component change: the user beside a component, or a bot with a
    /// <component> tag. Maintainer hands it to a component-editor agent in the background,
    /// then reviews, checks and commits it.
    public func requestComponentChange(_ name: String, request: String, from asker: String, files: [URL] = []) {
        let name = ComponentLibrary.safeName(name)
        guard !name.isEmpty else { return }
        let request = request.trimmingCharacters(in: .whitespacesAndNewlines)
        // Pictures alone say it: what is wrong is in them.
        let said = request.isEmpty ? "see the attached picture\(files.count == 1 ? "" : "s")" : request
        components.markWorking(name, change: said)
        let exists = components.names.contains(name)
        let pictures = files.isEmpty ? "" : " (Attached: \(files.count == 1 ? "a picture" : "\(files.count) pictures") of how it looks now or should look.)"
        handToMaintainer(exists
            ? "\(asker)'s request for the component \"\(name)\": \(said)\(pictures)"
            : "\(asker) wants a new component \"\(name)\": \(said)\(pictures)", files: files)
    }

    // MARK: Temporary teams

    /// Acts on the tags in a bot's reply. `project` is the manager that asked, nil for the main bot.
    func handle(_ requests: [BotRequest], from project: Project?) {
        // Folders asked for in one reply are asked about on one card.
        let folders = requests.compactMap { request -> (String, String)? in
            if case let .newProject(folder, task) = request { return (folder, task) }
            return nil
        }
        // Only the main bot adds projects; managers stay in their own folder.
        if project == nil, !folders.isEmpty { proposeProjects(folders) }
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
                guard project == nil || project?.isMaintainer == true else { break }
                switch makeBot(name: name, job: job, setUp: true, by: project?.name) {
                case let .existing(old):
                    tell(mainBot, "There is already a bot called \"\(old.name)\"; nothing new was made. To change its job, tell it, or remove it from its menu first.", sourceID: old.id)
                case .taken:
                    tell(mainBot, "No bot was made: the name \"\(Self.botName(name))\" is already used by a project or the app.")
                case .made, .empty, .removedByUser:
                    break
                }
            case .newProject:
                break
            case let .installBuild(path, note):
                if let project { proposeBuild(path, note: note, from: project) }
            case .appScreenshot:
                if let project { sendScreenshot(to: project) }
            case let .openQuestion(name):
                // Only the main bot brings up other bots' cards.
                if project == nil { showOpenQuestion(of: name) }
            case let .plugin(request):
                if project?.isMaintainer != true {
                    handToMaintainer("\(project?.name ?? mainBot.name)'s request for ClaudeCodeBot: \(request)")
                }
            case let .codexReview(agent, folder, base, note):
                requestCodexReview(agent: agent, folder: folder, base: base, note: note, from: project?.id ?? Self.mainBotID)
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
            tell(mainBot, "\(spec.title) could not start: \(error.localizedDescription)")
            return nil
        }
        runningTeams.append(run)
        process.send(TeamPrompts.task(task))
        Task { [weak self] in
            var reported = false
            for await event in process.events {
                switch event {
                case let .usage(total, tokens):
                    // A team runs one turn, so its running total is what it cost.
                    self?.record(total, tokens: tokens, by: spec.title)
                case .trace, .permission, .permissionCancelled, .connectionTrouble:
                    // Teams are started without asking (asksPermission is off), so nothing waits.
                    break
                case let .reply(text, _):
                    guard !reported else { continue }
                    reported = true
                    if let self { tell(mainBot, "\(spec.title): \(ReplyParser.parseAll(text).body)") }
                    process.finish()
                case let .exited(status, stderr):
                    if !reported {
                        if let self { tell(mainBot, "\(spec.title) did not finish: \(stderr.isEmpty ? "exit code \(status)" : stderr)") }
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
        - Components live in ccb-components/components/<name>/ (template.html, about.md). Never edit template.html or about.md yourself:
          every component request (a new component or a change) goes to a ccb-core:component-editor agent with the Agent tool, run in the background, one agent per component, so several components can be worked on at once. Give it the component folder's path and the request (and any attached pictures).
          Two editors never work on the same component folder at once: if another request comes for a component already being edited, send it to that running editor with SendMessage, or keep it until that editor returns.
          While editors run, stay free for new requests. When an editor returns, review its change, then do the rest yourself, one component at a time: bump the ccb-components version, run the check, then git add, commit and tag as above.
        - When a component request says /design or asks for designs to choose from, first make them a Claude Design: with the Artifact tool, quickstart with intent "design", publish from the Design type, using the look of ccb-components (its templates' colours, type and spacing) as the design system, and reply with the claude.ai link. Build the chosen one into ccb-components only after the user picks.
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

    /// The component editor's agent file, as this build of the app writes it.
    static let componentEditorAgent = """
        ---
        name: component-editor
        description: Edits one component in the ClaudeCodeBot chat (template.html and about.md). Give it the component folder's path and what to change.
        model: haiku
        tools: Read, Write, Edit
        ---
        \(ComponentPrompts.system)

        """

    /// `ccb-core`: ClaudeCodeBot's own agents, starting with the component editor (Haiku).
    /// The editor's file follows the app: rewritten whenever the built-in text changes.
    static func prepareCorePlugin(in library: URL) {
        let files = FileManager.default
        let plugin = library.appending(path: "ccb-core")
        let editor = plugin.appending(path: "claude/agents/component-editor.md")
        let isNew = !files.fileExists(atPath: plugin.path)
        if isNew || files.fileExists(atPath: editor.deletingLastPathComponent().path),
           (try? String(contentsOf: editor, encoding: .utf8)) != componentEditorAgent {
            try? files.createDirectory(at: editor.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data(componentEditorAgent.utf8).write(to: editor)
        }
        guard isNew else { return }
        try? files.createDirectory(at: plugin.appending(path: "claude/.claude-plugin"), withIntermediateDirectories: true)
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
        bot.autoMode = { [weak self] in self?.settings.autoApprovesSafeActions ?? false }
    }

    /// Turns auto mode for bots on or off. Awake bots start again (once free) in the new mode.
    public func setAutoApprovesSafeActions(_ on: Bool) {
        guard on != settings.autoApprovesSafeActions else { return }
        settings.autoApprove = on
        settings.save(to: settingsURL)
        for bot in [mainBot] + Array(managers.values) where bot.phase != .asleep {
            Task { await bot.restart(divider: on ? "Handoff → auto-approving safe actions" : "Handoff → asking before tools") }
        }
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
        // A question in a bot's own chat, else its memory's "Waiting on you".
        let own = everyProject.flatMap { project -> [Waiting] in
            if let question = self.managers[project.id]?.messages.last(where: \.isOpenQuestion) {
                return [Waiting(projectID: project.id, text: Self.firstLine(of: question.text), messageID: question.id)]
            }
            return MemoryFile.items(at: project.notesFolder.appending(path: "memory.md"), section: "Waiting on you")
                .map { Waiting(projectID: project.id, text: $0) }
        }
        // Copies of a bot's question are counted with the original.
        let main = mainBot.messages.filter { $0.isOpenQuestion && $0.sourceMessageID == nil }.map {
            Waiting(projectID: Self.mainBotID, text: Self.firstLine(of: $0.text), messageID: $0.id)
        }
        let inGroups = groups.flatMap { group in
            (groupChats[group.id]?.messages ?? []).filter { $0.isOpenQuestion && $0.sourceMessageID == nil }.map {
                Waiting(projectID: $0.sourceID ?? group.id, text: Self.firstLine(of: $0.text), messageID: $0.id, groupID: group.id)
            }
        }
        let ignored = Set(settings.ignoredWaiting ?? [])
        waiting = (own + main + inGroups).filter { !ignored.contains($0.id) }
    }

    /// A group's chat holds a question waiting for you (and not ignored).
    public func groupHasQuestion(_ id: UUID) -> Bool {
        let ignored = Set(settings.ignoredWaiting ?? [])
        return groupChats[id]?.messages.contains {
            $0.isOpenQuestion && !ignored.contains(Waiting(projectID: $0.sourceID ?? id, text: Self.firstLine(of: $0.text)).id)
        } == true
    }

    /// Takes an item off "Waiting on you" (and its dot and the Dock count) without answering it.
    public func ignoreWaiting(_ item: Waiting) {
        var ignored = settings.ignoredWaiting ?? []
        guard !ignored.contains(item.id) else { return }
        ignored.append(item.id)
        // Only the last 200: old ones are long answered or gone.
        settings.ignoredWaiting = Array(ignored.suffix(200))
        settings.save(to: settingsURL)
        refreshWaiting()
    }

    /// How many items you ignored.
    public var ignoredWaitingCount: Int { settings.ignoredWaiting?.count ?? 0 }

    /// Brings every ignored item back.
    public func showIgnoredWaiting() {
        settings.ignoredWaiting = nil
        settings.save(to: settingsURL)
        refreshWaiting()
    }

    /// The single place a pick is made, from any chat. A pick on a copy of a bot's question
    /// answers the original, and a pick on the original settles its copies; a pick on a bot's
    /// line in a group goes back to that bot there.
    @discardableResult
    public func choose(_ index: Int, in messageID: UUID, of bot: Bot) -> Bool {
        defer { refreshWaiting() }
        guard let message = bot.messages.first(where: { $0.id == messageID }) else { return false }
        if let proposal = installQuestions[messageID] {
            guard message.isOpenQuestion else { return false }
            installQuestions[messageID] = nil
            bot.markChosen(index, in: messageID)
            if index == 0 {
                Task { await finishInstall(proposal) }
            } else {
                try? FileManager.default.removeItem(at: proposal.folder)
            }
            return true
        }
        if let proposal = buildQuestions[messageID] {
            guard message.isOpenQuestion else { return false }
            buildQuestions[messageID] = nil
            bot.markChosen(index, in: messageID)
            answerBuild(proposal.build, requester: proposal.requester, note: proposal.note, install: index == 0)
            return true
        }
        if let proposal = projectQuestions[messageID] {
            guard message.isOpenQuestion else { return false }
            projectQuestions[messageID] = nil
            bot.markChosen(index, in: messageID)
            answerProjects(proposal, add: index == 0)
            return true
        }
        if let folder = folderQuestions[messageID] {
            guard message.isOpenQuestion else { return false }
            folderQuestions[messageID] = nil
            bot.markChosen(index, in: messageID)
            answerFolder(folder, allowed: index == 0)
            return true
        }
        if let review = codexQuestions[messageID] {
            guard message.isOpenQuestion else { return false }
            codexQuestions[messageID] = nil
            bot.markChosen(index, in: messageID)
            if index == 0 { fixCodexOnceMore(review) } else { acceptCodexReview(review) }
            return true
        }
        if let group = group(of: bot), message.role == .bot {
            guard message.isOpenQuestion, let label = message.choices?[safe: index]?.label else { return false }
            guard answerInGroup(group.id, message, with: "The user picked: \(label)") else {
                // Its bot was removed or taken out: nobody would get the answer.
                bot.markAnswered(Bot.noLongerNeeded, in: messageID)
                return false
            }
            bot.markChosen(index, in: messageID)
            return true
        }
        if isCalledIn(message, in: bot) {
            guard message.isOpenQuestion, let label = message.choices?[safe: index]?.label else { return false }
            guard answerCallIn(message, in: bot, with: "The user picked: \(label)") else {
                bot.markAnswered(Bot.noLongerNeeded, in: messageID)
                return false
            }
            bot.markChosen(index, in: messageID)
            return true
        }
        if message.role == .notice, let questionID = message.sourceMessageID {
            guard message.isOpenQuestion else { return false }
            guard let original = message.sourceID.flatMap(member), original.choose(index, in: questionID) else {
                // The question was settled or is gone: so is this copy.
                closeCopy(of: message, in: bot)
                return false
            }
            bot.markChosen(index, in: messageID)
            return true
        }
        guard bot.choose(index, in: messageID) else { return false }
        forEachCopy(of: messageID) { chat, copy in chat.markChosen(index, in: copy.id) }
        return true
    }

    /// What a component sent back in words, with any pictures the user attached in it (`files`,
    /// e.g. in choices' "Other"): an answer to the question in that message (from any chat, kept
    /// in step like a pick), or, for a message that asks nothing, just a reply. The pictures are
    /// kept in the chat's attachments folder and reach the bot as a message's attachments do.
    @discardableResult
    public func answer(_ text: String, files: [URL] = [], in messageID: UUID, of bot: Bot) -> Bool {
        defer { refreshWaiting() }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty else { return false }
        guard let message = bot.messages.first(where: { $0.id == messageID }) else { return false }
        let group = group(of: bot)
        let shown = Bot.answerLabel(text, files: files)
        /// For a bot told in words (a group or a called-in bot): the pictures, kept in `bot`'s
        /// folder, as a line it reads and as attachments on your line.
        func kept() -> (note: String, attachments: [Attachment]) {
            let attachments = files.compactMap { group != nil ? keep($0, in: bot) : bot.keep($0) }
            let note = attachments.isEmpty ? "" : "\n(Attachments:\n" + attachments.map { "- " + $0.url.path }.joined(separator: "\n") + ")"
            return (note, attachments)
        }
        guard message.isOpenQuestion else {
            // A question already answered stays answered.
            if message.choices?.isEmpty == false { return false }
            if group != nil || isCalledIn(message, in: bot) {
                // A component on a bot's line answers that bot, not everyone.
                if group != nil { guard message.role == .bot, message.sourceID != nil else { return false } }
                let (note, attachments) = kept()
                var line = ChatMessage(role: .user, text: text)
                line.attachments = attachments.isEmpty ? nil : attachments
                bot.post(line, unread: false)
                let said = "The user answered with the component: \(shown)\(note)"
                return group.map { answerInGroup($0.id, message, with: said) } ?? answerCallIn(message, in: bot, with: said)
            }
            bot.send(text, files: files, replyingTo: nil)
            return true
        }
        // Words on one of the app's own cards (add these projects? install this?) instead of a
        // pick: the card closes with nothing done, and the bot is told so plainly.
        if message.role == .notice, message.sourceMessageID == nil, let card = closeAppCard(messageID) {
            bot.markAnswered(shown, in: messageID)
            bot.send(text, files: files, replyingTo: messageID, appNote: "(App: The user wrote this on the app's card \(card) instead of picking an option. That card is closed and nothing was done. To ask again, put the tag in your reply again; never say the app has it unless your reply carries the tag.)")
            return true
        }
        /// Pictures with the answer: kept, and shown on a line of yours in this chat, so you and
        /// the bots reading it later see them (the question shows the words).
        func keptAndShown() -> String {
            let (note, attachments) = kept()
            if !attachments.isEmpty {
                var line = ChatMessage(role: .user, text: "")
                line.attachments = attachments
                bot.post(line, unread: false)
            }
            return note
        }
        if let group, message.role == .bot {
            guard answerInGroup(group.id, message, with: "The user answered: \(shown)\(keptAndShown())") else {
                bot.markAnswered(Bot.noLongerNeeded, in: messageID)
                return false
            }
            bot.markAnswered(shown, in: messageID)
            return true
        }
        if isCalledIn(message, in: bot) {
            guard answerCallIn(message, in: bot, with: "The user answered: \(shown)\(keptAndShown())") else {
                bot.markAnswered(Bot.noLongerNeeded, in: messageID)
                return false
            }
            bot.markAnswered(shown, in: messageID)
            return true
        }
        if message.role == .notice, let questionID = message.sourceMessageID {
            guard let original = message.sourceID.flatMap(member), original.answer(text, files: files, in: questionID) else {
                closeCopy(of: message, in: bot)
                return false
            }
            bot.markAnswered(shown, in: messageID)
            return true
        }
        guard bot.answer(text, files: files, in: messageID) else { return false }
        forEachCopy(of: messageID) { chat, copy in chat.markAnswered(shown, in: copy.id) }
        return true
    }

    /// A line from the app in `chat`, read at once if you are looking at it. Returns its id.
    @discardableResult
    func tell(_ chat: Bot, _ text: String, choices: [Choice]? = nil, sourceID: UUID? = nil, sourceMessageID: UUID? = nil) -> UUID {
        chat.notice(text, choices: choices, sourceID: sourceID, sourceMessageID: sourceMessageID)
        if selectedBot === chat { chat.markRead() }
        return chat.messages.last?.id ?? UUID()
    }

    /// A member asked something (may it use a tool?) while taking its turn in a group: the
    /// question shows there too, and a pick on that copy answers the original.
    private func mirrorIntoGroup(_ message: ChatMessage, from id: UUID) {
        guard let groupID = groupTurns[id], let chat = groupChats[groupID], let name = speakerName(for: id) else { return }
        tell(chat, "\(name): \(message.text)", choices: message.choices, sourceID: id, sourceMessageID: message.id)
    }

    /// Copies of the question `messageID` (in the main bot's chat, shown there by its
    /// <open-question> tag, or in a group).
    private func forEachCopy(of messageID: UUID, _ body: (Bot, ChatMessage) -> Void) {
        for chat in [mainBot] + Array(groupChats.values) {
            for copy in chat.messages where copy.role == .notice && copy.sourceMessageID == messageID {
                body(chat, copy)
            }
        }
    }

    /// A bot's question was settled in its own chat: so are its copies.
    private func closeCopies(of message: ChatMessage) {
        forEachCopy(of: message.id) { chat, copy in
            if copy.isOpenQuestion { closeCopy(of: copy, in: chat) }
        }
        refreshWaiting()
    }

    /// A copy whose question can no longer be answered: show what became of it.
    private func closeCopy(of copy: ChatMessage, in chat: Bot) {
        let original = copy.sourceID.flatMap(member)?.messages.first { $0.id == copy.sourceMessageID }
        if let chosen = original?.chosen {
            chat.markChosen(chosen, in: copy.id)
        } else {
            chat.markAnswered(original?.answer ?? Bot.noLongerNeeded, in: copy.id)
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
        if let group = group(of: bot) {
            postToGroup(group.id, text, files: files, replyingTo: replyID)
        } else {
            // Bots you named with @ are called in: they answer here too, after reading the chat.
            let called = calledIn(text, into: bot)
            // Components you named with / (picked from the input box's list) are explained to it.
            let notes = [heardSinceLastTurn(in: bot), callInNote(called), components.mentionNote(for: text)].compactMap { $0 }
            bot.send(text, files: files, replyingTo: replyID, appNote: notes.isEmpty ? nil : notes.joined(separator: "\n"))
            if !called.isEmpty, let newest = bot.messages.last(where: { $0.role == .user }) {
                startCallIn(in: bot, to: called, newest: newest.id, ask: nil)
            }
        }
    }

    /// Runs a plugin command in the plugin host.
    public func runCommand(_ id: String) async {
        guard let pluginHost else { return }
        do {
            _ = try await pluginHost.command(id)
        } catch {
            tell(mainBot, "Command \"\(id)\" failed: \(error.localizedDescription)")
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
                tell(mainBot, "\(title): \(params["text"]?.string ?? "")")
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
                case .taken: throw HostMessage.HostError(message: "The name \"\(name)\" is taken (by another bot, a project, or the app).")
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
        bot.onCodexSettings = { [weak self] _ in self?.retellCodexRules(to: project.id) }
        bot.onSpend = { [weak self] amount in self?.record(amount, by: project.name) }
        bot.onTokens = { [weak self] tokens in self?.record(0, tokens: tokens, by: project.name) }
        bot.wakeNote = { [weak self] in
            guard let self else { return "" }
            return [componentBriefing(), developerBriefing(for: project), managers[project.id].map(codexBriefing(for:)) ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
        giveClaudeParts(to: bot)
        bot.onReply = { [weak self, weak bot] _, _ in
            guard let self else { return }
            if project.isMaintainer { components.finishWorking() }
            refreshWaiting()
            if selection == project.id { bot?.markRead() }
        }
        // Asked during a group turn, its question (may it use a tool?) shows in that group too.
        bot.onQuestion = { [weak self] message in
            guard let self else { return }
            mirrorIntoGroup(message, from: project.id)
            refreshWaiting()
        }
        bot.onQuestionSettled = { [weak self] message in self?.closeCopies(of: message) }
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
