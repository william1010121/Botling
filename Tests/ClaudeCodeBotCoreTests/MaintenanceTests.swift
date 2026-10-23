import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// P5: Maintainer, the plugin library in git, hot reload that keeps the last good version, revert.
@MainActor
@Suite(.enabled(if: PluginLibraryGit.locate() != nil, "needs git"))
struct MaintenanceTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-maint-\(UUID().uuidString)")
    var library: URL { root.appending(path: "ccb/plugins") }

    func workspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), checkCommand: "ccb-check", launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func webPlugin(_ name: String, version: String = "1.0.0", source: String) throws {
        let folder = library.appending(path: name)
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try #"{ "name": "\#(name)", "version": "\#(version)", "engines": { "ccb": "^2.0.0" }, "ccb": { "web": "dist/web.js" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try source.write(to: folder.appending(path: "dist/web.js"), atomically: true, encoding: .utf8)
    }

    @Test func theLibraryIsAGitRepoWithMaintainerInIt() async throws {
        let workspace = workspace(FakeLauncher())
        await workspace.pluginLibraryReady.value
        let git = workspace.plugins.git
        #expect(FileManager.default.fileExists(atPath: library.appending(path: ".git").path))
        #expect(git.commits("ccb-components").count == 1)
        #expect(!git.isDirty("."))
        for name in ["ccb-components", "ccb-teams", "ccb-core"] {
            #expect(workspace.plugins.plugin(name) != nil, "\(name)")
            #expect(PluginRegistry.check(library.appending(path: name)).isEmpty, "\(name)")
        }
        #expect(FileManager.default.fileExists(atPath: library.appending(path: "PLUGINS.md").path))
        #expect(!workspace.teams.map(\.name).contains("component-editor"))
        #expect(workspace.plugins.agentFiles().contains { $0.url.lastPathComponent == "component-editor.md" })

        // Maintainer is a project of its own that never lands in projects.json.
        let maintainer = workspace.maintainer
        #expect(maintainer.profile.instructions?.contains("ccb-check <plugin folder>") == true)
        #expect(!workspace.projects.contains { $0.isMaintainer })
        #expect(workspace.projectBriefing().contains("Maintainer (plugin-library extensions and in-chat components only)"))
        workspace.addProject(folder: root.appending(path: "garden"))
        let saved = try String(contentsOf: root.appending(path: "ccb/projects.json"), encoding: .utf8)
        #expect(saved.contains("garden") && !saved.contains("Maintainer"))
        // Its notes stay out of the library's git.
        #expect(FileManager.default.fileExists(atPath: library.appending(path: ".bot/.gitignore").path))
    }

    @Test(.integration) func aBrokenNewVersionFallsBackToTheLastGoodOneAndGoesToMaintainer() async throws {
        try webPlugin("shout", source: "export function activate() { /* v1 */ }")
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let workspace = workspace(fake)
        let registry = workspace.plugins
        #expect(registry.webSpecs().first { $0.name == "shout" }?.source.contains("v1") == true)
        registry.markLoaded("shout")

        try await Task.sleep(for: .milliseconds(20))
        try "export function activate() { throw new Error('v2 broke') }".write(
            to: library.appending(path: "shout/dist/web.js"), atomically: true, encoding: .utf8)
        registry.rescan()
        #expect(registry.webSpecs().first { $0.name == "shout" }?.source.contains("v2") == true)

        registry.markFailed("shout", message: "v2 broke")
        let plugin = try #require(registry.plugin("shout"))
        #expect(plugin.enabled && plugin.usingPrevious)
        #expect(registry.webSpecs().first { $0.name == "shout" }?.source.contains("v1") == true)
        #expect(workspace.mainBot.messages.last?.text.contains("using the previous version") == true)
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text.contains("v2 broke") } }

        // Fixed: the new files get a try again.
        try await Task.sleep(for: .milliseconds(20))
        try "export function activate() { /* v3 */ }".write(to: library.appending(path: "shout/dist/web.js"), atomically: true, encoding: .utf8)
        registry.rescan()
        #expect(registry.plugin("shout")?.failure == nil)
        #expect(registry.webSpecs().first { $0.name == "shout" }?.source.contains("v3") == true)
        await workspace.putEveryoneToSleep()
    }

    @Test func aBrokenManifestKeepsThePluginRunningAndIsReported() async throws {
        try webPlugin("shout", source: "export function activate() {}")
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let workspace = workspace(fake)
        try "{ broken".write(to: library.appending(path: "shout/package.json"), atomically: true, encoding: .utf8)
        workspace.plugins.rescan()
        #expect(workspace.plugins.plugin("shout") != nil)
        #expect(workspace.plugins.problems["shout"]?.isEmpty == false)
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text.contains("shout") && $0.text.contains("Check failed") } }
        await workspace.putEveryoneToSleep()
    }

    @Test(.integration) func versionChangesAreAnnouncedAndCanBeRevertedWithGit() async throws {
        try webPlugin("shout", source: "export function activate() { /* v1 */ }")
        let workspace = workspace(FakeLauncher())
        await workspace.pluginLibraryReady.value
        let registry = workspace.plugins
        #expect(!registry.hasPrevious("shout"))

        // Maintainer's change: new version, committed.
        try webPlugin("shout", version: "1.1.0", source: "export function activate() { /* v1.1 */ }")
        registry.git.run(["add", "-A"])
        registry.git.run(["commit", "-q", "-m", "shout: louder"])
        registry.rescan()
        #expect(workspace.mainBot.messages.last?.text == "Plugin \"shout\" updated: 1.0.0 → 1.1.0")
        await eventually { registry.hasPrevious("shout") }

        #expect(await registry.revert("shout") == nil)
        #expect(registry.plugin("shout")?.manifest.version == "1.0.0")
        #expect(registry.webSpecs().first { $0.name == "shout" }?.source.contains("v1 ") == true)
        #expect(registry.git.run(["log", "-1", "--format=%s"]).output == "Revert shout to the previous version")

        #expect(await registry.remove("shout") == nil)
        #expect(registry.plugin("shout") == nil)
        #expect(!FileManager.default.fileExists(atPath: library.appending(path: "shout").path))
        #expect(await registry.remove("ccb-latex") != nil)
    }

    @Test func pluginTagsGoToMaintainer() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("Can the input box do laas?") ? "Handed to Maintainer.\n<plugin>laas quick typing in the input box</plugin>" : nil
        }
        let workspace = workspace(fake)
        workspace.mainBot.send("Can the input box do laas?")
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text == "Main bot's request for ClaudeCodeBot: laas quick typing in the input box" } }
        #expect(workspace.mainBot.messages.last?.text == "Handed to Maintainer.")
        await workspace.putEveryoneToSleep()
    }
}

/// P6: Maintainer asks before reading a folder outside the plugin library, once per folder.
@MainActor
struct FolderConsentTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-folder-\(UUID().uuidString)")

    @Test func maintenanceAsksOnceAndRestartsWithTheFolder() async throws {
        let source = root.appending(path: "laas-copy")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            if text.contains("into a ClaudeCodeBot plugin") { return "I need to read the original project first.\n<need-folder>\(source.path)</need-folder>" }
            if text.contains(Workspace.folderAnswer(source, allowed: true)) { return "Read it, starting now." }
            if text.contains(Workspace.folderAnswer(source, allowed: false)) { return "Then I can't do it." }
            return "Got it"
        }
        let ccb = root.appending(path: "ccb")
        let workspace = Workspace(root: ccb, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let maintainer = workspace.maintainer
        workspace.handToMaintainer("Turn laas-copy into a ClaudeCodeBot plugin")
        await eventually { workspace.maintainer.messages.contains { $0.role == .notice && $0.isOpenQuestion } }
        let question = try #require(workspace.maintainer.messages.last { $0.role == .notice })
        #expect(question.text.contains(source.path))
        #expect(question.choices?.map(\.label) == ["Allow", "Don't allow"])
        #expect(maintainer.messages.last { $0.role == .bot }?.text == "I need to read the original project first.")

        #expect(workspace.choose(0, in: question.id, of: workspace.maintainer))
        await eventually { maintainer.messages.contains { $0.role == .bot && $0.text == "Read it, starting now." } }
        #expect(maintainer.messages.contains { $0.role == .divider && $0.text == Bot.shownDivider(.mayRead("laas-copy"), resumed: false) })
        let restarted = try #require(fake.agents.last)
        #expect(restarted.launch.extraDirectories.map(\.standardizedFileURL.path).contains(source.standardizedFileURL.path))
        #expect(!workspace.choose(0, in: question.id, of: workspace.maintainer))

        // Remembered across restarts; a folder inside it needs no question.
        await workspace.putEveryoneToSleep()
        let again = Workspace(root: ccb, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        #expect(again.approvedFolders.map(\.path) == [source.standardizedFileURL.path])
        let count = again.mainBot.messages.count
        again.requestFolder(source.appending(path: "packages").path)
        await eventually { again.maintainer.messages.contains { $0.role == .relay && $0.text.contains("was already allowed before") } }
        #expect(again.mainBot.messages.count == count)
        await again.putEveryoneToSleep()
    }

    @Test func sayingNoIsPassedOn() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            if text.contains("Take a look") { return "<need-folder>/tmp/elsewhere</need-folder>" }
            return "Then I can't do it."
        }
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        workspace.handToMaintainer("Take a look")
        await eventually { workspace.maintainer.messages.contains { $0.role == .notice && $0.isOpenQuestion } }
        let question = try #require(workspace.maintainer.messages.last { $0.role == .notice })
        #expect(workspace.choose(1, in: question.id, of: workspace.maintainer))
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text == Workspace.folderAnswer(URL(filePath: "/tmp/elsewhere"), allowed: false) } }
        #expect(workspace.approvedFolders.isEmpty)
        await workspace.putEveryoneToSleep()
    }
}
