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

/// One bot, two heads: Claude and Codex get every message at the same time, each in a
/// process of its own, hear each other, and the chat marks which head saw each line.
@MainActor
struct TwoHeadsTests {
    func twoHeaded(_ fake: FakeLauncher, idle: TimeInterval = 60) async -> Bot {
        let bot = makeBot(fake, idle: idle)
        await bot.setHeads([.claude, .codex])
        return bot
    }

    func agent(_ fake: FakeLauncher, _ engine: BotEngine) -> FakeAgent? {
        fake.agents.last { $0.launch.engine == engine }
    }

    @Test func bothHeadsGetEachMessageAtOnceAndSeeIt() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { engine, text in isAppOnly(text) ? nil : engine == .claude ? "I take the toolbar." : "I'll review it after." }
        let bot = await twoHeaded(fake)
        #expect(bot.heads.targets == [.both, .claude, .codex])
        #expect(bot.heads.answerWith == .both)

        bot.send("Fix the hover toolbar")
        await eventually { bot.messages.filter { $0.role == .bot }.count == 2 }
        #expect(Set(fake.agents.map(\.launch.engine)) == [.claude, .codex])
        let mine = try #require(bot.messages.first)
        #expect(mine.to == nil)
        #expect(mine.seenBy == [.claude, .codex])
        let replies = bot.messages.filter { $0.role == .bot }
        #expect(Set(replies.compactMap(\.engine)) == [.claude, .codex])
        for reply in replies { #expect(reply.seenBy?.contains(reply.engine!) == true) }
        #expect(ChatPayload.seenMarks(mine, in: bot)?.map(\.mark) == ["C", "X"])
    }

    /// No lock: a head at work hears the other's reply in its turn; an idle one with its next
    /// message, and the reply is marked seen by it only then.
    @Test func eachHeadHearsTheOther() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { engine, text in
            if isAppOnly(text) { return nil }
            return engine == .codex ? "No regressions." : nil
        }
        let bot = await twoHeaded(fake)
        bot.send("Review PR #5")
        await eventually { bot.messages.contains { $0.text == "No regressions." } }
        let claude = try #require(agent(fake, .claude))
        await eventually { claude.sent.contains { $0.contains("Codex, this bot's other head, replied in this chat:)\nNo regressions.") } }
        let codexReply = try #require(bot.messages.first { $0.text == "No regressions." })
        #expect(codexReply.seenBy == [.claude, .codex])
        #expect(bot.isWorking)

        claude.reply("Merged it.")
        await eventually { bot.messages.contains { $0.text == "Merged it." } && !bot.isWorking }
        // Codex is idle: Claude's reply waits for its next message.
        let merged = try #require(bot.messages.first { $0.text == "Merged it." })
        #expect(merged.seenBy == [.claude])
        bot.send("Thanks", to: .codex)
        let codex = try #require(agent(fake, .codex))
        await eventually { codex.sent.last?.contains("Merged it.") == true }
        #expect(codex.sent.last?.hasSuffix("Thanks") == true)
        await eventually { bot.messages.first { $0.text == "Merged it." }?.seenBy == [.claude, .codex] }
    }

    @Test func aHeadsWordsReachTheOtherWhileItWorks() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, text in isAppOnly(text) ? "OK" : nil }
        let bot = await twoHeaded(fake)
        bot.send("Fix it")
        await eventually { fake.agents.count == 2 }
        let codex = try #require(agent(fake, .codex))
        let claude = try #require(agent(fake, .claude))
        codex.emit(.trace(.text("I'll take the CSS part.", parent: nil)))
        await eventually { claude.sent.contains("(App: Codex, working on this too, says: I'll take the CSS part.)") }
    }

    @Test func aMessageNamedForOneGoesToItAlone() async throws {
        let fake = FakeLauncher()
        let bot = await twoHeaded(fake)
        bot.send("@codex only", to: .codex)
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents.map(\.launch.engine) == [.codex])
        #expect(bot.messages.first?.to == .codex)
        #expect(bot.messages.first?.seenBy == [.codex])
        #expect(ChatPayload.headLabel(bot.messages[0], in: bot) == "to Codex")
    }

    @Test func aHeadWithNothingToAddShowsNoBubble() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { engine, text in isAppOnly(text) ? nil : engine == .claude ? "Done." : "<no-reply/>" }
        let bot = await twoHeaded(fake)
        bot.send("Small fix")
        await eventually { fake.agents.count == 2 && !bot.isWorking && bot.partner?.isWorking == false }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(bot.messages.filter { $0.role == .bot }.map(\.text) == ["Done."])
    }

    /// The heads sleep together, and memory.md is tidied once.
    @Test(.wallClock) func oneTidyForBoth() async {
        let fake = FakeLauncher()
        let bot = await twoHeaded(fake, idle: 0.3)
        bot.send("one")
        await eventually { bot.phase == .asleep && fake.agents.count == 2 && fake.agents.allSatisfy(\.finished) }
        let claude = agent(fake, .claude), codex = agent(fake, .codex)
        #expect(claude?.sent.last?.hasPrefix(bot.prompts.tidy) == true)
        #expect(codex?.sent.contains { $0.hasPrefix(BotPrompts.tidyLead) } == false)
        #expect(bot.partner?.phase == .asleep)
    }

    /// The composer saves a default; addressing one message must not replace it.
    @Test(arguments: AnswerTarget.allCases) func answerChoiceSurvivesAnOverrideAndRelaunch(_ target: AnswerTarget) async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-answer-choice-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let store = BotStore(directory: home.appending(path: "store"))
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        await bot.setHeads([.claude, .codex])
        bot.setAnswerWith(target)
        #expect(store.loadHeads()?.answerWith == target)

        let override: AnswerTarget = target == .claude ? .codex : .claude
        bot.send("One addressed message", to: override)
        await eventually { bot.messages.last?.role == .bot }
        #expect(bot.messages.first { $0.role == .user }?.to == override)
        #expect(bot.heads.answerWith == target)
        #expect(store.loadHeads()?.answerWith == target)
        bot.stop()

        let relaunched = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(relaunched.heads.answerWith == target)
    }

    @Test func headsAreKeptAndToldAboutEachOther() async {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        await bot.setHeads([.codex, .claude])
        bot.setAnswerWith(.codex)
        let again = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(again.heads == HeadsSettings(engines: [.claude, .codex], answerWith: .codex))
        #expect(bot.prompts.system.contains("working at the same time in this one chat, in the same folder"))
        // One head again: no marks, no labels, and Both is no longer a choice.
        await bot.setHeads([.claude])
        #expect(bot.heads.targets == [.claude])
        #expect(bot.partner == nil)
        #expect(!bot.prompts.system.contains("working at the same time"))
    }
}
