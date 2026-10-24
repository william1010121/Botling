import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct WorkerDependencyVerificationTests {
    /// Synthetic equivalent of the supplied screenshot: a real live transport snapshot,
    /// 2,515-character task, verbose history, and a delivered delegation reply.
    @Test func longTaskPreservesLiveStateAndCallbackInsteadOfUnknown() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in
            calls.add(input)
            let data = try JSONSerialization.jsonObject(with: Data(input.utf8)) as! [String: Any]
            let workers = data["workerDependencies"] as? [[String: Any]] ?? []
            return workers.contains { $0["state"] as? String == "running" && $0["callback"] as? String == "app_task_result" }
                ? .init(verdict: .waitingDependency, reason: "The authorized task is owned by the live worker; app_task_result returns its result.")
                : .init(verdict: .unknown, reason: "Truncated evidence cannot verify worker state or callback.")
        }
        bot.send("Research the synthetic catalog; all execution is assigned to the worker. Report when it returns.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        let task = "Research the synthetic catalog. " + String(repeating: "x", count: 2483)
        agent.completionWorkerDependencies = [.init(id: "catalog-worker", run: 1, task: task,
            state: .running, callback: "app_task_result")]
        agent.emit(.managedWorkPending(true))
        agent.emit(.trace(.subagentStarted(id: "catalog-worker", description: "Catalog research", type: "codex-worker", prompt: task, background: true)))
        agent.reply("The worker owns the catalog research and will report back. " + String(repeating: "history ", count: 2000))
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        let payload = try #require(calls.messages.first)
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(payload.utf8))
        #expect(decoded.workerDependencies?.first?.state == .running)
        #expect(decoded.workerDependencies?.first?.callback == "app_task_result")
        #expect(decoded.evidenceTruncated)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingDependency)
        #expect(!bot.messages.contains { $0.role == .notice && $0.text.contains("UNKNOWN") })
        #expect(agent.sent.count == 1)
    }
}

extension WorkerDependencyVerificationTests {
    @Test(arguments: ["completed", "failed", "interrupted"])
    func runtimeSnapshotTracksRealCallbackLifecycle(_ status: String) throws {
        let h = CodexManagedWorkerTests()
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let (task, _) = h.launch(&session)
        #expect(session.completionWorkerDependencies.first?.id == task)
        #expect(session.completionWorkerDependencies.first?.state == .running)
        #expect(session.completionWorkerDependencies.first?.callback == "app_task_result")
        _ = h.item("worker", "worker-1", ["id": "result", "type": "agentMessage", "phase": "final_answer", "text": "Concrete catalog evidence."], &session)
        let ended = h.completed("worker", "worker-1", &session, status: status)
        #expect(!ended.events.contains(.backgroundTurnStarted)) // Parent turn still running.
        #expect(session.completionWorkerDependencies.first?.state == .reportQueued)
        #expect(session.completionWorkerDependencies.first?.outcome == status)
        let delivery = h.completed("root", "parent-1", &session)
        #expect(delivery.events.contains(.managedWorkerReportStarted(taskID: task)))
        #expect(delivery.events.contains(.backgroundTurnStarted))
        #expect(session.completionWorkerDependencies.isEmpty) // Callback is being processed.
        #expect(h.completed("worker", "worker-1", &session, status: status).methods.isEmpty)
    }

    @Test func restoredOrStoppedWorkersAreNeverInventedAsRunning() {
        let h = CodexManagedWorkerTests()
        for status in ["completed", "failed", "interrupted", "unknown"] {
            let record = CodexManagedWorkerRecord(id: "old", name: "old", instructions: "old task", run: 1,
                wasActive: false, status: status)
            let (session, _) = h.ready(restored: [record])
            #expect(session.completionWorkerDependencies.isEmpty)
        }
        let record = CodexManagedWorkerRecord(id: "stale", name: "stale", instructions: "old task", run: 1, wasActive: true)
        let (restored, delivery) = h.ready(restored: [record])
        #expect(delivery.events.contains(.managedWorkerReportStarted(taskID: "stale")))
        #expect(restored.completionWorkerDependencies.isEmpty)
        var (live, _) = h.ready()
        h.rootTurn(&live)
        _ = h.launch(&live)
        #expect(live.completionWorkerDependencies.count == 1)
        _ = live.stop()
        #expect(live.completionWorkerDependencies.isEmpty)
    }

    @Test func packingProtectsWorkerFactsBeforeVerboseHistoryAndMarksOmissions() throws {
        let huge = String(repeating: "資料\"\\\n", count: 20000)
        var end = PromiseCheck.TurnEnd(reply: huge, workPending: true, task: "RESEARCH ONLY " + huge + " STOP",
            conversation: huge, dependencies: Array(repeating: huge, count: 100),
            actions: Array(repeating: huge, count: 12), memory: huge)
        end.workerDependencies = (0..<30).map {
            .init(id: "worker-\($0)", run: 2, task: "Own independent catalog slice \($0)", state: .running, callback: "app_task_result")
        }
        let payload = PromiseCheck.classifierMessage(end)
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(payload.utf8))
        #expect(payload.utf8.count <= 96000)
        #expect(decoded.evidenceTruncated)
        #expect(decoded.workerDependencies == end.workerDependencies)
        #expect(!decoded.workerDependenciesTruncated)
        #expect(decoded.task.hasPrefix("RESEARCH ONLY"))
        #expect(decoded.task.hasSuffix("STOP"))
        end.workerDependencies = [.init(id: "long", run: 3, task: huge + "DO NOT IMPLEMENT", state: .running, callback: "app_task_result")]
        let long = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(PromiseCheck.classifierMessage(end).utf8))
        #expect(long.workerDependencies?.first?.taskTruncated == true)
        #expect(long.workerDependencies?.first?.task.hasSuffix("DO NOT IMPLEMENT") == true)
        #expect(long.workerDependencies?.first?.callback == "app_task_result")
        #expect(!long.workerDependenciesTruncated)
        end.workerDependencies = Array(repeating: end.workerDependencies![0], count: 200)
        var omitted = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(PromiseCheck.classifierMessage(end).utf8))
        #expect(omitted.workerDependenciesTruncated)
        omitted.dependencies = []
        #expect(PromiseCheck.review(.waitingDependency, for: omitted).verdict == .unknown)
        end.dependencies = []
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .unknown)
    }

    @Test func waitNeedsALiveOwnerAndCallbackButNeverOverridesIndependentWorkOrStop() {
        var end = PromiseCheck.TurnEnd(reply: "worker is running", workPending: true, task: "research only")
        for workers: [PromiseCheck.WorkerDependency] in [[], [.init(id: "missing-path", run: 1, task: "research", state: .running)],
            [.init(id: "done", run: 1, task: "research", state: .reportQueued, callback: "app_task_result", outcome: "failed")]] {
            end.workerDependencies = workers
            #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .unknown)
            for verdict in [PromiseCheck.Judgment.continueWork, .waitingUser, .cancelled, .complete] {
                #expect(PromiseCheck.review(verdict, for: end).verdict == verdict.verdict)
            }
        }
        end.workerDependencies = [.init(id: "live", run: 1, task: "research", state: .running, callback: "app_task_result")]
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .waitingDependency)
        #expect(PromiseCheck.review(.continueWork, for: end).verdict == .continueWork)
        #expect(PromiseCheck.review(.cancelled, for: end).verdict == .cancelled)
    }

    @Test func staleRunningCardDoesNotEstablishLiveDependency() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { end in
            #expect(end.workerDependencies == [])
            #expect(end.dependencies.isEmpty)
            return .waitingDependency // Even a bad model verdict cannot invent a callback.
        }
        bot.send("Verify catalog research; no new implementation.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = []
        agent.emit(.trace(.subagentStarted(id: "stale-ui-card", description: "old task", type: "codex-worker", prompt: "old task", background: true)))
        agent.reply("The old card still says Running.")
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unknown)
        #expect(agent.sent.count == 1)
    }
}

extension WorkerDependencyVerificationTests {
    @Test func workerChangingDuringJudgmentIsRecheckedWithoutWakingTheCoordinator() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let gate = AsyncStream<Void>.makeStream()
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            calls.add(end.workerDependencies?.first?.state.rawValue ?? "none")
            if end.workerDependencies?.isEmpty == false {
                for await _ in gate.stream { break }
                return .continueWork // This answer is obsolete after the worker ends.
            }
            return .complete
        }
        bot.send("Research only; report the verified catalog findings.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = [.init(id: "live", run: 1, task: "catalog research", state: .running, callback: "app_task_result")]
        agent.reply("Catalog findings verified.")
        await eventually { calls.messages.count == 1 }
        agent.completionWorkerDependencies = []
        gate.continuation.yield(())
        gate.continuation.finish()
        await eventually { bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .complete }
        #expect(calls.messages == ["running", "none"])
        #expect(agent.sent.count == 1)
        #expect(!bot.messages.contains { $0.role == .notice && $0.text.contains("Continuing") })
    }

    @Test func liveWorkerDoesNotSuppressIndependentCoordinatorWork() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { end in
            #expect(end.workerDependencies?.first?.state == .running)
            #expect(end.task.contains("Independently analyze"))
            return .continueWork
        }
        bot.send("Worker owns catalog research. Independently analyze the error table now. Research only; do not implement.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = [.init(id: "live", run: 1, task: "catalog research", state: .running, callback: "app_task_result")]
        agent.reply("Catalog research is running; I will analyze the error table next.")
        await eventually { agent.sent.count == 2 }
        #expect(agent.sent.last?.contains(PromiseCheck.followUp) == true)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .continueWork)
    }
}

extension WorkerDependencyVerificationTests {
    @Test(arguments: ["before-thread-response", "before-turn-response", "running"])
    func followupIsDeliveredExactlyOnceWithoutMutatingLaunchInstructions(_ timing: String) throws {
        let h = CodexManagedWorkerTests()
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let original = "Original catalog research"
        let followup = "Count only the seven synthetic alpha records."
        let handoff = h.tool(100, arguments: ["instructions": original, "name": "catalog"], &session)
        let task = try #require(session.completionWorkerDependencies.first?.id)
        var writes: [[String: Any]] = []
        func sendFollowup(_ session: inout CodexSession) {
            writes += h.tool(101, name: "app_send_message", arguments: ["task_id": task, "message": followup], &session).writes
        }
        if timing == "before-thread-response" { sendFollowup(&session) }
        let threadReady = h.response(h.write(handoff, "thread/start"), ["thread": ["id": "worker"]], &session)
        writes += threadReady.writes
        if timing == "before-turn-response" { sendFollowup(&session) }
        let turnReady = h.response(h.write(threadReady, "turn/start"), ["turn": ["id": "worker-1"]], &session)
        writes += turnReady.writes
        if timing == "running" { sendFollowup(&session) }
        let starts = writes.filter { $0["method"] as? String == "turn/start" }
        let steers = writes.filter { $0["method"] as? String == "turn/steer" }
        func input(_ write: [String: Any]) -> String {
            let params = write["params"] as? [String: Any]
            return (params?["input"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
        }
        #expect(starts.count == 1)
        #expect(starts.first.map(input) == original)
        #expect(steers.count == 1)
        #expect(steers.first.map(input) == followup)
        #expect((starts + steers).map(input).joined(separator: "\n").components(separatedBy: followup).count - 1 == 1)
        #expect((steers.first?["params"] as? [String: Any])?["expectedTurnId"] as? String == "worker-1")
        #expect(session.managedWorkerRecords.first?.instructions == original)
        let evidence = try #require(session.completionWorkerDependencies.first?.task)
        #expect(evidence.contains(original))
        #expect(evidence.components(separatedBy: followup).count - 1 == 1)
        #expect(h.tool(101, name: "app_send_message", arguments: ["task_id": task, "message": followup], &session).methods.isEmpty)
        #expect(session.completionWorkerDependencies.first?.task == evidence)
        _ = h.response(try #require(steers.first), [:], &session)
        #expect(session.completionWorkerDependencies.first?.task == evidence)
    }
}
