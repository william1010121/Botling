import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Which head started a subagent, and which model it runs on, for its row and its view.
@MainActor
struct SubagentOwnerTests {
    /// A two-headed bot with one saved subagent per head, neither head launched.
    private func twoHeads(primary engine: BotEngine, model: BotModel = .opus, subagentModel: BotModel? = nil, claudeRan ran: String? = nil) throws -> Bot {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-owner-\(UUID().uuidString)")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: engine)
        store.save(heads: HeadsSettings(engines: [.claude, .codex]))
        store.save(model: model)
        if let subagentModel { store.save(subagentModel: subagentModel) }
        let other = try #require(BotEngine.allCases.first { $0 != engine })
        let partnerStore = BotStore(directory: store.directory.appending(path: "partner-\(other.rawValue)"))
        func team(_ head: BotEngine) -> Subagent {
            var team = Subagent(id: "\(head.rawValue)-team", description: "\(head.displayName) team", type: head == .codex ? "codex-worker" : "general-purpose", prompt: "Research", status: .completed)
            if head == .claude { team.model = ran }
            return team
        }
        store.save(subagents: [team(engine)])
        partnerStore.save(subagents: [team(other)])
        return Bot(profile: .main(home: root), launcher: FakeLauncher().launcher, store: store)
    }

    private func model(of id: String, in bot: Bot) throws -> String? {
        try ChatPayload.make(subagent: #require(bot.subagent(id)), of: bot, components: nil, avatar: "").subagent?.model
    }

    @Test(arguments: BotEngine.allCases)
    func eachRowNamesTheHeadThatStartedIt(_ engine: BotEngine) throws {
        let bot = try twoHeads(primary: engine)
        #expect(bot.subagentOwnerMark("claude-team") == .claude)
        #expect(bot.subagentOwnerMark("codex-team") == .codex)
        #expect(bot.subagentOwnerMark("missing") == nil)
    }

    @Test func aOneHeadedBotNeedsNoOwnerMark() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-owner-\(UUID().uuidString)")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(subagents: [Subagent(id: "solo", description: "Solo", type: "general-purpose", prompt: "Research")])
        let bot = Bot(profile: .main(home: root), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.subagentEngine("solo") == .claude)
        #expect(bot.subagentOwnerMark("solo") == nil)
    }

    @Test(arguments: BotEngine.allCases)
    func aClaudeSubagentOnTheSameModelShowsTheHeadsModel(_ engine: BotEngine) throws {
        // "Same model" (no subagent model) used to leave the Claude subagent with no model at all.
        let bot = try twoHeads(primary: engine, model: .opus)
        #expect(bot.subagentModel == nil)
        #expect(try model(of: "claude-team", in: bot) == "Opus")
        // The Claude subagent setting never names a Codex worker's model.
        #expect(try model(of: "codex-team", in: bot) == nil)
    }

    @Test func aClaudeSubagentModelSettingStillWins() throws {
        let bot = try twoHeads(primary: .claude, model: .opus, subagentModel: .haiku)
        #expect(try model(of: "claude-team", in: bot) == "Haiku")
        #expect(try model(of: "codex-team", in: bot) == nil)
    }

    @Test func theModelTheStreamReportsIsShownByName() throws {
        let bot = try twoHeads(primary: .claude, model: .opus, claudeRan: "claude-haiku-4-5-20251001")
        #expect(try model(of: "claude-team", in: bot) == "Haiku 4.5")
    }

    @Test func claudeModelIDsReadAsNames() {
        #expect(BotModel.displayName(ofModelID: "sonnet") == "Sonnet")
        #expect(BotModel.displayName(ofModelID: "Opus") == "Opus")
        #expect(BotModel.displayName(ofModelID: "claude-opus-4-5-20251101") == "Opus 4.5")
        #expect(BotModel.displayName(ofModelID: "claude-sonnet-4-5[1m]") == "Sonnet 4.5")
        #expect(BotModel.displayName(ofModelID: "claude-3-5-haiku-20241022") == "Haiku 3.5")
        #expect(BotModel.displayName(ofModelID: "claude-opus-4-1") == "Opus 4.1")
        #expect(BotModel.displayName(ofModelID: "gpt-5.1-codex") == "gpt-5.1-codex")
    }

    @Test func aSubagentsOwnMessagesSayWhichModelRanIt() {
        let line = #"{"type":"assistant","parent_tool_use_id":"toolu_agent","message":{"id":"msg_1","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Looking"}]}}"#
        let models = StreamEvent.events(in: line).compactMap { event -> String? in
            if case let .trace(.subagentModel(id, model)) = event { return "\(id)=\(model)" }
            return nil
        }
        #expect(models == ["toolu_agent=claude-haiku-4-5-20251001"])

        // The head's own lines, and lines Claude Code makes up itself, name no subagent's model.
        let own = #"{"type":"assistant","message":{"id":"msg_2","model":"claude-opus-4-5","content":[{"type":"text","text":"Hi"}]}}"#
        let synthetic = #"{"type":"assistant","parent_tool_use_id":"toolu_agent","message":{"id":"msg_3","model":"<synthetic>","content":[{"type":"text","text":"Error"}]}}"#
        for line in [own, synthetic] {
            #expect(!StreamEvent.events(in: line).contains { if case .trace(.subagentModel) = $0 { true } else { false } })
        }
    }
}
