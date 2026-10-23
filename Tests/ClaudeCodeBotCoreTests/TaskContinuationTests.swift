import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct TaskContinuationTests {
    let h = CodexManagedWorkerTests()

    func reportTurn() -> (CodexSession, String, CodexSessionTests.Out) {
        var (s, _) = h.ready()
        h.rootTurn(&s)
        let (task, _) = h.launch(&s)
        _ = h.completed("root", "parent-1", &s)
        _ = h.item("worker", "worker-1", ["id": "prep", "type": "agentMessage", "phase": "final_answer",
            "text": "Bounded manifest preparation completed; main remains unmerged. Architecture handoff and resumed-session validation need an owner."], &s)
        let report = h.completed("worker", "worker-1", &s)
        _ = h.response(h.write(report, "turn/start"), ["turn": ["id": "summary"]], &s)
        return (s, task, report)
    }
    func finish(_ s: inout CodexSession, turn: String = "summary") -> CodexSessionTests.Out {
        _ = h.item("root", turn, ["id": "summary-\(turn)", "type": "agentMessage", "phase": "final_answer",
            "text": "All workers done. Waiting on architecture handoff; nothing running."], &s)
        return h.completed("root", turn, &s)
    }
    func payload(_ out: CodexSessionTests.Out) throws -> [String: Any] {
        let tool = try #require(out.params("turn/start")?["toolOutput"] as? [String: Any])
        let text = try #require(tool["output"] as? String)
        return try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    @Test func manifestCompletionIsOnlyWorkerTurnCompletionAndUnownedGateGetsOneReconciliation() throws {
        var (s, task, report) = reportTurn()
        let initial = try payload(report)
        #expect(initial["status"] as? String == "completed")
        #expect(initial["completion_scope"] as? String == "worker_turn")
        #expect(initial["objective_status"] as? String == "unverified")
        let next = finish(&s)
        let retry = try payload(next)
        #expect(retry["task_id"] as? String == task)
        #expect(retry["reconciliation_attempt"] as? Int == 1)
        #expect(next.events.contains(.backgroundTurnStarted))
    }

    @Test func sameOwnerFollowupStartsRealWorkerTurnAndStopsReconciliation() {
        var (s, task, _) = reportTurn()
        let followup = h.tool(102, name: "app_send_message", arguments: ["task_id": task,
            "message": "Resolve architecture delivery and resumed-session validation, then integrate; preserve dirty files."], &s)
        #expect(followup.params("turn/start")?["threadId"] as? String == "worker")
        #expect(s.managedWorkerRecords.first?.wasActive == true)
        #expect(!finish(&s).methods.contains("turn/start"))
    }

    @Test func reconciliationHasHardOneTurnLimit() throws {
        var (s, _, _) = reportTurn()
        let retry = finish(&s)
        _ = try #require(retry.params("turn/start"))
        _ = h.response(h.write(retry, "turn/start"), ["turn": ["id": "reconcile"]], &s)
        let end = finish(&s, turn: "reconcile")
        #expect(!end.methods.contains("turn/start"))
        #expect(end.events.contains { if case .reply(_, true) = $0 { true } else { false } })
    }

    @Test(arguments: ["complete", "waiting_user", "blocked"])
    func explicitEvidenceDispositionDoesNotAutoLoop(outcome: String) {
        var (s, task, _) = reportTurn()
        let decision = h.tool(103, name: "app_task_checkpoint", arguments: ["task_id": task,
            "outcome": outcome, "evidence": "Concrete acceptance result or exact missing permission/failure supplied here."], &s)
        #expect(decision.writes.first?["result"] as? [String: Any] != nil)
        #expect((decision.writes.first?["result"] as? [String: Any])?["success"] as? Bool == true)
        #expect(!finish(&s).methods.contains("turn/start"))
    }

    @Test func idleDependencyCannotPretendToBeAnActiveWait() throws {
        var (s, task, _) = reportTurn()
        let decision = h.tool(104, name: "app_task_checkpoint", arguments: ["task_id": task,
            "outcome": "waiting_dependency", "evidence": "Waiting for architecture owner", "dependency_task_id": task], &s)
        #expect((decision.writes.first?["result"] as? [String: Any])?["success"] as? Bool == false)
        #expect(try payload(finish(&s))["reconciliation_attempt"] as? Int == 1)
    }
}
