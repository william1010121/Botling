import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Hand-offs between a bot's two heads and their limits: the heads decide who does what; the
/// app carries hand-offs, gives the reply back, and counts.
struct ConductorTests {
    let two = HeadsSettings(engines: [.claude, .codex])

    func asks(_ actions: [ConductorAction]) -> [(BotEngine, String)] {
        actions.compactMap { if case let .ask(head, text, _) = $0 { (head, text) } else { nil } }
    }

    func card(_ actions: [ConductorAction]) -> (String, [String])? {
        for action in actions { if case let .card(text, choices) = action { return (text, choices.map(\.label)) } }
        return nil
    }

    func progress(_ actions: [ConductorAction]) -> RoundsProgress?? {
        for action in actions { if case let .progress(value) = action { return .some(value) } }
        return nil
    }

    func hand(_ to: BotEngine, _ kind: HandoffKind = .task, _ task: String = "x") -> HeadTags {
        HeadTags(handoff: .init(to: to, kind: kind, task: task))
    }

    @Test func theTagIsReadAndTakenOut() {
        let (body, tags) = HeadTags.parse("Fixed it.\n<handoff to=\"codex\" kind=\"review\">Review the diff of PR #5.</handoff>")
        #expect(body == "Fixed it.")
        #expect(tags.handoff == .init(to: .codex, kind: .review, task: "Review the diff of PR #5."))
        #expect(HeadTags.parse("<handoff to=\"Claude\">Publish it</handoff>").tags.handoff == .init(to: .claude, kind: .task, task: "Publish it"))
        #expect(HeadTags.parse("plain").tags == HeadTags())
        #expect(HeadTags.parse("<handoff to=\"gemini\">x</handoff>").tags.handoff == nil)
    }

    @Test func aHandOffComesBackToWhoHandedIt() {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage()
        var out = conductor.replied(.claude, "Fixed.", tags: hand(.codex, .review, "Review PR #5"), handed: false)
        #expect(out.contains(.line("Claude → Codex: Review PR #5")))
        #expect(progress(out) == .some(RoundsProgress(kind: .review, round: 1, limit: 2)))
        #expect(asks(out).map(\.0) == [.codex])
        #expect(asks(out).first?.1 == Conductor.handed(from: .claude, handoff: .init(to: .codex, kind: .review, task: "Review PR #5"), count: 1, limit: 6))
        out = conductor.replied(.codex, "No regressions.", tags: HeadTags(), handed: true)
        #expect(asks(out).map(\.0) == [.claude])
        #expect(asks(out).first?.1 == Conductor.handBack(from: .codex, reply: "No regressions."))
        #expect(progress(out) == .some(nil))
        // A reply that was not handed work goes back to nobody.
        #expect(asks(conductor.replied(.claude, "All good.", tags: HeadTags(), handed: true)).isEmpty)
    }

    @Test func reviewsStopAtTheirLimitWithACard() {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage()
        _ = conductor.replied(.claude, "v1", tags: hand(.codex, .review), handed: false)
        _ = conductor.replied(.codex, "one issue", tags: HeadTags(), handed: true)
        _ = conductor.replied(.claude, "v2", tags: hand(.codex, .review), handed: true)
        _ = conductor.replied(.codex, "still one", tags: HeadTags(), handed: true)
        let out = conductor.replied(.claude, "v3", tags: hand(.codex, .review), handed: true)
        #expect(asks(out).isEmpty)
        let shown = card(out)
        #expect(shown?.1 == ["Go with Claude's", "Go with Codex's", "One more round"])
        #expect(shown?.0.hasPrefix("2 review rounds done.") == true)
        #expect(shown?.0.contains("Claude: v3") == true && shown?.0.contains("Codex: still one") == true)
        // One more round lets the stopped hand-off through.
        let more = conductor.picked(.oneMoreRound)
        #expect(asks(more).map(\.0) == [.codex])
        #expect(progress(more) == .some(RoundsProgress(kind: .review, round: 3, limit: 3)))
    }

    @Test func atTheLimitTheLatestVersionCanStand() {
        var settings = two
        settings.limits = RoundLimits(discussion: 1, atLimit: .useDoers)
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage()
        _ = conductor.replied(.claude, "git", tags: hand(.codex, .discuss), handed: false)
        _ = conductor.replied(.codex, "json", tags: HeadTags(), handed: true)
        let out = conductor.replied(.claude, "git, cached", tags: hand(.codex, .discuss), handed: true)
        #expect(card(out) == nil)
        #expect(asks(out).map(\.0) == [.claude])
        #expect(asks(out).first?.1 == Conductor.limitReached(other: .codex))
    }

    @Test func allHandOffsAreCountedPerMessage() {
        var settings = two
        settings.limits.handoffs = 2
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage()
        #expect(asks(conductor.replied(.claude, "a", tags: hand(.codex), handed: false)).count == 1)
        #expect(asks(conductor.replied(.codex, "b", tags: hand(.claude), handed: true)).count == 2)
        let out = conductor.replied(.claude, "c", tags: hand(.codex), handed: true)
        #expect(card(out)?.0.hasPrefix("2 hand-offs for this message: the limit.") == true)
        // A new message from the user starts the count again.
        _ = conductor.userMessage()
        #expect(asks(conductor.replied(.claude, "d", tags: hand(.codex), handed: false)).map(\.0) == [.codex])
    }

    @Test func stopNowEndsHandOffsUntilTheNextMessage() {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage()
        _ = conductor.replied(.claude, "a", tags: hand(.codex), handed: false)
        #expect(conductor.isRunning)
        #expect(conductor.stop().contains(.line("Stopped by you")))
        #expect(!conductor.isRunning)
        #expect(asks(conductor.replied(.claude, "b", tags: hand(.codex), handed: false)).isEmpty)
        _ = conductor.userMessage()
        #expect(asks(conductor.replied(.claude, "c", tags: hand(.codex), handed: false)).count == 1)
    }

    @Test func goWithTellsThatHead() {
        var conductor = Conductor(settings: two)
        let out = conductor.picked(.goWith(.codex))
        #expect(out.contains(.line("You went with Codex's")))
        #expect(asks(out).first?.0 == .codex)
    }

    @Test(arguments: BotEngine.allCases)
    func followupsKeepPendingHandbacksAndResetOnlyLimits(_ from: BotEngine) {
        let to: BotEngine = from == .claude ? .codex : .claude
        var settings = two
        settings.limits.handoffs = 1
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage()
        _ = conductor.replied(from, "First task", tags: hand(to), handed: false)
        #expect(conductor.userMessage().isEmpty)
        #expect(conductor.isRunning)
        // The new user message gets a fresh budget without orphaning either outstanding task.
        #expect(asks(conductor.replied(from, "Second task", tags: hand(to), handed: false)).map(\.0) == [to])
        #expect(asks(conductor.replied(to, "Second done", tags: HeadTags(), handed: true)).map(\.0) == [from])
        #expect(conductor.isRunning)
        #expect(asks(conductor.replied(to, "First done", tags: HeadTags(), handed: true)).map(\.0) == [from])
        #expect(!conductor.isRunning)
    }

    @Test(arguments: BotEngine.allCases)
    func aSilentHandbackClosesTrackingWithoutPassingAnEmptyReply(_ from: BotEngine) {
        let to: BotEngine = from == .claude ? .codex : .claude
        var conductor = Conductor(settings: two)
        _ = conductor.replied(from, "Task", tags: hand(to), handed: false)
        let out = conductor.replied(to, "", tags: HeadTags(), handed: true)
        #expect(!conductor.isRunning)
        #expect(progress(out) == .some(nil))
        #expect(asks(out).map(\.0) == [from])
        #expect(asks(out).first?.1.contains("without a user-facing reply") == true)
        // A silent acknowledgement of the handback cannot make a wake loop.
        #expect(asks(conductor.replied(from, "", tags: HeadTags(), handed: true)).isEmpty)
    }

    @Test(arguments: BotEngine.allCases)
    func explicitStopCancelsAnOldHandbackAcrossFollowups(_ from: BotEngine) {
        let to: BotEngine = from == .claude ? .codex : .claude
        var conductor = Conductor(settings: two)
        _ = conductor.replied(from, "Task", tags: hand(to), handed: false)
        _ = conductor.userMessage()
        _ = conductor.stop()
        #expect(!conductor.isRunning)
        #expect(asks(conductor.replied(to, "Late result", tags: HeadTags(), handed: true)).isEmpty)
    }

    @Test func handOffsOffStillLetCodexHandPublishingToClaudeWhenClaudeIsNotAHead() {
        var settings = HeadsSettings.single(.codex)
        settings.handoffs = false
        var conductor = Conductor(settings: settings)
        #expect(asks(conductor.replied(.codex, "Saved.", tags: hand(.claude, .task, "Publish /tmp/r.html"), handed: false)).map(\.0) == [.claude])
        var off = two
        off.handoffs = false
        var both = Conductor(settings: off)
        #expect(asks(both.replied(.claude, "x", tags: hand(.codex), handed: false)).isEmpty)
    }
}

@MainActor
struct ConductedBotTests {
    private func pendingHandoff(from: BotEngine, fake: FakeLauncher) async throws -> (Bot, FakeAgent, FakeAgent) {
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        let to: BotEngine = from == .claude ? .codex : .claude
        bot.send("Complete the task", to: from == .claude ? .claude : .codex)
        let sender = try #require(fake.agents.first { $0.launch.engine == from })
        sender.reply("Delegated. <handoff to=\"\(to.rawValue)\">Verify the result</handoff>")
        await eventually({ fake.agents.contains { $0.launch.engine == to } }, timeout: 2)
        let recipient = try #require(fake.agents.first { $0.launch.engine == to })
        #expect(bot.rounds != nil)
        return (bot, sender, recipient)
    }

    @Test(arguments: BotEngine.allCases, [false, true])
    func progressQuestionsKeepTheResultRoutedToItsInitiator(_ from: BotEngine, askRecipient: Bool) async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient) = try await pendingHandoff(from: from, fake: fake)
        defer { bot.stop() }
        let questioned = askRecipient ? recipient : sender
        bot.send("How is the work going?", to: questioned.launch.engine == .claude ? .claude : .codex)
        questioned.reply("Still checking.")
        await eventually({ bot.messages.contains { $0.text == "Still checking." } }, timeout: 2)
        #expect(bot.rounds != nil)
        #expect(!sender.sent.contains { $0.contains("finished what you handed over") })
        if askRecipient {
            await eventually({ recipient.sent.contains(Bot.resumeNote) }, timeout: 2)
        }
        recipient.reply("Verified result.")
        await eventually({ sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("Verified result.") } }, timeout: 2)
        #expect(sender.sent.filter { $0.contains("finished what you handed over") }.count == 1)
        #expect(bot.rounds == nil)
    }

    @Test(arguments: BotEngine.allCases)
    func silentHandbacksFinishRoundsAndWakeTheInitiatorOnlyOnce(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient) = try await pendingHandoff(from: from, fake: fake)
        defer { bot.stop() }
        let shown = bot.messages.filter { $0.role == .bot }.count
        recipient.reply("<no-reply/>")
        await eventually({ bot.rounds == nil }, timeout: 2)
        #expect(sender.sent.contains { $0.contains("without a user-facing reply") })
        #expect(bot.messages.filter { $0.role == .bot }.count == shown)
        sender.reply("<no-reply/>")
        await eventually({ !bot.isWorking && bot.partner?.isWorking == false }, timeout: 2)
        #expect(sender.sent.filter { $0.contains("finished what you handed over") }.count == 1)
        #expect(bot.messages.filter { $0.role == .bot }.count == shown)
    }

    @Test(arguments: BotEngine.allCases)
    func aSilentProgressAnswerResumesTheHandedTask(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient) = try await pendingHandoff(from: from, fake: fake)
        defer { bot.stop() }
        bot.send("Any update?", to: recipient.launch.engine == .claude ? .claude : .codex)
        recipient.reply("<no-reply/>")
        await eventually({ recipient.sent.contains(Bot.resumeNote) }, timeout: 2)
        #expect(bot.rounds != nil)
        #expect(!sender.sent.contains { $0.contains("finished what you handed over") })
        recipient.reply("Verified after resuming.")
        await eventually({ sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("Verified after resuming.") } }, timeout: 2)
        #expect(bot.rounds == nil)
    }

    @Test(arguments: BotEngine.allCases)
    func stopRoundsPreventsALateResultFromWakingTheInitiator(_ from: BotEngine) async throws {
        let fake = FakeLauncher()
        let (bot, sender, recipient) = try await pendingHandoff(from: from, fake: fake)
        defer { bot.stop() }
        bot.stopRounds()
        recipient.reply("Late result.")
        await eventually({ bot.messages.contains { $0.text == "Late result." } }, timeout: 2)
        #expect(bot.rounds == nil)
        #expect(!sender.sent.contains { $0.contains("finished what you handed over") })
    }

    @Test func aHandOffGoesToTheOtherHeadAndBack() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { engine, text in
            if text.contains("asks you to review this") { return "No regressions." }
            if text.contains("finished what you handed over") { return "Reviewed and clean." }
            if isAppOnly(text) { return nil }
            return engine == .claude ? #"Merged PR #5. <handoff to="codex" kind="review">Review PR #5</handoff>"# : "<no-reply/>"
        }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.send("Fix and merge")
        await eventually { bot.messages.contains { $0.text == "Reviewed and clean." } }
        #expect(bot.messages.contains { $0.role == .divider && $0.text == "Claude → Codex: Review PR #5" })
        #expect(bot.messages.contains { $0.text == "Merged PR #5." })
        #expect(bot.messages.contains { $0.text == "No regressions." && $0.engine == .codex })
        #expect(fake.agents.first { $0.launch.engine == .claude }?.launch.systemPrompt.contains("<handoff to=\"codex\"") == true)
        await eventually { bot.rounds == nil }
    }

    @Test func aCardsPickGoesToTheConductor() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { engine, text in
            if text.contains("went with your version") { return "<no-reply/>" }
            if isAppOnly(text) { return nil }
            return engine == .claude ? #"Mine. <handoff to="codex" kind="discuss">Git or JSON?</handoff>"# : "<no-reply/>"
        }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.setLimits(RoundLimits(discussion: 0))
        bot.send("Which?")
        await eventually { bot.messages.last?.role == .notice && bot.messages.last?.isOpenQuestion == true }
        let card = try #require(bot.messages.last)
        #expect(card.choices?.map(\.label) == ["Go with Claude's", "Go with Codex's", "One more round"])
        #expect(bot.choose(0, in: card.id))
        await eventually { bot.messages.contains { $0.text == "You went with Claude's" } }
    }

    /// Codex has no Artifact tool: a bot on Codex alone hands publishing to Claude, which runs
    /// next to it for that and hands the link back.
    @Test func codexHandsPublishingToClaude() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("hands you this") { return "Published: [Report](https://claude.ai/artifact/x)" }
            if text.contains("finished what you handed over") { return "Here it is: [Report](https://claude.ai/artifact/x)" }
            return isAppOnly(text) ? "OK" : #"Saved the report. <handoff to="claude">Publish /tmp/report.html as an Artifact</handoff>"#
        }
        let bot = makeBot(fake)
        await bot.switchEngine(to: .codex)
        #expect(bot.prompts.system.contains("<handoff to=\"claude\">"))
        bot.send("Make the weekly report and share it")
        await eventually { bot.messages.last?.text.hasPrefix("Here it is") == true && !bot.isWorking }
        #expect(fake.agents.map(\.launch.engine) == [.codex, .claude])
        let published = try #require(bot.messages.first { $0.text.hasPrefix("Published") })
        #expect(published.engine == .claude)
        #expect(ChatPayload.headLabel(published, in: bot) == "Main bot · Claude")
        #expect(bot.heads.engines == [.codex])
    }
}
