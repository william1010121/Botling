import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ComponentEditorCapabilityTests {
    @Test func invalidDefinitionNeverSubstitutesToolsOrModelAndIsNotRewritten() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-editor-capability-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appending(path: "ccb-core/claude/agents/component-editor.md")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var parent = AgentLaunch(model: .opus, sessionID: UUID(), workingDirectory: folder, systemPrompt: "maintain")
        parent.componentEditorEnabled = true
        for (model, tools, expected) in [("sonnet", "Read, Write, Agent", "tools outside"),
                                          ("unsupported-model", "Read, Write", "explicit Claude model")] {
            let text = "---\nname: component-editor\nmodel: \(model)\ntools: \(tools)\n---\nKept custom definition.\n"
            try text.write(to: file, atomically: true, encoding: .utf8)
            let before = try Data(contentsOf: file)
            let route = try #require(ComponentEditorRoute.load(for: parent))
            guard case let .unavailable(reason) = route else { Issue.record("Invalid definition was accepted"); return }
            #expect(reason.contains(expected))
            #expect(try Data(contentsOf: file) == before)
        }
        try FileManager.default.removeItem(at: file)
        guard case let .unavailable(reason) = ComponentEditorRoute.load(for: parent) else { Issue.record("Missing definition was accepted"); return }
        #expect(reason.contains(file.path))
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @MainActor
    @Test func childRuntimeShowsClaudeWhileOwnershipRemainsWithCodexMaintainer() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-editor-owner-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let fake = FakeLauncher(); fake.respond = { _ in nil }
        let store = BotStore(directory: folder.appending(path: "store")); store.save(engine: .codex)
        let bot = Bot(profile: .maintainer(folder: folder, instructions: "Never edit templates yourself"), launcher: fake.launcher, store: store)
        defer { bot.stop() }
        bot.send("Authorized change")
        await eventually { !fake.agents.isEmpty }
        let agent = try #require(fake.agents.first)
        #expect(agent.launch.componentEditorEnabled)
        #expect(agent.launch.systemPrompt.contains("role=\"component-editor\""))
        #expect(!agent.launch.codexWorkerInstructions!.contains(ComponentEditorRoute.coordinatorRule))
        agent.emit(.trace(.subagentStarted(id: "editor", description: "Authorized edit", type: "ccb-core:component-editor", prompt: "edit and check", background: true)))
        agent.emit(.trace(.subagentModel(id: "editor", model: "haiku")))
        agent.emit(.trace(.subagentRuntime(id: "editor", runtime: .init(engine: .claude))))
        await eventually { bot.subagent("editor")?.runtime?.engine == .claude }
        let editor = try #require(bot.subagent("editor"))
        let payload = ChatPayload.make(subagent: editor, of: bot, components: nil, avatar: "")
        #expect(payload.subagent?.engine == "claude")
        #expect(payload.subagent?.model == "Haiku")
        #expect(bot.subagentOwnerMark("editor") == .codex)
        let encoded = try JSONEncoder().encode(editor)
        #expect(try JSONDecoder().decode(Subagent.self, from: encoded).runtime?.engine == .claude)
    }
}
