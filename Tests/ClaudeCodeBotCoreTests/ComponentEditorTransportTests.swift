import Foundation
import Testing
@testable import ClaudeCodeBotCore

private final class EditorTransportEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [AgentEvent] = []
    func append(_ event: AgentEvent) { lock.withLock { values.append(event) } }
    var events: [AgentEvent] { lock.withLock { values } }
}

struct ComponentEditorTransportTests {
    /// Drives the production transport over real stdio, with a deterministic coordinator
    /// server and the existing AgentLauncher interface standing in for the Claude API.
    @MainActor
    @Test func coordinatorDispatchesClaudeEditorAndReconcilesSuccessOrLauncherFailure() async throws {
        for available in [true, false] {
            let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-editor-transport-\(UUID())")
            defer { try? FileManager.default.removeItem(at: folder) }
            let definition = folder.appending(path: "ccb-core/claude/agents/component-editor.md")
            try FileManager.default.createDirectory(at: definition.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Workspace.componentEditorAgent(model: .haiku).write(to: definition, atomically: true, encoding: .utf8)
            let executable = folder.appending(path: "coordinator.py")
            try Self.server.write(to: executable, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
            let fake = FakeLauncher(); fake.respond = { _ in nil }
            var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: UUID(), workingDirectory: folder,
                systemPrompt: "coordinate only", asksPermission: true, autoMode: true, codexWorkerInstructions: "generic worker")
            launch.componentEditorEnabled = true
            let process = try CodexAgentProcess(launch, executable: executable, threads: CodexThreads(folder: folder.appending(path: "threads")),
                componentEditorLauncher: available ? fake.launcher : nil)
            defer { process.stop() }
            let events = EditorTransportEvents()
            let reader = Task { for await event in process.events { events.append(event) } }
            defer { reader.cancel() }
            process.send("Authorized component task")
            if available {
                await eventually({ fake.agents.first?.sent.isEmpty == false }, timeout: 15)
                let child = try #require(fake.agents.first)
                #expect(child.launch.engine == .claude)
                #expect(child.launch.model == .haiku)
                #expect(child.launch.restrictedTools == ["Read", "Write", "Edit", "Bash"])
                #expect(child.sent.first == "Authorized component edit; no release; return evidence.")
                let original = PermissionRequest(id: "child-ask", tool: "Bash", summary: "Fixture permission", input: "{}")
                child.emit(.permission(original))
                await eventually({ events.events.contains { if case .permission = $0 { true } else { false } } }, timeout: 10)
                let card = try #require(events.events.compactMap { if case let .permission(card) = $0 { card } else { nil } }.first)
                process.answer(card, allow: false, message: "Denied for this test")
                await eventually({ !child.answers.isEmpty }, timeout: 10)
                #expect(child.answers.first?.0 == "child-ask")
                #expect(child.answers.first?.1 == false)
                #expect(child.allowedRules.isEmpty)
                child.reply("Isolated fixture edit checked; denied action was not executed.")
            }
            await eventually({ events.events.contains(.reply("Editor result reconciled", isError: false)) }, timeout: 15)
            let records = CodexThreads(folder: folder.appending(path: "threads")).workers(for: launch.sessionID)
            let record = try #require(records.first)
            #expect(record.role == "component-editor")
            // Reconciliation consumes the pending report; durable UI traces keep its outcome.
            #expect(record.reportPending == false)
            #expect(!record.wasActive)
            let ended = try #require(events.events.compactMap { event -> (String, String?)? in
                if case let .trace(.subagentEnded(_, status, summary)) = event { return (status, summary) }
                return nil
            }.first)
            #expect(ended.0 == (available ? "completed" : "failed"))
            if !available {
                #expect(ended.1?.contains("Claude component-editor launcher is unavailable") == true)
                #expect(fake.agents.isEmpty)
            }
            process.stop()
            if let child = fake.agents.first { #expect(child.finished) }
        }
    }

    private static let server = #"""
    #!/usr/bin/env python3
    import json, sys
    def emit(value):
        print(json.dumps(value), flush=True)
    def note(method, params):
        emit({"method": method, "params": params})
    def result(rpc, value):
        emit({"id": rpc["id"], "result": value})
    for line in sys.stdin:
        rpc = json.loads(line)
        method = rpc.get("method")
        params = rpc.get("params", {})
        if method == "initialize":
            result(rpc, {})
        elif method == "thread/start":
            result(rpc, {"thread": {"id": "root"}})
        elif method == "turn/start":
            report = params.get("toolOutput")
            turn = "report-1" if report else "parent-1"
            result(rpc, {"turn": {"id": turn}})
            if not report:
                emit({"id": 100, "method": "item/tool/call", "params": {
                    "threadId": "root", "turnId": turn, "tool": "app_handoff", "callId": "handoff",
                    "arguments": {"name": "token-speed", "role": "component-editor",
                        "instructions": "Authorized component edit; no release; return evidence."}}})
                note("turn/completed", {"threadId": "root", "turn": {"id": turn, "status": "completed"}})
            else:
                data = json.loads(report["output"])
                emit({"id": 101, "method": "item/tool/call", "params": {
                    "threadId": "root", "turnId": turn, "tool": "app_task_checkpoint", "callId": "checkpoint",
                    "arguments": {"task_id": data["task_id"], "outcome": "complete" if data["status"] == "completed" else "blocked",
                        "evidence": data["report"]}}})
        elif rpc.get("id") == 101:
            note("item/completed", {"threadId": "root", "turnId": "report-1", "item": {
                "id": "final", "type": "agentMessage", "text": "Editor result reconciled", "phase": "final_answer"}})
            note("turn/completed", {"threadId": "root", "turn": {"id": "report-1", "status": "completed"}})
        elif "id" in rpc and method:
            result(rpc, {})
    """#
}
