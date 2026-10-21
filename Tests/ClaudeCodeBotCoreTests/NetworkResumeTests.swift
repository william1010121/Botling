import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A clock the tests move by hand.
@MainActor
final class TestClock {
    var date = Date(timeIntervalSince1970: 1_800_000_000)
    func advance(minutes: Double) { date = date.addingTimeInterval(minutes * 60) }
}

@MainActor
private func clockedBot(_ fake: FakeLauncher, clock: TestClock) -> Bot {
    let bot = makeBot(fake, idle: 600)
    bot.now = { clock.date }
    return bot
}

/// Starts a turn that does not answer by itself, so the test plays claude's side.
@MainActor
private func startQuietTurn(_ bot: Bot, _ fake: FakeLauncher, _ text: String = "Build the parser") async -> FakeAgent {
    fake.respond = { _ in nil }
    bot.send(text)
    await eventually { fake.agents.count == 1 && bot.isWorking }
    return fake.agents[0]
}

/// claude 2.1.304's lines when the API cannot be reached (a real `claude -p --output-format
/// stream-json` run with ANTHROPIC_BASE_URL on a closed port, trimmed to what the app reads).
enum LostConnectionRun {
    static let apiError = #"{"type":"assistant","message":{"id":"2c569111-0e31-434e-8389-0eb823f8560c","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","content":[{"type":"text","text":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"}]},"parent_tool_use_id":null,"error":"server_error","is_api_error_message":true}"#
    static let result = #"{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"terminal_reason":"api_error","result":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"}"#
}

struct NetworkErrorRecognitionTests {
    /// What decides is claude's structured API error: no HTTP status, filed as a server error
    /// or unknown, no typed kind but `no_response`. Its words do not matter.
    @Test func aTurnsAPIErrorWithNoAnswerIsAConnectionLoss() {
        #expect(StreamEvent.events(in: LostConnectionRun.apiError).first == .connectionLost(parent: nil))
        let reworded = LostConnectionRun.apiError.replacingOccurrences(of: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", with: "連不上伺服器")
        #expect(StreamEvent.events(in: reworded).first == .connectionLost(parent: nil))
        let noResponse = LostConnectionRun.apiError.replacingOccurrences(of: #""is_api_error_message":true"#, with: #""is_api_error_message":true,"api_error":"no_response""#)
        #expect(StreamEvent.events(in: noResponse).first == .connectionLost(parent: nil))
        // A subagent's: that subagent was cut off.
        let subagent = LostConnectionRun.apiError.replacingOccurrences(of: #""parent_tool_use_id":null"#, with: #""parent_tool_use_id":"toolu_1""#)
        #expect(StreamEvent.events(in: subagent).first == .connectionLost(parent: "toolu_1"))
    }

    @Test func anAPIErrorTheAPIAnsweredIsNot() {
        func lost(_ line: String) -> Bool { StreamEvent.events(in: line).contains { if case .connectionLost = $0 { true } else { false } } }
        // An HTTP status: the API answered (overloaded, a bad key), even in a connection's words.
        #expect(!lost(LostConnectionRun.apiError.replacingOccurrences(of: #""is_api_error_message":true"#, with: #""is_api_error_message":true,"api_error_status":529"#)))
        // Refused by the API's safeguards (real: no status, `invalid_request`).
        #expect(!lost(LostConnectionRun.apiError.replacingOccurrences(of: "server_error", with: "invalid_request")))
        // A typed kind that is not the network (an untrusted certificate, credentials).
        #expect(!lost(LostConnectionRun.apiError.replacingOccurrences(of: #""is_api_error_message":true"#, with: #""is_api_error_message":true,"api_error":"tls_untrusted_ca""#)))
        // Not an API error at all: the bot writing those words.
        #expect(!lost(LostConnectionRun.apiError.replacingOccurrences(of: #","error":"server_error","is_api_error_message":true"#, with: "")))
    }

    /// The words of a process's stderr and a subagent's report are all there is for those: the
    /// adapter reads them (real texts from claude 2.1.283–2.1.304).
    @Test func claudesConnectionErrorsCount() {
        #expect(ConnectionErrorText.isConnectionError("API Error: Connection error."))
        #expect(ConnectionErrorText.isConnectionError("API Error: Request timed out."))
        #expect(ConnectionErrorText.isConnectionError("API Error: Unable to connect to API (ECONNRESET)"))
        #expect(ConnectionErrorText.isConnectionError("\nAPI Error: getaddrinfo ENOTFOUND api.anthropic.com\nagentId: a1"))
        #expect(ConnectionErrorText.isConnectionError("API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"))
        #expect(ConnectionErrorText.isConnectionError("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"))
        #expect(ConnectionErrorText.isConnectionError("API Error: Connection lost mid-response. The response above may be incomplete."))
    }

    @Test func otherFailuresDoNot() {
        #expect(!ConnectionErrorText.isConnectionError("API Error: 529 {\"type\":\"overloaded_error\"}"))
        #expect(!ConnectionErrorText.isConnectionError("API Error: 401 Invalid API key"))
        #expect(!ConnectionErrorText.isConnectionError("API Error: Unable to connect to API: SSL certificate verification failed"))
        #expect(!ConnectionErrorText.isConnectionError(""))
        // A report that talks about connection errors is not one.
        #expect(!ConnectionErrorText.isConnectionError("Fixed it.\nThe old code showed API Error: Connection error. on timeouts"))
        #expect(ConnectionErrorText.mentionsConnectionError("Fixed it.\nAPI Error: Connection error."))
    }

    @Test func agentIDIsReadFromTheToolResult() {
        #expect(NetworkResume.agentID(in: "API Error: Connection error.\nagentId: a7f3c2e (use SendMessage with to: 'a7f3c2e')") == "a7f3c2e")
        #expect(NetworkResume.agentID(in: "Done.") == nil)
    }

    @Test func apiRetryWithoutAStatusIsConnectionTrouble() {
        let lost = #"{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1200,"error_status":null,"error":"unknown"}"#
        #expect(StreamEvent.events(in: lost) == [.connectionTrouble(attempt: 2, maxRetries: 10)])
        let overloaded = #"{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":529,"error":"overloaded"}"#
        #expect(StreamEvent.events(in: overloaded).isEmpty)
    }

    @Test func aLostSessionIsResumedByID() {
        let id = UUID()
        var launch = AgentLaunch(model: .sonnet, sessionID: id, workingDirectory: URL(filePath: "/tmp"), systemPrompt: "")
        #expect(ClaudeAgentProcess.arguments(for: launch).contains("--session-id"))
        launch.resume = true
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        #expect(!arguments.contains("--session-id"))
        let at = arguments.firstIndex(of: "--resume")
        #expect(at.map { arguments[$0 + 1] } == id.uuidString.lowercased())
    }

    @Test func aNewSubagentGetsItsPromptWithTheAddedLine() {
        let note = NetworkResume.resumeNote(elapsed: 51 * 60, carryOn: true, subagents: [
            .init(description: "Fix login", type: "general-purpose", prompt: "Work in /repo/.bot/worktrees/login. Fix the login bug.", agentID: "a1")
        ])
        #expect(note.contains("NEW subagent"))
        #expect(note.contains("Work in /repo/.bot/worktrees/login. Fix the login bug.\n這個任務剛剛被中斷了，請從 worktree 的現況接著做"))
        #expect(!note.contains("SendMessage"))
    }
}

@MainActor
struct NetworkResumeTests {
    @Test func aTurnLostToTheNetworkSaysSoAndWaitsAwake() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)

        agent.emit(.connectionTrouble(attempt: 1, maxRetries: 10))
        await eventually { bot.retryingConnection }
        agent.emit(.connectionLost(parent: nil))
        agent.emit(.reply("API Error: Connection error.", isError: true))
        await eventually { bot.outage != nil }

        #expect(!bot.isWorking)
        #expect(!bot.retryingConnection)
        #expect(bot.phase == .awake)
        #expect(bot.messages.last?.role == .error)
        #expect(bot.messages.last?.text.hasPrefix("網路中斷") == true)
        #expect(bot.outage?.turnFailed == true)
        #expect(bot.outage?.since == clock.date)
        // It does not tidy and fall asleep while it waits.
        #expect(bot.sleepsAt == nil)
        await bot.goToSleep()
        #expect(bot.phase == .awake)
        #expect(!agent.finished)
    }

    /// claude's real lines decide, whatever the result's words: an error result that only reads
    /// like a lost connection is an ordinary error.
    @Test func theStreamsStructuredErrorDecidesNotTheResultsWords() async {
        let fake = FakeLauncher()
        let bot = clockedBot(fake, clock: TestClock())
        let agent = await startQuietTurn(bot, fake)
        for line in [LostConnectionRun.apiError, LostConnectionRun.result.replacingOccurrences(of: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", with: "伺服器沒有回應")] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        await eventually { bot.outage != nil }
        #expect(bot.messages.last?.text.contains("伺服器沒有回應") == true)

        let other = FakeLauncher()
        let plain = clockedBot(other, clock: TestClock())
        let second = await startQuietTurn(plain, other)
        second.emit(.reply("API Error: Connection error.", isError: true))
        await eventually { plain.messages.last?.role == .error }
        #expect(plain.outage == nil)
    }

    @Test func backWithinFiftyMinutesTheSameSessionCarriesOn() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.connectionLost(parent: nil))
        agent.emit(.reply("API Error: Connection error.", isError: true))
        await eventually { bot.outage != nil }

        clock.advance(minutes: 49)
        bot.networkRestored(at: clock.date)

        #expect(bot.outage == nil)
        #expect(fake.agents.count == 1)
        #expect(bot.isWorking)
        let note = agent.sent.last ?? ""
        #expect(note.hasPrefix("(App: 網路中斷"))
        #expect(note.contains("Carry on with what you were doing"))
        #expect(bot.messages.last?.role == .divider)
        #expect(bot.messages.last?.text.contains("接著原本的工作") == true)
    }

    @Test func aSubagentCutOffWithinTheWindowIsContinued() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.trace(.toolUse(id: "toolu_1", tool: "Agent", title: "Delegate Fix login", detail: "Work in /repo/.bot/worktrees/login. Fix the login bug.", parent: nil)))
        agent.emit(.trace(.subagentStarted(id: "toolu_1", description: "Fix login", type: "general-purpose", prompt: "Work in /repo/.bot/worktrees/login. Fix the login bug.", background: false)))
        agent.emit(.trace(.toolUse(id: "toolu_2", tool: "Read", title: "Read a.swift", detail: "/repo/a.swift", parent: "toolu_1")))
        agent.emit(.trace(.toolResult(id: "toolu_1", output: "API Error: Connection error.\nagentId: a7f3c2e (use SendMessage with to: 'a7f3c2e' to continue this agent)", failed: false, parent: nil)))
        agent.emit(.connectionLost(parent: nil))
        agent.emit(.reply("API Error: Connection error.", isError: true))
        await eventually { bot.outage?.turnFailed == true }
        #expect(bot.outage?.subagents == ["toolu_1"])

        clock.advance(minutes: 20)
        bot.networkRestored(at: clock.date)
        let note = agent.sent.last ?? ""
        #expect(note.contains("SendMessage"))
        #expect(note.contains("agentId: a7f3c2e"))
        #expect(!note.contains(NetworkResume.restartLine + "\n</prompt>"))
    }

    @Test func aSubagentCutOffLongerAgoStartsOverWithTheAddedLine() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        let prompt = "Work in /repo/.bot/worktrees/login. Fix the login bug."
        agent.emit(.trace(.toolUse(id: "toolu_1", tool: "Agent", title: "Delegate Fix login", detail: prompt, parent: nil)))
        agent.emit(.trace(.toolResult(id: "toolu_1", output: "Async agent launched successfully. agentId: b2", failed: false, parent: nil)))
        agent.emit(.trace(.subagentStarted(id: "toolu_1", description: "Fix login", type: "general-purpose", prompt: prompt, background: true)))
        agent.reply("Started it.")
        await eventually { !bot.isWorking }
        // In the background, it fails on its own: the notification says why.
        agent.emit(.trace(.subagentEnded(id: "toolu_1", status: "failed", summary: "Agent \"Fix login\" failed:\nAPI Error: Unable to connect to API (ENOTFOUND)")))
        await eventually { bot.outage != nil }
        #expect(bot.outage?.turnFailed == false)
        #expect(bot.outage?.subagents == ["toolu_1"])

        clock.advance(minutes: 75)
        bot.networkRestored(at: clock.date)
        let note = agent.sent.last ?? ""
        #expect(note.contains("NEW subagent"))
        #expect(note.contains("subagent_type: general-purpose"))
        #expect(note.contains(prompt + "\n" + NetworkResume.restartLine))
        #expect(bot.messages.last?.text.contains("重新開始被中斷的子代理") == true)
    }

    @Test func aProcessThatDiedIsResumedWhileTheCacheIsWarm() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.exited(status: 1, stderr: "API Error: Connection error."))
        await eventually { bot.outage != nil }
        #expect(bot.phase == .asleep)
        #expect(bot.outage?.lostSession == agent.launch.sessionID)
        #expect(bot.messages.last?.text.hasPrefix("網路中斷") == true)

        clock.advance(minutes: 10)
        bot.networkRestored(at: clock.date)
        await eventually { fake.agents.count == 2 }
        let resumed = fake.agents[1]
        #expect(resumed.launch.resume)
        #expect(resumed.launch.sessionID == agent.launch.sessionID)
        #expect(resumed.sent.first?.hasPrefix("(App: 網路中斷") == true)
        #expect(bot.phase == .awake)
    }

    @Test func aProcessThatDiedLongAgoWakesFresh() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.exited(status: 1, stderr: "API Error: Request timed out."))
        await eventually { bot.outage != nil }

        clock.advance(minutes: 120)
        bot.networkRestored(at: clock.date)
        await eventually { fake.agents.count == 2 }
        let fresh = fake.agents[1]
        #expect(!fresh.launch.resume)
        #expect(fresh.launch.sessionID != agent.launch.sessionID)
        #expect(fresh.sent.first?.hasPrefix(bot.prompts.wake) == true)
        #expect(fresh.sent.first?.contains("Carry on with what you were doing") == true)
    }

    @Test func otherErrorsAreNotNetworkLoss() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.reply("API Error: 529 overloaded", isError: true))
        await eventually { !bot.isWorking }
        #expect(bot.outage == nil)
        #expect(bot.messages.last?.text == "API Error: 529 overloaded")
    }
}

@MainActor
struct StallReminderTests {
    @Test func aQuietTurnIsRemindedOncePerQuietSpell() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        let count = bot.messages.count

        clock.advance(minutes: 14)
        #expect(bot.checkStall(now: clock.date, after: 15 * 60).isEmpty)
        clock.advance(minutes: 2)
        #expect(bot.checkStall(now: clock.date, after: 15 * 60).count == 1)
        #expect(bot.messages.count == count + 1)
        #expect(bot.messages.last?.role == .notice)
        #expect(bot.messages.last?.text.contains("15 分鐘沒有新的步驟") == true)
        clock.advance(minutes: 30)
        #expect(bot.checkStall(now: clock.date, after: 15 * 60).isEmpty)

        // A new step starts a new spell.
        agent.emit(.trace(.toolUse(id: "t1", tool: "Read", title: "Read a", detail: "a", parent: nil)))
        await eventually { bot.liveSteps.count == 1 }
        clock.advance(minutes: 16)
        #expect(bot.checkStall(now: clock.date, after: 15 * 60).count == 1)
        // Off.
        clock.advance(minutes: 60)
        agent.emit(.trace(.toolUse(id: "t2", tool: "Read", title: "Read b", detail: "b", parent: nil)))
        await eventually { bot.liveSteps.count == 2 }
        clock.advance(minutes: 60)
        #expect(bot.checkStall(now: clock.date, after: 0).isEmpty)
    }

    @Test func aQuietSubagentIsNamed() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.trace(.subagentStarted(id: "toolu_9", description: "Run the tests", type: "general-purpose", prompt: "Run them", background: true)))
        agent.reply("Started.")
        await eventually { !bot.isWorking }

        clock.advance(minutes: 20)
        let lines = bot.checkStall(now: clock.date, after: 15 * 60)
        #expect(lines == ["子代理「Run the tests」已經 15 分鐘沒有新的步驟了。"])
    }

    @Test func noReminderWhileItWaitsForYouOrTheNetwork() async {
        let fake = FakeLauncher()
        let clock = TestClock()
        let bot = clockedBot(fake, clock: clock)
        let agent = await startQuietTurn(bot, fake)
        agent.emit(.permission(PermissionRequest(id: "r1", tool: "Bash", summary: "ls", input: "{}")))
        await eventually { bot.waitingForPermission }
        clock.advance(minutes: 30)
        #expect(bot.checkStall(now: clock.date, after: 15 * 60).isEmpty)

        let fake2 = FakeLauncher()
        let bot2 = clockedBot(fake2, clock: clock)
        let agent2 = await startQuietTurn(bot2, fake2)
        agent2.emit(.connectionLost(parent: nil))
        agent2.emit(.reply("API Error: Connection error.", isError: true))
        await eventually { bot2.outage != nil }
        clock.advance(minutes: 30)
        #expect(bot2.checkStall(now: clock.date, after: 15 * 60).isEmpty)
    }

    @Test func settingsDefaultToFifteenMinutes() throws {
        #expect(AppSettings().stallReminderInterval == 15 * 60)
        let old = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"developerMode":false}"#.utf8))
        #expect(old.stallReminderInterval == 15 * 60)
        var off = AppSettings()
        off.stallReminderMinutes = 0
        #expect(off.stallReminderInterval == 0)
    }
}

@MainActor
struct NetworkWatchTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-net-\(UUID().uuidString)")

    @Test func botsCarryOnOnlyOnceTheProbeReachesTheAPI() async {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let bot = workspace.mainBot
        fake.respond = { _ in nil }
        bot.send("hi")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].emit(.connectionLost(parent: nil))
        fake.agents[0].emit(.reply("API Error: Connection error.", isError: true))
        await eventually { bot.outage != nil }

        workspace.networkProbe = { false }
        await workspace.checkNetwork()
        #expect(bot.outage != nil)

        workspace.networkProbe = { true }
        await workspace.checkNetwork()
        #expect(bot.outage == nil)
        #expect(fake.agents[0].sent.last?.hasPrefix("(App: 網路中斷") == true)
    }
}
