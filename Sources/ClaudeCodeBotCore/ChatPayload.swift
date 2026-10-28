import Foundation

/// What the web chat surface draws: the chat as plain values, encoded to JSON for
/// `ccb.setState(...)`. Field names match `Web/src/types.ts`.
public struct ChatPayload: Encodable, Equatable {
    public struct Choice: Encodable, Equatable {
        var label: String
        var detail: String?
        var recommended: Bool
        /// A tool question's button: what it does (`Choice.Action`), apart from its words.
        var action: String?
        var id: String? = nil
    }

    public struct File: Encodable, Equatable {
        var id: String?
        var name: String
        var kind: String
        var url: String
    }

    public struct ReactionView: Encodable, Equatable {
        var emoji: String
        var actors: [String]
        var own: Bool
    }

    public struct Message: Encodable, Equatable {
        var id: String
        var role: String
        var text: String
        var stamp: String?
        var avatar: String?
        var choices: [Choice]?
        var chosen: Int?
        var answer: String?
        var open: Bool
        /// The components it shows, each with where in `text` it goes.
        var displays: [Display]?
        var attachments: [File]?
        var replyTo: String?
        var replyPreview: String?
        var openable: Bool
        /// Who said it, above the bubble (a group chat, or a bot called into this one with @).
        var speaker: String?
        /// What the bot did on the way to this reply.
        var steps: [StepView]?
        /// Result pages it links to, drawn as 「網頁預覽卡片」 cards under it.
        var previews: [Display]?
        /// A "not right" report handed over: shown as who it is about and the user's words, with
        /// `text` (the chat around it) folded.
        var feedback: Feedback?
        /// Component specs made from it: a quiet chip each, under the reply.
        var specs: [SpecChip]? = nil
        /// The library component the reply already is ("Add to another bot…" instead of "Make
        /// into component").
        var component: String? = nil
        /// The chat's background work (all that runs, and what finished since your latest line), on
        /// the bot's latest reply only (nil on the others): one row of counts (subagents, waiting,
        /// done, failed) that moves down as replies arrive.
        var tasks: [TaskChip]? = nil
        /// claude.ai Artifacts it links to, drawn as cards under it (the links stay chips too).
        var artifacts: [ArtifactLink.Card]? = nil
        /// Before your latest line: its finished subagents leave the folded steps line (the
        /// unfolded steps still list them).
        var earlier: Bool? = nil
        /// A call auto mode blocked that a subagent made: which one (drawn above the card, with
        /// a way to open it).
        var fromSubagent: SubagentRef? = nil
        /// In a bot with two heads: each head, and whether this line has reached it ("C", "X").
        var reactionEnabled: Bool? = nil
        var reactions: [ReactionView]? = nil
        var seen: [Seen]? = nil
        /// When it was sent, in a subagent's view: its task and each message its bot sent it
        /// ("From Main · 15:58").
        var time: String? = nil
        /// A bot's turn cut off before it answered: what it had said and done so far.
        var interrupted: Bool? = nil
        var completionVerification: CompletionVerification? = nil
        /// Source provenance: persisted message identity, never inferred from current engine settings.
        var sourceAuthor: String? = nil
        var sourceEngine: String? = nil
        var sourceTime: String? = nil
        var decisionID: String? = nil
        /// The task cards it belongs to: a chip each under the reply.
        var taskCards: [TaskCardChip]? = nil
    }

    /// A task card as the chip under one of its replies (and beside a summary's bullet) shows it.
    public struct TaskCardChip: Encodable, Equatable {
        var id: String
        var name: String
        /// pending, running, waiting, done, stopped, or stale (running, maybe stuck).
        var state: String
        var owner: String?
        /// On the task's latest reply only: what it does now, or what it waits on.
        var detail: String?
        /// The right panel shows this task open.
        var selected: Bool?

        @MainActor
        static func of(_ task: TaskCard, in bot: Bot, latest: Bool, selected: UUID?, now: Date) -> TaskCardChip {
            let stale = bot.isStale(task, at: now)
            let detail: String? = switch task.state {
            case _ where stale: L("May be stuck")
            case .running: task.now.map { L("Now: {0}", $0) }
            case .waiting: L("Waiting on you: {0}", task.blocked ?? task.now ?? L("your reply"))
            default: nil
            }
            return TaskCardChip(id: task.id.uuidString, name: task.name, state: stale ? "stale" : task.state.rawValue,
                                owner: task.owner?.rawValue, detail: latest ? detail : nil, selected: selected == task.id ? true : nil)
        }
    }

    public struct SubagentRef: Encodable, Equatable {
        var id: String
        var title: String
    }

    /// Background work under a reply: a command or a subagent, with how it is doing. Times are
    /// milliseconds since 1970, so the page can count the time it has been running.
    public struct TaskChip: Encodable, Equatable {
        var id: String
        var kind: String
        var title: String
        /// running, completed, failed, killed, stopped (its bot's process ended) or interrupted
        /// (the app restarted).
        var status: String
        var started: Double
        var ended: Double?
        /// The command or the subagent's task, for the chip's tooltip.
        var detail: String?
        /// The message whose turn started it (its output is asked for by that message's id).
        var message: String
        /// A wake-up's or one-shot cron job's time (ms since 1970).
        var fires: Double?
        /// A cron job's five fields, and whether it fires on every match.
        var schedule: String?
        var recurring: Bool?

        init(_ task: BackgroundTask, from messageID: UUID) {
            message = messageID.uuidString
            id = task.id
            kind = task.kind.rawValue
            title = task.title
            status = task.status.rawValue
            started = (task.startedAt.timeIntervalSince1970 * 1000).rounded()
            ended = task.endedAt.map { ($0.timeIntervalSince1970 * 1000).rounded() }
            detail = task.detail
            fires = task.fireAt.map { ($0.timeIntervalSince1970 * 1000).rounded() }
            schedule = task.schedule
            recurring = task.recurring
        }
    }

    /// A component made from a reply, under it: a chip while it is a suggestion or being built
    /// (pressed: a suggestion starts its build, otherwise the spec opens in the right panel), then
    /// the component itself with "Edit spec".
    public struct SpecChip: Encodable, Equatable {
        var id: String
        var name: String
        var status: String
        /// A bot suggested it (nothing has run or been built).
        var suggested: Bool
        /// It shows in the right panel now.
        var open: Bool
        /// The library component it became, drawn under the reply (also while a new version
        /// builds), with its command's run as for any card.
        var component: String? = nil
        var display: Display? = nil
        /// The bot that wrote the reply is drawing the built component for it now (its name).
        var filling: String? = nil
    }

    public struct Feedback: Encodable, Equatable {
        var about: String
        var words: String
    }

    /// One line of work, as the page draws it. A subagent's line carries how it is doing.
    public struct StepView: Encodable, Equatable {
        var id: String
        var kind: String
        var tool: String?
        var title: String
        var detail: String?
        var output: String?
        var failed: Bool
        var done: Bool
        /// For a subagent: running, completed, failed or stopped, and its tool calls so far.
        var status: String?
        var count: Int?
        /// The pictures it gave back, drawn in its OUT box; click one to open it full size.
        var images: [StepImage]? = nil
    }

    /// A picture a tool call gave back: the `file:` URL the page loads, and its name.
    public struct StepImage: Encodable, Equatable {
        var url: String
        var name: String
        /// A small copy to show in the chat (`url` opens when it is clicked); nil to show `url`.
        var thumb: String? = nil
    }

    /// The top of the page while you look at a subagent (no input box: you only watch it).
    public struct SubagentHeader: Encodable, Equatable {
        var id: String
        var title: String
        var owner: String
        var status: String
        var type: String?
        /// Its reported execution backend, otherwise the head owning the trace/store, for its badge.
        var engine: String = "claude"
        /// Its model when known ("Sonnet"): what its Agent call asked for, else its bot's
        /// subagent model.
        var model: String? = nil
        var runtime: WorkerRuntimeInfo? = nil
        /// The parent head's effort, shown marked "inherited" when a Claude subagent reports none.
        var inheritedEffort: String? = nil
        /// Reported output only; epoch milliseconds, frozen on completion.
        var outputTokens: Double? = nil
        var startedAt: Double? = nil
        var endedAt: Double? = nil
    }

    public struct Display: Encodable, Equatable {
        var name: String
        var data: String
        /// Where in the message's text (UTF-16 offset); nil: after it.
        var at: Int?
        /// Set when its data comes from a command: the command, the folder it runs in, and how
        /// its run is going (see `ComponentCommands.Status`), with the error or when it last ran.
        var command: String?
        var folder: String?
        /// Its component's Detail command (about.md), which `ccb.runDetail` fills and runs in
        /// `folder`; allowed together with `command` on the card.
        var detail: String?
        /// Which card it is for its command's run (`ccb.runDetail(values, {save: true})` saves
        /// into it); set with `detail`.
        var card: String?
        var status: String?
        var error: String?
        var ranAt: String?
        /// Pictures its data names by file path, each to the URL its frame loads it from
        /// (`ccb.image(path)` in the template).
        var images: [String: String]? = nil
        /// In a chat that can pin: whether this component is pinned to the bot (its hover bar
        /// says so). Nil where nothing can be pinned.
        var pinned: Bool? = nil
        /// A card with a command: run it again every this many seconds while it is on screen
        /// (its `<show refresh>` or about.md's `Refresh:` line). Nil: only by hand (or as a pin's
        /// own refresh says).
        var every: Double? = nil
    }

    /// What drawing a chat's pins needs: their command runs, the folder they run in, and
    /// whether the Board is showing.
    public struct PinContext {
        public var runs: ComponentCommands
        public var folder: URL
        public var board: Bool
        /// Where pinned components' Detail commands are read from.
        public var library: ComponentLibrary?
        /// How many floating cards the chat shows now: whether one more may float there.
        public var floating: Int

        public init(runs: ComponentCommands, folder: URL, board: Bool = false, library: ComponentLibrary? = nil, floating: Int = 0) {
            self.runs = runs
            self.folder = folder
            self.board = board
            self.library = library
            self.floating = floating
        }
    }

    /// A component pinned to the bot: a chip above the input box and a card on its Board.
    public struct Pin: Encodable, Equatable {
        var id: String
        var name: String
        /// One line from its data: its chip's tooltip.
        var headline: String
        /// What its chip shows beside its icon: what the component set (`ccb.setStatus`), else
        /// `headline` cut short; its command's state when that matters.
        var chip: PinStatus
        /// Its Board card, "3x2": any columns × rows up to 4×4.
        var size: String
        /// Its card's top-left cell on the Board; nil: not laid out yet (the page places it).
        var place: PinnedComponent.Place? = nil
        /// How tall it opens above the input box, as the user dragged it; nil: its content's height.
        var panelHeight: Int?
        var refresh: String
        var minutes: Int
        /// Every this many seconds instead of `minutes` (a pin refreshed every few seconds).
        var seconds: Int? = nil
        /// The component as drawn, with its command's run as for a card in the chat.
        var display: Display
        /// Maintainer is giving it a command so it refreshes here ("making it live…").
        var makingLive: Bool? = nil
        /// Where it floats in a corner of the window; nil: it does not.
        var float: PinnedComponent.Floating? = nil
        /// Its menu's float entry: "float", "stop" or "full".
        var floatMenu: Pins.FloatMenu? = nil
    }

    /// A pin floating in a corner of a chat: its own bot's, or another bot's shown in all bots.
    /// Its bot, and the pin.
    public struct FloatingPin: Encodable, Equatable {
        var botID: String
        var botName: String
        var pin: Pin
        /// Shown in every bot's chat ("Show in all bots"); nil: only in its own.
        var global: Bool? = nil
        /// Not global, and a chat that already shows `Pins.maxFloating` cards would get one more:
        /// that chat's name, for its menu's "Show in all bots" (off). Nil: it may be.
        var blocked: String? = nil

        public init(botID: String, botName: String, pin: Pin, global: Bool = false, blocked: String? = nil) {
            self.botID = botID
            self.botName = botName
            self.pin = pin
            self.global = global ? true : nil
            self.blocked = blocked
        }
    }

    /// A component the picker offers: one this bot drew, or one with a Command.
    public struct PinChoice: Encodable, Equatable {
        var name: String
        var command: String?
        /// How often this bot drew it.
        var uses: Int
        var pinned: Bool
    }

    /// What drawing components with commands needs: their runs, and the folder each message's
    /// commands run in (the project of the bot that wrote it).
    public struct CommandContext {
        public var runs: ComponentCommands
        public var folder: (ChatMessage) -> URL

        public init(runs: ComponentCommands, folder: @escaping (ChatMessage) -> URL) {
            self.runs = runs
            self.folder = folder
        }
    }

    public struct Reply: Encodable, Equatable {
        var id: String
        var who: String
        var preview: String
    }

    public struct Component: Encodable, Equatable {
        var template: String
        var version: Int
        var working: Bool
        var updated: Bool
        var hasPrevious: Bool
        /// The Board sizes its about.md's optional `Sizes:` line hints at ("2x2", …): the first
        /// is what a new pin gets, the widest how the chat draws it. Any size may still be picked.
        var sizes: [String] = [PinnedComponent.Size.large.rawValue]
        /// Its pin chip's icon (about.md's `Icon:`): an SF Symbol name or an emoji.
        var icon: String? = nil
        /// An SF Symbol `icon` drawn as a PNG data URL (the page cannot draw symbols itself).
        var iconImage: String? = nil
        /// Its short human name from its about.md's first line ("發版進度卡"), for an opened or
        /// floating pin's header; nil: the page shows its folder name.
        var title: String? = nil
    }

    var chatAvatarSize: Int? = nil
    var botID: String
    var botName: String
    var messages: [Message]
    var working: Bool
    /// The coordinator is free to chat while its workers continue. This does not mark a turn active.
    var waitingForWorkers: Bool = false
    var avatar: String
    var placeholder: String
    var replyingTo: Reply?
    var pendingFiles: [File]
    var components: [String: Component]
    /// Bots you can @, for completing them as you type: a group's members, or in a bot's own
    /// chat the other bots, to call one in.
    var mentions: [String]
    /// Every bot you could @ here, searched once you type letters after @ or open with @@: in a
    /// bot's own chat every bot that can be called in (the short list first); in a group, its
    /// members (a bot outside it can't be called in).
    var allMentions: [String]
    /// What you can / (every chat you can type in): the app's commands, then components.
    var slashCommands: [SlashCommands.Command] = SlashCommands.all
    var slashComponents: [String] = []
    /// The shared library's other components (not on this bot's own list), offered after its own.
    var slashLibrary: [String] = []
    /// What it is doing right now, while it works.
    var live: [StepView]
    /// Set while you look at one of its subagents instead of the chat.
    var subagent: SubagentHeader?
    /// Developer mode: replies can be flagged as not right.
    var feedback = false
    /// The bot's pinned components, in order; nil where nothing can be pinned (a subagent).
    var pins: [Pin]? = nil
    /// What the pin picker offers.
    var pinChoices: [PinChoice]? = nil
    /// The Board is showing instead of the messages.
    var board: Bool? = nil
    /// The pins floating in a corner of this chat: its own, and other bots' shown in all bots;
    /// nil where none can show (a subagent).
    var floating: [FloatingPin]? = nil
    /// Replies can be made into components (their hover column and result cards say so).
    var makeComponents: Bool? = nil
    /// The language the page's own words are in (Settings → General → Language): "en", "zh-Hant",
    /// "zh-Hans", "ja" or "ko". What bots wrote and components show stay as they are.
    var lang: String = L10n.language.rawValue
    /// A bot with two heads: who the next message goes to ("Answer with" above the input box).
    var answerWith: AnswerWith? = nil
    /// A loop between the heads under way: "Round 2 of 3", with its Stop now button's words.
    var rounds: Rounds? = nil
    /// The hand-offs between the heads (the latest message's, and older ones still under way),
    /// for the hand-off chip and panel over the input box; nil where there are none.
    var handoffs: [Handoff]? = nil
    /// Bot look Cute: each enabled head's tiny character by its mark ("C", "X").
    /// Also identifies the Cute look when a single-engine chat has no seen marks; nil is Original.
    var seenHeads: [String: String]? = nil
    /// Cute character animations, shared once per state rather than embedded in every message.
    var animatedHeads: [ChibiAnimation.Head]? = nil
    var avatarMood: String? = nil
    /// Unread messages folded on your return, with their summary; nil when there is no group.
    var catchUp: CatchUpView? = nil
    var intervalSummaries: [CatchUpView] = []

    /// The page's catch-up group: which messages it folds and what the summary says.
    public struct CatchUpView: Encodable, Equatable {
        /// The range and language summarized: the page remembers expanding by it.
        public var key: String
        public var ids: [String]
        /// The unread replies in it (dividers not counted).
        public var count: Int
        /// How many heads wrote them, when more than one.
        public var heads: Int?
        /// "loading", "ready" or "failed".
        public var state: String
        public var bullets: [String]
        public var error: String?
        public var model: String
        /// When the first and the last of them came ("18:04"), and who said the last and its first line.
        public var since: String? = nil
        public var until: String? = nil
        public var latest: String? = nil
        public var manual: Bool = false
        public var automatic: Bool = false
        public var speakerCounts: [String: Int]? = nil
        public var requestedBy: String? = nil
        /// The task cards with lines in the range, for the chips beside its bullets and the
        /// header's count; nil when there are none.
        public var tasks: [TaskCardChip]? = nil
    }

    /// Bot look Cute: the engine characters as image URLs. `avatar`: a head's
    /// character wearing the bot's face, for its replies; `mark`: its tiny head for seen marks.
    public struct HeadLook {
        public var avatar: (BotEngine) -> String
        public var mark: (BotEngine) -> String
        public var animations: [ChibiAnimation.Head]

        public init(avatar: @escaping (BotEngine) -> String, mark: @escaping (BotEngine) -> String, animations: [ChibiAnimation.Head] = []) {
            self.avatar = avatar
            self.mark = mark
            self.animations = animations
        }
    }

    /// The letter a head's seen mark has, and its key in `seenHeads`.
    static func markLetter(_ head: BotEngine) -> String { head == .claude ? "C" : "X" }

    public struct Rounds: Encodable, Equatable {
        var text: String
        var stop: String
        /// "discussion", "review" or "handoff", and where it stands, for the chip's meter.
        var kind: String? = nil
        var round: Int? = nil
        var limit: Int? = nil

        static func of(_ progress: RoundsProgress) -> Rounds {
            Rounds(text: progress.shown, stop: L("Stop now"), kind: progress.kind.rawValue, round: progress.round, limit: progress.limit)
        }
    }

    /// One hand-off as the panel over the input box lists it (see `HandoffRecord`).
    public struct Handoff: Encodable, Equatable {
        struct Line: Encodable, Equatable {
            var who: String
            var name: String
            var text: String
        }
        var id: String
        var from: String
        var to: String
        var fromName: String
        var toName: String
        /// "task", "review" or "discuss".
        var kind: String
        /// The hand-off's first line, for its row.
        var task: String
        var origin: String?
        var round: Int
        var limit: Int
        /// "running", "waiting", "done" or "stopped".
        var state: String
        var lines: [Line]

        /// The most characters a line of the conversation carries to the page.
        static let lineLimit = 1500

        static func of(_ record: HandoffRecord) -> Handoff {
            Handoff(
                id: record.id.uuidString, from: record.from.rawValue, to: record.to.rawValue,
                fromName: record.from.displayName, toName: record.to.displayName, kind: record.kind.rawValue,
                task: Conductor.excerpt(record.task, 160), origin: record.origin, round: record.round, limit: record.limit,
                state: record.state.rawValue,
                lines: record.lines.map { line in
                    Line(who: line.who.rawValue, name: line.who.displayName,
                         text: line.text.count > lineLimit ? String(line.text.prefix(lineLimit)) + "…" : line.text)
                }
            )
        }
    }

    /// A head's read receipt, plus whether this user message was directed to it.
    public struct Seen: Encodable, Equatable {
        var mark: String
        var name: String
        var seen: Bool
        /// User messages only: distinct from reading the other head's later context.
        var recipient: Bool? = nil
    }

    /// The marks for a line in a bot with two heads: your lines and the heads' replies.
    @MainActor
    static func seenMarks(_ message: ChatMessage, in bot: Bot) -> [Seen]? {
        guard bot.heads.hasTwo, message.role == .user || message.role == .bot else { return nil }
        return bot.heads.engines.map { head in
            Seen(mark: markLetter(head), name: head.displayName, seen: message.seenBy?.contains(head) == true,
                 recipient: message.role == .user ? message.to == nil || message.to == .both || message.to?.engine == head : nil)
        }
    }

    /// The "Answer with" chips: Both (the usual) and each head, and the one new messages go to.
    public struct AnswerWith: Encodable, Equatable {
        struct Option: Encodable, Equatable {
            var id: String
            var label: String
        }
        var options: [Option]
        var chosen: String

        @MainActor
        static func of(_ bot: Bot) -> AnswerWith? {
            guard bot.heads.hasTwo else { return nil }
            return AnswerWith(options: bot.heads.targets.map { Option(id: $0.rawValue, label: $0.displayName) }, chosen: bot.heads.answerWith.rawValue)
        }
    }

    /// What a group chat adds: who is typing, and names for who said each line. A bot's own chat
    /// has one too, for the bots called into it with @.
    public struct GroupView {
        public var typing: UUID?
        /// The bot answering now, whose steps show live while it works.
        public var working: Bot?
        public var speaker: (UUID) -> String?
        public var names: [String]
        /// Every name you could @, the short list (`names`) first.
        public var allNames: [String]

        public init(typing: UUID?, working: Bot? = nil, names: [String] = [], allNames: [String]? = nil, speaker: @escaping (UUID) -> String?) {
            self.typing = typing
            self.working = working
            self.names = names
            self.allNames = allNames ?? names
            self.speaker = speaker
        }
    }

    /// A file waiting in the composer.
    public struct Pending: Equatable, Sendable {
        public var id: UUID
        public var url: URL

        public init(id: UUID = UUID(), url: URL) {
            self.id = id
            self.url = url
        }
    }

    /// Where the chat's background-work row goes: the bot's latest reply (or notice), never your
    /// own line, when there is background work to show at all.
    static func backgroundRowIndex(in messages: [ChatMessage]) -> Int? {
        guard !shownBackgroundTasks(in: messages).isEmpty else { return nil }
        return messages.lastIndex { [.bot, .notice].contains($0.role) }
    }

    /// The background work the row shows, with the message that started each: all that still
    /// runs, and what finished since your latest line. Your next line clears the finished ones.
    static func shownBackgroundTasks(in messages: [ChatMessage]) -> [(task: BackgroundTask, message: UUID)] {
        let lastYours = messages.lastIndex { $0.role == .user }
        return messages.enumerated().flatMap { index, message in
            (message.backgroundTasks ?? []).compactMap { task -> (task: BackgroundTask, message: UUID)? in
                guard let lastYours, !task.isRunning, index < lastYours,
                      (task.endedAt ?? .distantPast) <= messages[lastYours].date else { return (task, message.id) }
                return nil
            }
        }
    }

    /// Builds the payload. `avatar` gives a face as a data URL: the bot's own (nil project), or a
    /// project's for its notices.
    @MainActor
    public static func make(
        bot: Bot,
        components library: ComponentLibrary?,
        pending: [Pending],
        replyingTo: UUID?,
        now: Date = Date(),
        group: GroupView? = nil,
        callIn: GroupView? = nil,
        feedback: Bool = false,
        share: Bool = false,
        commands: CommandContext? = nil,
        pins pinning: PinContext? = nil,
        specs: Bool = false,
        openSpec: UUID? = nil,
        selectedTask: UUID? = nil,
        floating: [FloatingPin]? = nil,
        look: HeadLook? = nil,
        sourceLook: ((UUID) -> HeadLook?)? = nil,
        chatAvatarSize: Int? = nil,
        catchUp: CatchUpView? = nil,
        intervalSummaries: [CatchUpView] = [],
        avatar: (_ projectID: UUID?) -> String
    ) -> ChatPayload {
        // Each guest wears its own bot's hat. Never infer an old reply's engine from settings.
        let look = group == nil ? look : nil
        let pinnedNames = pinning.map { _ in Set(bot.pins.map(\.name)) }
        let own = avatar(nil)
        let main = bot.profile.role == .main ? own : nil
        let speaker = group?.speaker ?? callIn?.speaker
        // Someone called in is answering while neither of the bot's own engines is working.
        let guest = bot.isWorking || bot.partner?.isWorking == true ? nil : callIn?.typing
        // The live bubble's face and steps must describe the same process.
        let workingBot = group.map(\.working) ?? (bot.isWorking ? bot : bot.partner?.isWorking == true ? bot.partner : guest.flatMap { _ in callIn?.working })
        let sourceIDs = Set(bot.messages.filter { $0.role == .bot && $0.engine != nil && $0.subagentID == nil }.compactMap(\.sourceID)
            + [group?.typing ?? guest].compactMap { $0 }).sorted { $0.uuidString < $1.uuidString }
        let sourceLooks = Dictionary(uniqueKeysWithValues: sourceIDs.compactMap { id in sourceLook?(id).map { (id, $0) } })
        var knownAvatars = Set<String>()
        let animations = ((look?.animations ?? []) + sourceIDs.flatMap { sourceLooks[$0]?.animations ?? [] })
            .filter { knownAvatars.insert($0.avatar).inserted }
        let workingAvatar = (group?.typing ?? guest).map { id in
            sourceLooks[id].flatMap { look in workingBot.map { look.avatar($0.engine) } } ?? avatar(id)
        }
            ?? look.flatMap { look in workingBot.map { look.avatar($0.engine) } }
            ?? own
        let working = group.map { $0.typing != nil } ?? (bot.isWorking || bot.partner?.isWorking == true || guest != nil)
        let lastHead = bot.messages.last(where: { $0.role == .bot })?.engine
        let moodBot = workingBot ?? (lastHead == bot.partner?.engine ? bot.partner : nil) ?? bot
        // Each task's chip under the replies that belong to it; its latest one says how it stands.
        var taskChips: [UUID: [TaskCardChip]] = [:]
        if group == nil {
            for task in bot.tasks {
                let latest = task.latestMessage(in: bot.messages)
                for id in task.messageIDs {
                    taskChips[id, default: []].append(.of(task, in: bot, latest: id == latest, selected: selectedTask, now: now))
                }
            }
        }
        var messages = bot.messages.enumerated().map { index, message -> Message in
            let sourceName = message.role == .bot ? message.sourceID.map { speaker?($0) ?? "A removed bot" } : nil
            let sourceHead = message.sourceID.flatMap { sourceLooks[$0] }
            let face: String? = switch message.role {
            // In a group chat each line has the face of the bot that said it.
            // So does a bot called into a bot's own chat.
            case .bot where message.sourceID != nil:
                message.subagentID == nil ? message.engine.flatMap { sourceHead?.avatar($0) } ?? avatar(message.sourceID) : avatar(message.sourceID)
            // A head's reply under its character (a subagent's keeps the bot's face).
            case .bot: look.flatMap { look in message.subagentID == nil ? message.engine.map(look.avatar) : nil } ?? own
            case .notice: avatar(message.sourceID)
            case .relay: main ?? avatar(nil)
            default: nil
            }
            return Message(
                id: message.id.uuidString,
                role: message.role.rawValue,
                text: message.text,
                stamp: stamp(for: bot.messages, at: index, now: now),
                avatar: face,
                choices: message.choices?.map { Choice(label: $0.label, detail: $0.detail, recommended: $0.recommended, action: $0.action?.rawValue, id: $0.id?.uuidString) },
                chosen: message.chosen,
                answer: message.answer,
                open: message.isOpenQuestion,
                displays: message.shown.isEmpty ? nil : message.shown.enumerated().map { index, instance in
                    var shown = display(instance, card: "\(message.id.uuidString)/\(index)", in: message, library: library, commands: commands, fallbackFolder: bot.profile.workingDirectory)
                    // Only a bot's components that are in the library can be pinned.
                    if let pinnedNames, message.role == .bot, library?.names.contains(instance.name) == true {
                        shown.pinned = pinnedNames.contains(instance.name)
                    }
                    return shown
                },
                attachments: message.attachments?.map(file),
                replyTo: message.replyTo?.uuidString,
                replyPreview: message.replyPreview,
                openable: message.role == .notice && message.sourceID != nil,
                speaker: sourceName.map { name in message.engine.map { "\(name) · \($0.displayName)" } ?? name } ?? headLabel(message, in: bot),
                steps: message.steps.map { $0.map { stepView($0, in: bot) } },
                previews: previews(for: message, in: library),
                feedback: message.role == .relay
                    ? (message.feedback ?? FeedbackNote.parse(message.text)).map { Feedback(about: $0.about, words: $0.words) }
                    : nil,
                specs: specs ? specChips(for: message, in: bot, open: openSpec, library: library, commands: commands) : nil,
                component: specs && message.role == .bot
                    ? message.shown.first { !ComponentLibrary.isBuiltIn($0.name) && library?.names.contains($0.name) == true }?.name
                    : nil,
                tasks: nil,
                artifacts: artifactCards(for: message),
                fromSubagent: message.subagentID.map { id in
                    let agent = bot.subagent(id)
                    let title = agent.map { $0.description.isEmpty ? ($0.name ?? "") : $0.description } ?? ""
                    return SubagentRef(id: id, title: title.isEmpty ? L("Subagent") : title)
                },
                reactionEnabled: message.role != .divider && index >= max(0, bot.messages.count - BotStore.historyLimit),
                reactions: MessageReaction.palette.compactMap { emoji in
                    let matching = (message.reactions ?? []).filter { $0.emoji == emoji }
                    return matching.isEmpty ? nil : ReactionView(emoji: emoji, actors: matching.map { reaction in
                        let parts = reaction.actor.split(separator: ":")
                        if parts.count == 3, parts[0] == "guest", let id = UUID(uuidString: String(parts[1])),
                           let name = speaker?(id) {
                            return name + " · " + (BotEngine(rawValue: String(parts[2]))?.displayName ?? String(parts[2]))
                        }
                        return reaction.label
                    }, own: matching.contains { $0.actor == "user" })
                },
                seen: group == nil ? seenMarks(message, in: bot) : nil,
                interrupted: message.interrupted == true ? true : nil,
                completionVerification: message.completionVerification,
                sourceAuthor: message.role == .bot ? (sourceName ?? (message.sourceID == nil ? bot.name : nil)) : nil,
                sourceEngine: message.engine?.rawValue,
                sourceTime: CatchUp.time(message.date),
                decisionID: message.decisionID?.uuidString,
                taskCards: message.role == .bot ? taskChips[message.id] : nil
            )
        }
        // All the chat's background work goes on its latest message, as one row of counts.
        if let at = backgroundRowIndex(in: bot.messages) {
            messages[at].tasks = shownBackgroundTasks(in: bot.messages).map { TaskChip($0.task, from: $0.message) }
        }
        // Replies before your latest line fold their finished subagents away (still in their steps).
        if let lastYours = bot.messages.lastIndex(where: { $0.role == .user }) {
            for index in messages.indices where index < lastYours && messages[index].steps != nil {
                messages[index].earlier = true
            }
        }
        let reply = replyingTo.flatMap { id in bot.messages.first { $0.id == id } }.map {
            Reply(
                id: $0.id.uuidString,
                who: $0.role == .user ? L("Reply to yourself") : L("Reply to {0}", $0.sourceID.flatMap { id in speaker?(id) } ?? bot.name),
                preview: Bot.preview(of: $0)
            )
        }
        // A bot's own components first in the / menu; a chat without a list (a group) has them all.
        let names = library?.names ?? []
        let slash: (own: [String], library: [String]) = bot.componentList.map { list in
            let own = Set(list)
            return (names.filter(own.contains), names.filter { !own.contains($0) })
        } ?? (names, [])
        var components: [String: Component] = [:]
        for name in library?.names ?? [] {
            guard let library, let template = library.template(name) else { continue }
            let icon = library.icon(of: name)
            components[name] = Component(
                template: template,
                version: library.versions[name, default: 0],
                working: library.working[name] != nil,
                updated: library.updated.contains(name),
                hasPrevious: library.hasPrevious(name),
                sizes: library.sizes(of: name).map(\.rawValue),
                icon: icon,
                iconImage: icon.flatMap(ComponentIcon.symbolImage),
                title: library.shortTitle(of: name)
            )
        }
        return ChatPayload(
            chatAvatarSize: chatAvatarSize.map(AppSettings.clampedChatAvatarSize),
            botID: bot.id.uuidString,
            botName: bot.name,
            messages: messages,
            working: working,
            waitingForWorkers: group == nil && !working && bot.subagents.contains(where: \.isRunning),
            avatar: workingAvatar,
            placeholder: group != nil ? L("Message everyone, or @name one bot…")
                : bot.profile.role == .main ? L("Make a wish, or ask how things are going…") : L("Message {0}…", bot.name),
            replyingTo: reply,
            pendingFiles: pending.map { pending in
                var entry = file(Attachment(url: pending.url))
                entry.id = pending.id.uuidString
                return entry
            },
            components: components,
            mentions: group?.names ?? callIn?.names ?? [],
            allMentions: group?.allNames ?? callIn?.allNames ?? [],
            slashCommands: SlashCommands.all + (share ? [SlashCommands.share] : []),
            slashComponents: slash.own,
            slashLibrary: slash.library,
            live: liveSteps(of: workingBot),
            subagent: nil,
            feedback: feedback,
            pins: pinning.map { context in bot.pins.map { pin(view: $0, context: context) } },
            pinChoices: pinning.map { _ in pinChoices(for: bot, library: library) },
            board: pinning.map(\.board),
            floating: floating,
            makeComponents: specs ? true : nil,
            answerWith: group == nil ? AnswerWith.of(bot) : nil,
            rounds: group == nil ? bot.rounds.map(Rounds.of) : nil,
            handoffs: group == nil && !bot.handoffs.isEmpty ? bot.handoffs.map(Handoff.of) : nil,
            seenHeads: look.map { look in Dictionary(uniqueKeysWithValues: bot.heads.engines.map { (markLetter($0), look.mark($0)) }) },
            animatedHeads: animations.isEmpty ? nil : animations,
            avatarMood: look != nil || !sourceLooks.isEmpty
                ? Chibi.mood(asleep: moodBot.phase == .asleep, working: moodBot.isWorking, waiting: moodBot.waitingForPermission).rawValue : nil,
            catchUp: catchUp,
            intervalSummaries: intervalSummaries
        )
    }

    /// In a bot with two heads: which head said a reply ("ClaudeCodeBot · Codex"), and who your
    /// line was for ("to Both").
    @MainActor
    static func headLabel(_ message: ChatMessage, in bot: Bot) -> String? {
        // Two heads, or a reply by a head this bot does not have (Claude publishing for Codex).
        let outside = message.engine.map { !bot.heads.engines.contains($0) } ?? false
        guard bot.heads.hasTwo || outside else { return nil }
        switch message.role {
        case .bot: return message.engine.map { "\(bot.name) · \($0.displayName)" }
        case .user: return message.to.map { L("to {0}", $0.displayName) }
        default: return nil
        }
    }

    /// The chips of the specs made from `message`, each built one with its component.
    @MainActor
    static func specChips(for message: ChatMessage, in bot: Bot, open: UUID?, library: ComponentLibrary? = nil, commands: CommandContext? = nil) -> [SpecChip]? {
        let chips = bot.specs.filter { $0.messageID == message.id }.map { spec in
            var chip = SpecChip(id: spec.id.uuidString, name: spec.name, status: spec.status.rawValue, suggested: spec.suggestedBy != nil && spec.status == .draft && spec.built == nil, open: spec.id == open)
            if let shown = specDisplay(spec, library: library, runs: commands?.runs) {
                chip.component = shown.name
                chip.display = shown
            } else if spec.filling, let built = spec.built, library?.names.contains(built) == true {
                chip.component = built
                chip.filling = spec.filledBy
            }
            return chip
        }
        return chips.isEmpty ? nil : chips
    }

    /// The command a built spec's component takes its data from: the spec's (Maintainer's, for
    /// live data, or the user's); a reused component's own comes first. A spec without one shows
    /// the reply's own content, even when its about.md says how other bots may fill it.
    @MainActor
    static func specCommand(_ spec: ComponentSpec, component name: String, library: ComponentLibrary?) -> String? {
        spec.reuse ? (library?.command(of: name) ?? spec.command) : spec.command
    }

    /// A built spec's component as drawn under its reply: without a command, the reply's own
    /// content as the bot that wrote it drew it (nothing while it draws it; a sample if it did
    /// not); with one, the data it gave (only once the user allowed it; until then the card
    /// asks), else what was kept from its last run, else its sample.
    @MainActor
    static func specDisplay(_ spec: ComponentSpec, library: ComponentLibrary?, runs: ComponentCommands?) -> Display? {
        guard let name = spec.built, let library, library.names.contains(name) else { return nil }
        let command = specCommand(spec, component: name, library: library)
        if command == nil, spec.filling { return nil }
        let kept = spec.testRun.flatMap { $0.command == command ? $0.output : nil }
        let sample = ComponentSpec.preferredSample(in: spec.samples, live: command != nil).map { spec.samples[$0] }
        var shown = display(ComponentInstance(name: name, data: command == nil ? (spec.filled ?? sample?.data ?? "null") : (kept ?? sample?.data ?? "null")))
        guard let command else { return shown }
        let folder = URL(filePath: spec.folder)
        let detail = library.detailCommand(of: name)
        shown.command = command
        shown.folder = folder.path
        shown.detail = detail
        shown.card = detail == nil ? nil : spec.card
        guard let runs else {
            shown.status = ComponentCommands.Status.approve.rawValue
            return shown
        }
        let state = runs.state(for: spec.card, command: command, detail: detail, in: folder)
        var status = state.status
        // Kept from before (a restart): shown until ↻, unless it refreshes when shown.
        if status == .idle, kept != nil, spec.refresh != .shown { status = .done }
        shown.status = status.rawValue
        shown.error = state.error
        shown.ranAt = (state.ranAt ?? spec.testRun?.ranAt).map { $0.formatted(date: .omitted, time: .shortened) }
        if let data = state.data {
            shown.data = name == PagePreview.component ? PagePreview.cardData(data) : data
            let images = ComponentImages.urls(in: shown.data)
            shown.images = images.isEmpty ? nil : images
        }
        return shown
    }

    /// A pin as the page draws it. A pin with a command whose output was kept and that is not
    /// refreshed "when shown" shows that output until you press ↻ (or its time comes), instead
    /// of running again each time the app starts.
    @MainActor
    static func pin(view pin: PinnedComponent, context: PinContext) -> Pin {
        var shown = display(ComponentInstance(name: pin.name, data: pin.data))
        let ranAt: (Date?) -> String? = { date in
            date.map { Calendar.current.isDateInToday($0) ? $0.formatted(date: .omitted, time: .shortened) : $0.formatted(.dateTime.month().day().hour().minute()) }
        }
        let detail = context.library?.detailCommand(of: pin.name)
        if detail != nil {
            shown.detail = detail
            shown.card = pin.card
            shown.folder = context.folder.path
        }
        if let command = pin.command {
            let state = context.runs.state(for: pin.card, command: command, detail: detail, in: context.folder)
            var status = state.status
            if status == .idle, pin.data != "null", pin.refresh != .shown { status = .done }
            shown.command = command
            shown.folder = context.folder.path
            // Its about.md's `Refresh: every 2s`: the page reruns it while it is on screen.
            shown.every = context.library?.refreshInterval(of: pin.name)
            shown.status = status.rawValue
            shown.error = state.error
            shown.ranAt = ranAt(state.ranAt ?? pin.ranAt)
            if let data = state.data {
                shown.data = pin.name == PagePreview.component ? PagePreview.cardData(data) : data
                let images = ComponentImages.urls(in: shown.data)
                shown.images = images.isEmpty ? nil : images
            }
        }
        let headline: String = switch shown.status {
        case ComponentCommands.Status.approve.rawValue where pin.data == "null": "Needs your OK"
        case ComponentCommands.Status.failed.rawValue: "Failed"
        case ComponentCommands.Status.running.rawValue where pin.data == "null": "Running…"
        default: Pins.headline(shown.status == nil ? pin.data : shown.data)
        }
        let chip = Pins.chip(status: pin.status, headline: headline, command: shown.status.flatMap(ComponentCommands.Status.init(rawValue:)), hasData: pin.data != "null")
        return Pin(id: pin.id.uuidString, name: pin.name, headline: headline, chip: chip, size: pin.size.rawValue, place: pin.place, panelHeight: pin.panelHeight, refresh: pin.refresh.rawValue, minutes: pin.minutes, seconds: pin.seconds, display: shown,
                   makingLive: pin.makingLive && pin.command == nil ? true : nil, float: pin.float, floatMenu: Pins.floatMenu(for: pin, floating: context.floating))
    }

    /// The picker's list: components this bot drew (newest use first), then its own others (the
    /// library's, before it has a list) that have a Command. The question component is left out.
    @MainActor
    static func pinChoices(for bot: Bot, library: ComponentLibrary?) -> [PinChoice] {
        guard let library else { return [] }
        let available = Set(library.names)
        var uses: [String: Int] = [:]
        var commands: [String: String] = [:]
        var order: [String] = []
        for message in bot.messages.reversed() where message.role == .bot {
            for instance in message.shown.reversed() where available.contains(instance.name) && instance.name != ComponentLibrary.choices {
                if uses[instance.name] == nil {
                    order.append(instance.name)
                    if let command = command(of: instance, in: message, library: library) { commands[instance.name] = command }
                }
                uses[instance.name, default: 0] += 1
            }
        }
        let pinned = Set(bot.pins.map(\.name))
        let used = order.map { PinChoice(name: $0, command: commands[$0], uses: uses[$0] ?? 0, pinned: pinned.contains($0)) }
        // Not drawn here yet: from the bot's own components when it has a list, else the library's.
        let offered = bot.componentList?.filter(available.contains) ?? library.names
        let others = offered.filter { uses[$0] == nil }.compactMap { name in
            library.command(of: name).map { PinChoice(name: name, command: $0, uses: 0, pinned: pinned.contains(name)) }
        }
        return used + others
    }

    /// A subagent's conversation, read only: its task and each message its bot sent it later
    /// (SendMessage) as lines from the bot with when they were sent, in order; what it said, each
    /// with the tool calls before it (the page draws them one line each); the ones still going show live.
    @MainActor
    public static func make(subagent: Subagent, of bot: Bot, components library: ComponentLibrary?, avatar: String, chatAvatarSize: Int? = nil) -> ChatPayload {
        var messages: [Message] = []
        func message(_ id: String, role: String, text: String, steps: [Step], speaker: String? = nil, at date: Date? = nil) -> Message {
            var line = Message(
                id: "\(subagent.id)-\(id)", role: role, text: text, stamp: nil, avatar: role == "bot" ? avatar : nil,
                choices: nil, chosen: nil, answer: nil, open: false, displays: nil, attachments: nil,
                replyTo: nil, replyPreview: nil, openable: false, speaker: speaker,
                steps: steps.isEmpty ? nil : steps.map { step in
                    var view = stepView(step, in: bot)
                    // Ended, a call whose result never came is over too: no spinner on it.
                    if !subagent.isRunning, step.kind == .tool { view.done = true }
                    return view
                }
            )
            line.time = date?.formatted(date: .omitted, time: .shortened)
            return line
        }
        // One known only from a message sent to it (from before the app restarted) has no task.
        if !subagent.prompt.isEmpty { messages.append(message("task", role: "user", text: subagent.prompt, steps: [], speaker: bot.name, at: subagent.startedAt)) }
        var pending: [Step] = []
        var said = ""
        for step in subagent.steps {
            if step.kind == .text {
                messages.append(message(step.id, role: "bot", text: step.title, steps: pending))
                pending = []
                said = step.title
            } else if step.kind == .message {
                // Its calls before the message stay with what came before it.
                if !pending.isEmpty { messages.append(message(step.id + "-before", role: "bot", text: "", steps: pending)) }
                pending = []
                messages.append(message(step.id, role: "user", text: step.title, steps: [], speaker: bot.name, at: step.at))
                said = ""
            } else {
                pending.append(step)
            }
        }
        if !subagent.isRunning {
            // Its result, unless the last thing it said already is it.
            let result = subagent.result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !pending.isEmpty || (!result.isEmpty && result != said) {
                let text = result.isEmpty ? Self.endWords(subagent.status) : result
                messages.append(message("result", role: subagent.status == .completed ? "bot" : "error", text: text, steps: pending))
            }
            pending = []
        }
        let engine = subagent.runtime?.engine ?? bot.subagentEngine(subagent.id) ?? bot.engine
        let reported = subagent.runtime?.reasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let inherited = engine == .claude && reported.isEmpty ? bot.effort?.rawValue : nil
        return ChatPayload(
            chatAvatarSize: chatAvatarSize.map(AppSettings.clampedChatAvatarSize),
            botID: "\(bot.id.uuidString)/\(subagent.id)",
            botName: subagent.description,
            messages: messages,
            working: subagent.isRunning,
            avatar: avatar,
            placeholder: "",
            replyingTo: nil,
            pendingFiles: [],
            components: [:],
            mentions: [],
            allMentions: [],
            live: subagent.isRunning ? pending.map { stepView($0, in: bot) } : [],
            subagent: SubagentHeader(
                id: subagent.id,
                title: subagent.description.isEmpty ? L("Subagent") : subagent.description,
                owner: bot.name,
                status: subagent.status.rawValue,
                type: subagent.type,
                engine: engine.rawValue,
                model: bot.subagentModelName(subagent),
                runtime: subagent.runtime,
                inheritedEffort: inherited,
                outputTokens: subagent.reportedOutputTokens,
                startedAt: subagent.startedAt.timeIntervalSince1970 * 1000,
                endedAt: subagent.endedAt.map { $0.timeIntervalSince1970 * 1000 }
            )
        )
    }

    /// The steps of the turn `bot` is taking now (in a group chat, the member answering).
    @MainActor
    static func liveSteps(of bot: Bot?) -> [StepView] {
        guard let bot, bot.isWorking else { return [] }
        return bot.liveSteps.map { stepView($0, in: bot) }
    }

    @MainActor
    static func stepView(_ step: Step, in bot: Bot) -> StepView {
        let subagent = step.kind == .subagent ? bot.subagent(step.id) : nil
        return StepView(
            id: step.id,
            kind: step.kind.rawValue,
            tool: step.tool,
            title: subagent.map { $0.description.isEmpty ? step.title : $0.description } ?? step.title,
            detail: step.detail,
            output: step.output,
            failed: step.failed,
            done: step.done,
            status: subagent?.status.rawValue,
            count: subagent?.toolCount,
            images: images(of: step)
        )
    }

    /// The pictures a step shows: the files it kept that are still there (made smaller since,
    /// perhaps, with a small copy for the chat), or, for a Read that gave back no words, only a
    /// picture (since pruned), the file it read.
    static func images(of step: Step) -> [StepImage]? {
        let manager = FileManager.default
        let name = step.detail.map { ($0 as NSString).lastPathComponent }
        let kept = (step.images ?? []).compactMap(StepImages.existing).map { path in
            let file = URL(filePath: path)
            return StepImage(url: file.absoluteString, name: name ?? file.lastPathComponent, thumb: StepImages.thumb(for: file)?.absoluteString)
        }
        if !kept.isEmpty { return kept }
        guard step.tool == "Read", step.done, !step.failed, (step.output ?? "").isEmpty, let detail = step.detail else { return nil }
        let file = URL(filePath: detail)
        guard ComponentImages.isImage(file), manager.fileExists(atPath: file.path) else { return nil }
        return [StepImage(url: file.absoluteString, name: file.lastPathComponent)]
    }

    public func json() -> String {
        Self.encode(self) ?? "{}"
    }

    /// Sorted, so the same chat is the same text every time (dictionaries have no order).
    static func encode<Value: Encodable>(_ value: Value) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        guard let data = try? encoder.encode(value) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Sends the chat page only what changed since the state it last got, as
    /// `ccb.patchState({base?, components?, order, changed})`: `base` is the state without its
    /// messages and components (left out when the same), `components` likewise, `order` every
    /// message's id, and `changed` the messages that are new or different. A 500-message chat
    /// otherwise encoded, sent and parsed every message (and ~180 KB of components) on every
    /// streamed step. The page asks for everything again (`resync`) when it cannot apply one.
    public struct Patcher {
        private var base: String?
        private var components: String?
        private var messages: [String: Message] = [:]
        private var order: [String] = []

        public init() {}

        /// The next state goes whole (the page loaded again, or asked for it).
        public mutating func reset() {
            self = Patcher()
        }

        /// The script that brings the page to `payload`; nil when nothing changed.
        public mutating func script(for payload: ChatPayload) -> String? {
            var stripped = payload
            stripped.messages = []
            stripped.components = [:]
            let base = ChatPayload.encode(stripped) ?? "{}"
            let components = ChatPayload.encode(payload.components) ?? "{}"
            let order = payload.messages.map(\.id)
            let changed = payload.messages.filter { messages[$0.id] != $0 }
            guard base != self.base || components != self.components || order != self.order || !changed.isEmpty else { return nil }

            var parts: [String] = []
            if base != self.base { parts.append("\"base\":" + base) }
            if components != self.components { parts.append("\"components\":" + components) }
            parts.append("\"order\":" + (ChatPayload.encode(order) ?? "[]"))
            parts.append("\"changed\":" + (ChatPayload.encode(changed) ?? "[]"))
            self.base = base
            self.components = components
            self.order = order
            messages = Dictionary(payload.messages.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            return "ccb.patchState({" + parts.joined(separator: ",") + "})"
        }
    }

    /// A component in a message; a 「網頁預覽卡片」 gets where to load its page from.
    static func display(_ instance: ComponentInstance) -> Display {
        let data = instance.name == PagePreview.component ? PagePreview.cardData(instance.data) : instance.data
        let images = ComponentImages.urls(in: data)
        return Display(name: instance.name, data: data, at: instance.at, images: images.isEmpty ? nil : images)
    }

    /// A card's status when a bot showed it with no data and nothing can fill it: not drawn.
    static let emptyStatus = "empty"

    /// The bot's components shown with no data and no command to get it from (drawn as nothing).
    @MainActor
    static func isEmptyShow(_ instance: ComponentInstance, in message: ChatMessage, library: ComponentLibrary?) -> Bool {
        message.role == .bot && instance.data == "null" && !ComponentLibrary.isBuiltIn(instance.name)
            && command(of: instance, in: message, library: library) == nil
    }

    /// The command a component in a message takes its data from: its own, or, when it was
    /// written with no data, the one its about.md declares. Only a bot's lines run commands.
    @MainActor
    static func command(of instance: ComponentInstance, in message: ChatMessage, library: ComponentLibrary?) -> String? {
        guard message.role == .bot else { return nil }
        return instance.command ?? (instance.data == "null" ? library?.command(of: instance.name) : nil)
    }

    /// A component in a bot's message, with its command's run when its data comes from one.
    /// `card` names this one (the message and its place) for its run.
    @MainActor
    static func display(_ instance: ComponentInstance, card: String, in message: ChatMessage, library: ComponentLibrary?, commands: CommandContext?, fallbackFolder: URL) -> Display {
        var shown = display(instance)
        // A bot's component with a Detail command can ask for more of its data (ccb.runDetail),
        // in the folder its command would run in, once the user has allowed it on a card.
        let detail = message.role == .bot ? library?.detailCommand(of: instance.name) : nil
        if detail != nil {
            shown.detail = detail
            shown.card = card
            shown.folder = (commands?.folder(message) ?? fallbackFolder).path
        }
        guard let command = command(of: instance, in: message, library: library) else {
            // Nothing to draw: the page leaves it out rather than put an error card in the
            // user's chat; the bot hears why with the next message (`Workspace.emptyShowNote`).
            if instance.data == "null" { shown.status = emptyStatus }
            return shown
        }
        let folder = commands?.folder(message) ?? fallbackFolder
        shown.command = command
        shown.folder = folder.path
        shown.every = instance.refresh ?? library?.refreshInterval(of: instance.name)
        guard let state = commands?.runs.state(for: card, command: command, detail: detail, in: folder) else {
            shown.status = ComponentCommands.Status.approve.rawValue
            return shown
        }
        shown.status = state.status.rawValue
        shown.error = state.error
        shown.ranAt = state.ranAt.map { $0.formatted(date: .omitted, time: .shortened) }
        if let data = state.data {
            shown.data = instance.name == PagePreview.component ? PagePreview.cardData(data) : data
            let images = ComponentImages.urls(in: shown.data)
            shown.images = images.isEmpty ? nil : images
        }
        return shown
    }

    /// Cards for the claude.ai Artifacts a bot's line or a notice links to.
    static func artifactCards(for message: ChatMessage) -> [ArtifactLink.Card]? {
        guard message.role == .bot || message.role == .notice else { return nil }
        let cards = ArtifactLink.cards(in: message.text)
        return cards.isEmpty ? nil : cards
    }

    /// Cards for the result pages a bot's line or a notice links to, when the card component is
    /// there to draw them (without it the links stay chips, as before).
    @MainActor
    static func previews(for message: ChatMessage, in library: ComponentLibrary?) -> [Display]? {
        guard message.role == .bot || message.role == .notice,
              library?.names.contains(PagePreview.component) == true,
              message.text.contains("](file:") else { return nil }
        let shown = message.shown.compactMap { $0.name == PagePreview.component ? PagePreview.page(inCard: $0.data) : nil }
        let cards = PagePreview.linkedCards(in: message.text, skipping: shown)
        return cards.isEmpty ? nil : cards.map { Display(name: PagePreview.component, data: $0, at: nil) }
    }

    private static func file(_ attachment: Attachment) -> File {
        File(id: nil, name: attachment.name, kind: attachment.kind.rawValue, url: attachment.url.absoluteString)
    }

    /// What a subagent's chat ends with when it said nothing at the end.
    static func endWords(_ status: Subagent.Status) -> String {
        switch status {
        case .completed: L("Done.")
        case .failed: L("It failed.")
        case .stopped: L("It was stopped.")
        case .running: L("It is still running.")
        }
    }

    /// "Today 08:15" above a message that comes 30+ minutes after the one before it.
    static func stamp(for messages: [ChatMessage], at index: Int, now: Date) -> String? {
        let date = messages[index].date
        if index > 0, date.timeIntervalSince(messages[index - 1].date) < 30 * 60 { return nil }
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return L("Today {0}", time) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return L("Yesterday {0}", time)
        }
        return date.formatted(.dateTime.month().day().hour().minute())
    }
}
