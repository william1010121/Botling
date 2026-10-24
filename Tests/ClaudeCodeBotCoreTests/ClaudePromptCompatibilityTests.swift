import CryptoKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ClaudePromptCompatibilityTests {
    /// Frozen against accepted routine/monitor production c9441eee. The intentional routine
    /// passage changes only the eight system strings; the other 40 original digests remain.
    /// Independent pre-routine/accepted-source probes establish this fixture provenance.
    func snapshots() -> [String: [String: String]] {
        let root = URL(filePath: "/tmp/claude-dispatch-compatibility")
        var profiles = [BotProfile.main(home: root), .manager(name: "Probe", avatar: "square", folder: root)]
        profiles[1].instructions = "Keep the project's billing API stable."
        var all: [String: [String: String]] = [:]
        for (index, profile) in profiles.enumerated() {
            for language in [AppLanguage.english, .traditionalChinese] {
                for dual in [false, true] {
                    let heads: HeadsSettings? = dual ? .init(engines: [.claude, .codex]) : nil
                    let p = BotPrompts(profile: profile, language: language, engine: .claude, heads: heads)
                    let values = ["system": p.system, "headsRule": p.headsRule, "wake": p.wake,
                        "tidy": p.tidy, "handoff": p.handoff, "resume": p.resume]
                    all["\(index)-\(language.rawValue)-\(dual)"] = values.mapValues {
                        SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined()
                    }
                }
            }
        }
        return all
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_CLAUDE_BASELINE_EXPORT"] != nil))
    func exportUnmodifiedClaudeBaseline() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_CLAUDE_BASELINE_EXPORT"])
        try JSONSerialization.data(withJSONObject: snapshots(), options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(filePath: path))
    }

    @Test func claudeKeepsNativeDelegationAndNoCodexPolicy() {
        let root = URL(filePath: "/tmp/claude-dispatch-compatibility")
        let p = BotPrompts(profile: .manager(name: "Probe", avatar: "square", folder: root), engine: .claude)
        #expect(p.system.contains("hand real work (building, fixing, researching, anything longer than a few quick reads) to subagents with the Agent tool"))
        for value in [p.system, p.wake, p.tidy, p.handoff, p.resume] {
            #expect(!value.contains("app_handoff"))
            #expect(!value.contains("app_task_checkpoint"))
            #expect(!value.contains("App-owned Codex delegation policy"))
            #expect(!value.contains(BotPrompts.codexDelegationPolicy))
        }
    }

    @MainActor @Test func claudeLaunchNeverReceivesCodexWorkerInstructions() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-claude-dispatch-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = Bot(profile: .manager(name: "Probe", avatar: "square", folder: root),
            launcher: fake.launcher, store: BotStore(directory: root.appending(path: "store")))
        defer { bot.stop() }
        bot.send("Research with your native agents")
        await eventually { !fake.agents.isEmpty }
        let agent = try #require(fake.agents.first)
        #expect(agent.launch.engine == .claude)
        #expect(agent.launch.codexWorkerInstructions == nil)
        #expect(!agent.launch.systemPrompt.contains("app_handoff"))
        agent.emit(.trace(.subagentStarted(id: "native-agent", description: "Research", type: "general-purpose", prompt: "Research", background: true)))
        agent.reply("Research assigned to the native agent.")
        await eventually { !bot.isWorking && bot.trace.subagent("native-agent")?.isRunning == true }
        #expect(!agent.finished)
        #expect(!agent.sent.contains { $0.contains("app_task_checkpoint") || $0.contains("app_task_result") })
    }

    @Test func allClaudePromptStringsMatchAcceptedRoutineBaseline() throws {
        let expected = try JSONDecoder().decode([String: [String: String]].self, from: Data(Self.baseline.utf8))
        #expect(expected.count == 8)
        #expect(snapshots() == expected)
    }

    private static let baseline = #"""
    {
      "0-en-false" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "cbbfa9f399f34f181ec41e0c61ee361b3f849f8634a2d47f29da9559f68e35f7",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-en-true" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "3c2ac340c56c6d738847959d6ff0a8833a5f34730ebf3fc2819c4caf6a2ed15e",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-zh-Hant-false" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "fa44df6e27bcff3a68ea66e3a682612066acd3d8efa90b585e1f172132e4c52f",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-zh-Hant-true" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "3136c69f408805f774559aa02a6fcee44f825f136b1085c9df4cd57210095ab5",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "1-en-false" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "1b2425c85dc15420c5c0c1ecea6c9a8039270995b6554616d83572d4c9bba738",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-en-true" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "ff088115acd26645d6843f37ea17ad1c5765df7f3eb048e698376ff1b400f5c2",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-zh-Hant-false" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "e0b9d117ff0a72f44a7a43084afce111213b9789d540991c7760292590bc6226",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-zh-Hant-true" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "9de755826fbf53b229dca80adf0a1a557923852fe07a7b0932173ecd8caeace3",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      }
    }
    """#

}
