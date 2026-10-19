import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct TagParsingTests {
    @Test func teamComponentAndShowTagsAreActedOnAndHidden() {
        let reply = """
        交給研究小組。
        <team name="research">比較三個筆記 app 的同步方式</team>
        <component name="choices">選項改成橫排</component>
        <show name="progress">{"done": 7, "total": 10}</show>
        """
        let parsed = ReplyParser.parseAll(reply)
        #expect(parsed.body == "交給研究小組。")
        #expect(parsed.requests == [
            .team(name: "research", task: "比較三個筆記 app 的同步方式"),
            .component(name: "choices", request: "選項改成橫排")
        ])
        #expect(parsed.display == ComponentInstance(name: "progress", data: #"{"done": 7, "total": 10}"#))
    }

    @Test func showWithBrokenJSONIsDropped() {
        #expect(ReplyParser.parseAll(#"<show name="x">{oops</show>好"#).display == nil)
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
        #expect(workspace.projectBriefing().contains("research（研究小組）"))
    }

    @Test func wishOutsideProjectsPullsUpATeamThatReportsBack() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("比較筆記 app") && !text.hasPrefix("（App：主 bot 交給你的任務）") {
                return "交給研究小組。\n<team name=\"research\">比較三個筆記 app 的同步方式，交回一頁報告</team>"
            }
            if text.hasPrefix("（App：主 bot 交給你的任務）") {
                return "比完了，Obsidian 最適合你。[筆記 app 比較](file:///tmp/report.html)"
            }
            return "收到"
        }
        let workspace = makeWorkspace(fake)

        workspace.mainBot.send("幫我比較筆記 app")
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice } }

        #expect(workspace.mainBot.messages.map(\.role) == [.user, .bot, .notice])
        #expect(workspace.mainBot.messages[1].text == "交給研究小組。")
        let team = try #require(fake.agents.last)
        #expect(team.launch.model == .sonnet)
        #expect(team.launch.tools.contains("WebSearch"))
        #expect(team.launch.workingDirectory.path.contains("/runs/"))
        #expect(team.launch.workingDirectory.lastPathComponent.hasSuffix("research"))
        #expect(team.sent.first?.contains("比較三個筆記 app 的同步方式") == true)
        let notice = try #require(workspace.mainBot.messages.last)
        #expect(notice.text.hasPrefix("研究小組："))
        #expect(workspace.mainBot.results.first?.label == "筆記 app 比較")
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
        #expect(library.names == ["choices"])
        #expect(library.template("choices")?.contains("ccb.answer(index)") == true)
        #expect(library.catalog().hasPrefix("- choices：選擇題"))
        #expect(workspace.componentBriefing().contains("- choices："))
    }

    @Test func reportGoesToMaintainerWhichEditsAndLandsAsUpdated() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        let library = workspace.components
        let template = library.templateURL("choices")
        let original = try String(contentsOf: template, encoding: .utf8)
        fake.respond = { text in
            if text.contains("選項改成橫排") {
                try? (original + "\n<!-- row -->").write(to: template, atomically: true, encoding: .utf8)
                return "改成橫排了。"
            }
            return isAppOnly(text) ? "OK" : nil
        }

        workspace.requestComponentChange("choices", request: "選項改成橫排", from: "使用者")
        #expect(library.working["choices"] == "選項改成橫排")
        let maintainer = try #require(fake.agents.last)
        #expect(maintainer.launch.workingDirectory.standardizedFileURL == root.appending(path: "ccb/plugins").standardizedFileURL)
        #expect(maintainer.launch.tools.contains("Bash"))
        #expect(maintainer.launch.systemPrompt.contains("PLUGINS.md"))
        #expect(maintainer.sent.first?.contains("使用者 對組件「choices」的要求：選項改成橫排") == true)

        await eventually { library.working.isEmpty }
        #expect(library.updated.contains("choices"))
        #expect(library.template("choices")?.hasSuffix("<!-- row -->") == true)
        await eventually { library.hasPrevious("choices") }
        #expect(workspace.mainBot.messages.last?.text == "Maintainer：改成橫排了。")

        #expect(await library.revert("choices") == nil)
        #expect(library.template("choices") == original)
        await workspace.putEveryoneToSleep()
    }

    @Test func aBotCanAskForAComponentWithATag() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("做一個錯誤提示")
                ? "需要新組件。\n<component name=\"Error Toast\">錯誤提示：紅色、一行、可關閉</component>"
                : nil
        }
        let workspace = makeWorkspace(fake)

        workspace.mainBot.send("做一個錯誤提示")
        await eventually { workspace.components.working["error-toast"] != nil }
        await eventually { fake.agents.count == 2 }
        let maintainer = try #require(fake.agents.last)
        #expect(maintainer.sent.first?.contains("主 bot 要一個新組件「error-toast」") == true)
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
