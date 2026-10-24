import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Regression from the 2026-10-24 EEG report. Exercise Bot's real reply/trace/delivery path.
@MainActor
struct CompletionContinuationTests {
    static let authorization = """
    Continue authorized EEG research on GPU2 and GPU3. Each experiment must test a hypothesis.
    If EITHER GPU is idle for more than one minute, actively analyze the next research method.
    Thirty minutes is only fallback monitoring. Do not run experiments merely to fill GPUs.
    """
    static let idleReply = """
    Track3 四個假設都被推翻，baseline40.96；固定基線43.02/42.76，log loss41.23，EMA42.43。
    GPU3 又閒置，我在想下一個。GPU2 的 Track2 EEGNet 還在跑。
    接下來我想改問資料本身：CV 誤差集中在哪幾位受試者、哪個倒數區間，再決定要驗證什麼。
    """

    @Test func unrelatedGPUAndFallbackMonitorMustNotSuppressContinuation() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return true }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.trace(.toolUse(id: "ssh", tool: "Bash", title: "Check SSH output", detail: "read experiment output", parent: nil)))
        agent.emit(.trace(.toolResult(id: "ssh", output: "GPU2 running; GPU3 idle > 1 minute", failed: false, parent: nil)))
        agent.emit(.trace(.subagentStarted(id: "gpu2", description: "Track2 EEGNet on GPU2", type: nil, prompt: "Wait for GPU2 result only", background: true)))
        agent.emit(.trace(.monitorStarted(id: "monitor", description: "30 minute fallback")))
        agent.reply(Self.idleReply)
        await eventually { !bot.isWorking || agent.sent.count == 2 }
        try await Task.sleep(for: .milliseconds(200))
        #expect(calls.messages.count == 1, "Pending GPU2/monitor must still reach semantic judgment")
        #expect(agent.sent.count == 2, "Idle GPU3 analysis must continue in the same session")
        #expect(bot.messages.contains { $0.text == Self.idleReply }, "Preserve delivered report")
        bot.stop()
    }

    @Test func anotherUnfinishedReplyMustBeJudgedAgain() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return true }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply(Self.idleReply)
        await eventually { agent.sent.count == 2 }
        agent.emit(.trace(.toolUse(id: "read", tool: "Read", title: "Read CV error table", detail: "errors.csv", parent: nil)))
        agent.emit(.trace(.toolResult(id: "read", output: "P04 errors concentrate in the last interval", failed: false, parent: nil)))
        agent.reply("P04 errors concentrate in the last interval. Next I will analyze the interval errors.")
        await eventually { !bot.isWorking || agent.sent.count == 3 }
        try await Task.sleep(for: .milliseconds(200))
        #expect(calls.messages.count == 2, "A follow-up reply is not completion by definition")
        #expect(agent.sent.count == 3, "Keep advancing authorized work after actual progress")
        bot.stop()
    }
}
