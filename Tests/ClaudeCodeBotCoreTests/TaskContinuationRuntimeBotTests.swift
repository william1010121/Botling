import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct TaskContinuationRuntimeBotTests {
    @Test func realRuntimeReconciliationKeepsBotAwakeThenResumesSameOwner() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-continuation-\(UUID().uuidString)")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: .codex)
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        defer { bot.stop(); try? FileManager.default.removeItem(at: root) }
        bot.send("Integrate completed features into main after validation")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        func emit(_ out: CodexSessionTests.Out) { for e in out.events { agent.emit(e) } }
        let h = CodexManagedWorkerTests()
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let (task, launch) = h.launch(&session)
        emit(launch)
        emit(h.completed("root", "parent-1", &session))
        await eventually { !bot.isWorking && bot.trace.subagent(task)?.isRunning == true }
        _ = h.item("worker", "worker-1", ["id": "prep", "type": "agentMessage", "phase": "final_answer",
            "text": "Manifest prepared. Main is unmerged; no architecture owner is active."], &session)
        let report = h.completed("worker", "worker-1", &session)
        emit(report)
        _ = h.response(h.write(report, "turn/start"), ["turn": ["id": "summary"]], &session)
        await eventually { bot.isWorking && bot.trace.subagent(task)?.status == .completed }
        _ = h.item("root", "summary", ["id": "wrong", "type": "agentMessage", "phase": "final_answer",
            "text": "All done; waiting for architecture."], &session)
        let reconciliation = h.completed("root", "summary", &session)
        #expect(reconciliation.replies.isEmpty)
        #expect(reconciliation.events.contains(.backgroundTurnStarted))
        emit(reconciliation)
        _ = h.response(h.write(reconciliation, "turn/start"), ["turn": ["id": "decision"]], &session)
        let dispatched = h.tool(102, name: "app_send_message", arguments: ["task_id": task,
            "message": "Resolve remaining authorized gates and integrate with validation; preserve dirty work."], &session)
        emit(dispatched)
        #expect(dispatched.params("turn/start")?["threadId"] as? String == "worker")
        _ = h.item("root", "decision", ["id": "continued", "type": "agentMessage", "phase": "final_answer",
            "text": "The same integration owner is resolving the remaining gates."], &session)
        emit(h.completed("root", "decision", &session))
        await eventually { !bot.isWorking && bot.trace.subagent(task)?.isRunning == true }
        #expect(!bot.messages.contains { $0.text == "All done; waiting for architecture." })
        #expect(session.managedWorkerRecords.first?.run == 2)
        #expect(agent.sent.count == 1) // Runtime events, no duplicated Bot wakeup message.
    }
}
