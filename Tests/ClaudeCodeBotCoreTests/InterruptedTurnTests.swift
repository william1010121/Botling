import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A turn cut off before it answered (you wrote again, it was paused for you, its process went
/// away, the app quit) keeps what it said and did so far as a bubble in the chat, marked as
/// interrupted, instead of the live bubble just vanishing.
@MainActor
struct InterruptedTurnTests {
    /// Words, a tool call, and more words: the last words are the partial reply.
    private func work(_ agent: FakeAgent) {
        agent.emit(.trace(.text("Let me look at the file.", parent: nil)))
        agent.emit(.trace(.toolUse(id: "t1", tool: "Read", title: "Read main.swift", detail: "main.swift", parent: nil)))
        agent.emit(.trace(.toolResult(id: "t1", output: "print(1)", failed: false, parent: nil)))
        agent.emit(.trace(.text("Found it: the bug is in", parent: nil)))
    }

    private func kept(_ bot: Bot) -> ChatMessage? {
        bot.messages.first { $0.role == .bot && $0.interrupted == true }
    }

    @Test func whatItHadSaidStaysWhenYouAddToYourMessage() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("Fix the crash")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        work(agent)
        await eventually { bot.liveSteps.count == 3 }

        bot.send("and the warning")
        #expect(agent.interrupts == 1)
        let partial = try #require(kept(bot))
        #expect(partial.text == "Found it: the bug is in")
        #expect(partial.steps?.map(\.title) == ["Let me look at the file.", "Read main.swift"])
        #expect(partial.engine == .claude)
        // It goes where it was said: before the line that cut it off.
        #expect(bot.messages.map(\.text) == ["Fix the crash", "Found it: the bug is in", "and the warning"])

        // The stopped turn's error and the merged turn's answer do not repeat it.
        agent.reply("Fixed both.")
        await eventually { bot.messages.last?.text == "Fixed both." }
        #expect(bot.messages.map(\.role) == [.user, .bot, .user, .bot])
        #expect(bot.messages.last?.interrupted == nil)
        #expect(bot.messages.last?.steps == nil)
        #expect(!bot.messages.contains { $0.role == .error })
    }

    /// The turn had ended before the interrupt reached it: its own result is the whole reply,
    /// so the kept part gives way to it (no second copy of the same words and steps).
    @Test func aTurnThatEndedAnywayIsNotShownTwice() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("Fix the crash")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.interruptEndsTurn = false
        work(agent)
        await eventually { bot.liveSteps.count == 3 }

        bot.send("and the warning")
        #expect(kept(bot) != nil)
        agent.reply("Found it: the bug is in main.swift.")
        await eventually { bot.messages.last?.text == "Found it: the bug is in main.swift." }
        #expect(kept(bot) == nil)
        #expect(bot.messages.filter { $0.role == .bot }.count == 1)
        #expect(bot.messages.last?.steps?.map(\.title) == ["Let me look at the file.", "Read main.swift"])
    }

    @Test func workItWasHandedKeepsItsStepsWhenItPausesForYou() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.relay("Fix the login page")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        work(agent)
        await eventually { bot.liveSteps.count == 3 }

        bot.send("How is it going?")
        #expect(agent.interrupts == 1)
        let partial = try #require(kept(bot))
        #expect(partial.steps?.map(\.title) == ["Let me look at the file.", "Read main.swift"])
        #expect(bot.messages.last?.text == "How is it going?")
    }

    /// Nothing said and nothing done yet: no empty bubble.
    @Test func aTurnWithNothingYetLeavesNoBubble() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("Fix the crash")
        await eventually { fake.agents.count == 1 }
        bot.send("and the warning")
        #expect(fake.agents[0].interrupts == 1)
        #expect(kept(bot) == nil)
        #expect(bot.messages.map(\.role) == [.user, .user])
    }

    @Test(arguments: [BotEngine.claude, .codex])
    func whatItHadDoneStaysWhenItsProcessDies(_ engine: BotEngine) async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        if engine == .codex { await bot.switchEngine(to: .codex) }
        bot.send("Fix the crash")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        work(agent)
        await eventually { bot.liveSteps.count == 3 }

        agent.emit(.exited(status: 1, stderr: "killed"))
        await eventually { bot.phase == .asleep }
        let partial = try #require(kept(bot))
        #expect(partial.text == "Found it: the bug is in")
        #expect(partial.steps?.map(\.title) == ["Let me look at the file.", "Read main.swift"])
        #expect(partial.engine == engine)
        // Saved with the chat, so it is there after the app restarts.
        #expect(store.loadMessages().contains { $0.id == partial.id && $0.interrupted == true })
    }

    /// The app quits while it works: the process is ended with it, before its exit is read.
    @Test func whatItHadDoneStaysWhenTheAppQuits() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        bot.send("Fix the crash")
        await eventually { fake.agents.count == 1 }
        work(fake.agents[0])
        await eventually { bot.liveSteps.count == 3 }

        bot.keepTurnSoFar()
        #expect(store.loadMessages().contains { $0.interrupted == true && $0.text == "Found it: the bug is in" })
        #expect(bot.liveSteps.isEmpty)
        // Kept once.
        bot.keepTurnSoFar()
        #expect(bot.messages.filter { $0.interrupted == true }.count == 1)
    }

    @Test func theChatSaysItWasInterrupted() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")
        let store = BotStore(directory: home)
        var message = ChatMessage(role: .bot, text: "Found it")
        message.interrupted = true
        store.save(messages: [message, ChatMessage(role: .bot, text: "Done")])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        let json = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "data:bot" }.json()
        let object = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let messages = try #require(object["messages"] as? [[String: Any]])
        #expect(messages.first?["interrupted"] as? Bool == true)
        #expect(messages.last?["interrupted"] == nil)
    }
}
