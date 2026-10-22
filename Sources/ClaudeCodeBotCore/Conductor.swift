import Foundation

/// The tags a head ends a reply with to talk to the other head or the app: hand work over,
/// say where it stands in a discussion, or what a review found. The model decides them; the
/// app only reads them and takes them out of what the chat shows.
public struct HeadTags: Equatable, Sendable {
    /// `<handoff to="codex">task</handoff>`
    public var handoff: (to: BotEngine, task: String)? {
        get { handoffTarget.map { ($0, handoffTask) } }
        set { handoffTarget = newValue?.to; handoffTask = newValue?.task ?? "" }
    }
    private var handoffTarget: BotEngine?
    private var handoffTask = ""
    /// `<position agree="yes|no">one line</position>`: nil when it gave none.
    public var agrees: Bool?
    public var position = ""
    /// `<review blocking="N">one line</review>`: nil when it gave no count.
    public var blocking: Int?
    public var review = ""

    public init() {}

    public static func == (a: HeadTags, b: HeadTags) -> Bool {
        a.handoffTarget == b.handoffTarget && a.handoffTask == b.handoffTask && a.agrees == b.agrees
            && a.position == b.position && a.blocking == b.blocking && a.review == b.review
    }

    /// The tags in `text`, and the text without them.
    public static func parse(_ text: String) -> (body: String, tags: HeadTags) {
        var tags = HeadTags()
        var body = text
        if let match = first(#"<handoff\s+to\s*=\s*"([A-Za-z]+)"\s*>([\s\S]*?)</handoff>"#, in: body) {
            let task = match.groups[1].trimmingCharacters(in: .whitespacesAndNewlines)
            if let to = BotEngine(rawValue: match.groups[0].lowercased()), !task.isEmpty { tags.handoff = (to, task) }
            body.removeSubrange(match.range)
        }
        if let match = first(#"<position\s+agree\s*=\s*"([A-Za-z]+)"\s*>([\s\S]*?)</position>"#, in: body) {
            switch match.groups[0].lowercased() {
            case "yes", "true": tags.agrees = true
            case "no", "false": tags.agrees = false
            default: break
            }
            tags.position = match.groups[1].trimmingCharacters(in: .whitespacesAndNewlines)
            body.removeSubrange(match.range)
        }
        if let match = first(#"<review\s+blocking\s*=\s*"(\d+)"\s*>([\s\S]*?)</review>"#, in: body) {
            tags.blocking = Int(match.groups[0])
            tags.review = match.groups[1].trimmingCharacters(in: .whitespacesAndNewlines)
            body.removeSubrange(match.range)
        }
        return (body.trimmingCharacters(in: .whitespacesAndNewlines), tags)
    }

    private static func first(_ pattern: String, in text: String) -> (range: Range<String.Index>, groups: [String])? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range, in: text) else { return nil }
        let groups = (1..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
        }
        return (range, groups)
    }
}

/// Where a loop between the heads stands, for the line over the input box ("Round 2 of 3 · Stop now").
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

/// A button on a card the conductor shows (at a limit, or after both answered).
public enum CardPick: Equatable, Sendable {
    case discuss
    case goWith(BotEngine)
    case oneMoreRound
    case keepAsIs
    case letFix(BotEngine)
}

/// What the conductor wants done.
public enum ConductorAction: Equatable, Sendable {
    /// A turn for a head: the user's own message (`fromUser`), or the app's.
    case ask(BotEngine, String, fromUser: Bool)
    /// A line in the chat between messages ("Claude → Codex: …").
    case line(String)
    /// A card with buttons; the pick comes back through `picked`.
    case card(String, [(label: String, pick: CardPick)])
    case progress(RoundsProgress?)

    public static func == (a: ConductorAction, b: ConductorAction) -> Bool {
        switch (a, b) {
        case let (.ask(h1, t1, u1), .ask(h2, t2, u2)): h1 == h2 && t1 == t2 && u1 == u2
        case let (.line(x), .line(y)): x == y
        case let (.card(t1, c1), .card(t2, c2)): t1 == t2 && c1.map(\.label) == c2.map(\.label) && c1.map(\.pick) == c2.map(\.pick)
        case let (.progress(x), .progress(y)): x == y
        default: false
        }
    }
}

/// The loops between a bot's two heads, counted by the app (P3 of the Codex engine plan):
/// hand-offs with their automatic hand-back, the four "Both" modes, and the round limits. It
/// only decides; the bot sends what it says to the heads, one at a time.
struct Conductor {
    private enum Run {
        /// Both answer; then a card.
        case both(order: [BotEngine], question: String, answers: [BotEngine: String])
        /// One does the work, the other reviews it; `round` counts reviews.
        case review(doer: BotEngine, reviewer: BotEngine, question: String, round: Int, limit: Int, stage: ReviewStage, work: String)
        /// They take turns saying their piece; a round is each once.
        case discussion(order: [BotEngine], question: String, round: Int, limit: Int, said: [BotEngine: String], last: BotEngine?)
        /// The head asked for the one final answer; its reply ends the run.
        case final(BotEngine)
    }

    private enum ReviewStage { case doing, reviewing, fixing }

    var settings: HeadsSettings
    private var run: Run?
    /// What the card on screen was about, for its pick.
    private var cardRun: Run?
    /// Hand-offs made for the user's latest message.
    private(set) var handoffCount = 0
    /// Who handed work to whom, newest last: each hand-back goes to the one who handed it.
    private var handedBy: [(from: BotEngine, to: BotEngine)] = []

    init(settings: HeadsSettings) {
        self.settings = settings
    }

    var isRunning: Bool { run != nil || !handedBy.isEmpty }

    /// The user wrote: what was going on between the heads stops (they come first), and a
    /// message to Both starts its loop. Nil target: an ordinary message for one head.
    mutating func userMessage(_ text: String, to target: AnswerTarget) -> [ConductorAction] {
        let wasRunning = isRunning
        run = nil
        cardRun = nil
        handedBy = []
        handoffCount = 0
        var out: [ConductorAction] = wasRunning ? [.progress(nil)] : []
        guard target == .both, settings.hasTwo else { return out }
        let order = settings.engines
        switch settings.both {
        case .askBoth:
            run = .both(order: order, question: text, answers: [:])
            out.append(.ask(order[0], text, fromUser: true))
        case .claudeDoesCodexReviews, .codexDoesClaudeReviews:
            let doer: BotEngine = settings.both == .claudeDoesCodexReviews ? .claude : .codex
            let reviewer = other(doer)
            run = .review(doer: doer, reviewer: reviewer, question: text, round: 0, limit: settings.limits.review, stage: .doing, work: "")
            out.append(.ask(doer, text + "\n\n" + Self.doerNote(reviewer: reviewer), fromUser: true))
        case .discuss:
            run = .discussion(order: order, question: text, round: 1, limit: settings.limits.discussion, said: [:], last: nil)
            out.append(.progress(RoundsProgress(kind: .discussion, round: 1, limit: settings.limits.discussion)))
            out.append(.ask(order[0], text + "\n\n" + Self.openDiscussion(with: order[1], limit: settings.limits.discussion), fromUser: true))
        }
        return out
    }

    /// "Stop now": the loop ends where it is; the turn under way still shows when it comes.
    mutating func stop() -> [ConductorAction] {
        guard isRunning || cardRun != nil else { return [] }
        run = nil
        cardRun = nil
        handedBy = []
        return [.progress(nil), .line(L("Stopped by you"))]
    }

    /// A head's reply was shown. `conducted`: it answers a turn the conductor asked for.
    mutating func replied(_ head: BotEngine, _ text: String, tags: HeadTags, conducted: Bool) -> [ConductorAction] {
        if conducted, let run, let next = advance(run, head: head, text: text, tags: tags) {
            return next
        }
        // A hand-off it asked for; one inside a loop waits until the loop is done.
        if let handoff = tags.handoff, handoff.to != head, run == nil, settings.handoffs || !settings.engines.contains(handoff.to) {
            return handOff(from: head, to: handoff.to, task: handoff.task)
        }
        // The head work was handed to has finished it: it goes back to the one who handed it.
        if conducted, run == nil, let last = handedBy.last, last.to == head {
            handedBy.removeLast()
            var out = [ConductorAction.ask(last.from, Self.handBack(from: head, reply: text), fromUser: false)]
            if handedBy.isEmpty { out.insert(.progress(nil), at: 0) }
            return out
        }
        return []
    }

    mutating func picked(_ pick: CardPick) -> [ConductorAction] {
        guard let about = cardRun else { return [] }
        cardRun = nil
        switch (pick, about) {
        case let (.discuss, .both(order, question, answers)):
            let limit = settings.limits.discussion
            run = .discussion(order: order, question: question, round: 1, limit: limit, said: answers, last: order[1])
            return [.progress(RoundsProgress(kind: .discussion, round: 1, limit: limit)),
                    .ask(order[0], Self.discussTurn(round: 1, limit: limit, question: question, other: order[1], said: answers[order[1]] ?? ""), fromUser: false)]
        case let (.goWith(head), _):
            run = .final(head)
            return [.progress(nil), .line(L("You went with {0}'s", head.displayName)), .ask(head, Self.wentWith, fromUser: false)]
        case let (.oneMoreRound, .discussion(order, question, round, limit, said, last)):
            let next = Run.discussion(order: order, question: question, round: round + 1, limit: limit + 1, said: said, last: last)
            run = next
            return [.progress(RoundsProgress(kind: .discussion, round: round + 1, limit: limit + 1)),
                    .ask(order[0], Self.discussTurn(round: round + 1, limit: limit + 1, question: question, other: order[1], said: said[order[1]] ?? ""), fromUser: false)]
        case let (.oneMoreRound, .review(doer, reviewer, question, round, limit, _, work)):
            run = .review(doer: doer, reviewer: reviewer, question: question, round: round, limit: limit + 1, stage: .fixing, work: work)
            return [.progress(RoundsProgress(kind: .review, round: round + 1, limit: limit + 1)),
                    .ask(doer, Self.fix(reviewer: reviewer, round: round, review: work), fromUser: false)]
        case let (.letFix(head), .review(_, _, _, _, _, _, work)):
            run = nil
            return [.progress(nil), .ask(head, Self.fixYourself(review: work), fromUser: false)]
        case (.keepAsIs, _):
            run = nil
            return [.progress(nil), .line(L("Kept as it is"))]
        default:
            return []
        }
    }

    // MARK: Loops

    private mutating func advance(_ current: Run, head: BotEngine, text: String, tags: HeadTags) -> [ConductorAction]? {
        switch current {
        case let .final(final):
            guard final == head else { return nil }
            run = nil
            return [.progress(nil)]
        case let .both(order, question, answers):
            guard let index = order.firstIndex(of: head), answers[head] == nil else { return nil }
            var answers = answers
            answers[head] = text
            if index + 1 < order.count {
                run = .both(order: order, question: question, answers: answers)
                let before = order.prefix(index + 1).map(\.displayName).joined(separator: " and ")
                return [.ask(order[index + 1], Self.bothNote(answered: before) + "\n\n" + question, fromUser: false)]
            }
            run = nil
            cardRun = .both(order: order, question: question, answers: answers)
            return [.card(L("Both answered. What next?"), [(L("Let them discuss"), .discuss)] + order.map { (L("Go with {0}'s", $0.displayName), CardPick.goWith($0)) })]
        case let .review(doer, reviewer, question, round, limit, stage, _):
            switch stage {
            case .doing, .fixing:
                guard head == doer else { return nil }
                let next = round + 1
                run = .review(doer: doer, reviewer: reviewer, question: question, round: next, limit: limit, stage: .reviewing, work: text)
                return [.progress(RoundsProgress(kind: .review, round: next, limit: limit)),
                        .ask(reviewer, Self.reviewTurn(round: next, limit: limit, question: question, doer: doer, work: text), fromUser: false)]
            case .reviewing:
                guard head == reviewer else { return nil }
                let review = tags.review.isEmpty ? text : tags.review
                // No count said: it is read as still blocking (the limit ends it either way).
                let blocking = tags.blocking ?? 1
                if blocking == 0 {
                    run = .final(doer)
                    return [.progress(nil), .line(L("{0} review {1} of {2}: no blocking issues", reviewer.displayName, round, limit)),
                            .ask(doer, Self.reviewPassed(reviewer: reviewer, review: text), fromUser: false)]
                }
                let found = L("{0} review {1} of {2}: {3} blocking", reviewer.displayName, round, limit, blocking)
                if round < limit {
                    run = .review(doer: doer, reviewer: reviewer, question: question, round: round, limit: limit, stage: .fixing, work: text)
                    return [.line(found), .ask(doer, Self.fix(reviewer: reviewer, round: round, review: text), fromUser: false)]
                }
                switch settings.limits.atLimit {
                case .ask:
                    run = nil
                    cardRun = .review(doer: doer, reviewer: reviewer, question: question, round: round, limit: limit, stage: .reviewing, work: text)
                    return [.progress(nil), .line(found),
                            .card(L("{0} review rounds done. {1} blocking issue(s) left.", limit, blocking) + "\n\n" + "\(reviewer.displayName): \(review)",
                                  [(L("Keep it as is"), .keepAsIs), (L("Fix it, one more round"), .oneMoreRound), (L("Let {0} fix it", reviewer.displayName), .letFix(reviewer))])]
                case .useDoers:
                    run = .final(doer)
                    return [.progress(nil), .line(found), .ask(doer, Self.reviewLimit(reviewer: reviewer, review: text), fromUser: false)]
                }
            }
        case let .discussion(order, question, round, limit, said, last):
            guard order.contains(head), head != last else { return nil }
            var said = said
            said[head] = tags.position.isEmpty ? text : tags.position
            let other = self.other(head)
            // It agrees with the other's position: one answer, from the one agreed with.
            if tags.agrees == true, last != nil {
                run = .final(other)
                return [.progress(nil), .line(L("{0} and {1} agree", head.displayName, other.displayName)),
                        .ask(other, Self.agreed(by: head, position: said[head] ?? ""), fromUser: false)]
            }
            let endsRound = head == order[order.count - 1]
            if endsRound, round >= limit {
                switch settings.limits.atLimit {
                case .ask:
                    run = nil
                    cardRun = .discussion(order: order, question: question, round: round, limit: limit, said: said, last: head)
                    let sides = order.map { "\($0.displayName): \(said[$0] ?? "")" }.joined(separator: "\n")
                    return [.progress(nil),
                            .card(L("{0} rounds done. They still disagree.", limit) + "\n\n" + sides,
                                  order.map { (L("Go with {0}'s", $0.displayName), CardPick.goWith($0)) } + [(L("One more round"), .oneMoreRound)])]
                case .useDoers:
                    let doer = order[0]
                    run = .final(doer)
                    return [.progress(nil), .ask(doer, Self.discussionLimit(other: self.other(doer), position: said[self.other(doer)] ?? ""), fromUser: false)]
                }
            }
            let nextRound = endsRound ? round + 1 : round
            run = .discussion(order: order, question: question, round: nextRound, limit: limit, said: said, last: head)
            return [.progress(RoundsProgress(kind: .discussion, round: nextRound, limit: limit)),
                    .ask(other, Self.discussTurn(round: nextRound, limit: limit, question: question, other: head, said: said[head] ?? ""), fromUser: false)]
        }
    }

    private mutating func handOff(from: BotEngine, to: BotEngine, task: String) -> [ConductorAction] {
        let line = "\(from.displayName) → \(to.displayName): \(task.split(whereSeparator: \.isNewline).first.map(String.init) ?? task)"
        guard handoffCount < settings.limits.handoffs else {
            return [.progress(nil), .line(L("Hand-off limit reached ({0} for this message): not handed to {1}", settings.limits.handoffs, to.displayName))]
        }
        handoffCount += 1
        handedBy.append((from, to))
        return [.line(line), .progress(RoundsProgress(kind: .handoff, round: handoffCount, limit: settings.limits.handoffs)),
                .ask(to, Self.handed(from: from, task: task, count: handoffCount, limit: settings.limits.handoffs), fromUser: false)]
    }

    private func other(_ head: BotEngine) -> BotEngine {
        BotEngine.allCases.first { $0 != head } ?? head
    }

    /// The turn it asked for ended in an error: the loop stops there.
    mutating func abort() -> [ConductorAction] {
        guard isRunning else { return [] }
        run = nil
        handedBy = []
        return [.progress(nil)]
    }

    // MARK: What the heads are told

    /// What the second head is told when the user asked both: the first has answered.
    static func bothNote(answered: String) -> String {
        "(App: The user asked both heads of this bot. \(answered) answered first (above); now give your own answer to the same message.)"
    }

    static func doerNote(reviewer: BotEngine) -> String {
        "(App: When you are done, \(reviewer.displayName), this bot's other head, reviews your work; you then fix what it finds.)"
    }

    static func reviewTurn(round: Int, limit: Int, question: String, doer: BotEngine, work: String) -> String {
        "(App: Review round \(round) of \(limit). The user asked: \"\(question)\". \(doer.displayName) did the work; its reply was:\n\(work)\n\nReview the work itself (the changes, the files), not only the reply. Say what must be fixed before it is done (blocking) and what is only a nit. End your reply with <review blocking=\"N\">one line</review>, N being how many blocking issues are left (0 when none).)"
    }

    static func fix(reviewer: BotEngine, round: Int, review: String) -> String {
        "(App: \(reviewer.displayName)'s review (round \(round)) found blocking issues:\n\(review)\n\nFix them, then say in a sentence or two what you changed. Nits may stay as they are; say which.)"
    }

    static func reviewPassed(reviewer: BotEngine, review: String) -> String {
        "(App: \(reviewer.displayName)'s review found no blocking issues:\n\(review)\n\nTell the user in one or two sentences that it is done, and which nits you left as they are.)"
    }

    static func reviewLimit(reviewer: BotEngine, review: String) -> String {
        "(App: The review rounds are used up and \(reviewer.displayName) still found blocking issues:\n\(review)\n\nYour latest version stands. Tell the user in one or two sentences that it is done as it is, and what is left.)"
    }

    static func fixYourself(review: String) -> String {
        "(App: The user wants you to fix the blocking issues you found yourself:\n\(review)\n\nFix them, then say what you changed.)"
    }

    static func openDiscussion(with other: BotEngine, limit: Int) -> String {
        "(App: The user asked both heads of this bot. You and \(other.displayName) discuss it first (at most \(limit) rounds), then one answer goes to the user. Give your answer, and end your reply with <position agree=\"no\">your position in one line</position>.)"
    }

    static func discussTurn(round: Int, limit: Int, question: String, other: BotEngine, said: String) -> String {
        "(App: Discussion round \(round) of \(limit) about the user's message \"\(question)\". \(other.displayName)'s position:\n\(said)\n\nSay your piece in a few sentences. End your reply with <position agree=\"yes\">…</position> if you agree with it, else <position agree=\"no\">your position in one line</position>.)"
    }

    static func agreed(by head: BotEngine, position: String) -> String {
        "(App: \(head.displayName) agrees with you: \(position)\nGive the user the one answer now, in a few sentences.)"
    }

    static func discussionLimit(other: BotEngine, position: String) -> String {
        "(App: The discussion rounds are used up and \(other.displayName) still disagrees: \(position)\nGive the user the one answer now, your version, and say in a sentence where \(other.displayName) differs.)"
    }

    static let wentWith = "(App: The user went with your answer. If something in it is still to be done, do it now and say what came of it; if not, reply only <no-reply/>.)"

    static func handed(from: BotEngine, task: String, count: Int, limit: Int) -> String {
        "(App: \(from.displayName), this bot's other head, hands you this (hand-off \(count) of \(limit) for the user's latest message):\n\(task)\n\nDo it, then reply with the result; the app gives your reply back to \(from.displayName).)"
    }

    static func handBack(from: BotEngine, reply: String) -> String {
        "(App: \(from.displayName) finished what you handed over. Its reply:\n\(reply)\n\nCarry on from there, and tell the user what came of it.)"
    }
}
