import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// "Unfinished, but every remaining piece is held by a live worker" must not wake the head.
@MainActor
struct WorkerOwnedWaitTests {
    final class Script: @unchecked Sendable {
        private let lock = NSLock()
        private var verdicts: [PromiseCheck.Verdict]
        private(set) var calls = 0
        init(_ verdicts: [PromiseCheck.Verdict]) { self.verdicts = verdicts }
        func next() -> PromiseCheck.Judgment {
            lock.withLock {
                calls += 1
                return .init(verdict: verdicts.isEmpty ? .unknown : verdicts.removeFirst(), reason: "scripted")
            }
        }
        var count: Int { lock.withLock { calls } }
    }

    private func end(_ workers: [PromiseCheck.WorkerDependency]?, truncated: Bool = false) -> PromiseCheck.TurnEnd {
        var end = PromiseCheck.TurnEnd(reply: "All remaining work is owned by the running workers.", workPending: true,
            task: "Fix the bug, add a one-shot routine and a monitor.")
        end.workerDependencies = workers
        end.workerDependenciesTruncated = truncated
        return end
    }
    private let live = PromiseCheck.WorkerDependency(id: "51db02f0", run: 1, task: "integrate the validator", state: .running, callback: "app_task_result")
    private let queued = PromiseCheck.WorkerDependency(id: "0fc8a037", run: 1, task: "audit candidates", state: .reportQueued, callback: "app_task_result", outcome: "completed")

    @Test func aContinueWhileLiveWorkersRunIsCheckedAgainAndASecondWaitWins() async {
        let script = Script([.continueWork, .waitingDependency])
        let judgment = await PromiseCheck.check(end([live]), classify: { _ in script.next() })
        #expect(judgment.verdict == .waitingDependency)
        #expect(script.count == 2)
    }

    @Test func genuineContinuationsStillWake() async {
        // Two independent CONTINUE judgments: concrete unowned work remains.
        let both = Script([.continueWork, .continueAnalysis])
        #expect(await PromiseCheck.check(end([live]), classify: { _ in both.next() }).verdict == .continueWork)
        #expect(both.count == 2)
        // A finished worker's queued result, no live owner, or an incomplete snapshot: one judgment decides.
        for workers in [[queued], [], nil] as [[PromiseCheck.WorkerDependency]?] {
            let script = Script([.continueWork, .waitingDependency])
            #expect(await PromiseCheck.check(end(workers), classify: { _ in script.next() }).verdict == .continueWork)
            #expect(script.count == 1)
        }
        let truncated = Script([.continueWork, .waitingDependency])
        #expect(await PromiseCheck.check(end([live], truncated: true), classify: { _ in truncated.next() }).verdict == .continueWork)
        #expect(truncated.count == 1)
        // Only a dependency wait overrides; any other second answer keeps the first.
        let other = Script([.continueWork, .complete])
        #expect(await PromiseCheck.check(end([live]), classify: { _ in other.next() }).verdict == .continueWork)
        // A failed second call keeps the first judgment.
        let failing = Script([.continueWork])
        let judgment = await PromiseCheck.check(end([live]), classify: { _ in
            if failing.count >= 1 { throw CocoaError(.featureUnsupported) }
            return failing.next()
        })
        #expect(judgment.verdict == .continueWork)
    }

    @Test func nonContinueVerdictsAreNeverReasked() async {
        for verdict in [PromiseCheck.Verdict.waitingDependency, .complete, .waitingUser, .cancelled, .unknown] {
            let script = Script([verdict, .continueWork])
            #expect(await PromiseCheck.check(end([live]), classify: { _ in script.next() }).verdict == verdict)
            #expect(script.count == 1)
        }
    }

    /// The Bot pipeline: an interim worker wake judged as a dependency wait stays quiet.
    @Test func aWaitingWakePostsNoContinuationNoticeAndSendsNothing() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let script = Script([.continueWork, .waitingDependency])
        bot.promiseCheck = PromiseCheck.checker { _ in script.next() }
        bot.send("Fix the bug, add a one-shot routine and a monitor.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = [live]
        agent.reply("Remaining work is owned by 51db02f0; its app_task_result will wake me.")
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingDependency)
        #expect(!bot.messages.contains { $0.role == .notice })
        #expect(agent.sent.count == 1)
    }
}

/// Settings → Completion verification can be turned off.
@MainActor
struct CompletionVerificationToggleTests {
    @Test func offMeansNoJudgeNoRowNoWakeForBothHeadsAndSurvivesReload() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-verifier-off-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let calls = PromiseCheckTests.Calls()
        let factory: (String) -> PromiseCheck.Classifier = { model in
            { _ in calls.add(model); return .init(verdict: .continueWork, reason: "work remains") }
        }
        func open(_ fake: FakeLauncher) -> Workspace {
            Workspace(root: root, launcher: fake.launcher, completionClassifier: factory) { profile, store in
                Bot(profile: profile, launcher: fake.launcher, store: store)
            }
        }
        #expect(try JSONDecoder().decode(AppSettings.self, from: Data(#"{"developerMode":false}"#.utf8)).completionVerificationEnabled)
        let fake = FakeLauncher()
        let workspace = open(fake)
        defer { workspace.modelSettingsBots.forEach { $0.stop() } }
        #expect(workspace.settings.completionVerificationEnabled)
        let bot = workspace.mainBot
        await bot.setHeads([.claude, .codex])
        workspace.setCompletionVerificationEnabled(false)
        #expect(bot.promiseCheck == nil)
        for engine in [BotEngine.claude, .codex] {
            let before = (engine == .claude ? bot : bot.partner)?.messages.filter { $0.role == .bot }.count ?? 0
            bot.send("I'll look into it and report back.", to: engine == .claude ? .claude : .codex)
            await eventually { (engine == .claude ? bot : bot.partner).map { $0.messages.filter { $0.role == .bot }.count > before && !$0.isWorking } ?? false }
        }
        try await Task.sleep(for: .milliseconds(300))
        #expect(try #require(bot.partner).promiseCheck == nil) // Made after the switch: inherits off.
        #expect(calls.messages.isEmpty)
        for head in [bot, try #require(bot.partner)] {
            #expect(head.messages.allSatisfy { $0.completionVerification == nil })
            #expect(!head.messages.contains { $0.role == .notice && $0.text.contains("Continuing") })
        }
        // Persisted, applied to reloaded and newly made bots.
        let reloaded = open(FakeLauncher())
        defer { reloaded.modelSettingsBots.forEach { $0.stop() } }
        #expect(!reloaded.settings.completionVerificationEnabled)
        #expect(reloaded.mainBot.promiseCheck == nil)
        let project = reloaded.addProject(folder: root.appending(path: "project"), select: false)
        #expect(try #require(reloaded.bot(for: project)).promiseCheck == nil)
        // Turning it back on restores checking from the next reply.
        reloaded.setCompletionVerificationEnabled(true)
        #expect(reloaded.mainBot.promiseCheck != nil)
        #expect(try #require(reloaded.bot(for: project)).promiseCheck != nil)
    }
}

/// Running Claude Agent-tool subagents own work like app-managed workers, a task already reported
/// complete is not revived, and two continuations without a new result pause the loop.
@MainActor
struct JudgeOwnershipAndLoopTests {
    final class Ends: @unchecked Sendable {
        private let lock = NSLock()
        private var _ends: [PromiseCheck.TurnEnd] = []
        func add(_ end: PromiseCheck.TurnEnd) { lock.withLock { _ends.append(end) } }
        var ends: [PromiseCheck.TurnEnd] { lock.withLock { _ends } }
    }

    /// Before the fix the subagents were only free-text dependencies with no live snapshot, so a
    /// first CONTINUE was final and the head was woken again and again while they ran.
    @Test func aHeadWaitingOnItsRunningSubagentsIsNotWoken() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        let script = WorkerOwnedWaitTests.Script([.continueWork, .waitingDependency])
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return script.next() }
        bot.send("Investigate the three failing suites in parallel and fix them.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for n in 1...3 {
            agent.emit(.trace(.subagentStarted(id: "toolu_\(n)", description: "Fix suite \(n)", type: "general-purpose",
                prompt: "Fix failing suite \(n) and report", background: true)))
        }
        agent.reply("All three suites are owned by my 3 running subagents; their notifications will wake me to integrate.")
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        try await Task.sleep(for: .milliseconds(100))
        #expect(script.count == 2)
        let input = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(try #require(calls.messages.first).utf8))
        let owners = try #require(input.workerDependencies)
        #expect(owners.count == 3)
        #expect(owners.allSatisfy { $0.state == .running && $0.callback == PromiseCheck.subagentCallback })
        #expect(owners.contains { $0.task.contains("Fix failing suite 2") })
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingDependency)
        #expect(!bot.messages.contains { $0.role == .notice })
        #expect(agent.sent.count == 1)
    }

    /// The activity tracker can hold stale worker cards (still "running" in subagents.json from
    /// before an app restart, or a Codex worker's card with no live app-server task). Only the
    /// live process's work may own the remaining task; a real running Claude subagent does.
    @Test func staleTrackerRecordsAreNotLiveOwnersButARealSubagentIs() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-stale-owners-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = BotStore(directory: root.appending(path: "bot"))
        store.save(subagents: [
            Subagent(id: "toolu_before_restart", description: "Old suite fix", type: "general-purpose", prompt: "Fix suite 9", background: true),
            Subagent(id: "codex-stale", description: "Old Codex worker", type: "codex-worker", prompt: "Integrate the validator", background: true)
        ])
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = Bot(profile: .main(home: root.appending(path: "home")), launcher: fake.launcher, store: store)
        defer { bot.stop() }
        #expect(!bot.subagents.contains { $0.isRunning })
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return .waitingDependency }
        bot.send("Fix the failing suite.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        // A Codex worker card in the tracker is display only; the process reports live workers.
        agent.emit(.trace(.subagentStarted(id: "codex-card", description: "Codex worker card", type: "codex-worker",
            prompt: "Integrate", background: true)))
        agent.emit(.trace(.subagentStarted(id: "toolu_live", description: "Fix suite", type: "general-purpose",
            prompt: "Fix the failing suite and report", background: true)))
        agent.reply("The live subagent owns the fix; its notification will wake me.")
        await eventually { !calls.messages.isEmpty }
        let input = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(calls.messages[0].utf8))
        #expect(input.workerDependencies?.map(\.id) == ["toolu_live"])
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingDependency)
        #expect(agent.sent.count == 1)
    }

    @Test func runningSubagentsAloneSupportADependencyWait() {
        var end = PromiseCheck.TurnEnd(reply: "Waiting on my subagents.", workPending: true, task: "Fix it.")
        end.workerDependencies = [.init(id: "toolu_1", run: 1, task: "Fix suite 1", state: .running, callback: PromiseCheck.subagentCallback)]
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .waitingDependency)
        #expect(PromiseCheck.hasLiveWorkerOwner(end))
        end.workerDependencies = []
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .unknown)
    }

    /// A finished, merged task stayed the "authorized task", so a later turn was judged against it
    /// and the head was told to continue work it had already merged.
    @Test func aTaskReportedCompleteIsNotRevived() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let ends = Ends()
        // A judge that, like the real one did, revives the merge task whenever it is still the
        // authorization or an open instruction.
        bot.promiseCheck = { end in
            ends.add(end)
            if end.reply.contains("Merged") { return .init(verdict: .complete, reason: "abc123 merged into main") }
            let open = end.conversation.components(separatedBy: "Recent conversation:").first ?? ""
            return end.task.contains("login bug") || open.contains("login bug")
                ? .init(verdict: .continueWork, reason: "the login bug fix is not merged") : .complete
        }
        bot.send("Fix the login bug and merge it into main.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("Merged abc123 into main; tests pass. <end>login fix merged as abc123 on main</end>")
        await eventually { ends.ends.count == 1 && !bot.isWorking }
        try await Task.sleep(for: .milliseconds(100))
        // A later turn the user did not start (a background report).
        agent.reply("The nightly backup finished.")
        await eventually { ends.ends.count == 2 }
        try await Task.sleep(for: .milliseconds(100))
        // And a new, unrelated question.
        bot.send("What time zone is the server in?")
        await eventually { agent.sent.count == 2 }
        agent.reply("UTC.")
        await eventually { ends.ends.count == 3 }
        try await Task.sleep(for: .milliseconds(150))
        for end in ends.ends.dropFirst() {
            #expect(!end.task.contains("login bug"))
            #expect(!(end.conversation.components(separatedBy: "Recent conversation:").first ?? "").contains("login bug"))
            #expect(end.completed?.first?.contains("abc123") == true)
        }
        #expect(!bot.messages.contains { $0.role == .notice && $0.text.contains("Continuing") })
        #expect(agent.sent.count == 2)
    }

    /// Continuations that bring no new result stop after two, not later.
    @Test func twoContinuationsWithoutANewResultPause() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .init(verdict: .continueWork, reason: "work remains") }
        bot.send("Bring the flaky test suite to green.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        // The first turn produced a real result.
        agent.emit(.trace(.toolUse(id: "t1", tool: "Bash", title: "Run tests", detail: "swift test", parent: nil)))
        agent.emit(.trace(.toolResult(id: "t1", output: "3 failures", failed: false, parent: nil)))
        agent.reply("Three failures remain; I'll keep going.")
        await eventually { agent.sent.count == 2 }
        agent.reply("Still looking into it.")
        await eventually { agent.sent.count == 3 }
        agent.reply("Still looking into it, will continue.")
        await eventually { bot.messages.contains { $0.role == .notice && $0.text.contains("Automatic continuation paused") } }
        try await Task.sleep(for: .milliseconds(100))
        #expect(agent.sent.count == 3)
        #expect(bot.messages.filter { $0.role == .notice && $0.text.hasPrefix("Continuing") }.count == 2)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.continuationPaused == true)
    }
}
