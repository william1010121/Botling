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
        /// In the main bot's chat: a project manager reported something. `sourceID` is the project.
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
    /// What the user typed instead of picking one (a component's 「其他」).
    public var answer: String?
    /// For a notice: the project, and the manager's message it points at.
    public var sourceID: UUID?
    public var sourceMessageID: UUID?
    /// A component the bot asked to draw with its data.
    public var display: ComponentInstance?
    /// Files the user sent with it (copied into the bot's attachments folder).
    public var attachments: [Attachment]?
    /// The message this one replies to, and a short quote of it for showing.
    public var replyTo: UUID?
    public var replyPreview: String?

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

/// A file sent along with a message.
public struct Attachment: Codable, Equatable, Hashable, Sendable {
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
    public var label: String
    /// What picking it costs, in a few words.
    public var detail: String?
    public var recommended: Bool

    public init(label: String, detail: String? = nil, recommended: Bool = false) {
        self.label = label
        self.detail = detail
        self.recommended = recommended
    }
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
    /// An `AvatarKind` raw value.
    public var avatar: String
    public var workingDirectory: URL
    /// memory.md, relative to `workingDirectory`.
    public var memoryPath: String
    public var tools: [String]

    public init(name: String, role: Role, avatar: String, workingDirectory: URL, memoryPath: String, tools: [String]) {
        self.name = name
        self.role = role
        self.avatar = avatar
        self.workingDirectory = workingDirectory
        self.memoryPath = memoryPath
        self.tools = tools
    }

    public var memoryURL: URL { workingDirectory.appending(path: memoryPath) }

    /// Where files the user sends it are kept: inside its own folder, so it can read them later.
    public var attachmentsURL: URL {
        workingDirectory.appending(path: role == .main ? "attachments" : ".bot/attachments")
    }

    /// Its routines.cron, relative to `workingDirectory`.
    public var routinesPath: String { role == .main ? "routines.cron" : ".bot/routines.cron" }
    public var routinesURL: URL { workingDirectory.appending(path: routinesPath) }

    /// Where its result pages go: next to its memory.
    public var artifactsURL: URL {
        workingDirectory.appending(path: role == .main ? "artifacts" : ".bot/artifacts")
    }

    public static func main(home: URL) -> BotProfile {
        BotProfile(name: "主 bot", role: .main, avatar: "circle", workingDirectory: home, memoryPath: "memory.md", tools: ["Read", "Write", "Edit"])
    }

    /// A manager keeps its notes in `<project>/.bot/` and may use the usual coding tools.
    public static func manager(name: String, avatar: String, folder: URL) -> BotProfile {
        BotProfile(
            name: name,
            role: .manager,
            avatar: avatar,
            workingDirectory: folder,
            memoryPath: ".bot/memory.md",
            tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]
        )
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
