import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct PromiseCheckTests {
    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var _messages: [String] = []
        func add(_ message: String) { lock.withLock { _messages.append(message) } }
        var messages: [String] { lock.withLock { _messages } }
    }

    private func classifier(_ verdict: Bool, _ calls: Calls) -> PromiseCheck.Classifier {
        { message in calls.add(message); return verdict }
    }

    @Test func asksTheClassifierAboutTheReplyAlone() async {
        let calls = Calls()
        let promises = await PromiseCheck.check(.init(reply: "  好的，接下來我會確認測試結果再回報。\n", workPending: false), classify: classifier(true, calls))
        #expect(promises)
        #expect(calls.messages == ["好的，接下來我會確認測試結果再回報。"])
        #expect(await PromiseCheck.check(.init(reply: "Done: all tests pass.", workPending: false), classify: classifier(false, calls)) == false)
    }

    @Test func pendingWorkChoicesAndNothingSaidNeverAsk() async {
        let calls = Calls()
        #expect(await PromiseCheck.check(.init(reply: "I'll report back.", workPending: true), classify: classifier(true, calls)) == false)
        #expect(await PromiseCheck.check(.init(reply: "Which one?\n<choices>\n- A\n- B\n</choices>", workPending: false), classify: classifier(true, calls)) == false)
        #expect(await PromiseCheck.check(.init(reply: "  ", workPending: false), classify: classifier(true, calls)) == false)
        #expect(calls.messages.isEmpty)
    }

    @Test func errorsCountAsNo() async throws {
        let failing: PromiseCheck.Classifier = { _ in throw CocoaError(.executableLoad) }
        #expect(await PromiseCheck.check(.init(reply: "I'll check.", workPending: false), classify: failing) == false)
        #expect(throws: (any Error).self) { try PromiseCheck.parseVerdict("Error: rate limited") }
        #expect(throws: (any Error).self) { try PromiseCheck.parseVerdict("TOKEN BROKEN") }
        #expect(try PromiseCheck.parseVerdict("YES\n") == true)
        #expect(try PromiseCheck.parseVerdict("No") == false)
        #expect(try PromiseCheck.parseVerdict("NO.") == false)
    }

    @Test func theClassifierRunsHaikuWithoutToolsOrHooks() {
        let arguments = PromiseCheck.classifierArguments(message: "hi")
        #expect(arguments.contains(#"{"disableAllHooks":true}"#))
        #expect(arguments.firstIndex(of: "--tools").map { arguments[$0 + 1] } == "")
        #expect(arguments.firstIndex(of: "--model").map { arguments[$0 + 1] } == "haiku")
        #expect(arguments.firstIndex(of: "-p").map { arguments[$0 + 1] } == "<message>\nhi\n</message>")
        #expect(arguments.contains("--no-session-persistence"))
    }

    @Test func botSettingsHaveNoStopHook() throws {
        let launch = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp"), systemPrompt: "", allowRules: ["Bash(rm -rf build)"])
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        let json = try #require(arguments.firstIndex(of: "--settings").map { arguments[$0 + 1] })
        let settings = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        #expect(settings["hooks"] == nil)
        #expect((settings["permissions"] as? [String: Any])?["allow"] as? [String] == ["Bash(rm -rf build)"])
        #expect(!arguments.contains("--include-partial-messages"))
        // Without allow rules there are no flag settings at all.
        let plain = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp"), systemPrompt: "")
        #expect(!ClaudeAgentProcess.arguments(for: plain).contains("--settings"))
    }
}

/// The check as a bot runs it when a turn ends.
@MainActor
struct PromiseCheckBotTests {
    final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var _ends: [PromiseCheck.TurnEnd] = []
        func add(_ end: PromiseCheck.TurnEnd) { lock.withLock { _ends.append(end) } }
        var ends: [PromiseCheck.TurnEnd] { lock.withLock { _ends } }
    }

    private func bot(_ fake: FakeLauncher, says verdict: Bool, _ asked: Asked) -> Bot {
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.promiseCheck = { end in asked.add(end); return verdict }
        return bot
    }

    private func followUps(_ agent: FakeAgent) -> Int {
        agent.sent.filter { $0.contains(PromiseCheck.followUp) }.count
    }

    @Test func aYesSendsOneFollowUpAfterTheReplyShows() async throws {
        let fake = FakeLauncher()
        let asked = Asked()
        let bot = bot(fake, says: true, asked)
        bot.send("Check the build")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("I'll check the build and report back.")
        await eventually { agent.sent.count == 2 }
        // The reply showed first; only its words and the pending flag were asked about.
        #expect(bot.messages.map(\.text) == ["Check the build", "I'll check the build and report back."])
        #expect(asked.ends == [.init(reply: "I'll check the build and report back.", workPending: false)])
        #expect(agent.sent.last == PromiseCheck.followUp)
        #expect(bot.isWorking)

        // The follow-up's own reply, a promise again, is not checked: never twice in a row.
        agent.reply("I'll look again later.")
        await eventually { !bot.isWorking }
        try await Task.sleep(for: .milliseconds(100))
        #expect(asked.ends.count == 1)
        #expect(followUps(agent) == 1)
        #expect(bot.messages.last?.text == "I'll look again later.")

        // A new turn of yours is checked again.
        bot.send("And the tests?")
        await eventually { agent.sent.count == 3 }
        agent.reply("I'll run them next.")
        await eventually { followUps(agent) == 2 }
        #expect(asked.ends.count == 2)
    }

    @Test func aNoSendsNothing() async throws {
        let fake = FakeLauncher()
        let asked = Asked()
        let bot = bot(fake, says: false, asked)
        bot.send("hi")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("All tests pass.")
        await eventually { asked.ends.count == 1 }
        try await Task.sleep(for: .milliseconds(100))
        #expect(agent.sent.count == 1)
        #expect(followUps(agent) == 0)
        #expect(!bot.isWorking)
    }

    @Test func pendingBackgroundWorkSendsNothing() async throws {
        let fake = FakeLauncher()
        let asked = Asked()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        // The app's own checker: pending work never reaches the model.
        let calls = PromiseCheckTests.Calls()
        let checker = PromiseCheck.checker { message in calls.add(message); return true }
        bot.promiseCheck = { end in asked.add(end); return await checker(end) }
        bot.send("Build it")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.trace(.toolUse(id: "toolu_B", tool: "Bash", title: "Run swift build", detail: "swift build", parent: nil)))
        agent.emit(.trace(.backgroundCommandStarted(id: "toolu_B", description: "swift build")))
        agent.reply("Building in the background; I'll report when it's done.")
        await eventually { asked.ends.count == 1 }
        try await Task.sleep(for: .milliseconds(100))
        #expect(asked.ends.first?.workPending == true)
        #expect(calls.messages.isEmpty)
        #expect(followUps(agent) == 0)
    }

    @Test func aLateYesAfterYouWroteSendsNothing() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        let gate = AsyncStream<Void>.makeStream()
        bot.promiseCheck = { _ in
            for await _ in gate.stream { break }
            return true
        }
        bot.send("first")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("I'll check.")
        await eventually { !bot.isWorking }
        bot.send("second")
        await eventually { agent.sent.count == 2 }
        gate.continuation.yield()
        gate.continuation.finish()
        try await Task.sleep(for: .milliseconds(100))
        #expect(followUps(agent) == 0)
    }

    @Test func errorsAndQuestionsAreNotChecked() async throws {
        let fake = FakeLauncher()
        let asked = Asked()
        let bot = bot(fake, says: true, asked)
        bot.send("Pick one")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("Which one?\n<choices>\n- A\n- B\n</choices>")
        await eventually { !bot.isWorking }
        try await Task.sleep(for: .milliseconds(100))
        #expect(asked.ends.isEmpty)
        #expect(followUps(agent) == 0)
    }
}
