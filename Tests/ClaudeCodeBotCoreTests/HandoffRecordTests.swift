import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The hand-off panel's bookkeeping: each hand-off's message, direction, state and lines,
/// kept beside the conductor's counts without changing what it does.
struct HandoffRecordTests {
    let two = HeadsSettings(engines: [.claude, .codex])

    func hand(_ to: BotEngine, _ kind: HandoffKind = .task, _ task: String) -> HeadTags {
        HeadTags(handoff: .init(to: to, kind: kind, task: task))
    }

    @Test func aHandOffIsRecordedWithItsMessageAndGoesRunningWaitingDone() throws {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage("Fix the toolbar\noverlap at phone width")
        _ = conductor.replied(.claude, "On it.", tags: hand(.codex, .review, "Review the toolbar diff"), handed: false)
        var record = try #require(conductor.records.first)
        #expect(record.from == .claude && record.to == .codex && record.kind == .review)
        #expect(record.origin == "Fix the toolbar overlap at phone width")
        #expect(record.state == .running && record.round == 1 && record.limit == 2 && record.message == 1)
        #expect(record.lines == [.init(who: .claude, text: "Review the toolbar diff")])

        _ = conductor.replied(.codex, "One blocking issue.", tags: HeadTags(), handed: true)
        record = try #require(conductor.records.first)
        #expect(record.state == .waiting)
        #expect(record.lines.last == .init(who: .codex, text: "One blocking issue."))

        _ = conductor.replied(.claude, "Fixed it.", tags: HeadTags(), handed: true)
        record = try #require(conductor.records.first)
        #expect(record.state == .done)
        #expect(record.lines.map(\.who) == [.claude, .codex, .claude])
    }

    @Test func handOffsForSeveralMessagesAreListedTogetherEachWithItsOwnBudget() {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage("First")
        _ = conductor.replied(.claude, "a", tags: hand(.codex, .task, "Task one"), handed: false)
        _ = conductor.userMessage("Second")
        _ = conductor.replied(.codex, "b", tags: hand(.claude, .task, "Task two"), handed: false)
        #expect(conductor.records.map(\.task) == ["Task one", "Task two"])
        #expect(conductor.records.map(\.origin) == ["First", "Second"])
        #expect(conductor.records.map(\.round) == [1, 1])
        #expect(conductor.records.map(\.message) == [1, 2])
        #expect(conductor.records.allSatisfy { $0.isActive })
    }

    @Test func aNewMessageDropsFinishedOnesAndStopMarksTheRestStopped() {
        var conductor = Conductor(settings: two)
        _ = conductor.userMessage("One")
        _ = conductor.replied(.claude, "a", tags: hand(.codex, .task, "Done soon"), handed: false)
        _ = conductor.replied(.codex, "done", tags: HeadTags(), handed: true)
        _ = conductor.replied(.claude, "thanks", tags: HeadTags(), handed: true)
        #expect(conductor.records.map(\.state) == [.done])
        _ = conductor.userMessage("Two")
        #expect(conductor.records.isEmpty)
        _ = conductor.replied(.claude, "b", tags: hand(.codex, .task, "Still going"), handed: false)
        _ = conductor.stop()
        #expect(conductor.records.map(\.state) == [.stopped])
    }

    @Test func thePayloadCarriesEachHandOffForThePanel() throws {
        let record = HandoffRecord(from: .claude, to: .codex, kind: .task, task: "Line one\nline two", origin: "Hi", message: 1,
                                   round: 2, limit: 6, state: .waiting, lines: [.init(who: .claude, text: String(repeating: "x", count: 2000))])
        let view = ChatPayload.Handoff.of(record)
        #expect(view.task == "Line one line two")
        #expect(view.fromName == "Claude" && view.toName == "Codex" && view.state == "waiting")
        #expect(view.lines.first?.text.count == ChatPayload.Handoff.lineLimit + 1)
        let rounds = ChatPayload.Rounds.of(RoundsProgress(kind: .handoff, round: 1, limit: 6))
        #expect(rounds.kind == "handoff" && rounds.round == 1 && rounds.limit == 6)
    }

    @MainActor
    @Test func handoffPayloadKeepsAvatarSettingsAnimationsAndPatchUpdates() throws {
        let bot = makeBot(FakeLauncher())
        let record = HandoffRecord(from: .claude, to: .codex, kind: .review, task: "Review composer", origin: "Integrate A", message: 1,
                                   round: 1, limit: 2, state: .running, lines: [.init(who: .claude, text: "Review composer")])
        bot.showHandoffsForSnapshot([record])
        bot.showRoundsForSnapshot(RoundsProgress(kind: .review, round: 1, limit: 2))
        let head = ChibiAnimation.Head(engine: "claude", avatar: "portrait", thinking: "thinking", sleeping: "sleeping", hat: "hat", clips: ChibiAnimation.clips)
        let look = ChatPayload.HeadLook(avatar: { _ in "portrait" }, mark: { _ in "mark" }, animations: [head])
        func payload(_ size: Int) -> ChatPayload {
            ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look, chatAvatarSize: size) { _ in "custom" }
        }
        for size in [32, 96] {
            let combined = payload(size)
            #expect(combined.chatAvatarSize == size)
            #expect(combined.handoffs?.first?.id == record.id.uuidString)
            #expect(combined.rounds?.kind == "review" && combined.rounds?.limit == 2)
            #expect(combined.animatedHeads?.first?.clips.count == 12)
            #expect(combined.avatarMood != nil && combined.seenHeads != nil)
            let json = try #require(JSONSerialization.jsonObject(with: Data(combined.json().utf8)) as? [String: Any])
            #expect((json["handoffs"] as? [[String: Any]])?.count == 1)
            #expect((json["animatedHeads"] as? [[String: Any]])?.count == 1)
        }
        var patcher = ChatPayload.Patcher()
        _ = patcher.script(for: payload(32))
        let update = patcher.script(for: payload(96))
        let patch = try #require(update)
        #expect(patch.contains("\"chatAvatarSize\":96") && patch.contains("\"handoffs\":") && patch.contains("\"animatedHeads\":"))
        #expect(patch.contains("\"changed\":[]"))
        let group = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil,
                                     group: .init(typing: nil, speaker: { _ in nil }), look: look) { _ in "custom" }
        #expect(group.handoffs == nil && group.rounds == nil && group.animatedHeads == nil)
    }

}
