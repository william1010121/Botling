import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct SingleHandoffStopConductorTests {
    func hand(_ to: BotEngine, _ task: String) -> HeadTags {
        HeadTags(handoff: .init(to: to, kind: .task, task: task))
    }

    func asks(_ actions: [ConductorAction]) -> [(BotEngine, String, UUID?)] {
        actions.compactMap { if case let .ask(head, text, id) = $0 { (head, text, id) } else { nil } }
    }

    @Test(arguments: [false, true])
    func stoppedReplyNeverConsumesTheOtherSameHeadAssignment(stopNewest: Bool) throws {
        var conductor = Conductor(settings: HeadsSettings(engines: [.claude, .codex]))
        _ = conductor.userMessage("First")
        let firstAction = asks(conductor.replied(.claude, "", tags: hand(.codex, "A"), handed: false))
        let first = try #require(firstAction.first?.2)
        _ = conductor.userMessage("Second")
        let second = try #require(asks(conductor.replied(.claude, "", tags: hand(.codex, "B"), handed: false)).first?.2)
        let stopped = stopNewest ? second : first
        let kept = stopNewest ? first : second
        #expect(!conductor.stop(stopped).isEmpty)
        #expect(conductor.isRunning)
        #expect(conductor.records.first { $0.id == stopped }?.state == .stopped)
        #expect(conductor.records.first { $0.id == kept }?.state == .running)
        // Neither a late result nor its new handoff can resurrect the cancelled chain.
        #expect(conductor.replied(.codex, "Late A", tags: hand(.claude, "Must not start"), handed: true, handoffID: stopped).isEmpty)
        let returned = asks(conductor.replied(.codex, "Kept result", tags: HeadTags(), handed: true, handoffID: kept))
        #expect(returned.count == 1 && returned.first?.0 == .claude && returned.first?.2 == kept)
        #expect(returned.first?.1.contains("Kept result") == true)
        _ = conductor.replied(.claude, "Complete", tags: HeadTags(), handed: true, handoffID: kept)
        #expect(conductor.records.first { $0.id == kept }?.state == .done)
        #expect(conductor.records.count == 2)
        #expect(conductor.stop(stopped).isEmpty)
        #expect(conductor.stop(kept).isEmpty)
        #expect(conductor.stop(UUID()).isEmpty)
    }

    @Test func stoppingWaitingContinuationLeavesOtherWaitingContinuationActive() throws {
        var conductor = Conductor(settings: HeadsSettings(engines: [.claude, .codex]))
        _ = conductor.userMessage("Two")
        _ = conductor.replied(.claude, "", tags: hand(.codex, "A"), handed: false)
        let a = try #require(conductor.records.last?.id)
        _ = conductor.replied(.claude, "", tags: hand(.codex, "B"), handed: false)
        let b = try #require(conductor.records.last?.id)
        _ = conductor.replied(.codex, "A result", tags: HeadTags(), handed: true, handoffID: a)
        _ = conductor.replied(.codex, "B result", tags: HeadTags(), handed: true, handoffID: b)
        _ = conductor.stop(a)
        #expect(conductor.replied(.claude, "Late A", tags: hand(.codex, "Zombie"), handed: true, handoffID: a).isEmpty)
        #expect(conductor.records.first { $0.id == b }?.state == .waiting)
        _ = conductor.replied(.claude, "B finished", tags: HeadTags(), handed: true, handoffID: b)
        #expect(conductor.records.map(\.state) == [.stopped, .done])
    }

    @Test func stoppingSelectedChainAlsoCancelsItsNextHopButPreservesIndependentRoot() throws {
        var conductor = Conductor(settings: HeadsSettings(engines: [.claude, .codex]))
        _ = conductor.userMessage("First")
        _ = conductor.replied(.claude, "", tags: hand(.codex, "Parent"), handed: false)
        let parent = try #require(conductor.records.last?.id)
        _ = conductor.replied(.codex, "Continue", tags: hand(.claude, "Child"), handed: true, handoffID: parent)
        let child = try #require(conductor.records.last?.id)
        #expect(conductor.records.last?.chainID == parent)
        _ = conductor.userMessage("Independent request")
        _ = conductor.replied(.claude, "", tags: hand(.codex, "Independent"), handed: false)
        let independent = try #require(conductor.records.last?.id)
        _ = conductor.stop(child)
        #expect(conductor.records.first { $0.id == parent }?.state == .stopped)
        #expect(conductor.records.first { $0.id == child }?.state == .stopped)
        #expect(conductor.records.first { $0.id == independent }?.state == .running)
        #expect(conductor.replied(.claude, "Late child", tags: hand(.codex, "Zombie"), handed: true, handoffID: child).isEmpty)
        #expect(asks(conductor.replied(.codex, "Independent result", tags: HeadTags(), handed: true, handoffID: independent)).first?.2 == independent)
    }

    @Test func stoppingChainCannotBeUndoneByItsStaleOneMoreRoundCard() throws {
        var settings = HeadsSettings(engines: [.claude, .codex])
        settings.limits.handoffs = 1
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage("One chain")
        _ = conductor.replied(.claude, "", tags: hand(.codex, "First"), handed: false)
        let id = try #require(conductor.records.first?.id)
        _ = conductor.replied(.codex, "More work", tags: hand(.claude, "Blocked next hop"), handed: true, handoffID: id)
        #expect(conductor.records.first?.state == .waiting)
        _ = conductor.stop(id)
        #expect(conductor.picked(.oneMoreRound).isEmpty)
        _ = conductor.userMessage("Independent next task")
        #expect(asks(conductor.replied(.claude, "", tags: hand(.codex, "Allowed"), handed: false)).count == 1)
    }

    @Test func activeIdentitiesSurviveHistoryLimitAndNewMessages() throws {
        var conductor = Conductor(settings: HeadsSettings(engines: [.claude, .codex]))
        for index in 0...Conductor.recordLimit {
            _ = conductor.userMessage("Message \(index)")
            _ = conductor.replied(.claude, "", tags: hand(.codex, "Task \(index)"), handed: false)
        }
        let first = try #require(conductor.records.first)
        #expect(conductor.records.count == Conductor.recordLimit + 1)
        #expect(!conductor.stop(first.id).isEmpty)
        _ = conductor.userMessage("Next")
        #expect(conductor.records.count == Conductor.recordLimit)
        #expect(conductor.replied(.codex, "Retired", tags: hand(.claude, "Zombie"), handed: true, handoffID: first.id).isEmpty)
        #expect(conductor.isRunning)
    }
}

@MainActor
struct SingleHandoffStopBotTests {
    private func twoSameDirection(_ from: BotEngine, fake: FakeLauncher) async throws -> (Bot, FakeAgent, FakeAgent, UUID, UUID) {
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        let to: BotEngine = from == .claude ? .codex : .claude
        let target: AnswerTarget = from == .claude ? .claude : .codex
        bot.send("First request", to: target)
        let sender = try #require(fake.agents.first { $0.launch.engine == from })
        sender.reply("Accepted A. <handoff to=\"\(to.rawValue)\">Task A</handoff>")
        await eventually { bot.handoffs.count == 1 && fake.agents.contains { $0.launch.engine == to } }
        let recipient = try #require(fake.agents.first { $0.launch.engine == to })
        let a = try #require(bot.handoffs.first?.id)
        bot.send("Second request", to: target)
        sender.reply("Accepted B. <handoff to=\"\(to.rawValue)\">Task B</handoff>")
        await eventually { bot.handoffs.count == 2 }
        let b = try #require(bot.handoffs.last?.id)
        #expect(recipient.sent.contains { $0.contains("Task A") })
        #expect(!recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") })
        return (bot, sender, recipient, a, b)
    }

    @Test(arguments: BotEngine.allCases, [false, true])
    func stoppingRunningOrQueuedAssignmentPreservesTheOther(_ from: BotEngine, stopQueued: Bool) async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient, a, b) = try await twoSameDirection(from, fake: fake)
        defer { bot.stop() }
        let stopped = stopQueued ? b : a
        let kept = stopQueued ? a : b
        let interrupts = recipient.interrupts
        #expect(bot.stopHandoff(stopped))
        #expect(!bot.stopHandoff(stopped))
        #expect(!bot.stopHandoff(UUID()))
        #expect(bot.handoffs.first { $0.id == stopped }?.state == .stopped)
        #expect(bot.handoffs.first { $0.id == kept }?.state == .running)
        #expect(bot.rounds != nil)
        #expect(!sender.finished && !recipient.finished)
        #expect(sender.interrupts == 0)
        if stopQueued {
            #expect(recipient.interrupts == interrupts)
        } else {
            await eventually { recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") } }
            #expect(recipient.interrupts == interrupts + 1)
        }
        recipient.reply("Kept assignment result.")
        await eventually { sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("Kept assignment result.") } }
        sender.reply("Kept assignment complete.")
        await eventually { bot.handoffs.first { $0.id == kept }?.state == .done }
        #expect(bot.handoffs.first { $0.id == stopped }?.state == .stopped)
        #expect(sender.sent.filter { $0.contains("finished what you handed over") }.count == 1)
        #expect(!bot.stopHandoff(kept))
    }

    @Test(arguments: BotEngine.allCases)
    func successfulResultRacingInterruptCannotStartAnotherHandoff(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient, a, b) = try await twoSameDirection(from, fake: fake)
        defer { bot.stop() }
        recipient.interruptEndsTurn = false
        #expect(bot.stopHandoff(a))
        recipient.reply("Already finished. <handoff to=\"\(from.rawValue)\">Zombie task</handoff>")
        await eventually { recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") } }
        #expect(bot.handoffs.count == 2)
        #expect(bot.handoffs.first { $0.id == b }?.state == .running)
        #expect(!sender.sent.contains { $0.contains("Zombie task") || $0.contains("finished what you handed over") })
    }

    @Test(arguments: BotEngine.allCases)
    func stoppingPausedAssignmentDoesNotInterruptUsersQuestionOrResumeIt(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        let (bot, _, recipient, a, b) = try await twoSameDirection(from, fake: fake)
        defer { bot.stop() }
        let target: AnswerTarget = recipient.launch.engine == .claude ? .claude : .codex
        bot.send("Question for this head", to: target)
        await eventually { recipient.sent.contains { $0.contains("Question for this head") } }
        let interrupts = recipient.interrupts
        #expect(bot.stopHandoff(a))
        #expect(recipient.interrupts == interrupts)
        recipient.reply("Question answered.")
        await eventually { recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") } }
        #expect(!recipient.sent.contains(Bot.resumeNote))
        #expect(bot.handoffs.first { $0.id == a }?.state == .stopped)
        #expect(bot.handoffs.first { $0.id == b }?.state == .running)
    }
    @Test(arguments: BotEngine.allCases)
    func oppositeDirectionsRemainIndependent(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        await bot.setHeads([.claude, .codex])
        let to: BotEngine = from == .claude ? .codex : .claude
        bot.send("Request A", to: from == .claude ? .claude : .codex)
        let sender = try #require(fake.agents.first { $0.launch.engine == from })
        sender.reply("A accepted. <handoff to=\"\(to.rawValue)\">Task A</handoff>")
        await eventually { bot.handoffs.count == 1 }
        let recipient = try #require(fake.agents.first { $0.launch.engine == to })
        let a = try #require(bot.handoffs.first?.id)
        bot.send("Request B", to: to == .claude ? .claude : .codex)
        recipient.reply("B accepted. <handoff to=\"\(from.rawValue)\">Task B</handoff>")
        await eventually { bot.handoffs.count == 2 && recipient.sent.contains(Bot.resumeNote) }
        let b = try #require(bot.handoffs.last?.id)
        let otherInterrupts = sender.interrupts
        #expect(bot.stopHandoff(a))
        #expect(sender.interrupts == otherInterrupts)
        #expect(bot.handoffs.first { $0.id == b }?.state == .running)
        sender.reply("B result.")
        await eventually { recipient.sent.contains { $0.contains("finished what you handed over") && $0.contains("B result.") } }
        recipient.reply("B complete.")
        await eventually { bot.handoffs.first { $0.id == b }?.state == .done }
        #expect(bot.handoffs.first { $0.id == a }?.state == .stopped)
    }

    @Test func stoppingWaitingAssignmentRemovesOnlyItsQueuedReturn() async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient, a, b) = try await twoSameDirection(.claude, fake: fake)
        defer { bot.stop() }
        bot.send("User question keeps sender busy", to: .claude)
        recipient.reply("A result.")
        await eventually { bot.handoffs.first { $0.id == a }?.state == .waiting }
        let interrupts = sender.interrupts
        #expect(bot.stopHandoff(a))
        #expect(sender.interrupts == interrupts)
        sender.reply("User question answered.")
        await eventually { recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") } }
        #expect(!sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("A result.") })
        #expect(bot.handoffs.first { $0.id == b }?.state == .running)
    }

    @Test func stoppingHandoffCancelsOnlyItsOwnedManagedWorkers() async throws {
        let fake = FakeLauncher()
        let (bot, _, recipient, a, b) = try await twoSameDirection(.claude, fake: fake)
        defer { bot.stop() }
        recipient.emit(.trace(.subagentStarted(id: "owned-worker", description: "Task A", type: "codex-worker", prompt: "Task A", background: true)))
        recipient.emit(.managedWorkPending(true))
        recipient.reply("Accepted by worker.")
        await eventually { bot.partner?.isWorking == false }
        #expect(bot.handoffs.first { $0.id == a }?.state == .running)
        #expect(bot.stopHandoff(a))
        #expect(recipient.cancelledTasks == [Set(["owned-worker"])])
        await eventually { recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") } }
        #expect(bot.handoffs.first { $0.id == b }?.state == .running)
        #expect(recipient.interrupts == 0)
    }

    @Test func cancelledFilteredReplyCannotCompleteTheNextAssignment() async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient, a, b) = try await twoSameDirection(.claude, fake: fake)
        defer { bot.stop() }
        var pending: CheckedContinuation<String, Never>?
        var returned = false
        bot.replyFilter = { { text in
            guard text == "Delayed A" else { return text }
            let changed = await withCheckedContinuation { pending = $0 }
            returned = true
            return changed
        } }
        recipient.reply("Delayed A")
        await eventually({ pending != nil }, timeout: 2)
        #expect(bot.stopHandoff(a))
        await eventually({ recipient.sent.contains { $0.contains("hands you this") && $0.contains("Task B") } }, timeout: 2)
        pending?.resume(returning: "Late filtered result. <handoff to=\"claude\">Zombie</handoff>")
        await eventually({ returned }, timeout: 2)
        #expect(bot.handoffs.first { $0.id == b }?.state == .running)
        #expect(!bot.messages.contains { $0.text.contains("Late filtered result") })
        #expect(!sender.sent.contains { $0.contains("finished what you handed over") })
        recipient.reply("Actual B result")
        await eventually({ sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("Actual B result") } }, timeout: 2)
        #expect(bot.handoffs.count == 2)
    }

}
