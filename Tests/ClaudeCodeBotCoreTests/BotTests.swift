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
    private var _sentImages: [[ClaudeCodeBotCore.Attachment]] = []
    private var _finished = false

    init(_ launch: AgentLaunch, respond: @escaping @Sendable (String) -> String?) {
        self.launch = launch
        self.respond = respond
        (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
    }

    /// Full transport input, including the reaction snapshot (asserted by MessageReactionTests).
    var wireSent: [String] { lock.withLock { _sent } }
    /// Existing conversation tests inspect the message independently of reaction metadata.
    var sent: [String] { wireSent.map(Self.withoutReactionSnapshot) }

    private static func withoutReactionSnapshot(_ text: String) -> String {
        var text = text
        for header in ["(App: Current message reactions in this chat;", "(App: Message reactions.", "(App: Reactions changed since"] {
            text = withoutBlock(text, header: header)
        }
        // The id line each message from the chat carries.
        if let line = text.range(of: #"\n*\(App: message_id of this message: [0-9A-F-]{36}\)\n*"#, options: .regularExpression) {
            text.replaceSubrange(line, with: "\n\n")
        }
        return text.trimmingCharacters(in: .newlines)
    }

    /// `text` without a header line and the JSON line after it.
    private static func withoutBlock(_ text: String, header: String) -> String {
        guard let start = text.range(of: header),
              let headerEnd = text[start.lowerBound...].firstIndex(of: "\n") else { return text }
        let jsonStart = text.index(after: headerEnd)
        let jsonEnd = text[jsonStart...].firstIndex(of: "\n") ?? text.endIndex
        guard let data = String(text[jsonStart..<jsonEnd]).data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [[String: Any]] else { return text }
        let before = text[..<start.lowerBound].trimmingCharacters(in: .newlines)
        let after = text[jsonEnd...].trimmingCharacters(in: .newlines)
        return [before, after].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    var sentImages: [[ClaudeCodeBotCore.Attachment]] { lock.withLock { _sentImages } }
    var finished: Bool { lock.withLock { _finished } }

    /// What reached it, in order: "send" for a message, "interrupt" for an interrupt.
    private var _log: [String] = []
    var log: [String] { lock.withLock { _log } }

    func send(_ text: String) {
        lock.withLock {
            _sent.append(text)
            _log.append("send")
        }
        if let reply = respond(Self.withoutReactionSnapshot(text)) {
            continuation.yield(.reply(reply, isError: false))
        }
    }

    func send(_ text: String, images: [ClaudeCodeBotCore.Attachment]) {
        lock.withLock { _sentImages.append(images) }
        send(text)
    }

    /// The ids messages were sent under (like claude, which then reports their progress; the
    /// test emits `.commandQueued` / `.commandStarted` itself).
    private var _commands: [UUID] = []
    var commands: [UUID] { lock.withLock { _commands } }

    func send(_ text: String, images: [ClaudeCodeBotCore.Attachment], id: UUID) {
        lock.withLock { _commands.append(id) }
        send(text, images: images)
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

    private var _cancelledTasks: [Set<String>] = []
    var cancelledTasks: [Set<String>] { lock.withLock { _cancelledTasks } }
    func cancelTasks(_ ids: Set<String>) { lock.withLock { _cancelledTasks.append(ids) } }

    private var _interrupts = 0
    var interrupts: Int { lock.withLock { _interrupts } }

    private var _interruptEndsTurn = true
    /// False: the turn had already ended when the interrupt came, so no error result follows.
    var interruptEndsTurn: Bool {
        get { lock.withLock { _interruptEndsTurn } }
        set { lock.withLock { _interruptEndsTurn = newValue } }
    }

    /// Like claude: the turn ends with an error result.
    func interrupt() {
        let ends = lock.withLock {
            _interrupts += 1
            _log.append("interrupt")
            return _interruptEndsTurn
        }
        if ends { continuation.yield(.reply("", isError: true)) }
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
    /// For a bot with two heads: answers by engine (nil: `respond`).
    var respondFor: (@Sendable (BotEngine, String) -> String?)?

    var agents: [FakeAgent] { lock.withLock { _agents } }

    var launcher: AgentLauncher {
        { [self] launch in
            let answer: @Sendable (String) -> String?
            if let byEngine = respondFor {
                let engine = launch.engine
                answer = { text in byEngine(engine, text) }
            } else {
                answer = respond
            }
            let agent = FakeAgent(launch, respond: answer)
            lock.withLock { _agents.append(agent) }
            return agent
        }
    }
}

/// The prompts whose replies the chat never shows.
func isAppOnly(_ text: String) -> Bool {
    text.hasPrefix(BotPrompts.appLead) && !text.hasPrefix(BotPrompts.wakeLead)
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

    @Test(.wallClock) func idleBotKnowsWhenItWillSleep() async {
        let fake = FakeLauncher()
        let idle: TimeInterval = 60
        let bot = makeBot(fake, idle: idle)
        // The bot's own clock, not the wall clock read later: in a busy parallel run the test
        // gets the main actor back seconds after the reply set the time.
        let replied = Date()
        bot.now = { replied }
        #expect(bot.sleepsAt == nil)

        bot.send("hi")
        #expect(bot.sleepsAt == nil)
        await eventually { bot.sleepsAt != nil }
        #expect(bot.sleepsAt == replied.addingTimeInterval(idle))

        // A new message stops the clock until the reply.
        fake.respond = { _ in nil }
        bot.send("One more thing")
        #expect(bot.sleepsAt == nil)
    }

    @Test(.wallClock) func idleBotTidiesMemoryThenSleepsWithoutShowingIt() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 0.05)

        bot.send("hi")
        await eventually { bot.phase == .asleep && fake.agents.first?.finished == true }

        #expect(fake.agents[0].sent.last == bot.prompts.tidy)
        #expect(bot.messages.map(\.role) == [.user, .bot])
    }

    @Test(.wallClock) func nextMessageAfterSleepStartsAFreshSession() async throws {
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

    @Test(.wallClock) func switchRequestedMidTurnWaitsForTheReply() async {
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
        fake.respond = { text in text.hasPrefix(BotPrompts.tidyLead) ? nil : "Got it" }
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
