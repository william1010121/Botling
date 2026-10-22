import Foundation

public enum BotModel: String, CaseIterable, Codable, Sendable {
    case haiku, sonnet, opus

    public var displayName: String {
        switch self {
        case .haiku: "Haiku"
        case .sonnet: "Sonnet"
        case .opus: "Opus"
        }
    }
}

/// Which CLI a bot runs on: Claude Code (`claude`) or Codex (`codex app-server`). Both read and
/// write the same .bot/memory.md; switching hands over through it like a model switch.
public enum BotEngine: String, CaseIterable, Codable, Sendable {
    case claude, codex

    public var displayName: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        }
    }
}

/// How hard it thinks: Claude Code's `--effort`. No choice (nil) leaves the model's own default.
/// Its subagents think at the same level unless their definition sets one.
public enum EffortLevel: String, CaseIterable, Codable, Sendable {
    case low, medium, high, xhigh, max

    public var displayName: String {
        switch self {
        case .low: L("Low")
        case .medium: L("Medium")
        case .high: L("High")
        case .xhigh: L("Extra high")
        case .max: L("Max")
        }
    }

    /// Its name in English, for what bots are told (`displayName` is in the app's language).
    public var englishName: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        }
    }
}

public enum BotPhase: Equatable, Sendable {
    /// No process. The row is dimmed; the next message wakes it.
    case asleep
    case awake
    /// Idle for too long: writing memory.md before going to sleep.
    case tidying
    case switching(HandoffStep)
}

/// Switching model = write a handoff into memory.md, stop, start a new session on the new model.
public enum HandoffStep: Int, CaseIterable, Sendable {
    case writing = 1, stopping, starting
}

public struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable {
        case user, bot, divider, error
        /// Work handed over by the main bot; `text` is the instruction.
        case relay
        /// The app says something, or a bot's question is copied here (a group chat). `sourceID`
        /// is the bot it is about (a project's id, or `Workspace.mainBotID`).
        case notice
    }

    public var id: UUID
    public var role: Role
    public var text: String
    public var date: Date
    /// Buttons for a decision the user has to make.
    public var choices: [Choice]?
    /// Which of `choices` the user picked.
    public var chosen: Int?
    /// What the user typed instead of picking one (a component's "Other").
    public var answer: String?
    /// For a notice: the project, and the manager's message it points at.
    public var sourceID: UUID?
    public var sourceMessageID: UUID?
    /// The components the bot asked to draw, with their data, in order. Read them with `shown`.
    public var displays: [ComponentInstance]?
    /// Saved by versions that kept one component a message; read through `shown`.
    var display: ComponentInstance?
    /// Every component in the message, old saved ones too.
    public var shown: [ComponentInstance] { displays ?? display.map { [$0] } ?? [] }

    /// Versions that kept one component a message left the other `<show>` tags in the text:
    /// drawn now as components too. The one kept back then was the first, just before the next.
    var withShowTagsTakenOut: ChatMessage {
        guard role == .bot, displays == nil, text.contains("<show") else { return self }
        let parsed = ReplyParser.parseAll(text)
        guard !parsed.displays.isEmpty else { return self }
        var message = self
        message.text = parsed.body
        message.displays = display.map { [ComponentInstance(name: $0.name, data: $0.data, at: parsed.displays[0].at)] } ?? []
        message.displays! += parsed.displays
        message.display = nil
        return message
    }
    /// Files the user sent with it (copied into the bot's attachments folder).
    public var attachments: [Attachment]?
    /// The message this one replies to, and a short quote of it for showing.
    public var replyTo: UUID?
    public var replyPreview: String?
    /// It asks to let the bot use this tool; answered by the running `claude`, not as a message.
    public var permissionTool: String?
    /// A call auto mode blocked that one of the bot's subagents made, not the bot: that
    /// subagent's id (the Agent call's), so the card says which one asked.
    public var subagentID: String?
    /// What the bot did on the way to this reply (tool calls, subagents), folded above it.
    public var steps: [Step]?
    /// Work its turn left running in the background (commands, subagents): a chip each under it.
    public var backgroundTasks: [BackgroundTask]?
    /// A relay that is a "not right" report: whose reply it was about and the user's own words.
    /// Only for showing it short; `text` is the full report the bot got.
    public var feedback: FeedbackNote?
    /// For a bot's reply: the `claude` session that wrote it, so a fork of it can say more about
    /// that reply later ("Make into component" asks one for a brief). Nil for older replies.
    public var session: UUID?

    public init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        date: Date = Date(),
        choices: [Choice]? = nil,
        sourceID: UUID? = nil,
        sourceMessageID: UUID? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.date = date
        self.choices = choices
        self.sourceID = sourceID
        self.sourceMessageID = sourceMessageID
    }

    /// Asks for a decision that has not been made yet.
    public var isOpenQuestion: Bool {
        choices?.isEmpty == false && chosen == nil && answer == nil
    }
}

/// What a feedback relay is about, to show it as a short card with the chat around it folded.
public struct FeedbackNote: Codable, Equatable, Sendable {
    /// The chat whose reply was flagged.
    public var about: String
    /// What the user said was wrong; empty when they said nothing.
    public var words: String

    public init(about: String, words: String) {
        self.about = about
        self.words = words
    }

    /// Read back from a report's text, for relays saved before the note was kept.
    public static func parse(_ text: String) -> FeedbackNote? {
        let head = "Feedback: the user flagged a reply of "
        let middle = " as not right.\nWhat is wrong, in their words: "
        let tail = "\n\nThe chat up to that reply, oldest first:"
        guard text.hasPrefix(head),
              let said = text.range(of: middle),
              let chat = text.range(of: tail, range: said.upperBound..<text.endIndex) else { return nil }
        let about = String(text[text.index(text.startIndex, offsetBy: head.count)..<said.lowerBound])
        let words = String(text[said.upperBound..<chat.lowerBound])
        return FeedbackNote(about: about, words: words == noWords ? "" : words)
    }

    /// What the report says when the user wrote nothing.
    static let noWords = "(they did not say)"
}

/// A file sent along with a message.
public struct Attachment: Codable, Equatable, Hashable, Sendable {
    /// How a message lists the files with it for the bot: "(Attachments:\n- path …)".
    static let listLead = "(Attachments:\n"
    static func list(_ attachments: [Attachment]) -> String {
        listLead + attachments.map { "- " + $0.url.path }.joined(separator: "\n") + ")"
    }

    public enum Kind: String, Codable, Sendable {
        case image, video, file
    }

    public var url: URL
    public var kind: Kind

    public init(url: URL) {
        self.url = url
        kind = Self.kind(of: url)
    }

    public var name: String { url.lastPathComponent }

    public static func kind(of url: URL) -> Kind {
        switch url.pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp": .image
        case "mp4", "mov", "m4v", "webm": .video
        default: .file
        }
    }

    /// Image types Claude reads directly, by file extension.
    var mediaType: String? {
        switch url.pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        default: nil
        }
    }
}

public struct Choice: Codable, Equatable, Sendable {
    /// What a button on a tool question does. The label is only what it says.
    public enum Action: String, Codable, Sendable {
        case allowOnce, alwaysAllow, deny
    }

    public var label: String
    /// What picking it costs, in a few words.
    public var detail: String?
    public var recommended: Bool
    /// Set on a tool question's buttons; nil on a question the bot asked.
    public var action: Action?

    public init(label: String, detail: String? = nil, recommended: Bool = false, action: Action? = nil) {
        self.label = label
        self.detail = detail
        self.recommended = recommended
        self.action = action
    }
}

/// The faces bots wear: coloured shapes with big eyes (the app draws each). `BotProfile.avatar`
/// and a project's `avatar` hold one's raw value.
public enum AvatarShape: String, CaseIterable, Codable, Sendable {
    case circle, star, square, triangle, diamond, clover, heart, hexagon, drop, pentagon
    case cloud, octagon, moon, pill, ghost, burst

    /// The main bot's.
    public static let main = AvatarShape.circle
    /// Maintainer's.
    public static let maintainer = AvatarShape.diamond
    /// Shapes handed out to new projects, in order: all but the main bot's.
    public static let handedOut: [AvatarShape] = [.square, .triangle, .hexagon, .star, .diamond, .clover, .heart, .drop,
                                                  .pentagon, .cloud, .octagon, .moon, .pill, .ghost, .burst]
}

/// Who a bot is and where it works.
public struct BotProfile: Equatable, Sendable {
    public enum Role: Equatable, Sendable {
        /// The user's front desk: reads managers' memory, hands work to them.
        case main
        /// Lives in one project folder and does the work there.
        case manager
    }

    public var name: String
    public var role: Role
    /// An `AvatarShape` raw value.
    public var avatar: String
    public var workingDirectory: URL
    /// memory.md, relative to `workingDirectory`.
    public var memoryPath: String
    public var tools: [String]
    /// More of its system prompt, for a manager with a special job (Maintainer).
    public var instructions: String?
    /// A bot of its own rather than a project's manager (a morning news bot): what it is for.
    public var job: String?
    /// Tools it does not get at all, not even by asking.
    public var disallowedTools: [String] = []
    /// It reads and writes memory.md (wakes reading it, tidies it before sleeping). Without it
    /// every turn starts fresh.
    public var keepsMemory = true
    /// What its chat offers besides messages; the views ask this rather than which bot it is.
    public var capabilities = Capabilities()

    /// What a bot's chat offers besides messages.
    public struct Capabilities: Equatable, Sendable {
        /// A Board and pinned components.
        public var board = true
        /// Making a component out of one of its replies.
        public var specs = true
        /// A settings panel of its own (model, effort, …).
        public var settings = true

        public init(board: Bool = true, specs: Bool = true, settings: Bool = true) {
            self.board = board
            self.specs = specs
            self.settings = settings
        }
    }

    public init(name: String, role: Role, avatar: String, workingDirectory: URL, memoryPath: String, tools: [String], instructions: String? = nil, job: String? = nil) {
        self.name = name
        self.role = role
        self.avatar = avatar
        self.workingDirectory = workingDirectory
        self.memoryPath = memoryPath
        self.tools = tools
        self.instructions = instructions
        self.job = job
    }

    /// A bot of its own, not a project's manager.
    public var isStandalone: Bool { job != nil }

    public var memoryURL: URL { workingDirectory.appending(path: memoryPath) }

    /// Where files the user sends it are kept: inside its own folder, so it can read them later.
    public var attachmentsURL: URL {
        workingDirectory.appending(path: role == .main ? "attachments" : ".bot/attachments")
    }

    /// Its routines.cron, relative to `workingDirectory`.
    public var routinesPath: String { role == .main ? "routines.cron" : ".bot/routines.cron" }
    public var routinesURL: URL { workingDirectory.appending(path: routinesPath) }

    /// The whole chat, one markdown file a month, for the bot to search when it needs something
    /// older than the lines a wake-up brings along.
    public var archiveURL: URL {
        workingDirectory.appending(path: role == .main ? "archive" : ".bot/archive")
    }

    /// Where its result pages go: next to its memory.
    public var artifactsURL: URL {
        workingDirectory.appending(path: role == .main ? "artifacts" : ".bot/artifacts")
    }

    /// Every bot has the same tools; what differs is where it sits and what its job is. These
    /// it uses without asking; anything else it asks you for first.
    /// Artifact publishes results to claude.ai (private by default; see `ResultPublishing`).
    public static let toolbox = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "Task", "SendMessage", ResultPublishing.tool]

    /// The main bot asks before each command: its folder is no project to build or test in.
    public static func main(home: URL) -> BotProfile {
        BotProfile(name: "Main bot", role: .main, avatar: AvatarShape.main.rawValue, workingDirectory: home, memoryPath: "memory.md", tools: toolbox)
    }

    /// A manager keeps its notes in `<project>/.bot/` and runs commands in its project freely.
    public static func manager(name: String, avatar: String, folder: URL) -> BotProfile {
        BotProfile(
            name: name,
            role: .manager,
            avatar: avatar,
            workingDirectory: folder,
            memoryPath: ".bot/memory.md",
            tools: toolbox + ["Bash"]
        )
    }

    /// A bot of its own: it lives in its own folder under `~/.claudecodebot/bots/` and works like
    /// a manager (memory, inbox, routines in `.bot/`). Its folder is no project, so it asks
    /// before each command.
    public static func standalone(name: String, avatar: String, folder: URL, job: String) -> BotProfile {
        BotProfile(
            name: name,
            role: .manager,
            avatar: avatar,
            workingDirectory: folder,
            memoryPath: ".bot/memory.md",
            tools: toolbox,
            job: job
        )
    }

    /// Maintainer: the manager of the plugin library.
    public static func maintainer(folder: URL, instructions: String) -> BotProfile {
        BotProfile(
            name: "Maintainer",
            role: .manager,
            avatar: AvatarShape.maintainer.rawValue,
            workingDirectory: folder,
            memoryPath: ".bot/memory.md",
            tools: toolbox + ["Bash"],
            instructions: instructions
        )
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
