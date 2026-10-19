import Foundation
import Testing
@testable import DeckCore

/// P5: Deck 維護, the plugin library in git, hot reload that keeps the last good version, revert.
@MainActor
@Suite(.enabled(if: PluginLibraryGit.locate() != nil, "needs git"))
struct MaintenanceTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-maint-\(UUID().uuidString)")
    var library: URL { root.appending(path: "deck/plugins") }

    func workspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "deck"), checkCommand: "deck-check", launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func webPlugin(_ name: String, version: String = "1.0.0", source: String) throws {
        let folder = library.appending(path: name)
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try #"{ "name": "\#(name)", "version": "\#(version)", "engines": { "deck": "^2.0.0" }, "deck": { "web": "dist/web.js" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try source.write(to: folder.appending(path: "dist/web.js"), atomically: true, encoding: .utf8)
    }

    @Test func theLibraryIsAGitRepoWithDeckMaintenanceInIt() async throws {
        let workspace = workspace(FakeLauncher())
        await workspace.pluginLibraryReady.value
        let git = workspace.plugins.git
        #expect(FileManager.default.fileExists(atPath: library.appending(path: ".git").path))
        #expect(git.commits("deck-components").count == 1)
        #expect(!git.isDirty("."))
        for name in ["deck-components", "deck-teams", "deck-core"] {
            #expect(workspace.plugins.plugin(name) != nil, "\(name)")
            #expect(PluginRegistry.check(library.appending(path: name)).isEmpty, "\(name)")
        }
        #expect(FileManager.default.fileExists(atPath: library.appending(path: "DECK-PLUGINS.md").path))
        #expect(!workspace.teams.map(\.name).contains("component-editor"))
        #expect(workspace.plugins.agentFiles().contains { $0.url.lastPathComponent == "component-editor.md" })

        // Deck 維護 is a project of its own that never lands in projects.json.
        let maintainer = workspace.maintainer
        #expect(maintainer.profile.instructions?.contains("deck-check <插件資料夾>") == true)
        #expect(!workspace.projects.contains { $0.isMaintainer })
        #expect(workspace.projectBriefing().contains("Deck 維護（負責 Deck 本身"))
        workspace.addProject(folder: root.appending(path: "garden"))
        let saved = try String(contentsOf: root.appending(path: "deck/projects.json"), encoding: .utf8)
        #expect(saved.contains("garden") && !saved.contains("Deck 維護"))
        // Its notes stay out of the library's git.
        #expect(FileManager.default.fileExists(atPath: library.appending(path: ".bot/.gitignore").path))
    }

    @Test func aBrokenNewVersionFallsBackToTheLastGoodOneAndGoesToDeckMaintenance() async throws {
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

        // Deck 維護's change: new version, committed.
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
        #expect(await registry.remove("deck-latex") != nil)
    }

    @Test func pluginTagsGoToDeckMaintenance() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("輸入框能打 laas 嗎") ? "交給 Deck 維護。\n<plugin>輸入框支援 laas 快打</plugin>" : nil
        }
        let workspace = workspace(fake)
        workspace.mainBot.send("輸入框能打 laas 嗎")
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text == "主 bot 對 Deck 的要求：輸入框支援 laas 快打" } }
        #expect(workspace.mainBot.messages.last?.text == "交給 Deck 維護。")
        await workspace.putEveryoneToSleep()
    }
}
