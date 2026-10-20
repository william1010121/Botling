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
        /// Who said it, above the bubble (a group chat).
        var speaker: String?
        /// What the bot did on the way to this reply.
        var steps: [StepView]?
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
    /// Names you can @ (a group chat), for completing them as you type.
    var mentions: [String]
    /// What it is doing right now, while it works.
    var live: [StepView]
    /// Set while you look at one of its subagents instead of the chat.
    var subagent: SubagentHeader?
    /// Developer mode: replies can be flagged as not right.
    var feedback = false

    /// What a group chat adds: who is typing, and names for who said each line.
    public struct GroupView {
        public var typing: UUID?
        public var speaker: (UUID) -> String?
        public var names: [String]

        public init(typing: UUID?, names: [String] = [], speaker: @escaping (UUID) -> String?) {
            self.typing = typing
            self.names = names
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
        feedback: Bool = false,
        avatar: (_ projectID: UUID?) -> String
    ) -> ChatPayload {
        let own = avatar(nil)
        let main = bot.profile.role == .main ? own : nil
        let messages = bot.messages.enumerated().map { index, message -> Message in
            let face: String? = switch message.role {
            // In a group chat each line has the face of the bot that said it.
            case .bot: group != nil && message.sourceID != nil ? avatar(message.sourceID) : own
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
                openable: message.role == .notice && message.sourceID != nil,
                speaker: message.role == .bot ? message.sourceID.flatMap { id in group.map { $0.speaker(id) ?? "A removed bot" } } : nil,
                steps: message.steps.map { $0.map { stepView($0, in: bot) } }
            )
        }
        let reply = replyingTo.flatMap { id in bot.messages.first { $0.id == id } }.map {
            Reply(
                id: $0.id.uuidString,
                who: $0.role == .user ? "Reply to yourself" : "Reply to \($0.sourceID.flatMap { id in group?.speaker(id) } ?? bot.name)",
                preview: Bot.preview(of: $0)
            )
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
            working: group.map { $0.typing != nil } ?? bot.isWorking,
            avatar: group?.typing.map { avatar($0) } ?? own,
            placeholder: group != nil ? "Message everyone, or @name one bot…"
                : bot.profile.role == .main ? "Make a wish, or ask how things are going…" : "Message \(bot.name)…",
            replyingTo: reply,
            pendingFiles: pending.map { pending in
                var entry = file(Attachment(url: pending.url))
                entry.id = pending.id.uuidString
                return entry
            },
            components: components,
            mentions: group?.names ?? [],
            live: group == nil && bot.isWorking ? bot.liveSteps.map { stepView($0, in: bot) } : [],
            subagent: nil,
            feedback: feedback
        )
    }

    /// A subagent's conversation, the way Claude Code shows one: its task as your line, then what
    /// it said, each with the tool calls before it folded above; the ones still going show live.
    @MainActor
    public static func make(subagent: Subagent, of bot: Bot, components library: ComponentLibrary?, avatar: String) -> ChatPayload {
        var messages: [Message] = []
        func message(_ id: String, role: String, text: String, steps: [Step]) -> Message {
            Message(
                id: "\(subagent.id)-\(id)", role: role, text: text, stamp: nil, avatar: role == "bot" ? avatar : nil,
                choices: nil, chosen: nil, answer: nil, open: false, display: nil, attachments: nil,
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
            count: subagent?.toolCount
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
