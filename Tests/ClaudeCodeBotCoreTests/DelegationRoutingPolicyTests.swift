import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct DelegationRoutingPolicyTests {
    private func prompts(_ engine: BotEngine) -> BotPrompts {
        BotPrompts(profile: .manager(name: "ClaudeCodeBot", avatar: "square", folder: URL(filePath: "/tmp/routing-app")), engine: engine)
    }

    @Test func appSourceAndPluginLibraryHaveDifferentOwners() {
        for engine in BotEngine.allCases {
            let system = prompts(engine).system
            #expect(system.contains("Botling's application source belongs to its project bot"))
            #expect(system.contains("Only plugin-library extensions"))
            #expect(!system.contains("For new features or changed behaviour in ClaudeCodeBot itself (plugins)"))
            #expect(system.contains("<component name="))
            #expect(system.contains("<plugin>what is wanted</plugin>"))
            #expect(system.contains("<install>source</install>"))
        }
    }

    @MainActor
    @Test func projectBriefingDoesNotAdvertiseMaintainerAsAppSourceOwner() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-routing-briefing-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        await workspace.pluginLibraryReady.value
        let briefing = workspace.projectBriefing()
        #expect(briefing.contains("Maintainer (plugin-library extensions and in-chat components only)"))
        #expect(!briefing.contains("looks after ClaudeCodeBot itself"))
        await workspace.putEveryoneToSleep()
    }

    @Test func distinctTasksNeverBecomeSameWorkerFollowups() {
        let system = prompts(.codex).system
        #expect(system.contains("Reuse an existing worker only for a follow-up within the same task"))
        #expect(system.contains("A new independent request gets a separate app_handoff"))
        #expect(system.contains("global model/sidebar settings, routing policy, and a product rename are three distinct scopes"))
        #expect(!system.contains("or change its assigned task, use app_send_message"))
    }

    @Test func isolationAndSequentialIntegrationDoNotSerializeIndependentExecution() {
        let system = prompts(.codex).system
        #expect(system.contains("each source-editing worker its own isolated git worktree and branch"))
        #expect(system.contains("Integrate completed changes sequentially"))
        #expect(system.contains("single writer"))
        #expect(system.contains("Do not dispatch further tools after an acceptance receipt"))
        #expect(system.contains("name the remaining scopes as pending (not accepted)"))
        #expect(!system.contains("all independent app_handoff calls before ending the turn"))
        #expect(system.contains("app_task_result, correlated by task_id"))
    }

    @Test func researchPhaseRemainsLimitedInCoordinatorAndWorkerInstructions() {
        let p = prompts(.codex)
        #expect(p.system.contains("implementation_files=[]"))
        #expect(p.system.contains("file_release_authorizes_implementation=false"))
        #expect(p.system.contains("Do not grant conditional future implementation"))
        #expect(p.codexWorkerSystem.contains("new or non-conflicting files and isolated worktrees"))
        #expect(p.codexWorkerSystem.contains("Require explicit user authorization"))
    }

    @Test func routingPolicyReachesStartAndResumeRPC() throws {
        let instructions = prompts(.codex).system
        for resume in [nil, "routing-existing-thread"] as [String?] {
            var config = CodexSession.Config(workingDirectory: URL(filePath: "/tmp/routing-app"), instructions: instructions)
            config.resumeThread = resume
            var session = CodexSession(config: config)
            _ = session.start()
            let output = session.receive(#"{"id":1,"result":{}}"#)
            let request = try #require(output.compactMap { if case let .write(value) = $0 { value } else { nil } }.last)
            let params = try #require(request["params"] as? [String: Any])
            #expect(params["developerInstructions"] as? String == instructions)
        }
    }

    /// The live probe consumes the generated prompt verbatim, never a hand-written replacement.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_ROUTING_EXPORT"] != nil))
    func exportGeneratedPromptsForBehaviorProbe() throws {
        let root = URL(filePath: try #require(ProcessInfo.processInfo.environment["CCB_ROUTING_EXPORT"]))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try prompts(.codex).system.write(to: root.appending(path: "developer-instructions.txt"), atomically: true, encoding: .utf8)
    }
}
