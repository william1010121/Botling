import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct DecisionSyncTests {
    @Test(arguments: BotEngine.allCases) func handoffDecisionHasOneAnswerAndOneDispatch(_ sourceHead: BotEngine) async throws {
        let peer: BotEngine = sourceHead == .claude ? .codex : .claude
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "decision-sync-\(UUID())")
        let store = BotStore(directory: root)
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        await bot.setHeads([.claude, .codex])
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at: root) }
        bot.send("Review design", to: AnswerTarget(sourceHead))
        await eventually { fake.agents.count == 1 }
        let claude = try #require(fake.agents.first)
        claude.reply("Approve design?\n<choices>\n* Implement | Use reviewed design\n- Revise\n</choices>\n<handoff to=\"\(peer.rawValue)\" kind=\"review\">Review this same design decision</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == peer } }
        let original = try #require(bot.messages.first { $0.isOpenQuestion })
        let codex = try #require(fake.agents.first { $0.launch.engine == peer })
        codex.reply("Reviewed design\n<decision-ref id=\"\(original.id)\"/>")
        await eventually { bot.messages.contains { $0.text.contains("Reviewed design") } }
        let copy = try #require(bot.messages.first { $0.text.contains("Reviewed design") })
        #expect(copy.isOpenQuestion)
        // Keep the peer busy to prove the resolution does not inject another answer turn there.
        bot.send("Independent work while the decision waits", to: AnswerTarget(peer))
        await eventually { codex.wireSent.contains { $0.contains("Independent work while") } }
        let before = bot.messages.filter { $0.role == .user }.count
        #expect(bot.choose(0, in: copy.id))
        #expect(bot.messages.first { $0.id == original.id }?.chosen == 0)
        #expect(bot.messages.first { $0.id == copy.id }?.chosen == 0)
        #expect(!bot.answer("(Skipped)", in: original.id))
        #expect(!bot.choose(1, in: copy.id))
        #expect(bot.messages.filter { $0.role == .user }.count == before + 1)
        #expect(store.loadMessages().first { $0.id == original.id }?.chosen == 0)
        #expect(store.loadMessages().first { $0.id == copy.id }?.chosen == 0)
        await eventually { claude.wireSent.contains { $0.contains("resolved once") } }
        #expect(claude.wireSent.filter { $0.contains("resolved once") }.count == 1)
        #expect(codex.wireSent.filter { $0.contains("resolved once") }.isEmpty)
        let peerStore = BotStore(directory: store.directory.appending(path: "partner-\(peer.rawValue)"))
        if peer == .codex { #expect(peerStore.loadMessages().first { $0.id == copy.id }?.chosen == 0) }
        let sourceStore = BotStore(directory: store.directory.appending(path: "partner-\(sourceHead.rawValue)"))
        if sourceHead == .codex { #expect(sourceStore.loadMessages().first { $0.id == original.id }?.chosen == 0) }
    }
    private func fixture() -> (Bot, BotStore, [UUID]) {
        let root = FileManager.default.temporaryDirectory.appending(path: "decision-fixture-\(UUID())")
        let store = BotStore(directory: root)
        var a = Choice(label: "Implement"); a.id = UUID()
        var b = Choice(label: "Revise"); b.id = UUID()
        var source = ChatMessage(role: .bot, text: "Design?", choices: [a,b]); source.engine = .claude; source.decisionID = source.id
        var view = ChatMessage(role: .bot, text: "Same design", choices: [b,a]); view.engine = .codex; view.decisionID = source.id
        let unrelated = ChatMessage(role: .bot, text: "Design?", choices: [a,b])
        store.save(messages: [source,view,unrelated])
        store.save(heads: HeadsSettings(engines: [.claude,.codex]))
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        return (Bot(profile: .main(home: root), launcher: fake.launcher, store: store),store,[source.id,view.id,unrelated.id])
    }

    @Test(arguments: [false,true]) func eitherViewUsesOptionIdentityAndPreservesNotes(_ second: Bool) throws {
        let (bot,store,ids) = fixture()
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at: store.directory) }
        #expect(bot.choose(second ? 1 : 0, in: ids[second ? 1 : 0], notes: "Only the reviewed design"))
        #expect(bot.messages[0].chosen == 0)
        #expect(bot.messages[1].chosen == 1)
        #expect(bot.messages[0].answer == "Only the reviewed design")
        #expect(bot.messages[1].answer == "Only the reviewed design")
        #expect(bot.messages[2].isOpenQuestion)
        #expect(!bot.answer("(Skipped)", in: ids[0]))
        #expect(!bot.choose(0, in: ids[1]))
        #expect(bot.messages.filter { $0.role == .user }.count == 1)
        let loaded = Bot(profile: .main(home: store.directory), launcher: FakeLauncher().launcher, store: store)
        #expect(loaded.messages[0].chosen == 0 && loaded.messages[1].chosen == 1)
        #expect(!loaded.choose(1, in: ids[1]))
        #expect(store.loadMessages()[1].answer == "Only the reviewed design")
    }

    @Test(arguments: ["My own answer", "(Skipped)"])
    func freeformAndSkipAreTruthfulAcrossReload(_ answer: String) {
        let (bot,store,ids) = fixture()
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at: store.directory) }
        #expect(bot.answer(answer, in: ids[1]))
        #expect(bot.messages[0].answer == answer && bot.messages[1].answer == answer)
        #expect(bot.messages[0].chosen == nil && bot.messages[1].chosen == nil)
        #expect(bot.messages[2].isOpenQuestion)
        #expect(!bot.choose(0, in: ids[0]))
        let loaded = Bot(profile: .main(home: store.directory), launcher: FakeLauncher().launcher, store: store)
        #expect(loaded.messages[0].answer == answer && loaded.messages[1].answer == answer)
        #expect(loaded.messages.filter { $0.role == .user }.count == 1)
    }

    @Test func simultaneousClaimsDispatchOnlyOneSemanticAnswer() async {
        let (bot,store,ids) = fixture()
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at: store.directory) }
        let results = await withTaskGroup(of: Bool.self) { group in
            for i in 0..<12 { group.addTask { @MainActor in i.isMultiple(of: 2) ? bot.choose(0, in: ids[0]) : bot.answer("(Skipped)", in: ids[1]) } }
            var results = [Bool](); for await value in group { results.append(value) }; return results
        }
        #expect(results.filter { $0 }.count == 1)
        #expect(bot.messages.filter { $0.role == .user }.count == 1)
        #expect(!bot.messages[0].isOpenQuestion && !bot.messages[1].isOpenQuestion)
        #expect(bot.messages[2].isOpenQuestion)
    }

    @Test func persistenceFailureDoesNotClaimOrDispatch() throws {
        let (bot,store,ids) = fixture()
        defer { bot.stop(); try? FileManager.default.removeItem(at: store.directory) }
        try FileManager.default.removeItem(at: store.directory)
        try Data("blocked".utf8).write(to: store.directory)
        #expect(!bot.choose(0, in: ids[0]))
        #expect(bot.messages[0].isOpenQuestion && bot.messages[1].isOpenQuestion)
        #expect(bot.messages.filter { $0.role == .user }.isEmpty)
    }

    @Test func unknownOptionIdentityCannotAuthorizeAnotherOption() {
        let (bot,store,ids) = fixture()
        defer { bot.stop(); try? FileManager.default.removeItem(at: store.directory) }
        var saved = store.loadMessages()
        saved[1].choices?[0].id = UUID()
        store.save(messages: saved)
        let loaded = Bot(profile: .main(home: store.directory), launcher: FakeLauncher().launcher, store: store)
        #expect(!loaded.choose(0, in: ids[1]))
        #expect(loaded.messages[0].isOpenQuestion)
    }

    @Test func legacyAnswersStayTruthfulAndSimilarQuestionsIndependent() {
        let (bot,store,_) = fixture()
        defer { bot.stop(); try? FileManager.default.removeItem(at: store.directory) }
        var saved = store.loadMessages()
        saved[0].decisionID = nil; saved[1].decisionID = nil
        saved[0].chosen = 0; saved[1].answer = "(Skipped)"
        store.save(messages: saved)
        let loaded = Bot(profile: .main(home: store.directory), launcher: FakeLauncher().launcher, store: store)
        #expect(loaded.messages[0].chosen == 0)
        #expect(loaded.messages[1].answer == "(Skipped)")
        #expect(loaded.messages[2].isOpenQuestion)
    }

    @Test func referenceParserIgnoresCodeAndUsesAnExplicitIdentity() {
        let id = UUID()
        #expect(ReplyParser.parseAll("<decision-ref id=\"\(id)\"/>").decisionReference == id)
        #expect(ReplyParser.parseAll("```xml\n<decision-ref id=\"\(id)\"/>\n```").decisionReference == nil)
        #expect(ReplyParser.parseAll("`<decision-ref id=\"\(id)\"/>`").decisionReference == nil)
        for text in ["> <decision-ref id=\"\(id)\"/>", "<blockquote>\n<decision-ref id=\"\(id)\"/>\n</blockquote>", "<!--\n<decision-ref id=\"\(id)\"/>\n-->"] {
            #expect(ReplyParser.parseAll(text).decisionReference == nil)
            #expect(ReplyParser.liftTags(text).tags.isEmpty)
        }
        #expect(ReplyParser.parseAll("<decision-ref id=\"\(id)\"/>\n<decision-ref id=\"\(UUID())\"/>").decisionReference == nil)
        let lifted = ReplyParser.liftTags("<decision-ref id=\"\(id)\"/>")
        #expect(ReplyParser.parseAll(ReplyParser.lifting(lifted.tags, into: "Reviewed")).decisionReference == id)
    }

}
