import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct DecisionSyncTests {
    @Test func handoffDecisionHasOneAnswerAndOneDispatch() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "decision-sync-\(UUID())")
        let store = BotStore(directory: root)
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        await bot.setHeads([.claude, .codex])
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at: root) }
        bot.send("Review design", to: .claude)
        await eventually { fake.agents.count == 1 }
        let claude = try #require(fake.agents.first)
        claude.reply("Approve design?\n<choices>\n* Implement | Use reviewed design\n- Revise\n</choices>\n<handoff to=\"codex\" kind=\"review\">Review this same design decision</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let original = try #require(bot.messages.first { $0.isOpenQuestion })
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        codex.reply("Reviewed design\n<decision-ref id=\"\(original.id)\"/>")
        await eventually { bot.messages.contains { $0.text.contains("Reviewed design") } }
        let copy = try #require(bot.messages.first { $0.text.contains("Reviewed design") })
        #expect(copy.isOpenQuestion)
        let before = bot.messages.filter { $0.role == .user }.count
        #expect(bot.choose(0, in: copy.id))
        #expect(bot.messages.first { $0.id == original.id }?.chosen == 0)
        #expect(bot.messages.first { $0.id == copy.id }?.chosen == 0)
        #expect(!bot.answer("(Skipped)", in: original.id))
        #expect(!bot.choose(1, in: copy.id))
        #expect(bot.messages.filter { $0.role == .user }.count == before + 1)
        #expect(store.loadMessages().first { $0.id == original.id }?.chosen == 0)
        #expect(store.loadMessages().first { $0.id == copy.id }?.chosen == 0)
    }
}
