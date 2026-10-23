import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct WorkerRuntimeInfoTests {
    typealias Out = CodexSessionTests.Out
    func receive(_ value: [String: Any], _ session: inout CodexSession) -> Out {
        let data = try! JSONSerialization.data(withJSONObject: value)
        return Out(session.receive(String(decoding: data, as: UTF8.self)))
    }
    func reply(_ out: Out, _ method: String, _ result: [String: Any], _ session: inout CodexSession) -> Out {
        let request = out.writes.first { $0["method"] as? String == method }!
        return receive(["id": request["id"]!, "result": result], &session)
    }
    func launch(effort: EffortLevel? = nil, settings: [String: Any]) -> (CodexSession, String, Out) {
        var session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp/bot"), instructions: "coordinate", effort: effort, workerInstructions: "execute"))
        let initReply = reply(Out(session.start()), "initialize", [:], &session)
        _ = reply(initReply, "thread/start", ["thread": ["id": "root"]], &session)
        let handoff = receive(["id": 100, "method": "item/tool/call", "params": ["threadId": "root", "callId": "call", "tool": "app_handoff", "arguments": ["instructions": "test", "name": "worker"]]], &session)
        let task = handoff.traces.compactMap { event -> String? in
            if case let .subagentStarted(id, _, _, _, _) = event { return id }; return nil
        }.first!
        var result = settings; result["thread"] = ["id": "child"]
        let ready = reply(handoff, "thread/start", result, &session)
        return (session, task, ready)
    }
    func runtime(_ out: Out, _ id: String) -> WorkerRuntimeInfo? {
        out.traces.compactMap { event in
            if case let .subagentRuntime(task, value) = event, task == id { return value }; return nil
        }.last
    }
    @Test func inheritedSettingsComeFromWorkerResponseNotCoordinatorOrModel() {
        let (session, task, ready) = launch(settings: ["model": "resolved-model", "reasoningEffort": "low", "serviceTier": "fast"])
        #expect(runtime(ready, task) == .init(reasoningEffort: "low", serviceTier: "fast"))
        #expect(ready.traces.contains(.subagentModel(id: task, model: "resolved-model")))
        #expect(ready.params("turn/start")?["effort"] == nil)
        #expect(session.managedWorkerRecords.first?.runtime == runtime(ready, task))
    }
    @Test func explicitTurnOverrideIsCapturedOnlyAfterSuccessfulStart() {
        var (session, task, ready) = launch(effort: .max, settings: ["reasoningEffort": "low", "serviceTier": "priority"])
        #expect(runtime(ready, task)?.reasoningEffort == "low")
        #expect(ready.params("turn/start")?["effort"] as? String == "xhigh")
        let accepted = reply(ready, "turn/start", ["turn": ["id": "turn-1"]], &session)
        #expect(runtime(accepted, task) == .init(reasoningEffort: "xhigh", serviceTier: "priority"))
        #expect(session.managedWorkerRecords.first?.runtime?.reasoningEffort == "xhigh")
    }
    @Test func runtimeNotificationWinsOverPendingRequestedEffort() {
        var (session, task, ready) = launch(effort: .max, settings: ["reasoningEffort": "low", "serviceTier": "fast"])
        _ = receive(["method": "thread/settings/updated", "params": ["threadId": "child", "threadSettings": ["effort": "high", "serviceTier": "default"]]], &session)
        let accepted = reply(ready, "turn/start", ["turn": ["id": "turn-1"]], &session)
        #expect(runtime(accepted, task) == nil)
        #expect(session.managedWorkerRecords.first?.runtime == .init(reasoningEffort: "high", serviceTier: "default"))
    }
    @Test func rejectedOverrideDoesNotReplaceResolvedEffort() {
        var (session, task, ready) = launch(effort: .max, settings: ["reasoningEffort": "low"])
        let request = ready.writes.first { $0["method"] as? String == "turn/start" }!
        let rejected = receive(["id": request["id"]!, "error": ["message": "unsupported effort"]], &session)
        #expect(runtime(rejected, task) == nil)
        #expect(session.managedWorkerRecords.first?.runtime?.reasoningEffort == "low")
    }
    @Test func persistedRecordsSupportRestoreAndOlderRecords() throws {
        let (session, _, _) = launch(settings: ["reasoningEffort": "high", "serviceTier": "fast"])
        let records = try JSONDecoder().decode([CodexManagedWorkerRecord].self, from: JSONEncoder().encode(session.managedWorkerRecords))
        let restored = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp/bot"), instructions: "coordinate", restoredWorkers: records))
        #expect(restored.managedWorkerRecords.first?.runtime == records.first?.runtime)
        let old = #"{"id":"old","name":"worker","instructions":"test","run":1,"wasActive":false,"reportPending":false}"#
        let legacy = try JSONDecoder().decode(CodexManagedWorkerRecord.self, from: Data(old.utf8))
        #expect(legacy.runtime == nil)
    }
    @Test func missingAndNullNeverMeanMediumOrFastOff() {
        let (_, task, ready) = launch(settings: ["reasoningEffort": NSNull(), "serviceTier": NSNull()])
        #expect(runtime(ready, task) == WorkerRuntimeInfo())
        let (_, legacyTask, legacy) = launch(settings: [:])
        #expect(runtime(legacy, legacyTask) == WorkerRuntimeInfo())
    }
    @Test func updatesAreThreadScopedReplaceNullsAndPersistInHistory() throws {
        var (session, task, _) = launch(settings: ["reasoningEffort": "high", "serviceTier": "fast"])
        let update = receive(["method": "thread/settings/updated", "params": ["threadId": "child", "threadSettings": ["model": "worker-model", "effort": "medium", "serviceTier": "default"]]], &session)
        #expect(runtime(update, task) == .init(reasoningEffort: "medium", serviceTier: "default"))
        let rootUpdate = receive(["method": "thread/settings/updated", "params": ["threadId": "root", "threadSettings": ["effort": "low", "serviceTier": "fast"]]], &session)
        #expect(runtime(rootUpdate, task) == nil)
        var book = TraceBook()
        _ = book.apply(.subagentStarted(id: task, description: "worker", type: "codex-worker", prompt: "test", background: true))
        for trace in update.traces { _ = book.apply(trace) }
        _ = book.apply(.subagentEnded(id: task, status: "completed", summary: "done"))
        let loaded = try JSONDecoder().decode([Subagent].self, from: JSONEncoder().encode(book.subagents))
        #expect(loaded.first?.runtime == runtime(update, task))
        let records = try JSONDecoder().decode([CodexManagedWorkerRecord].self, from: JSONEncoder().encode(session.managedWorkerRecords))
        #expect(records.first?.runtime == runtime(update, task))
        let cleared = receive(["method": "thread/settings/updated", "params": ["threadId": "child", "threadSettings": ["effort": NSNull(), "serviceTier": NSNull()]]], &session)
        #expect(runtime(cleared, task) == WorkerRuntimeInfo())
    }
    @MainActor @Test func payloadUsesCapturedRuntimeAcrossGlobalChangesAndEngines() async {
        var subagent = Subagent(id: "a", description: "worker", prompt: "test", status: .completed)
        subagent.runtime = .init(reasoningEffort: "low", serviceTier: "fast")
        let bot = makeBot(FakeLauncher())
        await bot.setEffort(.max)
        let header = ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "").subagent
        #expect(header?.runtime == subagent.runtime)
        #expect(header?.engine == "claude")
        subagent.runtime = nil
        #expect(ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "").subagent?.runtime == nil)
    }
    @Test func nativeActivityCarriesResolvedEffortWithoutAssumingFastInheritance() {
        var session = CodexSessionTests().session()
        _ = CodexSessionTests().started(&session, "test", recording: CodexRecordings.helloAndApproval)
        let main = "01a1640c-e2db-7742-998a-553a14d4336f"
        let out = receive(["method": "item/completed", "params": ["threadId": main, "item": ["id": "spawn", "type": "subAgentActivity", "kind": "started", "agentThreadId": "native", "agentPath": "/root/test", "reasoningEffort": "high", "model": "actual"]]], &session)
        #expect(runtime(out, "spawn") == .init(reasoningEffort: "high"))
    }
}
