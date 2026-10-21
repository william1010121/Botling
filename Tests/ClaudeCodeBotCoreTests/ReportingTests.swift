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
        // The pick goes as the option's words, as a reply to that question (which it quotes).
        let sent = try #require(fake.agents[0].sent.last)
        #expect(sent.hasSuffix("Not yet"))
        #expect(sent.contains("Should we support succulents?"))
        #expect(manager.messages.last { $0.role == .user }?.replyTo == asked.id)
        #expect(manager.openQuestion == nil)
    }

    @Test func aQuestionStaysInTheManagersChatAndWaitsForYou() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.contains("Let the user decide") ? question : "OK, doing that." }
        let (workspace, project, manager) = try setUp(fake)
        workspace.select(nil)

        manager.relay("Should we support succulents? Let the user decide")
        await eventually { manager.openQuestion != nil }
        // Nothing is copied into the main bot's chat: the question waits where it was asked.
        #expect(!workspace.mainBot.messages.contains { $0.role == .notice })
        #expect(workspace.waiting.map(\.text) == ["Should we support succulents?"])
        #expect(workspace.waiting.first?.projectID == project.id)
        #expect(manager.hasUnread)
        // The main bot was not woken to say it.
        #expect(fake.agents.count == 1)

        let asked = try #require(manager.openQuestion)
        #expect(workspace.choose(0, in: asked.id, of: manager))
        await eventually { manager.messages.last?.text == "OK, doing that." }
        let sent = try #require(fake.agents[0].sent.last)
        #expect(sent.hasSuffix("Support them"))
        #expect(sent.contains("Should we support succulents?"))
        #expect(manager.messages.last { $0.role == .user }?.replyTo == asked.id)
        #expect(workspace.waiting.isEmpty)
    }

    @Test func finishedRelayedWorkStaysInTheManagersChat() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "README is written." }
        let (workspace, _, manager) = try setUp(fake)
        workspace.select(nil)

        manager.relay("Write the README")
        await eventually { manager.messages.count == 2 }
        #expect(manager.messages.last?.text == "README is written.")
        #expect(manager.hasUnread)
        #expect(!workspace.mainBot.messages.contains { $0.role == .notice })
    }

    @Test func managersAreToldHowToAskForADecision() {
        let manager = BotPrompts(profile: .manager(name: "garden", avatar: "square", folder: URL(filePath: "/tmp/g")))
        #expect(manager.system.contains("<choices>"))
        #expect(manager.system.contains(BotPrompts.relayPrefix))
    }
}
