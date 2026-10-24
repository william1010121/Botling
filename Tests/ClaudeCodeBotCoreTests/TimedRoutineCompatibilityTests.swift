import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct TimedRoutineCompatibilityTests {
    let before = Date(timeIntervalSince1970: 1_792_834_593)
    let deadline = Date(timeIntervalSince1970: 1_792_837_800)

    private func setup() -> (Bot, FakeLauncher, ScheduledRoutineStore) {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        for routine in bot.routines { bot.setRoutine(routine.id, enabled: false) }
        bot.now = { self.before }
        let store = ScheduledRoutineStore(url: bot.profile.routinesURL.deletingLastPathComponent().appending(path: "scheduled-routines.json"))
        return (bot, fake, store)
    }

    private func create(_ bot: Bot, kind: String = "once", request: String = "retry") throws -> ScheduledRoutine {
        var args: [String: Any] = ["operation": "create", "kind": kind, "task": "Cooldown check: resume the original task after the observed external failure; no independent work before the retry.", "request_id": request]
        if kind == "once" {
            args["at"] = deadline.ISO8601Format()
            args["timezone"] = "Asia/Taipei"
        } else {
            args["cron"] = "30 6 * * *"
            args["timezone"] = "America/New_York" // 06:30 EDT = 10:30Z, unlike the host's zone.
        }
        #expect(bot.routineOperation(args, at: before))
        return try #require(bot.scheduledRoutines.first { $0.requestID == request })
    }

    private func capture(_ bot: Bot, _ fake: FakeLauncher, id: String,
                         workers: [PromiseCheck.WorkerDependency] = []) async throws -> PromiseCheck.TurnEnd {
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            calls.add(PromiseCheck.classifierMessage(end))
            return .init(verdict: .waitingTimer, reason: "Observed failure; waiting for the saved retry, no independent work.", wakeupID: id)
        }
        bot.send("Continue the existing synthetic task; respect its evidenced cooldown, do not retry early or create another worker.")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].completionWorkerDependencies = workers
        fake.agents[0].reply("Worker execution ended. Remaining work waits for the saved retry; the task is unfinished.")
        await eventually { bot.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .judged }
        return try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(try #require(calls.messages.first).utf8))
    }

    @Test(arguments: ["once", "recurring"])
    func pendingRoutineRetainsPersistedIdAbsoluteTimeAndCallback(_ kind: String) async throws {
        let (bot, fake, store) = setup()
        defer { bot.stop() }
        let job = try create(bot, kind: kind)
        let bytes = try Data(contentsOf: store.url)
        let end = try await capture(bot, fake, id: job.id)
        let wake = try #require(end.scheduledWakeups?.first { $0.id == job.id })
        #expect(wake.fireAt == deadline.ISO8601Format())
        #expect(wake.callback == "app_routine")
        #expect(wake.isDue == false)
        #expect(wake.task == job.task)
        #expect(end.workerDependencies == [])
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingTimer)
        #expect(fake.agents[0].sent.count == 1)
        #expect(try Data(contentsOf: store.url) == bytes) // Snapshotting must not claim/rearm a job.
    }

    @Test(arguments: ["once", "recurring"])
    func overdueRoutineStaysDueRatherThanRollingToAFutureOccurrence(_ kind: String) async throws {
        let (bot, fake, _) = setup()
        defer { bot.stop() }
        let job = try create(bot, kind: kind)
        bot.now = { self.deadline.addingTimeInterval(60) }
        let end = try await capture(bot, fake, id: job.id)
        let wake = try #require(end.scheduledWakeups?.first { $0.id == job.id })
        #expect(wake.fireAt == deadline.ISO8601Format())
        #expect(wake.isDue == true)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unknown)
        #expect(fake.agents[0].sent.count == 1)
    }

    @Test(arguments: ["cancelled", "paused", "claimed", "fired"])
    func nonPendingRecordsCannotJustifyWaitingEvenWhenTheirTimeIsFuture(_ state: String) async throws {
        let (bot, fake, store) = setup()
        defer { bot.stop() }
        let job = try create(bot)
        if state == "cancelled" || state == "paused" {
            _ = try store.perform(["operation": state == "cancelled" ? "cancel" : "pause", "id": job.id], now: before)
        } else {
            #expect(try store.claim(job.id, now: deadline) != nil)
            if state == "fired" { try store.didDispatch(job.id, now: deadline) }
        }
        let saved = try #require(store.load().first)
        #expect(saved.state.rawValue == state)
        if state == "claimed" { #expect(saved.status(at: before) == "delivery_uncertain") }
        let end = try await capture(bot, fake, id: job.id)
        #expect(end.scheduledWakeups?.isEmpty == true)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unknown)
        #expect(try store.load().first?.state.rawValue == state)
    }

    @Test func corruptStoreDoesNotReuseItsPreviouslyLoadedPendingRecord() async throws {
        let (bot, fake, store) = setup()
        defer { bot.stop() }
        let job = try create(bot)
        let bytes = Data("broken scheduled-routines.json".utf8)
        try bytes.write(to: store.url)
        let end = try await capture(bot, fake, id: job.id)
        #expect(bot.routineError != nil)
        #expect(bot.scheduledRoutines.first?.id == job.id) // Existing UI cache deliberately stays intact.
        #expect(end.scheduledWakeups?.isEmpty == true)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unknown)
        #expect(try Data(contentsOf: store.url) == bytes)
    }

    @Test func recurringResumeBaselineAndTimezoneAreRespected() async throws {
        let (bot, fake, store) = setup()
        defer { bot.stop() }
        let job = try create(bot, kind: "recurring")
        #expect(try store.claim(job.id, now: deadline) != nil)
        try store.didDispatch(job.id, now: deadline)
        _ = try store.perform(["operation": "pause", "id": job.id], now: deadline.addingTimeInterval(60))
        let resumed = deadline.addingTimeInterval(86400 + 3600)
        _ = try store.perform(["operation": "resume", "id": job.id], now: resumed)
        bot.now = { resumed }
        let end = try await capture(bot, fake, id: job.id)
        let wake = try #require(end.scheduledWakeups?.first { $0.id == job.id })
        #expect(wake.fireAt == deadline.addingTimeInterval(172800).ISO8601Format())
        #expect(wake.isDue == false)
        #expect(try store.load().first?.baseline == resumed)
    }

    @Test(arguments: ["cancelled", "paused", "claimed", "fired", "expired", "corrupt"])
    func changesWhileJudgeRunsInvalidateTheOldTimer(_ change: String) async throws {
        let (bot, fake, store) = setup()
        defer { bot.stop() }
        let job = try create(bot)
        var clock = before
        bot.now = { clock }
        let calls = PromiseCheckTests.Calls()
        let gate = AsyncStream<Void>.makeStream()
        bot.promiseCheck = { end in
            calls.add(PromiseCheck.classifierMessage(end))
            if calls.messages.count == 1 {
                for await _ in gate.stream { break }
                return .init(verdict: .waitingTimer, reason: "Saved retry after an observed failure.", wakeupID: job.id)
            }
            return .init(verdict: .unknown, reason: "Old timed wait is no longer supported.")
        }
        bot.send("Existing synthetic task; wait for its evidenced cooldown without duplicating work.")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].completionWorkerDependencies = []
        fake.agents[0].reply("Waiting for the saved retry; work remains unfinished.")
        await eventually { calls.messages.count == 1 }
        switch change {
        case "cancelled", "paused":
            _ = try store.perform(["operation": change == "cancelled" ? "cancel" : "pause", "id": job.id], now: before)
        case "claimed", "fired":
            #expect(try store.claim(job.id, now: deadline) != nil)
            if change == "fired" { try store.didDispatch(job.id, now: deadline) }
        case "expired": clock = deadline
        default: try Data("corrupt".utf8).write(to: store.url)
        }
        gate.continuation.yield(())
        gate.continuation.finish()
        await eventually { bot.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .judged }
        #expect(calls.messages.count == 2)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unknown)
        #expect(fake.agents[0].sent.count == 1)
    }

    @Test func legacyTimersAndMonitorCallbacksAreNotReplacedByNewRoutineEvidence() async throws {
        let (bot, fake, _) = setup()
        defer { bot.stop() }
        let job = try create(bot)
        let parts = Calendar.current.dateComponents([.minute, .hour, .day, .month], from: deadline)
        let line = "\(parts.minute!) \(parts.hour!) \(parts.day!) \(parts.month!) * Legacy check: inspect another saved result."
        try (line + "\n").write(to: bot.profile.routinesURL, atomically: true, encoding: .utf8)
        bot.reloadRoutines()
        #expect(!bot.isDue(try #require(bot.routines.first), at: before))
        let monitor = PromiseCheck.WorkerDependency(id: "existing-monitor", run: 1, task: "Existing independently owned command", state: .running, callback: "app_monitor_result")
        let end = try await capture(bot, fake, id: job.id, workers: [monitor])
        #expect(end.workerDependencies == [monitor]) // Pass-through only; monitor policy belongs to its source change.
        #expect(end.scheduledWakeups?.count == 2)
        #expect(end.scheduledWakeups?.contains { $0.id == PromiseCheck.wakeupID("routine:" + line) } == true)
        #expect(end.scheduledWakeups?.contains { $0.id == job.id } == true)
    }
}
