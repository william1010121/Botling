import Foundation
import Testing
@testable import DeckCore

struct MarkdownTests {
    @Test func blocks() {
        let text = """
        # 今天
        **NotchDo** 做到 7 成。

        - 右側面板
        - 排程
        1. 先做錯誤狀態
        2. 再接排程
        > 卡在多肉植物
        ```
        swift build
        ```
        | 專案 | 狀態 |
        |---|---|
        | blog | 等你 |
        ---
        看這張：![面板截圖](file:///tmp/panel.png) 和影片 ![示範](file:///tmp/demo.mp4)
        """
        #expect(MarkdownBlock.parse(text) == [
            .heading(level: 1, text: "今天"),
            .paragraph("**NotchDo** 做到 7 成。"),
            .bullets(["右側面板", "排程"]),
            .numbered(["先做錯誤狀態", "再接排程"]),
            .quote("卡在多肉植物"),
            .code("swift build"),
            .table(header: ["專案", "狀態"], rows: [["blog", "等你"]]),
            .rule,
            .paragraph("看這張： 和影片"),
            .media(alt: "面板截圖", url: URL(string: "file:///tmp/panel.png")!),
            .media(alt: "示範", url: URL(string: "file:///tmp/demo.mp4")!)
        ])
    }

    @Test func attachmentKinds() {
        #expect(Attachment(url: URL(filePath: "/a/b.PNG")).kind == .image)
        #expect(Attachment(url: URL(filePath: "/a/b.mov")).kind == .video)
        #expect(Attachment(url: URL(filePath: "/a/b.pdf")).kind == .file)
    }

    @Test func toolCallsBecomeActivityLines() {
        let line = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/x/choices/template.html"}}]}}"#
        #expect(StreamEvent.events(in: line) == [.activity("改 template.html")])
        let bash = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"swift build\nswift test"}}]}}"#
        #expect(StreamEvent.events(in: bash) == [.activity("執行 swift build")])
    }
}

/// Records images too, unlike the plain fake.
final class ImageAgent: AgentProcess, @unchecked Sendable {
    let events: AsyncStream<AgentEvent>
    private let continuation: AsyncStream<AgentEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [(String, [DeckCore.Attachment])] = []

    init() {
        (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
    }

    var sent: [(String, [DeckCore.Attachment])] { lock.withLock { _sent } }

    func send(_ text: String) { send(text, images: []) }
    func send(_ text: String, images: [DeckCore.Attachment]) {
        lock.withLock { _sent.append((text, images)) }
        continuation.yield(.reply("看到了。", isError: false))
    }
    func finish() { continuation.finish() }
    func stop() { continuation.finish() }
}

@MainActor
struct AttachmentAndReplyTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-chat-\(UUID().uuidString)")

    @Test func filesAreKeptInTheBotsFolderAndImagesGoToClaude() async throws {
        let agent = ImageAgent()
        let home = root.appending(path: "main")
        let bot = Bot(profile: .main(home: home), launcher: { _ in agent })
        let picture = root.appending(path: "in/screen.png")
        let notes = root.appending(path: "in/notes.pdf")
        try FileManager.default.createDirectory(at: picture.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: picture)
        try Data("pdf".utf8).write(to: notes)

        bot.send("這是什麼？", files: [picture, notes], replyingTo: nil)
        await eventually { bot.messages.last?.role == .bot }

        let message = try #require(bot.messages.first)
        let kept = try #require(message.attachments)
        #expect(kept.count == 2)
        #expect(kept.allSatisfy { $0.url.path.hasPrefix(home.appending(path: "attachments").path) })
        #expect(kept.allSatisfy { FileManager.default.fileExists(atPath: $0.url.path) })
        let (text, images) = try #require(agent.sent.first)
        #expect(text.contains("這是什麼？"))
        #expect(text.contains(kept[1].url.path))
        #expect(images.map(\.url) == [kept[0].url])
    }

    @Test func aReplyQuotesTheLineItAnswers() async throws {
        let agent = ImageAgent()
        let bot = Bot(profile: .main(home: root.appending(path: "main2")), launcher: { _ in agent })
        bot.send("第一句")
        await eventually { bot.messages.count == 2 }
        let answer = try #require(bot.messages.last)

        bot.send("這句是什麼意思？", files: [], replyingTo: answer.id)
        await eventually { bot.messages.count == 4 }

        let reply = bot.messages[2]
        #expect(reply.replyTo == answer.id)
        #expect(reply.replyPreview == "看到了。")
        #expect(agent.sent.last?.0.hasPrefix("（回覆你之前說的：「看到了。」）") == true)
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
