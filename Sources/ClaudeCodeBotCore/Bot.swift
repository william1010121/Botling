import Combine
import Foundation

/// One bot: the main bot or a project's manager. It has no resident process. A message wakes it
/// into a fresh `claude` session that reads its memory.md; after `idleInterval` with nothing
/// happening (default 50 minutes, inside the 1-hour cache TTL) it writes memory.md and exits.
@MainActor
public final class Bot: ObservableObject, Identifiable {
    @Published public private(set) var phase: BotPhase = .asleep
    /// A turn the user is waiting for is running.
    @Published public private(set) var isWorking = false
    @Published public private(set) var messages: [ChatMessage]
    @Published public private(set) var model: BotModel
    /// The model being switched to, while a handoff runs.
    @Published public private(set) var switchTarget: BotModel?
    /// When the bot will tidy and fall asleep if nothing else happens; nil unless idle and awake.
    @Published public private(set) var sleepsAt: Date?
    /// A reply arrived that the user has not looked at.
    @Published public private(set) var hasUnread = false
    /// The jobs in its routines.cron, which the bot and the settings page both edit.
    @Published public private(set) var routines: [Routine]
    private let routineFile: RoutineFile
    private var routineRuns: [String: Date]

    public let id = UUID()
    public let profile: BotProfile
    let prompts: BotPrompts
    private let launcher: AgentLauncher
    private let idleInterval: TimeInterval
    private let exitTimeout: TimeInterval
    private let store: BotStore?

    /// Extra lines for the wake-up message, read at each wake (the main bot's project list).
    public var wakeNote: (() -> String)?
    /// Folders outside its own it may read and edit, read at each wake.
    public var extraDirectories: (() -> [URL])?
    /// Plugins' Claude parts (skills, agents, MCP) it starts with.
    public var pluginDirectories: (() -> [URL])?
    /// Plugins' MCP tools it may use, and the secrets their servers read.
    public var pluginTools: (() -> [String])?
    public var pluginEnvironment: (() -> [String: String])?
    /// Called after each reply the user sees, with whether it answers work the main bot handed
    /// over (rather than something the user said in this chat).
    public var onReply: ((ChatMessage, _ answersRelay: Bool) -> Void)?
    /// Plugins' afterReply hooks, when any plugin has one: may change a reply before it shows.
    public var replyFilter: (() -> ((String) async -> String)?)?
    /// Every reply shown, for plugins listening with bots.onReply.
    public var replyObserver: ((ChatMessage) -> Void)?
    /// Called with the tags a reply carried (pull up a team, ask the component team).
    public var onRequests: (([BotRequest]) -> Void)?
    /// It asked you something outside a reply (may it use a tool?), so a manager's question can
    /// go up to the main bot's chat too.
    public var onQuestion: ((ChatMessage) -> Void)?
    /// Tools you said it may always use; it starts with them allowed.
    @Published public private(set) var alwaysAllowed: [String]
    /// "May I use this tool?" questions waiting in the chat, by message id, with the process
    /// that is waiting for the answer.
    private var permissionAsks: [UUID: (request: PermissionRequest, process: AgentProcess)] = [:] {
        didSet { if waitingForPermission != !permissionAsks.isEmpty { waitingForPermission = !permissionAsks.isEmpty } }
    }
    /// A tool question waits for you (the row says so instead of "Working").
    @Published public private(set) var waitingForPermission = false
    /// A tool question was settled without you answering it here (it timed out, claude went
    /// away, "always" covered it), so a copy of it elsewhere can be closed too.
    public var onQuestionSettled: ((ChatMessage) -> Void)?
    /// How long a tool question waits before it counts as "don't allow", so a routine at night
    /// does not hold the bot awake forever.
    public var permissionTimeout: TimeInterval = 10 * 60
    /// Removed from ClaudeCodeBot: it never starts again.
    private var removed = false
    /// Whether the running turn started from a relay.
    private var turnFromRelay = false
    /// Something the App needs this awake bot to know, sent ahead of its next message.
    private var pendingNote: String?

    private var process: AgentProcess?
    private var idleTask: Task<Void, Never>?
    /// Set while an App-only turn (tidy, handoff, resume) waits for its reply.
    private var internalReply: CheckedContinuation<String, Never>?
    private var exitWaiter: CheckedContinuation<Void, Never>?
    /// Messages that arrived while tidying or switching; sent once that is done.
    private var queued: [Outgoing] = []

    /// What goes to Claude: the words, and the images it should look at.
    private struct Outgoing {
        var text: String
        var images: [Attachment] = []
    }
    private var pendingModel: BotModel?
    /// It should restart (new plugins, a new folder) once free, with this divider.
    private var pendingRestart: String?

    public init(
        profile: BotProfile,
        defaultModel: BotModel = .sonnet,
        idleInterval: TimeInterval = 50 * 60,
        exitTimeout: TimeInterval = 15,
        launcher: @escaping AgentLauncher,
        store: BotStore? = nil
    ) {
        self.profile = profile
        prompts = BotPrompts(profile: profile)
        self.idleInterval = idleInterval
        self.exitTimeout = exitTimeout
        self.launcher = launcher
        self.store = store
        var loaded = store?.loadMessages() ?? []
        // A tool question from before a restart has nobody waiting for it any more.
        for index in loaded.indices where loaded[index].permissionTool != nil && loaded[index].isOpenQuestion {
            loaded[index].answer = Self.noLongerNeeded
        }
        messages = loaded
        alwaysAllowed = store?.loadAlwaysAllowed() ?? []
        model = store?.loadModel() ?? defaultModel
        routineFile = RoutineFile(url: profile.routinesURL)
        // The main bot starts with a daily summary; managers with none. Routines saved the old way
        // move into the file.
        routineFile.create(with: store?.legacyRoutineLines() ?? (profile.role == .main ? [RoutineFile.dailySummary] : []))
        routines = routineFile.load()
        routineRuns = store?.loadRoutineRuns() ?? [:]
    }

    public var name: String { profile.name }

    public var isSwitching: Bool {
        if case .switching = phase { return true }
        return false
    }

    /// Links handed over in this chat (by the bot, or by managers and teams reporting in), newest first.
    public var results: [Chip] {
        var seen = Set<Chip>()
        return messages.reversed()
            .filter { $0.role == .bot || $0.role == .notice }
            .flatMap { RichText.chips(in: $0.text) }
            .filter { seen.insert($0).inserted }
    }

    public func markRead() {
        if hasUnread { hasUnread = false }
    }

    /// The newest question still waiting for the user's pick.
    public var openQuestion: ChatMessage? {
        messages.last { $0.role == .bot && $0.isOpenQuestion }
    }

    // MARK: Talking

    public func send(_ text: String) {
        send(text, files: [], replyingTo: nil)
    }

    /// A message from the user, optionally with files and as a reply to one of the chat's lines.
    /// Files are copied into the bot's attachments folder so it can open them again later;
    /// images also go to Claude directly.
    public func send(_ text: String, files: [URL], replyingTo replyID: UUID?) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty else { return }
        let attachments = files.compactMap(keep)
        var message = ChatMessage(role: .user, text: text)
        message.attachments = attachments.isEmpty ? nil : attachments
        let quoted = replyID.flatMap { id in messages.first { $0.id == id } }
        if let quoted {
            message.replyTo = quoted.id
            message.replyPreview = Self.preview(of: quoted)
        }
        append(message)
        turnFromRelay = false

        var lines: [String] = []
        if let quoted {
            lines.append("(Replying to what \(quoted.role == .user ? "I" : "you") said earlier: \"\(Self.preview(of: quoted))\")")
        }
        if !text.isEmpty { lines.append(text) }
        if !attachments.isEmpty {
            lines.append("(Attachments:\n" + attachments.map { "- " + $0.url.path }.joined(separator: "\n") + ")")
        }
        route(Outgoing(text: lines.joined(separator: "\n\n"), images: attachments.filter { $0.kind == .image }))
    }

    /// Copies a file the user sent into the bot's own attachments folder.
    private func keep(_ file: URL) -> Attachment? {
        let folder = profile.attachmentsURL
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = Date().formatted(.verbatim("\(year: .defaultDigits)\(month: .twoDigits)\(day: .twoDigits)-\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased))\(minute: .twoDigits)\(second: .twoDigits)", timeZone: .current, calendar: .current))
        var target = folder.appending(path: "\(stamp)-\(file.lastPathComponent)")
        var counter = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appending(path: "\(stamp)-\(counter)-\(file.lastPathComponent)")
            counter += 1
        }
        do {
            try FileManager.default.copyItem(at: file, to: target)
        } catch {
            return nil
        }
        return Attachment(url: target)
    }

    /// The quote shown above a reply: the first line, shortened.
    public static func preview(of message: ChatMessage) -> String {
        let line = message.text.split(whereSeparator: \.isNewline).first.map(String.init)
            ?? message.attachments?.first?.name ?? ""
        return line.count > 60 ? String(line.prefix(60)) + "…" : line
    }

    /// Work the main bot handed over. Shown as a relay line; wakes the bot like a message.
    public func relay(_ instruction: String) {
        let instruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }
        append(ChatMessage(role: .relay, text: instruction))
        turnFromRelay = true
        route(Outgoing(text: BotPrompts.relayPrefix + instruction))
    }

    /// The user picked a button: mark it, then send its label as their answer. A question can be
    /// answered once.
    @discardableResult
    public func choose(_ index: Int, in messageID: UUID) -> Bool {
        guard let message = messages.first(where: { $0.id == messageID }),
              message.isOpenQuestion,
              let choice = message.choices?[safe: index] else { return false }
        if message.permissionTool != nil { return decide(index, in: message) }
        markChosen(index, in: messageID)
        let wasRelay = message.role == .bot && turnFromRelay
        send(choice.label)
        // Picking answers the manager's own question; its next report still goes back up.
        turnFromRelay = wasRelay
        return true
    }

    /// The user answered a question in their own words instead of picking: mark it, then send
    /// the words as their answer. A question can be answered once.
    @discardableResult
    public func answer(_ text: String, in messageID: UUID) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              let message = messages.first(where: { $0.id == messageID }),
              message.isOpenQuestion else { return false }
        if message.permissionTool != nil {
            // Words instead of a button: not allowed, and Claude hears why.
            guard let ask = permissionAsks.removeValue(forKey: messageID), ask.process === process else {
                markAnswered(Self.noLongerNeeded, in: messageID)
                return false
            }
            markAnswered(text, in: messageID)
            ask.process.answer(ask.request, allow: false, message: "The user did not allow it and said: \(text)")
            return true
        }
        markAnswered(text, in: messageID)
        let wasRelay = message.role == .bot && turnFromRelay
        send(text)
        turnFromRelay = wasRelay
        return true
    }

    /// Shows a typed answer on a message without sending anything (the notice mirroring a question).
    public func markAnswered(_ text: String, in messageID: UUID) {
        guard let position = messages.firstIndex(where: { $0.id == messageID }) else { return }
        messages[position].answer = text
        store?.save(messages: messages)
    }

    /// Shows a pick on a message without sending anything (the notice mirroring a manager's question).
    public func markChosen(_ index: Int, in messageID: UUID) {
        guard let position = messages.firstIndex(where: { $0.id == messageID }) else { return }
        messages[position].chosen = index
        store?.save(messages: messages)
    }

    /// A line from a project manager or a team in this (the main bot's) chat. Does not wake anyone.
    public func notice(_ text: String, choices: [Choice]? = nil, sourceID: UUID? = nil, sourceMessageID: UUID? = nil) {
        append(ChatMessage(role: .notice, text: text, choices: choices, sourceID: sourceID, sourceMessageID: sourceMessageID))
        hasUnread = true
    }

    private func route(_ outgoing: Outgoing) {
        switch phase {
        case .asleep:
            wake(with: outgoing)
        case .awake:
            deliver(outgoing)
        case .tidying, .switching:
            queued.append(outgoing)
        }
    }

    private func deliver(_ outgoing: Outgoing) {
        guard let process else { return }
        cancelIdle()
        isWorking = true
        var text = outgoing.text
        if let note = pendingNote {
            pendingNote = nil
            text = note + "\n\n" + text
        }
        process.send(text, images: outgoing.images)
    }

    /// Tells an awake bot something with its next message (a later note replaces an earlier one).
    /// An asleep bot gets the fresh version in its wake note anyway, so nothing is kept.
    public func queueNote(_ note: String) {
        guard phase != .asleep else { return }
        pendingNote = note
    }

    private func wake(with outgoing: Outgoing) {
        pendingNote = nil
        do {
            let process = try start()
            phase = .awake
            isWorking = true
            let note = wakeNote?() ?? ""
            process.send([prompts.wake, note, outgoing.text].filter { !$0.isEmpty }.joined(separator: "\n\n"), images: outgoing.images)
        } catch {
            append(ChatMessage(role: .error, text: "Couldn't wake up: \(error.localizedDescription)"))
        }
    }

    private func start() throws -> AgentProcess {
        guard !removed else { throw CocoaError(.userCancelled) }
        let process = try launcher(AgentLaunch(
            model: model,
            sessionID: UUID(),
            workingDirectory: profile.workingDirectory,
            systemPrompt: prompts.system,
            tools: profile.tools + alwaysAllowed.filter { !profile.tools.contains($0) },
            extraDirectories: extraDirectories?() ?? [],
            pluginDirectories: pluginDirectories?() ?? [],
            pluginTools: pluginTools?() ?? [],
            environment: pluginEnvironment?() ?? [:],
            asksPermission: true
        ))
        self.process = process
        Task { [weak self] in
            for await event in process.events {
                self?.handle(event, from: process)
            }
        }
        return process
    }

    private func show(reply text: String, isError: Bool) {
        isWorking = false
        let parsed = ReplyParser.parseAll(text)
        var message = ChatMessage(role: isError ? .error : .bot, text: parsed.body, choices: parsed.choices)
        message.display = parsed.display
        append(message)
        hasUnread = true
        // It may have edited its routines.cron.
        reloadRoutines()
        onReply?(message, turnFromRelay)
        replyObserver?(message)
        if !parsed.requests.isEmpty { onRequests?(parsed.requests) }
        afterTurn()
    }

    // MARK: Asking to use a tool

    static let noLongerNeeded = "No longer needed"
    static let allowOnce = 0

    /// Claude wants a tool it may not use without asking: allowed already if you said always,
    /// otherwise a question in the chat while it waits.
    private func ask(permission request: PermissionRequest, from source: AgentProcess) {
        if alwaysAllowed.contains(request.tool) {
            source.answer(request, allow: true, message: nil)
            return
        }
        // Tidying, handing off: nobody is reading these turns, and they only touch memory.md.
        if internalReply != nil {
            source.answer(request, allow: false, message: "Not now: this turn only updates your memory file.")
            return
        }
        var choices = [Choice(label: "Allow once", detail: nil, recommended: true)]
        // "Always" by tool name would mean any command or any file on the disk for these.
        if !Self.neverAlways.contains(request.tool) {
            choices.append(Choice(label: "Always allow \(request.tool)", detail: "For \(name), from now on", recommended: false))
        }
        choices.append(Choice(label: "Don't allow", detail: nil, recommended: false))
        var message = ChatMessage(role: .bot, text: Self.permissionText(request), choices: choices)
        message.permissionTool = request.tool
        append(message)
        permissionAsks[message.id] = (request, source)
        hasUnread = true
        onQuestion?(message)
        let id = message.id
        let timeout = permissionTimeout
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(timeout))
            self?.expire(id)
        }
    }

    /// Tools whose "always" would be far broader than it sounds; they are asked every time.
    static let neverAlways: Set<String> = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]

    /// The question, with what would run shown as code so nothing in it renders as a link,
    /// a picture or formatting.
    static func permissionText(_ request: PermissionRequest) -> String {
        let fence = String(repeating: "~", count: max(3, longestRun(of: "~", in: request.summary) + 1))
        return "Wants to use `\(request.tool.replacingOccurrences(of: "`", with: "'"))`:\n\n\(fence)\n\(request.summary)\n\(fence)"
    }

    private static func longestRun(of character: Character, in text: String) -> Int {
        var longest = 0, current = 0
        for c in text {
            current = c == character ? current + 1 : 0
            longest = max(longest, current)
        }
        return longest
    }

    /// Nobody answered in time: it counts as not allowed.
    private func expire(_ id: UUID) {
        guard let ask = permissionAsks.removeValue(forKey: id) else { return }
        settle(id, answer: "No answer in time")
        ask.process.answer(ask.request, allow: false, message: "The user did not answer in time; carry on without it, or ask again later.")
    }

    /// Marks a tool question answered by the app (not by your pick here) and tells the copy.
    private func settle(_ id: UUID, answer: String? = nil, chosen: Int? = nil) {
        if let chosen { markChosen(chosen, in: id) } else { markAnswered(answer ?? Self.noLongerNeeded, in: id) }
        if let message = messages.first(where: { $0.id == id }) { onQuestionSettled?(message) }
    }

    /// Your pick on a tool question goes to the `claude` waiting for it.
    private func decide(_ index: Int, in message: ChatMessage) -> Bool {
        guard let ask = permissionAsks.removeValue(forKey: message.id), ask.process === process else {
            markAnswered(Self.noLongerNeeded, in: message.id)
            return false
        }
        markChosen(index, in: message.id)
        let label = message.choices?[safe: index]?.label ?? ""
        let always = label.hasPrefix("Always allow")
        if always, !alwaysAllowed.contains(ask.request.tool) {
            alwaysAllowed.append(ask.request.tool)
            store?.save(alwaysAllowed: alwaysAllowed)
        }
        let allowed = index == Self.allowOnce || always
        ask.process.answer(ask.request, allow: allowed, message: allowed ? nil : "The user did not allow it.")
        // Other questions for the same tool from this turn are settled by "always".
        if always {
            for (id, other) in permissionAsks where other.request.tool == ask.request.tool {
                permissionAsks[id] = nil
                settle(id, chosen: index)
                other.process.answer(other.request, allow: true, message: nil)
            }
        }
        return true
    }

    /// Lets it ask for this tool again (Settings).
    public func forget(alwaysAllowed tool: String) {
        alwaysAllowed.removeAll { $0 == tool }
        store?.save(alwaysAllowed: alwaysAllowed)
    }

    /// The process went away: its questions can no longer be answered.
    private func dropPermissionAsks() {
        let ids = Array(permissionAsks.keys)
        permissionAsks.removeAll()
        for id in ids { settle(id) }
    }

    private func handle(_ event: AgentEvent, from source: AgentProcess) {
        guard source === process else { return }
        switch event {
        case .activity:
            break
        case let .permission(request):
            ask(permission: request, from: source)
        case let .permissionCancelled(requestID):
            if let id = permissionAsks.first(where: { $0.value.request.id == requestID })?.key {
                permissionAsks[id] = nil
                settle(id)
            }
        case let .reply(text, isError):
            if let waiter = internalReply {
                internalReply = nil
                waiter.resume(returning: text)
                return
            }
            if !isError, let filter = replyFilter?() {
                Task { [weak self] in
                    let changed = await filter(text)
                    self?.show(reply: changed, isError: false)
                }
            } else {
                show(reply: text, isError: isError)
            }
        case let .exited(status, stderr):
            process = nil
            dropPermissionAsks()
            if let waiter = internalReply {
                internalReply = nil
                waiter.resume(returning: "")
            }
            if let waiter = exitWaiter {
                exitWaiter = nil
                waiter.resume()
                return
            }
            // Nobody asked it to exit.
            cancelIdle()
            isWorking = false
            phase = .asleep
            if status != 0 {
                append(ChatMessage(role: .error, text: stderr.isEmpty ? "claude exited unexpectedly (\(status))" : stderr))
            }
        }
    }

    private func afterTurn() {
        if let next = pendingModel {
            pendingModel = nil
            Task { await switchModel(to: next) }
            return
        }
        if let divider = pendingRestart {
            Task { await restart(divider: divider) }
            return
        }
        scheduleIdle()
    }

    // MARK: Routines

    /// Picks up edits to routines.cron, the bot's own included.
    public func reloadRoutines() {
        let loaded = routineFile.load()
        if loaded != routines { routines = loaded }
    }

    /// Due when its latest time today has passed and it has not run since. A job seen for the
    /// first time starts counting from now, so a new or re-timed job does not fire at once.
    public func isDue(_ routine: Routine, at now: Date, calendar: Calendar = .current) -> Bool {
        guard routine.enabled else { return false }
        guard let lastRun = routineRuns[routine.id] else {
            routineRuns[routine.id] = now
            store?.save(routineRuns: routineRuns)
            return false
        }
        guard let time = routine.schedule.lastTime(atOrBefore: now, notBefore: calendar.startOfDay(for: now), calendar: calendar) else {
            return false
        }
        return lastRun < time
    }

    /// Runs `routine` now: a time line in the chat, then `prompt` as a message nobody typed.
    /// A manager's routine result goes up to the main bot like handed-over work.
    public func run(_ routine: Routine, prompt: String, at date: Date = Date()) {
        routineRuns[routine.id] = date
        store?.save(routineRuns: routineRuns)
        let clock = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        append(ChatMessage(role: .divider, text: "\(routine.title) · \(clock)", date: date))
        turnFromRelay = profile.role == .manager
        route(Outgoing(text: prompt))
    }

    /// A once-a-day job, written to routines.cron as "Name: what to do".
    public func addRoutine(title: String, instruction: String, hour: Int, minute: Int) {
        guard let schedule = CronSchedule("\(minute) \(hour) * * *") else { return }
        let instruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        let task = instruction.isEmpty ? title : "\(title): \(instruction)"
        routineFile.add(Routine(schedule: schedule, task: task))
        reloadRoutines()
    }

    /// Any crontab schedule, for plugins (`routines.add`). False if the schedule is not valid.
    /// The same job twice is kept once, so a plugin may add it every time it starts.
    @discardableResult
    public func addRoutine(cron: String, task: String) -> Bool {
        let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let schedule = CronSchedule(cron), !task.isEmpty else { return false }
        reloadRoutines()
        if routines.contains(where: { $0.schedule.text == schedule.text && $0.task == task }) { return true }
        routineFile.add(Routine(schedule: schedule, task: task))
        reloadRoutines()
        return true
    }

    public func removeRoutine(_ id: String) {
        routineFile.remove(id)
        reloadRoutines()
    }

    public func setRoutine(_ id: String, enabled: Bool) {
        routineFile.setEnabled(id, enabled)
        reloadRoutines()
    }

    public func setRoutine(_ id: String, hour: Int, minute: Int) {
        routineFile.setTime(id, hour: hour, minute: minute)
        reloadRoutines()
    }

    // MARK: Sleeping

    private func scheduleIdle() {
        idleTask?.cancel()
        let interval = idleInterval
        sleepsAt = Date().addingTimeInterval(interval)
        idleTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(interval))
            guard !Task.isCancelled else { return }
            await self?.goToSleep()
        }
    }

    private func cancelIdle() {
        idleTask?.cancel()
        sleepsAt = nil
    }

    /// Writes memory.md, then ends the process. Also used when the app quits.
    public func goToSleep() async {
        guard phase == .awake, !isWorking, process != nil else { return }
        cancelIdle()
        phase = .tidying
        _ = await ask(prompts.tidy)
        guard !removed else { return }
        await finishProcess()
        phase = .asleep
        await flushQueue()
    }

    /// Ends the process at once without tidying (the bot is being removed).
    public func stop() {
        removed = true
        cancelIdle()
        queued.removeAll()
        pendingModel = nil
        pendingRestart = nil
        let running = process
        process = nil
        running?.stop()
        dropPermissionAsks()
        isWorking = false
        phase = .asleep
        // Anything waiting on that process (a tidy, a handoff) carries on instead of hanging.
        if let waiter = internalReply {
            internalReply = nil
            waiter.resume(returning: "")
        }
        if let waiter = exitWaiter {
            exitWaiter = nil
            waiter.resume()
        }
    }

    // MARK: Switching model

    /// Handoff into memory.md, stop, start a new session on `newModel`. Waits for a running
    /// turn, tidy or switch to end first.
    public func switchModel(to newModel: BotModel) async {
        guard newModel != model else {
            pendingModel = nil
            return
        }
        if isWorking || phase == .tidying || isSwitching {
            pendingModel = newModel
            return
        }
        guard phase == .awake else {
            model = newModel
            store?.save(model: newModel)
            append(ChatMessage(role: .divider, text: "Switched to \(newModel.displayName)"))
            return
        }

        await handOver(to: newModel, divider: "Handoff → \(newModel.displayName)")
    }

    /// Plugins' Claude parts changed. Asleep: the next wake loads them. Awake: hand over and
    /// restart once it is free, so the new skills and agents are there.
    public func reloadPlugins() async {
        await restart(divider: "Handoff → loading new plugins")
    }

    /// Hands over and starts a fresh session (same model) so it picks up what it starts with
    /// (plugins, folders). Asleep: nothing to do, the next wake has it. Busy: once it is free.
    public func restart(divider: String) async {
        guard phase != .asleep else {
            pendingRestart = nil
            return
        }
        if isWorking || phase == .tidying || isSwitching || phase != .awake {
            pendingRestart = divider
            return
        }
        pendingRestart = nil
        await handOver(to: model, divider: divider)
    }

    /// Writes a handoff, stops, and starts again on `newModel` reading it.
    private func handOver(to newModel: BotModel, divider: String) async {
        cancelIdle()
        switchTarget = newModel
        phase = .switching(.writing)
        _ = await ask(prompts.handoff)
        guard !removed else { return }
        phase = .switching(.stopping)
        await finishProcess()
        phase = .switching(.starting)
        model = newModel
        store?.save(model: newModel)
        append(ChatMessage(role: .divider, text: divider))
        do {
            _ = try start()
            let reply = await ask(prompts.resume)
            guard !removed else { return }
            phase = process == nil ? .asleep : .awake
            if !BotPrompts.isPlainOK(reply) {
                append(ChatMessage(role: .bot, text: reply))
            }
            if phase == .awake { scheduleIdle() }
        } catch {
            phase = .asleep
            append(ChatMessage(role: .error, text: "Restart after handoff failed: \(error.localizedDescription)"))
        }
        switchTarget = nil
        await flushQueue()
    }

    // MARK: Helpers

    /// Sends an App-only prompt and returns its reply without showing either.
    private func ask(_ prompt: String) async -> String {
        guard let process else { return "" }
        return await withCheckedContinuation { continuation in
            internalReply = continuation
            process.send(prompt)
        }
    }

    private func finishProcess() async {
        guard let process else { return }
        let timeout = exitTimeout
        await withCheckedContinuation { continuation in
            exitWaiter = continuation
            process.finish()
            Task {
                try? await Task.sleep(for: .seconds(timeout))
                process.stop()
            }
        }
    }

    private func flushQueue() async {
        if let next = pendingModel {
            pendingModel = nil
            await switchModel(to: next)
        }
        if let divider = pendingRestart, phase == .awake {
            await restart(divider: divider)
        }
        guard !queued.isEmpty else { return }
        let waiting = queued
        queued.removeAll()
        let text = waiting.map(\.text).joined(separator: "\n\n")
        route(Outgoing(text: text, images: waiting.flatMap(\.images)))
    }

    private func append(_ message: ChatMessage) {
        messages.append(message)
        store?.save(messages: messages)
    }
}
