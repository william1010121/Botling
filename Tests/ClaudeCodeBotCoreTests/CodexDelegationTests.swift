import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexDelegationTests {
    @Test func coordinatorEndsAfterAppAcceptanceAndClaudeKeepsNativeAgents() {
        let root = URL(filePath: "/tmp/delegation-prompt")
        for profile in [BotProfile.main(home: root), .manager(name: "Probe", avatar: "square", folder: root)] {
            let claude = BotPrompts(profile: profile).system
            let codex = BotPrompts(profile: profile, engine: .codex).system
            #expect(codex.contains("app_handoff"))
            #expect(codex.contains("app_send_message with task_id and message"))
            #expect(codex.contains("END YOUR CURRENT TURN"))
            #expect(codex.contains("app_task_result, correlated by task_id"))
            #expect(codex.contains("A user status question does not transfer task ownership"))
            #expect(!codex.contains("invoke the native agent-wait tool"))
            #expect(!codex.contains("use Codex's native subagent tools when delegating"))
            #expect(!codex.contains("then check its work yourself"))
            #expect(claude.contains("; then check its work yourself and say what you found."))
            #expect(!claude.contains("App-owned Codex delegation policy"))
        }
        let manager = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        #expect(BotPrompts(profile: manager).system.contains("to subagents with the Agent tool"))
        #expect(!BotPrompts(profile: manager, engine: .codex).system.contains("to subagents with the Agent tool"))
    }

    @Test func workerGetsExecutionScopeAndProjectContextWithoutCoordinatorRouting() {
        let root = URL(filePath: "/tmp/delegation-prompt")
        var profile = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        profile.instructions = "Preserve the billing API and check quantity validation."
        profile.job = "Maintain the billing project."
        let prompts = BotPrompts(profile: profile, language: .traditionalChinese, engine: .codex)
        let worker = prompts.codexWorkerSystem
        #expect(worker.contains("Execute your assigned scope yourself"))
        #expect(worker.contains("Do not reserve routine validation for the coordinator"))
        #expect(worker.contains(profile.instructions!))
        #expect(worker.contains(profile.job!))
        #expect(worker.contains(root.path))
        #expect(worker.contains(profile.memoryPath))
        #expect(worker.contains(profile.archiveURL.path))
        #expect(worker.contains("Reply in Traditional Chinese (as used in Taiwan) by default"))
        #expect(worker.contains("Never print credentials"))
        #expect(worker.contains(BotPrompts.resultsRule(.localOnly, folder: profile.artifactsURL.path)))
        #expect(!worker.contains("END YOUR CURRENT TURN"))
        #expect(!worker.contains("You are the coordinator"))
        #expect(!worker.contains("Your job is to hand work over"))
        #expect(!worker.contains("end your reply with <handoff"))
        #expect(!worker.contains("<plugin>"))
        #expect(!worker.contains(BotPrompts.codexDelegationPolicy))
    }

    @Test func codexMaintenanceUsesSnapshotsAndWaitsForDurableMemoryEvidence() {
        let root = URL(filePath: "/tmp/delegation-prompt")
        let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        let codex = BotPrompts(profile: profile, engine: .codex)
        let claude = BotPrompts(profile: profile)
        #expect(codex.wake.hasPrefix(BotPrompts.wakeLead))
        #expect(codex.tidy.hasPrefix(BotPrompts.tidyLead))
        #expect(codex.wake.contains("saved memory snapshot"))
        #expect(codex.resume.contains("saved memory snapshot"))
        #expect(codex.wake.contains("Do not start a worker just to read memory"))
        #expect(!codex.wake.contains("Read \(profile.memoryPath) before answering"))
        for maintenance in [codex.tidy, codex.handoff] {
            #expect(maintenance.contains("Use app_handoff"))
            #expect(maintenance.contains("END YOUR CURRENT TURN"))
            #expect(maintenance.contains("app_task_result confirms the update completed"))
            #expect(maintenance.contains("do not claim the memory was saved"))
        }
        #expect(claude.wake.contains("Read \(profile.memoryPath) before answering"))
        #expect(!claude.tidy.contains("app_handoff"))
        #expect(!claude.handoff.contains("app_handoff"))
    }

    @MainActor
    @Test func productionBotLaunchCarriesSeparateCoordinatorAndWorkerInstructions() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-worker-prompts-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        let bot = Bot(profile: profile, launcher: fake.launcher, store: BotStore(directory: root.appending(path: "store")))
        await bot.switchEngine(to: .codex)
        bot.send("Fix billing and test it.")
        await eventually { !fake.agents.isEmpty }
        let launch = try #require(fake.agents.first?.launch)
        #expect(launch.systemPrompt.contains(BotPrompts.codexDelegationPolicy))
        #expect(launch.codexWorkerInstructions == bot.prompts.codexWorkerSystem)
        #expect(launch.codexWorkerInstructions?.contains("Execute your assigned scope yourself") == true)
        #expect(launch.codexWorkerInstructions?.contains(BotPrompts.codexDelegationPolicy) == false)
    }

    @Test func ownershipPolicyReachesDeveloperInstructionsOnStartAndResume() throws {
        let root = URL(filePath: "/tmp/delegation-prompt")
        let instructions = BotPrompts(profile: .manager(name: "Probe", avatar: "square", folder: root), engine: .codex).system
        for resume in [nil, "existing-thread"] as [String?] {
            var config = CodexSession.Config(workingDirectory: root, instructions: instructions)
            config.resumeThread = resume
            var session = CodexSession(config: config)
            _ = session.start()
            let output = session.receive(#"{"id":1,"result":{}}"#)
            let request = try #require(output.compactMap { if case let .write(value) = $0 { value } else { nil } }.last)
            #expect(request["method"] as? String == (resume == nil ? "thread/start" : "thread/resume"))
            let params = try #require(request["params"] as? [String: Any])
            #expect(params["developerInstructions"] as? String == instructions)
            #expect((params["developerInstructions"] as? String)?.contains(BotPrompts.codexDelegationPolicy) == true)
        }
    }

    /// Exports the actual production prompts/RPC payload for an opt-in real Codex probe.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_CODEX_DELEGATION_EXPORT"] != nil))
    func exportActualAppRequestsForLiveProbe() throws {
        let root = URL(filePath: try #require(ProcessInfo.processInfo.environment["CCB_CODEX_DELEGATION_EXPORT"]))
        for name in ["baseline", "status"] {
            let folder = root.appending(path: name)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: folder)
            let prompts = BotPrompts(profile: profile, language: .traditionalChinese, engine: .codex)
            let instructions = prompts.system
            var session = CodexSession(config: .init(workingDirectory: folder, instructions: instructions, workerInstructions: prompts.codexWorkerSystem))
            _ = session.start()
            let output = session.receive(#"{"id":1,"result":{}}"#)
            let request = try #require(output.compactMap { if case let .write(value) = $0 { value } else { nil } }.last)
            #expect(request["method"] as? String == "thread/start")
            try JSONSerialization.data(withJSONObject: request, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appending(path: "thread-start.json"))
            try instructions.write(to: folder.appending(path: "developer-instructions.txt"), atomically: true, encoding: .utf8)
            try prompts.codexWorkerSystem.write(to: folder.appending(path: "worker-instructions.txt"), atomically: true, encoding: .utf8)
        }
    }
}
