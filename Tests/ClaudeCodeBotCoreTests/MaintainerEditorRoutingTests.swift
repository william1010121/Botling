import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct MaintainerEditorRoutingTests {
    @MainActor
    @Test func authorizedComponentChangeReachesEditorRatherThanGenericMaintainerWorker() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-editor-routing-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let editorFile = Workspace.componentEditorFile(in: folder)
        try FileManager.default.createDirectory(at: editorFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Workspace.componentEditorAgent(model: .haiku).write(to: editorFile, atomically: true, encoding: .utf8)
        let fake = FakeLauncher()
        let boundary = "Never edit template.html or about.md yourself: every component request goes to a ccb-core:component-editor agent with the Agent tool."
        let bot = Bot(profile: .maintainer(folder: folder, instructions: boundary), launcher: fake.launcher,
                      store: BotStore(directory: folder.appending(path: "store")))
        await bot.switchEngine(to: .codex)
        bot.send("The user authorized changing token-speed; use its component editor.")
        await eventually { !fake.agents.isEmpty }
        let launch = try #require(fake.agents.first?.launch)
        let config = try CodexAgentProcess.config(for: launch, threads: CodexThreads(folder: folder.appending(path: "threads")))
        var session = CodexSession(config: config)
        let h = CodexManagedWorkerTests()
        let initialize = CodexSessionTests.Out(session.start()).writes[0]
        let start = h.response(initialize, [:], &session)
        let coordinator = h.write(start, "thread/start")
        let params = try #require(coordinator["params"] as? [String: Any])
        let tools = try #require(params["dynamicTools"] as? [[String: Any]])
        let handoff = try #require(tools.first { $0["name"] as? String == "app_handoff" })
        let schema = try #require(handoff["inputSchema"] as? [String: Any])
        let properties = try #require(schema["properties"] as? [String: Any])
        let role = try #require(properties["role"] as? [String: Any])
        #expect(role["enum"] as? [String] == ["component-editor"])
        _ = h.response(coordinator, ["thread": ["id": "root"]], &session)
        h.rootTurn(&session)
        let out = h.tool(100, arguments: ["instructions": "Authorized component change: inspect the supplied screenshot, change token-speed in an isolated worktree, test and return evidence. No release.",
                                         "name": "token-speed", "role": "component-editor"], &session)
        let types = out.traces.compactMap { event -> String? in
            if case let .subagentStarted(_, _, type, _, _) = event { return type }
            return nil
        }
        #expect(types == ["ccb-core:component-editor"])
        guard case let .start(_, _, editor, _) = try #require(out.editors.first) else {
            Issue.record("Missing concrete Claude editor launch")
            return
        }
        #expect(editor.engine == .claude)
        #expect(editor.model == .haiku)
        #expect(editor.systemPrompt.contains(ComponentPrompts.system))
        #expect(!editor.systemPrompt.contains(boundary))
        #expect(editor.systemPrompt.contains("Do not delegate"))
        #expect(editor.restrictedTools == ["Read", "Write", "Edit", "Bash"])

        // A component editor must use its configured Claude role, never a generic Codex thread.
        #expect(!out.writes.contains { $0["method"] as? String == "thread/start" })
    }
}
