import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Lines as `claude -p --output-format stream-json --verbose` (2.1.303) wrote them for a bot that
/// ran a shell command and a subagent in the background, trimmed to the fields the app reads.
enum BackgroundRun {
    static let bash = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_B","name":"Bash","input":{"command":"swift test","description":"Run tests and build dev app","run_in_background":true}}]}}"#
    static let bashStarted = #"{"type":"system","subtype":"task_started","task_id":"bh62","tool_use_id":"toolu_B","description":"Run tests and build dev app","is_backgrounded":true,"task_type":"local_bash"}"#
    static let bashLaunched = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_B","type":"tool_result","content":"Command running in background with ID: bh62. Output is being written to: /tmp/ccb-probe/tasks/bh62.output. You will be notified when it completes. To check interim output, use Read on that file path.","is_error":false}]}}"#
    static let agent = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"description":"Review the diff","prompt":"Review it.","subagent_type":"general-purpose","run_in_background":true}}]}}"#
    static let agentStarted = #"{"type":"system","subtype":"task_started","task_id":"ab5d","tool_use_id":"toolu_A","description":"Review the diff","subagent_type":"general-purpose","is_backgrounded":true,"task_type":"local_agent","prompt":"Review it."}"#
    static let agentLaunched = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_A","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: ab5d (internal ID)\noutput_file: /tmp/ccb-probe/tasks/ab5d.output"}]}]}}"#
    static let agentDone = #"{"type":"system","subtype":"task_notification","task_id":"ab5d","tool_use_id":"toolu_A","status":"completed","output_file":"/tmp/ccb-probe/tasks/ab5d.output","summary":"Looks good."}"#
    static let bashFailed = #"{"type":"system","subtype":"task_notification","task_id":"bh62","tool_use_id":"toolu_B","status":"failed","output_file":"/tmp/ccb-probe/tasks/bh62.output","summary":"Background command \"Run tests and build dev app\" failed with exit code 2"}"#

    static var turn: [String] { [bash, bashStarted, bashLaunched, agent, agentStarted, agentLaunched] }
}

@MainActor
struct BackgroundTaskTests {
    @Test func aBackgroundCommandStartIsReadFromTheStream() {
        #expect(StreamEvent.events(in: BackgroundRun.bashStarted) == [.trace(.backgroundCommandStarted(id: "toolu_B", description: "Run tests and build dev app"))])
        // A foreground command that was never backgrounded is no chip.
        let foreground = BackgroundRun.bashStarted.replacingOccurrences(of: #""is_backgrounded":true"#, with: #""is_backgrounded":false"#)
        #expect(StreamEvent.events(in: foreground).isEmpty)
    }

    @Test func theLaunchResultNamesTheOutputFile() {
        #expect(BackgroundTask.outputFile(in: "Command running in background with ID: bh62. Output is being written to: /tmp/x/bh62.output. You will be notified when it completes.") == "/tmp/x/bh62.output")
        #expect(BackgroundTask.outputFile(in: "Async agent launched successfully.\nagentId: ab5d\noutput_file: /tmp/x/ab5d.output") == "/tmp/x/ab5d.output")
        #expect(BackgroundTask.outputFile(in: "hello") == nil)
    }

    @Test func aTurnCollectsItsBackgroundWorkAsChips() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        for line in BackgroundRun.turn {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: start) }
        }
        let tasks = book.takeTasks()
        #expect(tasks?.map(\.id) == ["toolu_B", "toolu_A"])
        #expect(tasks?.map(\.kind) == [.command, .agent])
        #expect(tasks?.map(\.title) == ["Run tests and build dev app", "Review the diff"])
        #expect(tasks?.allSatisfy { $0.status == .running && $0.startedAt == start } == true)
        #expect(tasks?[0].outputFile == "/tmp/ccb-probe/tasks/bh62.output")
        // Taken once.
        #expect(book.takeTasks() == nil)
    }

    @Test func aForegroundSubagentOrASubagentsOwnCommandIsNoChip() {
        var book = TraceBook()
        book.apply(.toolUse(id: "A", tool: "Agent", title: "Delegate x", detail: "x", parent: nil))
        book.apply(.subagentStarted(id: "A", description: "x", type: "general-purpose", prompt: "x", background: false))
        // A command the subagent itself sent to the background.
        book.apply(.toolUse(id: "S", tool: "Bash", title: "Run sleep", detail: "sleep 5", parent: "A"))
        book.apply(.backgroundCommandStarted(id: "S", description: "sleep"))
        #expect(book.takeTasks() == nil)
    }

    @Test func aNotificationEndsTheChipBeforeOrAfterTheReply() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        for line in BackgroundRun.turn {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: start) }
        }
        // The agent finishes while the turn is still on: its chip is already done.
        for case let .trace(event) in StreamEvent.events(in: BackgroundRun.agentDone) { book.apply(event, at: start.addingTimeInterval(65)) }
        var message = ChatMessage(role: .bot, text: "Started both.")
        message.backgroundTasks = book.takeTasks()
        #expect(message.backgroundTasks?[1].status == .completed)
        #expect(message.backgroundTasks?[1].summary == "Looks good.")
        #expect(message.backgroundTasks?[1].endedAt == start.addingTimeInterval(65))

        // The command fails after the reply showed: the message's chip says so.
        var messages = [ChatMessage(role: .user, text: "Go"), message]
        let ended = messages.endBackgroundTask("toolu_B", status: "failed", summary: "exit code 2", at: start.addingTimeInterval(845))
        #expect(ended)
        #expect(messages[1].backgroundTasks?[0].status == .failed)
        #expect(messages[1].backgroundTasks?[0].endedAt == start.addingTimeInterval(845))
        // Unknown ids and second notifications change nothing.
        let unknown = messages.endBackgroundTask("toolu_X", status: "completed", summary: nil, at: start)
        let second = messages.endBackgroundTask("toolu_B", status: "completed", summary: nil, at: start)
        #expect(!unknown && !second)
        #expect(BackgroundTask.Status(notification: "killed") == .killed)
        #expect(BackgroundTask.Status(notification: "stopped") == .killed)
        #expect(BackgroundTask.Status(notification: "error") == .failed)
    }

    @Test func runningChipsAreStoppedWhenTheProcessGoes() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Run the tests in the background")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in BackgroundRun.turn {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Started the tests and a review.")
        await eventually { bot.messages.last?.text == "Started the tests and a review." }
        #expect(bot.messages.last?.backgroundTasks?.map(\.status) == [.running, .running])

        // The review reports back (a turn of its own); its chip on the earlier reply is done.
        for event in StreamEvent.events(in: BackgroundRun.agentDone) { agent.emit(event) }
        await eventually { bot.messages.last { $0.backgroundTasks != nil }?.backgroundTasks?[1].status == .completed }

        // The process goes without the command ever reporting: it is not left spinning.
        agent.finish()
        await eventually { bot.messages.last { $0.backgroundTasks != nil }?.backgroundTasks?[0].status == .stopped }
        #expect(bot.messages.last { $0.backgroundTasks != nil }?.backgroundTasks?[1].status == .completed)
    }

    @Test func chipsStillRunningFromAnEarlierAppRunAreInterruptedAndTheBotIsToldOnce() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bgtask-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var message = ChatMessage(role: .bot, text: "Started.")
        var command = BackgroundTask(id: "B", kind: .command, title: "Run tests and build dev app", startedAt: Date(timeIntervalSince1970: 0))
        command.detail = "swift test && ./scripts/build-dev.sh"
        message.backgroundTasks = [
            command,
            BackgroundTask(id: "A", kind: .agent, title: "Review", status: .completed, startedAt: Date(timeIntervalSince1970: 0)),
        ]
        store.save(messages: [message])
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(bot.messages[0].backgroundTasks?.map(\.status) == [.interrupted, .completed])
        #expect(store.loadMessages()[0].backgroundTasks?.map(\.status) == [.interrupted, .completed])

        // Its next wake says which of its background work the restart killed, with the command.
        bot.send("Hi")
        await eventually { fake.agents.count == 1 && !fake.agents[0].sent.isEmpty }
        let wake = fake.agents[0].sent[0]
        #expect(wake.contains("Run tests and build dev app"))
        #expect(wake.contains("swift test && ./scripts/build-dev.sh"))
        #expect(!wake.contains("Review"))
        // Told once: saved, so a later restart does not tell it again.
        #expect(store.loadMessages()[0].backgroundTasks?[0].told == true)
        let again = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(again.messages[0].backgroundTasks?[0].status == .interrupted)
        #expect(Bot.interruptedNote(again.messages) == nil)
    }

    @Test func anIdleBotWithBackgroundWorkRunningStaysAwake() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Run the tests in the background")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in [BackgroundRun.bash, BackgroundRun.bashStarted, BackgroundRun.bashLaunched] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Started the tests.")
        await eventually { bot.messages.last?.text == "Started the tests." && !bot.isWorking }
        // Sleeping would kill the command: it waits for it.
        await bot.goToSleep()
        #expect(bot.phase == .awake)
        #expect(!agent.finished)
        for event in StreamEvent.events(in: BackgroundRun.bashFailed) { agent.emit(event) }
        await eventually { bot.messages.last { $0.backgroundTasks != nil }?.backgroundTasks?[0].status == .failed }
    }

    @Test func thePayloadCarriesChipsWithTheirTimes() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bgtask-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var message = ChatMessage(role: .bot, text: "Started.")
        var done = BackgroundTask(id: "B", kind: .command, title: "Run tests", startedAt: Date(timeIntervalSince1970: 100))
        done.status = .completed
        done.endedAt = Date(timeIntervalSince1970: 945)
        message.backgroundTasks = [done]
        store.save(messages: [message])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "data:bot" }
        let data = Data(payload.json().utf8)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let messages = try #require(object["messages"] as? [[String: Any]])
        let tasks = try #require(messages[0]["tasks"] as? [[String: Any]])
        #expect(tasks[0]["id"] as? String == "B")
        #expect(tasks[0]["kind"] as? String == "command")
        #expect(tasks[0]["title"] as? String == "Run tests")
        #expect(tasks[0]["status"] as? String == "completed")
        #expect(tasks[0]["started"] as? Double == 100_000)
        #expect(tasks[0]["ended"] as? Double == 945_000)
    }

    @Test func theTailOfAnOutputFileIsItsLastLines() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "ccb-tail-\(UUID().uuidString).output")
        let lines = (1...200).map { "line \($0)" }.joined(separator: "\n")
        try (lines + "\n\u{1B}[32mTest run with 12 tests passed\u{1B}[0m\nbuilding 10%\rbuilding 100%\n\n[exited with code 0]\n\n").write(to: file, atomically: true, encoding: .utf8)
        let tail = try #require(BackgroundTask.tail(of: file.path, lines: 4))
        #expect(tail == "line 200\nTest run with 12 tests passed\nbuilding 100%\n[exited with code 0]")
        #expect(BackgroundTask.tail(of: "/nonexistent/x.output") == nil)
    }

    @Test func expandingAChipShowsItsOutputOrWhatTheAgentIsDoing() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "ccb-out-\(UUID().uuidString).output")
        try "compiling\nTest run with 3 tests passed\n".write(to: file, atomically: true, encoding: .utf8)
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Go")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        let lines = BackgroundRun.turn.map { $0.replacingOccurrences(of: "/tmp/ccb-probe/tasks/bh62.output", with: file.path) }
        for line in lines {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.emit(.trace(.toolUse(id: "R", tool: "Read", title: "Read Diff.swift", detail: "/x/Diff.swift", parent: "toolu_A")))
        agent.reply("Started.")
        await eventually { bot.messages.last?.text == "Started." }
        let id = try #require(bot.messages.last?.id)
        let output = await bot.backgroundTaskOutput(messageID: id, taskID: "toolu_B")
        #expect(output == "compiling\nTest run with 3 tests passed")
        let doing = await bot.backgroundTaskOutput(messageID: id, taskID: "toolu_A")
        #expect(doing.contains("Read Diff.swift"))
        for event in StreamEvent.events(in: BackgroundRun.agentDone) { agent.emit(event) }
        await eventually { bot.messages.last { $0.backgroundTasks != nil }?.backgroundTasks?[1].status == .completed }
        let summary = await bot.backgroundTaskOutput(messageID: id, taskID: "toolu_A")
        #expect(summary == "Looks good.")
    }
}
