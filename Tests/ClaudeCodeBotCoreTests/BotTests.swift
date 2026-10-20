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

    /// What reached it, in order: "send" for a message, "interrupt" for an interrupt.
    private var _log: [String] = []
    var log: [String] { lock.withLock { _log } }

    func send(_ text: String) {
        lock.withLock {
            _sent.append(text)
            _log.append("send")
        }
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

    private var _interrupts = 0
    var interrupts: Int { lock.withLock { _interrupts } }

    /// Like claude: the turn ends with an error result.
    func interrupt() {
        lock.withLock {
            _interrupts += 1
            _log.append("interrupt")
        }
        continuation.yield(.reply("", isError: true))
    }

    /// Answers to permission requests: (request id, allowed, message).
    private var _answers: [(String, Bool, String?)] = []
    var answers: [(String, Bool, String?)] { lock.withLock { _answers } }

    func answer(_ request: PermissionRequest, allow: Bool, message: String?) {
        lock.withLock { _answers.append((request.id, allow, message)) }
    }

    /// Each set of permission rules it was told to allow from then on (apply_flag_settings).
    private var _allowedRules: [[String]] = []
    var allowedRules: [[String]] { lock.withLock { _allowedRules } }

    func allow(rules: [String]) {
        lock.withLock { _allowedRules.append(rules) }
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
/// Waits for `condition`. Generous by default: the whole suite runs in parallel on the main actor,
/// and on a small CI runner a test can wait many seconds for its turn. It returns as soon as the
/// condition holds, so a long limit only costs time when a test is failing anyway.
func eventually(_ condition: @MainActor () -> Bool, timeout: TimeInterval = 60, sourceLocation: SourceLocation = #_sourceLocation) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(for: .milliseconds(20))
    }
    #expect(condition(), sourceLocation: sourceLocation)
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

    @Test func nextMessageAfterSleepStartsAFreshSession() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 0.05)

        bot.send("hi")
        await eventually { bot.phase == .asleep && fake.agents.count == 1 }
        bot.send("Do you remember?")
        await eventually { bot.messages.count == 4 }

        try #require(fake.agents.count == 2)
        #expect(fake.agents[1].launch.sessionID != fake.agents[0].launch.sessionID)
        #expect(fake.agents[1].sent.first?.hasPrefix(bot.prompts.wake) == true)
    }

    /// With no transcript to resume (claude kept none), a model switch still writes a handoff,
    /// but only when the next message comes: an idle bot costs nothing.
    @Test func switchingModelWithoutATranscriptHandsOverBeforeTheNextMessage() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.sessionExists = { _, _ in false }

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        await bot.switchModel(to: .opus)

        #expect(bot.model == .opus)
        #expect(bot.phase == .awake)
        #expect(fake.agents.count == 1)
        #expect(!fake.agents[0].finished)
        #expect(bot.messages.map(\.role) == [.user, .bot])

        bot.send("next")
        await eventually { fake.agents.count == 2 && bot.messages.last?.role == .bot }
        #expect(bot.switchTarget == nil)
        #expect(fake.agents[0].sent.last == bot.prompts.handoff)
        #expect(fake.agents[0].finished)
        let fresh = try #require(fake.agents.last)
        #expect(fresh.launch.model == .opus)
        #expect(!fresh.launch.resume)
        #expect(fresh.sent == [bot.prompts.resume, "next"])
        // "OK" from the resume turn stays hidden; only the divider shows.
        #expect(bot.messages.map(\.role) == [.user, .bot, .user, .divider, .bot])
    }

    @Test func resumeReplyAfterHandoffDrawsItsChoicesAsButtons() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        let resume = bot.prompts.resume
        fake.respond = { text in
            guard text == resume else { return isAppOnly(text) ? "OK" : "Got it" }
            return """
            目前正在等你決定是否 push。

            <choices>
            * 現在 push ed1f2ad | 內容已審過
            - 先不 push，等你看過再說 | 本機保留
            </choices>
            """
        }

        bot.sessionExists = { _, _ in false }
        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        await bot.reloadPlugins()
        bot.send("again")
        await eventually { fake.agents.count == 2 && bot.messages.last?.text == "Got it" }

        let resumed = try #require(bot.messages.last { $0.choices != nil })
        #expect(resumed.role == .bot)
        #expect(resumed.text == "目前正在等你決定是否 push。")
        #expect(resumed.choices?.map(\.label) == ["現在 push ed1f2ad", "先不 push，等你看過再說"])
        #expect(resumed.choices?.first?.recommended == true)
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
        // The turn under way goes on; the next message is on the new model.
        #expect(bot.model == .opus)
        #expect(!fake.agents[0].finished)

        fake.agents[0].reply("All done")
        await eventually { !bot.isWorking && bot.phase == .awake }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(fake.agents.count == 1)
        #expect(bot.messages.map(\.role) == [.user, .bot])
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
