import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Developer mode: one project is ClaudeCodeBot's source; its manager may install builds (you
/// confirm, a build that does not come up is rolled back), look at the app, and gets feedback.
@MainActor
struct DeveloperModeTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-dev-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    /// A fake ClaudeCodeBot.app with an executable and these Info.plist values.
    @discardableResult
    func makeApp(_ path: String, version: String = "1.4.0", commit: String = "", dirty: Bool = false, id: String = "io.github.william1010121.ClaudeCodeBot") throws -> URL {
        let app = root.appending(path: path)
        try FileManager.default.createDirectory(at: app.appending(path: "Contents/MacOS"), withIntermediateDirectories: true)
        let executable = app.appending(path: "Contents/MacOS/ClaudeCodeBot")
        try Data("#!/bin/sh\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let info: [String: Any] = ["CFBundleIdentifier": id, "CFBundleExecutable": "ClaudeCodeBot", "CFBundleShortVersionString": version,
                                   "CCBGitCommit": commit, "CCBGitDirty": dirty ? "1" : "0"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: app.appending(path: "Contents/Info.plist"))
        return app
    }

    func developerSetUp(_ fake: FakeLauncher) throws -> (Workspace, Workspace.Project, Bot) {
        let workspace = makeWorkspace(fake)
        let folder = root.appending(path: "code/ClaudeCodeBot")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder, select: false)
        workspace.setDeveloperMode(true, project: project.id)
        return (workspace, project, try #require(workspace.bot(for: project)))
    }

    @Test func offForEveryoneUntilTurnedOn() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let folder = root.appending(path: "code/app")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder, select: false)
        #expect(workspace.developerProject == nil)
        #expect(workspace.developerBriefing(for: project).isEmpty)
        workspace.handle([.installBuild(path: "/tmp/x.app", note: "")], from: project)
        #expect(!workspace.mainBot.messages.contains { $0.isOpenQuestion })
        #expect(!workspace.reportFeedback("wrong", on: UUID(), in: workspace.mainBot))

        workspace.setDeveloperMode(true, project: project.id)
        #expect(workspace.developerProject?.id == project.id)
        let briefing = workspace.developerBriefing(for: project)
        #expect(briefing.contains("git worktree add \(project.notesFolder.appending(path: "worktrees").path)"))
        #expect(briefing.contains("<install-build path="))
        #expect(briefing.contains("--snapshot"))
        #expect(AppSettings.load(from: root.appending(path: "ccb/settings.json")).developerMode)
        workspace.setDeveloperMode(false, project: nil)
        #expect(workspace.developerProject == nil)
    }

    @Test func theDeveloperBotHearsItsBriefingWhenItWakes() async throws {
        let fake = FakeLauncher()
        // Kept: the wake note asks the workspace.
        let (workspace, _, manager) = try developerSetUp(fake)
        manager.send("hi")
        await eventually { fake.agents.count == 1 }
        #expect(fake.agents[0].sent.first?.contains("(App: Developer mode. This folder is ClaudeCodeBot's own source") == true)
        withExtendedLifetime(workspace) {}
    }

    @Test func theTagsAreRead() {
        let parsed = ReplyParser.parseAll(#"Built. <install-build path="/r/dist/ClaudeCodeBot.app">Unread counts</install-build> <app-screenshot/>"#)
        #expect(parsed.body == "Built.")
        #expect(parsed.requests == [.installBuild(path: "/r/dist/ClaudeCodeBot.app", note: "Unread counts"), .appScreenshot])
    }

    @Test func aBuildIsCheckedThenAskedAboutThenInstalled() throws {
        let fake = FakeLauncher()
        let (workspace, project, _) = try developerSetUp(fake)
        let running = try makeApp("Applications/ClaudeCodeBot.app", version: "1.3.0", commit: "aaaaaaa1")
        let new = try makeApp("code/ClaudeCodeBot/dist/ClaudeCodeBot.app", version: "1.4.0-dev", commit: "bbbbbbb2", dirty: true)

        // Not from an app bundle: it cannot replace itself.
        workspace.handle([.installBuild(path: new.path, note: "")], from: project)
        #expect(workspace.mainBot.messages.last?.text.contains("not running from an app bundle") == true)

        workspace.runningBuild = BuildInfo.read(running)
        // Not ClaudeCodeBot, or no app at all.
        let other = try makeApp("other/Other.app", id: "com.example.other")
        workspace.handle([.installBuild(path: other.path, note: "")], from: project)
        #expect(workspace.mainBot.messages.last?.text.contains("is not ClaudeCodeBot") == true)
        workspace.handle([.installBuild(path: root.appending(path: "nothing.app").path, note: "")], from: project)
        #expect(workspace.mainBot.messages.last?.text.contains("there is no app bundle") == true)

        var launched: [String]?
        workspace.launchInstaller = { launched = $0 }
        workspace.handle([.installBuild(path: new.path, note: "Unread counts in the left column")], from: project)
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })
        #expect(card.text.contains("New: 1.4.0-dev (bbbbbbb, uncommitted changes)"))
        #expect(card.text.contains("Running: 1.3.0 (aaaaaaa)"))
        #expect(card.text.contains("Unread counts in the left column"))
        #expect(card.text.contains("built from uncommitted changes"))
        #expect(card.choices?.first?.label == "Install and restart")

        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        let command = try #require(launched)
        #expect(command.prefix(3) == ["/usr/bin/nohup", "/bin/bash", root.appending(path: "ccb/update/install.sh").path])
        #expect(command[4] == running.standardizedFileURL.path && command[5] == new.standardizedFileURL.path)
        guard case let .installed(state)? = SelfUpdate.outcome(in: root.appending(path: "ccb")) else {
            Issue.record("no install under way")
            return
        }
        #expect(state.requesterID == project.id && state.to.version == "1.4.0-dev")
    }

    @Test func aBuildThatChangesWhatBotsMayDoSaysSo() throws {
        let fake = FakeLauncher()
        let (workspace, project, _) = try developerSetUp(fake)
        let repo = project.folder
        func git(_ arguments: String...) throws -> String {
            let process = Process()
            process.executableURL = URL(filePath: "/usr/bin/git")
            process.arguments = ["-C", repo.path, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"] + arguments
            let output = Pipe()
            process.standardOutput = output
            process.standardError = Pipe()
            try process.run()
            process.waitUntilExit()
            return String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let prompts = repo.appending(path: "Sources/ClaudeCodeBotCore/Prompts.swift")
        try FileManager.default.createDirectory(at: prompts.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = try git("init", "-q")
        try "let rules = 1\n".write(to: prompts, atomically: true, encoding: .utf8)
        try "let a = 1\n".write(to: repo.appending(path: "Bot.swift"), atomically: true, encoding: .utf8)
        _ = try git("add", ".")
        _ = try git("commit", "-q", "-m", "one")
        let old = try git("rev-parse", "HEAD")
        try "let rules = 2\nlet more = 3\n".write(to: prompts, atomically: true, encoding: .utf8)
        try "let alwaysAllowed = [\"Bash\"]\n".write(to: repo.appending(path: "Bot.swift"), atomically: true, encoding: .utf8)
        try "README\n".write(to: repo.appending(path: "README.md"), atomically: true, encoding: .utf8)
        _ = try git("add", ".")
        _ = try git("commit", "-q", "-m", "two")
        let new = try git("rev-parse", "HEAD")

        let changes = try #require(SelfUpdate.sensitiveChanges(in: repo, from: old, to: new))
        #expect(changes.map(\.file).sorted() == ["Bot.swift", "Sources/ClaudeCodeBotCore/Prompts.swift"])

        workspace.runningBuild = BuildInfo.read(try makeApp("Applications/ClaudeCodeBot.app", commit: old))
        let build = try makeApp("dist/ClaudeCodeBot.app", commit: new)
        workspace.handle([.installBuild(path: build.path, note: "")], from: project)
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })
        #expect(card.text.contains("It changes what bots are told or allowed to do"))
        #expect(card.text.contains("`Sources/ClaudeCodeBotCore/Prompts.swift` +2 −1"))
        #expect(card.choices?.map(\.label) == ["Install anyway and restart", "Not now"])
        #expect(card.choices?.last?.recommended == true)
    }

    @Test func afterARestartTheBotThatAskedIsToldHowItWent() async throws {
        let fake = FakeLauncher()
        let (workspace, project, manager) = try developerSetUp(fake)
        let ccb = root.appending(path: "ccb")
        let running = try #require(BuildInfo.read(try makeApp("A/ClaudeCodeBot.app", version: "1.3.0")))
        let new = try #require(BuildInfo.read(try makeApp("B/ClaudeCodeBot.app", version: "1.4.0")))

        // Came up: once it has run a moment, it says so and tells the bot.
        _ = try SelfUpdate.prepare(from: running, to: new, requester: project.id, note: "Unread counts", pid: 1, in: ccb)
        workspace.checkSelfUpdate(healthyAfter: 0.05)
        await eventually { manager.messages.first?.role == .relay }
        #expect(manager.messages.first?.text.hasPrefix("(App) ClaudeCodeBot restarted on 1.4.0") == true)
        #expect(FileManager.default.fileExists(atPath: ccb.appending(path: "update/healthy").path))
        #expect(SelfUpdate.outcome(in: ccb) == nil)

        // Did not come up, twice: the bot is told, and installing pauses.
        for attempt in 1...2 {
            _ = try SelfUpdate.prepare(from: running, to: new, requester: project.id, note: "", pid: 1, in: ccb)
            try "the new build did not come up in 90 seconds".write(to: ccb.appending(path: "update/rolled-back"), atomically: true, encoding: .utf8)
            workspace.checkSelfUpdate(healthyAfter: 0.05)
            await eventually { manager.messages.filter { $0.text.contains("did not come up") }.count == attempt }
        }
        #expect(SelfUpdate.failures(in: ccb) == 2)
        #expect(workspace.mainBot.messages.last?.text.contains("installing is paused") == true)
        workspace.runningBuild = running
        workspace.handle([.installBuild(path: new.path, note: "")], from: project)
        #expect(workspace.mainBot.messages.last?.text.contains("installing is paused") == true)
        #expect(!workspace.mainBot.messages.contains { $0.isOpenQuestion })
        // Turning developer mode off and on allows it again.
        workspace.setDeveloperMode(false, project: nil)
        workspace.setDeveloperMode(true, project: project.id)
        #expect(SelfUpdate.failures(in: ccb) == 0)
    }

    @Test func theScriptSwapsTheBuildAndPutsTheOldOneBackIfTheNewOneStaysDown() async throws {
        let ccb = root.appending(path: "ccb")
        func run(healthy: Bool) async throws -> (target: String, rolledBack: String?) {
            let target = try makeApp("Applications/ClaudeCodeBot.app", version: "old")
            let new = try makeApp("dist/ClaudeCodeBot.app", version: "new")
            let running = try #require(BuildInfo.read(target)), build = try #require(BuildInfo.read(new))
            // A process that has already quit stands for the app.
            let gone = Process()
            gone.executableURL = URL(filePath: "/usr/bin/true")
            try gone.run()
            gone.waitUntilExit()
            var command = try SelfUpdate.prepare(from: running, to: build, requester: UUID(), note: "", pid: gone.processIdentifier, in: ccb)
            command[command.count - 1] = "2"
            if healthy { try Data().write(to: ccb.appending(path: "update/healthy")) }
            // Off the main actor: the script sleeps while it waits, and other tests need it.
            let arguments = Array(command.dropFirst(1))
            try await Task.detached {
                let script = Process()
                script.executableURL = URL(filePath: arguments[0])
                script.arguments = Array(arguments.dropFirst())
                script.standardOutput = FileHandle.nullDevice
                script.standardError = FileHandle.nullDevice
                try script.run()
                script.waitUntilExit()
            }.value
            let version = BuildInfo.read(target)?.version ?? "missing"
            let rolledBack = try? String(contentsOf: ccb.appending(path: "update/rolled-back"), encoding: .utf8)
            try? FileManager.default.removeItem(at: target)
            try? FileManager.default.removeItem(at: URL(filePath: target.path + ".failed"))
            return (version, rolledBack)
        }
        let up = try await run(healthy: true)
        #expect(up.target == "new" && up.rolledBack == nil)
        let down = try await run(healthy: false)
        #expect(down.target == "old")
        #expect(down.rolledBack?.contains("did not come up in 2 seconds") == true)
    }

    @Test func aScreenshotGoesBackToTheDeveloperBot() async throws {
        let fake = FakeLauncher()
        let (workspace, project, manager) = try developerSetUp(fake)
        let picture = root.appending(path: "window.png")
        try Data([0x89, 0x50]).write(to: picture)
        workspace.captureWindow = { picture }
        workspace.handle([.appScreenshot], from: project)
        await eventually { manager.messages.first?.attachments?.count == 1 }
        #expect(manager.messages.first?.text == "(App) The app's window right now.")
    }

    @Test func feedbackGoesToTheDeveloperBotWithTheChatAroundIt() async throws {
        let fake = FakeLauncher()
        let (workspace, _, manager) = try developerSetUp(fake)
        let main = workspace.mainBot
        main.post(ChatMessage(role: .user, text: "Every folder under ~/tool should have a bot"))
        var reply = ChatMessage(role: .bot, text: "I can't set a folder for a new bot.")
        reply.steps = [Step(id: "1", kind: .tool, tool: "Read", title: "Read memory.md", done: true)]
        main.post(reply)

        #expect(workspace.reportFeedback("It could have made projects", on: reply.id, in: main))
        await eventually { manager.messages.first?.role == .relay }
        let text = try #require(manager.messages.first?.text)
        #expect(text.contains("the user flagged a reply of Main bot as not right"))
        #expect(text.contains("It could have made projects"))
        #expect(text.contains("User: Every folder under ~/tool should have a bot"))
        #expect(text.contains("You: I can't set a folder for a new bot."))
        #expect(text.contains("What it did on the way: Read memory.md"))
        #expect(text.contains("First write a test that shows this"))
        #expect(main.messages.last?.text.hasPrefix("Sent to ClaudeCodeBot as feedback") == true)
        let log = try String(contentsOf: root.appending(path: "ccb/feedback.md"), encoding: .utf8)
        #expect(log.contains("It could have made projects"))
    }
}
