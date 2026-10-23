import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct IntegratedProjectNamingTests {
    @Test func workspaceLoadMigratesOnlyOwnBotBeforeBuildingSidebarAndChatIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-integrated-naming-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = try ProjectBotNamingTests().source(in: root)
        let own = UUID(), other = UUID(), custom = UUID()
        let dataRoot = root.appending(path: "app-data")
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        AppSettings(developerMode: false, developerProjectID: own).save(to: dataRoot.appending(path: "settings.json"))
        let entries: [[String: Any]] = [
            ["id": own.uuidString, "name": "ClaudeCodeBot", "folder":source.absoluteString,"avatar":"square","futureField":"retained"],
            ["id": other.uuidString,"name":"ClaudeCodeBot","folder":source.absoluteString,"avatar":"star"],
            ["id": custom.uuidString,"name":"My app","folder":source.absoluteString,"avatar":"circle"]
        ]
        let projects = dataRoot.appending(path: "projects.json")
        try JSONSerialization.data(withJSONObject: entries).write(to: projects)
        let archive = source.appending(path: ".bot/archive/preserved.txt")
        try FileManager.default.createDirectory(at: archive.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("existing chat/archive content".utf8).write(to: archive)
        let fake = FakeLauncher()
        func load() -> Workspace {
            Workspace(root: dataRoot, secrets: MemorySecretStore(), launcher: fake.launcher) { profile, store in
                Bot(profile:profile,launcher:fake.launcher,store:store)
            }
        }
        let first = load()
        await first.pluginLibraryReady.value
        let project = try #require(first.projects.first { $0.id == own })
        let bot = try #require(first.bot(for:project))
        #expect(project.name == "botling")
        #expect(bot.name == "botling") // Sidebar, rail and chat title all use this profile name.
        #expect(bot.profile.workingDirectory == source)
        #expect(first.projects.first { $0.id == other }?.name == "ClaudeCodeBot")
        #expect(first.projects.first { $0.id == custom }?.name == "My app")
        let saved = try Data(contentsOf:projects)
        let decoded = try #require(JSONSerialization.jsonObject(with:saved) as? [[String:Any]])
        var expected = entries[0]; expected["name"] = "botling"
        #expect(NSDictionary(dictionary:decoded[0]).isEqual(to:expected))
        #expect(NSDictionary(dictionary:decoded[1]).isEqual(to:entries[1]))
        #expect(NSDictionary(dictionary:decoded[2]).isEqual(to:entries[2]))
        #expect(try String(contentsOf:archive,encoding:.utf8) == "existing chat/archive content")
        await first.putEveryoneToSleep()
        let second = load()
        await second.pluginLibraryReady.value
        #expect(second.projects.first { $0.id == own }?.name == "botling")
        #expect(try Data(contentsOf:projects) == saved)
        await second.putEveryoneToSleep()
    }
}
