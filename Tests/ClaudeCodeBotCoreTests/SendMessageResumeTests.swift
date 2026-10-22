import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Lines as `claude -p --output-format stream-json --verbose` (2.1.304) wrote them for a bot that
/// sent a subagent off in the background, waited for it, then sent it more work with SendMessage,
/// trimmed to the fields the app reads. The resumed run's `task_started` and `task_notification`
/// name the SendMessage call, not the Agent call; its own calls still name the Agent call.
enum ResumeRun {
    static let agent = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"description":"Echo test","name":"echoer","prompt":"Run echo one, then reply HI","run_in_background":true}}]}}"#
    static let agentStarted = #"{"type":"system","subtype":"task_started","task_id":"a0b0","tool_use_id":"toolu_A","description":"Echo test","subagent_type":"general-purpose","is_backgrounded":true,"task_type":"local_agent","prompt":"Run echo one, then reply HI"}"#
    static let agentLaunched = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_A","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: a0b0 (internal ID)"}]}]},"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"a0b0","outputFile":"/tmp/ccb-probe/tasks/a0b0.output"}}"#
    static let echoOne = #"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"tool_use","id":"toolu_E1","name":"Bash","input":{"command":"echo one","description":"Print the word one"}}]}}"#
    static let echoOneDone = #"{"type":"user","parent_tool_use_id":"toolu_A","message":{"role":"user","content":[{"tool_use_id":"toolu_E1","type":"tool_result","content":"one"}]}}"#
    static let saysHi = #"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"HI"}]}}"#
    static let firstDone = #"{"type":"system","subtype":"task_notification","task_id":"a0b0","tool_use_id":"toolu_A","status":"completed","summary":"HI"}"#

    static func send(to target: String) -> String {
        #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_S","name":"SendMessage","input":{"to":"\#(target)","summary":"Say bye","message":"Now run echo two, then reply BYE"}}]}}"#
    }
    static let resumedStarted = #"{"type":"system","subtype":"task_started","task_id":"a0b0","tool_use_id":"toolu_S","description":"Echo test","subagent_type":"general-purpose","is_backgrounded":true,"task_type":"local_agent","prompt":"Now run echo two, then reply BYE"}"#
    static let resumed = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_S","type":"tool_result","content":[{"type":"text","text":"{\"success\":true,\"message\":\"Resuming agent echoer\",\"resumedAgentId\":\"a0b0\"}"}]}]},"tool_use_result":{"success":true,"message":"Resuming agent echoer","resumedAgentId":"a0b0","revivedAgentId":"a0b0","pin":{"id":"a0b0","name":"echoer","ref":"85f73f"}}}"#
    static let queued = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_S","type":"tool_result","content":[{"type":"text","text":"{\"success\":true}"}]}]},"tool_use_result":{"success":true,"message":"Message queued for delivery to a0b0 at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.","pin":{"id":"a0b0","name":"a0b0","ref":"7b88e5"}}}"#
    static let echoTwo = #"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"tool_use","id":"toolu_E2","name":"Bash","input":{"command":"echo two","description":"Print the word two"}}]}}"#
    static let echoTwoDone = #"{"type":"user","parent_tool_use_id":"toolu_A","message":{"role":"user","content":[{"tool_use_id":"toolu_E2","type":"tool_result","content":"two"}]}}"#
    static let saysBye = #"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"BYE"}]}}"#
    static let secondDone = #"{"type":"system","subtype":"task_notification","task_id":"a0b0","tool_use_id":"toolu_S","status":"completed","summary":"BYE"}"#

    static var firstRun: [String] { [agent, agentStarted, agentLaunched, echoOne, echoOneDone, saysHi, firstDone] }
}

@MainActor
struct SendMessageResumeTests {
    func replay(_ lines: [String], into book: inout TraceBook, at date: Date) {
        for line in lines {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: date) }
        }
    }

    /// SendMessage to a subagent that had finished resumes it: its own row is at work again (no
    /// second row), the message shows in its conversation where it came, the turn gets a chip,
    /// and the resumed run's notification ends both. By its agentId or by its name, with or
    /// without the resumed run's `task_started`.
    @Test(arguments: [("a0b0", true), ("echoer", true), ("a0b0", false), ("echoer", false)])
    func aSubagentResumedBySendMessageWorksAgainInItsOwnRow(target: String, started: Bool) {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        replay(ResumeRun.firstRun, into: &book, at: start)
        _ = book.takeTasks()
        _ = book.takeSteps()
        #expect(book.subagent("toolu_A")?.status == .completed)

        let later = start.addingTimeInterval(120)
        replay([ResumeRun.send(to: target)] + (started ? [ResumeRun.resumedStarted] : []) + [ResumeRun.resumed, ResumeRun.echoTwo, ResumeRun.echoTwoDone], into: &book, at: later)

        #expect(book.subagents.map(\.id) == ["toolu_A"])
        let agent = try! #require(book.subagent("toolu_A"))
        #expect(agent.isRunning)
        #expect(agent.endedAt == nil)
        #expect(book.listed(at: later).map(\.id) == ["toolu_A"])
        // In order: the first run, the bot's message, then what it did with it.
        #expect(agent.steps.map(\.kind) == [.tool, .text, .message, .tool])
        #expect(agent.steps[1].title == "HI")
        #expect(agent.steps[2].title == "Now run echo two, then reply BYE")
        #expect(agent.steps[2].detail == "Say bye")
        #expect(agent.steps[3].title == "Run echo two")
        // The chat's background work: the resumed run is a chip of this turn.
        let chips = book.tasks
        #expect(chips.map(\.id) == ["toolu_S"])
        #expect(chips.first?.kind == .agent)
        #expect(chips.first?.title == "Echo test")
        #expect(chips.first?.isRunning == true)
        // The SendMessage call reaches the same subagent.
        #expect(book.subagent("toolu_S")?.id == "toolu_A")

        replay([ResumeRun.saysBye, ResumeRun.secondDone], into: &book, at: later.addingTimeInterval(30))
        #expect(book.subagent("toolu_A")?.status == .completed)
        #expect(book.subagent("toolu_A")?.result == "BYE")
        #expect(book.tasks.first?.status == .completed)
    }

    /// The resumed run ends after the reply showed: the chip in that message ends too.
    @Test func theResumedRunsNotificationEndsTheChipInTheReply() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        replay(ResumeRun.firstRun, into: &book, at: start)
        _ = book.takeTasks()
        replay([ResumeRun.send(to: "a0b0"), ResumeRun.resumedStarted, ResumeRun.resumed], into: &book, at: start)
        var message = ChatMessage(role: .bot, text: "Sent it more work.")
        message.backgroundTasks = book.takeTasks()
        var messages = [message]
        let ended = messages.endBackgroundTask("toolu_S", status: "completed", summary: "BYE", at: start.addingTimeInterval(60))
        #expect(ended)
        #expect(messages[0].backgroundTasks?.first?.status == .completed)
    }

    /// A message queued for a subagent still at work: no second row and no new chip, but the
    /// message is in its conversation.
    @Test func aMessageQueuedForARunningSubagentShowsInItsConversation() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        replay([ResumeRun.agent, ResumeRun.agentStarted, ResumeRun.agentLaunched, ResumeRun.echoOne], into: &book, at: start)
        _ = book.takeTasks()
        replay([ResumeRun.send(to: "a0b0"), ResumeRun.queued], into: &book, at: start)
        #expect(book.subagents.map(\.id) == ["toolu_A"])
        #expect(book.subagent("toolu_A")?.isRunning == true)
        #expect(book.subagent("toolu_A")?.steps.last?.kind == .message)
        #expect(book.tasks.isEmpty)
    }

    /// A subagent the app does not know (sent off before it restarted): a row from what is known,
    /// at work until its notification.
    @Test func anUnknownSubagentResumedGetsARow() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        replay([ResumeRun.send(to: "a0b0"), ResumeRun.resumed], into: &book, at: start)
        let row = try! #require(book.listed(at: start).first)
        #expect(row.isRunning)
        #expect(row.description == "Say bye")
        #expect(row.steps.map(\.kind) == [.message])
        #expect(book.tasks.map(\.id) == ["toolu_S"])
        replay([ResumeRun.secondDone], into: &book, at: start.addingTimeInterval(10))
        #expect(book.subagent(row.id)?.status == .completed)
    }

    /// A message to another session (not a subagent) is no row.
    @Test func aMessageToAnotherSessionIsNoSubagent() {
        var book = TraceBook()
        let other = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_S","type":"tool_result","content":"{\"success\":true}"}]},"tool_use_result":{"success":true,"message":"sent to x-06","msg_id":"039c"}}"#
        replay([ResumeRun.send(to: "x-06"), other], into: &book, at: Date())
        #expect(book.subagents.isEmpty)
        #expect(book.tasks.isEmpty)
    }

    /// Opened, the subagent's conversation has the bot's message as a line from the bot, between
    /// what the first run said and what it did after.
    @Test func theSubagentsConversationShowsTheBotsMessage() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        replay(ResumeRun.firstRun + [ResumeRun.send(to: "echoer"), ResumeRun.resumedStarted, ResumeRun.resumed, ResumeRun.echoTwo, ResumeRun.echoTwoDone, ResumeRun.saysBye, ResumeRun.secondDone], into: &book, at: start)
        let subagent = try! #require(book.subagent("toolu_A"))
        let bot = makeBot(FakeLauncher())
        let payload = ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "")
        #expect(payload.messages.map(\.role) == ["user", "bot", "user", "bot"])
        #expect(payload.messages.map(\.text) == ["Run echo one, then reply HI", "HI", "Now run echo two, then reply BYE", "BYE"])
        #expect(payload.messages[2].speaker == bot.name)
        #expect(payload.messages[3].steps?.map(\.title) == ["Run echo two"])
    }
}
