import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Codex thinks for a long while between tool calls; its reasoning summary shows as a step.
struct CodexReasoningTraceTests {
    let helper = CodexManagedWorkerTests()

    func steps(_ out: CodexSessionTests.Out) -> [TraceEvent] { out.traces }

    @Test func aFinishedReasoningSummaryIsAStep() {
        var (session, _) = helper.ready()
        helper.rootTurn(&session)
        let out = helper.item("root", "parent-1", ["type": "reasoning", "id": "rs1",
            "summary": ["**Planning the fix**\n\nLook at the parser first."], "content": []], &session)
        #expect(steps(out) == [
            .toolUse(id: "rs1", tool: "Thinking", title: "Planning the fix", detail: "", parent: nil),
            .toolResult(id: "rs1", output: "**Planning the fix**\n\nLook at the parser first.", failed: false, parent: nil),
        ])
    }

    @Test func anEmptySummaryShowsNothing() {
        var (session, _) = helper.ready()
        helper.rootTurn(&session)
        let out = helper.item("root", "parent-1", ["type": "reasoning", "id": "rs1", "summary": [], "content": []], &session)
        #expect(steps(out).isEmpty)
    }

    @Test func theFirstSummaryDeltaOpensAStepThatTheFinishedItemCloses() {
        var (session, _) = helper.ready()
        helper.rootTurn(&session)
        let delta: [String: Any] = ["method": "item/reasoning/summaryTextDelta",
            "params": ["threadId": "root", "turnId": "parent-1", "itemId": "rs1", "summaryIndex": 0, "delta": "**Plan"]]
        let first = helper.receive(delta, &session)
        #expect(steps(first) == [.toolUse(id: "rs1", tool: "Thinking", title: "Thinking…", detail: "", parent: nil)])
        // More deltas of the same item add nothing.
        #expect(steps(helper.receive(delta, &session)).isEmpty)
        let done = helper.item("root", "parent-1", ["type": "reasoning", "id": "rs1", "summary": ["**Plan** it"]], &session)
        #expect(steps(done) == [.toolResult(id: "rs1", output: "**Plan** it", failed: false, parent: nil)])
    }
}
