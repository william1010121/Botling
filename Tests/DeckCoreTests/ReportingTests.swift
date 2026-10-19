import Foundation
import Testing
@testable import DeckCore

struct ReplyParserTests {
    @Test func choicesBlockBecomesButtons() {
        let reply = """
        40 篇舊文章沒有封面圖，怎麼處理？
        <choices>
        * 用預設圖補上 | 今天做完
        - 先留白 | 之後再說
        - 每篇生成一張
        </choices>
        """
        let parsed = ReplyParser.parse(reply)
        #expect(parsed.body == "40 篇舊文章沒有封面圖，怎麼處理？")
        #expect(parsed.choices == [
            Choice(label: "用預設圖補上", detail: "今天做完", recommended: true),
            Choice(label: "先留白", detail: "之後再說"),
            Choice(label: "每篇生成一張")
        ])
    }

    @Test func replyWithoutBlockIsUnchanged() {
        let parsed = ReplyParser.parse("做好了。")
        #expect(parsed.body == "做好了。")
        #expect(parsed.choices == nil)
    }

    @Test func oldChatHistoryWithoutChoicesStillLoads() throws {
        let json = #"[{"id":"00000000-0000-0000-0000-000000000001","role":"bot","text":"hi","date":0}]"#
        let messages = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        #expect(messages.first?.choices == nil)
        #expect(messages.first?.isOpenQuestion == false)
    }
}

let question = """
要支援多肉植物嗎？
<choices>
* 支援 | 多 1 天
- 先不要
</choices>
"""

@MainActor
struct ReportingTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-report-\(UUID().uuidString)")

    func setUp(_ fake: FakeLauncher) throws -> (Workspace, Workspace.Project, Bot) {
        let workspace = Workspace(root: root.appending(path: "deck")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        return (workspace, project, try #require(workspace.bot(for: project)))
    }

    @Test func pickingAButtonSendsItsLabelOnce() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.hasSuffix("問我") ? question : "好，照做。" }
        let (workspace, _, manager) = try setUp(fake)

        manager.send("問我")
        await eventually { manager.openQuestion != nil }
        let asked = try #require(manager.openQuestion)
        #expect(asked.text == "要支援多肉植物嗎？")
        #expect(asked.choices?.count == 2)

        #expect(workspace.choose(1, in: asked.id, of: manager))
        #expect(!workspace.choose(0, in: asked.id, of: manager))
        await eventually { manager.messages.last?.text == "好，照做。" }

        #expect(manager.messages.first { $0.id == asked.id }?.chosen == 1)
        #expect(fake.agents[0].sent.last == "先不要")
        #expect(manager.openQuestion == nil)
    }

    @Test func questionGoesUpToTheMainBotAndCanBeAnsweredThere() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.contains("多肉") ? question : "好，照做。" }
        let (workspace, project, manager) = try setUp(fake)
        workspace.select(nil)

        manager.relay("多肉植物要不要支援，請使用者決定")
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice } }

        let notice = try #require(workspace.mainBot.messages.last)
        #expect(notice.role == .notice)
        #expect(notice.text == "garden：要支援多肉植物嗎？")
        #expect(notice.sourceID == project.id)
        #expect(notice.isOpenQuestion)
        #expect(workspace.waiting.map(\.text) == ["要支援多肉植物嗎？"])
        // The main bot was not woken to say it.
        #expect(fake.agents.count == 1)

        #expect(workspace.choose(0, in: notice.id, of: workspace.mainBot))
        await eventually { manager.messages.last?.text == "好，照做。" }

        #expect(fake.agents[0].sent.last == "支援")
        #expect(workspace.mainBot.messages.first { $0.id == notice.id }?.chosen == 0)
        #expect(manager.messages.first { $0.id == notice.sourceMessageID }?.chosen == 0)
        #expect(workspace.waiting.isEmpty)
    }

    @Test func answeringInTheProjectChatSettlesTheNotice() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.contains("多肉") ? question : "好。" }
        let (workspace, project, manager) = try setUp(fake)

        manager.relay("多肉植物要不要支援")
        await eventually { manager.openQuestion != nil }
        workspace.select(project.id)
        let asked = try #require(manager.openQuestion)

        #expect(workspace.choose(1, in: asked.id, of: manager))
        let notice = try #require(workspace.mainBot.messages.first { $0.role == .notice })
        #expect(notice.chosen == 1)
        #expect(!notice.isOpenQuestion)
    }

    @Test func finishedRelayedWorkIsReportedButChatWithTheUserIsNot() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "README 寫好了。" }
        let (workspace, _, manager) = try setUp(fake)

        manager.send("你好")
        await eventually { manager.messages.count == 2 }
        #expect(!workspace.mainBot.messages.contains { $0.role == .notice })

        manager.relay("寫 README")
        await eventually { manager.messages.count == 4 }
        let notices = workspace.mainBot.messages.filter { $0.role == .notice }
        #expect(notices.map(\.text) == ["garden：README 寫好了。"])
        #expect(notices.first?.choices == nil)
        #expect(workspace.mainBot.hasUnread)
    }

    @Test func managersAreToldHowToAskForADecision() {
        let manager = BotPrompts(profile: .manager(name: "garden", avatar: "square", folder: URL(filePath: "/tmp/g")))
        #expect(manager.system.contains("<choices>"))
        #expect(manager.system.contains(BotPrompts.relayPrefix))
    }
}
