import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor struct DecisionSyncMirrorTests {
    @Test(arguments: ["option-ids", "legacy-copy", "incompatible-legacy"])
    func explicitNoticeMirrorsUseSafeOptionMappingAndKeepHistoricalAnswers(_ mode: String) throws {
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "decision-mirrors-\(UUID())")
        let folder = root.appending(path: "project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories:true)
        var a = Choice(label:"Implement"); a.id = UUID()
        var b = Choice(label:"Revise"); b.id = UUID()
        var source = ChatMessage(role:.bot,text:"Design approval",choices:[a,b]); source.engine = .claude; source.decisionID = source.id
        var linked = ChatMessage(role:.bot,text:"Peer design approval",choices:[b,a]); linked.engine = .codex; linked.decisionID = source.id
        let workspace = Workspace(root:root.appending(path:"workspace")) { profile, store in
            if profile.workingDirectory.resolvingSymlinksInPath().standardizedFileURL.path == folder.resolvingSymlinksInPath().standardizedFileURL.path { store.save(messages:[source,linked]); store.save(heads:HeadsSettings(engines:[.claude,.codex])) }
            return Bot(profile:profile,launcher:fake.launcher,store:store)
        }
        let project = workspace.addProject(folder:folder)
        let manager = try #require(workspace.bot(for:project))
        _ = try #require(manager.messages.first { $0.id == source.id })
        defer { manager.stop(); manager.partner?.stop(); workspace.mainBot.stop(); try? FileManager.default.removeItem(at:root) }
        var legacyA = a; legacyA.id = nil
        var legacyB = b; legacyB.id = nil
        let shown = mode == "option-ids" ? [b,a] : mode == "legacy-copy" ? [legacyA,legacyB] : [legacyB,legacyA]
        let main = workspace.mainBot
        main.notice("First view",choices:shown,sourceID:project.id,sourceMessageID:source.id)
        let first = try #require(main.messages.last)
        main.notice("Second view",choices:[b,a],sourceID:project.id,sourceMessageID:linked.id)
        let second = try #require(main.messages.last)
        main.notice("Historical view",choices:[a,b],sourceID:project.id,sourceMessageID:source.id)
        let historical = try #require(main.messages.last)
        main.markAnswered("(Skipped)",in:historical.id)
        let independent = ChatMessage(role:.bot,text:"Design approval",choices:[a,b]); main.post(independent)
        let before = manager.messages.filter { $0.role == .user }.count
        let result = workspace.choose(mode == "legacy-copy" ? 0 : 1,in:first.id,of:main,notes:"Only reviewed scope")
        if mode == "incompatible-legacy" {
            #expect(!result)
            #expect(manager.messages.first { $0.id == source.id }?.isOpenQuestion == true)
            #expect(main.messages.first { $0.id == first.id }?.isOpenQuestion == true)
        } else {
            #expect(result)
            #expect(manager.messages.first { $0.id == source.id }?.chosen == 0)
            #expect(manager.messages.first { $0.id == linked.id }?.chosen == 1)
            #expect(main.messages.first { $0.id == first.id }?.isOpenQuestion == false)
            #expect(main.messages.first { $0.id == second.id }?.chosen == 1)
            #expect(main.messages.first { $0.id == second.id }?.answer == "Only reviewed scope")
            #expect(main.messages.first { $0.id == historical.id }?.answer == "(Skipped)")
            #expect(main.messages.first { $0.id == historical.id }?.decisionID == nil)
            #expect(main.messages.first { $0.id == independent.id }?.isOpenQuestion == true)
            #expect(manager.messages.filter { $0.role == .user }.count == before + 1)
            #expect(!workspace.answer("(Skipped)",in:second.id,of:main))
            let saved = try #require(main.storeDirectory).appending(path:"chat.json")
            let persisted = try JSONDecoder().decode([ChatMessage].self,from:Data(contentsOf:saved))
            #expect(persisted.first { $0.id == first.id }?.isOpenQuestion == false)
            #expect(persisted.first { $0.id == second.id }?.answer == "Only reviewed scope")
        }
    }
}
