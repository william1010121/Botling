import CryptoKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ClaudePromptCompatibilityTests {
    /// Frozen against accepted routine/monitor production c9441eee. The intentional routine
    /// passage changes only the eight system strings; the other 40 original digests remain.
    /// Independent pre-routine/accepted-source probes establish this fixture provenance.
    /// Updated for 1.20's two intentional prompt lines: task cards (the `<task …/>` line) and
    /// bot-to-bot @ delivery (a line starting with @ and another bot's name). Together they
    /// change only the eight system strings; every other digest is unchanged.
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
        "system" : "ba7308a7f3bda80bfffb4df21e8ebce4489c36327b3605682769530c78f9c640",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-en-true" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "8922ce65f32179dd1f2dc3a73a17558819646cd1ae5e60b4bcd13c3c1094a5c8",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-zh-Hant-false" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "dbc6c8242f98f6dcca37ac244cd5d1bcd76b8d36e9f4b6d57649447d61f4a5fd",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-zh-Hant-true" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "eca31d8a4f779c3b67a8c6132c1b7b9581f180c30443f884f73a663324eeeb83",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "1-en-false" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "b1f0939f61a7d768e3bf0b3fa9bad158b42675a59a78586ef43e75758e4c3d1d",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-en-true" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "7184b7be3ed96bdef2029d1ac963f0fed4985b0bf21a414adb385a463788a237",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-zh-Hant-false" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "3e482637a580b7bf3431b510360f6e084f6ecb0a7ad18935b702baf10b2eff82",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-zh-Hant-true" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "65ebede6f10ee6474c49999c90a12e60b7dc5c5ff66d427711dd620e3efb7b36",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "26b05f87805256df78c2e5665edfa78425645018689531ce95fce8cf9119dbfc",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      }
    }
    """#

}
