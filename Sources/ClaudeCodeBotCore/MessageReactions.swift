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

/// Full snapshots supersede earlier feedback, including empty arrays after removal. All touched
/// retained messages are included even outside recent history; recent untouched lines supply targets.
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
}
