import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A background subagent that hands its report back (SubagentHandback), as claude 2.1.304
/// streams it: the lines below are from a real `claude -p --output-format stream-json` run
/// (sonnet, auto mode), trimmed of usage fields.
enum HandbackRun {
    static let spawn = #"{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Qx2S6cTaNhG292edWkEgzm","name":"Agent","input":{"description":"Send pending handback","prompt":"Your whole task: call your SubagentHandback tool with message \"pending\" (that is your whole final report). Do nothing else.","subagent_type":"general-purpose","run_in_background":true},"caller":{"type":"direct"}}],"stop_reason":null},"parent_tool_use_id":null}"#
    static let started = #"{"type":"system","subtype":"task_started","task_id":"a1da74024fe43096d","tool_use_id":"toolu_01Qx2S6cTaNhG292edWkEgzm","description":"Send pending handback","subagent_type":"general-purpose","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent","prompt":"Your whole task: call your SubagentHandback tool with message \"pending\" (that is your whole final report). Do nothing else."}"#
    static let launched = #"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Qx2S6cTaNhG292edWkEgzm","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: a1da74024fe43096d (internal ID - do not mention to user.)"}]}]},"parent_tool_use_id":null,"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"a1da74024fe43096d","description":"Send pending handback","resolvedModel":"claude-sonnet-5-5","prompt":"Your whole task.","outputFile":"/tmp/tasks/a1da74024fe43096d.output","canReadOutputFile":true,"canContinueAgent":true}}"#
    static let sentText = #"{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"sent"}],"stop_reason":null},"parent_tool_use_id":null}"#
    static let sentResult = #"{"duration_api_ms":5091,"stop_reason":"end_turn","total_cost_usd":0.17957620000000002,"terminal_reason":"completed","safety_stops":0,"is_error":false,"num_turns":2,"subtype":"success","api_error_status":null,"result":"sent","type":"result","duration_ms":5287,"queued_turn_count":0,"result_index":0}"#
    /// The subagent called SubagentHandback: claude tells the bot it finished, with the report.
    static let notification = #"{"type":"system","subtype":"task_notification","task_id":"a1da74024fe43096d","tool_use_id":"toolu_01Qx2S6cTaNhG292edWkEgzm","status":"completed","summary":"This agent's report was delivered to you as a message from \"a1da74024fe43096d\" (its SubagentHandback call). Read it there; it is not repeated here.\n","handback":"send","handback_report":{"text":"pending"}}"#
    /// The turn the hand-back (a peer message) starts: the bot judged "pending" not worth saying.
    static let noReplyText = #"{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"<no-reply/>"}],"stop_reason":null},"parent_tool_use_id":null}"#
    static let noReplyResult = #"{"duration_api_ms":9258,"stop_reason":"end_turn","total_cost_usd":0.2670094,"terminal_reason":"completed","origin":{"kind":"peer","from":"a1da74024fe43096d","senderTaskId":"a1da74024fe43096d","name":"general-purpose","body":"The report follows:\n  pending","handback":true,"handbackReportText":"pending"},"safety_stops":0,"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"<no-reply/>","type":"result","duration_ms":1765,"queued_turn_count":0,"result_index":1}"#
    /// The task-notification itself, taken into the transcript only (its report came as the
    /// hand-back): no turn runs, but claude still writes a result line, with no words.
    static let turnlessResult = #"{"is_error":false,"duration_api_ms":0,"num_turns":0,"stop_reason":null,"total_cost_usd":0.2670094,"origin":{"kind":"task-notification","producer":"session-task","runId":"0mvj96klw-542e1431"},"safety_stops":0,"subtype":"success","result":"","type":"result","duration_ms":4,"queued_turn_count":0,"result_index":2}"#

    static let id = "toolu_01Qx2S6cTaNhG292edWkEgzm"
}

@MainActor
struct WakeReportTests {
    private func emit(_ lines: [String], to agent: FakeAgent) {
        for line in lines {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
    }

    /// Sends the subagent off and waits for that turn to end; returns the agent.
    private func sendOff(_ bot: Bot, _ fake: FakeLauncher) async -> FakeAgent {
        bot.send("把兩個測試合併成一個")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        emit([HandbackRun.spawn, HandbackRun.started, HandbackRun.launched, HandbackRun.sentText, HandbackRun.sentResult], to: agent)
        await eventually { bot.messages.last?.text == "sent" && !bot.isWorking }
        return agent
    }

    @Test func aTurnlessResultIsNoReply() {
        // No turn ran (num_turns 0, no words): not a reply. Its cost still counts.
        #expect(StreamEvent.events(in: HandbackRun.turnlessResult).allSatisfy { if case .reply = $0 { false } else { true } })
        #expect(StreamEvent.events(in: HandbackRun.noReplyResult).contains(.reply("<no-reply/>", isError: false)))
        // A hand-back's notification carries the report itself, not "delivered as a message".
        #expect(StreamEvent.events(in: HandbackRun.notification) == [.trace(.subagentEnded(id: HandbackRun.id, status: "completed", summary: "pending"))])
    }

    /// CSIT, 2026-10-22 15:11: the subagent handed back "pending", the bot answered
    /// `<no-reply/>`, and claude's result for the task-notification (no turn, no words) drew an
    /// empty bubble. The user heard nothing until asking 40 minutes later.
    @Test func aFinishedSubagentAnsweredWithNoReplyStillReachesTheUser() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) && !text.contains("<no-reply/>") ? "OK" : nil }
        let agent = await sendOff(bot, fake)
        let shown = bot.messages.count

        emit([HandbackRun.notification, HandbackRun.noReplyText, HandbackRun.noReplyResult, HandbackRun.turnlessResult], to: agent)
        // The app asks it once to report what the finished subagent did.
        await eventually { agent.sent.contains { $0.contains("<no-reply/>") && $0.contains("Send pending handback") } }
        #expect(!bot.messages.contains { $0.role == .bot && $0.text.isEmpty && $0.steps == nil && $0.displays == nil })
        #expect(bot.messages.count == shown)

        agent.emit(.trace(.text("合併好了，71 行。", parent: nil)))
        agent.reply("合併好了，71 行。")
        await eventually { bot.messages.last?.text == "合併好了，71 行。" }
        #expect(bot.messages.count == shown + 1)
        try? await Task.sleep(for: .milliseconds(50))
        // Asked once only.
        #expect(agent.sent.filter { $0.contains("Send pending handback") }.count == 1)
    }

    /// Asked to report, it still says nothing: the app says the subagent finished itself.
    @Test func aSubagentThatStaysUnreportedGetsANotice() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in
            if text.contains("Send pending handback") { return "<no-reply/>" }
            return isAppOnly(text) ? "OK" : nil
        }
        let agent = await sendOff(bot, fake)
        let shown = bot.messages.count

        emit([HandbackRun.notification, HandbackRun.noReplyText, HandbackRun.noReplyResult, HandbackRun.turnlessResult], to: agent)
        await eventually { bot.messages.count == shown + 1 }
        let notice = bot.messages.last
        #expect(notice?.role == .notice)
        #expect(notice?.text.contains("Send pending handback") == true)
        #expect(notice?.text.contains("pending") == true)
        #expect(!bot.messages.contains { $0.role == .bot && $0.text.isEmpty && $0.steps == nil })
        await eventually { !bot.isWorking }
    }

    /// A notification that says the subagent is still waiting on its own work is no news: no
    /// prompt to report, no notice.
    @Test func anInterimWakeStaysQuiet() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let agent = await sendOff(bot, fake)
        let shown = bot.messages.count
        let sent = agent.sent.count
        let waiting = #"{"type":"system","subtype":"task_notification","task_id":"a1da74024fe43096d","tool_use_id":"toolu_01Qx2S6cTaNhG292edWkEgzm","status":"completed","summary":"Agent \"Send pending handback\" is waiting on its own background work"}"#
        emit([waiting, HandbackRun.noReplyText, HandbackRun.noReplyResult], to: agent)
        await eventually { !bot.isWorking }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(bot.messages.count == shown)
        #expect(agent.sent.count == sent)
    }
}
