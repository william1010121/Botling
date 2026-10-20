import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct TagParsingTests {
    @Test func teamComponentAndShowTagsAreActedOnAndHidden() {
        let reply = """
        Handed to the Research team.
        <team name="research">Compare how three note apps sync</team>
        <component name="choices">Lay the options out in a row</component>
        <show name="progress">{"done": 7, "total": 10}</show>
        """
        let parsed = ReplyParser.parseAll(reply)
        #expect(parsed.body == "Handed to the Research team.")
        #expect(parsed.requests == [
            .team(name: "research", task: "Compare how three note apps sync"),
            .component(name: "choices", request: "Lay the options out in a row")
        ])
        #expect(parsed.displays.map(\.name) == ["progress"])
        #expect(parsed.displays.first?.data == #"{"done": 7, "total": 10}"#)
    }

    @Test func showWithBrokenJSONIsDropped() {
        let parsed = ReplyParser.parseAll(#"<show name="x">{oops</show>OK"#)
        #expect(parsed.displays.isEmpty)
        #expect(parsed.body == "OK")
    }

    /// A reply showing several components draws every one, each where it was written.
    @Test func everyShowInAReplyIsKeptInOrderAndInPlace() {
        let reply = """
        Here are four designs.

        <show name="table">[{"bot":"Main","n":19}]</show>

        <show name="ranking">[{"bot":"Main","n":19}]</show>

        Two more:

        <show name="pie">[{"bot":"Main","n":19}]</show>

        <show name="grid">[{"bot":"Main","n":19}]</show>

        Which one do you like?
        """
        let parsed = ReplyParser.parseAll(reply)
        #expect(parsed.displays.map(\.name) == ["table", "ranking", "pie", "grid"])
        #expect(!parsed.body.contains("<show"))
        let body = parsed.body as NSString
        let before = parsed.displays.map { body.substring(to: $0.at ?? body.length).trimmingCharacters(in: .whitespacesAndNewlines) }
        #expect(before[0] == "Here are four designs.")
        #expect(before[1] == "Here are four designs.")
        #expect(before[2].hasSuffix("Two more:"))
        #expect(before[3].hasSuffix("Two more:"))
        #expect(body.substring(from: parsed.displays[3].at ?? 0).trimmingCharacters(in: .whitespacesAndNewlines) == "Which one do you like?")
    }

    @Test func aMessageWithSeveralComponentsKeepsThemAllAfterARestart() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-shows-\(UUID().uuidString)")
        let store = BotStore(directory: home)
        let parsed = ReplyParser.parseAll(#"A <show name="a">{"x":1}</show> B <show name="b">{"x":2}</show> C"#)
        var message = ChatMessage(role: .bot, text: parsed.body)
        message.displays = parsed.displays
        store.save(messages: [message])
        let loaded = try #require(store.loadMessages().first)
        #expect(loaded.shown == parsed.displays)
        #expect(loaded.shown.map(\.name) == ["a", "b"])
    }

    /// Saved before: the first <show> taken out, the rest left in the text as tags.
    @Test func aMessageSavedWithLeftoverShowTagsShowsThemAll() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-shows-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let text = #"Five designs.\n\n\n\n<show name=\"b\">[1]</show>\n\n<show name=\"c\">[2]</show>\n\nWhich one?"#
        let json = #"[{"id":"5A7392E5-4CD9-4F19-95D0-9EBA9E047BE1","role":"bot","text":"\#(text)","date":0,"display":{"name":"a","data":"[0]"}}]"#
        try Data(json.utf8).write(to: home.appending(path: "chat.json"))
        let message = try #require(BotStore(directory: home).loadMessages().first)
        #expect(message.shown.map(\.name) == ["a", "b", "c"])
        #expect(!message.text.contains("<show"))
        #expect(message.text.hasPrefix("Five designs.") && message.text.hasSuffix("Which one?"))
        #expect(message.shown[0].at == message.shown[1].at)
    }

    @Test func aMessageSavedWithOneComponentStillShowsIt() throws {
        let json = #"[{"id":"5A7392E5-4CD9-4F19-95D0-9EBA9E047BE1","role":"bot","text":"Hi","date":0,"display":{"name":"bars","data":"[]"}}]"#
        let messages = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        #expect(messages[0].shown == [ComponentInstance(name: "bars", data: "[]")])
    }

    @Test func teamFilesRoundTrip() throws {
        let spec = try #require(TeamSpec.parse(TeamSpec.defaults[0].fileText))
        #expect(spec == TeamSpec.defaults[0])
    }
}

@MainActor
struct TeamTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-team-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func defaultTeamsAreWrittenAsEditableFiles() {
        let workspace = makeWorkspace(FakeLauncher())
        #expect(workspace.teams.map(\.name) == ["prototype", "research"])
        let file = root.appending(path: "ccb/plugins/ccb-teams/claude/agents/research.md")
        #expect(FileManager.default.fileExists(atPath: file.path))
        #expect(workspace.projectBriefing().contains("research (Research team)"))
    }

    @Test func wishOutsideProjectsPullsUpATeamThatReportsBack() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("compare note apps") && !text.hasPrefix("(App: A task from the main bot)") {
                return "Handed to the Research team.\n<team name=\"research\">Compare how three note apps sync and hand back a one-page report</team>"
            }
            if text.hasPrefix("(App: A task from the main bot)") {
                return "Compared them; Obsidian suits you best. [Note app comparison](file:///tmp/report.html)"
            }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)

        workspace.mainBot.send("Help me compare note apps")
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice } }

        #expect(workspace.mainBot.messages.map(\.role) == [.user, .bot, .notice])
        #expect(workspace.mainBot.messages[1].text == "Handed to the Research team.")
        let team = try #require(fake.agents.last)
        #expect(team.launch.model == .sonnet)
        #expect(team.launch.tools.contains("WebSearch"))
        #expect(team.launch.workingDirectory.path.contains("/runs/"))
        #expect(team.launch.workingDirectory.lastPathComponent.hasSuffix("research"))
        #expect(team.sent.first?.contains("Compare how three note apps sync") == true)
        let notice = try #require(workspace.mainBot.messages.last)
        #expect(notice.text.hasPrefix("Research team: "))
        #expect(workspace.mainBot.results.first?.label == "Note app comparison")
        await eventually { workspace.runningTeams.isEmpty }
        #expect(team.finished)
    }

    @Test func unknownTeamFallsBackToTheFirstOne() {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let workspace = makeWorkspace(fake)
        let run = workspace.startTeam("nope", task: "x")
        #expect(run?.spec.name == "prototype")
        #expect(workspace.runningTeams.count == 1)
    }

    @Test func managersCannotPullUpTeams() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let folder = root.appending(path: "code/a")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        workspace.handle([.team(name: "research", task: "x")], from: project)
        #expect(workspace.runningTeams.isEmpty)
    }
}

@MainActor
struct ComponentTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-comp-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func choicesShipsAsATemplate() {
        let workspace = makeWorkspace(FakeLauncher())
        let library = workspace.components
        #expect(library.names == ["choices", PagePreview.component])
        #expect(library.template("choices")?.contains("ccb.answer(index)") == true)
        #expect(library.catalog().hasPrefix("- choices: Choices"))
        #expect(workspace.componentBriefing().contains("- choices: "))
    }

    /// "Make me five kinds of component to pick from, use /design": the main bot hands it to
    /// Maintainer (the component library) instead of drawing its own page, and a /design
    /// request comes back as a Claude Design link, not a local HTML file.
    @Test func componentDesignsGoToTheLibraryAndDesignMeansAClaudeDesignLink() {
        let main = BotPrompts(profile: .main(home: root)).system
        #expect(main.contains("Designing chat components (new looks, several kinds to choose from) is Maintainer's"))
        #expect(main.contains("one <component> tag per design"))
        #expect(main.contains("never draw design pages of your own"))
        let manager = BotPrompts(profile: .manager(name: "g", avatar: "square", folder: root)).system
        for system in [main, manager] {
            #expect(system.contains("\"/design\""))
            #expect(system.contains("Claude Design"))
            #expect(system.contains("not a local HTML file"))
        }
        let maintainer = makeWorkspace(FakeLauncher()).maintainerInstructions()
        #expect(maintainer.contains(#"quickstart with intent "design""#))
        #expect(maintainer.contains("the look of ccb-components"))
        #expect(maintainer.contains("claude.ai link"))
    }

    /// Maintainer never edits a component itself: each request goes to its own background
    /// editor, and the version bump, check and commit happen one component at a time.
    @Test func maintainerAlwaysDelegatesComponentsAndCommitsThemOneAtATime() {
        let maintainer = makeWorkspace(FakeLauncher()).maintainerInstructions()
        #expect(maintainer.contains("Never edit template.html or about.md yourself"))
        #expect(maintainer.contains("every component request (a new component or a change) goes to a ccb-core:component-editor agent"))
        #expect(maintainer.contains("run in the background, one agent per component"))
        #expect(maintainer.contains("Two editors never work on the same component folder at once"))
        #expect(maintainer.contains("SendMessage"))
        #expect(maintainer.contains("stay free for new requests"))
        #expect(maintainer.contains("review its change, then do the rest yourself, one component at a time"))
        #expect(!maintainer.contains("Small jobs"))
    }

    /// The editor's agent file follows the app: an old copy is rewritten, the rest of ccb-core stays.
    @Test func theComponentEditorFileIsRefreshedWhenTheAppsTextChanges() throws {
        let library = FileManager.default.temporaryDirectory.appending(path: "ccb-core-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: library) }
        Workspace.prepareCorePlugin(in: library)
        let editor = library.appending(path: "ccb-core/claude/agents/component-editor.md")
        #expect(try String(contentsOf: editor, encoding: .utf8) == Workspace.componentEditorAgent)
        #expect(Workspace.componentEditorAgent.contains("tools: Read, Write, Edit"))

        let manifest = library.appending(path: "ccb-core/package.json")
        try "{ \"name\": \"ccb-core\", \"version\": \"1.0.7\" }".write(to: manifest, atomically: true, encoding: .utf8)
        try "---\nname: component-editor\n---\nold text".write(to: editor, atomically: true, encoding: .utf8)
        Workspace.prepareCorePlugin(in: library)
        #expect(try String(contentsOf: editor, encoding: .utf8) == Workspace.componentEditorAgent)
        #expect(try String(contentsOf: manifest, encoding: .utf8).contains("1.0.7"))
    }

    @Test func aReportMayBeJustAPicture() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        let shot = FileManager.default.temporaryDirectory.appending(path: "ccb-shot-\(UUID().uuidString).png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: shot)
        defer { try? FileManager.default.removeItem(at: shot) }

        workspace.requestComponentChange("choices", request: "  ", from: "The user", files: [shot])
        #expect(workspace.components.working["choices"] == "see the attached picture")
        let relay = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(relay.text == "The user's request for the component \"choices\": see the attached picture (Attached: a picture of how it looks now or should look.)")
        #expect(relay.attachments?.count == 1)
        await eventually { fake.agents.last?.sent.first?.contains("(Attachments:") == true }
    }

    @Test func reportGoesToMaintainerWhichEditsAndLandsAsUpdated() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        let library = workspace.components
        let template = library.templateURL("choices")
        let original = try String(contentsOf: template, encoding: .utf8)
        fake.respond = { text in
            if text.contains("Lay the options out in a row") {
                try? (original + "\n<!-- row -->").write(to: template, atomically: true, encoding: .utf8)
                return "The options are in a row now."
            }
            return isAppOnly(text) ? "OK" : nil
        }

        workspace.requestComponentChange("choices", request: "Lay the options out in a row", from: "The user")
        #expect(library.working["choices"] == "Lay the options out in a row")
        let maintainer = try #require(fake.agents.last)
        #expect(maintainer.launch.workingDirectory.standardizedFileURL == root.appending(path: "ccb/plugins").standardizedFileURL)
        #expect(maintainer.launch.tools.contains("Bash"))
        #expect(maintainer.launch.systemPrompt.contains("PLUGINS.md"))
        #expect(maintainer.sent.first?.contains("The user's request for the component \"choices\": Lay the options out in a row") == true)

        await eventually { library.working.isEmpty }
        #expect(library.updated.contains("choices"))
        #expect(library.template("choices")?.hasSuffix("<!-- row -->") == true)
        await eventually { library.hasPrevious("choices") }
        #expect(workspace.maintainer.messages.last?.text == "The options are in a row now.")
        #expect(!workspace.mainBot.messages.contains { $0.role == .notice })

        #expect(await library.revert("choices") == nil)
        #expect(library.template("choices") == original)
        await workspace.putEveryoneToSleep()
    }

    @Test func aBotCanAskForAComponentWithATag() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("Make an error toast")
                ? "This needs a new component.\n<component name=\"Error Toast\">Error toast: red, one line, dismissible</component>"
                : nil
        }
        let workspace = makeWorkspace(fake)

        workspace.mainBot.send("Make an error toast")
        await eventually { workspace.components.working["error-toast"] != nil }
        await eventually { fake.agents.count == 2 }
        let maintainer = try #require(fake.agents.last)
        #expect(maintainer.sent.first?.contains("Main bot wants a new component \"error-toast\"") == true)
        await workspace.putEveryoneToSleep()
    }

    @Test func editingATemplateByHandBumpsItsVersion() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let library = workspace.components
        let before = library.versions["choices", default: 0]
        let url = library.templateURL("choices")
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: url.path)
        library.rescan()
        #expect(library.versions["choices", default: 0] == before + 1)
    }
}
