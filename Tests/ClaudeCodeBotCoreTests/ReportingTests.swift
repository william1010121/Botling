import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ReplyParserTests {
    @Test func choicesBlockBecomesButtons() {
        let reply = """
        40 old posts have no cover image. What should we do?
        <choices>
        * Fill in with a placeholder image | Done today
        - Leave it blank for now | Decide later
        - Generate one per post
        </choices>
        """
        let parsed = ReplyParser.parse(reply)
        #expect(parsed.body == "40 old posts have no cover image. What should we do?")
        #expect(parsed.choices == [
            Choice(label: "Fill in with a placeholder image", detail: "Done today", recommended: true),
            Choice(label: "Leave it blank for now", detail: "Decide later"),
            Choice(label: "Generate one per post")
        ])
    }

    @Test func replyWithoutBlockIsUnchanged() {
        let parsed = ReplyParser.parse("All done.")
        #expect(parsed.body == "All done.")
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
Should we support succulents?
<choices>
* Support them | One more day
- Not yet
</choices>
"""

@MainActor
struct ReportingTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-report-\(UUID().uuidString)")

    func setUp(_ fake: FakeLauncher) throws -> (Workspace, Workspace.Project, Bot) {
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        return (workspace, project, try #require(workspace.bot(for: project)))
    }

    @Test func pickingAButtonSendsItsLabelOnce() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.hasSuffix("Ask me") ? question : "OK, doing that." }
        let (workspace, _, manager) = try setUp(fake)

        manager.send("Ask me")
        await eventually { manager.openQuestion != nil }
        let asked = try #require(manager.openQuestion)
        #expect(asked.text == "Should we support succulents?")
        #expect(asked.choices?.count == 2)

        #expect(workspace.choose(1, in: asked.id, of: manager))
        #expect(!workspace.choose(0, in: asked.id, of: manager))
        await eventually { manager.messages.last?.text == "OK, doing that." }

        #expect(manager.messages.first { $0.id == asked.id }?.chosen == 1)
        #expect(fake.agents[0].sent.last == "Not yet")
        #expect(manager.openQuestion == nil)
    }

    @Test func questionGoesUpToTheMainBotAndCanBeAnsweredThere() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.contains("succulents") ? question : "OK, doing that." }
        let (workspace, project, manager) = try setUp(fake)
        workspace.select(nil)

        manager.relay("Should we support succulents? Let the user decide")
        await eventually { workspace.group.messages.contains { $0.role == .notice } }

        let notice = try #require(workspace.group.messages.last)
        #expect(notice.role == .notice)
        #expect(notice.text == "garden: Should we support succulents?")
        #expect(notice.sourceID == project.id)
        #expect(notice.isOpenQuestion)
        #expect(workspace.waiting.map(\.text) == ["Should we support succulents?"])
        // The main bot was not woken to say it.
        #expect(fake.agents.count == 1)

        #expect(workspace.choose(0, in: notice.id, of: workspace.group))
        await eventually { manager.messages.last?.text == "OK, doing that." }

        #expect(fake.agents[0].sent.last == "Support them")
        #expect(workspace.group.messages.first { $0.id == notice.id }?.chosen == 0)
        #expect(manager.messages.first { $0.id == notice.sourceMessageID }?.chosen == 0)
        #expect(workspace.waiting.isEmpty)
    }

    @Test func answeringInTheProjectChatSettlesTheNotice() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.contains("succulents") ? question : "OK." }
        let (workspace, project, manager) = try setUp(fake)

        manager.relay("Should we support succulents?")
        await eventually { manager.openQuestion != nil }
        workspace.select(project.id)
        let asked = try #require(manager.openQuestion)

        #expect(workspace.choose(1, in: asked.id, of: manager))
        let notice = try #require(workspace.group.messages.first { $0.role == .notice })
        #expect(notice.chosen == 1)
        #expect(!notice.isOpenQuestion)
    }

    @Test func finishedRelayedWorkIsReportedButChatWithTheUserIsNot() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "README is written." }
        let (workspace, _, manager) = try setUp(fake)

        manager.send("Hello")
        await eventually { manager.messages.count == 2 }
        #expect(!workspace.group.messages.contains { $0.role == .notice })

        manager.relay("Write the README")
        await eventually { manager.messages.count == 4 }
        let notices = workspace.group.messages.filter { $0.role == .notice }
        #expect(notices.map(\.text) == ["garden: README is written."])
        #expect(notices.first?.choices == nil)
        #expect(workspace.group.hasUnread)
    }

    @Test func managersAreToldHowToAskForADecision() {
        let manager = BotPrompts(profile: .manager(name: "garden", avatar: "square", folder: URL(filePath: "/tmp/g")))
        #expect(manager.system.contains("<choices>"))
        #expect(manager.system.contains(BotPrompts.relayPrefix))
    }
}
