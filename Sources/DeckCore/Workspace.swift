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
    }

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
    /// The component team's page is open in place of a chat.
    @Published public private(set) var viewingComponents = false
    /// Temporary teams at work right now.
    @Published public private(set) var runningTeams: [TeamRun] = []
    public private(set) var teams: [TeamSpec] = []

    public let mainBot: Bot
    public private(set) var managers: [UUID: Bot] = [:]
    public let components: ComponentLibrary
    /// Plugins for Deck itself: `~/.deck/plugins/` and the ones shipped with the app.
    public let plugins: PluginRegistry
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
        launcher: @escaping AgentLauncher = { _ in throw CocoaError(.featureUnsupported) },
        makeBot: @escaping BotFactory
    ) {
        self.root = root
        self.makeBot = makeBot
        self.launcher = launcher
        let library = root.appending(path: "plugins")
        let componentFolder = Self.prepareComponentPlugin(in: library, movingFrom: root.appending(path: "components"))
        plugins = PluginRegistry(library: library, builtIns: builtInPlugins)
        components = ComponentLibrary(folder: componentFolder, launcher: launcher)
        let mainHome = root.appending(path: "main")
        try? FileManager.default.createDirectory(at: mainHome, withIntermediateDirectories: true)
        mainBot = makeBot(.main(home: mainHome), BotStore(directory: mainHome))
        mainBot.wakeNote = { [weak self] in self?.projectBriefing() ?? "" }
        mainBot.extraDirectories = { [weak self] in self?.projects.map(\.notesFolder) ?? [] }
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
        components.onChanged = { [weak self] name, summary in
            self?.mainBot.notice("組件「\(name)」：\(summary)")
            if self?.selection == nil { self?.mainBot.markRead() }
        }
        for project in loadProjects() {
            attach(project)
        }
        refreshWaiting()
    }

    public var selectedBot: Bot {
        selection.flatMap { managers[$0] } ?? mainBot
    }

    public func bot(for project: Project) -> Bot? {
        managers[project.id]
    }

    public func project(_ id: UUID) -> Project? {
        projects.first { $0.id == id }
    }

    public func select(_ projectID: UUID?) {
        selection = projectID
        viewingComponents = false
        selectedBot.markRead()
    }

    /// Opens what the component team was asked, is doing, and said.
    public func viewComponents() {
        viewingComponents = true
        openResult = nil
        components.markJobsSeen()
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
        for bot in [mainBot] + projects.compactMap({ managers[$0.id] }) {
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
        let teamLines = teams.map { "- \($0.name)（\($0.title)）：\($0.description)" }.joined(separator: "\n")
        return """
        （App：專案清單。問進度就讀記憶檔，不要叫醒主管；要交辦就在交辦檔最後加一行。）
        \(projectLines)
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
        "（App：對話裡的組件。<show name=\"名稱\">JSON</show> 畫出來；<component name=\"名稱\">要求</component> 請組件團隊改。）\n" + components.catalog()
    }

    /// Someone asked the component team for a change: the user beside a component, or a bot with
    /// a <component> tag.
    public func requestComponentChange(_ name: String, request: String, from asker: String) {
        components.request(name, change: request, from: asker)
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
                tools: spec.tools
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

    private var teamsFolder: URL { root.appending(path: "teams") }

    /// Team files in `~/.deck/teams/`; the defaults are written there the first time.
    private func loadTeams() -> [TeamSpec] {
        let manager = FileManager.default
        if !manager.fileExists(atPath: teamsFolder.path) {
            try? manager.createDirectory(at: teamsFolder, withIntermediateDirectories: true)
            for spec in TeamSpec.defaults {
                try? Data(spec.fileText.utf8).write(to: teamsFolder.appending(path: "\(spec.name).md"))
            }
        }
        let files = (try? manager.contentsOfDirectory(at: teamsFolder, includingPropertiesForKeys: nil)) ?? []
        let specs = files
            .filter { $0.pathExtension == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { (try? String(contentsOf: $0, encoding: .utf8)).flatMap(TeamSpec.parse) }
        return specs.isEmpty ? TeamSpec.defaults : specs
    }

    /// Hands whatever the main bot wrote into a project's inbox.md to that manager.
    public func deliverInboxes() {
        for project in projects {
            guard let text = try? String(contentsOf: project.inboxURL, encoding: .utf8),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            try? Data().write(to: project.inboxURL)
            managers[project.id]?.relay(text)
        }
    }

    public func refreshWaiting() {
        waiting = projects.flatMap { project -> [Waiting] in
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

    // MARK: Setup

    private func attach(_ project: Project) {
        let store = BotStore(directory: root.appending(path: "projects/\(project.id.uuidString)"))
        let bot = makeBot(.manager(name: project.name, avatar: project.avatar, folder: project.folder), store)
        bot.onRequests = { [weak self] requests in self?.handle(requests, from: project) }
        bot.wakeNote = { [weak self] in self?.componentBriefing() ?? "" }
        bot.onReply = { [weak self, weak bot] message, answersRelay in
            guard let self else { return }
            report(from: project, message, answersRelay: answersRelay)
            refreshWaiting()
            if selection == project.id { bot?.markRead() }
        }
        // Memory changes most when a manager tidies before sleeping.
        bot.$phase
            .filter { $0 == .asleep }
            .sink { [weak self] _ in self?.refreshWaiting() }
            .store(in: &subscriptions)
        managers[project.id] = bot
        projects.append(project)
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
        guard let data = try? JSONEncoder().encode(projects) else { return }
        try? data.write(to: projectsURL, options: .atomic)
    }
}
