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

        public var notesFolder: URL { folder.appending(path: ".bot") }
        public var inboxURL: URL { notesFolder.appending(path: "inbox.md") }
        /// Deck 維護, the built-in project whose folder is the plugin library.
        public var isMaintainer: Bool { id == Workspace.maintainerID }
    }

    /// Deck 維護's fixed id: its chat survives restarts, and it is never saved in projects.json.
    public static let maintainerID = UUID(uuidString: "DEC0DE00-0000-4000-8000-00000000DEC0")!

    /// Something a manager needs the user to decide: an open question in its chat, or else a
    /// line from its memory.md 「等你決定的事」.
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
    /// Deck 維護's project (the plugin library); not in `projects`, which are the user's own.
    public let maintainerProject: Project
    /// The plugin library becomes a git repo in the background; done when this finishes.
    public private(set) var pluginLibraryReady: Task<Void, Never>!
    public private(set) var managers: [UUID: Bot] = [:]
    public let components: ComponentLibrary
    /// Plugins for Deck itself: `~/.deck/plugins/` and the ones shipped with the app.
    public let plugins: PluginRegistry
    /// Runs plugins' program parts (Node), when a script for it was given.
    public let pluginHost: PluginHostClient?
    private let root: URL
    private let makeBot: BotFactory
    /// Starts processes that are not bots: temporary teams and the component team.
    private let launcher: AgentLauncher
    private var subscriptions: Set<AnyCancellable> = []

    /// `root` is `~/.deck`: the main bot's home, each manager's chat, the project list and the
    /// plugin library. `builtInPlugins` is the folder of plugins shipped inside the app.
    public init(
        root: URL,
        builtInPlugins: URL? = nil,
        pluginHostScript: URL? = nil,
        locateNode: @escaping () -> URL? = { ClaudeExecutableLocator(command: "node").locate() },
        validateClaudePart: ((URL) async -> String?)? = nil,
        checkCommand: String? = nil,
        gitForPlugins: PluginLibraryGit? = nil,
        launcher: @escaping AgentLauncher = { _ in throw CocoaError(.featureUnsupported) },
        makeBot: @escaping BotFactory
    ) {
        self.root = root
        self.makeBot = makeBot
        self.launcher = launcher
        let library = root.appending(path: "plugins")
        let componentFolder = Self.prepareComponentPlugin(in: library, movingFrom: root.appending(path: "components"))
        Self.prepareTeamsPlugin(in: library, movingFrom: root.appending(path: "teams"))
        Self.prepareCorePlugin(in: library)
        Self.writeLibraryGuide(in: library, builtIns: builtInPlugins)
        let git = gitForPlugins ?? PluginLibraryGit(folder: library)
        maintainerProject = Project(id: Self.maintainerID, name: "Deck 維護", folder: library, avatar: "diamond")
        plugins = PluginRegistry(library: library, builtIns: builtInPlugins, validateClaudePart: validateClaudePart, git: git)
        pluginHost = pluginHostScript.map { PluginHostClient(script: $0, locateNode: locateNode) }
        components = ComponentLibrary(folder: componentFolder)
        components.git = git.isAvailable ? git : nil
        self.checkCommand = checkCommand
        let mainHome = root.appending(path: "main")
        try? FileManager.default.createDirectory(at: mainHome, withIntermediateDirectories: true)
        mainBot = makeBot(.main(home: mainHome), BotStore(directory: mainHome))
        mainBot.wakeNote = { [weak self] in self?.projectBriefing() ?? "" }
        mainBot.extraDirectories = { [weak self] in self?.everyProject.map(\.notesFolder) ?? [] }
        mainBot.pluginDirectories = { [weak self] in self?.plugins.claudeDirectories() ?? [] }
        mainBot.onReply = { [weak self] _, _ in
            guard let self else { return }
            deliverInboxes()
            refreshWaiting()
            if selection == nil { mainBot.markRead() }
        }
        mainBot.onRequests = { [weak self] requests in self?.handle(requests, from: nil) }
        teams = loadTeams()
        components.otherFolders = { [weak self] in
            (self?.plugins.componentFolders() ?? []).filter { $0.standardizedFileURL != componentFolder.standardizedFileURL }
        }
        components.rescan()
        components.onCatalogChanged = { [weak self] in
            guard let self else { return }
            let note = "（App：組件有更新，下面是最新的用法。）\n" + componentBriefing()
            for bot in [mainBot] + Array(managers.values) { bot.queueNote(note) }
        }
        plugins.onNotice = { [weak self] text in
            self?.mainBot.notice(text)
            if self?.selection == nil { self?.mainBot.markRead() }
        }
        plugins.onBroken = { [weak self] plugin, problem in
            self?.handToMaintainer("（App：熱更新檢查）插件「\(plugin)」壞了，Deck 先用上一版或先停用。請修好：\(problem)")
        }
        plugins.onUpdated = { [weak self] plugin, old in
            guard let self else { return }
            mainBot.notice("插件「\(plugin.manifest.title)」更新了：\(old) → \(plugin.manifest.version)")
            if selection == nil { mainBot.markRead() }
        }
        connectPlugins(to: mainBot)
        startPluginHost()
        followClaudeParts()
        prepareNotesFolder(for: maintainerProject)
        approvedFolders = loadApprovedFolders()
        attach(maintainerProject)
        maintainer.extraDirectories = { [weak self] in self?.approvedFolders ?? [] }
        for project in loadProjects() where !project.isMaintainer {
            attach(project)
        }
        refreshWaiting()
        // Everything Deck writes into the library at start is in the first commit.
        let components = components
        pluginLibraryReady = Task {
            await Task.detached { git.prepare() }.value
            components.forgetHistory()
        }
    }

    /// The user's projects and Deck 維護.
    var everyProject: [Project] { projects + [maintainerProject] }

    /// How Deck 維護 runs `deck plugin check` (the Deck binary with --check-plugin).
    private let checkCommand: String?

    // MARK: Folders outside the library

    /// Folders you let Deck 維護 read (kept in `~/.deck/folders.json`).
    public private(set) var approvedFolders: [URL] = []
    /// Open 「may it read this folder?」 questions in the main chat, by message id.
    private var folderQuestions: [UUID: URL] = [:]
    private var foldersURL: URL { root.appending(path: "folders.json") }

    private func loadApprovedFolders() -> [URL] {
        guard let data = try? Data(contentsOf: foldersURL),
              let paths = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return paths.map { URL(filePath: $0) }
    }

    /// Deck 維護 asked to read `path`: ask you once (in the main chat); a folder you allowed
    /// before, or one inside it, is allowed at once.
    func requestFolder(_ path: String) {
        let folder = URL(filePath: (path as NSString).expandingTildeInPath).standardizedFileURL
        if approvedFolders.contains(where: { folder.path == $0.path || folder.path.hasPrefix($0.path + "/") }) {
            maintainer.relay("（App）\(folder.path) 之前已經同意過，可以直接讀。")
            return
        }
        mainBot.notice(
            "Deck 維護想讀「\(folder.path)」。只會讀，不會改那裡的檔案。可以嗎？",
            choices: [Choice(label: "可以讀", detail: "之後不用再問", recommended: false), Choice(label: "不要", detail: nil, recommended: false)],
            sourceID: Self.maintainerID
        )
        if let question = mainBot.messages.last { folderQuestions[question.id] = folder }
        if selection == nil { mainBot.markRead() }
        refreshWaiting()
    }

    /// Your answer to a folder question.
    private func answerFolder(_ folder: URL, allowed: Bool) {
        guard allowed else {
            maintainer.relay("（App）使用者不讓你讀 \(folder.path)。換個做法，或說明做不了。")
            return
        }
        approvedFolders.append(folder)
        let data = try? JSONEncoder().encode(approvedFolders.map(\.path))
        try? data?.write(to: foldersURL, options: .atomic)
        let maintainer = maintainer
        Task {
            // A new session that can open it (--add-dir), then carry on.
            await maintainer.restart(divider: "交接 → 可以讀 \(folder.lastPathComponent)")
            maintainer.relay("（App）使用者同意了，你現在可以讀 \(folder.path)（只讀，不要改那裡的檔案）。繼續剛才的工作。")
        }
    }

    /// Deck 維護's bot.
    public var maintainer: Bot {
        managers[Self.maintainerID]!
    }

    /// Gives Deck 維護 a job, the way the main bot hands work to a manager.
    public func handToMaintainer(_ text: String) {
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
        let used = Set(projects.map(\.avatar))
        let avatar = Self.avatars.first { !used.contains($0) } ?? Self.avatars[projects.count % Self.avatars.count]
        let project = Project(id: UUID(), name: folder.lastPathComponent, folder: folder, avatar: avatar)
        prepareNotesFolder(for: project)
        attach(project)
        saveProjects()
        select(project.id)
        return project
    }

    // MARK: Routines

    private var routineTask: Task<Void, Never>?

    /// Checks every `interval` seconds for routines whose time has come. Checking a wall-clock
    /// time (rather than sleeping until it) survives the Mac sleeping, and a time missed while
    /// Deck was closed still runs once later that day.
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
        let ask = routine.file.map { "打開 \($0)（相對於你的工作資料夾），照裡面寫的做。" } ?? routine.instruction
        switch bot.profile.role {
        case .main:
            return "（App：Routine「\(routine.title)」時間到了。\(ask)）\n" + projectBriefing()
        case .manager:
            return "（App：Routine「\(routine.title)」時間到了：\(ask)。做完用一句話回報結果；需要使用者決定就附選項區塊。）"
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
        let projectLines = projects.isEmpty
            ? "（目前還沒有專案。）"
            : projects.map { project in
                "- \(project.name)：記憶檔 \(project.notesFolder.appending(path: "memory.md").path)；交辦檔 \(project.inboxURL.path)"
            }.joined(separator: "\n")
        let maintainerLine = "- Deck 維護（負責 Deck 本身：插件、組件）：記憶檔 \(maintainerProject.notesFolder.appending(path: "memory.md").path)；交辦檔 \(maintainerProject.inboxURL.path)"
        let teamLines = teams.map { "- \($0.name)（\($0.title)）：\($0.description)" }.joined(separator: "\n")
        return """
        （App：專案清單。問進度就讀記憶檔，不要叫醒主管；要交辦就在交辦檔最後加一行。）
        \(projectLines)
        \(maintainerLine)
        （App：可以拉起的臨時團隊，用 <team name="名稱">任務</team>。）
        \(teamLines)
        \(componentBriefing())
        """
    }

    /// The component library is the `deck-components` plugin. Components from before plugins
    /// (`~/.deck/components`) move into it once.
    static func prepareComponentPlugin(in library: URL, movingFrom old: URL) -> URL {
        let plugin = library.appending(path: "deck-components")
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
              "name": "deck-components",
              "displayName": "組件庫",
              "version": "1.0.0",
              "description": "對話裡的組件（選擇題等）。每個組件一個資料夾：template.html 和 about.md。",
              "license": "MIT",
              "engines": { "deck": "^2.0.0" },
              "deck": {
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
        "（App：對話裡的組件。<show name=\"名稱\">JSON</show> 畫出來；<component name=\"名稱\">要求</component> 請 Deck 維護改。）\n" + components.catalog()
    }

    /// Someone asked for a component change: the user beside a component, or a bot with a
    /// <component> tag. Deck 維護 does it (or hands it to its component-editor agent).
    public func requestComponentChange(_ name: String, request: String, from asker: String) {
        let name = ComponentLibrary.safeName(name)
        guard !name.isEmpty else { return }
        components.markWorking(name, change: request)
        let exists = components.names.contains(name)
        handToMaintainer(exists
            ? "\(asker) 對組件「\(name)」的要求：\(request)"
            : "\(asker) 要一個新組件「\(name)」：\(request)")
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
            case let .folder(path):
                if project?.isMaintainer == true { requestFolder(path) }
            case let .plugin(request):
                if project?.isMaintainer != true {
                    handToMaintainer("\(project?.name ?? mainBot.name) 對 Deck 的要求：\(request)")
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
                pluginDirectories: plugins.claudeDirectories()
            ))
        } catch {
            mainBot.notice("\(spec.title)拉不起來：\(error.localizedDescription)")
            return nil
        }
        runningTeams.append(run)
        process.send(TeamPrompts.task(task))
        Task { [weak self] in
            var reported = false
            for await event in process.events {
                switch event {
                case .activity:
                    break
                case let .reply(text, _):
                    guard !reported else { continue }
                    reported = true
                    self?.mainBot.notice("\(spec.title)：\(ReplyParser.parseAll(text).body)")
                    if self?.selection == nil { self?.mainBot.markRead() }
                    process.finish()
                case let .exited(status, stderr):
                    if !reported {
                        self?.mainBot.notice("\(spec.title)沒做完：\(stderr.isEmpty ? "結束碼 \(status)" : stderr)")
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
    /// the `deck-teams` plugin. The first agent of a name wins.
    private func loadTeams() -> [TeamSpec] {
        var seen = Set<String>()
        // deck-core's agents (the component editor) work for Deck 維護; they are not teams.
        let specs = plugins.agentFiles().filter { $0.plugin != "deck-core" }.compactMap { file -> TeamSpec? in
            guard let spec = (try? String(contentsOf: file.url, encoding: .utf8)).flatMap(TeamSpec.parse),
                  seen.insert(spec.name).inserted else { return nil }
            return spec
        }
        return specs.isEmpty ? TeamSpec.defaults : specs
    }

    /// What Deck 維護 is told on top of a manager's usual instructions.
    func maintainerInstructions() -> String {
        let library = root.appending(path: "plugins").path
        let check = checkCommand.map { "\($0) <插件資料夾>" } ?? "（這次沒有檢查指令；至少確定 package.json 是合法 JSON、宣告的檔案都在）"
        return """
        - 你是「Deck 維護」：負責 Deck 這個 App 的插件庫。工作資料夾 \(library) 就是插件庫，是一個 git repo。
        - 先讀 \(library)/DECK-PLUGINS.md：插件格式、網頁／程式／Claude 三個部分的 API、檢查和上線流程都在裡面。
        - 每次改插件：
          1. 改檔（有 src/ 的插件改 src，再用 esbuild 打包到 package.json 指定的位置）。
          2. 把那個插件 package.json 的 version 升一版（修正升 patch、加功能升 minor）。
          3. 跑檢查：\(check)。沒過就修，最多 3 輪；3 輪都沒過，用選項區塊問使用者卡在哪。
          4. git add 那個插件資料夾，git commit -m "<插件名>: <做了什麼>"，再 git tag <插件名>--v<版本>。
          5. 用一句話回報做了什麼。Deck 會自己熱更新，不用重開。
        - 組件在 deck-components/components/<名稱>/（template.html、about.md）。改完一樣升 deck-components 的版本、檢查、commit。
          只改組件樣板這種小事，可以交給 deck-core:component-editor 這個 agent（Haiku）做，你再檢查和 commit。
        - App 內建的插件不在這裡，不能直接改：要改就把它整個資料夾複製進插件庫，同名的會蓋過內建的（路徑見 DECK-PLUGINS.md）。
        - 要讀插件庫以外的資料夾（例如把現有專案做成插件）：在回覆最後加 <need-folder>完整路徑</need-folder>，用一句話說為什麼要讀，然後停下來等。
          使用者同意後你會收到「（App）使用者同意了…」，那時才讀；不同意就換個做法。只讀不改那裡的檔案。同意過的資料夾不用再問。
        - 把現有專案做成插件：先找出能重用的核心（沒有依賴的程式庫最好），網頁部分只做接線（接上 deck.composer、設定、指令）。
          用 esbuild 打包成單一 ES module（可以用原專案 node_modules 裡的 esbuild，或 npx --yes esbuild@0.25.11）。
          原專案的授權照抄進插件（package.json 的 license 和 LICENSE 檔）；GPL 的程式只能放在獨立插件裡。
        - 「熱更新檢查」的訊息是 Deck 發現插件壞了：照上面流程修好。
        """
    }

    /// `deck-core`: Deck's own agents, starting with the component editor (Haiku).
    static func prepareCorePlugin(in library: URL) {
        let files = FileManager.default
        let plugin = library.appending(path: "deck-core")
        guard !files.fileExists(atPath: plugin.path) else { return }
        try? files.createDirectory(at: plugin.appending(path: "claude/.claude-plugin"), withIntermediateDirectories: true)
        try? files.createDirectory(at: plugin.appending(path: "claude/agents"), withIntermediateDirectories: true)
        let editor = """
        ---
        name: component-editor
        description: 改 Deck 對話裡的一個組件（template.html 和 about.md）。給它組件資料夾的路徑和要怎麼改。
        model: haiku
        tools: Read, Write, Edit
        ---
        \(ComponentPrompts.system)

        """
        try? Data(editor.utf8).write(to: plugin.appending(path: "claude/agents/component-editor.md"))
        try? Data("""
        {
          "name": "deck-core",
          "version": "1.0.0",
          "description": "Deck 自己用的 agents。",
          "author": { "name": "Deck" }
        }

        """.utf8).write(to: plugin.appending(path: "claude/.claude-plugin/plugin.json"))
        try? Data("""
        {
          "name": "deck-core",
          "displayName": "Deck 核心",
          "version": "1.0.0",
          "description": "Deck 自己用的 agents：component-editor（Haiku）改組件樣板。",
          "license": "MIT",
          "engines": { "deck": "^2.0.0" },
          "deck": {
            "permissions": ["claude"],
            "claude": "claude"
          }
        }

        """.utf8).write(to: plugin.appending(path: "package.json"))
    }

    /// DECK-PLUGINS.md in the library: how plugins are written, for Deck 維護 and for people.
    static func writeLibraryGuide(in library: URL, builtIns: URL?) {
        try? FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        let url = library.appending(path: "DECK-PLUGINS.md")
        let text = PluginGuide.text(builtIns: builtIns?.path ?? "（這次沒有內建插件）")
        if (try? String(contentsOf: url, encoding: .utf8)) != text {
            try? Data(text.utf8).write(to: url)
        }
    }

    /// The `deck-teams` plugin holds the temporary teams as Claude Code agents. Team files from
    /// before plugins (`~/.deck/teams`) move into it once; the old folder is kept as
    /// `teams.v1-backup`.
    static func prepareTeamsPlugin(in library: URL, movingFrom old: URL) {
        let files = FileManager.default
        let plugin = library.appending(path: "deck-teams")
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
          "name": "deck-teams",
          "version": "1.0.0",
          "description": "Deck 的臨時團隊：研究小組、原型小組。",
          "author": { "name": "Deck" }
        }

        """
        try? Data(claudeManifest.utf8).write(to: plugin.appending(path: "claude/.claude-plugin/plugin.json"))
        let manifest = """
        {
          "name": "deck-teams",
          "displayName": "臨時團隊",
          "version": "1.0.0",
          "description": "主 bot 可以拉起的臨時團隊。每個團隊是 claude/agents/ 裡的一個 agent 檔。",
          "license": "MIT",
          "engines": { "deck": "^2.0.0" },
          "deck": {
            "permissions": ["claude"],
            "claude": "claude"
          }
        }

        """
        try? Data(manifest.utf8).write(to: plugin.appending(path: "package.json"))
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
            return MemoryFile.items(at: project.notesFolder.appending(path: "memory.md"), section: "等你決定的事")
                .map { Waiting(projectID: project.id, text: $0) }
        }
    }

    /// The single place a pick is made, from either chat. A pick on a notice in the main bot's
    /// chat answers the manager; a pick in the manager's chat also settles its notice.
    @discardableResult
    public func choose(_ index: Int, in messageID: UUID, of bot: Bot) -> Bool {
        defer { refreshWaiting() }
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
            guard notice.isOpenQuestion,
                  let projectID = notice.sourceID,
                  let questionID = notice.sourceMessageID,
                  let manager = managers[projectID],
                  manager.choose(index, in: questionID) else { return false }
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
                  manager.answer(text, in: questionID) else { return false }
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
            "\(project.name)：\(message.text)",
            choices: message.choices,
            sourceID: project.id,
            sourceMessageID: message.id
        )
        if selection == nil { mainBot.markRead() }
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
                bot.notice("插件「\(title)」攔下了這則訊息：\(text)")
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
            mainBot.notice("指令「\(id)」失敗：\(error.localizedDescription)")
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
            "role": .string(bot === mainBot ? "main" : "manager"),
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
                mainBot.notice("\(title)：\(params["text"]?.string ?? "")")
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
            case "routines.add":
                guard let id = params["bot"]?.string, let bot = bot(pluginID: id) else {
                    throw HostMessage.HostError(message: "沒有這個 bot。")
                }
                guard bot.addRoutine(cron: params["cron"]?.string ?? "", task: params["task"]?.string ?? "") else {
                    throw HostMessage.HostError(message: "排程格式不對（要是 crontab 的 5 欄）。")
                }
                return .null
            default:
                throw HostMessage.HostError(message: "不認識的方法「\(method)」。")
            }
        }
    }

    // MARK: Setup

    private func attach(_ project: Project) {
        let store = BotStore(directory: root.appending(path: "projects/\(project.id.uuidString)"))
        let profile: BotProfile = project.isMaintainer
            ? .maintainer(folder: project.folder, instructions: maintainerInstructions())
            : .manager(name: project.name, avatar: project.avatar, folder: project.folder)
        let bot = makeBot(profile, store)
        bot.onRequests = { [weak self] requests in self?.handle(requests, from: project) }
        bot.wakeNote = { [weak self] in self?.componentBriefing() ?? "" }
        bot.pluginDirectories = { [weak self] in self?.plugins.claudeDirectories() ?? [] }
        bot.onReply = { [weak self, weak bot] message, answersRelay in
            guard let self else { return }
            report(from: project, message, answersRelay: answersRelay)
            if project.isMaintainer { components.finishWorking() }
            refreshWaiting()
            if selection == project.id { bot?.markRead() }
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
