import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor struct DecisionSyncContextTests {
    @Test(arguments: ["late-view", "independent", "changed-options", "unknown-reference", "quoted-reference"])
    func associationRequiresAnExplicitCompatibleHandoff(_ mode: String) async throws {
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        let folder = FileManager.default.temporaryDirectory.appending(path: "decision-context-\(UUID())")
        let store = BotStore(directory: folder)
        let bot = Bot(profile: .main(home: folder), launcher: fake.launcher, store: store)
        await bot.setHeads([.claude,.codex])
        defer { bot.stop(); bot.partner?.stop(); try? FileManager.default.removeItem(at: folder) }
        bot.send("Review design", to: .claude)
        await eventually { fake.agents.count == 1 }
        let claude = try #require(fake.agents.first)
        claude.reply("Design approval\n<choices>\n* Implement\n- Revise\n</choices>\n<handoff to=\"codex\" kind=\"review\">Review decision</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        let source = try #require(bot.messages.first { $0.isOpenQuestion })
        #expect(source.decisionID == source.id)
        #expect(codex.wireSent.contains { $0.contains("<decision-ref") && $0.contains(source.id.uuidString) })
        let body: String
        switch mode {
        case "late-view":
            #expect(bot.choose(0,in:source.id,notes:"Reviewed scope only"))
            body = "Review result\n<decision-ref id=\"\(source.id)\"/>"
        case "independent": body = "Review result\n<choices>\n* Implement\n- Revise\n</choices>"
        case "changed-options": body = "Review result\n<decision-ref id=\"\(source.id)\"/>\n<choices>\n* Implement a different proposal\n- Revise\n</choices>"
        case "unknown-reference": body = "Review result\n<decision-ref id=\"\(UUID())\"/>"
        default: body = "Review result\n```xml\n<decision-ref id=\"\(source.id)\"/>\n```"
        }
        codex.reply(body)
        await eventually { bot.messages.contains { $0.text.contains("Review result") } }
        let copy = try #require(bot.messages.first { $0.text.contains("Review result") })
        if mode == "late-view" {
            #expect(copy.decisionID == source.id && copy.chosen == 0)
            #expect(copy.answer == "Reviewed scope only")
            #expect(!copy.isOpenQuestion)
            #expect(!bot.answer("(Skipped)",in:copy.id))
            #expect(bot.messages.filter { $0.role == .user }.count == 2)
            #expect(store.loadMessages().first { $0.id == copy.id }?.chosen == 0)
        } else {
            #expect(copy.decisionID != source.id)
            #expect(bot.messages.first { $0.id == source.id }?.isOpenQuestion == true)
            if mode == "independent" || mode == "changed-options" {
                #expect(copy.isOpenQuestion)
                #expect(bot.choose(0,in:copy.id))
                #expect(bot.messages.first { $0.id == source.id }?.isOpenQuestion == true)
            } else { #expect(copy.choices == nil) }
        }
    }
}
