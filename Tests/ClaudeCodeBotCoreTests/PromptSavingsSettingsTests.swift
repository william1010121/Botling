import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct PromptSavingsSettingsTests {
    private func open(_ root: URL, _ fake: FakeLauncher) -> Workspace {
        Workspace(root: root, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    private func knowledge(_ version: String = "usage-v1") -> ComponentKnowledge {
        .init(own: [.init(name: "card", text: "- card: Card\n  \(version)")], others: [], limit: 20)
    }

    @Test func defaultsPersistenceSearchAndNewBots() async throws {
        let old = try JSONDecoder().decode(AppSettings.self, from: Data("{\"developerMode\":false}".utf8))
        #expect(old.reactionChangesOnly && old.componentChangesOnly)
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-savings-settings-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), workspace = open(root, FakeLauncher())
        workspace.setBotLook(.original)
        workspace.setReactionChangesOnly(false)
        #expect(!workspace.settings.reactionChangesOnly && workspace.settings.componentChangesOnly)
        workspace.setComponentChangesOnly(false)
        workspace.setReactionChangesOnly(true)
        let reloaded = open(root, fake)
        #expect(reloaded.settings.reactionChangesOnly && !reloaded.settings.componentChangesOnly)
        #expect(reloaded.settings.botLook == .original)
        #expect(reloaded.mainBot.reactionChangesOnly && !reloaded.mainBot.componentChangesOnly)
        let project = reloaded.addProject(folder: root.appending(path: "project"), select: false)
        let bot = try #require(reloaded.bot(for: project))
        await bot.setHeads([.claude, .codex])
        bot.componentKnowledge = { knowledge() }
        bot.send("first", to: .codex)
        await eventually { !bot.isWorking && bot.partner?.isWorking != true }
        defer { bot.stop(); bot.partner?.stop() }
        #expect(bot.partner?.reactionChangesOnly == true && bot.partner?.componentChangesOnly == false)
        #expect(fake.agents.last?.wireSent.first?.contains("(App: Components in the chat:") == true)
        #expect(fake.agents.last?.wireSent.first?.contains("(App: Message reactions.") == true)
        reloaded.setReactionChangesOnly(false)
        reloaded.setComponentChangesOnly(true)
        #expect(bot.partner?.reactionChangesOnly == false && bot.partner?.componentChangesOnly == true)
        for key in ["App context savings", "Send only reaction changes", "Send only component changes"] {
            #expect(SettingsSection.matching(key, in: SettingsSection.allCases) == [.usage])
        }
    }

    @Test(arguments: [BotEngine.claude, .codex], [0, 1, 2, 3])
    func fourIndependentModesReachTransport(_ engine: BotEngine, _ mode: Int) async throws {
        let fake = FakeLauncher(), bot = makeBot(fake)
        await bot.setHeads([engine])
        bot.reactionChangesOnly = mode & 1 == 0
        bot.componentChangesOnly = mode & 2 == 0
        bot.componentKnowledge = { knowledge() }
        defer { bot.stop() }
        bot.send("first")
        await eventually { !bot.isWorking }
        let agent = try #require(fake.agents.first)
        #expect(agent.wireSent[0].contains("(App: Components in the chat:"))
        bot.send("unchanged")
        await eventually { agent.wireSent.count == 2 && !bot.isWorking }
        let second = agent.wireSent[1]
        #expect(second.contains("(App: Current message reactions in this chat;") == !bot.reactionChangesOnly)
        #expect(second.contains("(App: Components in the chat:") == !bot.componentChangesOnly)
        let target = try #require(bot.messages.first { $0.role == .user })
        try bot.setUserReaction(messageID: target.id, emoji: "❤️", present: true)
        bot.componentKnowledge = { knowledge("usage-v2") }; bot.componentsChanged()
        bot.send("changed")
        await eventually { agent.wireSent.count == 3 && !bot.isWorking }
        #expect(agent.wireSent[2].contains("❤️") && agent.wireSent[2].contains("usage-v2"))
        try bot.setUserReaction(messageID: target.id, emoji: "❤️", present: false)
        bot.componentKnowledge = { .init(own: [], others: [], limit: 20) }; bot.componentsChanged()
        bot.send("removed")
        await eventually { agent.wireSent.count == 4 && !bot.isWorking }
        let last = agent.wireSent[3]
        #expect(last.contains("\"reactions\":[]") && !last.contains("\"emoji\":\"❤️\""))
        #expect(bot.componentChangesOnly ? last.contains("Gone from the library: card") : last.contains("Anything absent is no longer available"))
    }

    @Test(arguments: [BotEngine.claude, .codex])
    func midSessionSwitchesRebaselineEachFeatureIndependently(_ engine: BotEngine) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-savings-switch-\(UUID())")
        let fake = FakeLauncher(), workspace = open(root, fake), bot = workspace.mainBot
        defer { bot.stop(); try? FileManager.default.removeItem(at: root) }
        await bot.setHeads([engine])
        bot.componentKnowledge = { knowledge() }
        bot.sessionExists = { _, _ in true }
        bot.send("first")
        await eventually { !bot.isWorking }
        let agent = try #require(fake.agents.first)
        let target = try #require(bot.messages.first { $0.role == .user })
        try bot.setUserReaction(messageID: target.id, emoji: "🎉", present: true)
        bot.send("notice")
        await eventually { agent.wireSent.count == 2 && !bot.isWorking }
        workspace.setReactionChangesOnly(false)
        #expect(agent.wireSent.count == 2 && fake.agents.count == 1)
        bot.send("reaction full")
        await eventually { agent.wireSent.count == 3 && !bot.isWorking }
        #expect(agent.wireSent[2].contains("Current message reactions") && agent.wireSent[2].contains("🎉"))
        #expect(!agent.wireSent[2].contains("(App: Components in the chat:"))
        workspace.setComponentChangesOnly(false)
        workspace.setReactionChangesOnly(true)
        try bot.setUserReaction(messageID: target.id, emoji: "🎉", present: false)
        bot.send("new baseline")
        await eventually { agent.wireSent.count == 4 && !bot.isWorking }
        #expect(agent.wireSent[3].contains("Current message reactions") && agent.wireSent[3].contains("\"reactions\":[]"))
        #expect(agent.wireSent[3].contains("(App: Components in the chat:"))
        bot.send("only component full")
        await eventually { agent.wireSent.count == 5 && !bot.isWorking }
        #expect(!agent.wireSent[4].contains("Current message reactions") && agent.wireSent[4].contains("(App: Components in the chat:"))
        workspace.setComponentChangesOnly(true)
        bot.send("component baseline")
        await eventually { agent.wireSent.count == 6 && !bot.isWorking }
        #expect(agent.wireSent[5].contains("(App: Components in the chat:"))
        bot.send("deltas again")
        await eventually { agent.wireSent.count == 7 && !bot.isWorking }
        #expect(!agent.wireSent[6].contains("(App: Components in the chat:") && !agent.wireSent[6].contains("Current message reactions"))
        // Even a toggle back before a send requires the next complete baseline.
        workspace.setReactionChangesOnly(false); workspace.setReactionChangesOnly(true)
        workspace.setComponentChangesOnly(false); workspace.setComponentChangesOnly(true)
        bot.send("rapid switches")
        await eventually { agent.wireSent.count == 8 && !bot.isWorking }
        #expect(agent.wireSent[7].contains("Current message reactions") && agent.wireSent[7].contains("(App: Components in the chat:"))
        #expect(fake.agents.count == 1)
    }

    @Test(arguments: [BotEngine.claude, .codex], [true, false])
    func processResumeSleepAndAppReloadKeepCorrectBaselines(_ engine: BotEngine, _ changesOnly: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-savings-reload-\(UUID())")
        let fake = FakeLauncher(), workspace = open(root, fake), bot = workspace.mainBot
        defer { bot.stop(); try? FileManager.default.removeItem(at: root) }
        workspace.setReactionChangesOnly(changesOnly); workspace.setComponentChangesOnly(changesOnly)
        await bot.setHeads([engine]); bot.componentKnowledge = { knowledge() }; bot.sessionExists = { _, _ in true }
        bot.send("before restart")
        await eventually { !bot.isWorking }
        let target = try #require(bot.messages.first { $0.role == .user })
        try bot.setUserReaction(messageID: target.id, emoji: "👀", present: true)
        await bot.restart(.plugins)
        bot.send("same session")
        await eventually { fake.agents.count == 2 && !bot.isWorking }
        let resumed = try #require(fake.agents.dropFirst().first)
        let input = try #require(resumed.wireSent.first)
        #expect(input.contains("👀"))
        #expect(input.contains("(App: Components in the chat:") == !changesOnly)
        #expect(input.contains("Current message reactions") == !changesOnly)
        await bot.goToSleep()
        bot.send("new session")
        await eventually { fake.agents.count == 3 && !bot.isWorking }
        #expect(fake.agents[2].wireSent[0].contains("(App: Components in the chat:"))
        #expect(fake.agents[2].wireSent[0].contains("👀"))
        bot.stop()
        let nextFake = FakeLauncher(), reloaded = open(root, nextFake), fresh = reloaded.mainBot
        defer { fresh.stop() }
        fresh.componentKnowledge = { knowledge() }
        fresh.send("after app reload")
        await eventually { !fresh.isWorking }
        let newInput = try #require(nextFake.agents.first?.wireSent.first)
        #expect(fresh.reactionChangesOnly == changesOnly && fresh.componentChangesOnly == changesOnly)
        #expect(newInput.contains("(App: Components in the chat:") && newInput.contains("👀"))
    }

    @Test func switchingWhileWorkingOnlyAffectsNextNormalTurn() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-savings-working-\(UUID())")
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let workspace = open(root, fake), bot = workspace.mainBot
        defer { bot.stop(); try? FileManager.default.removeItem(at: root) }
        bot.componentKnowledge = { knowledge() }
        bot.send("still working")
        let agent = try #require(fake.agents.first)
        #expect(bot.isWorking && agent.wireSent.count == 1)
        workspace.setReactionChangesOnly(false); workspace.setComponentChangesOnly(false)
        #expect(bot.isWorking && !agent.finished && agent.wireSent.count == 1)
        agent.reply("Done")
        await eventually { !bot.isWorking }
        bot.send("next normal turn")
        #expect(agent.wireSent.count == 2)
        #expect(agent.wireSent[1].contains("Current message reactions") && agent.wireSent[1].contains("(App: Components in the chat:"))
        #expect(!agent.log.contains("interrupt"))
        agent.reply("Done")
        await eventually { !bot.isWorking }
    }

    @Test func fullReactionBaselineClearsOldAndEvictedStates() throws {
        var old = ChatMessage(role: .user, text: "old")
        old.reactions = [.init(emoji: "❤️", actor: "user")]
        let empty = ChatMessage(role: .user, text: "cleared")
        let (text, seen) = ReactionContext.full([empty], previous: [old.id: old.reactions!], current: empty.id)
        #expect(text.contains(old.id.uuidString) && text.contains(empty.id.uuidString))
        #expect(!text.contains("\"emoji\":\"❤️\""))
        #expect(seen[old.id] == nil && seen[empty.id] == [])
        #expect(text.contains("\"reactions\":[]"))
        var cleared = old; cleared.reactions = nil
        let later = (0..<25).map { ChatMessage(role: .user, text: "later \($0)") }
        let reset = ReactionContext.full([cleared] + later, previous: [old.id: old.reactions!], current: later.last?.id)
        #expect(reset.text.contains(old.id.uuidString)) // A cleared old row outside the newest 20.
        #expect(!reset.text.contains(later[0].id.uuidString)) // Same target window as the original full mode.
        #expect(reset.seen[old.id] == [])
    }
}
