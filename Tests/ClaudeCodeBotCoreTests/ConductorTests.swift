import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Hand-offs, Both and the round limits between a bot's two heads (Codex engine P3).
struct ConductorTests {
    let two = HeadsSettings(engines: [.claude, .codex], answerWith: .both)

    func asks(_ actions: [ConductorAction]) -> [(BotEngine, String, Bool)] {
        actions.compactMap { if case let .ask(head, text, fromUser) = $0 { (head, text, fromUser) } else { nil } }
    }

    func card(_ actions: [ConductorAction]) -> [String]? {
        for action in actions { if case let .card(_, choices) = action { return choices.map(\.label) } }
        return nil
    }

    func progress(_ actions: [ConductorAction]) -> RoundsProgress?? {
        for action in actions { if case let .progress(value) = action { return .some(value) } }
        return nil
    }

    func tags(_ text: String) -> HeadTags { HeadTags.parse(text).tags }

    @Test func tagsAreReadAndTakenOut() {
        let (body, tags) = HeadTags.parse("""
        Fixed it.
        <handoff to="codex">Review the diff of PR #5.</handoff>
        <position agree="yes">Read git, with a cache</position>
        <review blocking="2">two left</review>
        """)
        #expect(body == "Fixed it.")
        #expect(tags.handoff?.to == .codex)
        #expect(tags.handoff?.task == "Review the diff of PR #5.")
        #expect(tags.agrees == true)
        #expect(tags.position == "Read git, with a cache")
        #expect(tags.blocking == 2)
        #expect(HeadTags.parse("plain").tags == HeadTags())
    }

    @Test func askBothThenPick() {
        var conductor = Conductor(settings: two)
        var out = conductor.userMessage("Which is better?", to: .both)
        #expect(asks(out).map(\.0) == [.claude])
        #expect(asks(out).first?.2 == true)
        out = conductor.replied(.claude, "Git.", tags: HeadTags(), conducted: true)
        #expect(asks(out).map(\.0) == [.codex])
        #expect(asks(out).first?.1.contains("Which is better?") == true)
        out = conductor.replied(.codex, "JSON.", tags: HeadTags(), conducted: true)
        #expect(card(out) == ["Let them discuss", "Go with Claude's", "Go with Codex's"])
        out = conductor.picked(.goWith(.codex))
        #expect(asks(out).map(\.0) == [.codex])
        #expect(out.contains(.line("You went with Codex's")))
    }

    @Test func reviewStopsEarlyWhenNothingBlocks() {
        var settings = two
        settings.both = .claudeDoesCodexReviews
        var conductor = Conductor(settings: settings)
        var out = conductor.userMessage("Fix the toolbar", to: .both)
        #expect(asks(out).map(\.0) == [.claude])
        out = conductor.replied(.claude, "Fixed.", tags: HeadTags(), conducted: true)
        #expect(progress(out) == .some(RoundsProgress(kind: .review, round: 1, limit: 2)))
        #expect(asks(out).map(\.0) == [.codex])
        out = conductor.replied(.codex, "Looks right.", tags: tags(#"<review blocking="0">fine</review>"#), conducted: true)
        #expect(out.contains(.line("Codex review 1 of 2: no blocking issues")))
        #expect(asks(out).map(\.0) == [.claude])
        out = conductor.replied(.claude, "Done.", tags: HeadTags(), conducted: true)
        #expect(!conductor.isRunning)
    }

    @Test func reviewAtTheLimitAsksWithACard() {
        var settings = two
        settings.both = .codexDoesClaudeReviews
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage("Fix it", to: .both)
        _ = conductor.replied(.codex, "v1", tags: HeadTags(), conducted: true)
        var out = conductor.replied(.claude, "bad", tags: tags(#"<review blocking="1">x</review>"#), conducted: true)
        #expect(asks(out).map(\.0) == [.codex])
        out = conductor.replied(.codex, "v2", tags: HeadTags(), conducted: true)
        #expect(progress(out) == .some(RoundsProgress(kind: .review, round: 2, limit: 2)))
        out = conductor.replied(.claude, "still bad", tags: tags(#"<review blocking="1">x</review>"#), conducted: true)
        #expect(card(out) == ["Keep it as is", "Fix it, one more round", "Let Claude fix it"])
        #expect(asks(out).isEmpty)
        out = conductor.picked(.oneMoreRound)
        #expect(asks(out).map(\.0) == [.codex])
        out = conductor.replied(.codex, "v3", tags: HeadTags(), conducted: true)
        #expect(progress(out) == .some(RoundsProgress(kind: .review, round: 3, limit: 3)))
    }

    @Test func reviewAtTheLimitCanTakeTheDoersVersion() {
        var settings = two
        settings.both = .claudeDoesCodexReviews
        settings.limits = RoundLimits(review: 1, atLimit: .useDoers)
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage("Fix it", to: .both)
        _ = conductor.replied(.claude, "v1", tags: HeadTags(), conducted: true)
        let out = conductor.replied(.codex, "bad", tags: tags(#"<review blocking="3">x</review>"#), conducted: true)
        #expect(card(out) == nil)
        #expect(asks(out).map(\.0) == [.claude])
        #expect(asks(out).first?.1 == Conductor.reviewLimit(reviewer: .codex, review: "bad"))
    }

    @Test func discussionEndsWhenOneAgrees() {
        var settings = two
        settings.both = .discuss
        var conductor = Conductor(settings: settings)
        var out = conductor.userMessage("Git or JSON?", to: .both)
        #expect(progress(out) == .some(RoundsProgress(kind: .discussion, round: 1, limit: 3)))
        out = conductor.replied(.claude, "Git.", tags: tags(#"<position agree="no">git</position>"#), conducted: true)
        #expect(asks(out).map(\.0) == [.codex])
        out = conductor.replied(.codex, "Fine, git.", tags: tags(#"<position agree="yes">git</position>"#), conducted: true)
        #expect(out.contains(.line("Codex and Claude agree")))
        #expect(asks(out).map(\.0) == [.claude])
    }

    @Test func discussionAtTheLimitShowsBothSides() {
        var settings = two
        settings.both = .discuss
        settings.limits.discussion = 2
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage("Git or JSON?", to: .both)
        let no = { (line: String) in self.tags(#"<position agree="no">"# + line + "</position>") }
        _ = conductor.replied(.claude, "a", tags: no("git"), conducted: true)
        var out = conductor.replied(.codex, "b", tags: no("json"), conducted: true)
        #expect(progress(out) == .some(RoundsProgress(kind: .discussion, round: 2, limit: 2)))
        _ = conductor.replied(.claude, "c", tags: no("git, cached"), conducted: true)
        out = conductor.replied(.codex, "d", tags: no("json, checked"), conducted: true)
        #expect(card(out) == ["Go with Claude's", "Go with Codex's", "One more round"])
        let text = out.compactMap { if case let .card(text, _) = $0 { text } else { nil } }.first ?? ""
        #expect(text.contains("Claude: git, cached") && text.contains("Codex: json, checked"))
    }

    @Test func aHandOffComesBackToWhoHandedIt() {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage("Fix it", to: .claude)
        var out = conductor.replied(.claude, "Fixed.", tags: tags(#"<handoff to="codex">Review PR #5</handoff>"#), conducted: false)
        #expect(out.contains(.line("Claude → Codex: Review PR #5")))
        #expect(asks(out).map(\.0) == [.codex])
        #expect(asks(out).first?.1 == Conductor.handed(from: .claude, task: "Review PR #5", count: 1, limit: 6))
        out = conductor.replied(.codex, "No regressions.", tags: HeadTags(), conducted: true)
        #expect(asks(out).map(\.0) == [.claude])
        #expect(asks(out).first?.1 == Conductor.handBack(from: .codex, reply: "No regressions."))
        #expect(progress(out) == .some(nil))
        out = conductor.replied(.claude, "All good.", tags: HeadTags(), conducted: true)
        #expect(out.isEmpty)
    }

    @Test func handOffsStopAtTheLimitPerMessage() {
        var settings = two
        settings.limits.handoffs = 1
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage("go", to: .claude)
        let hand = tags(#"<handoff to="codex">x</handoff>"#)
        _ = conductor.replied(.claude, "a", tags: hand, conducted: false)
        _ = conductor.replied(.codex, "b", tags: HeadTags(), conducted: true)
        let out = conductor.replied(.claude, "c", tags: hand, conducted: true)
        #expect(asks(out).isEmpty)
        #expect(out.contains(.line("Hand-off limit reached (1 for this message): not handed to Codex")))
        // A new message from the user starts the count again.
        _ = conductor.userMessage("again", to: .claude)
        #expect(asks(conductor.replied(.claude, "d", tags: hand, conducted: false)).map(\.0) == [.codex])
    }

    @Test func handOffsOffStillLetCodexHandPublishingToClaudeWhenClaudeIsNotAHead() {
        var settings = HeadsSettings.single(.codex)
        settings.handoffs = false
        var conductor = Conductor(settings: settings)
        let out = conductor.replied(.codex, "Saved.", tags: tags(#"<handoff to="claude">Publish /tmp/r.html as an Artifact</handoff>"#), conducted: false)
        #expect(asks(out).map(\.0) == [.claude])
        var off = two
        off.handoffs = false
        var both = Conductor(settings: off)
        #expect(both.replied(.claude, "x", tags: tags(#"<handoff to="codex">y</handoff>"#), conducted: false).isEmpty)
    }

    @Test func theUserComesFirstAndStopNowEndsTheLoop() {
        var settings = two
        settings.both = .discuss
        var conductor = Conductor(settings: settings)
        _ = conductor.userMessage("Git or JSON?", to: .both)
        #expect(conductor.isRunning)
        #expect(conductor.stop().contains(.line("Stopped by you")))
        #expect(!conductor.isRunning)
        _ = conductor.userMessage("Git or JSON?", to: .both)
        #expect(conductor.userMessage("never mind", to: .claude) == [.progress(nil)])
        #expect(!conductor.isRunning)
    }
}

@MainActor
struct ConductedBotTests {
    @Test func bothInReviewModeRunsTheLoopThroughTheBot() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("Review round") { return #"Fine. <review blocking="0">no issues</review>"# }
            if text.contains("found no blocking issues") { return "Done, nothing left." }
            return isAppOnly(text) ? "OK" : "Fixed the toolbar."
        }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.setBothMode(.claudeDoesCodexReviews)

        bot.send("Fix the toolbar", to: .both)
        await eventually { bot.messages.last?.text == "Done, nothing left." && !bot.isWorking }
        #expect(fake.agents.map(\.launch.engine) == [.claude, .codex, .claude])
        let shown = bot.messages.map(\.text)
        #expect(shown.contains("Fine."))
        #expect(!shown.contains { $0.contains("<review") })
        #expect(shown.contains("Codex review 1 of 2: no blocking issues"))
        #expect(bot.rounds == nil)
    }

    @Test func aHandOffGoesToTheOtherHeadAndBack() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("hands you this") { return "No regressions." }
            if text.contains("finished what you handed over") { return "Reviewed and clean." }
            return isAppOnly(text) ? "OK" : #"Merged PR #5. <handoff to="codex">Review PR #5</handoff>"#
        }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.send("Fix and merge", to: .claude)
        await eventually { bot.messages.last?.text == "Reviewed and clean." && !bot.isWorking }
        #expect(fake.agents.map(\.launch.engine) == [.claude, .codex, .claude])
        #expect(bot.messages.contains { $0.role == .divider && $0.text == "Claude → Codex: Review PR #5" })
        #expect(bot.messages.contains { $0.text == "Merged PR #5." })
        #expect(fake.agents[0].launch.systemPrompt.contains("<handoff to=\"codex\">"))
    }

    @Test func aCardsPickGoesToTheConductor() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) && !text.contains("asked both") ? "<no-reply/>" : "An answer." }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.send("Which?", to: .both)
        await eventually { bot.messages.last?.role == .notice && bot.messages.last?.isOpenQuestion == true }
        let card = try #require(bot.messages.last)
        #expect(card.choices?.map(\.label) == ["Let them discuss", "Go with Claude's", "Go with Codex's"])
        #expect(bot.choose(1, in: card.id))
        await eventually { bot.messages.contains { $0.text == "You went with Claude's" } && !bot.isWorking }
    }
}
