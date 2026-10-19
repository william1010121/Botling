import Foundation
import Testing
@testable import DeckCore

/// P4: plugins' Claude parts reach bots and teams with --plugin-dir; teams are agents.
@MainActor
struct ClaudePartTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-claude-\(UUID().uuidString)")

    func claudePlugin(_ name: String, skill: String = "secret-word") throws -> URL {
        let folder = root.appending(path: "deck/plugins/\(name)")
        let claude = folder.appending(path: "claude")
        try FileManager.default.createDirectory(at: claude.appending(path: ".claude-plugin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: claude.appending(path: "skills/\(skill)"), withIntermediateDirectories: true)
        try #"{ "name": "\#(name)", "version": "1.0.0", "author": { "name": "test" } }"#
            .write(to: claude.appending(path: ".claude-plugin/plugin.json"), atomically: true, encoding: .utf8)
        try "---\nname: \(skill)\ndescription: test\n---\nhi".write(to: claude.appending(path: "skills/\(skill)/SKILL.md"), atomically: true, encoding: .utf8)
        try #"{ "name": "\#(name)", "version": "1.0.0", "engines": { "deck": "^2.0.0" }, "deck": { "claude": "claude" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        return claude
    }

    func workspace(_ fake: FakeLauncher, validate: ((URL) async -> String?)? = nil) -> Workspace {
        Workspace(root: root.appending(path: "deck"), validateClaudePart: validate, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func claudeArgumentsCarryPluginDirectories() {
        let launch = AgentLaunch(model: .haiku, sessionID: UUID(), workingDirectory: root, systemPrompt: "", pluginDirectories: [URL(filePath: "/p/a"), URL(filePath: "/p/b")])
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        #expect(arguments.joined(separator: " ").contains("--plugin-dir /p/a --plugin-dir /p/b"))
    }

    @Test func botsAndTeamsStartWithCheckedClaudeParts() async throws {
        let good = try claudePlugin("tools")
        _ = try claudePlugin("broken")
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.hasPrefix("（App：主 bot 交給你的任務）") { return "好了" }
            return isAppOnly(text) ? "OK" : "收到"
        }
        let workspace = workspace(fake) { folder in
            folder.path.contains("/broken/") ? "skills: bad frontmatter" : nil
        }
        let teams = root.appending(path: "deck/plugins/deck-teams/claude").standardizedFileURL.path
        await eventually { workspace.plugins.claudeDirectories().count == 2 }
        #expect(Set(workspace.plugins.claudeDirectories().map(\.standardizedFileURL.path)) == [good.standardizedFileURL.path, teams])
        await eventually { workspace.mainBot.messages.contains { $0.text.contains("broken") && $0.text.contains("沒通過") } }

        workspace.mainBot.send("嗨")
        await eventually { fake.agents.count == 1 }
        #expect(fake.agents[0].launch.pluginDirectories.map(\.standardizedFileURL.path).contains(good.standardizedFileURL.path))

        workspace.startTeam("research", task: "查一下")
        await eventually { fake.agents.count == 2 }
        #expect(fake.agents[1].launch.pluginDirectories.count == 2)
        await workspace.putEveryoneToSleep()
    }

    @Test func oldTeamFilesMoveIntoTheTeamsPlugin() throws {
        let old = root.appending(path: "deck/teams")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try "---\nname: writers\ntitle: 寫作小組\nmodel: haiku\ntools: Read, Write\ndescription: 寫文章。\n---\n你是寫作小組。"
            .write(to: old.appending(path: "writers.md"), atomically: true, encoding: .utf8)
        let workspace = workspace(FakeLauncher())
        #expect(workspace.teams.map(\.name) == ["writers"])
        #expect(workspace.teams.first?.model == .haiku)
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.fileExists(atPath: root.appending(path: "deck/teams.v1-backup/writers.md").path))
        #expect(PluginRegistry.check(root.appending(path: "deck/plugins/deck-teams")).isEmpty)
    }

    @Test func anAwakeBotRestartsWhenClaudePartsChange() async throws {
        let fake = FakeLauncher()
        let workspace = workspace(fake)
        let bot = workspace.mainBot
        bot.send("嗨")
        await eventually { bot.phase == .awake && !bot.isWorking }
        #expect(fake.agents.count == 1)

        // A new plugin with a Claude part arrives (Deck 維護 made one).
        _ = try claudePlugin("fresh", skill: "new-skill")
        workspace.plugins.rescan()
        await eventually({ bot.messages.contains { $0.role == .divider && $0.text == "交接 → 載入新插件" } }, timeout: 3)
        await eventually { fake.agents.count == 2 && bot.phase == .awake }
        #expect(fake.agents[1].launch.pluginDirectories.contains { $0.path.contains("/fresh/") })
        await workspace.putEveryoneToSleep()
    }
}
