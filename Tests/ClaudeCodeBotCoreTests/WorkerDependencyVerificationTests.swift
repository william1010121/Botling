import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct WorkerDependencyVerificationTests {
    /// Synthetic equivalent of the supplied screenshot: a real live transport snapshot,
    /// 2,515-character task, verbose history, and a delivered delegation reply.
    @Test func longTaskPreservesLiveStateAndCallbackInsteadOfUnknown() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in
            calls.add(input)
            let data = try JSONSerialization.jsonObject(with: Data(input.utf8)) as! [String: Any]
            let workers = data["workerDependencies"] as? [[String: Any]] ?? []
            return workers.contains { $0["state"] as? String == "running" && $0["callback"] as? String == "app_task_result" }
                ? .init(verdict: .waitingDependency, reason: "The authorized task is owned by the live worker; app_task_result returns its result.")
                : .init(verdict: .unknown, reason: "Truncated evidence cannot verify worker state or callback.")
        }
        bot.send("Research the synthetic catalog; all execution is assigned to the worker. Report when it returns.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        let task = "Research the synthetic catalog. " + String(repeating: "x", count: 2483)
        agent.completionWorkerDependencies = [.init(id: "catalog-worker", run: 1, task: task,
            state: .running, callback: "app_task_result")]
        agent.emit(.managedWorkPending(true))
        agent.emit(.trace(.subagentStarted(id: "catalog-worker", description: "Catalog research", type: "codex-worker", prompt: task, background: true)))
        agent.reply("The worker owns the catalog research and will report back. " + String(repeating: "history ", count: 2000))
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        let payload = try #require(calls.messages.first)
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(payload.utf8))
        #expect(decoded.workerDependencies?.first?.state == .running)
        #expect(decoded.workerDependencies?.first?.callback == "app_task_result")
        #expect(decoded.evidenceTruncated)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .waitingDependency)
        #expect(!bot.messages.contains { $0.role == .notice && $0.text.contains("UNKNOWN") })
        #expect(agent.sent.count == 1)
    }
}
