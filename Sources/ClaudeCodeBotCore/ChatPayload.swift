import Foundation

/// What the web chat surface draws: the chat as plain values, encoded to JSON for
/// `ccb.setState(...)`. Field names match `Web/src/types.ts`.
public struct ChatPayload: Encodable, Equatable {
    public struct Choice: Encodable, Equatable {
        var label: String
        var detail: String?
        var recommended: Bool
    }

    public struct File: Encodable, Equatable {
        var id: String?
        var name: String
        var kind: String
        var url: String
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
        /// All the chat's background work, on its latest message only (nil on the others): one
        /// row of counts (subagents, waiting, done, failed) that moves down as messages arrive.
        var tasks: [TaskChip]? = nil
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

        init(_ task: BackgroundTask, from messageID: UUID) {
            message = messageID.uuidString
            id = task.id
            kind = task.kind.rawValue
            title = task.title
            status = task.status.rawValue
            started = (task.startedAt.timeIntervalSince1970 * 1000).rounded()
            ended = task.endedAt.map { ($0.timeIntervalSince1970 * 1000).rounded() }
            detail = task.detail
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

    var botID: String
    var botName: String
    var messages: [Message]
    var working: Bool
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

    /// Where the chat's background-work row goes: its latest message one can be drawn under (a
    /// reply, a notice or your own line), when the chat has any background work at all.
    static func backgroundRowIndex(in messages: [ChatMessage]) -> Int? {
        guard messages.contains(where: { !($0.backgroundTasks ?? []).isEmpty }) else { return nil }
        return messages.lastIndex { [.bot, .notice, .user].contains($0.role) }
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
        floating: [FloatingPin]? = nil,
        avatar: (_ projectID: UUID?) -> String
    ) -> ChatPayload {
        let pinnedNames = pinning.map { _ in Set(bot.pins.map(\.name)) }
        let own = avatar(nil)
        let main = bot.profile.role == .main ? own : nil
        let speaker = group?.speaker ?? callIn?.speaker
        // Someone called in is answering while the bot itself is not.
        let guest = bot.isWorking ? nil : callIn?.typing
        var messages = bot.messages.enumerated().map { index, message -> Message in
            let face: String? = switch message.role {
            // In a group chat each line has the face of the bot that said it.
            // So does a bot called into a bot's own chat.
            case .bot: speaker != nil && message.sourceID != nil ? avatar(message.sourceID) : own
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
                choices: message.choices?.map { Choice(label: $0.label, detail: $0.detail, recommended: $0.recommended) },
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
                speaker: message.role == .bot ? message.sourceID.flatMap { id in speaker.map { $0(id) ?? "A removed bot" } } : nil,
                steps: message.steps.map { $0.map { stepView($0, in: bot) } },
                previews: previews(for: message, in: library),
                feedback: message.role == .relay
                    ? (message.feedback ?? FeedbackNote.parse(message.text)).map { Feedback(about: $0.about, words: $0.words) }
                    : nil,
                specs: specs ? specChips(for: message, in: bot, open: openSpec, library: library, commands: commands) : nil,
                component: specs && message.role == .bot
                    ? message.shown.first { $0.name != "choices" && $0.name != PagePreview.component && library?.names.contains($0.name) == true }?.name
                    : nil,
                tasks: nil
            )
        }
        // All the chat's background work goes on its latest message, as one row of counts.
        if let at = backgroundRowIndex(in: bot.messages) {
            messages[at].tasks = bot.messages.flatMap { message in
                (message.backgroundTasks ?? []).map { TaskChip($0, from: message.id) }
            }
        }
        let reply = replyingTo.flatMap { id in bot.messages.first { $0.id == id } }.map {
            Reply(
                id: $0.id.uuidString,
                who: $0.role == .user ? "Reply to yourself" : "Reply to \($0.sourceID.flatMap { id in speaker?(id) } ?? bot.name)",
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
            botID: bot.id.uuidString,
            botName: bot.name,
            messages: messages,
            working: group.map { $0.typing != nil } ?? (bot.isWorking || guest != nil),
            avatar: (group?.typing ?? guest).map { avatar($0) } ?? own,
            placeholder: group != nil ? "Message everyone, or @name one bot…"
                : bot.profile.role == .main ? "Make a wish, or ask how things are going…" : "Message \(bot.name)…",
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
            live: liveSteps(of: group.map(\.working) ?? (bot.isWorking ? bot : guest.flatMap { _ in callIn?.working })),
            subagent: nil,
            feedback: feedback,
            pins: pinning.map { context in bot.pins.map { pin(view: $0, context: context) } },
            pinChoices: pinning.map { _ in pinChoices(for: bot, library: library) },
            board: pinning.map(\.board),
            floating: floating,
            makeComponents: specs ? true : nil
        )
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

    /// The data made from the reply itself before it was built (a "This reply" sample: the app's
    /// draft, or Maintainer's in specs from before the bot filled them).
    static func replySample(of spec: ComponentSpec) -> ComponentSpec.Sample? {
        spec.samples.first { $0.label == "This reply" } ?? spec.samples.first { $0.label == "This page" }
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
        let sample = command == nil ? (replySample(of: spec) ?? spec.samples.first)
            : (spec.samples.first { $0.label == "Test run" } ?? replySample(of: spec) ?? spec.samples.first)
        var shown = display(ComponentInstance(name: name, data: command == nil ? (spec.filled ?? sample?.data ?? "null") : (kept ?? sample?.data ?? "null")))
        guard let command else { return shown }
        let folder = URL(filePath: spec.folder)
        let detail = library.detailCommand(of: name)
        shown.command = command
        shown.folder = folder.path
        shown.detail = detail
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
        return Pin(id: pin.id.uuidString, name: pin.name, headline: headline, chip: chip, size: pin.size.rawValue, panelHeight: pin.panelHeight, refresh: pin.refresh.rawValue, minutes: pin.minutes, seconds: pin.seconds, display: shown,
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
            for instance in message.shown.reversed() where available.contains(instance.name) && instance.name != "choices" {
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

    /// A subagent's conversation, the way Claude Code shows one: its task as your line, then what
    /// it said, each with the tool calls before it folded above; the ones still going show live.
    @MainActor
    public static func make(subagent: Subagent, of bot: Bot, components library: ComponentLibrary?, avatar: String) -> ChatPayload {
        var messages: [Message] = []
        func message(_ id: String, role: String, text: String, steps: [Step]) -> Message {
            Message(
                id: "\(subagent.id)-\(id)", role: role, text: text, stamp: nil, avatar: role == "bot" ? avatar : nil,
                choices: nil, chosen: nil, answer: nil, open: false, displays: nil, attachments: nil,
                replyTo: nil, replyPreview: nil, openable: false, speaker: nil,
                steps: steps.isEmpty ? nil : steps.map { stepView($0, in: bot) }
            )
        }
        messages.append(message("task", role: "user", text: subagent.prompt, steps: []))
        var pending: [Step] = []
        var said = ""
        for step in subagent.steps {
            if step.kind == .text {
                messages.append(message(step.id, role: "bot", text: step.title, steps: pending))
                pending = []
                said = step.title
            } else {
                pending.append(step)
            }
        }
        if !subagent.isRunning {
            // Its result, unless the last thing it said already is it.
            let result = subagent.result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !pending.isEmpty || (!result.isEmpty && result != said) {
                let text = result.isEmpty ? (subagent.status == .completed ? "Done." : "It \(subagent.status.rawValue).") : result
                messages.append(message("result", role: subagent.status == .completed ? "bot" : "error", text: text, steps: pending))
            }
            pending = []
        }
        return ChatPayload(
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
                title: subagent.description.isEmpty ? "Subagent" : subagent.description,
                owner: bot.name,
                status: subagent.status.rawValue,
                type: subagent.type
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
        let subagent = step.kind == .subagent ? bot.trace.subagent(step.id) : nil
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
    /// perhaps, with a small copy for the chat), or, for a Read that gave back a picture (kept
    /// before pictures were, or since pruned), the file it read.
    static func images(of step: Step) -> [StepImage]? {
        let manager = FileManager.default
        let name = step.detail.map { ($0 as NSString).lastPathComponent }
        let kept = (step.images ?? []).compactMap(StepImages.existing).map { path in
            let file = URL(filePath: path)
            return StepImage(url: file.absoluteString, name: name ?? file.lastPathComponent, thumb: StepImages.thumb(for: file)?.absoluteString)
        }
        if !kept.isEmpty { return kept }
        guard step.tool == "Read", let detail = step.detail, step.output?.contains("(image)") == true else { return nil }
        let file = URL(filePath: detail)
        guard ComponentImages.isImage(file), manager.fileExists(atPath: file.path) else { return nil }
        return [StepImage(url: file.absoluteString, name: file.lastPathComponent)]
    }

    public func json() -> String {
        let encoder = JSONEncoder()
        // Sorted, so the same chat is the same text every time (dictionaries have no order):
        // the page is only sent a state that changed, and redraws only messages that did.
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        guard let data = try? encoder.encode(self) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    /// A component in a message; a 「網頁預覽卡片」 gets where to load its page from.
    static func display(_ instance: ComponentInstance) -> Display {
        let data = instance.name == PagePreview.component ? PagePreview.cardData(instance.data) : instance.data
        let images = ComponentImages.urls(in: data)
        return Display(name: instance.name, data: data, at: instance.at, images: images.isEmpty ? nil : images)
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
            shown.folder = (commands?.folder(message) ?? fallbackFolder).path
        }
        guard let command = command(of: instance, in: message, library: library) else {
            if instance.data == "null" {
                shown.status = ComponentCommands.Status.failed.rawValue
                shown.error = "This component was shown without data, and it has no command to get data from."
            }
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

    /// "Today 08:15" above a message that comes 30+ minutes after the one before it.
    static func stamp(for messages: [ChatMessage], at index: Int, now: Date) -> String? {
        let date = messages[index].date
        if index > 0, date.timeIntervalSince(messages[index - 1].date) < 30 * 60 { return nil }
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "Today \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday \(time)"
        }
        return date.formatted(.dateTime.month().day().hour().minute())
    }
}
