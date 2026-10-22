import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ComponentShotTests {
    private func component() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "shot-\(UUID().uuidString)/todo")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<div>hi</div>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        return folder
    }

    @Test func theCommandLineIsRead() throws {
        let folder = try component()
        // A working folder as the process gives it: no trailing slash.
        let cwd = URL(filePath: folder.deletingLastPathComponent().path(percentEncoded: false).replacingOccurrences(of: "/$", with: "", options: .regularExpression), directoryHint: .notDirectory)
        let options = try ComponentShot.parse(["ClaudeCodeBot", "--component-shot", "todo", "--out", "shots", "--surfaces", "board,chat", "--sizes", "1x1,3x2", "--data", "d.json"], cwd: cwd).get()
        #expect(options.component.path == folder.standardizedFileURL.path)
        #expect(options.out.path == cwd.appending(path: "shots").standardizedFileURL.path)
        #expect(options.surfaces == [.board, .chat])
        #expect(options.sizes == [.small, PinnedComponent.Size(columns: 3, rows: 2)])
        #expect(options.data?.lastPathComponent == "d.json")
        #expect(try ComponentShot.parse(["x", "--component-shot", folder.path, "--sizes", "all"]).get().sizes == PinnedComponent.Size.all)
        #expect(try ComponentShot.parse(["x", "--component-shot", folder.path]).get().surfaces == ComponentShot.Surface.allCases)
    }

    @Test func badUsageAndTheLightThemeAreSaidPlainly() throws {
        let folder = try component()
        guard case .failure(.usage) = ComponentShot.parse(["x", "--component-shot"]) else { Issue.record("no folder"); return }
        guard case .failure(.usage) = ComponentShot.parse(["x", "--component-shot", folder.deletingLastPathComponent().path]) else { Issue.record("no template"); return }
        guard case .failure(.usage) = ComponentShot.parse(["x", "--component-shot", folder.path, "--surfaces", "sidebar"]) else { Issue.record("surface"); return }
        guard case .failure(.usage) = ComponentShot.parse(["x", "--component-shot", folder.path, "--sizes", "5x5"]) else { Issue.record("size"); return }
        guard case let .failure(.unsupported(text)) = ComponentShot.parse(["x", "--component-shot", folder.path, "--theme", "light"]) else { Issue.record("light"); return }
        #expect(text.contains("only draws components in the dark theme"))
    }

    @Test func boardSizesAreTheDefaultsPlusTheAboutHints() {
        #expect(ComponentShot.sizes(asked: nil, hinted: [.large]) == ComponentShot.defaultSizes)
        let tall3 = PinnedComponent.Size(columns: 1, rows: 3)
        #expect(ComponentShot.sizes(asked: nil, hinted: [tall3, .small]) == ComponentShot.defaultSizes + [tall3])
        #expect(ComponentShot.sizes(asked: [.wide], hinted: [tall3]) == [.wide])
    }

    @Test func theSampleDataIsAboutsFirstValidJSONBlock() {
        let about = """
        Todo list.
        ```json
        {not json
        ```
        Data:
        ```json
        {"items": [{"text": "milk", "done": false}]}
        ```
        ```json
        {"second": true}
        ```
        """
        #expect(ComponentShot.sampleData(fromAbout: about) == #"{"items": [{"text": "milk", "done": false}]}"#)
        // Without a block: the first Data: line holding JSON.
        #expect(ComponentShot.sampleData(fromAbout: "Todo.\nData: not yet\nData: `{\"a\": 1}`") == #"{"a": 1}"#)
        #expect(ComponentShot.sampleData(fromAbout: "Data: 3 numbers") == nil)
    }

    private func report(_ change: (inout ComponentShot.FrameReport) -> Void = { _ in }) -> ComponentShot.FrameReport {
        var report = ComponentShot.FrameReport(surface: "board", size: "2x2", width: 320, height: 320, scrollWidth: 320, scrollHeight: 320, contentHeight: 200)
        change(&report)
        return report
    }

    @Test func aCleanFrameHasNoFindings() {
        #expect(ComponentShot.judge(report(), place: "board 2x2", uniform: false).isEmpty)
        // Sub-pixel rounding is not overflow.
        #expect(ComponentShot.judge(report { $0.scrollWidth = 321 }, place: "board 2x2", uniform: false).isEmpty)
    }

    @Test func errorsRejectionsCcbAndResourcesAreProblems() {
        let findings = ComponentShot.judge(report {
            $0.errors = ["TypeError: x is undefined\nglobal code@about:srcdoc:12:3"]
            $0.rejections = ["Error: nope"]
            $0.console = ["bad"]
            $0.ccb = ["ccb.sav is not part of ccb (see PLUGINS.md for the API)"]
            $0.resources = ["img https://example.com/a.png"]
        }, place: "chat", uniform: false)
        #expect(findings.count == 5)
        #expect(findings.allSatisfy { $0.level == .problem && $0.place == "chat" })
        #expect(findings[0].text == "Script error: TypeError: x is undefined · global code@about:srcdoc:12:3")
        #expect(findings[3].text.contains("ccb.sav"))
        #expect(findings[4].text.contains("Did not load: img https://example.com/a.png"))
    }

    @Test func contentWiderThanTheFrameNamesTheWidestElement() {
        let findings = ComponentShot.judge(report { $0.scrollWidth = 480; $0.widest = "table.grid"; $0.widestRight = 480 }, place: "board 2x2", uniform: false)
        #expect(findings == [.init(level: .problem, place: "board 2x2", text: "Wider than its frame: 480px of content in 320px, cut off on the right (widest: table.grid, reaching 480px)")])
    }

    @Test func blankFramesAreProblemsButFlatOnesWithTextAreNot() {
        #expect(ComponentShot.judge(report { $0.contentHeight = 0 }, place: "chat", uniform: true).map(\.text) == ["Draws nothing: its content is 0px tall"])
        #expect(ComponentShot.judge(report { $0.hasText = false }, place: "chat", uniform: true).map(\.text) == ["Looks blank: one flat colour, no text or pictures"])
        #expect(ComponentShot.judge(report(), place: "chat", uniform: true).isEmpty)
        #expect(ComponentShot.judge(report { $0.hasText = false; $0.hasMedia = true }, place: "chat", uniform: true).isEmpty)
    }

    @Test func aBoardTileTooShortIsOnlyAWarning() {
        let findings = ComponentShot.judge(report { $0.scrollHeight = 500 }, place: "board 2x2", uniform: false)
        #expect(findings.map(\.level) == [.warning])
        // In the chat a frame is as tall as its content: no warning there.
        #expect(ComponentShot.judge(report { $0.surface = "chat"; $0.scrollHeight = 500 }, place: "chat", uniform: false).isEmpty)
    }

    @Test func maskedErrorsAreSpotted() {
        #expect(report { $0.errors = ["Script error."] }.hasMaskedErrors)
        #expect(!report { $0.errors = ["TypeError: x"] }.hasMaskedErrors)
    }

    @Test func uniformPixelsAreTold() {
        let flat = [UInt8](repeating: 0, count: 0) + (0..<400).flatMap { _ in [UInt8(27), 27, 31, 255] }
        #expect(ComponentShot.isUniform(flat))
        var drawn = flat
        for i in 0..<40 { drawn[i * 4] = 237; drawn[i * 4 + 1] = 237; drawn[i * 4 + 2] = 240 }
        #expect(!ComponentShot.isUniform(drawn))
        #expect(ComponentShot.isUniform([]))
    }

    @Test func theSummaryListsProblemsWarningsAndTheContactSheet() {
        let text = ComponentShot.summary(
            component: "todo", data: .example,
            findings: [.init(level: .problem, place: "board 1x1", text: "Wider than its frame"), .init(level: .warning, place: "board 2x1", text: "Taller than its tile")],
            shots: [.init(place: "chat", path: "/tmp/s/chat.png")], sheet: "/tmp/s/contact-sheet.png")
        #expect(text.contains("Component todo: 1 frame drawn (dark theme; data from about.md's example)."))
        #expect(text.contains("Problems (1):\n  ✗ board 1x1: Wider than its frame"))
        #expect(text.contains("Warnings (1):\n  ! board 2x1: Taller than its tile"))
        #expect(text.contains("![todo](/tmp/s/contact-sheet.png)"))
        #expect(ComponentShot.summary(component: "x", data: .none, findings: [], shots: [], sheet: nil).contains("No problems."))
        let same = ComponentShot.summary(component: "x", data: .none, findings: ["chat", "board 1x1"].map { .init(level: .problem, place: $0, text: "Script error: boom") }, shots: [], sheet: nil)
        #expect(same.contains("Problems (2):\n  ✗ chat, board 1x1: Script error: boom"))
        #expect(ComponentShot.fileName("board 2x1") == "board-2x1")
    }

    /// A component in a plugin's components/ folder, with this about.md.
    private func pluginComponent(about: String?) throws -> URL {
        let plugin = FileManager.default.temporaryDirectory.appending(path: "shot-plugin-\(UUID().uuidString)/ccb-components")
        let folder = plugin.appending(path: "components/board")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<div>hi</div>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        if let about { try about.write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8) }
        return folder
    }

    @Test func aCommandWithBracketNotationFailsTheCheckWithTheShellsWords() async throws {
        let component = try pluginComponent(about: "Contribution board.\nCommand: echo '{}' [repo_dir]\n")
        let check = try #require(await ComponentShot.checkCommand(component: component, folder: nil))
        #expect(check.command == "echo '{}' [repo_dir]")
        // Without --folder it runs in the plugin folder that holds the component.
        #expect(check.folder.standardizedFileURL.path == component.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL.path)
        let problem = try #require(check.findings.first { $0.level == .problem })
        #expect(problem.place == "command")
        #expect(problem.text.contains("no matches found: [repo_dir]"))
        #expect(problem.text.contains("verbatim"))
        #expect(check.outcome.data == nil)
        let text = ComponentShot.summary(component: "board", data: .example, findings: check.findings, shots: [], sheet: nil)
        #expect(text.contains("✗ command:"))
        #expect(text.contains("no matches found: [repo_dir]"))
    }

    @Test func aRunnableCommandPassesTheCheckAndGivesItsOutput() async throws {
        let component = try pluginComponent(about: "Board.\nCommand: `echo '{\"days\": 3}'`\n")
        let project = FileManager.default.temporaryDirectory.appending(path: "shot-project-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let check = try #require(await ComponentShot.checkCommand(component: component, folder: project))
        #expect(check.findings.isEmpty)
        #expect(check.folder == project)
        #expect(check.outcome.data == #"{"days": 3}"#)
    }

    @Test func aComponentWithoutACommandIsNotRun() async throws {
        #expect(await ComponentShot.checkCommand(component: try pluginComponent(about: "Todo list.\nData: {\"a\": 1}\n"), folder: nil) == nil)
        #expect(await ComponentShot.checkCommand(component: try pluginComponent(about: nil), folder: nil) == nil)
    }

    @Test func aCommandTooSlowForTheCheckIsOnlyAWarning() async throws {
        let component = try pluginComponent(about: "Slow.\nCommand: sleep 5\n")
        let check = try #require(await ComponentShot.checkCommand(component: component, folder: nil, timeout: 0.5))
        #expect(check.findings.count == 1)
        #expect(check.findings.first?.level == .warning)
        #expect(check.outcome.timedOut)
    }

    @Test func theEditorIsToldTheCommandLineRunsVerbatim() {
        #expect(ComponentPrompts.system.contains(ComponentPrompts.commandVerbatim))
        #expect(ComponentPrompts.commandVerbatim.contains("verbatim"))
        #expect(PluginGuide.text(builtIns: "/x").contains("verbatim"))
    }

    @MainActor @Test func maintainerIsToldTheShotCommand() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "shot-ws-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = Workspace(root: root, checkCommand: "ccb-check", shotCommand: "ccb-shot") { profile, store in
            Bot(profile: profile, launcher: { _ in throw CocoaError(.featureUnsupported) }, store: store)
        }
        let rules = workspace.maintainerInstructions()
        #expect(rules.contains("Component shot: ccb-shot <component folder> --out <new folder>"))
        #expect(rules.contains("Give every component editor this exact command"))
        let without = Workspace(root: root.appending(path: "b")) { profile, store in
            Bot(profile: profile, launcher: { _ in throw CocoaError(.featureUnsupported) }, store: store)
        }
        #expect(without.maintainerInstructions().contains("No component-shot command this time"))
    }

    @Test func picturesInMaintainersSpecWordsAreDrawnUnderThem() {
        let line = SpecPayload.LineView(kind: "maintainer", text: "Built it.\n\n![todo](/tmp/shot/contact-sheet.png)\n\nLooks right on every size.")
        #expect(line.text == "Built it.\n\nLooks right on every size.")
        #expect(line.images == ["file:///tmp/shot/contact-sheet.png"])
        let plain = SpecPayload.LineView(kind: "user", text: "Make it ![wider](https://x.y/a.png)")
        #expect(plain.text == "Make it ![wider](https://x.y/a.png)")
        #expect(plain.images == nil)
    }
}
