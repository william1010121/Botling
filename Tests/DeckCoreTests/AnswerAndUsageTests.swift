import Foundation
import Testing
@testable import DeckCore

@MainActor
struct AnswerAndUsageTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-answer-\(UUID().uuidString)")

    func setUp(_ fake: FakeLauncher) throws -> (Workspace, Workspace.Project, Bot) {
        let workspace = Workspace(root: root.appending(path: "deck"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        return (workspace, project, try #require(workspace.bot(for: project)))
    }

    // MARK: ① One way to answer

    @Test func answeringInWordsClosesTheQuestionAndSendsTheWords() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.hasSuffix("問我") ? question : "好。" }
        let (workspace, _, manager) = try setUp(fake)

        manager.send("問我")
        await eventually { manager.openQuestion != nil }
        let asked = try #require(manager.openQuestion)
        #expect(workspace.waiting.count == 1)

        #expect(workspace.answer("只支援仙人掌", in: asked.id, of: manager))
        #expect(!workspace.answer("再答一次", in: asked.id, of: manager))
        #expect(!workspace.choose(0, in: asked.id, of: manager))
        await eventually { manager.messages.last?.text == "好。" }

        #expect(fake.agents[0].sent.last == "只支援仙人掌")
        #expect(manager.messages.first { $0.id == asked.id }?.answer == "只支援仙人掌")
        #expect(manager.openQuestion == nil)
        #expect(workspace.waiting.isEmpty)
    }

    @Test func answeringInWordsFromTheMainBotsNoticeReachesTheManager() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.contains("多肉") ? question : "好。" }
        let (workspace, _, manager) = try setUp(fake)

        manager.relay("多肉植物要不要支援，請使用者決定")
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice } }
        let notice = try #require(workspace.mainBot.messages.last { $0.role == .notice })

        #expect(workspace.answer("看情況，先做一種", in: notice.id, of: workspace.mainBot))
        await eventually { manager.messages.last?.text == "好。" }

        #expect(fake.agents[0].sent.last == "看情況，先做一種")
        #expect(workspace.mainBot.messages.first { $0.id == notice.id }?.answer == "看情況，先做一種")
        #expect(manager.messages.first { $0.id == notice.sourceMessageID }?.answer == "看情況，先做一種")
        #expect(workspace.waiting.isEmpty)
    }

    @Test func aComponentThatAsksNothingJustReplies() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "收到" }
        let (workspace, _, _) = try setUp(fake)
        workspace.mainBot.send("hi")
        await eventually { workspace.mainBot.messages.count == 2 }
        let reply = try #require(workspace.mainBot.messages.last)

        #expect(workspace.answer("再多一點", in: reply.id, of: workspace.mainBot))
        #expect(workspace.mainBot.messages.last { $0.role == .user }?.text == "再多一點")
    }

    // MARK: ② Every bot knows how to use every component

    @Test func botsGetEachComponentsWholeUsage() throws {
        let (workspace, _, _) = try setUp(FakeLauncher())
        let briefing = workspace.componentBriefing()
        #expect(briefing.contains("- choices：選擇題"))
        #expect(briefing.contains(#"  資料：{"options""#))
        #expect(briefing.contains("使用者回答時，bot 會收到"))
    }

    @Test func awakeBotsHearAboutAChangedComponentWithTheirNextMessage() async throws {
        let fake = FakeLauncher()
        let (workspace, _, _) = try setUp(fake)
        let main = workspace.mainBot

        main.send("hi")
        await eventually { main.messages.count == 2 }
        // The component team rewrites the usage.
        let about = workspace.components.aboutURL("choices")
        try "選擇題：現在多了「其他」。\n資料：{\"options\":[],\"chosen\":null,\"answer\":null}".write(to: about, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: about.path)
        workspace.components.rescan()

        main.send("用新的選擇題問我")
        await eventually { main.messages.count == 4 }
        let sent = try #require(fake.agents[0].sent.last)
        #expect(sent.hasPrefix("（App：組件有更新"))
        #expect(sent.contains("現在多了「其他」"))
        #expect(sent.hasSuffix("用新的選擇題問我"))

        main.send("再一句")
        await eventually { main.messages.count == 6 }
        #expect(fake.agents[0].sent.last == "再一句")
    }

    @Test func asleepBotsAreNotNotedTwice() throws {
        let fake = FakeLauncher()
        let (workspace, _, _) = try setUp(fake)
        workspace.mainBot.queueNote("（App：x）")
        workspace.mainBot.send("hi")
        // Waking already carries the latest usage; the note is not added on top.
        #expect(fake.agents[0].sent.first?.contains("（App：x）") == false)
    }

    @Test func unEditedShippedFilesAreUpgradedButEditedOnesAreKept() throws {
        let folder = root.appending(path: "components")
        let choices = folder.appending(path: "choices")
        try FileManager.default.createDirectory(at: choices, withIntermediateDirectories: true)
        try ComponentDefaults.olderChoicesAbouts[0].write(to: choices.appending(path: "about.md"), atomically: true, encoding: .utf8)
        try "<p>我自己改的</p>".write(to: choices.appending(path: "template.html"), atomically: true, encoding: .utf8)

        let library = ComponentLibrary(folder: folder)
        #expect(try String(contentsOf: library.aboutURL("choices"), encoding: .utf8) == ComponentDefaults.choicesAbout)
        #expect(library.template("choices") == "<p>我自己改的</p>")
    }

    @Test func componentTeamIsToldTheAnswerContract() {
        #expect(ComponentPrompts.system.contains("deck.answer"))
        #expect(ComponentPrompts.system.contains("about.md 是給所有 bot 看的使用說明"))
        #expect(ComponentDefaults.choicesTemplate.contains("deck.answer(index)"))
    }
}
