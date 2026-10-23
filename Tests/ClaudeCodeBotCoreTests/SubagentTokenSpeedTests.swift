import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct SubagentTokenSpeedTests {
    let start = Date(timeIntervalSince1970: 1_000)
    func apply(_ line: String, to book: inout TraceBook) {
        for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: start) }
    }
    @Test func claudeSnapshotsReplacePerMessageAndNeverUseInputOrTextLength() {
        var book = TraceBook(subagents: [Subagent(id: "child", description: "Test", prompt: "Go", startedAt: start)])
        func message(_ id: String, _ usage: String, parent: String = "child") -> String {
            #"{"type":"assistant","parent_tool_use_id":"\#(parent)","message":{"id":"\#(id)","content":[],"usage":\#(usage)}}"#
        }
        for (id, usage) in [("m1", #"{"input_tokens":10000,"output_tokens":20}"#), ("m1", #"{"output_tokens":40}"#), ("m1", #"{"output_tokens":40}"#), ("m2", #"{"output_tokens":10}"#)] {
            apply(message(id, usage), to: &book)
        }
        for usage in [#"{"input_tokens":99999}"#, #"{"output_tokens":null}"#, #"{"output_tokens":-1}"#, #"{"output_tokens":true}"#, #"{"output_tokens":1.5}"#] {
            apply(message("missing", usage), to: &book)
        }
        apply(message("foreign", #"{"output_tokens":900}"#, parent: "other"), to: &book)
        #expect(book.subagent("child")?.reportedOutputTokens == 50)
        #expect(book.subagent("child")?.outputTokenCounters?.count == 2)
        apply(#"{"type":"result","result":"Done","total_cost_usd":0,"usage":{"output_tokens":999}}"#, to: &book)
        #expect(book.subagent("child")?.reportedOutputTokens == 50)
    }
    @Test func completionAndReloadKeepCountersAndEpochMilliseconds() throws {
        var book = TraceBook(subagents: [Subagent(id: "child", description: "Test", prompt: "Go", startedAt: start)])
        let changed = book.apply(.subagentOutput(id: "child", counter: "m1", tokens: 100), at: start)
        let repeated = book.apply(.subagentOutput(id: "child", counter: "m1", tokens: 100), at: start)
        #expect(changed)
        #expect(!repeated)
        book.apply(.subagentEnded(id: "child", status: "completed", summary: "Done"), at: start.addingTimeInterval(4))
        let child = try #require(book.subagent("child"))
        let loaded = try JSONDecoder().decode(Subagent.self, from: JSONEncoder().encode(child))
        let header = ChatPayload.make(subagent: loaded, of: makeBot(FakeLauncher()), components: nil, avatar: "").subagent
        #expect(header?.outputTokens == 100)
        #expect(header?.startedAt == 1_000_000)
        #expect(header?.endedAt == 1_004_000)
        book.apply(.subagentStarted(id: "child", description: "", type: nil, prompt: "", background: false), at: start.addingTimeInterval(10))
        book.apply(.subagentOutput(id: "child", counter: "m2", tokens: 50), at: start.addingTimeInterval(11))
        #expect(book.subagent("child")?.reportedOutputTokens == 150)
        #expect(book.subagent("child")?.startedAt == start)
        #expect(book.subagent("child")?.endedAt == nil)
    }
    @Test func oldAndZeroCountersAreDistinctAndMalformedCountsAreUnavailable() throws {
        let json = #"{"id":"child","description":"Test","prompt":"Go","status":"completed","background":false,"startedAt":0,"steps":[]}"#
        var child = try JSONDecoder().decode(Subagent.self, from: Data(json.utf8))
        #expect(child.reportedOutputTokens == nil)
        child.outputTokenCounters = ["m": 0]
        #expect(child.reportedOutputTokens == 0)
        child.outputTokenCounters = ["m": -1]
        #expect(child.reportedOutputTokens == nil)
        let invalid: [Any] = [true, -1, 1.1, Double.infinity, Double.nan, Double(Int.max), "100"]
        for value in invalid { #expect(SubagentTokenCounter.read(value) == nil) }
    }
}

extension CodexSessionTests {
    @Test func childThreadUsageUsesItsTotalOnceNotLastOrParentTotals() {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        _ = codex.receive(#"{"id":3,"result":{"turn":{"id":"t1","items":[],"status":"inProgress"}}}"#)
        let main = "01a1640c-e2db-7742-998a-553a14d4336f"
        let spawn = #"{"method":"item/completed","params":{"threadId":"\#(main)","turnId":"t1","item":{"type":"collabAgentToolCall","id":"spawn","tool":"spawnAgent","prompt":"Go","receiverThreadIds":["child"],"agentsStates":{"child":{"status":"running"}},"status":"completed"}}}"#
        var book = TraceBook()
        for event in Out(codex.receive(spawn)).traces { book.apply(event) }
        func usage(_ total: String) -> String {
            #"{"method":"thread/tokenUsage/updated","params":{"threadId":"child","tokenUsage":{"total":\#(total),"last":{"outputTokens":9999}}}}"#
        }
        for total in [#"{"inputTokens":9999,"outputTokens":30}"#, #"{"outputTokens":30}"#, #"{"outputTokens":50}"#] {
            let output = Out(codex.receive(usage(total)))
            #expect(output.traces.count == 1)
            for event in output.traces { book.apply(event) }
        }
        #expect(book.subagent("spawn")?.reportedOutputTokens == 50)
        for total in [#"{"inputTokens":1000}"#, #"{"outputTokens":null}"#, #"{"outputTokens":-4}"#] {
            #expect(Out(codex.receive(usage(total))).traces.isEmpty)
        }
        let completed = #"{"method":"turn/completed","params":{"threadId":"child","turn":{"id":"s1","status":"completed","items":[]}}}"#
        for event in Out(codex.receive(completed)).traces { book.apply(event, at: Date(timeIntervalSince1970: 2000)) }
        for event in Out(codex.receive(usage(#"{"outputTokens":60}"#))).traces { book.apply(event) }
        #expect(book.subagent("spawn")?.reportedOutputTokens == 60)
        #expect(book.subagent("spawn")?.endedAt == Date(timeIntervalSince1970: 2000))
        #expect(book.subagent("spawn")?.isRunning == false)
    }
}
