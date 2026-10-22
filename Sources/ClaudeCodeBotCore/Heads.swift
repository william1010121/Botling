import Foundation

/// Who answers a message in a bot with two heads (Claude and Codex): one of them, or both.
public enum AnswerTarget: String, CaseIterable, Codable, Sendable {
    case claude, codex, both

    public init(_ engine: BotEngine) {
        self = engine == .claude ? .claude : .codex
    }

    /// The head it names; nil for both.
    public var engine: BotEngine? {
        switch self {
        case .claude: .claude
        case .codex: .codex
        case .both: nil
        }
    }

    public var displayName: String {
        engine?.displayName ?? L("Both")
    }
}

/// A bot's heads: which engines it has, and who new messages go to (both, unless one is named).
/// Kept in bot.json; a bot that never had two keeps one, its `engine`.
public struct HeadsSettings: Codable, Equatable, Sendable {
    /// The engines in this bot, Claude first. Never empty.
    public var engines: [BotEngine]
    /// Where a new message goes unless the user picks another for it.
    public var answerWith: AnswerTarget
    /// How many rounds the loops between the heads may take, and what happens at the limit.
    public var limits = RoundLimits()
    /// The heads may hand work to each other (`<handoff to="…">`).
    public var handoffs = true
    /// The Codex model (`model/list`'s id); nil: Codex's own default.
    public var codexModel: String?

    public init(engines: [BotEngine], answerWith: AnswerTarget = .both, limits: RoundLimits = RoundLimits(), handoffs: Bool = true) {
        let kept = BotEngine.allCases.filter(engines.contains)
        self.engines = kept.isEmpty ? [.claude] : kept
        self.answerWith = answerWith
        self.limits = limits
        self.handoffs = handoffs
        self.answerWith = fitted(answerWith)
    }

    private enum CodingKeys: String, CodingKey { case engines, answerWith, limits, handoffs, codexModel }

    /// Read as text, so a value this build does not know leaves the rest of bot.json readable.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let engines = (try? container.decode([String].self, forKey: .engines))?.compactMap(BotEngine.init(rawValue:)) ?? []
        let target = (try? container.decode(String.self, forKey: .answerWith)).flatMap(AnswerTarget.init(rawValue:))
        self.init(
            engines: engines,
            answerWith: target ?? .both,
            limits: (try? container.decode(RoundLimits.self, forKey: .limits)) ?? RoundLimits(),
            handoffs: (try? container.decode(Bool.self, forKey: .handoffs)) ?? true
        )
        codexModel = try? container.decode(String.self, forKey: .codexModel)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(engines.map(\.rawValue), forKey: .engines)
        try container.encode(answerWith.rawValue, forKey: .answerWith)
        try container.encode(limits, forKey: .limits)
        try container.encode(handoffs, forKey: .handoffs)
        try container.encodeIfPresent(codexModel, forKey: .codexModel)
    }

    public static func single(_ engine: BotEngine) -> HeadsSettings {
        HeadsSettings(engines: [engine], answerWith: AnswerTarget(engine))
    }

    public var hasTwo: Bool { engines.count > 1 }

    /// What can be picked: both (the usual), or one of them by name.
    public var targets: [AnswerTarget] {
        (hasTwo ? [.both] : []) + engines.map(AnswerTarget.init)
    }

    /// `target`, or the nearest one this bot has (both needs two heads).
    public func fitted(_ target: AnswerTarget) -> AnswerTarget {
        if targets.contains(target) { return target }
        return targets[0]
    }

    /// The heads a message to `target` goes to, in the order they answer.
    public func heads(for target: AnswerTarget) -> [BotEngine] {
        let target = fitted(target)
        return target.engine.map { [$0] } ?? engines
    }
}

/// How far hand-offs between the heads go, per user message. The app counts them; the head
/// handing work says what kind it is. The defaults are the plan's: 3 discussion rounds, 2
/// review rounds, 6 hand-offs in all.
public struct RoundLimits: Codable, Equatable, Sendable {
    public enum AtLimit: String, Codable, CaseIterable, Sendable {
        /// Stop with a card that shows both sides, for you to pick.
        case ask
        /// Take the doer's latest version and finish.
        case useDoers
    }

    public var discussion = 3
    public var review = 2
    public var handoffs = 6
    public var atLimit = AtLimit.ask

    /// The steppers' range in settings.
    public static let range = 1...10

    public init(discussion: Int = 3, review: Int = 2, handoffs: Int = 6, atLimit: AtLimit = .ask) {
        self.discussion = discussion
        self.review = review
        self.handoffs = handoffs
        self.atLimit = atLimit
    }

    private enum CodingKeys: String, CodingKey { case discussion, review, handoffs, atLimit }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = RoundLimits()
        func count(_ key: CodingKeys, _ value: Int) -> Int {
            ((try? container.decode(Int.self, forKey: key)) ?? value).clamped(to: Self.range)
        }
        self.init(
            discussion: count(.discussion, fallback.discussion),
            review: count(.review, fallback.review),
            handoffs: count(.handoffs, fallback.handoffs),
            atLimit: (try? container.decode(String.self, forKey: .atLimit)).flatMap(AtLimit.init(rawValue:)) ?? .ask
        )
    }
}

extension Int {
    func clamped(to range: ClosedRange<Int>) -> Int { Swift.min(Swift.max(self, range.lowerBound), range.upperBound) }
}
