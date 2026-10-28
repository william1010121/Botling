import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A Claude subagent never reports its effort: its header names the parent's, marked inherited.
@MainActor
struct SubagentEffortInheritTests {
    private func header(effort: EffortLevel?, reported: String? = nil, type: String = "general-purpose") throws -> ChatPayload.SubagentHeader {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-effort-\(UUID().uuidString)")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: .claude)
        if let effort { store.save(effort: effort) }
        var agent = Subagent(id: "a1", description: "Research", type: type, prompt: "x", status: .running)
        if let reported { agent.runtime = WorkerRuntimeInfo(reasoningEffort: reported) }
        store.save(subagents: [agent])
        let bot = Bot(profile: .main(home: root), launcher: FakeLauncher().launcher, store: store)
        let sub = try #require(bot.subagent("a1"))
        return try #require(ChatPayload.make(subagent: sub, of: bot, components: nil, avatar: "").subagent)
    }

    @Test func unreportedEffortIsTheParentsMarkedInherited() throws {
        let h = try header(effort: .high)
        #expect(h.inheritedEffort == "high")
    }

    @Test func aReportedEffortWinsAndIsNotMarked() throws {
        #expect(try header(effort: .high, reported: "low").inheritedEffort == nil)
    }

    @Test func noParentEffortStaysUnknown() throws {
        #expect(try header(effort: nil).inheritedEffort == nil)
    }
}
