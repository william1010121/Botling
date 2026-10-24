import Darwin
import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct CommandMonitorTests {
    let h = CodexManagedWorkerTests()
    typealias Out = CodexSessionTests.Out

    func start(_ session: inout CodexSession, command: String = "printf hello; exit 0", rpc: Int = 901) throws -> (String, Out) {
        let out = h.tool(rpc, name: "app_monitor_start", arguments: ["command": command], &session)
        let request = try #require(out.events.compactMap { if case let .permission(r) = $0 { r } else { nil } }.first)
        #expect(request.tool == "Monitored command")
        #expect(!out.methods.contains("command/exec"))
        return (String(request.id.dropFirst(8)), out)
    }
    func approve(_ id: String, _ session: inout CodexSession) -> Out {
        Out(session.answer("monitor:" + id, allow: true))
    }
    func result(_ request: Out, exit: Int, output: String = "hello", _ session: inout CodexSession) -> Out {
        h.response(h.write(request, "command/exec"), ["exitCode": exit, "stdout": output, "stderr": "diagnostic"], &session)
    }
    func payload(_ out: Out) throws -> [String: Any] {
        let tool = try #require(out.params("turn/start")?["toolOutput"] as? [String: Any])
        #expect(tool["name"] as? String == "app_monitor_result")
        let json = try #require(tool["output"] as? String)
        return try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    @Test func routineToolsAndMonitorCompletionRemainIndependentInOneSession() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "monitor-routine-integration-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        var session = CodexSession(config: .init(workingDirectory: root, instructions: "coordinate",
            workerInstructions: "execute", routinesURL: root.appending(path: "routines.cron")))
        let initialize = Out(session.start()).writes[0]
        let thread = h.response(initialize, [:], &session)
        let tools = try #require(thread.params("thread/start")?["dynamicTools"] as? [[String: Any]])
        #expect(Set(tools.compactMap { $0["name"] as? String }) == ["app_routines", "app_monitor_start",
            "app_monitor_status", "app_monitor_cancel", "app_handoff", "app_send_message", "app_task_checkpoint"])
        _ = h.response(h.write(thread, "thread/start"), ["thread": ["id": "root"]], &session)
        h.rootTurn(&session)
        let store = ScheduledRoutineStore(url: root.appending(path: "scheduled-routines.json"))
        for (rpc, kind) in [(930, "once"), (931, "recurring")] {
            var arguments: [String: Any] = ["operation": "create", "kind": kind, "task": "preserve \(kind)",
                "request_id": kind, "timezone": "Asia/Taipei"]
            if kind == "once" { arguments["at"] = "2099-01-01T00:00:00Z" }
            else { arguments["cron"] = "0 9 * * *" }
            let receipt = h.tool(rpc, name: "app_routines", arguments: arguments, &session)
            #expect((receipt.writes.first?["result"] as? [String: Any])?["success"] as? Bool == true)
            #expect(receipt.events.allSatisfy { if case .permission = $0 { false } else { true } })
        }
        let jobs = try store.load()
        #expect(Set(jobs.map(\.kind)) == [.once, .recurring])
        let bytes = try Data(contentsOf: store.url)
        let (id, _) = try start(&session)
        let run = approve(id, &session)
        #expect(!h.completed("root", "parent-1", &session).methods.contains("turn/start"))
        let wake = result(run, exit: 7, &session)
        #expect(try payload(wake)["monitor_id"] as? String == id)
        #expect(try payload(wake)["exit_code"] as? Int == 7)
        #expect(try store.load() == jobs)
        #expect(try Data(contentsOf: store.url) == bytes)
    }

    @Test func completionAndFailureWakeCorrectOwnerExactlyOnceAfterUserQueue() throws {
        for exit in [0, 7] {
            var (session, _) = h.ready()
            h.rootTurn(&session)
            let (id, accepted) = try start(&session)
            #expect(accepted.events.contains(.managedWorkPending(true)))
            let run = approve(id, &session)
            let params = try #require(run.params("command/exec"))
            #expect(params["processId"] as? String == id)
            #expect(params["command"] as? [String] == ["/bin/zsh", "-c", "printf hello; exit 0"])
            #expect(params["outputBytesCap"] as? Int == 8192)
            #expect(params["disableTimeout"] as? Bool == true)
            let sandbox = try #require(params["sandboxPolicy"] as? [String: Any])
            #expect(sandbox["type"] as? String == "workspaceWrite")
            #expect(sandbox["networkAccess"] as? Bool == false)
            #expect(sandbox["writableRoots"] as? [String] == ["/tmp/bot", "/tmp/extra"])
            #expect(Bot.neverAlways.contains("Monitored command"))
            #expect(session.completionWorkerDependencies.first?.callback == "app_monitor_result")
            _ = session.send(.init(text: "user goes first", id: UUID()))
            let done = result(run, exit: exit, &session)
            #expect(!done.methods.contains("turn/start"))
            #expect(session.monitorRecords.first?.wake == .pending)
            #expect(session.monitorRecords.first?.state == (exit == 0 ? .succeeded : .failed))
            #expect(session.completionWorkerDependencies.first?.state == .reportQueued)
            let user = h.completed("root", "parent-1", &session)
            #expect((user.params("turn/start")?["input"] as? [[String: Any]])?.first?["text"] as? String == "user goes first")
            _ = h.response(h.write(user, "turn/start"), ["turn": ["id": "user"]], &session)
            let wake = h.completed("root", "user", &session)
            let report = try payload(wake)
            #expect(report["monitor_id"] as? String == id)
            #expect(report["owner_session_id"] as? String == session.config.ownerSession.uuidString.lowercased())
            #expect(report["exit_code"] as? Int == exit)
            #expect(report["stdout"] as? String == "hello")
            #expect(wake.events.contains(.backgroundTurnStarted))
            #expect(session.monitorRecords.first?.wake == .dispatching)
            _ = h.response(h.write(wake, "turn/start"), ["turn": ["id": "callback"]], &session)
            #expect(session.monitorRecords.first?.wake == .delivered)
            #expect(result(run, exit: exit, &session).writes.isEmpty)
            #expect(h.completed("root", "callback", &session).methods.isEmpty)
            #expect(session.completionWorkerDependencies.isEmpty)
        }
    }

    @Test func idleCompletionKeepsSessionOpenAndUsesExistingMonitorChip() throws {
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let (id, accepted) = try start(&session)
        let run = approve(id, &session)
        var trace = TraceBook()
        for event in accepted.traces + run.traces { trace.apply(event) }
        #expect(trace.tasks.first?.kind == .monitor)
        #expect(!h.completed("root", "parent-1", &session).closed)
        #expect(!Out(session.finish()).closed)
        let done = result(run, exit: 0, output: String(repeating: "a", count: 20_000), &session)
        for event in done.traces { trace.apply(event) }
        #expect(trace.tasks.first?.status == .completed)
        #expect((try payload(done))["stdout"] as? String == String(repeating: "a", count: 8192))
        #expect(session.monitorRecords.first?.id == id)
    }

    @Test func duplicateCallsAndStaleApprovalNeverLaunchTwice() throws {
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let (id, _) = try start(&session)
        let duplicate = h.tool(901, name: "app_monitor_start", arguments: ["command": "touch should-not-run"], &session)
        #expect(duplicate.events.isEmpty)
        #expect(session.monitorRecords.count == 1)
        #expect(approve(id, &session).methods == ["command/exec"])
        #expect(approve(id, &session).writes.isEmpty)
        let deniedThread = h.receive(["method": "item/tool/call", "id": 990, "params": ["threadId": "another-owner", "tool": "app_monitor_start", "arguments": ["command": "true"]]], &session)
        #expect(deniedThread.events.isEmpty)
        #expect(session.monitorRecords.count == 1)
    }

    @Test func denialCancellationAndStopSuppressLateCompletions() throws {
        for mode in ["deny", "cancel", "stop", "queued-cancel"] {
            var (session, _) = h.ready()
            h.rootTurn(&session)
            let (id, _) = try start(&session)
            if mode == "deny" {
                #expect(!Out(session.answer("monitor:" + id, allow: false)).methods.contains("command/exec"))
                #expect(approve(id, &session).methods.isEmpty)
            } else {
                let run = approve(id, &session)
                if mode == "queued-cancel" { _ = result(run, exit: 0, &session) }
                let cancel = mode == "stop" ? Out(session.stop()) : h.tool(902, name: "app_monitor_cancel", arguments: ["monitor_id": id], &session)
                if mode != "queued-cancel" { #expect(cancel.methods.contains("command/exec/terminate")) }
                #expect(result(run, exit: 0, &session).methods.isEmpty)
            }
            #expect(session.monitorRecords.first?.wake == .suppressed)
            #expect(session.monitorRecords.first?.state == (mode == "queued-cancel" ? .succeeded : (mode == "stop" ? .cancelling : .cancelled)))
            #expect(!h.completed("root", "parent-1", &session).methods.contains("turn/start"))
        }
    }

    @Test func restartNeverReplaysCommandsAndPreservesTerminalEvidence() throws {
        let owner = UUID()
        for state in [CommandMonitor.State.awaitingApproval, .running, .succeeded, .failed, .cancelled] {
            var record = CommandMonitor(id: "stable-id", owner: owner, command: "side-effectful", cwd: "/tmp", createdAt: Date())
            record.state = state
            record.wake = state == .cancelled ? .suppressed : .pending
            record.exitCode = state == .succeeded ? 0 : nil
            record.stdout = "durable evidence"
            var session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp"), instructions: "coordinate", workerInstructions: "execute", ownerSession: owner, restoredMonitors: [record]))
            let initialize = Out(session.start()).writes[0]
            let start = h.response(initialize, [:], &session)
            let ready = h.response(h.write(start, "thread/start"), ["thread": ["id": "root"]], &session)
            #expect(!ready.methods.contains("command/exec"))
            if state == .cancelled { #expect(!ready.methods.contains("turn/start")) }
            else {
                let report = try payload(ready)
                #expect(report["monitor_id"] as? String == "stable-id")
                #expect(report["status"] as? String == (record.active ? "interrupted" : state.rawValue))
                if record.active { #expect(report["exit_code"] is NSNull) }
                #expect(report["stdout"] as? String == "durable evidence")
            }
        }
    }

    @Test func crashDuringCallbackDispatchIsExplicitlyUncertainNotDuplicated() {
        let owner = UUID()
        var record = CommandMonitor(id: "uncertain", owner: owner, command: "true", cwd: "/tmp", createdAt: Date())
        record.state = .succeeded; record.exitCode = 0; record.wake = .dispatching
        let session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp"), instructions: "coordinate", ownerSession: owner, restoredMonitors: [record]))
        #expect(session.monitorRecords.first?.wake == .uncertain)
        #expect(session.monitorRecords.first?.detail.contains("No duplicate wake") == true)
        #expect(session.completionWorkerDependencies.isEmpty)
    }

    @Test func storeRoundTripOwnerIsolationAndCorruptionFailClosed() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "monitor-store-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = CodexThreads(folder: root), owner = UUID(), other = UUID()
        let record = CommandMonitor(id: "id", owner: owner, command: "true", cwd: root.path, createdAt: Date())
        try store.saveMonitors([record], for: owner)
        #expect(try store.monitors(for: owner) == [record])
        #expect(try store.monitors(for: other).isEmpty)
        try store.saveMonitors([record], for: other)
        #expect(throws: (any Error).self) { try store.monitors(for: other) }
        try Data("invalid".utf8).write(to: root.appending(path: owner.uuidString.lowercased() + ".monitors.json"))
        #expect(throws: (any Error).self) { try store.monitors(for: owner) }
    }
    @Test func unicodeBoundsStatusListAndStaleTurn() throws {
        let text = String(repeating: "漢🙂", count: 2000)
        let bounded = CommandMonitor.bounded(text)
        #expect(bounded.utf8.count <= 8192)
        #expect(text.hasPrefix(bounded))
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let (id, _) = try start(&session)
        let list = h.tool(920, name: "app_monitor_status", arguments: [:], &session)
        #expect(list.events.isEmpty)
        let full = h.tool(921, name: "app_monitor_status", arguments: ["monitor_id": id], &session)
        #expect(full.events.isEmpty)
        let stale = h.receive(["method": "item/tool/call", "id": 922, "params": ["threadId": "root", "turnId": "stale", "tool": "app_monitor_start", "arguments": ["command": "true"]]], &session)
        #expect(stale.events.isEmpty)
        #expect(session.monitorRecords.count == 1)
        let unknown = h.tool(923, name: "app_monitor_cancel", arguments: ["monitor_id": "not-owned"], &session)
        #expect(unknown.methods.isEmpty)
        #expect(session.monitorRecords.first?.state == .awaitingApproval)
    }

    @Test func cancellingRunWaitsForTerminalEvidenceAndRestartSuppressesWake() throws {
        var (session, _) = h.ready()
        h.rootTurn(&session)
        let (id, _) = try start(&session)
        let run = approve(id, &session)
        _ = h.tool(924, name: "app_monitor_cancel", arguments: ["monitor_id": id], &session)
        #expect(session.monitorRecords.first?.state == .cancelling)
        #expect(session.monitorRecords.first?.endedAt == nil)
        #expect(!Out(session.finish()).closed)
        var record = try #require(session.monitorRecords.first)
        record.reconcile()
        #expect(record.state == .cancelled)
        #expect(record.wake == .suppressed)
        #expect(record.exitCode == nil)
        _ = result(run, exit: 143, &session)
        #expect(session.monitorRecords.first?.state == .cancelled)
        #expect(session.monitorRecords.first?.exitCode == 143)
        #expect(session.monitorRecords.first?.endedAt != nil)
    }

    @Test func monitorPermissionCannotBePersistentlyAllowedByToolName() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "monitor-permission-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(alwaysAllowed: ["Monitored command"])
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        bot.send("Monitor the authorized harmless command")
        await eventually { fake.agents.count == 1 }
        let agent = try #require(fake.agents.first)
        agent.emit(.permission(.init(id: "monitor:probe", tool: "Monitored command", summary: "printf hello", input: "{}")))
        await eventually { bot.openQuestion != nil }
        let question = try #require(bot.openQuestion)
        #expect(question.choices?.map(\.action) == [.allowOnce, .deny])
        #expect(agent.answers.isEmpty)
        #expect(bot.choose(0, in: question.id))
        #expect(agent.answers.first?.1 == true)
    }

    @Test func persistenceFailurePreventsCommandDispatchThroughProductionAdapter() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "monitor-fail-closed-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appending(path: "fake-server.py")
        let script = #"""
        #!/usr/bin/python3
        import json, sys
        from pathlib import Path
        def emit(v):
            print(json.dumps(v), flush=True)
        for line in sys.stdin:
            msg = json.loads(line)
            method = msg.get('method')
            if method == 'initialize': emit({'id':msg['id'], 'result':{}})
            elif method == 'thread/start': emit({'id':msg['id'], 'result':{'thread':{'id':'owner'}}})
            elif method == 'turn/start':
                emit({'id':msg['id'], 'result':{'turn':{'id':'turn'}}})
                emit({'id':901, 'method':'item/tool/call', 'params':{'threadId':'owner', 'turnId':'turn', 'tool':'app_monitor_start', 'arguments':{'command':'printf harmless'}}})
            elif method == 'command/exec':
                Path('dispatched').touch()
                emit({'id':msg['id'], 'result':{'exitCode':0, 'stdout':'harmless', 'stderr':''}})
        """#
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let blocked = root.appending(path: "not-a-directory")
        try Data().write(to: blocked)
        let threads = CodexThreads(folder: root.appending(path: "threads"))
        var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: UUID(), workingDirectory: root, systemPrompt: "fixture")
        launch.codexWorkerInstructions = "unused"
        let process = try CodexAgentProcess(launch, executable: executable, threads: threads)
        var permissionSeen = false
        var exited = false
        var errorText = ""
        let task = Task { @MainActor in
            for await event in process.events {
                if case let .permission(request) = event {
                    permissionSeen = true
                    threads.folder = blocked
                    process.answer(request, allow: true, message: nil)
                }
                if case let .exited(status, stderr) = event {
                    #expect(status != 0)
                    errorText = stderr
                    exited = true
                }
            }
        }
        defer { process.stop(); task.cancel() }
        process.send("start fixture")
        let deadline = Date().addingTimeInterval(10)
        while !exited, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        #expect(permissionSeen)
        #expect(exited)
        #expect(errorText.contains("Could not persist command monitor state"))
        #expect(!FileManager.default.fileExists(atPath: root.appending(path: "dispatched").path))
    }

    @Test func verifierRecognizesOnlyLiveMonitoredCommandCallbacks() {
        var end = PromiseCheck.TurnEnd(reply: "Authorized command is running", workPending: true)
        end.workerDependencies = [.init(id: "monitor", run: 1, task: "authorized command", state: .running, callback: "app_monitor_result")]
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .waitingDependency)
        end.workerDependencies?[0].state = .reportQueued
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .unknown)
        end.workerDependencies?[0].state = .running
        end.workerDependencies?[0].callback = "invented_callback"
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .unknown)
    }

    @Test func stopCleansUpTheMonitoredProcessTreeWithoutALateWake() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "monitor-stop-tree-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appending(path: "fake-server.py")
        try #"""
        #!/usr/bin/python3
        import json, subprocess, sys
        from pathlib import Path
        def emit(v): print(json.dumps(v), flush=True)
        for line in sys.stdin:
            msg=json.loads(line); method=msg.get('method')
            if method=='initialize': emit({'id':msg['id'],'result':{}})
            elif method=='thread/start': emit({'id':msg['id'],'result':{'thread':{'id':'owner'}}})
            elif method=='turn/start':
                emit({'id':msg['id'],'result':{'turn':{'id':'turn'}}})
                emit({'id':901,'method':'item/tool/call','params':{'threadId':'owner','turnId':'turn','tool':'app_monitor_start','arguments':{'command':'sleep 30'}}})
            elif method=='command/exec':
                child=subprocess.Popen(['/bin/sh','-c','sleep 30'])
                Path('child.pid').write_text(str(child.pid))
            # Deliberately ignore terminate to exercise the app-owned tree cleanup.
        """#.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let threads = CodexThreads(folder: root.appending(path: "threads")), owner = UUID()
        var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: owner, workingDirectory: root, systemPrompt: "fixture")
        launch.codexWorkerInstructions = "unused"
        let process = try CodexAgentProcess(launch, executable: executable, threads: threads)
        var wakes = 0
        let task = Task { @MainActor in
            for await event in process.events {
                if case let .permission(request) = event { process.answer(request, allow: true, message: nil) }
                if case .backgroundTurnStarted = event { wakes += 1 }
            }
        }
        defer { process.stop(); task.cancel() }
        process.send("start fixture")
        let pidFile = root.appending(path: "child.pid")
        let deadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: pidFile.path), Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        let pid = try #require(Int32(try String(contentsOf: pidFile, encoding: .utf8)))
        let started = ChildProcessLedger.startTime(of: pid)
        defer { if ChildProcessLedger.startTime(of: pid) == started { kill(pid, SIGKILL) } }
        #expect(started != nil)
        #expect(kill(pid, 0) == 0)
        process.stop()
        let killedBy = Date().addingTimeInterval(3)
        while ChildProcessLedger.startTime(of: pid) == started, !ChildProcessLedger.isZombie(pid), Date() < killedBy {
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(ChildProcessLedger.startTime(of: pid) != started || ChildProcessLedger.isZombie(pid))
        #expect(wakes == 0)
        #expect(try threads.monitors(for: owner).first?.wake == .suppressed)
    }

}
