import Foundation

/// What a hand-off between the heads is for, as the head handing it says (`kind="…"`): the
/// app does not guess it. Reviews and discussions have their own round limits.
public enum HandoffKind: String, Sendable {
    case task, review, discuss
}

/// The tag a head ends a reply with to hand the other head work:
/// `<handoff to="codex" kind="review">what to do</handoff>`. The model decides it; the app only
/// reads it and takes it out of what the chat shows.
public struct HeadTags: Equatable, Sendable {
    public struct Handoff: Equatable, Sendable {
        public var to: BotEngine
        public var kind: HandoffKind
        public var task: String
    }

    public var handoff: Handoff?

    public init(handoff: Handoff? = nil) {
        self.handoff = handoff
    }

    /// The tag in `text`, and the text without it.
    public static func parse(_ text: String) -> (body: String, tags: HeadTags) {
        guard let regex = try? NSRegularExpression(pattern: #"<handoff\b([^>]*)>([\s\S]*?)</handoff>"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let whole = Range(match.range, in: text),
              let attributes = Range(match.range(at: 1), in: text),
              let inner = Range(match.range(at: 2), in: text) else {
            return (text.trimmingCharacters(in: .whitespacesAndNewlines), HeadTags())
        }
        func attribute(_ name: String) -> String? {
            let pattern = name + #"\s*=\s*"([^"]*)""#
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let found = regex.firstMatch(in: String(text[attributes]), range: NSRange(text[attributes].startIndex..., in: text[attributes])),
                  let value = Range(found.range(at: 1), in: String(text[attributes])) else { return nil }
            return String(String(text[attributes])[value])
        }
        var body = text
        body.removeSubrange(whole)
        let task = String(text[inner]).trimmingCharacters(in: .whitespacesAndNewlines)
        var tags = HeadTags()
        if let to = attribute("to").flatMap({ BotEngine(rawValue: $0.lowercased()) }), !task.isEmpty {
            tags.handoff = Handoff(to: to, kind: attribute("kind").flatMap { HandoffKind(rawValue: $0.lowercased()) } ?? .task, task: task)
        }
        return (body.trimmingCharacters(in: .whitespacesAndNewlines), tags)
    }
}

/// Where the hand-offs for the user's latest message stand, for the line over the input box
/// ("Review round 1 of 2 · Stop now").
public struct RoundsProgress: Equatable, Sendable {
    public enum Kind: String, Sendable { case discussion, review, handoff }
    public var kind: Kind
    public var round: Int
    public var limit: Int

    public init(kind: Kind, round: Int, limit: Int) {
        self.kind = kind
        self.round = round
        self.limit = limit
    }

    public var shown: String {
        switch kind {
        case .discussion: L("Round {0} of {1}", round, limit)
        case .review: L("Review round {0} of {1}", round, limit)
        case .handoff: L("Hand-off {0} of {1}", round, limit)
        }
    }
}

/// A button on the card shown at a limit.
public enum CardPick: Equatable, Sendable {
    case goWith(BotEngine)
    case oneMoreRound
}

/// What the conductor wants done.
public enum ConductorAction: Equatable, Sendable {
    /// Work for a head (a hand-off, its hand-back, the user's pick): wakes it if it sleeps,
    /// joins its turn if it works.
    case ask(BotEngine, String)
    /// A line in the chat between messages ("Claude → Codex: …").
    case line(String)
    /// A card with buttons; the pick comes back through `picked`.
    case card(String, [(label: String, pick: CardPick)])
    case progress(RoundsProgress?)

    public static func == (a: ConductorAction, b: ConductorAction) -> Bool {
        switch (a, b) {
        case let (.ask(h1, t1), .ask(h2, t2)): h1 == h2 && t1 == t2
        case let (.line(x), .line(y)): x == y
        case let (.card(t1, c1), .card(t2, c2)): t1 == t2 && c1.map(\.label) == c2.map(\.label) && c1.map(\.pick) == c2.map(\.pick)
        case let (.progress(x), .progress(y)): x == y
        default: false
        }
    }
}

/// The hand-offs between a bot's two heads and their limits. The heads run at the same time
/// and decide between them who does what; the conductor only carries a hand-off to the other
/// head, gives the reply back to the one who handed it, and counts, so they cannot go back and
/// forth forever: per user message, at most `limits.handoffs` hand-offs, of them
/// `limits.review` reviews and `limits.discussion` discussion rounds.
struct Conductor {
    var settings: HeadsSettings
    /// Hand-offs made for the user's latest message, by kind.
    private var counts: [HandoffKind: Int] = [:]
    private var total = 0
    /// Rounds the user granted at a limit ("One more round"), for this message.
    private var extra: [HandoffKind: Int] = [:]
    private var extraTotal = 0
    /// For each head working on handed work, who handed it (newest last).
    private var handedBy: [BotEngine: [BotEngine]] = [:]
    /// Each head's latest reply, for the card at a limit.
    private var latest: [BotEngine: String] = [:]
    /// The hand-off a limit stopped, for "One more round".
    private var blocked: (from: BotEngine, handoff: HeadTags.Handoff)?
    /// "Stop now" was pressed: no more hand-offs until the user writes again.
    private var stopped = false

    init(settings: HeadsSettings) {
        self.settings = settings
    }

    /// Handed work is out: a head works for the other.
    var isRunning: Bool { handedBy.values.contains { !$0.isEmpty } }

    /// The user wrote: the counts start again; work handed for the last message is forgotten.
    mutating func userMessage() -> [ConductorAction] {
        let was = isRunning
        counts = [:]
        total = 0
        extra = [:]
        extraTotal = 0
        handedBy = [:]
        blocked = nil
        stopped = false
        return was ? [.progress(nil)] : []
    }

    /// "Stop now": no more hand-offs for this message; work under way still shows when it comes.
    mutating func stop() -> [ConductorAction] {
        guard isRunning || blocked != nil else { return [] }
        handedBy = [:]
        blocked = nil
        stopped = true
        return [.progress(nil), .line(L("Stopped by you"))]
    }

    /// A head's reply was shown. `handed`: its turn did work the other head handed it.
    mutating func replied(_ head: BotEngine, _ text: String, tags: HeadTags, handed: Bool) -> [ConductorAction] {
        latest[head] = text
        var out: [ConductorAction] = []
        // Handed work done: the reply goes back to the one who handed it.
        if handed, var waiting = handedBy[head], let from = waiting.popLast() {
            handedBy[head] = waiting
            out.append(.ask(from, Self.handBack(from: head, reply: text)))
        }
        if !stopped, let handoff = tags.handoff, handoff.to != head,
           settings.handoffs || !settings.engines.contains(handoff.to) {
            out += handOff(from: head, handoff)
        } else if !isRunning {
            out.append(.progress(nil))
        }
        return out
    }

    mutating func picked(_ pick: CardPick) -> [ConductorAction] {
        switch pick {
        case let .goWith(head):
            blocked = nil
            return [.progress(nil), .line(L("You went with {0}'s", head.displayName)), .ask(head, Self.wentWith)]
        case .oneMoreRound:
            guard let stopped = blocked else { return [] }
            blocked = nil
            extra[stopped.handoff.kind, default: 0] += 1
            extraTotal += 1
            return handOff(from: stopped.from, stopped.handoff)
        }
    }

    // MARK: Hand-offs

    private func limit(_ kind: HandoffKind) -> Int? {
        let base: Int? = switch kind {
        case .task: nil
        case .review: settings.limits.review
        case .discuss: settings.limits.discussion
        }
        return base.map { $0 + extra[kind, default: 0] }
    }

    private mutating func handOff(from: BotEngine, _ handoff: HeadTags.Handoff) -> [ConductorAction] {
        let kindLimit = limit(handoff.kind)
        let totalLimit = settings.limits.handoffs + extraTotal
        let done = counts[handoff.kind, default: 0]
        if total >= totalLimit || kindLimit.map({ done >= $0 }) == true {
            return atLimit(from: from, handoff, done: kindLimit == nil || total >= totalLimit ? total : done)
        }
        counts[handoff.kind, default: 0] += 1
        total += 1
        handedBy[handoff.to, default: []].append(from)
        let progress: RoundsProgress = switch handoff.kind {
        case .task: RoundsProgress(kind: .handoff, round: total, limit: totalLimit)
        case .review: RoundsProgress(kind: .review, round: counts[.review] ?? 1, limit: kindLimit ?? 1)
        case .discuss: RoundsProgress(kind: .discussion, round: counts[.discuss] ?? 1, limit: kindLimit ?? 1)
        }
        let line = "\(from.displayName) → \(handoff.to.displayName): \(handoff.task.split(whereSeparator: \.isNewline).first.map(String.init) ?? handoff.task)"
        return [.line(line), .progress(progress),
                .ask(handoff.to, Self.handed(from: from, handoff: handoff, count: total, limit: totalLimit))]
    }

    /// The limit is reached: a card with where each head stands, or the latest version stands.
    private mutating func atLimit(from: BotEngine, _ handoff: HeadTags.Handoff, done: Int) -> [ConductorAction] {
        switch settings.limits.atLimit {
        case .ask:
            blocked = (from, handoff)
            let lead = switch handoff.kind {
            case .task: L("{0} hand-offs for this message: the limit.", done)
            case .review: L("{0} review rounds done.", done)
            case .discuss: L("{0} rounds done. They still disagree.", done)
            }
            let sides = BotEngine.allCases.compactMap { head in
                latest[head].map { "\(head.displayName): \(Self.short($0))" }
            }.joined(separator: "\n")
            return [.progress(nil),
                    .card(lead + (sides.isEmpty ? "" : "\n\n" + sides),
                          BotEngine.allCases.map { (L("Go with {0}'s", $0.displayName), CardPick.goWith($0)) } + [(L("One more round"), .oneMoreRound)])]
        case .useDoers:
            return [.progress(nil), .line(L("Hand-off limit reached ({0} for this message): not handed to {1}", done, handoff.to.displayName)),
                    .ask(from, Self.limitReached(other: handoff.to))]
        }
    }

    static func short(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.count > 200 ? String(line.prefix(200)) + "…" : line
    }

    // MARK: What the heads are told

    static func handed(from: BotEngine, handoff: HeadTags.Handoff, count: Int, limit: Int) -> String {
        let what = switch handoff.kind {
        case .task: "hands you this"
        case .review: "asks you to review this"
        case .discuss: "wants your view on this"
        }
        return "(App: \(from.displayName), this bot's other head, \(what) (hand-off \(count) of \(limit) for the user's latest message):\n\(handoff.task)\n\nDo it, then reply with the result; the app gives your reply back to \(from.displayName).)"
    }

    static func handBack(from: BotEngine, reply: String) -> String {
        "(App: \(from.displayName) finished what you handed over. Its reply:\n\(reply)\n\nCarry on from there, and tell the user what came of it.)"
    }

    static func limitReached(other: BotEngine) -> String {
        "(App: The hand-offs for the user's latest message are used up; \(other.displayName) was not asked. Your latest version stands: tell the user in a sentence or two where things are and what is left.)"
    }

    static let wentWith = "(App: The user went with your version. If something in it is still to be done, do it now and say what came of it; if not, reply only <no-reply/>.)"
}
