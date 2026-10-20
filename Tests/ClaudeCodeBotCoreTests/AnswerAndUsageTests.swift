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

    /// A picture saved where the page leaves pasted files.
    func picture(_ name: String = "sketch.png") throws -> URL {
        let url = root.appending(path: "incoming/\(UUID().uuidString.prefix(4))-\(name)")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: url)
        return url
    }

    @Test func anAnswerCanCarryPicturesThatReachTheBotAsAttachments() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.hasSuffix("Ask me") ? question : "OK." }
        let (workspace, _, manager) = try setUp(fake)
        manager.send("Ask me")
        await eventually { manager.openQuestion != nil }
        let asked = try #require(manager.openQuestion)

        let sketch = try picture()
        #expect(!workspace.answer("  ", files: [], in: asked.id, of: manager))
        #expect(workspace.answer("Like this", files: [sketch], in: asked.id, of: manager))
        await eventually { manager.messages.last?.text == "OK." }

        #expect(manager.messages.first { $0.id == asked.id }?.answer == "Like this")
        let line = try #require(manager.messages.last { $0.role == .user })
        let kept = try #require(line.attachments?.first)
        #expect(kept.kind == .image)
        #expect(kept.url.path.hasPrefix(manager.profile.attachmentsURL.path))
        #expect(FileManager.default.fileExists(atPath: kept.url.path))
        let told = try #require(fake.agents[0].sent.last)
        #expect(told.contains("Like this"))
        #expect(told.contains("(Attachments:\n- \(kept.url.path))"))
        #expect(manager.openQuestion == nil)
    }

    @Test func aPictureAloneAnswersAndAComponentThatAsksNothingCanSendOne() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text.hasSuffix("Ask me") ? question : "OK." }
        let (workspace, _, manager) = try setUp(fake)
        manager.send("Ask me")
        await eventually { manager.openQuestion != nil }
        let asked = try #require(manager.openQuestion)

        #expect(workspace.answer("", files: [try picture()], in: asked.id, of: manager))
        #expect(manager.messages.first { $0.id == asked.id }?.answer == "(picture)")
        #expect(Bot.answerLabel("", files: [try picture(), try picture()]) == "(2 pictures)")
        await eventually { manager.messages.last?.text == "OK." }

        // A component on a line that asks nothing: the picture goes as a reply.
        let reply = try #require(manager.messages.last)
        #expect(workspace.answer("", files: [try picture("b.jpg")], in: reply.id, of: manager))
        let line = try #require(manager.messages.last { $0.role == .user })
        #expect(line.text == "")
        #expect(line.attachments?.first?.name.hasSuffix("b.jpg") == true)
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

    @Test func shippedChoicesTakeWordsAndPicturesInOther() throws {
        let template = ComponentDefaults.choicesTemplate
        #expect(template.contains("ccb.pickImage({ multiple: true })"))
        #expect(template.contains("ccb.readImage(file)"))
        #expect(template.contains("ccb.answer(pictures.length ? { text, images: pictures } : text)"))
        #expect(template.contains("event.isComposing"))
        #expect(ComponentDefaults.choicesAbout.contains("(Attachments: …)"))

        // A choices template from 1.5 nobody edited is brought up to the new one.
        let folder = root.appending(path: "components15")
        let choices = folder.appending(path: "choices")
        try FileManager.default.createDirectory(at: choices, withIntermediateDirectories: true)
        try ComponentDefaults.choicesTemplateV1.write(to: choices.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try ComponentDefaults.olderChoicesAbouts.last!.write(to: choices.appending(path: "about.md"), atomically: true, encoding: .utf8)
        let library = ComponentLibrary(folder: folder)
        #expect(library.template("choices") == template)
        #expect(try String(contentsOf: library.aboutURL("choices"), encoding: .utf8) == ComponentDefaults.choicesAbout)
    }

    @Test func componentTeamIsToldTheAnswerContract() {
        #expect(ComponentPrompts.system.contains("ccb.answer({text, images})"))
        #expect(ComponentPrompts.system.contains("ccb.pickImage"))
        #expect(ComponentPrompts.system.contains("ccb.image(path)"))
        #expect(ComponentPrompts.system.contains("ccb.answer"))
        #expect(ComponentPrompts.system.contains("about.md is the usage guide every bot reads"))
        // Details on demand: the about.md line and the call that runs it.
        #expect(ComponentPrompts.system.contains("Detail command: git show --patch --stat {hash}"))
        #expect(ComponentPrompts.system.contains("ccb.runDetail({hash: \"2aed630\"})"))
        #expect(PluginGuide.text(builtIns: "/x").contains("ccb.runDetail({ hash: \"2aed630\" })"))
        // Board sizes: the about.md line, the size it is drawn at, and a layout per size.
        #expect(ComponentPrompts.system.contains("Sizes: 1x1, 2x1, 2x2"))
        #expect(ComponentPrompts.system.contains("ccb.size = {w, h, name}"))
        #expect(ComponentPrompts.system.contains("ccb.onSize("))
        #expect(ComponentPrompts.system.contains("small = the one key number or status"))
        #expect(PluginGuide.text(builtIns: "/x").contains("`Sizes: 1x1, 2x1, 2x2`"))
        #expect(PluginGuide.text(builtIns: "/x").contains("ccb.onSize("))
        // On the Board the component is the tile: told so, and told to drop its own frame.
        #expect(ComponentPrompts.system.contains("ccb.surface = \"board\""))
        #expect(ComponentPrompts.system.contains("<html data-surface=\"board\">"))
        #expect(ComponentPrompts.system.contains("no outer padding beyond about 12px"))
        #expect(PluginGuide.text(builtIns: "/x").contains("`<html data-surface=\"board\">`"))
        // Opened above the input box it is frameless too, and told so.
        #expect(ComponentPrompts.system.contains("ccb.surface = \"pinned\""))
        #expect(ComponentPrompts.system.contains("html:not([data-surface=\"chat\"]) .card"))
        #expect(PluginGuide.text(builtIns: "/x").contains("`<html data-surface=\"pinned\">`"))
        #expect(ComponentDefaults.choicesTemplate.contains("ccb.answer(index)"))
    }
}
