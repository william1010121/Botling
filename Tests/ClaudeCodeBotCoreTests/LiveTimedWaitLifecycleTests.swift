import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Real worker → production Bot/adapter → real completion judge → timed routine → same
/// worker callback. All work is synthetic local fixture IO, never an external account.
@MainActor
struct LiveTimedWaitLifecycleTests {
    enum Failure: Error { case timeout(String) }
    private func wait(_ label: String, seconds: Double = 180, until ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !ready() {
            guard Date() < deadline else { throw Failure.timeout(label) }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE_TIMED_LIFECYCLE"] == "1"))
    func actualWorkerCooldownAndScheduledCallback() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appending(path: "ccb-live-timed-lifecycle-\(UUID())")
        let folder = root.appending(path: "fixture")
        try fm.createDirectory(at: folder.appending(path: ".bot"), withIntermediateDirectories: true)
        print("Live timed lifecycle evidence:", root.path)
        let real = try #require(CodexCLI.newestExecutable())
        let relay = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "LiveCodexManagedWorkers/relay.py")
        let before = TimedWaitContinuationTests.before, deadline = TimedWaitContinuationTests.deadline
        let parts = Calendar.current.dateComponents([.minute, .hour, .day, .month], from: deadline)
        let line = "\(parts.minute!) \(parts.hour!) \(parts.day!) \(parts.month!) * Fixture-retry: Resume the original synthetic task with app_send_message to its original task_id. The explicit not-before time has arrived; run python3 fixture.py once. No new worker."
        let fixture: [String: Any] = ["phase": "cooldown", "count": 40, "remaining": 460, "target": 500,
            "not_before": deadline.ISO8601Format(), "routine": line,
            "observed": "Synthetic external write reverted after20seconds; cause unknown. Explicitly no more work until the fixture's not_before time."]
        try JSONSerialization.data(withJSONObject: fixture, options: .prettyPrinted).write(to: folder.appending(path: "fixture.json"))
        try """
        import json, time
        from pathlib import Path
        data=json.loads(Path('fixture.json').read_text())
        if data['phase']=='cooldown':
            Path('.ready').touch()
            until=time.monotonic()+180
            while not Path('.release').exists():
                if time.monotonic()>until: raise RuntimeError('test gate not released')
                time.sleep(.1)
            Path('.bot/routines.cron').write_text(data['routine']+'\\n')
            print(json.dumps({'status':'external_cooldown','count':40,'remaining':460,'not_before':data['not_before'],'observed':data['observed'],'next_wake':'Fixture-retry','independent_work':False}))
        else:
            Path('.bot/routines.cron').write_text('# retry consumed\\n')
            Path('receipt.json').write_text(json.dumps({'count':500,'remaining':0,'fixture_only':True}))
            print('SYNTHETIC TASK COMPLETE: receipt.json has count500, remaining0; retry routine consumed. No external service was accessed.')
        """.write(to: folder.appending(path: "fixture.py"), atomically: true, encoding: .utf8)
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: .codex)
        var heads = HeadsSettings(engines: [.codex])
        heads.codexModel = "gpt-6.1-sol"
        store.save(heads: heads)
        store.save(codexWorkerDefaults: .init(model: "gpt-6.1-sol", effort: .medium))
        let threads = CodexThreads(folder: root.appending(path: "threads"))
        let launcher: AgentLauncher = { input in
            var launch = input
            launch.environment["CCB_LIVE_CODEX_REAL"] = real.path
            launch.environment["CCB_LIVE_CODEX_EVIDENCE"] = root.path
            return try CodexAgentProcess(launch, executable: relay, threads: threads)
        }
        let bot = Bot(profile: .manager(name: "Timed fixture", avatar: "square", folder: folder), launcher: launcher, store: store)
        bot.autoMode = { true }
        defer { bot.stop() }
        var clock = before
        bot.now = { clock }
        let calls = PromiseCheckTests.Calls()
        let classify = PromiseCheck.codexClassifier()
        bot.promiseCheck = { end in
            let payload = PromiseCheck.classifierMessage(end)
            calls.add(payload)
            let judgment = await PromiseCheck.check(end, classify: classify)
            let index = calls.messages.count
            try? payload.write(to: root.appending(path: "judge-\(index)-input.json"), atomically: true, encoding: .utf8)
            try? JSONEncoder().encode(judgment).write(to: root.appending(path: "judge-\(index)-result.json"))
            return judgment
        }
        bot.send("""
        This is an isolated local acceptance fixture, with no real external account. Delegate exactly one app worker the complete synthetic500-record task, 40 already verified, all460 remaining. The worker must execute python3 fixture.py once and report its actual JSON. Do not delegate independent work or modify fixture.py. Finish your dispatch turn while it runs. On external_cooldown, all remaining work is blocked by the explicit not_before value; no local analysis or other work remains authorized. Record the active result as blocked with observed evidence, current40/500 and the saved Fixture-retry routine. Say the worker execution turn ended and the original task_id is its future resume route, not an active worker. The App clock is fixed at2026-10-24T09:36:33Z for this test; the normal check is at2026-10-24T10:30:00Z. Do not poll or retry before it. When the App routine fires, use app_send_message to the SAME worker task_id to execute python3 fixture.py again; do not create a new worker. Once it reports receipt.json with500 and0remaining, accept the active report as complete and report the fixture result. Never access X, a browser or a remote service.
        """)
        try await wait("worker gate and live dependency judgment") {
            fm.fileExists(atPath: folder.appending(path: ".ready").path)
                && bot.messages.contains { $0.completionVerification?.verdict == .waitingDependency }
        }
        let workerID = try #require(bot.trace.subagents.first(where: { $0.type == "codex-worker" })?.id)
        #expect(bot.trace.subagent(workerID)?.isRunning == true)
        try Data().write(to: folder.appending(path: ".release"))
        try await wait("completed worker reports cooldown through production Bot and judge") {
            bot.messages.contains { $0.completionVerification?.verdict == .waitingTimer }
        }
        #expect(bot.trace.subagent(workerID)?.status == .completed)
        let waitPayload = try #require(calls.messages.last)
        let end = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(waitPayload.utf8))
        #expect(end.workerDependencies == [])
        #expect(end.scheduledWakeups?.contains { $0.callback == "app_routine" && $0.fireAt == deadline.ISO8601Format() } == true)
        #expect(!bot.messages.contains { $0.completionVerification?.continuationPaused == true })
        bot.reloadRoutines()
        let routine = try #require(bot.routines.first(where: { $0.title == "Fixture-retry" }))
        #expect(!bot.isDue(routine, at: before))
        #expect(!bot.isDue(routine, at: deadline.addingTimeInterval(-1)))
        var ready = fixture
        ready["phase"] = "ready"
        try JSONSerialization.data(withJSONObject: ready).write(to: folder.appending(path: "fixture.json"))
        clock = deadline
        #expect(bot.isDue(routine, at: clock))
        bot.run(routine, prompt: "(App: Time for Fixture-retry. Resume original task_id=\(workerID) with app_send_message; ask that SAME worker to run python3 fixture.py once. No new worker.)", at: clock)
        #expect(!bot.isDue(routine, at: clock))
        try await wait("same worker second run reports final receipt and complete judgment") {
            fm.fileExists(atPath: folder.appending(path: "receipt.json").path)
                && bot.messages.contains { $0.completionVerification?.verdict == .complete }
        }
        #expect(bot.trace.subagents.filter { $0.type == "codex-worker" }.map(\.id) == [workerID])
        let records = threads.workers(for: try #require(bot.messages.last(where: { $0.role == .bot })?.session))
        #expect(records.first(where: { $0.id == workerID })?.run == 2)
        #expect(records.first(where: { $0.id == workerID })?.wasActive == false)
        try JSONEncoder().encode(bot.messages).write(to: root.appending(path: "chat.json"))
        print("Live timed lifecycle passed: same worker", workerID, "two runs; live wait → idle timer wait → due routine → worker callback → COMPLETE")
    }
}
