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

/// A bot's heads: which engines it has, and who new messages go to. Kept in bot.json; a bot
/// that never had two keeps one, its `engine`.
public struct HeadsSettings: Codable, Equatable, Sendable {
    /// The engines in this bot, Claude first. Never empty.
    public var engines: [BotEngine]
    /// Where a new message goes unless the user picks another for it.
    public var answerWith: AnswerTarget

    public init(engines: [BotEngine], answerWith: AnswerTarget) {
        let kept = BotEngine.allCases.filter(engines.contains)
        self.engines = kept.isEmpty ? [.claude] : kept
        self.answerWith = answerWith
        self.answerWith = fitted(answerWith)
    }

    private enum CodingKeys: String, CodingKey { case engines, answerWith }

    /// Read as text, so a value this build does not know leaves the rest of bot.json readable.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let engines = (try? container.decode([String].self, forKey: .engines))?.compactMap(BotEngine.init(rawValue:)) ?? []
        let target = (try? container.decode(String.self, forKey: .answerWith)).flatMap(AnswerTarget.init(rawValue:))
        self.init(engines: engines, answerWith: target ?? AnswerTarget(engines.first ?? .claude))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(engines.map(\.rawValue), forKey: .engines)
        try container.encode(answerWith.rawValue, forKey: .answerWith)
    }

    public static func single(_ engine: BotEngine) -> HeadsSettings {
        HeadsSettings(engines: [engine], answerWith: AnswerTarget(engine))
    }

    public var hasTwo: Bool { engines.count > 1 }

    /// What can be picked: each head, and both once there are two.
    public var targets: [AnswerTarget] {
        engines.map(AnswerTarget.init) + (hasTwo ? [.both] : [])
    }

    /// `target`, or the nearest one this bot has (both needs two heads).
    public func fitted(_ target: AnswerTarget) -> AnswerTarget {
        if targets.contains(target) { return target }
        return AnswerTarget(engines[0])
    }

    /// The heads a message to `target` goes to, in the order they answer.
    public func heads(for target: AnswerTarget) -> [BotEngine] {
        let target = fitted(target)
        return target.engine.map { [$0] } ?? engines
    }
}
