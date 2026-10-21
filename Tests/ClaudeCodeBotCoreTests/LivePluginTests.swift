import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// P3 acceptance against the real `claude` (Haiku): a plugin's beforeSend hook changes what the
/// bot actually receives, and the host recovers after being killed.
/// Runs only with `CCB_LIVE=1 swift test --filter Live`.
@MainActor
struct LivePluginTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func beforeSendReachesClaudeAndSurvivesAKill() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-plugin-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "plugins/swap")
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try #"{ "name": "swap", "version": "1.0.0", "engines": { "ccb": "^2.0.0" }, "ccb": { "host": "dist/host.mjs" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try "export function activate(ccb) { ccb.hooks.beforeSend((m) => m.text.replaceAll('PINEAPPLE', 'BANANA')); }"
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
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func botUsesAPluginSkillAndTeamsStillWork() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-claude-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let claude = root.appending(path: "plugins/ccb-secrets/claude")
        try FileManager.default.createDirectory(at: claude.appending(path: ".claude-plugin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: claude.appending(path: "skills/secret-word"), withIntermediateDirectories: true)
        try #"{ "name": "ccb-secrets", "version": "1.0.0", "description": "test", "author": { "name": "ClaudeCodeBot" } }"#
            .write(to: claude.appending(path: ".claude-plugin/plugin.json"), atomically: true, encoding: .utf8)
        try """
        ---
        name: secret-word
        description: Use whenever the user asks for the ClaudeCodeBot secret word. It cannot be guessed; it is only in this skill.
        ---
        The ClaudeCodeBot secret word is MANGOSTEEN-42. Answer with it exactly.
        """.write(to: claude.appending(path: "skills/secret-word/SKILL.md"), atomically: true, encoding: .utf8)
        try #"{ "name": "ccb-secrets", "version": "1.0.0", "engines": { "ccb": "^2.0.0" }, "ccb": { "claude": "claude" } }"#
            .write(to: root.appending(path: "plugins/ccb-secrets/package.json"), atomically: true, encoding: .utf8)

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
        bot.send("What is the ClaudeCodeBot secret word? Use your skill to look it up.")
        await eventually({ bot.messages.contains { $0.role == .bot } }, timeout: 120)
        let reply = bot.messages.last { $0.role == .bot }?.text ?? ""
        print("reply:", reply)
        #expect(reply.contains("MANGOSTEEN-42"))

        let run = try #require(workspace.startTeam("research", task: "Just reply with one sentence, \"Research team here\"; no result page needed."))
        #expect(run.spec.title == "Research team")
        await eventually({ workspace.runningTeams.isEmpty }, timeout: 180)
        let notice = bot.messages.last { $0.role == .notice }?.text ?? ""
        print("team:", notice)
        #expect(notice.hasPrefix("Research team: "))
        await workspace.putEveryoneToSleep()
    }
}

/// P6 acceptance: "Turn laas-copy into a ClaudeCodeBot plugin". The only thing done for the user is allowing
/// Maintainer to read the folder; it then makes ccb-laas, checks and commits it.
/// Needs `CCB_LAAS_SOURCE=<path to a laas-copy checkout>`; skipped when it is unset.
/// `CCB_LIVE_KEEP=<dir>` copies the plugin library there afterwards.
@MainActor
struct LivePortTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"
                       && ProcessInfo.processInfo.environment["CCB_LAAS_SOURCE"]?.isEmpty == false))
    func maintenancePortsLaasCopyIntoAPlugin() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let path = try #require(ProcessInfo.processInfo.environment["CCB_LAAS_SOURCE"])
        let source = URL(filePath: (path as NSString).expandingTildeInPath)
        try #require(FileManager.default.fileExists(atPath: source.path))
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-port-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let here = URL(filePath: #filePath).deletingLastPathComponent()
        let appBinary = TestPaths.app
        let launcher = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(
            root: root,
            builtInPlugins: here.appending(path: "../../Sources/ClaudeCodeBot/Resources/plugins").standardizedFileURL,
            validateClaudePart: { await ClaudePluginValidator.validate($0, executable: executable) },
            checkCommand: "env -u CLAUDECODE '\(appBinary.path)' --check-plugin",
            launcher: launcher
        ) { profile, store in
            Bot(profile: profile, defaultModel: profile.name == "Maintainer" ? .sonnet : .haiku, idleInterval: 3600, launcher: launcher, store: store)
        }
        await workspace.pluginLibraryReady.value
        let maintainer = workspace.maintainer

        workspace.mainBot.send("Turn \(source.path) into a ClaudeCodeBot plugin, so that typing ;a in the input box becomes \\alpha.")
        // The user's one click: allow reading the folder.
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion && $0.text.contains(source.lastPathComponent) } }, timeout: 600)
        let question = try #require(workspace.mainBot.messages.last { $0.role == .notice && $0.isOpenQuestion })
        print("question:", question.text)
        #expect(workspace.choose(0, in: question.id, of: workspace.mainBot))

        // Done when Maintainer has said something after being allowed and is idle again.
        await eventually({
            !maintainer.isWorking && maintainer.phase == .awake
                && maintainer.messages.last(where: { $0.role == .relay })?.text.contains("The user agreed") == true
                && maintainer.messages.last?.role == .bot
        }, timeout: 1800)
        print("maintainer:\n" + maintainer.messages.map { "[\($0.role)] \($0.text)" }.joined(separator: "\n"))
        workspace.plugins.rescan()
        let plugin = try #require(workspace.plugins.plugins.first { $0.name.contains("laas") })
        print("plugin:", plugin.name, plugin.manifest.version, plugin.folder.path)
        #expect(PluginRegistry.check(plugin.folder).isEmpty)
        #expect(plugin.manifest.ccb?.web != nil)
        #expect(!workspace.plugins.git.isDirty(plugin.folder.lastPathComponent))
        print(workspace.plugins.git.run(["log", "--oneline", "-5"]).output)
        print(workspace.plugins.git.run(["tag"]).output)
        if let keep = ProcessInfo.processInfo.environment["CCB_LIVE_KEEP"] {
            try? FileManager.default.removeItem(atPath: keep)
            try FileManager.default.copyItem(at: root.appending(path: "plugins"), to: URL(filePath: keep))
        }
        await workspace.putEveryoneToSleep()
    }
}

/// P7 acceptance: a plugin with an MCP server, installed only after the user says yes; then a
/// project's manager uses its tool (with a secret from the keychain store).
@MainActor
struct LiveInstallTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func managerUsesAnInstalledPluginsMCPTool() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let helper = InstallTests()
        let repo = try await helper.numberPluginRepo()
        let root = helper.root.appending(path: "ccb")
        defer { try? FileManager.default.removeItem(at: helper.root) }
        let launcher = ClaudeAgentProcess.launcher(executable: executable)
        let secrets = MemorySecretStore()
        let workspace = Workspace(
            root: root,
            validateClaudePart: { await ClaudePluginValidator.validate($0, executable: executable) },
            secrets: secrets,
            launcher: launcher
        ) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: launcher, store: store)
        }
        await workspace.pluginLibraryReady.value

        workspace.mainBot.send("Install this plugin for me: file://\(repo.path)")
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion } }, timeout: 180)
        let card = try #require(workspace.mainBot.messages.last { $0.role == .notice && $0.isOpenQuestion })
        print("card:\n" + card.text)
        #expect(workspace.plugins.plugin("ccb-number") == nil)
        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        await eventually({ workspace.plugins.claudeTools() == ["mcp__plugin_ccb-number_numbers"] }, timeout: 60)
        workspace.plugins.setSecret("ccb-number", "number.salt", to: "1")

        let folder = helper.root.appending(path: "garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        let manager = try #require(workspace.bot(for: project))
        manager.send("Use the secret_number tool to look up ClaudeCodeBot's secret number. Reply with only the number.")
        await eventually({ manager.messages.contains { $0.role == .bot } }, timeout: 180)
        let reply = manager.messages.last { $0.role == .bot }?.text ?? ""
        print("manager:", reply)
        #expect(reply.contains("4243"))
        await workspace.putEveryoneToSleep()
    }
}
