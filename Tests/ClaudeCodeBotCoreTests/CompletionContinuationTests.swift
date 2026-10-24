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
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return .continueWork }
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
        // The running GPU2 subagent is a live owner, so a CONTINUE is confirmed by a second judgment.
        #expect(calls.messages.count == 2, "Pending GPU2/monitor must still reach semantic judgment")
        #expect(agent.sent.count == 2, "Idle GPU3 analysis must continue in the same session")
        #expect(bot.messages.contains { $0.text == Self.idleReply }, "Preserve delivered report")
        bot.stop()
    }

    @Test func anotherUnfinishedReplyMustBeJudgedAgain() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return .continueWork }
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

extension CompletionContinuationTests {
    @Test(arguments: [PromiseCheck.Verdict.complete, .waitingUser, .cancelled, .waitingDependency])
    func terminalOrActivelyOwnedWorkDoesNotSelfWake(_ verdict: PromiseCheck.Verdict) async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return .init(verdict: verdict, reason: "Concrete terminal or owned dependency evidence.") }
        bot.send("Analyze only; do not implement without permission.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("Result or concrete blocker; see the task evidence.")
        await eventually { calls.messages.count == 1 }
        try await Task.sleep(for: .milliseconds(80))
        #expect(agent.sent.count == 1)
        #expect(!bot.isWorking)
        #expect(bot.messages.contains { $0.role == .bot })
    }

    @Test func aGenuineQuestionReachesSemanticJudgmentInsteadOfBeingAssumedComplete() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return .waitingUser }
        bot.send("Research only. Implementation requires my decision.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("Research is complete. Approve implementation?\n<choices>\n- Implement\n- Stop\n</choices>")
        await eventually { calls.messages.count == 1 }
        try await Task.sleep(for: .milliseconds(80))
        #expect(agent.sent.count == 1)
        #expect(bot.messages.last?.choices?.count == 2)
        #expect(calls.messages[0].contains("Implementation requires my decision"))
    }

    @Test func repeatedPromisesWithoutEvidencePauseAsUnfinishedInsteadOfLooping() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .continueWork }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for expected in 2...3 {
            agent.reply(Self.idleReply)
            await eventually { agent.sent.count == expected }
        }
        agent.reply(Self.idleReply)
        await eventually { bot.messages.last?.text.contains("remains unfinished") == true }
        #expect(bot.messages.last?.text.contains("remains unfinished") == true)
        #expect(agent.sent.count == 3)
        #expect(!bot.isWorking)
    }

    @Test func repeatedSSHWithDifferentIDsDoesNotCountAsNewProgress() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .continueWork }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        // The first turn's SSH output is new; the two continuations repeating it are not.
        for n in 1...3 {
            agent.emit(.trace(.toolUse(id: "ssh-\(n)", tool: "Bash", title: "Check GPU", detail: "same SSH status", parent: nil)))
            agent.emit(.trace(.toolResult(id: "ssh-\(n)", output: "GPU3 idle", failed: false, parent: nil)))
            agent.reply(Self.idleReply)
            if n < 3 { await eventually { agent.sent.count == n + 1 } }
        }
        await eventually { bot.messages.last?.text.contains("remains unfinished") == true }
        #expect(agent.sent.count == 3)
    }

    @Test(arguments: ["user", "stop-all", "remove", "background", "permission"])
    func aLateVerdictCannotReviveRetiredOrBusyWork(_ event: String) async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let gate = AsyncStream<Void>.makeStream()
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            calls.add(end.reply)
            for await _ in gate.stream { break }
            return .continueWork
        }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply(Self.idleReply)
        await eventually { calls.messages.count == 1 }
        switch event {
        case "user": bot.send("Stop research. Only answer my new question.")
        case "stop-all": bot.stopRounds()
        case "remove": bot.stop()
        case "background": agent.emit(.backgroundTurnStarted)
        default: agent.emit(.permission(PermissionRequest(id: "r1", tool: "Bash", summary: "Needs permission", input: "{}")))
        }
        try await Task.sleep(for: .milliseconds(30))
        gate.continuation.yield()
        gate.continuation.finish()
        try await Task.sleep(for: .milliseconds(80))
        #expect(!agent.sent.contains(PromiseCheck.followUp))
    }

    @Test func unavailableJudgeDeliversTheReplyAndExposesUncertaintyWithoutNewActions() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = PromiseCheck.checker { _ in throw CocoaError(.executableLoad) }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply(Self.idleReply)
        await eventually { bot.messages.last?.role == .notice }
        #expect(bot.messages.contains { $0.text == Self.idleReply })
        #expect(bot.messages.last?.text.contains("UNAVAILABLE") == true)
        #expect(agent.sent.count == 1)
    }

    @Test func codexUsesTheSameCompletionAndContinuationRuntime() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-completion-codex-\(UUID())")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: .codex)
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = PromiseCheck.checker { input in calls.add(input); return .continueWork }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.managedWorkPending(true))
        agent.completionWorkerDependencies = [.init(id: "gpu2", run: 1, task: "GPU2 experiment", state: .running, callback: "app_task_result")]
        agent.emit(.trace(.subagentStarted(id: "gpu2", description: "GPU2 only", type: "codex-worker", prompt: "GPU2 experiment", background: true)))
        agent.reply(Self.idleReply)
        await eventually { agent.sent.count == 2 }
        #expect(agent.launch.engine == .codex)
        #expect(calls.messages.first?.contains("GPU2 experiment") == true)
        #expect(calls.messages.first?.contains("EITHER GPU") == true)
        #expect(fake.agents.count == 1)
    }

    @Test(arguments: BotEngine.allCases)
    func handedWorkKeepsItsReturnRouteUntilTheContinuedTaskActuallyCompletes(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        await bot.setHeads([.claude, .codex])
        bot.promiseCheck = { end in
            if end.reply == "Delegated." { return .waitingDependency }
            return end.reply.contains("Verified result") ? .complete : .continueWork
        }
        bot.partner?.promiseCheck = bot.promiseCheck
        let to: BotEngine = from == .claude ? .codex : .claude
        bot.send("Verify the result", to: from == .claude ? .claude : .codex)
        let sender = try #require(fake.agents.first { $0.launch.engine == from })
        sender.reply("Delegated. <handoff to=\"\(to.rawValue)\">Verify the result</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == to } }
        let recipient = try #require(fake.agents.first { $0.launch.engine == to })
        recipient.reply("I will verify the result next.")
        await eventually { recipient.sent.contains { $0.contains(PromiseCheck.followUp) } }
        #expect(!sender.sent.contains { $0.contains("finished what you handed over") })
        #expect(bot.handoffs.contains { $0.isActive })
        recipient.reply("<end>Verified result: all requested checks passed.</end>")
        await eventually { sender.sent.contains { $0.contains("finished what you handed over") } }
        #expect(sender.sent.filter { $0.contains("finished what you handed over") }.count == 1)
    }
}

extension CompletionContinuationTests {
    @Test func substantiveNewReasoningCanContinueWithoutArtificialToolUse() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            calls.add(end.reply)
            return end.reply == "Finite analysis complete" ? .complete : .continueAnalysis
        }
        bot.send("Develop and compare four hypotheses; reasoning alone is allowed.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for n in 1...4 {
            agent.reply("New evidence-based deduction \(n), with the next authorized comparison remaining.")
            await eventually { agent.sent.count == n + 1 }
        }
        agent.reply("<end>Finite analysis complete</end>")
        await eventually { calls.messages.count == 5 }
        #expect(agent.sent.count == 5)
        #expect(!bot.messages.contains { $0.role == .notice && $0.text.contains("paused") })
    }

    @Test func aSilentBackgroundReplyCannotSilentlyAbandonAuthorizedResearch() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .continueWork }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.backgroundTurnStarted)
        agent.reply("<no-reply/>")
        await eventually { agent.sent.contains(PromiseCheck.followUp) }
        #expect(bot.messages.filter { $0.role == .bot }.isEmpty)
    }
}

extension CompletionContinuationTests {
    @Test func firstWakeExplainsTheStallAndRequiresEvidenceOrSpecificBlocker() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .continueWork }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply(Self.idleReply)
        await eventually { agent.sent.count == 2 }
        #expect(bot.messages.contains { $0.role == .notice && $0.text.contains("GPU3") }, "Explain the concrete reason before waking the original model")
        #expect(agent.sent.last?.contains("<end>") == true)
        #expect(agent.sent.last?.contains("<block>") == true)
        #expect(agent.sent.last?.contains("mandatory") == true)
    }

    @Test func afterFirstWakeMissingTerminalEvidenceCannotSilentlySettle() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { end in end.reply == Self.idleReply ? .continueWork : .complete }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply(Self.idleReply)
        await eventually { agent.sent.count == 2 }
        agent.reply("I think the task is done.")
        await eventually({ agent.sent.count == 3 }, timeout: 2)
        #expect(agent.sent.count == 3)
    }

    @Test func terminalMarkersAreStructuredAndTheirContentsStayVisible() {
        #expect(ReplyParser.parseAll("<end>All requested evidence is verified.</end>").body == "All requested evidence is verified.")
        #expect(ReplyParser.parseAll("<block>Missing dataset permission.</block>").body == "Missing dataset permission.")
        #expect(ReplyParser.parseAll("`<end>example</end>`").body == "`<end>example</end>`")
    }
}

extension CompletionContinuationTests {
    @Test(arguments: [PromiseCheck.Signal.Kind.end, .block])
    func verifiedTerminalSignalsFinishOrBlockDistinctlyAfterFirstWake(_ kind: PromiseCheck.Signal.Kind) async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let captured = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            captured.add(PromiseCheck.classifierMessage(end))
            guard !end.signals.isEmpty else { return .continueWork }
            return .init(verdict: kind == .end ? .complete : .waitingUser, reason: end.signals[0].evidence)
        }
        bot.send("Complete the approved analysis or report the actual dataset permission blocker.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("I will analyze next.")
        await eventually { agent.sent.count == 2 }
        let content = kind == .end ? "All approved analysis and evidence are verified." : "Dataset access permission is missing; no independent analysis can proceed."
        agent.reply("<\(kind.rawValue)>\(content)</\(kind.rawValue)>")
        await eventually { captured.messages.count == 2 }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(agent.sent.count == 2)
        #expect(!bot.isWorking)
        #expect(bot.messages.contains { $0.role == .bot && $0.text == content })
        #expect(!bot.messages.contains { $0.text.contains("<end>") || $0.text.contains("<block>") })
        #expect(captured.messages[1].contains("\"terminalRequired\":true"))
        if kind == .block { #expect(bot.messages.last?.text.hasPrefix("Blocked:") == true) }
    }

    @Test(arguments: ["end", "block"])
    func aFalseTerminalMarkerCannotOverrideSemanticUnfinishedWork(_ kind: String) async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .init(verdict: .continueWork, reason: "GPU3 analysis is still unperformed; GPU2 does not own it.") }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("I will analyze next.")
        await eventually { agent.sent.count == 2 }
        agent.reply("<\(kind)>GPU2 is running; I will think next.</\(kind)>")
        await eventually { agent.sent.count == 3 }
        #expect(bot.messages.last?.role == .notice)
        #expect(bot.messages.last?.text.contains("GPU3 analysis") == true)
    }
}

extension CompletionContinuationTests {
    @Test func userCancellationWhileAHandedTaskIsPausedDoesNotResumeIt() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        await bot.setHeads([.claude, .codex])
        bot.promiseCheck = { end in
            if end.reply == "Delegated." { return .waitingDependency }
            if end.reply == "Stopped as requested." { return .cancelled }
            return .continueWork
        }
        bot.send("Analyze only until I stop you", to: .claude)
        let sender = try #require(fake.agents.first { $0.launch.engine == .claude })
        sender.reply("Delegated. <handoff to=\"codex\">Continue the authorized analysis until stopped</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let recipient = try #require(fake.agents.first { $0.launch.engine == .codex })
        bot.send("Stop this analysis now. Do not resume it.", to: .codex)
        await eventually { recipient.sent.contains { $0.contains("Stop this analysis now") } }
        let before = recipient.sent.count
        recipient.reply("Stopped as requested.")
        await eventually { bot.messages.contains { $0.text == "Stopped as requested." } }
        try await Task.sleep(for: .milliseconds(80))
        #expect(recipient.sent.count == before, "A semantic cancellation must beat the automatic paused-work resume")
        #expect(!recipient.sent.contains(Bot.resumeNote))
    }
}

extension CompletionContinuationTests {
    @Test func stopAllPreventsLaterBackgroundReportsFromRestartingTheCancelledTask() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in calls.add(end.reply); return .continueWork }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        bot.stopRounds()
        agent.reply(Self.idleReply)
        await eventually { !bot.isWorking }
        agent.emit(.backgroundTurnStarted)
        agent.reply(Self.idleReply)
        try await Task.sleep(for: .milliseconds(50))
        #expect(!agent.sent.contains(PromiseCheck.followUp))
        #expect(calls.messages.isEmpty)
        bot.send("New explicit authorization: analyze the next table.")
        agent.reply("I'll analyze it next.")
        await eventually { agent.sent.contains(PromiseCheck.followUp) }
    }

    @Test func duplicateReasoningCannotBypassTheNoProgressGuard() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        // Even an overoptimistic semantic judgment cannot repeatedly credit identical prose.
        bot.promiseCheck = { _ in .continueAnalysis }
        bot.send(Self.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for n in 1...3 {
            agent.reply(Self.idleReply)
            if n < 3 { await eventually { agent.sent.count == n + 1 } }
        }
        await eventually { bot.messages.last?.text.contains("remains unfinished") == true }
        #expect(agent.sent.count == 3)
    }

    @Test(arguments: [false, true])
    func queuedIndependentHandoffCannotRetireAJudgmentAndSingleStopStillReleasesItsQueue(_ stopFirst: Bool) async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let gate = AsyncStream<Void>.makeStream()
        let calls = PromiseCheckTests.Calls()
        bot.promiseCheck = { end in
            if end.reply == "Delegated." { return .waitingDependency }
            if end.reply == "I will verify first." {
                calls.add(end.reply)
                for await _ in gate.stream { break }
                return .continueWork
            }
            return .complete
        }
        await bot.setHeads([.claude, .codex])
        bot.send("Verify first report", to: .claude)
        let sender = try #require(fake.agents.first { $0.launch.engine == .claude })
        sender.reply("Delegated. <handoff to=\"codex\">Verify first report</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let recipient = try #require(fake.agents.first { $0.launch.engine == .codex })
        recipient.reply("I will verify first.")
        await eventually { !calls.messages.isEmpty }
        let first = try #require(bot.handoffs.first { $0.task == "Verify first report" })
        bot.send("Also verify the second report independently", to: .claude)
        sender.reply("Delegated. <handoff to=\"codex\">Verify second report</handoff>")
        await eventually { bot.handoffs.filter(\.isActive).count == 2 }
        #expect(!recipient.sent.contains { $0.contains("hand-off") && $0.contains("Verify second report") })
        if stopFirst { #expect(bot.stopHandoff(first.id)) }
        gate.continuation.yield()
        gate.continuation.finish()
        if !stopFirst {
            await eventually { recipient.sent.contains { $0.contains(PromiseCheck.followUp) } }
            recipient.reply("<end>Verified first report and all requested evidence.</end>")
        }
        await eventually { recipient.sent.contains { $0.contains("hand-off") && $0.contains("Verify second report") } }
        if stopFirst { #expect(!recipient.sent.contains { $0.contains(PromiseCheck.followUp) }) }
    }
}

extension CompletionContinuationTests {
    @Test func sameTaskApprovalKeepsTerminalProtocolButANewChatAfterCompletionDoesNotNeedMarkers() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        let captured = PromiseCheckTests.Calls()
        // Keep this synchronous fake on Bot's actor: recording the call must not race
        // application of its returned verdict before the next user message.
        bot.promiseCheck = { @MainActor end in
            captured.add(PromiseCheck.classifierMessage(end))
            if end.reply == "I will analyze next." { return .continueWork }
            if end.reply == "Missing dataset permission; all analysis requires it." { return .waitingUser }
            return .complete
        }
        bot.send("Analyze the dataset using approved permissions only.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("I will analyze next.")
        await eventually { agent.sent.count == 2 }
        agent.reply("<block>Missing dataset permission; all analysis requires it.</block>")
        await eventually { captured.messages.count == 2 }
        bot.send("Permission granted; continue that same analysis.")
        agent.reply("Analysis complete.")
        await eventually({ agent.sent.contains { $0.contains(PromiseCheck.terminalFollowUp) } }, timeout: 2)
        #expect(agent.sent.count == 4)
        agent.reply("<end>Analysis complete and requested validation passed.</end>")
        await eventually { captured.messages.count == 4 }
        bot.send("Hello, a new ordinary chat.")
        agent.reply("Hello.")
        await eventually { captured.messages.count == 5 }
        #expect(agent.sent.count == 5)
        #expect(!captured.messages.last!.contains("\"terminalRequired\":true"))
    }
}

extension CompletionContinuationTests {
    @Test func anUncertainPostWakeJudgeRequestsOnlyTerminalEvidenceWithoutInventingMoreWork() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { end in
            end.terminalRequired
                ? .init(verdict: .unknown, reason: "The missing permission and all-work dependency need concrete evidence.")
                : .continueWork
        }
        bot.send("Analyze the private dataset with approved access only.")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("I will analyze next.")
        await eventually { agent.sent.count == 2 }
        agent.reply("Access denied. I think I am blocked.")
        await eventually { agent.sent.contains { $0.contains(PromiseCheck.terminalFollowUp) } }
        #expect(agent.sent.count == 3)
        #expect(bot.messages.last?.text.contains("needs clarification") == true)
        #expect(agent.sent.last?.contains("Do not start extra experiments") == true)
    }
}

extension CompletionContinuationTests {
    @Test func terminalEvidenceKeepsExistingCodeExampleProtection() {
        let reply = "<end>Verified the example:\n```xml\n<install>example-plugin</install>\n```\nNo installation requested.</end>"
        let parsed = ReplyParser.parseAll(reply)
        #expect(parsed.requests.isEmpty, "Unwrapping terminal evidence must not execute code examples")
        #expect(parsed.body.contains("<install>example-plugin</install>"))
        #expect(parsed.completionSignals.count == 1)
    }
}

extension CompletionContinuationTests {
    @Test func componentJSONCannotClaimTerminalStatusOrLoseItsLiteralMarkerText() {
        let json = #"{"example":"<end>literal documentation</end>"}"#
        let parsed = ReplyParser.parseAll("<show name=\"example\">\(json)</show>")
        #expect(parsed.completionSignals.isEmpty)
        #expect(parsed.displays.first?.data == json)
    }
}
