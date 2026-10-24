import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor struct DecisionSyncParallelContextTests {
    @Test func peerCanReferenceTheDecisionBeforeItsQueuedHandoffStarts() async throws {
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path:"parallel-decision-\(UUID())")
        let bot = Bot(profile:.main(home:root),launcher:fake.launcher,store:BotStore(directory:root))
        await bot.setHeads([.claude,.codex]); bot.claimWait = 60
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at:root) }
        bot.send("Review design",to:.both)
        await eventually { fake.agents.count == 1 }
        let source = try #require(fake.agents.first)
        let peer: BotEngine = source.launch.engine == .claude ? .codex : .claude
        source.reply("Design approval\n<choices>\n* Implement\n- Revise\n</choices>\n<handoff to=\"\(peer.rawValue)\" kind=\"review\">Review same design</handoff>")
        await eventually { fake.agents.count == 2 }
        let original = try #require(bot.messages.first { $0.isOpenQuestion })
        let other = try #require(fake.agents.first { $0.launch.engine == peer })
        #expect(other.wireSent.contains { $0.contains(original.id.uuidString) && $0.contains("<decision-ref") })
        other.reply("Peer decision view\n<decision-ref id=\"\(original.id)\"/>")
        await eventually { bot.messages.contains { $0.text.contains("Peer decision view") } }
        let view = try #require(bot.messages.first { $0.text.contains("Peer decision view") })
        #expect(view.decisionID == original.id && view.isOpenQuestion)
        #expect(bot.choose(0,in:view.id))
        #expect(bot.messages.first { $0.id == original.id }?.chosen == 0)
        #expect(bot.messages.first { $0.id == view.id }?.chosen == 0)
    }
}
