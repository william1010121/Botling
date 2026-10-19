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

/// P6 acceptance: 「把 laas-copy 做成 Deck 插件」. The only thing done for the user is allowing
/// Deck 維護 to read the folder; it then makes deck-laas, checks and commits it.
/// `DECK_LIVE_KEEP=<dir>` copies the plugin library there afterwards.
@MainActor
struct LivePortTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["DECK_LIVE"] == "1"))
    func maintenancePortsLaasCopyIntoAPlugin() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let source = URL(filePath: "/Users/guoshengwei/tool/extension/laas-copy")
        try #require(FileManager.default.fileExists(atPath: source.path))
        let root = FileManager.default.temporaryDirectory.appending(path: "deck-live-port-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let here = URL(filePath: #filePath).deletingLastPathComponent()
        let deckBinary = here.appending(path: "../../.build/debug/Deck").standardizedFileURL
        let launcher = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(
            root: root,
            builtInPlugins: here.appending(path: "../../Sources/Deck/Resources/plugins").standardizedFileURL,
            validateClaudePart: { await ClaudePluginValidator.validate($0, executable: executable) },
            checkCommand: "env -u CLAUDECODE '\(deckBinary.path)' --check-plugin",
            launcher: launcher
        ) { profile, store in
            Bot(profile: profile, defaultModel: profile.name == "Deck 維護" ? .sonnet : .haiku, idleInterval: 3600, launcher: launcher, store: store)
        }
        await workspace.pluginLibraryReady.value
        let maintainer = workspace.maintainer

        workspace.mainBot.send("把 \(source.path) 做成 Deck 插件，讓我在輸入框打 ;a 就變成 \\alpha。")
        // The user's one click: allow reading the folder.
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion && $0.text.contains("laas-copy") } }, timeout: 600)
        let question = try #require(workspace.mainBot.messages.last { $0.role == .notice && $0.isOpenQuestion })
        print("question:", question.text)
        #expect(workspace.choose(0, in: question.id, of: workspace.mainBot))

        // Done when Deck 維護 has said something after being allowed and is idle again.
        await eventually({
            !maintainer.isWorking && maintainer.phase == .awake
                && maintainer.messages.last(where: { $0.role == .relay })?.text.contains("使用者同意了") == true
                && maintainer.messages.last?.role == .bot
        }, timeout: 1800)
        print("maintainer:\n" + maintainer.messages.map { "[\($0.role)] \($0.text)" }.joined(separator: "\n"))
        workspace.plugins.rescan()
        let plugin = try #require(workspace.plugins.plugins.first { $0.name.contains("laas") })
        print("plugin:", plugin.name, plugin.manifest.version, plugin.folder.path)
        #expect(PluginRegistry.check(plugin.folder).isEmpty)
        #expect(plugin.manifest.deck?.web != nil)
        #expect(!workspace.plugins.git.isDirty(plugin.folder.lastPathComponent))
        print(workspace.plugins.git.run(["log", "--oneline", "-5"]).output)
        print(workspace.plugins.git.run(["tag"]).output)
        if let keep = ProcessInfo.processInfo.environment["DECK_LIVE_KEEP"] {
            try? FileManager.default.removeItem(atPath: keep)
            try FileManager.default.copyItem(at: root.appending(path: "plugins"), to: URL(filePath: keep))
        }
        await workspace.putEveryoneToSleep()
    }
}
