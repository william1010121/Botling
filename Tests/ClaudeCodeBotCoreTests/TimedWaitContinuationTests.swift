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
        try "30 18 24 10 * Resume-X500: After the observed 17:28:56 rollback, resume the same worker at 18:30; do not retry early.\n".write(to: bot.profile.routinesURL, atomically: true, encoding: .utf8)
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
