import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// P4: plugins' Claude parts reach bots and teams with --plugin-dir; teams are agents.
@MainActor
struct ClaudePartTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-claude-\(UUID().uuidString)")

    func claudePlugin(_ name: String, skill: String = "secret-word") throws -> URL {
        let folder = root.appending(path: "ccb/plugins/\(name)")
        let claude = folder.appending(path: "claude")
        try FileManager.default.createDirectory(at: claude.appending(path: ".claude-plugin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: claude.appending(path: "skills/\(skill)"), withIntermediateDirectories: true)
        try #"{ "name": "\#(name)", "version": "1.0.0", "author": { "name": "test" } }"#
            .write(to: claude.appending(path: ".claude-plugin/plugin.json"), atomically: true, encoding: .utf8)
        try "---\nname: \(skill)\ndescription: test\n---\nhi".write(to: claude.appending(path: "skills/\(skill)/SKILL.md"), atomically: true, encoding: .utf8)
        try #"{ "name": "\#(name)", "version": "1.0.0", "engines": { "ccb": "^2.0.0" }, "ccb": { "claude": "claude" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        return claude
    }

    func workspace(_ fake: FakeLauncher, validate: ((URL) async -> String?)? = nil) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), validateClaudePart: validate, launcher: fake.launcher) { profile, store in
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
            if text.hasPrefix("(App: A task from the main bot)") { return "Done" }
            return isAppOnly(text) ? "OK" : "Got it"
        }
        let workspace = workspace(fake) { folder in
            folder.path.contains("/broken/") ? "skills: bad frontmatter" : nil
        }
        let teams = root.appending(path: "ccb/plugins/ccb-teams/claude").standardizedFileURL.path
        let core = root.appending(path: "ccb/plugins/ccb-core/claude").standardizedFileURL.path
        await eventually { workspace.plugins.claudeDirectories().count == 3 }
        #expect(Set(workspace.plugins.claudeDirectories().map(\.standardizedFileURL.path)) == [good.standardizedFileURL.path, teams, core])
        await eventually { workspace.mainBot.messages.contains { $0.text.contains("broken") && $0.text.contains("failed") } }

        workspace.mainBot.send("Hi")
        await eventually { fake.agents.count == 1 }
        #expect(fake.agents[0].launch.pluginDirectories.map(\.standardizedFileURL.path).contains(good.standardizedFileURL.path))

        workspace.startTeam("research", task: "Look it up")
        await eventually { fake.agents.count == 2 }
        #expect(fake.agents[1].launch.pluginDirectories.count == 3)
        await workspace.putEveryoneToSleep()
    }

    @Test func oldTeamFilesMoveIntoTheTeamsPlugin() throws {
        let old = root.appending(path: "ccb/teams")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try "---\nname: writers\ntitle: Writing team\nmodel: haiku\ntools: Read, Write\ndescription: Writes articles.\n---\nYou are the writing team."
            .write(to: old.appending(path: "writers.md"), atomically: true, encoding: .utf8)
        let workspace = workspace(FakeLauncher())
        #expect(workspace.teams.map(\.name) == ["writers"])
        #expect(workspace.teams.first?.model == .haiku)
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.fileExists(atPath: root.appending(path: "ccb/teams.v1-backup/writers.md").path))
        #expect(PluginRegistry.check(root.appending(path: "ccb/plugins/ccb-teams")).isEmpty)
    }

    @Test func anAwakeBotRestartsWhenClaudePartsChange() async throws {
        let fake = FakeLauncher()
        let workspace = workspace(fake)
        let bot = workspace.mainBot
        bot.send("Hi")
        await eventually { bot.phase == .awake && !bot.isWorking }
        #expect(fake.agents.count == 1)

        // A new plugin with a Claude part arrives (Maintainer made one).
        _ = try claudePlugin("fresh", skill: "new-skill")
        workspace.plugins.rescan()
        await eventually({ bot.messages.contains { $0.role == .divider && $0.text == "Handoff → loading new plugins" } })
        await eventually { fake.agents.count == 2 && bot.phase == .awake }
        #expect(fake.agents[1].launch.pluginDirectories.contains { $0.path.contains("/fresh/") })
        await workspace.putEveryoneToSleep()
    }

    /// A plugin changed while the bot had a subagent at work in the background: the handoff
    /// would end that subagent. It waits until the bot is free, and two changes make one handoff.
    @Test func aBotWithASubagentAtWorkLoadsNewPluginsOnceItIsFree() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let workspace = workspace(fake)
        let bot = workspace.mainBot
        bot.send("Read a.txt in a subagent")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Sent it off.")
        await eventually { !bot.isWorking && bot.phase == .awake }
        #expect(bot.subagents.first?.isRunning == true)

        // The Maintainer changes plugins twice while the subagent works.
        _ = try claudePlugin("fresh", skill: "new-skill")
        workspace.plugins.rescan()
        try? await Task.sleep(for: .milliseconds(300))
        _ = try claudePlugin("fresher", skill: "other-skill")
        workspace.plugins.rescan()
        try? await Task.sleep(for: .milliseconds(300))
        #expect(!bot.messages.contains { $0.role == .divider })
        #expect(fake.agents.count == 1)
        #expect(!agent.finished)
        #expect(bot.subagents.first?.isRunning == true)

        // The subagent reports and the bot tells you: now it is free, and loads them once.
        for event in StreamEvent.events(in: SubagentRun.notification) { agent.emit(event) }
        agent.emit(.trace(.text("Done.", parent: nil)))
        await eventually { bot.isWorking }
        agent.reply("It says hello world.")
        await eventually { fake.agents.count == 2 && bot.phase == .awake }
        try? await Task.sleep(for: .milliseconds(300))
        #expect(bot.messages.contains { $0.text == "It says hello world." })
        #expect(bot.messages.filter { $0.role == .divider }.map(\.text) == ["Handoff → loading new plugins"])
        #expect(fake.agents.count == 2)
        let loaded = fake.agents[1].launch.pluginDirectories.map(\.path)
        #expect(loaded.contains { $0.contains("/fresh/") })
        #expect(loaded.contains { $0.contains("/fresher/") })
        await workspace.putEveryoneToSleep()
    }

    /// A changed Claude part is out while it is checked again: the bot hands off once, after
    /// the check, with the new files, not first without the plugin and then again with it.
    @Test func aChangedClaudePartHandsOffOnceAfterItsCheck() async throws {
        let claude = try claudePlugin("tools")
        let fake = FakeLauncher()
        let workspace = workspace(fake) { _ in
            try? await Task.sleep(for: .milliseconds(200))
            return nil
        }
        await eventually { workspace.plugins.claudeDirectories().contains { $0.path.contains("/tools/") } }
        let bot = workspace.mainBot
        bot.send("Hi")
        await eventually { bot.phase == .awake && !bot.isWorking }

        try "---\nname: secret-word\ndescription: test\n---\nhello again".write(to: claude.appending(path: "skills/secret-word/SKILL.md"), atomically: true, encoding: .utf8)
        workspace.plugins.rescan()
        await eventually { fake.agents.count == 2 && bot.phase == .awake }
        try? await Task.sleep(for: .milliseconds(600))
        #expect(fake.agents.count == 2)
        #expect(bot.messages.filter { $0.role == .divider }.count == 1)
        #expect(fake.agents[1].launch.pluginDirectories.contains { $0.path.contains("/tools/") })
        await workspace.putEveryoneToSleep()
    }
}
