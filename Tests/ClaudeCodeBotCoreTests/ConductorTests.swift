import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Hand-offs between a bot's two heads and their limits: the heads decide who does what; the
/// app carries hand-offs, gives the reply back, and counts.
struct ConductorTests {
    let two = HeadsSettings(engines: [.claude, .codex])

    func asks(_ actions: [ConductorAction]) -> [(BotEngine, String)] {
        actions.compactMap { if case let .ask(head, text) = $0 { (head, text) } else { nil } }
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
