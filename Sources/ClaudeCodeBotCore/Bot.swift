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
    /// The model its subagents use; nil: the same as its own.
    @Published public private(set) var subagentModel: BotModel?
    /// How hard it (and its subagents) think; nil: the model's default.
    @Published public private(set) var effort: EffortLevel?
    /// Whether Codex reviews its subagents' work, how many fix rounds, what goes back.
    @Published public private(set) var codexSettings: CodexSettings
    /// Components pinned to it: the chips above its input box and its Board (`pins.json`).
    @Published public private(set) var pins: [PinnedComponent] = []
    /// Components being made from its replies: a chip under each, a workspace in the right
    /// panel once pressed (`specs.json`).
    @Published public private(set) var specs: [ComponentSpec] = []
    /// Called when you change `codexSettings`, so an awake bot hears the new rules.
    public var onCodexSettings: ((CodexSettings) -> Void)?
    /// The components it has from the shared library (at most `ComponentLibrary.limit`); its
    /// briefing has their whole usage. Nil until first given, and for chats without one (groups).
    @Published public private(set) var componentList: [String]?
    /// When the bot will tidy and fall asleep if nothing else happens; nil unless idle and awake.
    @Published public private(set) var sleepsAt: Date?
    /// A reply arrived that the user has not looked at.
    @Published public private(set) var unreadCount = 0 {
        didSet { if unreadCount != oldValue { store?.save(unread: unreadCount) } }
    }
    public var hasUnread: Bool { unreadCount > 0 }
    /// When the newest line in this chat was said; the left column lists the newest first.
    public var lastActivity: Date { messages.last?.date ?? .distantPast }
    /// The jobs in its routines.cron, which the bot and the settings page both edit.
    @Published public private(set) var routines: [Routine]
    /// What it is doing in the turn under way, and the subagents it sent off (newest last).
    @Published public private(set) var trace: TraceBook
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
    /// What those plugins' Claude parts are now (see `PluginRegistry.claudeStamp`).
    public var pluginStamp: (() -> [String])?
    /// The stamp its session started with: a plugin change it already has needs no handoff.
    private var loadedPluginStamp: [String]?
    /// Plugins' MCP tools it may use, and the secrets their servers read.
    public var pluginTools: (() -> [String])?
    public var pluginEnvironment: (() -> [String: String])?
    /// Whether it starts in Claude Code's auto mode, read at each wake (off when not set).
    public var autoMode: (() -> Bool)?
    /// Called once for each new line added to the chat (not when a saved chat is loaded or
    /// drawn again): where component cards are counted.
    public var onNewMessage: ((ChatMessage) -> Void)?
    /// Called after each reply the user sees, with whether it answers work the main bot handed
    /// over (rather than something the user said in this chat).
    public var onReply: ((ChatMessage, _ answersRelay: Bool) -> Void)?
    /// Plugins' afterReply hooks, when any plugin has one: may change a reply before it shows.
    public var replyFilter: (() -> ((String) async -> String)?)?
    /// Every reply shown, for plugins listening with bots.onReply.
    public var replyObserver: ((ChatMessage) -> Void)?
    /// Called with what each turn cost, in US dollars.
    public var onSpend: ((Double) -> Void)?
    /// Called with the tokens each turn used.
    public var onTokens: ((TokenUsage) -> Void)?
    /// The API reported the subscription's limits.
    public var onRateLimits: ((RateLimits) -> Void)?
    /// What the running session has cost so far (claude reports a running total).
    private var sessionCost = 0.0
    /// Called with the tags a reply carried (pull up a team, ask the component team).
    public var onRequests: (([BotRequest]) -> Void)?
    /// It asked you something outside a reply (may it use a tool?), so a question asked during a
    /// group turn can show in that group too.
    public var onQuestion: ((ChatMessage) -> Void)?
    /// Tools you said it may always use; it starts with them allowed.
    @Published public private(set) var alwaysAllowed: [String]
    /// "May I use this tool?" questions waiting in the chat, by message id, with the process
    /// that is waiting for the answer.
    private var permissionAsks: [UUID: (request: PermissionRequest, process: AgentProcess)] = [:] {
        didSet { if waitingForPermission != !permissionAsks.isEmpty { waitingForPermission = !permissionAsks.isEmpty } }
    }
    /// Calls auto mode blocked that wait in the chat for your Allow, by message id. Nothing waits
    /// on them: claude already got the refusal; allowing lets the call through and tells it to retry.
    private var denialAsks: [UUID: Denial] = [:]
    private struct Denial {
        var tool: String
        var summary: String
        /// What lets that call through: "Bash(rm -rf build)".
        var rule: String
    }
    /// Blocked calls allowed once: rules for this run of the app (each new session starts with them).
    private var sessionRules: [String] = []
    /// Recent tool calls by id (tool, what it ran or touched), to show and allow a blocked one.
    private var toolCalls: [String: (tool: String, detail: String)] = [:]
    /// Blocked calls already shown (claude says so twice: its frame and the tool result).
    private var deniedCalls: Set<String> = []
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
    /// Waiting for a group-chat reply, which goes to the group instead of this chat.
    private var groupReply: CheckedContinuation<GroupAnswer, Never>?
    /// A group turn timed out: its late reply is dropped instead of showing in this chat.
    private var dropNextReply = false

    /// How a group-chat turn went.
    public enum GroupAnswer: Equatable, Sendable {
        /// Its reply, with the steps it took on the way (its words between tool calls among them).
        case reply(String, steps: [Step]? = nil)
        /// Still busy with its own chat (a turn, tidying, a handoff) when its turn came.
        case busy
        /// It could not answer: did not start, exited, errored, or took too long.
        case failed(String)
    }

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
        /// You typed it here (not handed over, not a routine): you may add to it before the reply.
        var fromUser = false
        /// Its line in this chat, left out of the recent chat a wake-up brings along.
        var messageID: UUID?
    }
    /// What you said in the turn under way, while nothing but you started it.
    private var turnInput: Outgoing?
    /// Work it was doing (handed over, a routine) when you wrote: it answers you first, then is
    /// told to carry on. Holds whether that work reports up like handed-over work.
    private var pausedWork: Bool?
    /// The turn under way was started by claude itself only to say a subagent is still waiting
    /// on its own background work: nothing new, so its reply does not show.
    private var quietTurn = false
    /// That quiet turn was paused for you: the work it carries on with after stays quiet.
    private var pausedQuiet = false
    static let pauseNote = "(App: I stopped what you were doing to ask you this. Answer me first; you will be told to carry on with it after.)"
    static let resumeNote = "(App: Now carry on with what you were doing before the user's message, where you left off.)"

    /// Turns interrupted to take in what you added whose error results have not come back yet;
    /// those are not shown. (You may add twice before the first one comes back.)
    private var interruptions = 0
    /// It should restart (new plugins, a model, a new folder) before its next real message, with
    /// this divider. Nothing restarts an idle bot: it costs nothing until someone writes.
    private var pendingRestart: String?
    /// The restart waiting is only for plugins: when they changed back, it is not needed.
    private var pendingRestartForPluginsOnly = false
    /// Whether the session `sessionID` names can be `--resume`d (claude kept its transcript).
    /// Tests stand in for it; without a transcript a restart writes a handoff instead.
    public var sessionExists: (UUID, URL) -> Bool = { Bot.claudeSessionExists($0, in: $1) }
    /// A session just went on with `--resume`: until it shows it is alive (a step or a reply),
    /// an exit means the resume failed, and the first message it got goes to a fresh session.
    private var resumeProbe = false
    private var resumeRetry: Outgoing?

    /// Its run (or a subagent's) failed because the network went away; it waits for the
    /// network to come back (`networkRestored`) to carry on. The row says "網路中斷".
    @Published public private(set) var outage: Outage?
    /// Claude cannot reach the API right now and is retrying.
    @Published public private(set) var retryingConnection = false
    /// The clock (tests set it).
    var now: () -> Date = Date.init
    /// The session the running process has, to `--resume` it.
    private var sessionID: UUID?
    /// When anything last happened in the turn under way, and in each subagent.
    private var lastProgress: Date?
    private var subagentProgress: [String: Date] = [:]
    /// Quiet spells already reminded about ("" for the bot itself, else a subagent's id).
    private var stallReminded: Set<String> = []
    /// Subagents' ids for SendMessage, by the id of the tool call that started them.
    private var agentIDs: [String: String] = [:]

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
        // The app's own cards (add these projects? install this?) are answered by the app run that
        // asked; after a restart nobody would act on a pick.
        for index in loaded.indices where loaded[index].role == .notice && loaded[index].sourceMessageID == nil && loaded[index].isOpenQuestion {
            loaded[index].answer = Self.askAgain
        }
        messages = loaded
        // A chat from before there was an archive goes into it once, so all of it can be searched.
        if !loaded.isEmpty, !FileManager.default.fileExists(atPath: profile.archiveURL.path) {
            Self.archiveAll(loaded, in: profile.archiveURL)
        }
        alwaysAllowed = store?.loadAlwaysAllowed() ?? []
        unreadCount = store?.loadUnread() ?? 0
        model = store?.loadModel() ?? defaultModel
        subagentModel = store?.loadSubagentModel()
        effort = store?.loadEffort()
        codexSettings = store?.loadCodexSettings() ?? CodexSettings()
        componentList = store?.loadComponentList()
        pins = store?.loadPins() ?? []
        specs = store?.loadSpecs() ?? []
        routineFile = RoutineFile(url: profile.routinesURL)
        // The main bot starts with a daily summary; managers with none. Routines saved the old way
        // move into the file.
        routineFile.create(with: store?.legacyRoutineLines() ?? (profile.role == .main ? [RoutineFile.dailySummary] : []))
        routines = routineFile.load()
        routineRuns = store?.loadRoutineRuns() ?? [:]
        // Subagents that ran when the app quit went away with their process.
        // Background shell commands an earlier build took for subagents (no kind, no task) go.
        let saved = store?.loadSubagents() ?? []
        let real = saved.filter { $0.type != nil || !$0.prompt.isEmpty || !$0.steps.isEmpty }
        var book = TraceBook(subagents: real)
        book.imageFolder = store.map { $0.directory.appending(path: StepImages.folderName) }
        if real.count != saved.count { store?.save(subagents: real) }
        if book.stopLeftovers() { store?.save(subagents: book.subagents) }
        trace = book
    }

    /// The steps of the turn under way.
    public var liveSteps: [Step] { trace.steps }

    /// The subagents it sent off, newest last.
    public var subagents: [Subagent] { trace.subagents }

    /// Settles a subagent: its row moves from the left column to "Settled" in the right one
    /// (saved, so it lasts). A running one is left alone: it works on and reports back.
    public func settleSubagent(_ id: String) {
        if trace.settle(id) { store?.save(subagents: trace.subagents) }
    }

    /// Brings a settled subagent back to the left column.
    public func unsettleSubagent(_ id: String) {
        if trace.unsettle(id) { store?.save(subagents: trace.subagents) }
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
        if unreadCount != 0 { unreadCount = 0 }
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
        send(text, files: files, replyingTo: replyID, appNote: nil)
    }

    /// `appNote` goes to Claude ahead of your words without showing in the chat (what the app
    /// did about a card you answered).
    func send(_ text: String, files: [URL], replyingTo replyID: UUID?, appNote: String?) {
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

        var lines: [String] = []
        if let appNote { lines.append(appNote) }
        if let quoted {
            let whose = switch quoted.role {
            case .user: "what I said earlier"
            case .notice: "the app's message"
            default: "what you said earlier"
            }
            lines.append("(Replying to \(whose): \"\(Self.preview(of: quoted))\")")
        }
        if !text.isEmpty { lines.append(text) }
        if !attachments.isEmpty {
            lines.append("(Attachments:\n" + attachments.map { "- " + $0.url.path }.joined(separator: "\n") + ")")
        }
        // Whether paused work reported up is read before this turn becomes yours.
        route(Outgoing(text: lines.joined(separator: "\n\n"), images: attachments.filter { $0.kind == .image }, fromUser: true, messageID: message.id))
        turnFromRelay = false
    }

    /// Copies a file the user sent into the bot's own attachments folder.
    func keep(_ file: URL) -> Attachment? {
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
    /// `files` (screenshots with a report) are kept in its attachments folder; images also go to
    /// Claude directly.
    /// `feedback` marks a "not right" report, so the chat shows it short.
    public func relay(_ instruction: String, files: [URL] = [], feedback: FeedbackNote? = nil) {
        let instruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }
        let attachments = files.compactMap(keep)
        var message = ChatMessage(role: .relay, text: instruction)
        message.attachments = attachments.isEmpty ? nil : attachments
        message.feedback = feedback
        append(message)
        turnFromRelay = true
        var text = BotPrompts.relayPrefix + instruction
        if !attachments.isEmpty {
            text += "\n\n(Attachments:\n" + attachments.map { "- " + $0.url.path }.joined(separator: "\n") + ")"
        }
        route(Outgoing(text: text, images: attachments.filter { $0.kind == .image }, messageID: message.id))
    }

    /// Something only the app says (no line in the chat): wakes it like a message. A report it
    /// was waiting for (Codex's review of its subagent's work) arrives this way.
    public func appMessage(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        route(Outgoing(text: text))
    }

    /// The user picked a button: mark it, then send its label as their answer. A question can be
    /// answered once.
    @discardableResult
    public func choose(_ index: Int, in messageID: UUID) -> Bool {
        guard let message = messages.first(where: { $0.id == messageID }),
              message.isOpenQuestion,
              let choice = message.choices?[safe: index] else { return false }
        if denialAsks[messageID] != nil { return decideDenial(index, in: message) }
        if message.permissionTool != nil { return decide(index, in: message) }
        markChosen(index, in: messageID)
        let wasRelay = message.role == .bot && turnFromRelay
        // As a reply to the question, so it knows which one you answered, even after a sleep.
        send(choice.label, files: [], replyingTo: messageID)
        // Picking answers the manager's own question; its next report still goes back up.
        turnFromRelay = wasRelay
        return true
    }

    /// The user answered a question in their own words instead of picking: mark it, then send
    /// the words as their answer. A question can be answered once. `files` (pictures attached in
    /// the component, e.g. in "Other") go along like a message's attachments.
    @discardableResult
    public func answer(_ text: String, files: [URL] = [], in messageID: UUID) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty,
              let message = messages.first(where: { $0.id == messageID }),
              message.isOpenQuestion else { return false }
        let shown = Self.answerLabel(text, files: files)
        if let denial = denialAsks.removeValue(forKey: messageID) {
            markAnswered(shown, in: messageID)
            appMessage("(App: The user did not allow `\(denial.summary)` (\(denial.tool)), which auto mode blocked, and said: \(shown))")
            return true
        }
        if message.permissionTool != nil {
            // Words instead of a button: not allowed, and Claude hears why.
            guard let ask = permissionAsks.removeValue(forKey: messageID), ask.process === process else {
                markAnswered(Self.noLongerNeeded, in: messageID)
                return false
            }
            markAnswered(shown, in: messageID)
            // Pictures with it are kept, and Claude is told where (a refusal carries only words).
            let kept = files.compactMap(keep)
            let note = kept.isEmpty ? "" : "\n(Attachments:\n" + kept.map { "- " + $0.url.path }.joined(separator: "\n") + ")"
            ask.process.answer(ask.request, allow: false, message: "The user did not allow it and said: \(shown)\(note)")
            return true
        }
        markAnswered(shown, in: messageID)
        let wasRelay = message.role == .bot && turnFromRelay
        send(text, files: files, replyingTo: messageID)
        turnFromRelay = wasRelay
        return true
    }

    /// What an answer shows on the question: the words, or, for pictures alone, that pictures
    /// were sent.
    public static func answerLabel(_ text: String, files: [URL]) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty || files.isEmpty { return text }
        return files.count == 1 ? "(picture)" : "(\(files.count) pictures)"
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
        unreadCount += 1
    }

    private func route(_ outgoing: Outgoing) {
        // Its group-chat turn is running: what you say here waits, so the reply to it does not
        // end up in the group.
        if groupReply != nil {
            queued.append(outgoing)
            return
        }
        switch phase {
        case .asleep:
            wake(with: outgoing)
        case .awake:
            if restartsBeforeMessage {
                // A restart was waiting for a message: done now, then this goes to the new process.
                queued.insert(outgoing, at: 0)
                phase = .switching(.stopping)
                Task { [weak self] in await self?.restartWaiting() }
                return
            }
            if let merged = merging(outgoing) {
                // You added to what you said before it answered: stop that turn and ask again
                // with all of it, so one reply answers the whole thing. The message goes first:
                // the interrupt stops the turn for it (and leaves background subagents running).
                trace.dropSteps()
                deliver(merged)
                process?.interrupt()
                interruptions += 1
                return
            }
            if pausing(for: outgoing) {
                // You come first: what it was doing waits until it has answered you. Its
                // subagents in the background carry on and still report back.
                trace.dropSteps()
                pausedWork = turnFromRelay
                pausedQuiet = quietTurn
                turnFromRelay = false
                var mine = outgoing
                mine.text = Self.pauseNote + "\n\n" + outgoing.text
                deliver(mine)
                // Yours now: what you add before it answers joins it.
                turnInput = mine
                process?.interrupt()
                interruptions += 1
                return
            }
            deliver(outgoing)
        case .tidying, .switching:
            queued.append(outgoing)
        }
    }

    /// Your earlier words and these as one message, when the turn under way only answers you
    /// and stopping it loses nothing: no question waits on you, no subagent is at work.
    private func merging(_ outgoing: Outgoing) -> Outgoing? {
        guard outgoing.fromUser, isWorking, let earlier = turnInput, internalReply == nil, groupReply == nil,
              permissionAsks.isEmpty, !trace.subagents.contains(where: \.isRunning) else { return nil }
        return Outgoing(
            text: Self.partsNote + Self.withoutPartsNote(earlier.text) + "\n\n" + outgoing.text,
            images: earlier.images + outgoing.images,
            fromUser: true,
            messageID: outgoing.messageID
        )
    }

    /// You wrote while it worked on something you did not start (handed-over work, a routine, a
    /// report of its own): unless stopping it would lose work (a question waits on you, a
    /// subagent runs in the foreground), it pauses that for you.
    private func pausing(for outgoing: Outgoing) -> Bool {
        outgoing.fromUser && isWorking && turnInput == nil && pausedWork == nil && internalReply == nil && groupReply == nil
            && permissionAsks.isEmpty && !trace.subagents.contains { $0.isRunning && !$0.background }
    }

    private static let partsNote = "(I sent this in parts before you answered; here is all of it:)\n\n"

    /// A third part joins the first two, not a message that already says "in parts".
    private static func withoutPartsNote(_ text: String) -> String {
        text.hasPrefix(partsNote) ? String(text.dropFirst(partsNote.count)) : text
    }

    private func deliver(_ outgoing: Outgoing) {
        guard let process else { return }
        cancelIdle()
        // A turn you started, or one you are adding to; anything else is not yours to add to.
        turnInput = outgoing.fromUser && (!isWorking || turnInput != nil) ? outgoing : nil
        // You said something: the reply is yours to see.
        if outgoing.fromUser { quietTurn = false }
        if !isWorking { noteProgress() }
        isWorking = true
        if resumeProbe, resumeRetry == nil, groupReply == nil { resumeRetry = outgoing }
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
            turnInput = outgoing.fromUser ? outgoing : nil
            let note = wakeNote?() ?? ""
            let recent = recentChat(leavingOut: outgoing.messageID)
            let wakeLine = profile.keepsMemory ? prompts.wake : ""
            process.send([wakeLine, note, recent, outgoing.text].filter { !$0.isEmpty }.joined(separator: "\n\n"), images: outgoing.images)
        } catch {
            append(ChatMessage(role: .error, text: "Couldn't wake up: \(error.localizedDescription)"))
        }
    }

    /// How many of the chat's last lines a wake-up brings along, and how long each may be.
    static let recentLines = 20
    static let recentLineLength = 600

    /// The chat's last lines, so a bot that just woke up (a new session: it remembers nothing
    /// but memory.md) knows what you were just talking about. Empty in a new chat.
    func recentChat(leavingOut id: UUID? = nil) -> String {
        let lines = messages.filter { $0.id != id }.suffix(Self.recentLines).compactMap { message -> String? in
            var text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count > Self.recentLineLength { text = String(text.prefix(Self.recentLineLength)) + "…" }
            if let files = message.attachments, !files.isEmpty {
                text += (text.isEmpty ? "" : " ") + "(files: " + files.map(\.url.path).joined(separator: ", ") + ")"
            }
            if let choices = message.choices, !choices.isEmpty {
                let picked = message.chosen.flatMap { choices[safe: $0]?.label } ?? message.answer
                text += " [options: " + choices.map(\.label).joined(separator: " / ") + "]" + (picked.map { " → picked: \($0)" } ?? " (not answered yet)")
            }
            guard !text.isEmpty else { return nil }
            let stamp = message.date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            return "[\(stamp)] \(Self.speaker(message.role)): \(text)"
        }
        guard !lines.isEmpty else { return "" }
        return "(App: The last messages in this chat, oldest first. You were asleep since; for anything older, Grep your chat archive in \(profile.archiveURL.path):)\n" + lines.joined(separator: "\n")
    }

    /// Starts a process: a new session, or (`resuming`) one that went away.
    private func start(resuming: UUID? = nil) throws -> AgentProcess {
        guard !removed else { throw CocoaError(.userCancelled) }
        let session = resuming ?? UUID()
        // A new process loads what it starts with now (plugins, effort, folders): a restart
        // waiting for it is done.
        pendingRestart = nil
        pendingRestartForPluginsOnly = false
        loadedPluginStamp = pluginStamp?()
        let process = try launcher(AgentLaunch(
            model: model,
            sessionID: session,
            resume: resuming != nil,
            workingDirectory: profile.workingDirectory,
            systemPrompt: prompts.system,
            // "Bash(rm -rf build)" is a rule, not a tool name, and may hold commas: it goes in --settings.
            tools: profile.tools + alwaysAllowed.filter { !profile.tools.contains($0) && !Self.isRule($0) },
            extraDirectories: extraDirectories?() ?? [],
            pluginDirectories: pluginDirectories?() ?? [],
            pluginTools: pluginTools?() ?? [],
            environment: pluginEnvironment?() ?? [:],
            asksPermission: true,
            disallowedTools: profile.disallowedTools,
            autoMode: autoMode?() ?? false,
            allowRules: allowRules,
            effort: effort,
            subagentModel: subagentModel
        ))
        self.process = process
        sessionID = session
        noteProgress()
        sessionCost = 0
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
        if !parsed.displays.isEmpty { message.displays = parsed.displays }
        message.steps = trace.takeSteps()
        append(message)
        unreadCount += 1
        // It may have edited its routines.cron.
        reloadRoutines()
        onReply?(message, turnFromRelay)
        replyObserver?(message)
        if !parsed.requests.isEmpty { onRequests?(parsed.requests) }
        if let fromRelay = pausedWork, process != nil {
            // It answered you; now back to what it was doing.
            pausedWork = nil
            turnFromRelay = fromRelay
            quietTurn = pausedQuiet
            pausedQuiet = false
            deliver(Outgoing(text: Self.resumeNote))
            return
        }
        afterTurn()
    }

    // MARK: Group chat

    /// Says `text` (its turn in a group chat) and returns the reply, showing neither in this
    /// chat. Wakes it if asleep. While it is busy with its own chat it waits up to `waitFor`,
    /// then gives up (`.busy`); once asked, it gets `answerWithin` to reply.
    public func groupTurn(_ text: String, waitFor: TimeInterval = 20, answerWithin: TimeInterval = 5 * 60) async -> GroupAnswer {
        let deadline = Date().addingTimeInterval(waitFor)
        // A background subagent's report would come back as a turn of its own and be taken for the group's reply.
        while isWorking || groupReply != nil || phase == .tidying || isSwitching || dropNextReply
                || trace.subagents.contains(where: \.isRunning) {
            guard !removed else { return .failed("It was removed.") }
            guard Date() < deadline else { return .busy }
            try? await Task.sleep(for: .milliseconds(300))
        }
        guard !removed else { return .failed("It was removed.") }
        if restartsBeforeMessage {
            phase = .switching(.stopping)
            await restartWaiting()
            guard !removed else { return .failed("It was removed.") }
        }
        return await withCheckedContinuation { continuation in
            groupReply = continuation
            if phase == .asleep {
                wake(with: Outgoing(text: text))
            } else {
                deliver(Outgoing(text: text))
            }
            // It could not start, or had no process to talk to.
            if process == nil {
                finishGroupReply(.failed("It could not start."))
                return
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(answerWithin))
                guard let self, groupReply != nil else { return }
                // Its reply, when it comes, belongs to nobody now.
                dropNextReply = true
                finishGroupReply(.failed("No answer in time."))
            }
        }
    }

    private func finishGroupReply(_ answer: GroupAnswer) {
        guard let waiter = groupReply else { return }
        groupReply = nil
        waiter.resume(returning: answer)
    }

    /// A line in this chat that is not part of its own conversation (a group chat's lines).
    public func post(_ message: ChatMessage, unread: Bool = true) {
        append(message)
        if unread { unreadCount += 1 }
    }

    /// Puts earlier lines in, in date order (notices moving over from another chat).
    public func adopt(_ older: [ChatMessage]) {
        guard !older.isEmpty else { return }
        messages = (older + messages).sorted { $0.date < $1.date }
        store?.save(messages: messages)
    }

    // MARK: Asking to use a tool

    static let noLongerNeeded = "No longer needed"
    static let askAgain = "Closed when ClaudeCodeBot restarted; ask again"
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
        unreadCount += 1
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
    static func permissionText(_ request: PermissionRequest, lead: String = "Wants to use") -> String {
        let fence = String(repeating: "~", count: max(3, longestRun(of: "~", in: request.summary) + 1))
        return "\(lead) `\(request.tool.replacingOccurrences(of: "`", with: "'"))`:\n\n\(fence)\n\(request.summary)\n\(fence)"
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

    // MARK: Calls auto mode blocked

    /// Auto mode's classifier refused a call: the same card as a tool question, for that very call
    /// (its command, file or site) and the classifier's reason. Allowing it adds a rule that lets
    /// exactly that through, then tells it to try again.
    private func showDenial(_ denial: PermissionDenial) {
        guard internalReply == nil, deniedCalls.insert(denial.toolUseID).inserted else { return }
        let call = toolCalls[denial.toolUseID]
        guard let tool = denial.tool ?? call?.tool,
              let rule = Self.allowRule(tool: tool, detail: call?.detail ?? "") else { return }
        let summary = call?.detail ?? tool
        // Allowed already (a rule from before this session reached claude late): nothing to ask.
        guard !allowRules.contains(rule) else { return }
        let always = switch tool {
        case "Bash": "Always allow this command"
        case "Write", "Edit", "MultiEdit", "NotebookEdit": "Always allow editing this file"
        case "WebFetch": "Always allow this site"
        default: "Always allow \(tool)"
        }
        let choices = [
            Choice(label: "Allow once", detail: nil, recommended: true),
            Choice(label: always, detail: "For \(name), from now on", recommended: false),
            Choice(label: "Don't allow", detail: nil, recommended: false)
        ]
        let request = PermissionRequest(id: denial.toolUseID, tool: tool, summary: summary, input: "{}")
        let reason = denial.reason.isEmpty ? "" : "\n\nReason: " + denial.reason.replacingOccurrences(of: "\n", with: " ")
        var message = ChatMessage(role: .bot, text: Self.permissionText(request, lead: "Auto mode blocked") + reason, choices: choices)
        message.permissionTool = tool
        append(message)
        denialAsks[message.id] = Denial(tool: tool, summary: summary, rule: rule)
        unreadCount += 1
        onQuestion?(message)
    }

    /// Your pick on a blocked call: allowed, the rule goes to claude and it is told to retry;
    /// not, it is told so.
    private func decideDenial(_ index: Int, in message: ChatMessage) -> Bool {
        guard let denial = denialAsks.removeValue(forKey: message.id) else { return false }
        markChosen(index, in: message.id)
        guard index <= 1 else {
            appMessage("(App: The user did not allow `\(denial.summary)` (\(denial.tool)), which auto mode blocked. Do not try it again; carry on without it, or ask the user what to do instead.)")
            return true
        }
        if index == 1 {
            if !alwaysAllowed.contains(denial.rule) {
                alwaysAllowed.append(denial.rule)
                store?.save(alwaysAllowed: alwaysAllowed)
            }
        } else if !sessionRules.contains(denial.rule) {
            sessionRules.append(denial.rule)
        }
        process?.allow(rules: allowRules)
        appMessage("(App: The user allowed `\(denial.summary)` (\(denial.tool)), which auto mode blocked. It is allowed now: run it again as it was, then carry on.)")
        return true
    }

    /// Rules for calls you allowed after auto mode blocked them: always, then this run's.
    private var allowRules: [String] {
        let always = alwaysAllowed.filter(Self.isRule)
        return always + sessionRules.filter { !always.contains($0) }
    }

    static func isRule(_ entry: String) -> Bool {
        entry.contains("(") && entry.hasSuffix(")")
    }

    /// The permission rule that lets exactly this call through: the command, the file (as
    /// `//absolute/path`; Edit rules cover every file tool), the site. Nil when there is nothing
    /// narrow to allow (a command we did not see).
    static func allowRule(tool: String, detail: String) -> String? {
        let detail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        switch tool {
        case "Bash":
            return detail.isEmpty ? nil : "Bash(\(detail))"
        case "Write", "Edit", "MultiEdit", "NotebookEdit":
            guard detail.hasPrefix("/") else { return nil }
            return "Edit(/\(detail))"
        case "WebFetch":
            guard let host = URL(string: detail)?.host, !host.isEmpty else { return nil }
            return "WebFetch(domain:\(host))"
        default:
            // A tool with no narrower rule (MCP tools, Skill…): the tool itself, like the tool
            // question's "Always allow".
            return neverAlways.contains(tool) ? nil : tool
        }
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
        noteProgress(of: event)
        switch event {
        case .reply, .trace, .permission, .usage:
            // The resumed session is alive.
            resumeProbe = false
            resumeRetry = nil
        default:
            break
        }
        switch event {
        case let .rateLimits(limits):
            onRateLimits?(limits)
        case .connectionTrouble:
            if !retryingConnection { retryingConnection = true }
        case let .usage(total, tokens):
            // A running total for the session: what this turn cost is the difference.
            let spent = max(0, total - sessionCost)
            sessionCost = max(sessionCost, total)
            if spent > 0 { onSpend?(spent) }
            if tokens.total > 0 { onTokens?(tokens) }
        case let .trace(step):
            if case let .toolUse(id, tool, _, detail, _) = step {
                if toolCalls.count > 500 { toolCalls.removeAll() }
                toolCalls[id] = (tool, detail)
            }
            if trace.apply(step) { store?.save(subagents: trace.subagents) }
            noteSubagentEnd(step)
            switch step {
            case .subagentWaiting:
                // claude wakes it to say a subagent is still waiting on its own work (each
                // time a Monitor or background command of that subagent reports): a turn with
                // nothing new for you, unless something else comes in it.
                if !isWorking, internalReply == nil, groupReply == nil { quietTurn = true }
            case .subagentEnded:
                // A real report: the turn tells you about it.
                quietTurn = false
            default:
                break
            }
            // It started a turn of its own (a subagent in the background finished): it is at
            // work again, and the reply will show.
            if !isWorking, internalReply == nil, groupReply == nil, Self.startsATurn(step) {
                cancelIdle()
                isWorking = true
            } else if case .subagentEnded = step, !isWorking, phase == .awake, sleepsAt != nil {
                // Its report turn comes next: the countdown starts over, so the bot does not
                // begin tidying in the moment between the two.
                scheduleIdle()
            }
        case let .permission(request):
            ask(permission: request, from: source)
        case let .permissionDenied(denial):
            showDenial(denial)
        case let .permissionCancelled(requestID):
            if let id = permissionAsks.first(where: { $0.value.request.id == requestID })?.key {
                permissionAsks[id] = nil
                settle(id)
            }
        case .reply(var text, let isError):
            // The turn stopped to take in what you added: the next one answers it all.
            if interruptions > 0 {
                if isError {
                    interruptions -= 1
                    return
                }
                // A turn that ended well before the interrupt reached it: nothing more is coming
                // back for the interrupts sent so far.
                interruptions = 0
            }
            turnInput = nil
            let quiet = quietTurn
            quietTurn = false
            // `<choices>` and other tags written before a tool call are not in claude's result
            // (only the words after the last call are): they count as part of the reply.
            let lifted = trace.liftReplyTags()
            if !isError { text = ReplyParser.lifting(lifted, into: text) }
            if let waiter = internalReply {
                internalReply = nil
                trace.dropSteps()
                waiter.resume(returning: text)
                return
            }
            if groupReply != nil || dropNextReply {
                // The steps go with the reply to the group's line, not to this chat.
                let steps = trace.takeSteps()
                isWorking = false
                dropNextReply = false
                // It may have edited its routines.cron.
                reloadRoutines()
                finishGroupReply(isError ? .failed(text) : .reply(text, steps: steps))
                afterTurn()
                Task { [weak self] in await self?.flushQueue() }
                return
            }
            if isError, NetworkResume.isConnectionError(text) {
                showNetworkLoss(text)
                return
            }
            if quiet, !isError {
                // "Still running": no bubble, and nothing unread.
                trace.dropSteps()
                isWorking = false
                reloadRoutines()
                afterTurn()
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
            // Gone because of the network (or gone while waiting for it): its session and the
            // subagents still at work are picked up again when the network is back.
            let lostToNetwork = exitWaiter == nil && (outage != nil || (status != 0 && NetworkResume.mentionsConnectionError(stderr)))
            let cutOff = lostToNetwork ? trace.subagents.filter(\.isRunning).map(\.id) : []
            let session = sessionID
            let failedResume = resumeProbe && exitWaiter == nil && !lostToNetwork ? resumeRetry : nil
            let resumeFailed = resumeProbe && exitWaiter == nil && !lostToNetwork
            resumeProbe = false
            resumeRetry = nil
            process = nil
            sessionID = nil
            turnInput = nil
            interruptions = 0
            if !lostToNetwork { pausedWork = nil }
            quietTurn = false
            pausedQuiet = false
            if trace.stopRunning() { store?.save(subagents: trace.subagents) }
            dropPermissionAsks()
            dropNextReply = false
            finishGroupReply(.failed(stderr.isEmpty ? "It stopped (\(status))." : stderr))
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
            if resumeFailed {
                // `--resume` did not take (claude lost the session): the old process is gone, so
                // no handoff can be written; a fresh session reads memory and the recent chat.
                append(ChatMessage(role: .divider, text: "Couldn't go on in the same session → new session"))
                if let retry = failedResume {
                    wake(with: retry)
                } else if !queued.isEmpty {
                    Task { [weak self] in await self?.flushQueue() }
                }
                return
            }
            if lostToNetwork {
                let shown = outage != nil
                recordOutage(subagents: cutOff, lostSession: session)
                if !shown {
                    let line = stderr.split(whereSeparator: \.isNewline).first { NetworkResume.isConnectionErrorLine(String($0)) }
                    append(ChatMessage(role: .error, text: NetworkResume.lostText(line.map(String.init) ?? "")))
                    unreadCount += 1
                }
            } else if status != 0 {
                append(ChatMessage(role: .error, text: stderr.isEmpty ? "claude exited unexpectedly (\(status))" : stderr))
            }
            // What you said here while a group turn ran still gets an answer.
            if !queued.isEmpty { Task { [weak self] in await self?.flushQueue() } }
        }
    }

    /// Something the bot itself does (not one of its subagents), which only happens in a turn.
    static func startsATurn(_ event: TraceEvent) -> Bool {
        switch event {
        case let .toolUse(_, _, _, _, parent), let .text(_, parent): parent == nil
        default: false
        }
    }

    private func afterTurn() {
        // A restart waiting is done before the next message, not now: an idle bot costs nothing.
        scheduleIdle()
    }

    // MARK: Network and quiet runs

    /// Something happened in the turn under way (or one starts).
    private func noteProgress() {
        lastProgress = now()
        stallReminded.remove("")
    }

    private func noteProgress(of event: AgentEvent) {
        switch event {
        case .connectionTrouble, .rateLimits, .exited:
            return
        case let .trace(step):
            if let id = Self.subagentID(of: step) {
                subagentProgress[id] = now()
                stallReminded.remove(id)
            }
        default:
            break
        }
        noteProgress()
        if retryingConnection { retryingConnection = false }
    }

    /// The subagent a trace event belongs to, if any.
    static func subagentID(of step: TraceEvent) -> String? {
        switch step {
        case let .toolUse(_, _, _, _, parent), let .toolResult(_, _, _, parent), let .toolImages(_, _, parent), let .text(_, parent): parent
        case let .subagentStarted(id, _, _, _, _): id
        case let .subagentWaiting(id): id
        case .subagentEnded, .subagentNamed: nil
        }
    }

    /// A subagent's call returned (its agentId, for SendMessage) or it ended with claude's
    /// connection error: then it waits for the network like the bot.
    private func noteSubagentEnd(_ step: TraceEvent) {
        let id: String
        let text: String
        switch step {
        case let .toolResult(callID, output, _, _):
            guard trace.subagent(callID) != nil else { return }
            if let agentID = NetworkResume.agentID(in: output) { agentIDs[callID] = agentID }
            id = callID
            text = output
        case let .subagentEnded(callID, status, summary):
            id = callID
            // A notification says more than the error, so a failed one counts if any line is it.
            guard status == "failed" || status == "error" || NetworkResume.isConnectionError(summary ?? "") else { return }
            text = (summary ?? "").split(whereSeparator: \.isNewline).first { NetworkResume.isConnectionErrorLine(String($0)) }.map(String.init) ?? ""
        default:
            return
        }
        guard let subagent = trace.subagent(id), !subagent.isRunning, NetworkResume.isConnectionError(text) else { return }
        recordOutage(subagents: [id])
    }

    /// Its turn ended with claude's connection error: say so, and wait for the network instead
    /// of going to sleep.
    private func showNetworkLoss(_ text: String) {
        isWorking = false
        recordOutage(turnFailed: true)
        var message = ChatMessage(role: .error, text: NetworkResume.lostText(text))
        message.steps = trace.takeSteps()
        append(message)
        unreadCount += 1
    }

    private func recordOutage(turnFailed: Bool = false, subagents: [String] = [], lostSession: UUID? = nil) {
        var record = outage ?? Outage(since: now())
        if turnFailed { record.turnFailed = true }
        for id in subagents where !record.subagents.contains(id) { record.subagents.append(id) }
        if let lostSession { record.lostSession = lostSession }
        if record != outage { outage = record }
        retryingConnection = false
        cancelIdle()
    }

    /// The network is back (`date`: when that was seen). Within `NetworkResume.warmWindow` of the
    /// failure it goes on in the same session and continues its subagents; later, cut-off
    /// subagents start over as new ones in their worktree with their prompt and one added line.
    public func networkRestored(at date: Date) {
        guard let outage, !removed else { return }
        self.outage = nil
        retryingConnection = false
        let elapsed = max(0, date.timeIntervalSince(outage.since))
        let warm = elapsed <= NetworkResume.warmWindow
        let cut = outage.subagents.compactMap { id in
            trace.subagent(id).map { NetworkResume.CutOff(description: $0.description, type: $0.type, prompt: $0.prompt, agentID: agentIDs[id]) }
        }
        let note = NetworkResume.resumeNote(elapsed: elapsed, carryOn: outage.turnFailed || outage.lostSession != nil, subagents: cut)
        append(ChatMessage(role: .divider, text: NetworkResume.restoredText(elapsed: elapsed, warm: warm, subagents: cut.count)))
        if phase == .asleep, warm, let session = outage.lostSession {
            // The process went away with it: the same session again, while its cache is warm.
            do {
                let process = try start(resuming: session)
                phase = .awake
                isWorking = true
                process.send(note)
                return
            } catch {
                // Could not resume it: a fresh session (memory and the recent chat) below.
            }
        }
        route(Outgoing(text: note))
    }

    /// Reminds you once per quiet spell when the turn under way, or a subagent at work, has shown
    /// no new step for `interval` (0 or less: never). Not while it waits for you or for the network.
    @discardableResult
    public func checkStall(now date: Date, after interval: TimeInterval) -> [String] {
        guard interval > 0, outage == nil, process != nil, !waitingForPermission else { return [] }
        let minutes = max(1, Int((interval / 60).rounded()))
        var lines: [String] = []
        var quietForeground = false
        for subagent in trace.subagents where subagent.isRunning && !stallReminded.contains(subagent.id) {
            let last = subagentProgress[subagent.id] ?? subagent.startedAt
            guard date.timeIntervalSince(last) >= interval else { continue }
            stallReminded.insert(subagent.id)
            if !subagent.background { quietForeground = true }
            lines.append("子代理「\(subagent.description.isEmpty ? "Subagent" : subagent.description)」已經 \(minutes) 分鐘沒有新的步驟了。")
        }
        if isWorking, phase == .awake, let last = lastProgress, date.timeIntervalSince(last) >= interval, !stallReminded.contains("") {
            stallReminded.insert("")
            // Waiting on a quiet subagent is that subagent's quiet spell, already said.
            if !quietForeground { lines.insert("\(name) 已經 \(minutes) 分鐘沒有新的步驟了。", at: 0) }
        }
        guard !lines.isEmpty else { return [] }
        append(ChatMessage(role: .notice, text: lines.joined(separator: "\n") + "\n可能卡住了：可以再等等，或傳訊息問它在做什麼。"))
        unreadCount += 1
        return lines
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
        // A subagent still at work in the background would stop with the process: wait for it.
        // Cut off by the network, it keeps its session for when the network is back.
        if trace.subagents.contains(where: \.isRunning) || outage != nil, !removed {
            scheduleIdle()
            return
        }
        cancelIdle()
        phase = .tidying
        // A bot with no memory (Codex) has nothing to write down.
        if profile.keepsMemory { _ = await ask(prompts.tidy) }
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
        pendingRestart = nil
        resumeProbe = false
        resumeRetry = nil
        let running = process
        process = nil
        running?.stop()
        dropPermissionAsks()
        dropNextReply = false
        finishGroupReply(.failed("It was removed."))
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

    /// Picks its model. Asleep: the next wake uses it. Awake: it goes on in the same session on
    /// `newModel` (`--resume --model`) just before its next message, so a running turn or a
    /// subagent at work is not cut off and nothing is written down or read back.
    public func switchModel(to newModel: BotModel) async {
        guard newModel != model else { return }
        model = newModel
        store?.save(model: newModel)
        guard phase != .asleep else {
            append(ChatMessage(role: .divider, text: "Switched to \(newModel.displayName)"))
            return
        }
        await restart(divider: "Handoff → \(newModel.displayName)")
    }

    /// Picks the model its subagents use. Awake: restarts before its next message, like a model
    /// switch; asleep: the next wake uses it.
    public func setSubagentModel(_ newModel: BotModel?) async {
        guard newModel != subagentModel else { return }
        subagentModel = newModel
        store?.save(subagentModel: newModel)
        await restart(divider: "Handoff → subagents on \(newModel?.displayName ?? "the same model")")
    }

    /// Picks how hard it thinks. Awake: restarts before its next message; asleep: the next wake.
    public func setEffort(_ newEffort: EffortLevel?) async {
        guard newEffort != effort else { return }
        effort = newEffort
        store?.save(effort: newEffort)
        await restart(divider: "Handoff → \(newEffort?.displayName ?? "default") effort")
    }

    /// Codex review of its subagents' work. Takes effect at once: an awake bot is told with its
    /// next message, an asleep one reads it when it wakes.
    public func setCodexSettings(_ settings: CodexSettings) {
        guard settings != codexSettings else { return }
        codexSettings = settings
        store?.save(codexSettings: settings)
        onCodexSettings?(settings)
    }

    /// Its own components (kept in bot.json).
    public func setComponentList(_ names: [String]) {
        guard names != componentList else { return }
        componentList = names
        store?.save(componentList: names)
    }

    /// Changes its pins (see `Workspace+Pins`) and saves them, if anything changed.
    public func editPins(_ change: (inout [PinnedComponent]) -> Void) {
        var edited = pins
        change(&edited)
        guard edited != pins else { return }
        pins = edited
        store?.save(pins: edited)
    }

    /// Changes its component specs (see `Workspace+Specs`) and saves them, if anything changed.
    public func editSpecs(_ change: (inout [ComponentSpec]) -> Void) {
        var edited = specs
        change(&edited)
        guard edited != specs else { return }
        specs = edited
        store?.save(specs: edited)
    }

    /// Plugins' Claude parts changed. Asleep: the next wake loads them. Awake: it restarts just
    /// before its next message, so the new skills and agents are there. Many changes make one
    /// restart, and changes that come back to what its session has make none.
    public func reloadPlugins() async {
        // Its session already has these (they changed back, or it started after the change).
        if let stamp = pluginStamp?(), stamp == loadedPluginStamp {
            if pendingRestartForPluginsOnly {
                pendingRestart = nil
                pendingRestartForPluginsOnly = false
            }
            return
        }
        let waiting = pendingRestart != nil
        await restart(divider: "Handoff → loading new plugins")
        if !waiting, pendingRestart != nil { pendingRestartForPluginsOnly = true }
    }

    /// Restarts it so it picks up what it starts with (plugins, folders, model, effort). Asleep:
    /// nothing to do, the next wake has it. Awake: marked, and done just before its next real
    /// message (see `restartsBeforeMessage`): an idle bot costs nothing, and a turn or a
    /// subagent at work is never cut off. Several restarts asked for make one.
    public func restart(divider: String) async {
        guard phase != .asleep else {
            pendingRestart = nil
            pendingRestartForPluginsOnly = false
            return
        }
        pendingRestart = divider
        pendingRestartForPluginsOnly = false
    }

    /// A restart waits and nothing would be lost by doing it now: no turn, no subagent at work
    /// (in the background too: the restart would end it), no question waiting.
    private var restartsBeforeMessage: Bool {
        pendingRestart != nil && phase == .awake && process != nil && !isWorking && internalReply == nil
            && groupReply == nil && permissionAsks.isEmpty && outage == nil && !removed
            && !trace.subagents.contains(where: \.isRunning)
    }

    /// Does the restart waiting: the same session again (`--resume`), or, when claude kept no
    /// transcript of it, a handoff written into memory.md and a new session. Then the messages
    /// that waited go on.
    private func restartWaiting() async {
        guard let divider = pendingRestart else {
            if phase == .switching(.stopping) { phase = .awake }
            await flushQueue()
            return
        }
        pendingRestart = nil
        let pluginsOnly = pendingRestartForPluginsOnly
        pendingRestartForPluginsOnly = false
        if pluginsOnly, let stamp = pluginStamp?(), stamp == loadedPluginStamp {
            // The plugins came back to what its session has.
            phase = .awake
            await flushQueue()
            return
        }
        if let session = sessionID, sessionExists(session, profile.workingDirectory) {
            await resume(session, divider: divider)
        } else {
            await handOver(divider: divider)
        }
    }

    static func resumedDivider(_ divider: String) -> String {
        divider.hasPrefix("Handoff → ") ? "Restarted → " + divider.dropFirst("Handoff → ".count) : divider
    }

    /// Ends the process and goes on in the same session (`--resume`) with what it starts with
    /// now: no handoff turn, no memory read back, the prompt cache stays warm. claude keeps the
    /// session's first system prompt on `--resume` (a new `--append-system-prompt` is ignored),
    /// so what may have changed since (the briefing) goes with the next message.
    private func resume(_ session: UUID, divider: String) async {
        cancelIdle()
        switchTarget = model
        phase = .switching(.stopping)
        await finishProcess()
        guard !removed else { return }
        phase = .switching(.starting)
        do {
            _ = try start(resuming: session)
            phase = .awake
            append(ChatMessage(role: .divider, text: Self.resumedDivider(divider)))
            resumeProbe = true
            resumeRetry = nil
            let reason = divider.hasPrefix("Handoff → ") ? String(divider.dropFirst("Handoff → ".count)) : divider
            let briefing = wakeNote?() ?? ""
            let note = "(App: ClaudeCodeBot restarted you in this same conversation (\(reason)); carry on as before." + (briefing.isEmpty ? ")" : " What the app tells you at a wake, as it is now:)\n" + briefing)
            pendingNote = [note, pendingNote].compactMap { $0 }.joined(separator: "\n\n")
            scheduleIdle()
        } catch {
            // The old process is gone already: the messages waiting wake a fresh session.
            phase = .asleep
            append(ChatMessage(role: .error, text: "Restart failed: \(error.localizedDescription)"))
        }
        switchTarget = nil
        await flushQueue()
    }

    /// Writes a handoff, stops, and starts a new session on its model reading it.
    private func handOver(divider: String) async {
        cancelIdle()
        switchTarget = model
        phase = .switching(.writing)
        _ = await ask(prompts.handoff)
        guard !removed else { return }
        phase = .switching(.stopping)
        await finishProcess()
        phase = .switching(.starting)
        append(ChatMessage(role: .divider, text: divider))
        do {
            _ = try start()
            let briefing = wakeNote?() ?? ""
            let reply = await ask(briefing.isEmpty ? prompts.resume : prompts.resume + "\n\n" + briefing)
            guard !removed else { return }
            phase = process == nil ? .asleep : .awake
            if !BotPrompts.isPlainOK(reply) {
                // Read like any reply: its <choices> become buttons, <show> components and
                // requests are acted on, rather than showing the raw tags.
                let parsed = ReplyParser.parseAll(reply)
                var message = ChatMessage(role: .bot, text: parsed.body, choices: parsed.choices)
                if !parsed.displays.isEmpty { message.displays = parsed.displays }
                if !message.text.isEmpty || message.choices != nil || message.displays != nil {
                    append(message)
                }
                if !parsed.requests.isEmpty { onRequests?(parsed.requests) }
            }
            if phase == .awake { scheduleIdle() }
        } catch {
            phase = .asleep
            append(ChatMessage(role: .error, text: "Restart after handoff failed: \(error.localizedDescription)"))
        }
        switchTarget = nil
        await flushQueue()
    }

    /// Whether claude kept the transcript of `session`, started in `folder`: under
    /// `~/.claude/projects/<folder with every other character as ->/<session>.jsonl` (or
    /// `$CLAUDE_CONFIG_DIR/projects`), or, for a folder claude names differently (a long path,
    /// a symlink), in any project folder there.
    public nonisolated static func claudeSessionExists(_ session: UUID, in folder: URL, config: URL? = nil) -> Bool {
        let config = config ?? ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"].map { URL(filePath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude")
        let projects = config.appending(path: "projects")
        let file = session.uuidString.lowercased() + ".jsonl"
        let named = String(folder.standardizedFileURL.path.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        if FileManager.default.fileExists(atPath: projects.appending(path: named).appending(path: file).path) { return true }
        let folders = (try? FileManager.default.contentsOfDirectory(atPath: projects.path)) ?? []
        return folders.contains { FileManager.default.fileExists(atPath: projects.appending(path: $0).appending(path: file).path) }
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
        guard !queued.isEmpty else { return }
        let waiting = queued
        queued.removeAll()
        // One message goes as it is (yours stays yours to add to).
        if waiting.count == 1 {
            route(waiting[0])
            return
        }
        let text = waiting.map(\.text).joined(separator: "\n\n")
        route(Outgoing(text: text, images: waiting.flatMap(\.images)))
    }

    private func append(_ message: ChatMessage) {
        messages.append(message)
        store?.save(messages: messages)
        archive(message)
        onNewMessage?(message)
    }

    /// Adds a line to this month's file in its archive (the bot greps it for older talk).
    private func archive(_ message: ChatMessage) {
        guard let entry = Self.archiveEntry(message) else { return }
        let folder = profile.archiveURL
        let month = message.date.formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)", timeZone: .current, calendar: .current))
        let file = folder.appending(path: "\(month).md")
        let data = Data((entry + "\n\n").utf8)
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: file)
        }
    }

    /// Writes a whole chat into a new archive, a file per month.
    static func archiveAll(_ messages: [ChatMessage], in folder: URL) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let months = Dictionary(grouping: messages.compactMap { message in
            archiveEntry(message).map { (month: message.date.formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)", timeZone: .current, calendar: .current)), entry: $0) }
        }, by: \.month)
        for (month, entries) in months {
            try? Data(entries.map { $0.entry + "\n\n" }.joined().utf8).write(to: folder.appending(path: "\(month).md"))
        }
    }

    /// "[2026-10-20 13:16] User: …", with files and options, the way a wake-up shows lines.
    static func archiveEntry(_ message: ChatMessage) -> String? {
        var text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let files = message.attachments, !files.isEmpty {
            text += (text.isEmpty ? "" : " ") + "(files: " + files.map(\.url.path).joined(separator: ", ") + ")"
        }
        if let choices = message.choices, !choices.isEmpty {
            text += " [options: " + choices.map(\.label).joined(separator: " / ") + "]"
        }
        guard !text.isEmpty else { return nil }
        let stamp = message.date.formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits) \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits)", timeZone: .current, calendar: .current))
        return "[\(stamp)] \(speaker(message.role)): \(text)"
    }

    static func speaker(_ role: ChatMessage.Role) -> String {
        switch role {
        case .user: "User"
        case .bot: "You"
        case .relay: "Handed to you"
        case .notice: "App notice"
        case .divider: "—"
        case .error: "Error"
        }
    }
}
