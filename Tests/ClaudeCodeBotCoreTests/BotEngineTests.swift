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
    /// `claimWait`: how long the second head waits for the first one's opening words (short
    /// here, so tests where the first head stays silent do not wait long).
    func twoHeaded(_ fake: FakeLauncher, idle: TimeInterval = 60, claimWait: TimeInterval = 0.3) async -> Bot {
        let bot = makeBot(fake, idle: idle)
        bot.claimWait = claimWait
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

    /// The race: both heads used to get a message at the same instant, so neither saw the
    /// other's "I take X" before it started, and both did the same work. Now the second head
    /// gets the message with the first one's opening words, then both work at once.
    @Test func theSecondHeadGetsTheMessageWithTheFirstOnesClaim() async throws {
        let fake = FakeLauncher()
        // Nothing answers by itself: each head speaks only when the test says so.
        fake.respondFor = { _, _ in nil }
        let bot = await twoHeaded(fake, claimWait: 600)
        bot.send("Fix the page")
        await eventually { agent(fake, .claude)?.sent.contains { $0.contains("Fix the page") } == true }
        let claude = try #require(agent(fake, .claude))
        // Claude takes a moment before it says what it takes on; Codex must not start blind.
        try? await Task.sleep(for: .milliseconds(200))
        #expect(agent(fake, .codex)?.sent.contains { $0.contains("Fix the page") } != true)
        claude.emit(.trace(.text("I'll take the CSS part.", parent: nil)))
        await eventually { agent(fake, .codex)?.sent.contains { $0.contains("Fix the page") } == true }
        let codex = try #require(agent(fake, .codex))
        let first = try #require(codex.sent.first { $0.contains("Fix the page") })
        let claim = "(App: Claude, working on this too, says: I'll take the CSS part.)"
        #expect(first.contains(claim + "\n\nFix the page"))
        #expect(codex.sent.filter { $0.contains(claim) }.count == 1)
        #expect(bot.isWorking && bot.partner?.isWorking == true)
        // From here on both work at once and hear each other mid-turn.
        codex.emit(.trace(.text("Then I'll take the API.", parent: nil)))
        await eventually { claude.sent.contains("(App: Codex, working on this too, says: Then I'll take the API.)") }
        // The next message to both is led by the other head.
        claude.reply("CSS done.")
        codex.reply("API done.")
        await eventually { !bot.isWorking && bot.partner?.isWorking == false }
        bot.send("Now the footer")
        await eventually { codex.sent.contains { $0.contains("Now the footer") } }
        try? await Task.sleep(for: .milliseconds(200))
        #expect(!claude.sent.contains { $0.contains("Now the footer") })
    }

    /// A first head that says nothing does not keep the other waiting long.
    @Test func theSecondHeadIsNotHeldPastTheWait() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, text in isAppOnly(text) ? "OK" : nil }
        let bot = await twoHeaded(fake, claimWait: 0.2)
        bot.send("Fix it")
        await eventually { fake.agents.count == 2 }
        let codex = try #require(agent(fake, .codex))
        #expect(codex.sent.contains { $0.hasSuffix("Fix it") && !$0.contains("working on this too") })
        #expect(bot.isWorking && bot.partner?.isWorking == true)
    }

    /// A lead can answer without commentary: its reply must accompany the held message,
    /// including when the other head is already awake and reads no fresh recent-chat note.
    @Test func aReplyOnlyClaimReachesAWarmHeadWithTheMessage() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = await twoHeaded(fake, claimWait: 600)
        defer { bot.stop() }
        bot.send("Warm Claude", to: .claude)
        let claude = try #require(agent(fake, .claude))
        claude.reply("Claude is ready.")
        await eventually { !bot.isWorking }
        bot.send("Warm Codex", to: .codex)
        let codex = try #require(agent(fake, .codex))
        codex.reply("Codex is ready.")
        await eventually { bot.partner?.isWorking == false }

        bot.send("Fix the reply-only case")
        #expect(!codex.sent.contains { $0.contains("Fix the reply-only case") })
        claude.reply("I'll take the parser; Codex can review it.")
        await eventually { codex.sent.contains { $0.contains("Fix the reply-only case") } }
        let delivered = try #require(codex.sent.first { $0.contains("Fix the reply-only case") })
        #expect(delivered.contains("Claude, this bot's other head, replied in this chat:"))
        #expect(delivered.contains("I'll take the parser; Codex can review it."))
        #expect(codex.sent.filter { $0.contains("I'll take the parser; Codex can review it.") }.count == 1)
    }

    /// Switching away from two heads must invalidate its pending timer. Otherwise the
    /// timer can create a new, disabled Codex partner after the switch has completed.
    @Test(arguments: ["switch", "disable", "stop"])
    func aHeldHeadCannotStartAfterItWasRemoved(_ action: String) async {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = await twoHeaded(fake, claimWait: 0.1)
        defer { bot.stop() }
        bot.send("Held before removing Codex")
        #expect(agent(fake, .codex) == nil)
        switch action {
        case "switch": await bot.switchEngine(to: .claude)
        case "disable": await bot.setHeads([.claude])
        default: bot.stop()
        }
        try? await Task.sleep(for: .milliseconds(250))
        #expect(agent(fake, .codex) == nil)
        #expect(bot.partner == nil)
    }

    /// Hearing its peer is context for the user's task, not a new app-owned task. The next
    /// user message must still extend that task instead of pausing and later resuming it.
    @Test(arguments: [false, true])
    func hearingAPeerKeepsTheUsersTaskMergeable(finalReply: Bool) async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = await twoHeaded(fake, claimWait: 600)
        defer { bot.stop() }
        bot.send("Fix the toolbar")
        let claude = try #require(agent(fake, .claude))
        claude.emit(.trace(.text("I'll take the toolbar.", parent: nil)))
        await eventually { agent(fake, .codex) != nil }
        let codex = try #require(agent(fake, .codex))
        if finalReply { codex.reply("I'll review the toolbar.") }
        else { codex.emit(.trace(.text("I'll review the toolbar.", parent: nil))) }
        await eventually { claude.sent.contains { $0.contains("I'll review the toolbar.") } }

        bot.send("And its border", to: .claude)
        let followup = try #require(claude.sent.last)
        #expect(followup.contains("I sent this in parts before you answered"))
        #expect(followup.contains("Fix the toolbar\n\nAnd its border"))
        #expect(!followup.contains(Bot.pauseNote))
        await eventually { claude.interrupts == 1 }
        claude.reply("Toolbar and border done.")
        await eventually({ !bot.isWorking }, timeout: 2)
        #expect(!claude.sent.contains(Bot.resumeNote))
    }

    /// A split message must keep the same lead and bounded wait, with every attachment and
    /// read marker retained, instead of starting the held head blind on the second part.
    @Test func splitMessagesKeepTheirLeadAndHeldContext() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = await twoHeaded(fake, claimWait: 600)
        defer { bot.stop() }
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-claim-images-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let files = [home.appending(path: "first.png"), home.appending(path: "second.png")]
        for file in files { try Data([0x89, 0x50, 0x4E, 0x47]).write(to: file) }
        bot.send("First part", files: [files[0]], replyingTo: nil)
        let claude = try #require(agent(fake, .claude))
        bot.send("Second part", files: [files[1]], replyingTo: nil)
        #expect(agent(fake, .codex) == nil)
        // Wait for the first, interrupted turn's error before finishing the merged task.
        await eventually { claude.interrupts == 1 }
        claude.emit(.trace(.text("I'll handle both parts; please review.", parent: nil)))
        await eventually { agent(fake, .codex) != nil }
        let codex = try #require(agent(fake, .codex))
        let delivered = try #require(codex.sent.first)
        #expect(delivered.contains("I'll handle both parts; please review."))
        #expect(delivered.contains("First part"))
        #expect(delivered.contains("Second part"))
        let userLines = bot.messages.filter { $0.role == .user }
        #expect(userLines.count == 2)
        let attachments = userLines.flatMap { $0.attachments ?? [] }
        #expect(codex.sentImages.first?.map(\.url) == attachments.map(\.url))
        #expect(userLines.allSatisfy { $0.seenBy == [.claude, .codex] })
        #expect(codex.sent.filter { $0.contains("First part") }.count == 1)
    }

    @Test(arguments: ["silent", "exit", "deadline"])
    func aHeldMessageStillReleasesWithoutAClaim(_ reason: String) async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = await twoHeaded(fake, claimWait: reason == "deadline" ? 0.1 : 600)
        defer { bot.stop() }
        bot.send("Waiting for a claim")
        let claude = try #require(agent(fake, .claude))
        switch reason {
        case "silent": claude.reply("<no-reply/>")
        case "exit": claude.emit(.exited(status: 1, stderr: "Failed before opening words"))
        default:
            // A new part must not replace the original deadline with a fresh, longer one.
            bot.claimWait = 600
            bot.send("One more part")
        }
        await eventually({ agent(fake, .codex) != nil }, timeout: 2)
        let codex = try #require(agent(fake, .codex))
        #expect(codex.sent.contains { $0.contains("Waiting for a claim") })
        if reason == "deadline" { #expect(codex.sent.first?.contains("One more part") == true) }
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
