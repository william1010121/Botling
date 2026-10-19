import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Stands in for `claude`: answers each message through `respond`, exits when stdin closes.
final class FakeAgent: AgentProcess, @unchecked Sendable {
    let launch: AgentLaunch
    let events: AsyncStream<AgentEvent>
    private let continuation: AsyncStream<AgentEvent>.Continuation
    private let respond: @Sendable (String) -> String?
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _finished = false

    init(_ launch: AgentLaunch, respond: @escaping @Sendable (String) -> String?) {
        self.launch = launch
        self.respond = respond
        (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
    }

    var sent: [String] { lock.withLock { _sent } }
    var finished: Bool { lock.withLock { _finished } }

    func send(_ text: String) {
        lock.withLock { _sent.append(text) }
        if let reply = respond(text) {
            continuation.yield(.reply(reply, isError: false))
        }
    }

    func reply(_ text: String) {
        continuation.yield(.reply(text, isError: false))
    }

    func emit(_ event: AgentEvent) {
        continuation.yield(event)
    }

    func finish() {
        lock.withLock { _finished = true }
        continuation.yield(.exited(status: 0, stderr: ""))
        continuation.finish()
    }

    func stop() {
        finish()
    }

    /// Answers to permission requests: (request id, allowed, message).
    private var _answers: [(String, Bool, String?)] = []
    var answers: [(String, Bool, String?)] { lock.withLock { _answers } }

    func answer(_ request: PermissionRequest, allow: Bool, message: String?) {
        lock.withLock { _answers.append((request.id, allow, message)) }
    }
}

final class FakeLauncher: @unchecked Sendable {
    private let lock = NSLock()
    private var _agents: [FakeAgent] = []
    var respond: @Sendable (String) -> String? = { text in
        isAppOnly(text) ? "OK" : "Got it"
    }

    var agents: [FakeAgent] { lock.withLock { _agents } }

    var launcher: AgentLauncher {
        { [self] launch in
            let agent = FakeAgent(launch, respond: respond)
            lock.withLock { _agents.append(agent) }
            return agent
        }
    }
}

/// The prompts whose replies the chat never shows.
func isAppOnly(_ text: String) -> Bool {
    text.hasPrefix("(App: ") && !text.hasPrefix("(App: You were just woken up")
}

@MainActor
/// Waits for `condition`. Generous by default: the whole suite runs in parallel on the main actor.
func eventually(_ condition: @MainActor () -> Bool, timeout: TimeInterval = 5) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(for: .milliseconds(20))
    }
    #expect(condition())
}

@MainActor
func makeBot(_ fake: FakeLauncher, idle: TimeInterval = 60) -> Bot {
    Bot(
        profile: .main(home: FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")),
        idleInterval: idle,
        launcher: fake.launcher
    )
}

@MainActor
struct BotTests {
    @Test func firstMessageWakesANewSessionThatReadsMemory() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        #expect(bot.phase == .asleep)

        bot.send("How is NotchDo doing?")
        await eventually { bot.messages.last?.role == .bot }

        #expect(bot.phase == .awake)
        #expect(!bot.isWorking)
        #expect(fake.agents.count == 1)
        #expect(fake.agents[0].launch.model == .sonnet)
        #expect(fake.agents[0].sent.first?.hasPrefix(bot.prompts.wake) == true)
        #expect(fake.agents[0].sent.first?.hasSuffix("How is NotchDo doing?") == true)
        #expect(bot.messages.map(\.role) == [.user, .bot])
    }

    @Test func idleBotKnowsWhenItWillSleep() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 60)
        #expect(bot.sleepsAt == nil)

        bot.send("hi")
        #expect(bot.sleepsAt == nil)
        await eventually { bot.sleepsAt != nil }
        let remaining = bot.sleepsAt!.timeIntervalSinceNow
        #expect(remaining > 55 && remaining <= 60)

        // A new message stops the clock until the reply.
        fake.respond = { _ in nil }
        bot.send("One more thing")
        #expect(bot.sleepsAt == nil)
    }

    @Test func idleBotTidiesMemoryThenSleepsWithoutShowingIt() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 0.05)

        bot.send("hi")
        await eventually { bot.phase == .asleep && fake.agents.first?.finished == true }

        #expect(fake.agents[0].sent.last == bot.prompts.tidy)
        #expect(bot.messages.map(\.role) == [.user, .bot])
    }

    @Test func nextMessageAfterSleepStartsAFreshSession() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 0.05)

        bot.send("hi")
        await eventually { bot.phase == .asleep && fake.agents.count == 1 }
        bot.send("Do you remember?")
        await eventually { bot.messages.count == 4 }

        #expect(fake.agents.count == 2)
        #expect(fake.agents[1].launch.sessionID != fake.agents[0].launch.sessionID)
        #expect(fake.agents[1].sent.first?.hasPrefix(bot.prompts.wake) == true)
    }

    @Test func switchingModelWritesHandoffStopsAndRestarts() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        await bot.switchModel(to: .opus)

        #expect(bot.model == .opus)
        #expect(bot.phase == .awake)
        #expect(bot.switchTarget == nil)
        #expect(fake.agents.count == 2)
        #expect(fake.agents[0].sent.last == bot.prompts.handoff)
        #expect(fake.agents[0].finished)
        #expect(fake.agents[1].launch.model == .opus)
        #expect(fake.agents[1].sent == [bot.prompts.resume])
        // "OK" from the resume turn stays hidden; only the divider shows.
        #expect(bot.messages.map(\.role) == [.user, .bot, .divider])
    }

    @Test func switchingWhileAsleepJustChangesTheNextSession() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)

        await bot.switchModel(to: .haiku)

        #expect(bot.model == .haiku)
        #expect(fake.agents.isEmpty)
        #expect(bot.messages.map(\.role) == [.divider])
    }

    @Test func switchRequestedMidTurnWaitsForTheReply() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let bot = makeBot(fake)

        bot.send("Do something long")
        await eventually { fake.agents.count == 1 }
        await bot.switchModel(to: .opus)
        #expect(bot.model == .sonnet)

        fake.agents[0].reply("All done")
        await eventually { bot.model == .opus && bot.phase == .awake }
        #expect(bot.messages.map(\.role) == [.user, .bot, .divider])
    }

    @Test func messageDuringTidyIsSentAfterSleeping() async {
        let fake = FakeLauncher()
        // Hold the tidy reply so a message can arrive mid-tidy.
        fake.respond = { text in text.hasPrefix("(App: You have been idle") ? nil : "Got it" }
        let bot = makeBot(fake, idle: 0.05)

        bot.send("hi")
        await eventually { bot.phase == .tidying }
        bot.send("Another thing")
        #expect(fake.agents[0].sent.count == 2)

        fake.agents[0].reply("OK")
        await eventually { fake.agents.count == 2 && bot.messages.last?.role == .bot }
        #expect(fake.agents[1].sent.first?.hasSuffix("Another thing") == true)
    }

    @Test func unexpectedExitPutsTheBotToSleepWithAnError() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)

        bot.send("hi")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].stop()
        await eventually { bot.phase == .asleep }
        #expect(!bot.isWorking)
    }

    @Test func historyAndModelSurviveARestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: directory), launcher: fake.launcher, store: BotStore(directory: directory))

        bot.send("hi")
        await eventually { bot.messages.count == 2 }
        await bot.switchModel(to: .haiku)

        let reopened = Bot(profile: .main(home: directory), launcher: fake.launcher, store: BotStore(directory: directory))
        #expect(reopened.messages.map(\.text).prefix(2) == ["hi", "Got it"])
        #expect(reopened.model == .haiku)
        #expect(reopened.phase == .asleep)
    }
}
