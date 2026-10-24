import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor struct DecisionSyncExistingDataTests {
    @Test(arguments: [false,true], [false,true])
    func anExplicitHandoffCanReferenceAnExistingOpenQuestionButCannotInventPastApproval(_ historical: Bool, _ knownHead: Bool) async throws {
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        let folder = FileManager.default.temporaryDirectory.appending(path: "existing-decision-\(UUID())")
        let store = BotStore(directory: folder)
        var old = ChatMessage(role:.bot,text:"Existing design approval",choices:[Choice(label:"Implement"),Choice(label:"Revise")]); old.engine = knownHead ? .claude : nil
        if historical { old.chosen = 0 }
        store.save(messages:[old]); store.save(heads:HeadsSettings(engines:[.claude,.codex]))
        let bot = Bot(profile:.main(home:folder),launcher:fake.launcher,store:store)
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at:folder) }
        bot.send("Review the existing design decision",to:.claude)
        await eventually { fake.agents.count == 1 }
        try #require(fake.agents.first).reply("Review request\n<handoff to=\"codex\" kind=\"review\" decision=\"\(old.id)\">Review the existing decision</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        try #require(fake.agents.first { $0.launch.engine == .codex }).reply("Reviewed existing design\n<decision-ref id=\"\(old.id)\"/>")
        await eventually { bot.messages.contains { $0.text.contains("Reviewed existing design") } }
        let view = try #require(bot.messages.first { $0.text.contains("Reviewed existing design") })
        if historical || !knownHead {
            #expect(bot.messages.first { $0.id == old.id }?.chosen == (historical ? 0 : nil))
            #expect(bot.messages.first { $0.id == old.id }?.decisionID == nil)
            #expect(view.choices == nil && view.decisionID == nil)
        } else {
            #expect(bot.messages.first { $0.id == old.id }?.decisionID == old.id)
            #expect(view.decisionID == old.id && view.isOpenQuestion)
            #expect(bot.choose(0,in:view.id))
            #expect(bot.messages.first { $0.id == old.id }?.chosen == 0)
        }
    }
    @Test func anAlreadyIdentifiedDecisionCarriesItsActualChoiceAndNotesInNewHandoffContext() async throws {
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        let folder = FileManager.default.temporaryDirectory.appending(path:"identified-decision-\(UUID())")
        let store = BotStore(directory:folder)
        var a = Choice(label:"Implement"); a.id = UUID()
        var source = ChatMessage(role:.bot,text:"Reviewed design",choices:[a]); source.engine = .claude
        source.decisionID = source.id; source.chosen = 0; source.answer = "Only the reviewed scope"
        store.save(messages:[source]); store.save(heads:HeadsSettings(engines:[.claude,.codex]))
        let bot = Bot(profile:.main(home:folder),launcher:fake.launcher,store:store)
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at:folder) }
        bot.send("Discuss this existing decision",to:.claude)
        await eventually { fake.agents.count == 1 }
        try #require(fake.agents.first).reply("Discuss the decision\n<handoff to=\"codex\" decision=\"\(source.id)\">Discuss existing approved scope, without executing again</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let peer = try #require(fake.agents.first { $0.launch.engine == .codex })
        #expect(peer.wireSent.contains { $0.contains("answer: Implement\nNotes: Only the reviewed scope") })
        peer.reply("Decision view\n<decision-ref id=\"\(source.id)\"/>")
        await eventually { bot.messages.contains { $0.text.contains("Decision view") } }
        let view = try #require(bot.messages.first { $0.text.contains("Decision view") })
        #expect(view.chosen == 0 && view.answer == source.answer && !view.isOpenQuestion)
        #expect(!bot.choose(0,in:view.id))
        #expect(bot.messages.filter { $0.role == .user }.count == 1)
    }

}
