import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct TokenSavingsIntegrationTests {
    private func knowledge(_ usage: String = "usage-v1") -> ComponentKnowledge {
        .init(own: [.init(name: "private-card", text: "- private-card: Card\n  \(usage)")], others: [], limit: 20)
    }

    private func awake(_ engine: BotEngine, _ fake: FakeLauncher) async -> Bot {
        let bot = makeBot(fake)
        await bot.setHeads(engine == .codex ? [.codex] : [.claude])
        bot.componentKnowledge = { knowledge() }
        bot.sessionExists = { _, _ in true }
        bot.send("first")
        await eventually { !bot.isWorking && bot.messages.contains { $0.role == .bot } }
        return bot
    }

    @Test(arguments: [BotEngine.claude, .codex])
    func sameSessionResumesWithDeltasAndANewSessionGetsFullContext(_ engine: BotEngine) async throws {
        let fake = FakeLauncher()
        let bot = await awake(engine, fake)
        defer { bot.stop() }
        let first = try #require(fake.agents.first)
        let target = try #require(bot.messages.first { $0.role == .user })
        #expect(first.wireSent[0].components(separatedBy: "(App: Components in the chat:").count == 2)
        #expect(first.wireSent[0].contains("(App: Message reactions."))
        try bot.setUserReaction(messageID: target.id, emoji: "❤️", present: true)
        bot.componentKnowledge = { knowledge("usage-v2") }
        bot.componentsChanged()
        await bot.reloadPlugins()
        bot.send("resumed")
        await eventually { fake.agents.count == 2 && !bot.isWorking }
        let resumed = try #require(fake.agents.dropFirst().first)
        #expect(resumed.launch.resume && resumed.launch.sessionID == first.launch.sessionID)
        let input = try #require(resumed.wireSent.first)
        #expect(input.contains("Usage changed") && input.contains("usage-v2"))
        #expect(input.contains("Reactions changed") && input.contains("❤️"))
        #expect(!input.contains("(App: Components in the chat:") && !input.contains("(App: Message reactions."))
        try bot.setUserReaction(messageID: target.id, emoji: "❤️", present: false)
        bot.send("removed")
        await eventually { resumed.wireSent.count == 2 && !bot.isWorking }
        #expect(resumed.wireSent[1].contains("\"reactions\":[]"))
        #expect(!resumed.wireSent[1].contains("❤️"))
        await bot.goToSleep()
        #expect(bot.phase == .asleep)
        bot.send("new session")
        await eventually { fake.agents.count == 3 && !bot.isWorking }
        let fresh = try #require(fake.agents.dropFirst(2).first)
        #expect(!fresh.launch.resume && fresh.launch.sessionID != first.launch.sessionID)
        #expect(fresh.wireSent[0].contains("(App: Components in the chat:"))
        #expect(fresh.wireSent[0].contains("usage-v2") && fresh.wireSent[0].contains("(App: Message reactions."))
    }

    @Test func componentDeltasReachBothHeadsAndDoNotIncludeAnotherBotsPrivateUsage() async throws {
        let fake = FakeLauncher()
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-token-integration-\(UUID())")
        let workspace = Workspace(root: root, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        defer { workspace.mainBot.stop(); workspace.mainBot.partner?.stop(); try? FileManager.default.removeItem(at: root) }
        for name in ["mine", "theirs"] {
            let folder = workspace.components.folder.appending(path: name)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try "<p>card</p>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
            try "\(name) summary\nprivate usage v1".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        }
        workspace.components.rescan()
        let bot = workspace.mainBot
        bot.setComponentList(["mine"])
        await bot.setHeads([.claude, .codex])
        for target in [AnswerTarget.claude, .codex] {
            bot.send("first", to: target)
            await eventually { !bot.isWorking && bot.partner?.isWorking != true }
        }
        #expect(fake.agents.count == 2)
        for agent in fake.agents {
            #expect(agent.wireSent[0].contains("- mine:") && agent.wireSent[0].contains("private usage v1"))
            #expect(agent.wireSent[0].contains("- theirs:"))
        }
        func edit(_ name: String, _ version: Int) throws {
            let about = workspace.components.aboutURL(name)
            try "\(name) summary\nprivate usage v\(version)".write(to: about, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(Double(version * 5))], ofItemAtPath: about.path)
            workspace.components.rescan()
        }
        try edit("theirs", 2) // The shelf summary is unchanged; its private usage is irrelevant.
        for target in [AnswerTarget.claude, .codex] {
            bot.send("unrelated", to: target)
            await eventually { !bot.isWorking && bot.partner?.isWorking != true }
        }
        for agent in fake.agents { #expect(!agent.wireSent.last!.contains("Components were updated")) }
        try edit("mine", 3)
        for target in [AnswerTarget.claude, .codex] {
            bot.send("related", to: target)
            await eventually { !bot.isWorking && bot.partner?.isWorking != true }
        }
        for agent in fake.agents {
            let input = try #require(agent.wireSent.last)
            #expect(input.contains("Usage changed") && input.contains("private usage v3"))
            #expect(!input.contains("(App: Components in the chat:") && !input.contains("- theirs:"))
        }
        workspace.takeComponent("mine", from: bot)
        for target in [AnswerTarget.claude, .codex] {
            bot.send("dropped", to: target)
            await eventually { !bot.isWorking && bot.partner?.isWorking != true }
        }
        for agent in fake.agents { #expect(agent.wireSent.last!.contains("No longer yours")) }
    }

    @Test func codexInternalThreadMigrationResendsFullContextEvenWithTheSameAppSession() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-token-migration-\(UUID())")
        let threads = CodexThreads.shared
        let originalFolder = threads.folder
        threads.folder = root
        defer { threads.folder = originalFolder; try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let bot = await awake(.codex, fake)
        defer { bot.stop() }
        let first = try #require(fake.agents.first)
        let session = first.launch.sessionID
        threads.save("old-schema-thread", for: session)
        // The actual adapter will start a fresh internal thread for this legacy marker.
        var resume = first.launch
        resume.resume = true
        #expect(try CodexAgentProcess.config(for: resume, threads: threads).resumeThread == nil)
        await bot.reloadPlugins()
        bot.send("after schema migration")
        await eventually { fake.agents.count == 2 && !bot.isWorking }
        let migrated = try #require(fake.agents.dropFirst().first)
        #expect(migrated.launch.sessionID == session && migrated.launch.resume)
        #expect(migrated.wireSent[0].contains("(App: Components in the chat:"))
        #expect(migrated.wireSent[0].contains("(App: Message reactions."))
        threads.save("current-thread", for: session)
        threads.markManaged("current-thread", for: session)
        await bot.reloadPlugins()
        bot.send("same internal thread")
        await eventually { fake.agents.count == 3 && !bot.isWorking }
        #expect(!fake.agents[2].wireSent[0].contains("(App: Components in the chat:"))
        #expect(!fake.agents[2].wireSent[0].contains("(App: Message reactions."))
    }

    @Test func separateBotsNeverShareSeenReactionsOrComponentState() async throws {
        let fakeA = FakeLauncher(), fakeB = FakeLauncher()
        let a = await awake(.claude, fakeA)
        let b = await awake(.codex, fakeB)
        defer { a.stop(); b.stop() }
        let target = try #require(a.messages.first)
        try a.setUserReaction(messageID: target.id, emoji: "🎉", present: true)
        a.componentKnowledge = { knowledge("only-bot-a") }; a.componentsChanged()
        a.send("a next"); b.send("b next")
        await eventually { !a.isWorking && !b.isWorking }
        #expect(fakeA.agents[0].wireSent.last!.contains("only-bot-a"))
        #expect(fakeA.agents[0].wireSent.last!.contains(target.id.uuidString))
        let input = fakeB.agents[0].wireSent.last!
        #expect(!input.contains("only-bot-a") && !input.contains(target.id.uuidString))
        #expect(!input.contains("Components were updated") && !input.contains("Reactions changed"))
    }
}
