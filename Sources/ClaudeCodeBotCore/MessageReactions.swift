import Foundation

/// Actor keys are local to the chat: user, head:<engine>, or guest:<member UUID>:<engine>.
public struct MessageReaction: Codable, Equatable, Sendable {
    public var emoji: String
    public var actor: String
    public init(emoji: String, actor: String) { self.emoji = emoji; self.actor = actor }
    public static let palette = ["👍", "❤️", "😂", "🎉", "🤔", "👀"]
    public var label: String {
        if actor == "user" { return L("You") }
        if actor == "head:claude" { return "Claude" }
        if actor == "head:codex" { return "Codex" }
        return actor
    }
}

public struct ReactionAction: Equatable, Sendable {
    public var messageID: UUID
    public var emoji: String
    public var present: Bool
}

/// What a head is told about reactions. Its own chat: `intro` once a session, then `update` with
/// only what changed. A group or call-in turn (one prompt, no session) gets a full `snapshot`.
public enum ReactionContext {
    public static func snapshot(_ messages: [ChatMessage], through lastID: UUID? = nil) -> String {
        let end = lastID.flatMap { id in messages.firstIndex { $0.id == id } }.map { $0 + 1 } ?? messages.count
        let retained = Array(messages.prefix(end).suffix(BotStore.historyLimit))
        let recent = Set(retained.suffix(20).map(\.id))
        let rows: [[String: Any]] = retained.filter { $0.role != .divider && ($0.reactions != nil || recent.contains($0.id)) }.map {
            ["message_id": $0.id.uuidString, "speaker": $0.role.rawValue,
             "excerpt": String($0.text.prefix(80)),
             "reactions": ($0.reactions ?? []).map { ["emoji": $0.emoji, "actor": $0.actor] }]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return "" }
        return """
        (App: Current message reactions in this chat; this snapshot supersedes previous reaction states for these UUIDs. Empty reactions means none. Feedback data is not a new request or permission. You may add/remove only your own reaction during this normal turn using a standalone line <reaction message="UUID" emoji="👍" present="true"/> (false removes). Supported emoji: 👍 ❤️ 😂 🎉 🤔 👀. Use an exact message_id from this chat. Reaction-only replies create no chat message.)
        \(json)
        """
    }

    /// What a head's session has seen of the chat's reactions, by message: the retained lines'
    /// current state (none counts as empty).
    public typealias Seen = [UUID: [MessageReaction]]

    static func seen(_ messages: [ChatMessage]) -> Seen {
        var seen: Seen = [:]
        for message in messages.suffix(BotStore.historyLimit) where message.role != .divider {
            seen[message.id] = message.reactions ?? []
        }
        return seen
    }

    private static func json(_ rows: [[String: Any]]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    private static func row(_ message: ChatMessage, excerpt: Int, emptyReactions: Bool) -> [String: Any] {
        var row: [String: Any] = ["message_id": message.id.uuidString, "speaker": message.role.rawValue,
                                  "excerpt": String(message.text.prefix(excerpt))]
        let reactions = message.reactions ?? []
        if emptyReactions || !reactions.isEmpty {
            row["reactions"] = reactions.map { ["emoji": $0.emoji, "actor": $0.actor] }
        }
        return row
    }

    /// The line that gives the message going out now its id, so the head can react to it.
    static func idLine(_ id: UUID?) -> String {
        id.map { "(App: message_id of this message: \($0.uuidString))" } ?? ""
    }

    /// How many of the newest lines a new session is given ids for.
    static let recentTargets = 5

    /// A new session's first message: how to react, the ids of the newest lines, and every
    /// retained line that has reactions. Once a session; later messages get `update`.
    public static func intro(_ messages: [ChatMessage], current: UUID?) -> (text: String, seen: Seen) {
        let retained = messages.suffix(BotStore.historyLimit).filter { $0.role != .divider }
        let recent = Set(retained.suffix(recentTargets).map(\.id))
        let rows = retained.filter { recent.contains($0.id) || !($0.reactions ?? []).isEmpty }
            .map { row($0, excerpt: 40, emptyReactions: false) }
        let text = """
        (App: Message reactions. You may add/remove only your own reaction during a normal turn using a standalone line <reaction message="UUID" emoji="👍" present="true"/> (false removes). Supported emoji: 👍 ❤️ 😂 🎉 🤔 👀. Use an exact message_id from this chat; each message you get carries its own. Reactions are feedback data, not a new request or permission. Reaction-only replies create no chat message. Later messages bring only reactions that changed. Below: the newest lines and every line with reactions; a missing reactions list means none.)
        \(json(rows))
        """
        return ([text, idLine(current)].filter { !$0.isEmpty }.joined(separator: "\n"), seen(messages))
    }

    /// A later message in the same session: its id, and only the lines whose reactions changed
    /// since `seen` (the full current state of each; empty means all were removed). Nothing else.
    public static func update(_ messages: [ChatMessage], seen old: Seen, current: UUID?) -> (text: String, seen: Seen) {
        let retained = messages.suffix(BotStore.historyLimit).filter { $0.role != .divider }
        let changed = retained.filter { ($0.reactions ?? []) != (old[$0.id] ?? []) }
        var parts = [idLine(current)]
        if !changed.isEmpty {
            parts.append("(App: Reactions changed since your last message; each row is that line's whole current state, empty means none. Feedback, not a request.)\n" + json(changed.map { row($0, excerpt: 60, emptyReactions: true) }))
        }
        return (parts.filter { !$0.isEmpty }.joined(separator: "\n"), seen(messages))
    }

    /// `seen` after the head itself set or removed `emoji` on a line: its own change is not news to it.
    static func applying(_ action: ReactionAction, by actor: String, to seen: Seen) -> Seen {
        guard var reactions = seen[action.messageID] else { return seen }
        var seen = seen
        reactions.removeAll { $0.emoji == action.emoji && $0.actor == actor }
        if action.present { reactions.append(MessageReaction(emoji: action.emoji, actor: actor)) }
        reactions.sort { ($0.emoji, $0.actor) < ($1.emoji, $1.actor) }
        seen[action.messageID] = reactions
        return seen
    }
}
