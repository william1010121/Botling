import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct MarkdownTests {
    @Test func blocks() {
        let text = """
        # Today
        **NotchDo** is 70% done.

        - Right panel
        - Scheduling
        1. Error states first
        2. Then scheduling
        > Stuck on succulents
        ```
        swift build
        ```
        | Project | Status |
        |---|---|
        | blog | Waiting on you |
        ---
        Look at this:![Panel screenshot](file:///tmp/panel.png) and the video ![Demo](file:///tmp/demo.mp4)
        """
        #expect(MarkdownBlock.parse(text) == [
            .heading(level: 1, text: "Today"),
            .paragraph("**NotchDo** is 70% done."),
            .bullets(["Right panel", "Scheduling"]),
            .numbered(["Error states first", "Then scheduling"]),
            .quote("Stuck on succulents"),
            .code("swift build"),
            .table(header: ["Project", "Status"], rows: [["blog", "Waiting on you"]]),
            .rule,
            .paragraph("Look at this: and the video"),
            .media(alt: "Panel screenshot", url: URL(string: "file:///tmp/panel.png")!),
            .media(alt: "Demo", url: URL(string: "file:///tmp/demo.mp4")!)
        ])
    }

    @Test func attachmentKinds() {
        #expect(Attachment(url: URL(filePath: "/a/b.PNG")).kind == .image)
        #expect(Attachment(url: URL(filePath: "/a/b.mov")).kind == .video)
        #expect(Attachment(url: URL(filePath: "/a/b.pdf")).kind == .file)
    }

    @Test func toolCallsBecomeTraceLines() {
        let line = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/x/choices/template.html"}}]}}"#
        #expect(StreamEvent.events(in: line) == [.trace(.toolUse(id: "t1", tool: "Edit", title: "Edit template.html", detail: "/x/choices/template.html", parent: nil))])
        let bash = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"swift build\nswift test"}}]}}"#
        #expect(StreamEvent.events(in: bash) == [.trace(.toolUse(id: "t2", tool: "Bash", title: "Run swift build", detail: "swift build\nswift test", parent: nil))])
    }
}

/// Records images too, unlike the plain fake.
final class ImageAgent: AgentProcess, @unchecked Sendable {
    let events: AsyncStream<AgentEvent>
    private let continuation: AsyncStream<AgentEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [(String, [ClaudeCodeBotCore.Attachment])] = []

    init() {
        (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
    }

    var sent: [(String, [ClaudeCodeBotCore.Attachment])] { lock.withLock { _sent } }

    func send(_ text: String) { send(text, images: []) }
    func send(_ text: String, images: [ClaudeCodeBotCore.Attachment]) {
        lock.withLock { _sent.append((text, images)) }
        continuation.yield(.reply("I see it.", isError: false))
    }
    func finish() { continuation.finish() }
    func stop() { continuation.finish() }
}

@MainActor
struct AttachmentAndReplyTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-chat-\(UUID().uuidString)")

    @Test func handedOverWorkCanCarryPictures() async throws {
        let agent = ImageAgent()
        let home = root.appending(path: "maintainer")
        let bot = Bot(profile: .manager(name: "Maintainer", avatar: "diamond", folder: home), launcher: { _ in agent })
        let shot = root.appending(path: "in/choices-screenshot.png")
        try FileManager.default.createDirectory(at: shot.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: shot)

        bot.relay("The user's request for the component \"choices\": see the attached picture", files: [shot])
        await eventually { bot.messages.last?.role == .bot }
        let relay = try #require(bot.messages.first)
        #expect(relay.role == .relay)
        let kept = try #require(relay.attachments?.first)
        #expect(kept.url.path.hasPrefix(home.appending(path: ".bot/attachments").path))
        let (text, images) = try #require(agent.sent.first)
        #expect(text.contains("(Attachments:\n- \(kept.url.path))"))
        #expect(images.map(\.url) == [kept.url])
    }

    @Test func filesAreKeptInTheBotsFolderAndImagesGoToClaude() async throws {
        let agent = ImageAgent()
        let home = root.appending(path: "main")
        let bot = Bot(profile: .main(home: home), launcher: { _ in agent })
        let picture = root.appending(path: "in/screen.png")
        let notes = root.appending(path: "in/notes.pdf")
        try FileManager.default.createDirectory(at: picture.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: picture)
        try Data("pdf".utf8).write(to: notes)

        bot.send("What is this?", files: [picture, notes], replyingTo: nil)
        await eventually { bot.messages.last?.role == .bot }

        let message = try #require(bot.messages.first)
        let kept = try #require(message.attachments)
        #expect(kept.count == 2)
        #expect(kept.allSatisfy { $0.url.path.hasPrefix(home.appending(path: "attachments").path) })
        #expect(kept.allSatisfy { FileManager.default.fileExists(atPath: $0.url.path) })
        let (text, images) = try #require(agent.sent.first)
        #expect(text.contains("What is this?"))
        #expect(text.contains(kept[1].url.path))
        #expect(images.map(\.url) == [kept[0].url])
    }

    @Test func aReplyQuotesTheLineItAnswers() async throws {
        let agent = ImageAgent()
        let bot = Bot(profile: .main(home: root.appending(path: "main2")), launcher: { _ in agent })
        bot.send("First line")
        await eventually { bot.messages.count == 2 }
        let answer = try #require(bot.messages.last)

        bot.send("What does this mean?", files: [], replyingTo: answer.id)
        await eventually { bot.messages.count == 4 }

        let reply = bot.messages[2]
        #expect(reply.replyTo == answer.id)
        #expect(reply.replyPreview == "I see it.")
        #expect(agent.sent.last?.0.hasPrefix("(Replying to what you said earlier: \"I see it.\")") == true)
    }

    @Test func aPhotoAloneCanBeSent() async throws {
        let agent = ImageAgent()
        let bot = Bot(profile: .main(home: root.appending(path: "main3")), launcher: { _ in agent })
        let picture = root.appending(path: "in2/a.jpg")
        try FileManager.default.createDirectory(at: picture.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0xFF, 0xD8]).write(to: picture)
        bot.send("", files: [picture], replyingTo: nil)
        await eventually { bot.messages.count == 2 }
        #expect(bot.messages.first?.text == "")
        #expect(agent.sent.first?.1.count == 1)
    }
}
