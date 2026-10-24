import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ComponentEditorLifecycleTests {
    let h = CodexManagedWorkerTests()
    typealias Out = CodexSessionTests.Out

    func ready(editor: ComponentEditorRoute? = .available(AgentLaunch(model: .haiku, sessionID: UUID(),
        workingDirectory: URL(filePath: "/tmp/editor"), systemPrompt: "existing editor", tools: ["Read", "Write", "Edit", "Bash"])),
        restored: [CodexManagedWorkerRecord] = []) -> CodexSession {
        var config = CodexSession.Config(workingDirectory: URL(filePath: "/tmp/editor"), instructions: "coordinate",
            workerInstructions: "generic worker", componentEditor: editor)
        config.restoredWorkers = restored
        var session = CodexSession(config: config)
        let start = h.response(Out(session.start()).writes[0], [:], &session)
        let root = h.response(h.write(start, "thread/start"), ["thread": ["id": "root"]], &session)
        if let automaticReport = root.writes.first(where: { $0["method"] as? String == "turn/start" }) {
            _ = h.response(automaticReport, ["turn": ["id": "parent-1"]], &session)
        } else {
            h.rootTurn(&session)
        }
        return session
    }

    func handoff(_ session: inout CodexSession, id: Int = 100) throws -> (String, Int, AgentLaunch, Out) {
        let out = h.tool(id, arguments: ["instructions": "Authorized component change; test and report, no release.",
                                       "name": "token-speed", "role": "component-editor"], &session)
        let action = try #require(out.editors.first)
        guard case let .start(task, run, launch, _) = action else { throw TestFailure.wrongAction }
        return (task, run, launch, out)
    }
    enum TestFailure: Error { case wrongAction }

    @Test func roleUsesConfiguredDefinitionAndPreservesExistingPermissions() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-editor-definition-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appending(path: "ccb-core/claude/agents/component-editor.md")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "---\nname: component-editor\nmodel: opus\ntools: Read, Write, Edit, Bash\n---\nCustom editor instructions kept by the user.\n".write(to: file, atomically: true, encoding: .utf8)
        var parent = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: folder, systemPrompt: "Never edit templates yourself",
            extraDirectories: [folder.appending(path: "approved")], asksPermission: true,
            disallowedTools: ["WebFetch"], autoMode: true, allowRules: ["Bash(git status)"])
        // A name or a file on disk is insufficient: ordinary managers have no editor route.
        #expect(ComponentEditorRoute.load(for: parent)?.launch == nil)
        parent.componentEditorEnabled = true
        let editor = try #require(ComponentEditorRoute.load(for: parent)?.launch)
        #expect(editor.engine == .claude)
        #expect(editor.model == .opus)
        #expect(editor.systemPrompt.contains("Custom editor instructions kept by the user."))
        #expect(!editor.systemPrompt.contains("Never edit templates yourself"))
        #expect(editor.extraDirectories == parent.extraDirectories)
        #expect(editor.autoMode == parent.autoMode)
        #expect(editor.asksPermission == parent.asksPermission)
        #expect(editor.allowRules == parent.allowRules)
        #expect(editor.tools == ["Read", "Write", "Edit", "Bash"])
        #expect(editor.restrictedTools == editor.tools)
        #expect(editor.disallowedTools.contains("WebFetch"))
        #expect(editor.disallowedTools.contains("Agent"))
        #expect(editor.pluginDirectories.isEmpty)
        #expect(editor.codexWorkerInstructions == nil)
        let args = ClaudeAgentProcess.arguments(for: editor)
        let toolsIndex = try #require(args.firstIndex(of: "--tools"))
        #expect(args[toolsIndex + 1] == "Read,Write,Edit,Bash")
        #expect(!args.contains("--dangerously-skip-permissions"))
    }

    @Test func unavailableAndUnknownRolesFailWithoutGenericFallback() throws {
        for editor in [nil, .unavailable("Definition is missing at /tmp/editor/component-editor.md")] as [ComponentEditorRoute?] {
            var session = ready(editor: editor)
            let out = h.tool(100, arguments: ["instructions": "change token-speed", "role": "component-editor"], &session)
            #expect(out.editors.isEmpty)
            #expect(out.traces.isEmpty)
            #expect(out.writes.first?["result"] as? [String: Any] != nil)
            #expect((out.writes.first?["result"] as? [String: Any])?["success"] as? Bool == false)
            #expect(session.managedWorkerRecords.isEmpty)
        }
        var session = ready()
        let out = h.tool(100, arguments: ["instructions": "fix", "role": "administrator"], &session)
        #expect(out.editors.isEmpty)
        #expect(session.managedWorkerRecords.isEmpty)
        let ordinary = h.tool(101, &session)
        #expect(ordinary.editors.isEmpty)
        #expect(ordinary.methods == ["thread/start"])
        #expect(session.managedWorkerRecords.first?.role == nil)
    }

    @Test func editorReportReturnsToTheSameTaskAndRemainsUnverifiedUntilCheckpoint() throws {
        var session = ready()
        let (task, run, launch, _) = try handoff(&session)
        let launched = Out(session.componentEditorStarted(task, run: run, model: launch.model))
        #expect(launched.traces.contains { if case .launchResult = $0 { true } else { false } })
        #expect(session.managedWorkerRecords.first?.runtime?.engine == .claude)
        _ = h.completed("root", "parent-1", &session)
        let report = Out(session.componentEditorEvent(task, run: run, event: .reply("Changed the isolated template; JS check passed; native acceptance pending.", isError: false)))
        let params = try #require(report.params("turn/start"))
        let payload = try #require(params["toolOutput"] as? [String: Any])
        #expect(payload["name"] as? String == "app_task_result")
        let json = try #require(payload["output"] as? String)
        #expect(json.contains(task))
        #expect(json.contains("unverified"))
        #expect(session.managedWorkerRecords.first?.status == "completed")
        #expect(session.managedWorkerRecords.first?.reportPending == true)
        #expect(session.managedWorkerRecords.first?.role == "component-editor")
    }

    @Test func permissionRefusalKeepsExactRequestAndDoesNotCreateFallbackWorker() throws {
        var session = ready()
        let (task, run, _, _) = try handoff(&session)
        let request = PermissionRequest(id: "ask-1", tool: "Bash", summary: "blocked action", input: "{\"command\":\"blocked action\"}")
        let output = Out(session.componentEditorEvent(task, run: run, event: .permission(request)))
        let card = try #require(output.events.compactMap { if case let .permission(card) = $0 { card } else { nil } }.first)
        #expect(card.id != request.id)
        let answer = Out(session.answer(card.id, allow: false, message: "Not authorized"))
        guard case let .answer(target, original, allow, message) = try #require(answer.editors.first) else { throw TestFailure.wrongAction }
        #expect(target == task)
        #expect(original == request)
        #expect(!allow)
        #expect(message == "Not authorized")
        #expect(answer.writes.isEmpty)
        let denial = PermissionDenial(toolUseID: "denied-tool", tool: "Bash", reason: "Exact classifier refusal")
        #expect(Out(session.componentEditorEvent(task, run: run, event: .permissionDenied(denial))).events == [.permissionDenied(denial)])
        #expect(session.managedWorkerRecords.count == 1)
    }

    @Test func cancelClearsPermissionsStopsOnlyEditorAndIgnoresLateResults() throws {
        var session = ready()
        let (task, run, _, _) = try handoff(&session)
        let request = PermissionRequest(id: "ask", tool: "Write", summary: "write", input: "{}")
        _ = session.componentEditorEvent(task, run: run, event: .permission(request))
        let stopped = Out(session.cancelManagedWorkers([task]))
        #expect(stopped.editors.count == 1)
        #expect(stopped.events.contains(.permissionCancelled("component-editor:\(task):ask")))
        #expect(stopped.writes.isEmpty)
        #expect(session.componentEditorEvent(task, run: run, event: .reply("late", isError: false)).isEmpty)
        #expect(session.answer("component-editor:\(task):ask", allow: true).isEmpty)
        #expect(session.completionWorkerDependencies.isEmpty)
    }

    @Test func followupsAndRestoredTasksKeepTheEditorRoleAndClaudeSession() throws {
        var session = ready()
        let (task, run, launch, _) = try handoff(&session)
        let steer = h.tool(101, name: "app_send_message", arguments: ["task_id": task, "message": "Keep the labels"], &session)
        guard case let .send(target, text) = try #require(steer.editors.first) else { throw TestFailure.wrongAction }
        #expect(target == task && text == "Keep the labels")
        _ = session.componentEditorEvent(task, run: run, event: .reply("isolated change ready", isError: false))
        let records = try JSONDecoder().decode([CodexManagedWorkerRecord].self, from: JSONEncoder().encode(session.managedWorkerRecords))
        var restored = ready(restored: records)
        let followup = h.tool(102, name: "app_send_message", arguments: ["task_id": task, "message": "Fix the failed native check"], &restored)
        guard case let .start(target2, run2, resumed, _) = try #require(followup.editors.first) else { throw TestFailure.wrongAction }
        #expect(target2 == task && run2 == run + 1)
        #expect(resumed.resume)
        #expect(resumed.sessionID == launch.sessionID)
        #expect(resumed.model == launch.model)
        #expect(followup.methods.isEmpty)
        // A lost definition fails explicitly on continuation; it cannot downgrade to generic.
        var missing = ready(editor: nil, restored: records)
        let denied = h.tool(103, name: "app_send_message", arguments: ["task_id": task, "message": "continue"], &missing)
        #expect(denied.editors.isEmpty)
        #expect(missing.managedWorkerRecords.first?.status == "failed")
        #expect(missing.managedWorkerRecords.first?.run == run + 1)
        #expect(missing.managedWorkerRecords.first?.role == "component-editor")
    }

    @Test func launchAndPrematureExitFailuresAreConcreteAndNeverRetried() throws {
        var session = ready()
        let (task, run, _, _) = try handoff(&session)
        let failure = Out(session.componentEditorLaunchFailed(task, run: run, fresh: true, reason: "Claude executable not found"))
        #expect(failure.editors.isEmpty)
        #expect(session.managedWorkerRecords.first?.report?.contains("Claude executable not found") == true)
        #expect(session.managedWorkerRecords.first?.status == "failed")
        #expect(session.managedWorkerRecords.first?.thread == nil)
        var other = ready()
        let (task2, run2, _, _) = try handoff(&other)
        _ = other.componentEditorEvent(task2, run: run2, event: .exited(status: 9, stderr: "API unavailable"))
        #expect(other.managedWorkerRecords.first?.report?.contains("API unavailable") == true)
        #expect(other.managedWorkerRecords.first?.status == "failed")
    }

    @Test func lateLaunchNoticeCannotStopTheReplacementAfterCancellation() throws {
        var session = ready()
        let (task, oldRun, launch, _) = try handoff(&session)
        _ = session.cancelManagedWorkers([task])
        let followup = h.tool(102, name: "app_send_message", arguments: ["task_id": task, "message": "Continue the same authorized edit"], &session)
        guard case let .start(_, newRun, _, _) = try #require(followup.editors.first) else { throw TestFailure.wrongAction }
        #expect(newRun == oldRun + 1)
        let stale = Out(session.componentEditorStarted(task, run: oldRun, model: launch.model))
        #expect(stale.editors.isEmpty)
        #expect(stale.events.isEmpty)
        #expect(session.managedWorkerRecords.first?.wasActive == true)
        _ = session.componentEditorStarted(task, run: newRun, model: launch.model)
        #expect(session.managedWorkerRecords.first?.runtime?.engine == .claude)
    }

    @Test func ordinaryLegacyRecordsDecodeWithoutAnEditorRole() throws {
        let data = Data(#"[{"id":"old","name":"legacy","instructions":"do work","run":1,"wasActive":false,"reportPending":false}]"#.utf8)
        #expect(try JSONDecoder().decode([CodexManagedWorkerRecord].self, from: data).first?.role == nil)
    }
}
