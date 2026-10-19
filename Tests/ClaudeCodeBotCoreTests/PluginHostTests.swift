import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The plugin host with the real Node process and the built `host.mjs`.
@MainActor
@Suite(.enabled(if: ClaudeExecutableLocator(command: "node").locate() != nil, "needs Node"))
struct PluginHostTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-host-\(UUID().uuidString)")
    static let script = URL(filePath: #filePath).deletingLastPathComponent()
        .appending(path: "../../Sources/ClaudeCodeBot/Resources/host/host.mjs").standardizedFileURL

    /// A plugin with only a program part.
    func hostPlugin(_ name: String, _ source: String) throws {
        let folder = root.appending(path: "ccb/plugins/\(name)")
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try """
        { "name": "\(name)", "version": "1.0.0", "engines": { "ccb": "^2.0.0" }, "ccb": { "host": "dist/host.mjs", "permissions": ["bots"] } }
        """.write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try source.write(to: folder.appending(path: "dist/host.mjs"), atomically: true, encoding: .utf8)
    }

    func workspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), pluginHostScript: Self.script) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func beforeSendChangesWhatIsSentAndCanStopIt() async throws {
        try hostPlugin("tidy", """
        export function activate(ccb) {
          ccb.hooks.beforeSend((m) => m.text.includes("密碼") ? false : m.text.replaceAll("\\\\(", "$").replaceAll("\\\\)", "$"));
        }
        """)
        let fake = FakeLauncher()
        let workspace = workspace(fake)
        let host = try #require(workspace.pluginHost)
        #expect(await host.waitUntilReady(timeout: .seconds(10)))
        await eventually({ host.beforeSendHooks == 1 }, timeout: 10)

        let bot = workspace.mainBot
        await workspace.send("算 \\(x^2\\)", to: bot)
        #expect(bot.messages.first?.text == "算 $x^2$")
        await eventually({ fake.agents.first?.sent.contains { $0.contains("算 $x^2$") } == true }, timeout: 10)

        await workspace.send("我的密碼是 1234", to: bot)
        #expect(!bot.messages.contains { $0.role == .user && $0.text.contains("1234") && !$0.text.contains("攔下") })
        #expect(bot.messages.last?.text.contains("攔下") == true)
        host.stop()
    }

    @Test func comesBackWithinThreeSecondsAfterBeingKilled() async throws {
        try hostPlugin("shout", """
        export function activate(ccb) { ccb.hooks.beforeSend((m) => m.text + "!"); }
        """)
        let workspace = workspace(FakeLauncher())
        let host = try #require(workspace.pluginHost)
        #expect(await host.waitUntilReady(timeout: .seconds(10)))
        await eventually({ host.beforeSendHooks == 1 }, timeout: 10)
        let pid = try #require(host.pid)

        kill(pid, SIGKILL)
        let killed = Date()
        await eventually({ !host.isRunning }, timeout: 2)
        await eventually({ host.isRunning && host.pid != pid && host.beforeSendHooks == 1 }, timeout: 10)
        #expect(Date().timeIntervalSince(killed) < 3)
        #expect(host.restarts == 1)
        // An unexplained exit is not blamed on the plugin.
        #expect(workspace.plugins.plugin("shout")?.enabled == true)

        await workspace.send("hi", to: workspace.mainBot)
        #expect(workspace.mainBot.messages.first?.text == "hi!")
        host.stop()
    }

    @Test func afterReplyNotifyRoutinesAndReplyListeners() async throws {
        try hostPlugin("helper", """
        export function activate(ccb) {
          ccb.hooks.afterReply((m) => m.text + "（已檢查）");
          ccb.bots.onReply(async (bot, reply) => {
            const bots = await ccb.bots.list();
            ccb.notify(`${bot.name} 回了，共 ${bots.length} 個 bot`);
            ccb.storage.set("last", reply);
          });
          ccb.routines.add("main", "0 9 * * 1", "週一備份：把插件庫推到備份資料夾");
        }
        """)
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : "好" }
        let workspace = workspace(fake)
        let host = try #require(workspace.pluginHost)
        #expect(await host.waitUntilReady(timeout: .seconds(10)))
        await eventually({ host.afterReplyHooks == 1 }, timeout: 10)
        await eventually({ workspace.mainBot.routines.contains { $0.task.hasPrefix("週一備份") } }, timeout: 10)

        await workspace.send("嗨", to: workspace.mainBot)
        await eventually({ workspace.mainBot.messages.contains { $0.role == .bot && $0.text == "好（已檢查）" } }, timeout: 10)
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice && $0.text.contains("主 bot 回了，共 2 個 bot") } }, timeout: 10)
        let storage = root.appending(path: "ccb/plugin-data/helper/storage.json")
        await eventually({ (try? String(contentsOf: storage, encoding: .utf8))?.contains("好（已檢查）") == true }, timeout: 10)
        host.stop()
    }

    @Test func aPluginThatFailsToLoadIsTurnedOffAndCommandsRun() async throws {
        try hostPlugin("broken", "export function activate() { throw new Error('壞了'); }")
        try hostPlugin("calc", """
        export function activate(ccb) { ccb.commands.register("calc.double", (n) => (n ?? 21) * 2); }
        """)
        let workspace = workspace(FakeLauncher())
        let host = try #require(workspace.pluginHost)
        await eventually({ workspace.plugins.plugin("broken")?.failure?.contains("壞了") == true }, timeout: 10)
        #expect(workspace.mainBot.messages.contains { $0.text.contains("broken") && $0.text.contains("停用") })
        await eventually({ host.commands == ["calc.double"] }, timeout: 10)
        #expect(try await host.command("calc.double", args: [.number(5)]) == .number(10))
        host.stop()
    }

    @Test func threeCrashesInTenMinutesTurnAPluginOff() throws {
        let folder = root.appending(path: "lib/flaky")
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try #"{ "name": "flaky", "version": "1.0.0", "engines": { "ccb": "^2.0.0" }, "ccb": { "host": "dist/host.mjs" } }"#
            .write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try "export function activate() {}".write(to: folder.appending(path: "dist/host.mjs"), atomically: true, encoding: .utf8)
        let registry = PluginRegistry(library: root.appending(path: "lib"), builtIns: nil)
        let start = Date()
        registry.recordHostFailure("flaky", message: "a", now: start)
        registry.recordHostFailure("flaky", message: "b", now: start.addingTimeInterval(700))
        registry.recordHostFailure("flaky", message: "c", now: start.addingTimeInterval(800))
        #expect(registry.plugin("flaky")?.enabled == true)
        registry.recordHostFailure("flaky", message: "d", now: start.addingTimeInterval(900))
        #expect(registry.plugin("flaky")?.failure == "d")
        #expect(registry.hostSpecs(dataRoot: root).isEmpty)
    }
}
