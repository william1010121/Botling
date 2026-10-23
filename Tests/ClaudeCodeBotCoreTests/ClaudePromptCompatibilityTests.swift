import CryptoKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ClaudePromptCompatibilityTests {
    /// Captured from unchanged production d2b2d8ced63173933c2156f703badc769e2c12b8
    /// before modifying any production source. Each digest covers the complete string.
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

    @Test func allClaudePromptStringsMatchFrozenPreChangeBaseline() throws {
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
        "system" : "129fedff6b79aae6bb01b7e9c1f5906d87da719817f64bf7b0a57e2f49505209",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-en-true" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "d6e3c4ab9849bcc7a2a358fe4a97bfaa88c76b590d62cf3e272597d03e795e31",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "0f27071421606c61afdd5b5c5ebca38bdc1da13d61e07eb5053598911e4ec573",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-zh-Hant-false" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "a973c59977789c1c586b69aba8fd87e3e8c15322c47f536f4ebcac8400cfe6cf",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "0-zh-Hant-true" : {
        "handoff" : "7282be28fe401a5fd334f61213c92b4aa7ded98d6dfc62cda9e4267adfbf6bea",
        "headsRule" : "d6e3c4ab9849bcc7a2a358fe4a97bfaa88c76b590d62cf3e272597d03e795e31",
        "resume" : "189c966ded904e46cc5952761b61945dca0ab0c144fc8c059804944eaff48ad3",
        "system" : "3af878b91a7942a4bcdb3d198ceb018a79fa7d7f7cecfdaece79ff0250a3e87b",
        "tidy" : "22764c9d3a10d735ae474753bfac7983df08e82043b64ebeb5cb02ca4ba623aa",
        "wake" : "7a4d72b1d04753a92b4e6405b02213eda564fa3bdee623504e650a63018f86a1"
      },
      "1-en-false" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "92c8708ec134ab8c5d8220548462c4459d87f916259f7ae249134a21d77e3429",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-en-true" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "d6e3c4ab9849bcc7a2a358fe4a97bfaa88c76b590d62cf3e272597d03e795e31",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "ebfa30d0ec8fd58912343e1140d48b910a3a077ad14bf19b29029b2ded63ff06",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-zh-Hant-false" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "2178afdf2de34aa3ec02bc80e1ddf0138b09929c4c1d4b74222f971c5b96fe84",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      },
      "1-zh-Hant-true" : {
        "handoff" : "a75a0d72f7b216d909a94dd827ae28bd01619b5c941317502e0bed4cf09e5497",
        "headsRule" : "d6e3c4ab9849bcc7a2a358fe4a97bfaa88c76b590d62cf3e272597d03e795e31",
        "resume" : "09c9ec7c739ec7342e676d013a19381b6563c0009945712e53a8e794cfcc3a7d",
        "system" : "86377ae958dc0b317851d4d8de9a3e165fd64c42a3d417e947e4b050c1a0935d",
        "tidy" : "e861a38d593c2e95bef2e482f6217fd5e589615c3d7c3da682fe82cc2775eba5",
        "wake" : "10197a0bed41df72bab812cd17c16464bca122f62713f585817b74ee2a413182"
      }
    }
    """#

}
