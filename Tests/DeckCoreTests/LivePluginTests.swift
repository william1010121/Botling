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
