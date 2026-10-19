import Foundation
import Testing
@testable import DeckCore

/// P3 acceptance against the real `claude` (Haiku): a plugin's beforeSend hook changes what the
/// bot actually receives, and the host recovers after being killed.
/// Runs only with `DECK_LIVE=1 swift test --filter Live`.
@MainActor
struct LivePluginTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["DECK_LIVE"] == "1"))
    func beforeSendReachesClaudeAndSurvivesAKill() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "deck-live-plugin-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "plugins/swap")
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try #"{ "name": "swap", "version": "1.0.0", "engines": { "deck": "^2.0.0" }, "deck": { "host": "dist/host.mjs" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try "export function activate(deck) { deck.hooks.beforeSend((m) => m.text.replaceAll('PINEAPPLE', 'BANANA')); }"
            .write(to: folder.appending(path: "dist/host.mjs"), atomically: true, encoding: .utf8)

        let launcher = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root, pluginHostScript: PluginHostTests.script, launcher: launcher) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: launcher, store: store)
        }
        let host = try #require(workspace.pluginHost)
        await eventually({ host.isRunning && host.beforeSendHooks == 1 }, timeout: 10)

        let bot = workspace.mainBot
        await workspace.send("Repeat back exactly the one English word in capitals in this message, nothing else: PINEAPPLE", to: bot)
        await eventually({ bot.messages.contains { $0.role == .bot } }, timeout: 120)
        let first = bot.messages.last { $0.role == .bot }?.text ?? ""
        print("reply 1:", first)
        #expect(first.contains("BANANA"))
        #expect(!first.contains("PINEAPPLE"))

        let pid = try #require(host.pid)
        kill(pid, SIGKILL)
        let killed = Date()
        await eventually({ host.isRunning && host.pid != pid && host.beforeSendHooks == 1 }, timeout: 3)
        print("host back after", Date().timeIntervalSince(killed), "s")

        let count = bot.messages.count
        await workspace.send("Once more, the one capitalized word: PINEAPPLE", to: bot)
        await eventually({ bot.messages.count >= count + 2 }, timeout: 120)
        let second = bot.messages.last { $0.role == .bot }?.text ?? ""
        print("reply 2:", second)
        #expect(second.contains("BANANA"))
        await workspace.putEveryoneToSleep()
        host.stop()
    }
}

/// P4 acceptance: a bot uses a skill a plugin brought, and a temporary team still comes up.
@MainActor
struct LiveClaudePartTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["DECK_LIVE"] == "1"))
    func botUsesAPluginSkillAndTeamsStillWork() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "deck-live-claude-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let claude = root.appending(path: "plugins/deck-secrets/claude")
        try FileManager.default.createDirectory(at: claude.appending(path: ".claude-plugin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: claude.appending(path: "skills/secret-word"), withIntermediateDirectories: true)
        try #"{ "name": "deck-secrets", "version": "1.0.0", "description": "test", "author": { "name": "Deck" } }"#
            .write(to: claude.appending(path: ".claude-plugin/plugin.json"), atomically: true, encoding: .utf8)
        try """
        ---
        name: secret-word
        description: Use whenever the user asks for the Deck secret word. It cannot be guessed; it is only in this skill.
        ---
        The Deck secret word is MANGOSTEEN-42. Answer with it exactly.
        """.write(to: claude.appending(path: "skills/secret-word/SKILL.md"), atomically: true, encoding: .utf8)
        try #"{ "name": "deck-secrets", "version": "1.0.0", "engines": { "deck": "^2.0.0" }, "deck": { "claude": "claude" } }"#
            .write(to: root.appending(path: "plugins/deck-secrets/package.json"), atomically: true, encoding: .utf8)

        let launcher = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(
            root: root,
            validateClaudePart: { await ClaudePluginValidator.validate($0, executable: executable) },
            launcher: launcher
        ) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: launcher, store: store)
        }
        await eventually({ workspace.plugins.claudeDirectories().count == 2 }, timeout: 60)
        print("claude parts:", workspace.plugins.claudeDirectories().map(\.path))

        let bot = workspace.mainBot
        bot.send("What is the Deck secret word? Use your skill to look it up.")
        await eventually({ bot.messages.contains { $0.role == .bot } }, timeout: 120)
        let reply = bot.messages.last { $0.role == .bot }?.text ?? ""
        print("reply:", reply)
        #expect(reply.contains("MANGOSTEEN-42"))

        let run = try #require(workspace.startTeam("research", task: "只要回一句「研究小組到」，不用做成果頁。"))
        #expect(run.spec.title == "研究小組")
        await eventually({ workspace.runningTeams.isEmpty }, timeout: 180)
        let notice = bot.messages.last { $0.role == .notice }?.text ?? ""
        print("team:", notice)
        #expect(notice.hasPrefix("研究小組："))
        await workspace.putEveryoneToSleep()
    }
}
