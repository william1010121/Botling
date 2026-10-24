import CryptoKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexReportPromptTests {
    /// Full Claude prompts from all roles/settings, including the accepted routine instructions.
    private func claudeSnapshots() -> [String: String] {
        let root = URL(filePath: "/tmp/codex-report-prompt-baseline")
        let profiles: [BotProfile] = [
            .main(home: root), .manager(name: "Probe", avatar: "square", folder: root),
            .standalone(name: "Probe", avatar: "square", folder: root, job: "Review reports."),
            .maintainer(folder: root, instructions: "Keep project assets local.")
        ]
        var snapshots: [String: String] = [:]
        for (index, profile) in profiles.enumerated() {
            for publishing in ResultPublishing.allCases {
                for language in [AppLanguage.english, .traditionalChinese] {
                    for dual in [false, true] {
                        let heads: HeadsSettings? = dual ? .init(engines: [.claude, .codex]) : nil
                        let prompts = BotPrompts(profile: profile, results: publishing,
                            language: language, engine: .claude, heads: heads)
                        let fields = ["system": prompts.system, "headsRule": prompts.headsRule,
                            "wake": prompts.wake, "tidy": prompts.tidy,
                            "handoff": prompts.handoff, "resume": prompts.resume]
                        for (field, value) in fields {
                            snapshots["\(index)/\(publishing.rawValue)/\(language.rawValue)/\(dual)/\(field)"] = value
                        }
                    }
                }
            }
        }
        return snapshots
    }

    private func claudeDigest() throws -> String {
        let data = try JSONSerialization.data(withJSONObject: claudeSnapshots(), options: [.sortedKeys])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    @Test func allDeliveredClaudePromptsMatchRoutineAwareBaseline() throws {
        #expect(claudeSnapshots().count == 288)
        // Updated for be8bf867's intentional routine instructions. Restoring only that passage
        // reproduces the original d2b2d8c digest; the other 240 prompt fields are unchanged.
        // SHA-256 of sorted-key JSON containing all 288 complete prompt strings.
        #expect(try claudeDigest() == "1f3fd24a0cf8917e3f7a2d52e828e418d8041b711b9d5723ecc33f8552439d36")
    }

    private func expectReportRules(_ instructions: String, folder: String) {
        #expect(instructions.contains(BotPrompts.codexLocalReportRule(folder: folder)))
        // Check the safety/acceptance clauses, independently of the interpolation above.
        for clause in ["a single file with its styles inline", "<!doctype html><meta charset=\"utf-8\">",
            "original image/animation bytes", "correct MIME type", "data URI",
            "Do not use file:// URLs or temporary worktree paths as HTML subresources",
            "Standalone images/videos in chat still use file:// links",
            "production PagePreview/WKWebView through ccb-preview:", "every img",
            "naturalWidth > 0", "rendered screenshots", "inspect them yourself",
            "File existence or opening the HTML directly via file:// is not display acceptance",
            "preserve all frames", "multiple distinct decoded frames over time", "not only the first frame",
            "traceable original", "fabricate replacement images", "disclose that limitation"] {
            #expect(instructions.contains(clause), "Missing report rule: \(clause)")
        }
        #expect(instructions.contains(folder + "/<english-file-name>.html"))
    }

    @Test func coordinatorAndWorkerGetTheSameReportContractAcrossSettings() {
        let root = URL(filePath: "/tmp/codex-report-contract")
        let profiles: [BotProfile] = [.main(home: root), .manager(name: "Probe", avatar: "square", folder: root),
            .standalone(name: "Probe", avatar: "square", folder: root, job: "Review reports."),
            .maintainer(folder: root, instructions: "Keep project assets local.")]
        for profile in profiles {
            for publishing in ResultPublishing.allCases {
                for language in [AppLanguage.english, .traditionalChinese] {
                    let prompts = BotPrompts(profile: profile, results: publishing, language: language, engine: .codex)
                    expectReportRules(prompts.system, folder: profile.artifactsURL.path)
                    expectReportRules(prompts.codexWorkerSystem, folder: profile.artifactsURL.path)
                }
            }
        }
    }

    @MainActor @Test func productionLaunchPassesRulesToCodexAndLeavesClaudeUntouched() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-report-launch-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        for engine in BotEngine.allCases {
            let folder = root.appending(path: engine.rawValue)
            let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: folder)
            let fake = FakeLauncher()
            fake.respond = { _ in nil }
            let bot = Bot(profile: profile, launcher: fake.launcher, store: BotStore(directory: folder.appending(path: "store")))
            defer { bot.stop() }
            if engine == .codex { await bot.switchEngine(to: .codex) }
            bot.send("Prepare the local report.")
            await eventually { !fake.agents.isEmpty }
            let launch = try #require(fake.agents.first?.launch)
            if engine == .codex {
                expectReportRules(launch.systemPrompt, folder: profile.artifactsURL.path)
                expectReportRules(try #require(launch.codexWorkerInstructions), folder: profile.artifactsURL.path)
                let config = try CodexAgentProcess.config(for: launch, threads: CodexThreads(folder: folder.appending(path: "threads")))
                #expect(config.instructions == launch.systemPrompt)
                #expect(config.workerInstructions == launch.codexWorkerInstructions)
            } else {
                #expect(launch.codexWorkerInstructions == nil)
                #expect(launch.systemPrompt == bot.prompts.system)
                #expect(!launch.systemPrompt.contains("Local HTML report image rules"))
            }
        }
    }

    @Test func coordinatorStartAndResumeRPCIncludeReportRules() throws {
        let root = URL(filePath: "/tmp/codex-report-rpc")
        let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        let prompts = BotPrompts(profile: profile, engine: .codex)
        for resumed in [false, true] {
            var config = CodexSession.Config(workingDirectory: root, instructions: prompts.system, workerInstructions: prompts.codexWorkerSystem)
            if resumed { config.resumeThread = "existing-coordinator" }
            var session = CodexSession(config: config)
            let initialize = try #require(CodexSessionTests.Out(session.start()).writes.first)
            let output = try reply(to: initialize, result: [:], session: &session)
            let params = try #require(output.params(resumed ? "thread/resume" : "thread/start"))
            expectReportRules(try #require(params["developerInstructions"] as? String), folder: profile.artifactsURL.path)
        }
    }

    @Test func managedWorkerThreadRPCIncludesReportRules() throws {
        let root = URL(filePath: "/tmp/codex-report-rpc")
        let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        let prompts = BotPrompts(profile: profile, engine: .codex)
        var session = CodexSession(config: .init(workingDirectory: root, instructions: prompts.system, workerInstructions: prompts.codexWorkerSystem))
        let initialize = try #require(CodexSessionTests.Out(session.start()).writes.first)
        let started = try reply(to: initialize, result: [:], session: &session)
        let start = try #require(started.writes.first { $0["method"] as? String == "thread/start" })
        _ = try reply(to: start, result: ["thread": ["id": "coordinator"]], session: &session)
        let turn = try #require(CodexSessionTests.Out(session.send(.init(text: "Prepare report"))).writes.first { $0["method"] as? String == "turn/start" })
        _ = try reply(to: turn, result: ["turn": ["id": "report-turn"]], session: &session)
        let call: [String: Any] = ["method": "item/tool/call", "id": 100, "params": ["threadId": "coordinator", "turnId": "report-turn", "callId": "report-call", "tool": "app_handoff", "arguments": ["instructions": "Prepare and verify the assigned HTML report.", "name": "report"]]]
        let output = CodexSessionTests.Out(session.receive(String(decoding: try JSONSerialization.data(withJSONObject: call), as: UTF8.self)))
        let params = try #require(output.params("thread/start"))
        let instructions = try #require(params["developerInstructions"] as? String)
        #expect(instructions == prompts.codexWorkerSystem)
        expectReportRules(instructions, folder: profile.artifactsURL.path)
    }

    private func reply(to request: [String: Any], result: [String: Any], session: inout CodexSession) throws -> CodexSessionTests.Out {
        let response: [String: Any] = ["id": try #require(request["id"]), "result": result]
        return CodexSessionTests.Out(session.receive(String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self)))
    }
}
