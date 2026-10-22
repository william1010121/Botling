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

/// One bot, two heads (P2): Claude and Codex take turns on one chat and one memory.md, one
/// process at a time.
@MainActor
struct TwoHeadsTests {
    func twoHeaded(_ fake: FakeLauncher, idle: TimeInterval = 60) async -> Bot {
        let bot = makeBot(fake, idle: idle)
        await bot.setHeads([.claude, .codex])
        return bot
    }

    @Test func aMessageGoesToTheHeadPickedForIt() async throws {
        let fake = FakeLauncher()
        let bot = await twoHeaded(fake)
        #expect(bot.heads.targets == [.claude, .codex, .both])

        bot.send("Review this", to: .codex)
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents.map(\.launch.engine) == [.codex])
        #expect(bot.messages.first?.to == .codex)
        #expect(bot.messages.last?.engine == .codex)
    }

    /// The lock: while one head works, a message for the other waits; it goes once the first is
    /// free, without a tidy (the bot is not going to sleep), and that head hears what it missed.
    @Test func theOtherHeadWaitsForTheOneRunningThenCatchesUp() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let bot = await twoHeaded(fake)
        bot.sessionExists = { _, _ in true }

        bot.send("Fix the hover toolbar", to: .claude)
        await eventually { fake.agents.count == 1 }
        bot.send("Review PR #5", to: .codex)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(fake.agents.count == 1)
        #expect(bot.waitingHead == .codex)

        fake.agents[0].reply("Fixed and merged in PR #5.")
        await eventually { fake.agents.count == 2 }
        #expect(fake.agents[0].finished)
        #expect(!fake.agents[0].sent.contains(bot.prompts.tidy))
        let codex = fake.agents[1]
        #expect(codex.launch.engine == .codex)
        #expect(!codex.launch.resume)
        #expect(codex.sent.first?.contains("Fixed and merged in PR #5.") == true)
        #expect(codex.sent.first?.hasSuffix("Review PR #5") == true)
        #expect(bot.waitingHead == nil)

        codex.reply("No regressions found.")
        await eventually { bot.messages.last?.text == "No regressions found." }
        // Back to Claude: its own session again, told what Codex said meanwhile.
        bot.send("Thanks, ship it", to: .claude)
        await eventually { fake.agents.count == 3 }
        let back = fake.agents[2]
        #expect(back.launch.engine == .claude)
        #expect(back.launch.resume)
        #expect(back.launch.sessionID == fake.agents[0].launch.sessionID)
        let told = try #require(back.sent.first)
        #expect(told.contains("Codex: No regressions found."))
        #expect(told.contains("User (to Codex): Review PR #5"))
        #expect(!told.contains("Fix the hover toolbar"))
        #expect(told.hasSuffix("Thanks, ship it"))
    }

    @Test func bothAnswerOneAfterTheOther() async throws {
        let fake = FakeLauncher()
        let bot = await twoHeaded(fake)

        bot.send("How should the release card get its data?", to: .both)
        await eventually { bot.messages.filter { $0.role == .bot }.count == 2 }
        #expect(fake.agents.map(\.launch.engine) == [.claude, .codex])
        #expect(bot.messages.filter { $0.role == .bot }.map(\.engine) == [.claude, .codex])
        #expect(bot.messages.first?.to == .both)
        #expect(fake.agents[1].sent.first?.contains(Bot.bothNote(answered: "Claude")) == true)
    }

    /// Only the head that ran last tidies memory.md before sleeping.
    @Test(.wallClock) func onlyTheLastHeadTidies() async {
        let fake = FakeLauncher()
        let bot = await twoHeaded(fake, idle: 0.3)
        bot.send("one", to: .claude)
        bot.send("two", to: .codex)
        await eventually { bot.phase == .asleep && fake.agents.count == 2 && fake.agents[1].finished }
        #expect(!fake.agents[0].sent.contains(bot.prompts.tidy))
        #expect(fake.agents[1].sent.last == bot.prompts.tidy)
    }

    @Test func headsAreKeptAndLabelled() async {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        await bot.setHeads([.codex, .claude])
        bot.setAnswerWith(.both)
        let again = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(again.heads == HeadsSettings(engines: [.claude, .codex], answerWith: .both))

        bot.send("hi", to: .codex)
        await eventually { bot.messages.last?.role == .bot }
        #expect(ChatPayload.headLabel(bot.messages[0], in: bot) == "to Codex")
        #expect(ChatPayload.headLabel(bot.messages[1], in: bot) == "Main bot · Codex")
        // One head again: no labels, and Both is no longer a choice.
        await bot.setHeads([.codex])
        #expect(ChatPayload.headLabel(bot.messages[1], in: bot) == nil)
        #expect(bot.heads.answerWith == .codex)
    }
}
