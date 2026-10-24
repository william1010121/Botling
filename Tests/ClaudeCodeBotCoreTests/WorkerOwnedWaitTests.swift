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
