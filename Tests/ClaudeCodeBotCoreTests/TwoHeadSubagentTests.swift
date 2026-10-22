import Combine
import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct TwoHeadSubagentTests {
    @Test func aPartnersLiveTeamCanBeListedViewedAndSettledFromTheSharedChat() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-team-\(UUID().uuidString)")
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let bot = workspace.mainBot
        await bot.setHeads([.claude, .codex])
        bot.send("Research this", to: .codex)
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        let partner = try #require(bot.partner)
        var changes = 0
        let watch = bot.objectWillChange.sink { changes += 1 }
        defer { watch.cancel(); bot.stop(); partner.stop() }
        let before = changes
        codex.emit(.trace(.subagentStarted(id: "codex-team", description: "Check protocol", type: "codex", prompt: "Research", background: true)))
        codex.emit(.trace(.toolUse(id: "read", tool: "Bash", title: "Read protocol", detail: "pwd", parent: "codex-team")))
        codex.emit(.trace(.text("Found the event shape", parent: "codex-team")))
        await eventually { partner.trace.subagent("codex-team")?.steps.count == 2 }
        #expect(changes > before)
        #expect(bot.subagents.map(\.id) == ["codex-team"])
        #expect(bot.subagentTrace.listed().map(\.id) == ["codex-team"])
        #expect(bot.trace.subagents.isEmpty)
        #expect(bot.phase == .asleep)
        workspace.view(subagent: "codex-team", of: bot)
        #expect(workspace.viewingSubagent == "codex-team")
        let card = ChatPayload.stepView(Step(id: "codex-team", kind: .subagent, title: "Research"), in: bot)
        #expect(card.title == "Check protocol")
        #expect(card.status == "running")
        #expect(card.count == 1)
        let payload = ChatPayload.make(subagent: try #require(bot.subagent("codex-team")), of: bot, components: nil, avatar: "")
        #expect(payload.subagent?.engine == "codex")
        bot.settleSubagent("codex-team")
        #expect(partner.trace.subagent("codex-team")?.isSettled == true)
        #expect(bot.subagentTrace.listed().isEmpty)
        #expect(bot.subagentTrace.settled.map(\.id) == ["codex-team"])
        #expect(partner.trace.subagent("codex-team")?.isRunning == true)
        bot.unsettleSubagent("codex-team")
        #expect(partner.trace.subagent("codex-team")?.isSettled == false)
        #expect(bot.subagentTrace.settled.isEmpty)
        codex.emit(.trace(.subagentEnded(id: "codex-team", status: "completed", summary: "Protocol verified")))
        await eventually { partner.trace.subagent("codex-team")?.status == .completed }
        #expect(bot.subagents.first?.result == "Protocol verified")
        #expect(bot.subagent("codex-team")?.steps.count == 2)
        let partnerStore = BotStore(directory: Workspace.Layout.mainBot(in: root).appending(path: "partner-codex"))
        #expect(partnerStore.loadSubagents().first?.result == "Protocol verified")
        #expect(BotStore(directory: Workspace.Layout.mainBot(in: root)).loadSubagents().isEmpty)
    }

    @Test(arguments: BotEngine.allCases)
    func savedPartnerTeamsLoadAndSettleWithoutLaunchingEitherHead(_ engine: BotEngine) throws {
        let fake = FakeLauncher()
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-saved-team-\(UUID().uuidString)")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: engine)
        store.save(heads: HeadsSettings(engines: [.claude, .codex]))
        let other = try #require(BotEngine.allCases.first { $0 != engine })
        let partnerStore = BotStore(directory: store.directory.appending(path: "partner-\(other.rawValue)"))
        var own = Subagent(id: "own-team", description: "Own team", type: engine.rawValue, prompt: "Research", status: .completed)
        own.endedAt = Date()
        store.save(subagents: [own])
        // The subtype is not an engine label: ownership comes from its actual head/store.
        partnerStore.save(subagents: [Subagent(id: "saved-team", description: "Partner team", type: "reviewer", prompt: "Research")])
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        #expect(bot.partner == nil && fake.agents.isEmpty)
        #expect(Set(bot.subagents.map(\.id)) == ["own-team", "saved-team"])
        #expect(bot.subagents.first { $0.id == "saved-team" }?.status == .stopped)
        #expect(bot.trace.subagents.map(\.id) == ["own-team"])
        let payload = ChatPayload.make(subagent: try #require(bot.subagent("saved-team")), of: bot, components: nil, avatar: "")
        #expect(payload.subagent?.engine == other.rawValue)
        bot.settleSubagent("saved-team")
        #expect(partnerStore.loadSubagents().first?.isSettled == true)
        #expect(bot.subagentTrace.settled.map(\.id) == ["saved-team"])
        let reopened = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        #expect(reopened.subagents.first { $0.id == "saved-team" }?.isSettled == true)
        reopened.unsettleSubagent("saved-team")
        #expect(partnerStore.loadSubagents().first?.isSettled == false)
        #expect(reopened.subagentTrace.settled.isEmpty)
        #expect(reopened.partner == nil && fake.agents.isEmpty)
        #expect(store.loadSubagents().map(\.id) == ["own-team"])
    }
}
