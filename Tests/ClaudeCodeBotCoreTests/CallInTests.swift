import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// @ in a bot's own chat calls another bot in: it reads the chat and answers there, under its
/// own name and face, like in a group.
@MainActor
struct CallInTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-callin-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func folder(_ name: String) throws -> URL {
        let url = root.appending(path: "code/\(name)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func owner(of agent: FakeAgent) -> String { agent.launch.workingDirectory.lastPathComponent }

    @Test func everyBotButThisOneCanBeCalledIn() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        #expect(workspace.callable(into: chat).map(\.name) == ["Main bot", "Maintainer", "Codex"])
        #expect(workspace.callable(into: workspace.mainBot).map(\.name) == ["garden", "Maintainer", "Codex"])
        // A group lists its own members, as before.
        let group = try #require(workspace.createGroup(name: "Team", members: [garden.id]))
        #expect(workspace.callable(into: try #require(workspace.groupChats[group.id])).isEmpty)
    }

    @Test func theAtMenuInABotsOwnChatListsOnlyTheGlobalBots() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let garden = workspace.addProject(folder: try folder("garden"))
        let orchard = workspace.addProject(folder: try folder("orchard"))
        let gardenChat = try #require(workspace.bot(for: garden))
        // Other projects' bots are not offered after @, only the global bots.
        #expect(workspace.callInView(for: gardenChat)?.names == ["Main bot", "Maintainer", "Codex"])
        #expect(workspace.callInView(for: workspace.mainBot)?.names == ["Maintainer", "Codex"])
        #expect(workspace.callInView(for: workspace.maintainer)?.names == ["Main bot", "Codex"])
        // A group's menu is its members only.
        let group = try #require(workspace.createGroup(name: "Team", members: [garden.id, orchard.id]))
        let groupChat = try #require(workspace.groupChats[group.id])
        #expect(workspace.callInView(for: groupChat) == nil)
        #expect(Set(workspace.members(of: group).map(\.name)) == ["garden", "orchard"])
    }

    @Test func typingAfterAtOrAtAtSearchesEveryBotThatCanBeCalledIn() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let garden = workspace.addProject(folder: try folder("garden"))
        let orchard = workspace.addProject(folder: try folder("orchard"))
        let gardenChat = try #require(workspace.bot(for: garden))
        // Every bot that can be called in, the short list first.
        #expect(workspace.callInView(for: gardenChat)?.allNames == ["Main bot", "Maintainer", "Codex", "orchard"])
        #expect(workspace.callInView(for: workspace.mainBot)?.allNames == ["Maintainer", "Codex", "garden", "orchard"])
        let payload = ChatPayload.make(bot: gardenChat, components: workspace.components, pending: [], replyingTo: nil,
                                       callIn: workspace.callInView(for: gardenChat)) { _ in "" }
        let json = try #require(JSONSerialization.jsonObject(with: payload.json().data(using: .utf8)!) as? [String: Any])
        #expect(json["mentions"] as? [String] == ["Main bot", "Maintainer", "Codex"])
        #expect(json["allMentions"] as? [String] == ["Main bot", "Maintainer", "Codex", "orchard"])
        // A group can't call in bots that aren't in it: every list is its members.
        let group = try #require(workspace.createGroup(name: "Team", members: [garden.id]))
        let groupChat = try #require(workspace.groupChats[group.id])
        let groupPayload = ChatPayload.make(bot: groupChat, components: workspace.components, pending: [], replyingTo: nil,
                                            group: ChatPayload.GroupView(typing: nil, names: ["garden"]) { _ in nil }) { _ in "" }
        let groupJSON = try #require(JSONSerialization.jsonObject(with: groupPayload.json().data(using: .utf8)!) as? [String: Any])
        #expect(groupJSON["allMentions"] as? [String] == ["garden"])
        _ = orchard
    }

    @Test func aBotNamedWithAtAnswersInThisChatUnderItsOwnName() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains(Workspace.calledInLead) {
                // It sees the chat it was called into, and who it is there.
                #expect(text.contains("\"garden\"'s chat"))
                #expect(text.contains("User (newest): @Maintainer the flag is broken"))
                return "I'll fix the flag."
            }
            if isAppOnly(text) { return "OK" }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))

        await workspace.send("@Maintainer the flag is broken", to: chat)
        await workspace.callInQueues[garden.id]?.value
        await eventually { chat.messages.contains { $0.role == .bot && $0.sourceID == nil } }

        // garden got your line, and knows who else was called in.
        let gardenAgent = try #require(fake.agents.first { Self.owner(of: $0) == "garden" })
        let toGarden = try #require(gardenAgent.sent.first { $0.contains("@Maintainer the flag is broken") })
        #expect(toGarden.contains("(App: The user also called in \"Maintainer\""))
        // Maintainer's answer is in garden's chat, as Maintainer's.
        let called = try #require(chat.messages.first { $0.sourceID == Workspace.maintainerID })
        #expect(called.role == .bot)
        #expect(called.text == "I'll fix the flag.")
        #expect(workspace.callInSpeakers.isEmpty)
        // Maintainer's own chat keeps what it was asked there and what it said.
        #expect(workspace.maintainer.messages.map(\.role) == [.notice, .bot])

        let payload = ChatPayload.make(bot: chat, components: workspace.components, pending: [], replyingTo: nil,
                                       callIn: workspace.callInView(for: chat)) { _ in "" }
        let json = try #require(JSONSerialization.jsonObject(with: payload.json().data(using: .utf8)!) as? [String: Any])
        #expect(json["mentions"] as? [String] == ["Main bot", "Maintainer", "Codex"])
        let messages = try #require(json["messages"] as? [[String: Any]])
        #expect(messages.first { $0["text"] as? String == "I'll fix the flag." }?["speaker"] as? String == "Maintainer")
        #expect(messages.first { $0["text"] as? String == "Got it" }?["speaker"] == nil)
    }

    @Test func plainMessagesAndSelfMentionsCallNobody() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("@garden hi, mail me@Maintainer.com", to: chat)
        await eventually { chat.messages.contains { $0.role == .bot } }
        #expect(workspace.callInQueues[garden.id] == nil)
        #expect(!fake.agents.contains { Self.owner(of: $0) != "garden" })
    }

    @Test func aPickOnACalledInBotsLineGoesBackToThatBot() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains(Workspace.calledInLead) {
                if text.contains(Workspace.pickedNote("Today")) { return "Done today, then." }
                return "When?\n<choices>\n* Today | fast\n- Tomorrow\n</choices>"
            }
            return isAppOnly(text) ? "OK" : "Got it"
        }
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("@Main bot ship it", to: chat)
        await workspace.callInQueues[garden.id]?.value
        let question = try #require(chat.messages.first { $0.sourceID == Workspace.mainBotID })
        #expect(question.isOpenQuestion)

        #expect(workspace.choose(0, in: question.id, of: chat))
        await workspace.callInQueues[garden.id]?.value
        #expect(chat.messages.last { $0.sourceID == Workspace.mainBotID }?.text == "Done today, then.")
        #expect(chat.messages.first { $0.id == question.id }?.chosen == 0)
    }

    /// A called-in bot works in its own main session, and its own chat and archive keep the
    /// exchange (with the subagent it sent), so it owns that work after the call-in too.
    @Test func aCalledInBotsOwnChatAndArchiveKeepTheExchange() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("(App: The user called you into") { return "Measured: 42 tokens/s." }
            if isAppOnly(text) { return "OK" }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))

        await workspace.send("@Maintainer how fast is it?", to: chat)
        await workspace.callInQueues[garden.id]?.value
        #expect(chat.messages.contains { $0.sourceID == Workspace.maintainerID && $0.text == "Measured: 42 tokens/s." })

        // Its own chat: where it was called in and what was asked, then its reply.
        let own = workspace.maintainer.messages
        #expect(own.count == 2)
        let asked = try #require(own.first)
        #expect(asked.role == .notice)
        #expect(asked.text.contains("garden"))
        #expect(asked.text.contains("@Maintainer how fast is it?"))
        #expect(own.last?.role == .bot)
        #expect(own.last?.sourceID == nil)
        #expect(own.last?.text == "Measured: 42 tokens/s.")
        // Seen already in garden's chat: nothing unread for it.
        #expect(workspace.maintainer.unreadCount == 0)

        // Its archive has both, so a later session can grep it.
        let archive = workspace.maintainer.profile.archiveURL
        let months = try FileManager.default.contentsOfDirectory(at: archive, includingPropertiesForKeys: nil)
        let written = try months.map { try String(contentsOf: $0, encoding: .utf8) }.joined()
        #expect(written.contains("@Maintainer how fast is it?"))
        #expect(written.contains("You: Measured: 42 tokens/s."))

        // The same main session as its own chat: talking to it there launches nothing new.
        let launched = fake.agents.filter { $0.launch.workingDirectory == workspace.maintainer.profile.workingDirectory }
        #expect(launched.count == 1)
        await workspace.send("and now?", to: workspace.maintainer)
        await eventually { workspace.maintainer.messages.contains { $0.text == "Got it" } }
        #expect(fake.agents.filter { $0.launch.workingDirectory == workspace.maintainer.profile.workingDirectory }.count == 1)
        #expect(launched.first?.sent.contains { $0.contains("(App: The user called you into") } == true)
        // The reply in garden's chat is not answered twice.
        #expect(chat.messages.filter { $0.text == "Measured: 42 tokens/s." }.count == 1)
    }
}
