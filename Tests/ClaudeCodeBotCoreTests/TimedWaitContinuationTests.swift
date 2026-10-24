import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct TimedWaitContinuationTests {
    static let before = Date(timeIntervalSince1970: 1_792_834_593) // 2026-10-24 17:36:33 +08
    static let deadline = Date(timeIntervalSince1970: 1_792_837_800) // 18:30 +08

    /// The saved screenshot's affected boundary: an idle worker, a real enabled app routine,
    /// and an observed external write rollback. A future schedule is not a running worker.
    @Test func turnEndIncludesAppClockAndReloadedRoutineWithoutInventingWorker() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.now = { Self.before }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in
            calls.add(input)
            return .init(verdict: .unknown, reason: "Regression captures evidence only.")
        }
        bot.send("Continue the original 500 target, currently 40/500. Respect rollback cooldown; no parallel worker.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = []
        _ = try saveRoutine(bot)
        agent.reply("40/500; the worker turn ended after saving Resume-X500 for 18:30. No independent work remains before the cooldown check.")
        await eventually { !calls.messages.isEmpty }
        let payload = try #require(calls.messages.first)
        let json = try #require(try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect(json["evaluatedAt"] as? String == Self.before.ISO8601Format())
        #expect(json["timeZone"] as? String == TimeZone.current.identifier)
        let wakeups = try #require(json["scheduledWakeups"] as? [[String: Any]])
        let wakeup = try #require(wakeups.first { ($0["task"] as? String)?.contains("Resume-X500") == true })
        #expect(wakeup["fireAt"] as? String == Self.deadline.ISO8601Format())
        #expect(wakeup["callback"] as? String == "app_routine")
        #expect((json["workerDependencies"] as? [Any])?.isEmpty == true)
        #expect(agent.sent.count == 1)
    }

    @Test func timedWaitingIsDistinctFromCompletionAndLiveDependency() throws {
        let result = try PromiseCheck.parseVerdict(#"{"verdict":"WAITING_TIMER","reason":"Observed rollback; no independent work before the verified 18:30 routine.","wakeupID":"routine-fixture"}"#)
        #expect(result.rawValue == "WAITING_TIMER")
    }
}

extension TimedWaitContinuationTests {
    static func evidence() -> PromiseCheck.TurnEnd {
        var end = PromiseCheck.TurnEnd(reply: "40/500, 460 remain. The worker turn ended. After the observed rollback we are waiting until 18:30 for the existing retry routine, not claiming completion or an active worker.", workPending: true,
            task: "Finish the original 500-record synthetic task; 40 are verified. After a nonpersistent write at 17:28:56, do not write again until the single 18:30 check. All remaining work needs the same external account, with no independent authorized work before that check. Do not claim the unknown cause is a rate limit.",
            actions: ["app_task_checkpoint blocked: observed 17:28:56 write reverted after 20 seconds, no 429/challenge proved. Resume-X500 saved for 2026-10-24 18:30 Asia/Taipei; resume the same task after the normal low-volume check, stop on another failure. No independent progress remains."])
        end.workerDependencies = []
        end.evaluatedAt = before.ISO8601Format()
        end.timeZone = "Asia/Taipei"
        end.scheduledWakeups = [.init(id: "retry", task: "Resume-X500: original 500 target; 40/500, 460 remain; resume the same task after the 18:30 check; do not retry early.", fireAt: deadline, callback: "app_routine")]
        return end
    }

    @Test func timedWaitRequiresExactFutureWakeupAndNeverBecomesCompletion() throws {
        var end = Self.evidence()
        end.terminalRequired = true
        let waiting = PromiseCheck.Judgment(verdict: .waitingTimer, reason: "Observed rollback; retry at 18:30.", wakeupID: "retry")
        #expect(PromiseCheck.review(waiting, for: end) == waiting) // No report-repair loop.
        #expect(PromiseCheck.review(.waitingDependency, for: end).verdict == .unknown)
        for verdict in [PromiseCheck.Judgment.continueWork, .cancelled] {
            #expect(PromiseCheck.review(verdict, for: end) == verdict)
        }
        for invalid in ["no-clock", "expired", "missing", "wrong-id", "no-callback", "omitted"] {
            var bad = end
            switch invalid {
            case "no-clock": bad.evaluatedAt = nil
            case "expired": bad.evaluatedAt = Self.deadline.ISO8601Format()
            case "missing": bad.scheduledWakeups = []
            case "wrong-id": bad.scheduledWakeups?[0].id = "unrelated"
            case "no-callback": bad.scheduledWakeups?[0].callback = "claimed-only"
            default: bad.scheduledWakeupsTruncated = true
            }
            #expect(PromiseCheck.review(waiting, for: bad).verdict == .unknown, "Reject \(invalid)")
        }
    }

    @Test func clockComparisonIsAppComputedAndDoesNotPretendEvidenceWasTruncated() throws {
        var end = Self.evidence()
        for offset in [-1.0, 0.0, 60.0] {
            end.evaluatedAt = Self.deadline.addingTimeInterval(offset).ISO8601Format()
            let packed = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(PromiseCheck.classifierMessage(end).utf8))
            #expect(packed.scheduledWakeups?.first?.isDue == (offset >= 0))
            #expect(!packed.evidenceTruncated)
        }
    }

    @Test func packingPreservesClockAndWakeupIdentityAlongsideProtectedWorkers() throws {
        let huge = String(repeating: "資料\"\\\n", count: 20000)
        var end = Self.evidence()
        end.task += huge
        end.conversation = huge
        end.actions = Array(repeating: huge, count: 12)
        end.workerDependencies = (0..<30).map { .init(id: "worker-\($0)", run: 2, task: "Other owned slice", state: .running, callback: "app_task_result") }
        end.scheduledWakeups?[0].task = "Observed rollback; original task. " + huge + "STOP on another failure"
        let message = PromiseCheck.classifierMessage(end)
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(message.utf8))
        #expect(message.utf8.count <= 96_000)
        #expect(decoded.workerDependencies == end.workerDependencies)
        #expect(decoded.evaluatedAt == end.evaluatedAt)
        #expect(decoded.scheduledWakeups?.first?.id == "retry")
        #expect(decoded.scheduledWakeups?.first?.fireAt == Self.deadline.ISO8601Format())
        #expect(decoded.scheduledWakeups?.first?.callback == "app_routine")
        #expect(decoded.scheduledWakeups?.first?.taskTruncated == true)
        #expect(decoded.scheduledWakeups?.first?.task.hasSuffix("STOP on another failure") == true)
        end.scheduledWakeups = Array(repeating: end.scheduledWakeups![0], count: 100)
        let omitted = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(PromiseCheck.classifierMessage(end).utf8))
        #expect(omitted.scheduledWakeupsTruncated)
        #expect(PromiseCheck.review(.init(verdict: .waitingTimer, reason: "wait", wakeupID: "retry"), for: omitted).verdict == .unknown)
    }

    private func saveRoutine(_ bot: Bot) throws -> Routine {
        let parts = Calendar.current.dateComponents([.minute, .hour, .day, .month], from: Self.deadline)
        let line = "\(parts.minute!) \(parts.hour!) \(parts.day!) \(parts.month!) * Resume-X500: Check the observed rollback once and resume the original remaining 460; no early retries."
        try (line + "\n").write(to: bot.profile.routinesURL, atomically: true, encoding: .utf8)
        bot.reloadRoutines()
        let routine = try #require(bot.routines.first)
        #expect(!bot.isDue(routine, at: Self.before))
        return routine
    }

    @Test(arguments: ["removed", "deadline"])
    func timerChangingDuringInferenceIsRejudged(_ change: String) async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        var clock = Self.before
        bot.now = { clock }
        let gate = AsyncStream<Void>.makeStream()
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            calls.add(PromiseCheck.classifierMessage(end))
            if calls.messages.count == 1 {
                for await _ in gate.stream { break }
                return .init(verdict: .waitingTimer, reason: "Observed rollback; wait until the saved retry.", wakeupID: end.scheduledWakeups?.first?.id)
            }
            return .init(verdict: .unknown, reason: "Old wait no longer valid; current evidence needs review.")
        }
        bot.send("Original 500 target; honor the existing rollback cooldown.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = []
        _ = try saveRoutine(bot)
        agent.reply("Waiting on the observed rollback until 18:30; no live worker.")
        await eventually { calls.messages.count == 1 }
        if change == "removed" {
            try "# removed\n".write(to: bot.profile.routinesURL, atomically: true, encoding: .utf8)
        } else { clock = Self.deadline }
        gate.continuation.yield(())
        gate.continuation.finish()
        await eventually { calls.messages.count == 2 && bot.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .judged }
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unknown)
        #expect(agent.sent.count == 1)
        #expect(!bot.messages.contains { $0.completionVerification?.verdict == .waitingTimer })
    }

    @Test func acceptedCooldownDoesNotSelfRetryAndExistingRoutineWakesOnceAtDeadline() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        var clock = Self.before
        bot.now = { clock }
        bot.promiseCheck = { end in
            if end.reply == "Incomplete result; I will continue." { return .continueWork }
            return .init(verdict: .waitingTimer, reason: "Observed rollback; next check at18:30, no independent work.", wakeupID: end.scheduledWakeups?.first?.id)
        }
        bot.send("Finish the original target, respect rollback cooldown; no parallel worker.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = []
        agent.reply("Incomplete result; I will continue.")
        await eventually { agent.sent.count == 2 }
        let routine = try saveRoutine(bot)
        agent.reply("The worker turn ended. Observed rollback; saved 18:30 check. All 460 remain; no independent work can advance.")
        await eventually { bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingTimer }
        #expect(agent.sent.count == 2)
        #expect(!bot.messages.contains { $0.completionVerification?.continuationPaused == true })
        #expect(!bot.messages.contains { $0.text.contains("Checking terminal evidence:") })
        #expect(!bot.isDue(routine, at: Self.deadline.addingTimeInterval(-1)))
        clock = Self.deadline
        #expect(bot.isDue(routine, at: clock))
        bot.run(routine, prompt: "Resume the original task after its scheduled normal check.", at: clock)
        await eventually { agent.sent.count == 3 }
        #expect(!bot.isDue(routine, at: clock))
        #expect(agent.sent.last?.contains("Resume the original task") == true)
    }
}

extension TimedWaitContinuationTests {
    /// Opt-in real inference, with production schema, parser and local review. All task data is
    /// synthetic/reconstructed from the recorded failure. This does not operate the X account.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE_TIMED_WAIT"] == "1"))
    func realJudgeDistinguishesCooldownFromBareScheduleIndependentWorkAndStop() async throws {
        let folder = URL(filePath: ProcessInfo.processInfo.environment["CCB_TIMED_WAIT_EVIDENCE"] ?? "/private/tmp/ccb-timed-wait-live-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let classifier = PromiseCheck.codexClassifier()
        var rows: [[String: String]] = []
        for name in ["observed-cooldown", "bare-schedule", "independent-work", "expired", "stopped"] {
            var end = Self.evidence()
            let expected: PromiseCheck.Verdict
            switch name {
            case "bare-schedule":
                end.task = "Analyze the local error table now. This is already authorized research only; do not implement. The table is available locally, with no external restriction or other blocker."
                end.reply = "I saved a routine for later and will analyze next."
                end.actions = []
                expected = .continueWork
            case "independent-work":
                end.task += " Independently analyze the already-local error table NOW; it does not use the external account and has not been done or delegated."
                end.reply += " I will analyze the local error table next."
                expected = .continueWork
            case "expired":
                end.evaluatedAt = Self.deadline.addingTimeInterval(60).ISO8601Format()
                end.task += " At the deadline the authorized next action is one normal read-only check, then report actual results. No other blocking condition is known."
                expected = .continueWork
            case "stopped":
                end.task += " LATEST USER INSTRUCTION: Stop and pause this task; do not resume."
                end.conversation = "[user] Stop and pause this task; do not resume."
                end.reply = "Stopped."
                expected = .cancelled
            default: expected = .waitingTimer
            }
            let payload = PromiseCheck.classifierMessage(end)
            try payload.write(to: folder.appending(path: name + "-input.json"), atomically: true, encoding: .utf8)
            let judgment = PromiseCheck.review(await PromiseCheck.check(end, classify: classifier), for: end)
            rows.append(["case": name, "expected": expected.rawValue, "actual": judgment.rawValue, "reason": judgment.reason, "wakeupID": judgment.wakeupID ?? ""])
            print("Timed-wait live \(name): \(judgment.rawValue); \(judgment.reason)")
            #expect(judgment.verdict == expected)
        }
        try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appending(path: "results.json"))
        print("Timed-wait live evidence:", folder.path)
    }
}

extension TimedWaitContinuationTests {
    @Test func partnerJudgmentUsesThePrimaryBotsActualRoutines() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.now = { Self.before }
        _ = try saveRoutine(bot)
        await bot.setHeads([.claude, .codex])
        bot.send("Original remaining work is in a rollback cooldown; the routine is in this project's shared routines file.", to: .codex)
        let partner = try #require(bot.partner)
        partner.now = { Self.before }
        let calls = PromiseCheckTests.Calls()
        partner.promiseCheck = { end in
            calls.add(PromiseCheck.classifierMessage(end))
            return .init(verdict: .waitingTimer, reason: "Observed rollback; saved18:30 wakeup, no independent work.", wakeupID: end.scheduledWakeups?.first?.id)
        }
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.completionWorkerDependencies = []
        agent.reply("Worker turn ended; observed rollback; waiting for the shared18:30 routine.")
        await eventually { partner.messages.contains { $0.completionVerification?.verdict == .waitingTimer } }
        let end = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(try #require(calls.messages.first).utf8))
        #expect(end.workerDependencies == [])
        #expect(end.scheduledWakeups?.first?.callback == "app_routine")
        #expect(end.scheduledWakeups?.first?.fireAt == Self.deadline.ISO8601Format())
        #expect(agent.sent.count == 1)
    }
}

extension TimedWaitContinuationTests {
    @Test func existingSessionWakeupsRemainClockEvidenceSeparateFromRunningOwners() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.now = { Self.before }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            calls.add(PromiseCheck.classifierMessage(end))
            return .init(verdict: .unknown, reason: "A schedule alone does not establish a blocker.")
        }
        bot.send("Analyze the locally available table now. A fallback schedule is not a reason to wait.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in [ScheduleRun.wakeup, ScheduleRun.wakeupSet, ScheduleRun.cron, ScheduleRun.cronSet] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("I have a future wakeup and a recurring fallback schedule.")
        await eventually { !calls.messages.isEmpty }
        let end = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(try #require(calls.messages.first).utf8))
        let session = end.scheduledWakeups?.filter { $0.callback == "session_wakeup" } ?? []
        #expect(session.count == 2)
        #expect(session.allSatisfy { ($0.date ?? .distantPast) > Self.before })
        #expect(end.dependencies.isEmpty)
        #expect(agent.sent.count == 1)
    }
}
