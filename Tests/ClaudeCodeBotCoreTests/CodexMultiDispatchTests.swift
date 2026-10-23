import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexMultiDispatchTests {
    let h = CodexManagedWorkerTests()
    let c = TaskContinuationTests()

    func receipt(_ out: CodexSessionTests.Out) throws -> [String: Any] {
        let result = try #require(out.writes.first?["result"] as? [String: Any])
        #expect(result["success"] as? Bool == true)
        let items = try #require(result["contentItems"] as? [[String: Any]])
        let text = try #require(items.first?["text"] as? String)
        return try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    @Test func generatedPolicyToolAndReceiptAgreeOnDispatchPhase() throws {
        let root = URL(filePath: "/tmp/multi-dispatch")
        let prompts = BotPrompts(profile: .manager(name: "Probe", avatar: "square", folder: root), engine: .codex)
        var s = CodexSession(config: .init(workingDirectory: root, instructions: prompts.system,
            workerInstructions: prompts.codexWorkerSystem))
        let initialize = CodexSessionTests.Out(s.start()).writes[0]
        let start = h.response(initialize, [:], &s)
        let params = try #require(start.params("thread/start"))
        #expect(params["developerInstructions"] as? String == prompts.system)
        let tools = try #require(params["dynamicTools"] as? [[String: Any]])
        let handoff = try #require(tools.first { $0["name"] as? String == "app_handoff" })
        let description = try #require(handoff["description"] as? String)
        #expect(prompts.system.contains("You may call app_handoff sequentially multiple times in this same turn"))
        #expect(!prompts.system.contains("Do not dispatch further tools after an acceptance receipt"))
        #expect(!prompts.system.contains("keep any other independent scope pending for a later turn"))
        #expect(description.contains("dispatch phase"))
        #expect(!description.contains("Finish this turn after the receipt"))
        _ = h.response(h.write(start, "thread/start"), ["thread": ["id": "root"]], &s)
        h.rootTurn(&s)
        let message = try #require(receipt(h.tool(100, &s))["message"] as? String)
        #expect(message.contains("dispatch phase"))
        #expect(!message.contains("Finish this turn;"))
    }

    @Test func sameTurnDispatchPreservesSeparateTaskIDsPhasesAndReportCheckpoints() throws {
        var (s, _) = h.ready()
        h.rootTurn(&s)
        let scopes = [
            #"Scope contract: {"deliverables":["shortcut research"],"phase":"research-only","implementation_authorized":false,"implementation_files":[],"advance_requires":"explicit-user-authorization","file_release_authorizes_implementation":false}"#,
            #"Scope contract: {"deliverables":["authorized footer fix"],"phase":"implementation","implementation_authorized":true,"implementation_files":["Footer.swift"]}"#
        ]
        var tasks: [String] = []
        for (index, scope) in scopes.enumerated() {
            let accepted = h.tool(100 + index, arguments: ["instructions": scope, "name": "scope-\(index)"], &s)
            let task = try #require(receipt(accepted)["task_id"] as? String)
            tasks.append(task)
            #expect(!accepted.closed)
            #expect(!accepted.methods.contains("turn/interrupt"))
            let thread = h.response(h.write(accepted, "thread/start"), ["thread": ["id": "worker-\(index)"]], &s)
            let input = try #require(thread.params("turn/start")?["input"] as? [[String: Any]])
            #expect(input.first?["text"] as? String == scope)
            _ = h.response(h.write(thread, "turn/start"), ["turn": ["id": "run-\(index)"]], &s)
        }
        #expect(Set(tasks).count == 2)
        #expect(s.managedWorkerRecords.count == 2)
        #expect(s.managedWorkerRecords.allSatisfy { $0.wasActive })
        // Both workers can finish before the dispatch turn ends, in reverse order.
        for index in [1, 0] {
            _ = h.item("worker-\(index)", "run-\(index)", ["id": "evidence-\(index)", "type": "agentMessage",
                "phase": "final_answer", "text": "Evidence for scope \(index) only"], &s)
            #expect(!h.completed("worker-\(index)", "run-\(index)", &s).methods.contains("turn/start"))
        }
        var next = h.completed("root", "parent-1", &s)
        for (index, task) in tasks.reversed().enumerated() {
            let payload = try c.payload(next)
            #expect(payload["task_id"] as? String == task)
            #expect(payload["run"] as? Int == 1)
            let turn = "report-\(index)"
            _ = h.response(h.write(next, "turn/start"), ["turn": ["id": turn]], &s)
            let checkpoint = h.tool(200 + index, name: "app_task_checkpoint", arguments: ["task_id": task,
                "outcome": "complete", "evidence": "The assigned scope's acceptance evidence is sufficient."], &s)
            #expect(try receipt(checkpoint)["recorded"] as? Bool == true)
            next = c.finish(&s, turn: turn)
        }
        #expect(!next.methods.contains("turn/start"))
        #expect(!s.managedWorkerRecords.contains { $0.reportPending })
    }

    @Test func unrelatedHandoffCannotConsumeActiveReport() throws {
        var (s, task, _) = c.reportTurn()
        let accepted = h.tool(110, arguments: ["instructions": "A separate authorized deliverable", "name": "unrelated"], &s)
        #expect(try receipt(accepted)["task_id"] as? String != task)
        let retry = try c.payload(c.finish(&s))
        #expect(retry["task_id"] as? String == task)
        #expect(retry["reconciliation_attempt"] as? Int == 1)
    }

    @Test func messageToAnotherWorkerCannotConsumeActiveReport() throws {
        var (s, _) = h.ready()
        h.rootTurn(&s)
        let (task, _) = h.launch(&s)
        let other = h.tool(101, arguments: ["instructions": "Separate task", "name": "other"], &s)
        let otherTask = try #require(receipt(other)["task_id"] as? String)
        let thread = h.response(h.write(other, "thread/start"), ["thread": ["id": "other-worker"]], &s)
        _ = h.response(h.write(thread, "turn/start"), ["turn": ["id": "other-run"]], &s)
        _ = h.completed("root", "parent-1", &s)
        _ = h.item("worker", "worker-1", ["id": "proof", "type": "agentMessage", "text": "Partial evidence"], &s)
        let report = h.completed("worker", "worker-1", &s)
        _ = h.response(h.write(report, "turn/start"), ["turn": ["id": "summary"]], &s)
        _ = h.tool(102, name: "app_send_message", arguments: ["task_id": otherTask, "message": "More context for that other task"], &s)
        #expect(try c.payload(c.finish(&s))["task_id"] as? String == task)
    }

    @Test func sameTaskContinuationCanBeFollowedByIndependentDispatch() throws {
        var (s, task, _) = c.reportTurn()
        let followup = h.tool(110, name: "app_send_message", arguments: ["task_id": task,
            "message": "Complete the remaining authorized checks for this same deliverable."], &s)
        #expect(followup.params("turn/start")?["threadId"] as? String == "worker")
        _ = h.tool(111, arguments: ["instructions": "An independent authorized task", "name": "second"], &s)
        #expect(!c.finish(&s).methods.contains("turn/start"))
        #expect(s.managedWorkerRecords.filter(\.wasActive).count == 2)
    }

    @Test func oldSingleDispatchDescriptionMigratesEvenWithSameThreeTools() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-dispatch-schema-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let threads = CodexThreads(folder: folder), session = UUID()
        threads.save("old-coordinator", for: session)
        var oldTools = try #require(JSONSerialization.jsonObject(with: Data(CodexSession.managedToolSignature.utf8)) as? [[String: Any]])
        let index = try #require(oldTools.firstIndex { $0["name"] as? String == "app_handoff" })
        oldTools[index]["description"] = "Assign the whole execution scope to an independent app-managed worker. Returns acceptance immediately. Finish this turn after the receipt; the app will deliver app_task_result in a later turn."
        let signature = String(decoding: try JSONSerialization.data(withJSONObject: oldTools, options: [.sortedKeys, .prettyPrinted]), as: UTF8.self)
        let stamp = ["thread": "old-coordinator", "tools": signature]
        try JSONSerialization.data(withJSONObject: stamp).write(to: folder.appending(path: session.uuidString.lowercased() + ".managed"))
        let record = CodexManagedWorkerRecord(id: "task-kept", name: "research", instructions: "Research only", thread: "same-worker", run: 2, wasActive: false)
        threads.saveWorkers([record], for: session)
        let workerFile = folder.appending(path: session.uuidString.lowercased() + ".workers.json")
        let workerBytes = try Data(contentsOf: workerFile)
        var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: session, resume: true,
            workingDirectory: folder, systemPrompt: "current policy")
        launch.codexWorkerInstructions = "execute own scope"
        #expect(!threads.isManaged(session, thread: "old-coordinator"))
        let config = try CodexAgentProcess.config(for: launch, threads: threads)
        #expect(config.resumeThread == nil)
        #expect(config.restoredWorkers == [record])
        threads.save("new-coordinator", for: session)
        threads.markManaged("new-coordinator", for: session)
        #expect(try CodexAgentProcess.config(for: launch, threads: threads).resumeThread == "new-coordinator")
        #expect(try Data(contentsOf: workerFile) == workerBytes)
        #expect(try String(contentsOf: folder.appending(path: session.uuidString.lowercased() + ".previous-threads"), encoding: .utf8) == "old-coordinator\n")
    }
}
