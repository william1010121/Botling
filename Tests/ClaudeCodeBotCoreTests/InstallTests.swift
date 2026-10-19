import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// P7: plugins from outside — fetched, checked, and installed only after the user says so.
@MainActor
@Suite(.enabled(if: PluginLibraryGit.locate() != nil, "needs git"))
struct InstallTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-install-\(UUID().uuidString)")

    /// A plugin with an MCP server and a secret, as a git repo at file://…
    func numberPluginRepo() async throws -> URL {
        let repo = root.appending(path: "src/ccb-number")
        let claude = repo.appending(path: "claude")
        try FileManager.default.createDirectory(at: claude.appending(path: ".claude-plugin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: claude.appending(path: "server"), withIntermediateDirectories: true)
        try #"{ "name": "ccb-number", "version": "1.0.0", "description": "test", "author": { "name": "ClaudeCodeBot" } }"#
            .write(to: claude.appending(path: ".claude-plugin/plugin.json"), atomically: true, encoding: .utf8)
        try #"{ "mcpServers": { "numbers": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server/server.mjs"], "env": { "NUMBER_SALT": "${CCB_NUMBER_SALT}" } } } }"#
            .write(to: claude.appending(path: ".mcp.json"), atomically: true, encoding: .utf8)
        try Self.server.write(to: claude.appending(path: "server/server.mjs"), atomically: true, encoding: .utf8)
        try """
        { "name": "ccb-number", "displayName": "秘密數字", "version": "1.0.0", "description": "給 bot 一個查秘密數字的工具。",
          "license": "MIT", "author": "Tester", "engines": { "ccb": "^2.0.0" },
          "ccb": { "permissions": ["claude", "network"], "claude": "claude",
            "contributes": { "settings": { "number.salt": { "type": "string", "title": "鹽", "secret": true, "env": "CCB_NUMBER_SALT" } } } } }
        """.write(to: repo.appending(path: "package.json"), atomically: true, encoding: .utf8)
        let git = PluginLibraryGit(folder: repo)
        await blocking {
            git.run(["init", "-q"])
            git.run(["add", "-A"])
            git.run(["commit", "-q", "-m", "init"])
        }
        return repo
    }

    static let server = """
    import { createInterface } from "node:readline";
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "numbers", version: "1.0.0" } } });
      else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "secret_number", description: "Returns the ClaudeCodeBot secret number.", inputSchema: { type: "object", properties: {} } }] } });
      else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "The secret number is " + (4242 + Number(process.env.NUMBER_SALT || 0)) }] } });
      else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    });
    """

    func workspace(_ fake: FakeLauncher, secrets: SecretStore = MemorySecretStore()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), secrets: secrets, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func sourcesAreRecognised() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        #expect(PluginInstaller.classify(root.path) == .folder(root))
        #expect(PluginInstaller.classify("https://github.com/someone/ccb-x") == .git("https://github.com/someone/ccb-x"))
        #expect(PluginInstaller.classify("git@github.com:someone/ccb-x.git") == .git("git@github.com:someone/ccb-x.git"))
        #expect(PluginInstaller.classify("ccb-mermaid") == .npm("ccb-mermaid"))
        #expect(PluginInstaller.classify("@someone/ccb-x@1.2.0") == .npm("@someone/ccb-x@1.2.0"))
        #expect(PluginInstaller.classify("https://example.com/p.zip") == .archive(URL(string: "https://example.com/p.zip")!))
        #expect(PluginInstaller.classify("not a source!") == nil)
    }

    @Test func aGitPluginIsInstalledOnlyAfterYouSayYes() async throws {
        let repo = try await numberPluginRepo()
        let fake = FakeLauncher()
        let secrets = MemorySecretStore()
        let workspace = workspace(fake, secrets: secrets)
        await workspace.pluginLibraryReady.value

        let source = "file://\(repo.path)"
        #expect(await workspace.proposeInstall(source) == nil)
        let card = try #require(workspace.mainBot.messages.last { $0.role == .notice && $0.isOpenQuestion })
        print(card.text)
        #expect(card.text.contains("秘密數字"))
        #expect(card.text.contains("來源：\(source)"))
        #expect(card.text.contains("作者：Tester；授權：MIT"))
        #expect(card.text.contains("給 bot 新的工具") && card.text.contains("連上網路"))
        #expect(card.text.contains("MCP）：numbers"))
        #expect(workspace.plugins.plugin("ccb-number") == nil)

        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        await eventually { workspace.plugins.plugin("ccb-number") != nil }
        let plugin = try #require(workspace.plugins.plugin("ccb-number"))
        #expect(plugin.installedFrom == source)
        #expect(workspace.mainBot.messages.last?.text.hasPrefix("裝好了：秘密數字 1.0.0") == true)
        #expect(workspace.plugins.git.run(["log", "-1", "--format=%s"]).output.hasPrefix("安裝 ccb-number 1.0.0"))
        #expect(!FileManager.default.fileExists(atPath: plugin.folder.appending(path: ".git").path))

        // Its MCP tools are allowed and its secret reaches bots as an environment variable.
        await eventually { workspace.plugins.claudeTools() == ["mcp__plugin_ccb-number_numbers"] }
        workspace.plugins.setSecret("ccb-number", "number.salt", to: "1")
        #expect(secrets.get(plugin: "ccb-number", key: "number.salt") == "1")
        let saved = try String(contentsOf: root.appending(path: "ccb/plugins.json"), encoding: .utf8)
        #expect(!saved.contains("number.salt"))
        let project = workspace.addProject(folder: root.appending(path: "garden"))
        workspace.bot(for: project)?.send("用工具")
        await eventually { fake.agents.count == 1 }
        let launch = fake.agents[0].launch
        #expect(launch.pluginTools == ["mcp__plugin_ccb-number_numbers"])
        #expect(launch.environment["CCB_NUMBER_SALT"] == "1")
        #expect(ClaudeAgentProcess.arguments(for: launch).joined(separator: " ").contains("mcp__plugin_ccb-number_numbers"))
        await workspace.putEveryoneToSleep()
    }

    @Test func sayingNoInstallsNothingAndTagsAlwaysAsk() async throws {
        let repo = try await numberPluginRepo()
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("幫我裝那個插件") ? "好，先給你看。\n<install>file://\(repo.path)</install>" : "收到"
        }
        let workspace = workspace(fake)
        await workspace.pluginLibraryReady.value
        workspace.mainBot.send("幫我裝那個插件")
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion } }, timeout: 10)
        let card = try #require(workspace.mainBot.messages.last { $0.role == .notice && $0.isOpenQuestion })
        #expect(workspace.choose(1, in: card.id, of: workspace.mainBot))
        try await Task.sleep(for: .milliseconds(200))
        #expect(workspace.plugins.plugin("ccb-number") == nil)
        #expect(!FileManager.default.fileExists(atPath: root.appending(path: "ccb/plugins/ccb-number").path))
        await workspace.putEveryoneToSleep()
    }

    @Test func aFolderYouPickIsTrustedAndBrokenOnesAreRefused() async throws {
        let repo = try await numberPluginRepo()
        let workspace = workspace(FakeLauncher())
        await workspace.pluginLibraryReady.value
        #expect(await workspace.proposeInstall(repo.path, trusted: true) == nil)
        #expect(workspace.plugins.plugin("ccb-number")?.installedFrom == repo.path)
        #expect(!workspace.mainBot.messages.contains { $0.isOpenQuestion })

        let broken = root.appending(path: "src/broken")
        try FileManager.default.createDirectory(at: broken, withIntermediateDirectories: true)
        try #"{ "name": "broken", "version": "1.0.0", "engines": { "ccb": "^9.0.0" } }"#
            .write(to: broken.appending(path: "package.json"), atomically: true, encoding: .utf8)
        #expect(await workspace.proposeInstall(broken.path) != nil)
        #expect(workspace.mainBot.messages.last?.text.contains("沒通過檢查") == true)
        #expect(workspace.plugins.plugin("broken") == nil)
    }
}
