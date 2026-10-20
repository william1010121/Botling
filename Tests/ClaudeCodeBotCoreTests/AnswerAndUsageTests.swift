import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct AnswerAndUsageTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-answer-\(UUID().uuidString)")

    func setUp(_ fake: FakeLauncher) throws -> (Workspace, Workspace.Project, Bot) {
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
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
        fake.respond = { text in text.hasSuffix("Ask me") ? question : "OK." }
        let (workspace, _, manager) = try setUp(fake)

        manager.send("Ask me")
        await eventually { manager.openQuestion != nil }
        let asked = try #require(manager.openQuestion)
        #expect(workspace.waiting.count == 1)

        #expect(workspace.answer("Only cacti", in: asked.id, of: manager))
        #expect(!workspace.answer("Answering again", in: asked.id, of: manager))
        #expect(!workspace.choose(0, in: asked.id, of: manager))
        await eventually { manager.messages.last?.text == "OK." }

        #expect(fake.agents[0].sent.last == "(Replying to what you said earlier: \"Should we support succulents?\")\n\nOnly cacti")
        #expect(manager.messages.first { $0.id == asked.id }?.answer == "Only cacti")
        #expect(manager.openQuestion == nil)
        #expect(workspace.waiting.isEmpty)
    }

    @Test func aComponentThatAsksNothingJustReplies() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "Got it" }
        let (workspace, _, _) = try setUp(fake)
        workspace.mainBot.send("hi")
        await eventually { workspace.mainBot.messages.count == 2 }
        let reply = try #require(workspace.mainBot.messages.last)

        #expect(workspace.answer("A bit more", in: reply.id, of: workspace.mainBot))
        #expect(workspace.mainBot.messages.last { $0.role == .user }?.text == "A bit more")
    }

    // MARK: ② Every bot knows how to use every component

    @Test func botsGetEachComponentsWholeUsage() throws {
        let (workspace, _, _) = try setUp(FakeLauncher())
        let briefing = workspace.componentBriefing()
        #expect(briefing.contains("- choices: Choices"))
        #expect(briefing.contains(#"  Data: {"options""#))
        #expect(briefing.contains("When the user answers, the bot receives"))
    }

    @Test func awakeBotsHearAboutAChangedComponentWithTheirNextMessage() async throws {
        let fake = FakeLauncher()
        let (workspace, _, _) = try setUp(fake)
        let main = workspace.mainBot

        main.send("hi")
        await eventually { main.messages.count == 2 }
        // The component team rewrites the usage.
        let about = workspace.components.aboutURL("choices")
        try "Choices: now with \"Other\".\nData: {\"options\":[],\"chosen\":null,\"answer\":null}".write(to: about, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: about.path)
        workspace.components.rescan()

        main.send("Ask me with the new choices")
        await eventually { main.messages.count == 4 }
        let sent = try #require(fake.agents[0].sent.last)
        #expect(sent.hasPrefix("(App: Components were updated"))
        #expect(sent.contains("now with \"Other\""))
        #expect(sent.hasSuffix("Ask me with the new choices"))

        main.send("One more thing")
        await eventually { main.messages.count == 6 }
        #expect(fake.agents[0].sent.last == "One more thing")
    }

    @Test func asleepBotsAreNotNotedTwice() throws {
        let fake = FakeLauncher()
        let (workspace, _, _) = try setUp(fake)
        workspace.mainBot.queueNote("(App: x)")
        workspace.mainBot.send("hi")
        // Waking already carries the latest usage; the note is not added on top.
        #expect(fake.agents[0].sent.first?.contains("(App: x)") == false)
    }

    @Test func unEditedShippedFilesAreUpgradedButEditedOnesAreKept() throws {
        let folder = root.appending(path: "components")
        let choices = folder.appending(path: "choices")
        try FileManager.default.createDirectory(at: choices, withIntermediateDirectories: true)
        try ComponentDefaults.olderChoicesAbouts[0].write(to: choices.appending(path: "about.md"), atomically: true, encoding: .utf8)
        try "<p>my own edit</p>".write(to: choices.appending(path: "template.html"), atomically: true, encoding: .utf8)

        let library = ComponentLibrary(folder: folder)
        #expect(try String(contentsOf: library.aboutURL("choices"), encoding: .utf8) == ComponentDefaults.choicesAbout)
        #expect(library.template("choices") == "<p>my own edit</p>")
    }

    @Test func componentTeamIsToldTheAnswerContract() {
        #expect(ComponentPrompts.system.contains("ccb.answer"))
        #expect(ComponentPrompts.system.contains("about.md is the usage guide every bot reads"))
        #expect(ComponentDefaults.choicesTemplate.contains("ccb.answer(index)"))
    }
}
