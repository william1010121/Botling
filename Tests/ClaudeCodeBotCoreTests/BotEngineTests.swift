import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A bot that runs on Codex or Claude: the engine it keeps, and switching between them.
@MainActor
struct BotEngineTests {
    @Test func aBotRemembersItsEngineAndWakesOnIt() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")
        let fake = FakeLauncher()
        let store = BotStore(directory: home.appending(path: "store"))
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(bot.engine == .claude)

        await bot.switchEngine(to: .codex)
        #expect(bot.engine == .codex)
        #expect(bot.messages.map(\.text) == ["Switched to Codex"])
        #expect(store.loadEngine() == .codex)

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents.first?.launch.engine == .codex)

        let again = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(again.engine == .codex)
    }

    /// One CLI cannot resume the other's conversation: an engine switch always hands over
    /// through memory.md, even when the session could be resumed.
    @Test func switchingEngineWhileAwakeHandsOverThroughMemory() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.sessionExists = { _, _ in true }

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        await bot.switchEngine(to: .codex)
        #expect(fake.agents.count == 1)

        bot.send("next")
        await eventually { fake.agents.count == 2 && bot.messages.last?.role == .bot }
        #expect(fake.agents[0].sent.last == bot.prompts.handoff)
        let fresh = try #require(fake.agents.last)
        #expect(fresh.launch.engine == .codex)
        #expect(!fresh.launch.resume)
        #expect(fresh.sent.first?.hasPrefix(bot.prompts.resume) == true)
        #expect(bot.messages.contains { $0.role == .divider && $0.text == "Handoff → Codex" })
    }

    @Test func aBotOnCodexIsToldItsResultsStayLocal() {
        let profile = BotProfile.main(home: FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)"))
        let manager = BotProfile.manager(name: "Site", avatar: "S", folder: FileManager.default.temporaryDirectory.appending(path: "ccb-site-\(UUID().uuidString)"))
        let claude = BotPrompts(profile: manager, results: .artifactAlways)
        let codex = BotPrompts(profile: manager, results: .artifactAlways, engine: .codex)
        #expect(!claude.system.contains(BotPrompts.codexNote))
        #expect(codex.system.contains(BotPrompts.codexNote))
        #expect(codex.system.contains(BotPrompts.resultsRule(.localOnly, folder: manager.artifactsURL.path)))
        #expect(BotPrompts(profile: profile, engine: .codex).system.contains(BotPrompts.codexNote))
    }
}
