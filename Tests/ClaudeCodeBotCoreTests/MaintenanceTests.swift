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
        #expect(maintainer.profile.instructions?.contains("ccb-check <插件資料夾>") == true)
        #expect(!workspace.projects.contains { $0.isMaintainer })
        #expect(workspace.projectBriefing().contains("Maintainer（負責 ClaudeCodeBot 本身"))
        workspace.addProject(folder: root.appending(path: "garden"))
        let saved = try String(contentsOf: root.appending(path: "ccb/projects.json"), encoding: .utf8)
        #expect(saved.contains("garden") && !saved.contains("Maintainer"))
        // Its notes stay out of the library's git.
        #expect(FileManager.default.fileExists(atPath: library.appending(path: ".bot/.gitignore").path))
    }

    @Test func aBrokenNewVersionFallsBackToTheLastGoodOneAndGoesToMaintainer() async throws {
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
        #expect(workspace.mainBot.messages.last?.text.contains("先用上一版") == true)
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
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text.contains("shout") && $0.text.contains("檢查沒過") } }
        await workspace.putEveryoneToSleep()
    }

    @Test func versionChangesAreAnnouncedAndCanBeRevertedWithGit() async throws {
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
        #expect(workspace.mainBot.messages.last?.text == "插件「shout」更新了：1.0.0 → 1.1.0")
        await eventually { registry.hasPrevious("shout") }

        #expect(await registry.revert("shout") == nil)
        #expect(registry.plugin("shout")?.manifest.version == "1.0.0")
        #expect(registry.webSpecs().first { $0.name == "shout" }?.source.contains("v1 ") == true)
        #expect(registry.git.run(["log", "-1", "--format=%s"]).output == "退回 shout 到上一版")

        #expect(await registry.remove("shout") == nil)
        #expect(registry.plugin("shout") == nil)
        #expect(!FileManager.default.fileExists(atPath: library.appending(path: "shout").path))
        #expect(await registry.remove("ccb-latex") != nil)
    }

    @Test func pluginTagsGoToMaintainer() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("輸入框能打 laas 嗎") ? "交給 Maintainer。\n<plugin>輸入框支援 laas 快打</plugin>" : nil
        }
        let workspace = workspace(fake)
        workspace.mainBot.send("輸入框能打 laas 嗎")
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text == "主 bot 對 ClaudeCodeBot 的要求：輸入框支援 laas 快打" } }
        #expect(workspace.mainBot.messages.last?.text == "交給 Maintainer。")
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
            if text.contains("做成 ClaudeCodeBot 插件") { return "要先讀原專案。\n<need-folder>\(source.path)</need-folder>" }
            if text.contains("使用者同意了") { return "讀到了，開始做。" }
            if text.contains("不讓你讀") { return "那我做不了。" }
            return "收到"
        }
        let ccb = root.appending(path: "ccb")
        let workspace = Workspace(root: ccb, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let maintainer = workspace.maintainer
        workspace.handToMaintainer("把 laas-copy 做成 ClaudeCodeBot 插件")
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion } }
        let question = try #require(workspace.mainBot.messages.last { $0.role == .notice })
        #expect(question.text.contains(source.path))
        #expect(question.choices?.map(\.label) == ["可以讀", "不要"])
        #expect(maintainer.messages.last?.text == "要先讀原專案。")

        #expect(workspace.choose(0, in: question.id, of: workspace.mainBot))
        await eventually { maintainer.messages.contains { $0.role == .bot && $0.text == "讀到了，開始做。" } }
        #expect(maintainer.messages.contains { $0.role == .divider && $0.text == "交接 → 可以讀 laas-copy" })
        let restarted = try #require(fake.agents.last)
        #expect(restarted.launch.extraDirectories.map(\.standardizedFileURL.path).contains(source.standardizedFileURL.path))
        #expect(!workspace.choose(0, in: question.id, of: workspace.mainBot))

        // Remembered across restarts; a folder inside it needs no question.
        await workspace.putEveryoneToSleep()
        let again = Workspace(root: ccb, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        #expect(again.approvedFolders.map(\.path) == [source.standardizedFileURL.path])
        let count = again.mainBot.messages.count
        again.requestFolder(source.appending(path: "packages").path)
        await eventually { again.maintainer.messages.contains { $0.role == .relay && $0.text.contains("之前已經同意過") } }
        #expect(again.mainBot.messages.count == count)
        await again.putEveryoneToSleep()
    }

    @Test func sayingNoIsPassedOn() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            if text.contains("看一下") { return "<need-folder>/tmp/elsewhere</need-folder>" }
            return "那我做不了。"
        }
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        workspace.handToMaintainer("看一下")
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion } }
        let question = try #require(workspace.mainBot.messages.last { $0.role == .notice })
        #expect(workspace.choose(1, in: question.id, of: workspace.mainBot))
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text.contains("不讓你讀") } }
        #expect(workspace.approvedFolders.isEmpty)
        await workspace.putEveryoneToSleep()
    }
}
