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
        #expect(parsed.display == ComponentInstance(name: "progress", data: #"{"done": 7, "total": 10}"#))
    }

    @Test func showWithBrokenJSONIsDropped() {
        #expect(ReplyParser.parseAll(#"<show name="x">{oops</show>OK"#).display == nil)
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
