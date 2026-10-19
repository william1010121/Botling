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
        var display: Display?
        var attachments: [File]?
        var replyTo: String?
        var replyPreview: String?
        var openable: Bool
    }

    public struct Display: Encodable, Equatable {
        var name: String
        var data: String
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

    /// A file waiting in the composer.
    public struct Pending: Equatable, Sendable {
        public var id: UUID
        public var url: URL

        public init(id: UUID = UUID(), url: URL) {
            self.id = id
            self.url = url
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
        avatar: (_ projectID: UUID?) -> String
    ) -> ChatPayload {
        let own = avatar(nil)
        let main = bot.profile.role == .main ? own : nil
        let messages = bot.messages.enumerated().map { index, message -> Message in
            let face: String? = switch message.role {
            case .bot: own
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
                display: message.display.map { Display(name: $0.name, data: $0.data) },
                attachments: message.attachments?.map(file),
                replyTo: message.replyTo?.uuidString,
                replyPreview: message.replyPreview,
                openable: message.role == .notice && message.sourceID != nil
            )
        }
        let reply = replyingTo.flatMap { id in bot.messages.first { $0.id == id } }.map {
            Reply(id: $0.id.uuidString, who: $0.role == .user ? "Reply to yourself" : "Reply to \(bot.name)", preview: Bot.preview(of: $0))
        }
        var components: [String: Component] = [:]
        for name in library?.names ?? [] {
            guard let library, let template = library.template(name) else { continue }
            components[name] = Component(
                template: template,
                version: library.versions[name, default: 0],
                working: library.working[name] != nil,
                updated: library.updated.contains(name),
                hasPrevious: library.hasPrevious(name)
            )
        }
        return ChatPayload(
            botID: bot.id.uuidString,
            botName: bot.name,
            messages: messages,
            working: bot.isWorking,
            avatar: own,
            placeholder: bot.profile.role == .main ? "Make a wish, or ask how things are going…" : "Message \(bot.name)…",
            replyingTo: reply,
            pendingFiles: pending.map { pending in
                var entry = file(Attachment(url: pending.url))
                entry.id = pending.id.uuidString
                return entry
            },
            components: components
        )
    }

    public func json() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
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
