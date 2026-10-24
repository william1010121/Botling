import Foundation

/// One piece of work in a chat, as the right panel's Tasks list and the chips under replies show
/// it: what it is, which head owns it, how it stands and what comes next. The app opens one for
/// each message you send; the head that takes it on names it and keeps it current with a hidden
/// `<task …/>` line in its replies (`TaskTag`). Kept per bot in tasks.json.
public struct TaskCard: Codable, Equatable, Identifiable, Sendable {
    public enum State: String, Codable, CaseIterable, Sendable {
        /// Just sent: no head has started on it yet.
        case pending
        case running
        /// It needs the user (a decision, a check).
        case waiting
        case done
        case stopped

        /// Still on the user's plate or a head's: shown in the Tasks list, counted on the rail.
        public var isActive: Bool { self == .pending || self == .running || self == .waiting }
    }

    /// The other head helping with it: a hand-off made while the owner worked on it.
    public struct Help: Codable, Equatable, Sendable {
        public var handoffID: UUID
        public var head: BotEngine
        public var text: String

        public init(handoffID: UUID, head: BotEngine, text: String) {
            self.handoffID = handoffID
            self.head = head
            self.text = text
        }
    }

    public let id: UUID
    public var name: String
    /// The head that took it on; nil until one does. Only it changes the card's state.
    public var owner: BotEngine?
    public var state: State
    public var now: String?
    public var next: String?
    public var blocked: String?
    public var createdAt: Date
    public var updatedAt: Date
    /// The chat lines that belong to it, oldest first: the user's and the heads'.
    public var messageIDs: [UUID]
    public var startedByMessageID: UUID?
    /// It is real work, not a quick answer: a head wrote a `<task>` line for it, used tools on it
    /// or took longer than `TaskBook.quickAnswer`. A provisional card that is not kept goes.
    public var kept: Bool = false
    public var helps: [Help]? = nil
    /// Subagents and workers started for it (their ids in subagents.json).
    public var subagentIDs: [String]? = nil
    /// The state its owner last wrote in a `<task state=…/>` line; nil when no line said one.
    /// Only a card its owner said is running stays running once the owner's turn is over.
    public var stateFromTag: State? = nil

    public init(id: UUID = UUID(), name: String, owner: BotEngine? = nil, state: State = .pending, now: String? = nil, next: String? = nil,
                blocked: String? = nil, createdAt: Date, updatedAt: Date? = nil, messageIDs: [UUID] = [], startedByMessageID: UUID? = nil) {
        self.id = id
        self.name = name
        self.owner = owner
        self.state = state
        self.now = now
        self.next = next
        self.blocked = blocked
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.messageIDs = messageIDs
        self.startedByMessageID = startedByMessageID
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, owner, state, now, next, blocked, createdAt, updatedAt, messageIDs, startedByMessageID, kept, helps, subagentIDs, stateFromTag
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        owner = try container.decodeIfPresent(String.self, forKey: .owner).flatMap(BotEngine.init(rawValue:))
        // A state this build does not know reads as running, so the card stays visible.
        state = try container.decodeIfPresent(String.self, forKey: .state).flatMap(State.init(rawValue:)) ?? .running
        now = try container.decodeIfPresent(String.self, forKey: .now)
        next = try container.decodeIfPresent(String.self, forKey: .next)
        blocked = try container.decodeIfPresent(String.self, forKey: .blocked)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
        messageIDs = try container.decodeIfPresent([UUID].self, forKey: .messageIDs) ?? []
        startedByMessageID = try container.decodeIfPresent(UUID.self, forKey: .startedByMessageID)
        kept = try container.decodeIfPresent(Bool.self, forKey: .kept) ?? false
        helps = try container.decodeIfPresent([Help].self, forKey: .helps)
        subagentIDs = try container.decodeIfPresent([String].self, forKey: .subagentIDs)
        stateFromTag = try container.decodeIfPresent(String.self, forKey: .stateFromTag).flatMap(State.init(rawValue:))
    }

    /// The latest chat line of it that is not the user's (else the latest at all).
    public func latestMessage(in messages: [ChatMessage]) -> UUID? {
        let mine = Set(messageIDs)
        return messages.last { mine.contains($0.id) && $0.role != .user }?.id ?? messages.last { mine.contains($0.id) }?.id
    }

    /// Running, quiet for `TaskBook.staleAfter`, and nothing of it still at work: shown as maybe stuck.
    public func isStale(at date: Date, working: Bool) -> Bool {
        state == .running && !working && date.timeIntervalSince(updatedAt) >= TaskBook.staleAfter
    }
}

/// The line a head writes in a reply to name and update the task it works on:
/// `<task name="…" continues="…" now="…" next="…" blocked="…" state="running"/>`. Every attribute
/// may be left out (it keeps its value); the app takes the line out of what the chat shows.
public struct TaskTag: Equatable, Sendable {
    public var name: String?
    /// The name of an earlier task this message carries on: it joins that card.
    public var continues: String?
    public var now: String?
    public var next: String?
    public var blocked: String?
    public var state: TaskCard.State?

    public init(name: String? = nil, continues: String? = nil, now: String? = nil, next: String? = nil, blocked: String? = nil, state: TaskCard.State? = nil) {
        self.name = name
        self.continues = continues
        self.now = now
        self.next = next
        self.blocked = blocked
        self.state = state
    }

    /// The tag from its attributes as written (`ReplyParser.attributes`).
    init(attributes: [String: String]) {
        func value(_ key: String) -> String? { attributes[key].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } }
        name = value("name").flatMap { $0.isEmpty ? nil : $0 }
        continues = value("continues").flatMap { $0.isEmpty ? nil : $0 }
        // Written but empty clears the field; not written keeps it.
        now = value("now")
        next = value("next")
        blocked = value("blocked")
        state = value("state").flatMap { TaskCard.State(rawValue: $0.lowercased()) }.flatMap { $0 == .pending ? nil : $0 }
    }
}

/// A chat's tasks and how replies move them. Pure bookkeeping: `Bot` says what happened (a
/// message sent, a head starting, a reply with its tags), the book updates its cards.
public struct TaskBook: Equatable, Sendable {
    public private(set) var tasks: [TaskCard]

    /// A turn that answers within this long, with no tools and no `<task>` line, was a quick
    /// answer: its provisional card goes.
    public static let quickAnswer: TimeInterval = 20
    /// A running task with no news for this long, and nothing of it at work, may be stuck.
    public static let staleAfter: TimeInterval = 10 * 60
    /// The most cards kept: finished ones go first.
    static let limit = 100
    /// The most characters of the user's message a provisional name keeps.
    static let nameLength = 40

    public init(tasks: [TaskCard] = []) {
        self.tasks = tasks
    }

    public func task(_ id: UUID) -> TaskCard? { tasks.first { $0.id == id } }

    /// The task a chat line belongs to (the newest, when it belongs to two).
    public func task(containing message: UUID) -> TaskCard? { tasks.last { $0.messageIDs.contains(message) } }

    public func tasks(containing message: UUID) -> [TaskCard] { tasks.filter { $0.messageIDs.contains(message) } }

    /// The newest task by that name (case and spacing aside).
    public func task(named name: String) -> TaskCard? {
        let wanted = Self.key(name)
        return tasks.last { Self.key($0.name) == wanted }
    }

    private static func key(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// What a provisional card is called: the start of the user's message.
    static func provisionalName(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !line.isEmpty else { return L("New message") }
        return line.count > nameLength ? String(line.prefix(nameLength)) + "…" : line
    }

    private func index(_ id: UUID) -> Int? { tasks.firstIndex { $0.id == id } }

    // MARK: What happens

    /// You sent `message`: a provisional card named after its start, waiting for a head. A
    /// reply to a line of a task (an answer to its question, say) carries that task on instead.
    @discardableResult
    public mutating func begin(message id: UUID, text: String, owner: BotEngine?, replyingTo: UUID? = nil, at date: Date) -> UUID {
        if let replyingTo, let existing = task(containing: replyingTo), let at = index(existing.id) {
            tasks[at].messageIDs.append(id)
            if tasks[at].state != .done, tasks[at].state != .stopped { tasks[at].state = tasks[at].owner == nil ? .pending : .running }
            tasks[at].updatedAt = date
            return existing.id
        }
        let card = TaskCard(name: Self.provisionalName(text), owner: owner, createdAt: date, messageIDs: [id], startedByMessageID: id)
        tasks.append(card)
        trim()
        return card.id
    }

    /// `head` started on the user's `message` (its first words or tool): it owns the card unless
    /// another head already does, and the card runs. True when something changed.
    @discardableResult
    public mutating func claim(message id: UUID, by head: BotEngine, at date: Date) -> Bool {
        guard let card = task(containing: id), let at = index(card.id) else { return false }
        var changed = false
        if tasks[at].owner == nil { tasks[at].owner = head; changed = true }
        if tasks[at].state == .pending, tasks[at].owner == head {
            tasks[at].state = .running
            tasks[at].updatedAt = date
            changed = true
        }
        return changed
    }

    /// A head used a tool for the user's `message`: the card is real work and stays. One a quick
    /// answer already took away comes back (the other head took longer). Returns its id.
    @discardableResult
    public mutating func working(on message: UUID, text: String, by head: BotEngine, at date: Date) -> UUID {
        if let card = task(containing: message), let at = index(card.id) {
            tasks[at].kept = true
            return card.id
        }
        let id = begin(message: message, text: text, owner: head, at: date)
        if let at = index(id) {
            tasks[at].kept = true
            tasks[at].state = .running
        }
        return id
    }

    /// You sent `later` before a head answered `earlier`, and both go as one message: the later
    /// one's provisional card joins the earlier one's.
    public mutating func join(message earlier: UUID, into later: UUID) {
        guard let first = task(containing: earlier), let second = task(containing: later), first.id != second.id,
              second.startedByMessageID == later, let from = index(second.id) else { return }
        merge(from, into: first.id)
    }

    /// A subagent or worker started for `task`.
    public mutating func link(subagent: String, to task: UUID) {
        guard let at = index(task), tasks[at].subagentIDs?.contains(subagent) != true else { return }
        tasks[at].subagentIDs = (tasks[at].subagentIDs ?? []) + [subagent]
        tasks[at].kept = true
    }

    /// The other head took on part of `task` (a hand-off): a line on its card.
    public mutating func help(_ help: TaskCard.Help, on task: UUID) {
        guard let at = index(task), tasks[at].helps?.contains(where: { $0.handoffID == help.handoffID }) != true else { return }
        tasks[at].helps = (tasks[at].helps ?? []) + [help]
    }

    /// What a finished turn was about, for `replied`.
    public struct Turn: Equatable, Sendable {
        public var head: BotEngine
        /// The user's message the turn answered; nil for handed work and background reports.
        public var userMessage: UUID?
        public var userText: String?
        /// When the head got the message.
        public var started: Date?
        public var usedTools = false
        /// Hand-off it worked on, and the subagents whose reports it passes on.
        public var handoffID: UUID?
        public var reporting: [String] = []
        /// The reply asks the user something (a choices block).
        public var asks = false
        /// The reply hands part of the work to the other head (a `<handoff>`).
        public var handsOff = false
        /// Subagents and workers still at work, and hand-offs the other head still works on,
        /// when the turn ended: a card with one of them linked is not over yet.
        public var runningSubagents: Set<String> = []
        public var runningHandoffs: Set<UUID> = []

        public init(head: BotEngine, userMessage: UUID? = nil, userText: String? = nil, started: Date? = nil, usedTools: Bool = false,
                    handoffID: UUID? = nil, reporting: [String] = [], asks: Bool = false, handsOff: Bool = false,
                    runningSubagents: Set<String> = [], runningHandoffs: Set<UUID> = []) {
            self.head = head
            self.userMessage = userMessage
            self.userText = userText
            self.started = started
            self.usedTools = usedTools
            self.handoffID = handoffID
            self.reporting = reporting
            self.asks = asks
            self.handsOff = handsOff
            self.runningSubagents = runningSubagents
            self.runningHandoffs = runningHandoffs
        }
    }

    /// The card a turn works on: the one of the user's message, of its hand-off, or of the
    /// subagents it reports on.
    func base(of turn: Turn) -> TaskCard? {
        if let message = turn.userMessage { return task(containing: message) }
        if let handoff = turn.handoffID, let card = tasks.last(where: { $0.helps?.contains { $0.handoffID == handoff } == true }) { return card }
        let reporting = Set(turn.reporting)
        guard !reporting.isEmpty else { return nil }
        return tasks.last { !reporting.isDisjoint(with: $0.subagentIDs ?? []) }
    }

    /// A head's reply `message` ended its turn, with the `<task>` lines it wrote. Returns the
    /// cards it now belongs to (none: a quick answer, or a reply to nothing the book follows).
    @discardableResult
    public mutating func replied(_ message: UUID, turn: Turn, tags: [TaskTag], at date: Date) -> [UUID] {
        let quick = turn.userMessage != nil && !turn.usedTools && turn.started.map { date.timeIntervalSince($0) < Self.quickAnswer } ?? true
        var base = base(of: turn)
        if tags.isEmpty {
            if base == nil, let user = turn.userMessage, !quick {
                // A quick answer took the card away; this head's longer answer brings it back.
                let id = working(on: user, text: turn.userText ?? "", by: turn.head, at: date)
                base = task(id)
            }
            guard let card = base, let at = index(card.id) else { return [] }
            if quick, !card.kept, card.state == .pending || card.state == .running, card.subagentIDs?.isEmpty != false {
                tasks.remove(at: at)
                return []
            }
            touch(at, message: message, head: turn.head, asks: turn.asks, at: date)
            if !quick { tasks[at].kept = true }
            settle(card.id, turn: turn, at: date)
            return [card.id]
        }
        var touched: [UUID] = []
        for (number, tag) in tags.enumerated() {
            var target: Int?
            if let earlier = tag.continues, let found = task(named: earlier), found.id != base?.id {
                // It carries on an earlier task: this message, and what its own card had, join it.
                if number == 0, turn.userMessage != nil, let card = base, let from = index(card.id), card.startedByMessageID == turn.userMessage {
                    merge(from, into: found.id)
                    base = nil
                }
                target = index(found.id)
            } else if number == 0, let card = base {
                target = index(card.id)
            } else if let name = tag.name ?? tag.continues, let found = task(named: name) {
                target = index(found.id)
            }
            if target == nil {
                let name = tag.name ?? tag.continues ?? turn.userText.map(Self.provisionalName) ?? L("New task")
                var card = TaskCard(name: name, owner: turn.head, state: .running, createdAt: date, startedByMessageID: turn.userMessage)
                if number == 0, let user = turn.userMessage { card.messageIDs = [user] }
                tasks.append(card)
                target = tasks.count - 1
            }
            guard let at = target else { continue }
            apply(tag, at: at, head: turn.head, message: message, asks: turn.asks, at: date)
            touched.append(tasks[at].id)
        }
        for id in touched { settle(id, turn: turn, at: date) }
        trim()
        return touched
    }

    /// The card's state is set back from waiting or pending by its owner's reply without a tag.
    private mutating func touch(_ at: Int, message: UUID, head: BotEngine, asks: Bool, at date: Date) {
        if !tasks[at].messageIDs.contains(message) { tasks[at].messageIDs.append(message) }
        if tasks[at].owner == nil { tasks[at].owner = head }
        guard tasks[at].owner == head else { return }
        if asks, tasks[at].state.isActive {
            tasks[at].state = .waiting
        } else if tasks[at].state == .pending || tasks[at].state == .waiting {
            tasks[at].state = .running
        }
        tasks[at].updatedAt = date
    }

    private mutating func apply(_ tag: TaskTag, at: Int, head: BotEngine, message: UUID, asks: Bool, at date: Date) {
        if !tasks[at].messageIDs.contains(message) { tasks[at].messageIDs.append(message) }
        tasks[at].kept = true
        if tasks[at].owner == nil { tasks[at].owner = head }
        // One owner: the other head's line only puts its message on the card.
        guard tasks[at].owner == head else { return }
        if let name = tag.name { tasks[at].name = name }
        if let now = tag.now { tasks[at].now = now.isEmpty ? nil : now }
        if let next = tag.next { tasks[at].next = next.isEmpty ? nil : next }
        if let blocked = tag.blocked { tasks[at].blocked = blocked.isEmpty ? nil : blocked }
        tasks[at].state = tag.state ?? (asks ? .waiting : .running)
        if let state = tag.state { tasks[at].stateFromTag = state }
        tasks[at].updatedAt = date
    }

    /// The owner's turn is over. A card it left running without ever saying so in a `<task>`
    /// line (a plain long answer), with no subagent, worker or hand-off of it still at work, is
    /// done: nothing carries it on, so it must not sit there and turn into "may be stuck".
    /// One its owner said is running keeps running (and may go stale).
    private mutating func settle(_ id: UUID, turn: Turn, at date: Date) {
        guard let at = index(id), tasks[at].owner == turn.head, tasks[at].state == .running,
              tasks[at].stateFromTag != .running, !turn.handsOff else { return }
        if tasks[at].subagentIDs?.contains(where: turn.runningSubagents.contains) == true { return }
        if tasks[at].helps?.contains(where: { turn.runningHandoffs.contains($0.handoffID) }) == true { return }
        tasks[at].state = .done
        tasks[at].updatedAt = date
    }

    /// Moves card `from`'s lines, helpers and subagents onto `into`, and drops it.
    private mutating func merge(_ from: Int, into id: UUID) {
        let card = tasks.remove(at: from)
        guard let at = index(id) else { return }
        for message in card.messageIDs where !tasks[at].messageIDs.contains(message) { tasks[at].messageIDs.append(message) }
        for help in card.helps ?? [] { self.help(help, on: id) }
        for subagent in card.subagentIDs ?? [] { link(subagent: subagent, to: id) }
    }

    /// The user (or the app) set a card's state by hand.
    public mutating func set(_ id: UUID, state: TaskCard.State, at date: Date) {
        guard let at = index(id) else { return }
        tasks[at].state = state
        tasks[at].updatedAt = date
    }

    /// Lines gone from the chat leave their cards; cards with none of their lines left go.
    public mutating func keep(only present: Set<UUID>) -> Bool {
        let before = tasks
        for at in tasks.indices { tasks[at].messageIDs.removeAll { !present.contains($0) } }
        tasks.removeAll { $0.messageIDs.isEmpty }
        return tasks != before
    }

    /// Past `limit`, the oldest finished cards go first, then the oldest of all.
    private mutating func trim() {
        while tasks.count > Self.limit {
            if let at = tasks.firstIndex(where: { !$0.state.isActive }) { tasks.remove(at: at) } else { tasks.removeFirst() }
        }
    }
}
