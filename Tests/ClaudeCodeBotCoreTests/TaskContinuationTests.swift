import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct TaskContinuationTests {
    let h = CodexManagedWorkerTests()

    func reportTurn() -> (CodexSession, String, CodexSessionTests.Out) {
        var (s, _) = h.ready()
        let start = CodexSessionTests.Out(s.send(.init(text: "When feature owners finish, integrate their changes into main and validate. Preserve dirty work.")))
        _ = h.response(h.write(start, "turn/start"), ["turn": ["id": "parent-1"]], &s)
        let handoff = h.tool(100, arguments: ["name": "main-integration",
            "instructions": "Prepare the manifest, resolve architecture handoff and resumed-session validation, then integrate into main after all owners deliver. Do not overwrite dirty work."], &s)
        let task = s.managedWorkerRecords.first!.id
        let worker = h.response(h.write(handoff, "thread/start"), ["thread": ["id": "worker"]], &s)
        _ = h.response(h.write(worker, "turn/start"), ["turn": ["id": "worker-1"]], &s)
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
        let evidence = ["complete": "Integration owner supplied the merged main commit and passing consolidated validation; all requested acceptance checks are satisfied.",
            "waiting_user": "The merge requires user approval of a destructive replacement; no replacement is authorized. User must choose whether to preserve or replace the conflicting file.",
            "blocked": "The integration worktree cannot be created: filesystem denied the requested path, and the authorized writable root is unavailable. No authorized alternative location exists."][outcome]!
        let decision = h.tool(103, name: "app_task_checkpoint", arguments: ["task_id": task,
            "outcome": outcome, "evidence": evidence], &s)
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
    @Test func reconciliationBudgetSurvivesPersistenceAndRestart() throws {
        var (s, _, _) = reportTurn()
        _ = finish(&s)
        let saved = s.managedWorkerRecords
        #expect(saved.first?.reconciliationAttempt == 1)
        #expect(saved.first?.reportPending == true)
        let encoded = try JSONEncoder().encode(saved)
        let records = try JSONDecoder().decode([CodexManagedWorkerRecord].self, from: encoded)
        var (restored, next) = h.ready(restored: records)
        #expect(try payload(next)["reconciliation_attempt"] as? Int == 1)
        _ = h.response(h.write(next, "turn/start"), ["turn": ["id": "summary"]], &restored)
        let end = finish(&restored)
        #expect(!end.methods.contains("turn/start"))
        #expect(end.replies.first?.1 == true)
    }

    @Test(arguments: ["", "   "])
    func emptyCheckpointCannotBypassReconciliation(evidence: String) throws {
        var (s, task, _) = reportTurn()
        let out = h.tool(107, name: "app_task_checkpoint", arguments: ["task_id": task,
            "outcome": "complete", "evidence": evidence], &s)
        #expect((out.writes.first?["result"] as? [String: Any])?["success"] as? Bool == false)
        #expect(try payload(finish(&s))["reconciliation_attempt"] as? Int == 1)
    }

    @Test func activeDependencyAllowsLegitimateWaitWithoutExecutionRetry() throws {
        var (s, task, _) = reportTurn()
        // The existing runtime can have another independently accepted owner already active.
        let accepted = h.tool(108, arguments: ["instructions": "Validate resumed-session rollout", "name": "rollout"], &s)
        let dependency = try #require(s.managedWorkerRecords.first { $0.id != task }?.id)
        #expect(accepted.params("thread/start") != nil)
        let out = h.tool(109, name: "app_task_checkpoint", arguments: ["task_id": task,
            "outcome": "waiting_dependency", "evidence": "Rollout owner is executing validation", "dependency_task_id": dependency], &s)
        #expect((out.writes.first?["result"] as? [String: Any])?["success"] as? Bool == true)
        #expect(!finish(&s).methods.contains("turn/start"))
    }

    @Test func wrongTaskCheckpointCannotConsumeAnotherOwnersReport() throws {
        var (s, _, _) = reportTurn()
        let out = h.tool(110, name: "app_task_checkpoint", arguments: ["task_id": "different-task",
            "outcome": "complete", "evidence": "Another feature passed its own checks"], &s)
        #expect((out.writes.first?["result"] as? [String: Any])?["success"] as? Bool == false)
        #expect(try payload(finish(&s))["reconciliation_attempt"] as? Int == 1)
    }

    @Test func finishingAllowsAcceptanceCheckpointButNoNewExecution() {
        var (s, task, _) = reportTurn()
        #expect(!CodexSessionTests.Out(s.finish()).closed)
        let dispatch = h.tool(111, name: "app_send_message", arguments: ["task_id": task,
            "message": "Start another execution"], &s)
        #expect((dispatch.writes.first?["result"] as? [String: Any])?["success"] as? Bool == false)
        let checkpoint = h.tool(112, name: "app_task_checkpoint", arguments: ["task_id": task,
            "outcome": "blocked", "evidence": "Session is finishing; no new execution may start. The requested merge is still unfulfilled."], &s)
        #expect((checkpoint.writes.first?["result"] as? [String: Any])?["success"] as? Bool == true)
        #expect(finish(&s).closed)
    }

}
