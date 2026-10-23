import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct GlobalBotModelTests {
    @Test(arguments: BotEngine.allCases)
    func batchPersistsForEveryExistingBotWithoutChangingOtherSettings(engine: BotEngine) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-global-model-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        func open() -> Workspace {
            Workspace(root: root.appending(path: "app")) { profile, store in
                Bot(profile: profile, launcher: fake.launcher, store: store)
            }
        }
        let workspace = open()
        let folder = root.appending(path: "source")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        let standalone = try #require(workspace.createBot(name: "News", job: "Read news"))
        let bots = workspace.modelSettingsBots
        #expect(bots.count == 4) // Main, project, standalone, hidden Maintainer.
        #expect(bots.contains { $0 === workspace.maintainer })
        for bot in bots {
            await bot.setHeads([.claude, .codex])
            await bot.switchModel(to: .haiku)
            await bot.setCodexModel("previous-codex-model")
            await bot.setSubagentModel(.sonnet)
            await bot.setEffort(.high)
            bot.setHandoffs(false)
            bot.setLimits(RoundLimits(discussion: 1, review: 1, handoffs: 2))
        }
        // All changes are opt-in: picking a model elsewhere affects only that bot.
        await workspace.mainBot.switchModel(to: .sonnet)
        #expect(workspace.bot(for: project)?.model == .haiku)
        let originalMessages = bots.map(\.messages)
        let originalTools = bots.map { $0.profile.tools }
        let count = await workspace.applyModelToAllBots(engine: engine, claudeModel: .opus, codexModel: "selected-codex-model")
        #expect(count == 4)
        #expect(!workspace.isApplyingBotModel)
        for (index, bot) in bots.enumerated() {
            #expect(bot.heads.engines == [engine])
            #expect(bot.engine == engine)
            #expect(bot.heads.answerWith == AnswerTarget(engine))
            #expect(bot.model == (engine == .claude ? .opus : (index == 0 ? .sonnet : .haiku)))
            #expect(bot.heads.codexModel == (engine == .codex ? "selected-codex-model" : "previous-codex-model"))
            #expect(bot.subagentModel == .sonnet)
            #expect(bot.effort == .high)
            #expect(!bot.heads.handoffs)
            #expect(bot.heads.limits == RoundLimits(discussion: 1, review: 1, handoffs: 2))
            #expect(bot.profile.tools == originalTools[index])
            #expect(Array(bot.messages.prefix(originalMessages[index].count)) == originalMessages[index])
            #expect(bot.partner == nil)
        }
        #expect(fake.agents.isEmpty) // Sleeping bots are not woken by applying settings.
        let reopened = open()
        #expect(reopened.projects.map(\.id) == [project.id, standalone.id])
        for bot in reopened.modelSettingsBots {
            #expect(bot.heads.engines == [engine])
            #expect(bot.engine == engine)
            #expect(bot.heads.engineNames == engine.displayName)
            #expect(bot.subagentModel == .sonnet)
            #expect(bot.effort == .high)
            #expect(!bot.heads.handoffs)
        }
        // Reenabling remains possible; individual overrides survive a further restart.
        await reopened.mainBot.setHeads([.claude, .codex])
        reopened.mainBot.setAnswerWith(.codex)
        let again = open()
        #expect(again.mainBot.heads.engines == [.claude, .codex])
        #expect(again.mainBot.heads.answerWith == .codex)
        #expect(again.bot(for: project)?.heads.engines == [engine])
        let future = try #require(again.createBot(name: "Future", job: "Independent settings"))
        #expect(again.bot(for: future)?.engine == .claude)
    }

    @Test func codexDefaultAndRepeatedBatchApplication() async {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-global-default-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root) { profile, store in Bot(profile: profile, launcher: fake.launcher, store: store) }
        await workspace.applyModelToAllBots(engine: .codex, claudeModel: .opus, codexModel: "custom")
        await workspace.applyModelToAllBots(engine: .codex, claudeModel: .opus, codexModel: nil)
        let before = workspace.mainBot.messages
        await workspace.applyModelToAllBots(engine: .codex, claudeModel: .opus, codexModel: nil)
        #expect(workspace.mainBot.heads.codexModel == nil)
        #expect(workspace.mainBot.messages == before)
        #expect(HeadsSettings.single(.codex).engineNames == "Codex")
        #expect(HeadsSettings.single(.claude).engineNames == "Claude")
        #expect(HeadsSettings(engines: [.claude, .codex]).engineNames == "Claude & Codex")
    }
    @Test(arguments: BotEngine.allCases)
    func awakeBotKeepsEngineHandoffWhenBatchAlsoChangesItsModel(engine: BotEngine) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-global-awake-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root) { profile, store in Bot(profile: profile, launcher: fake.launcher, store: store) }
        let bot = workspace.mainBot
        defer { bot.stop() }
        await bot.setHeads([engine == .claude ? .codex : .claude])
        bot.sessionExists = { _, _ in true }
        bot.send("before batch")
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        #expect(fake.agents.count == 1)
        let history = bot.messages
        await workspace.applyModelToAllBots(engine: engine, claudeModel: .opus, codexModel: "selected-model")
        #expect(fake.agents.count == 1) // Applying does not interrupt the session.
        bot.send("after batch")
        await eventually { fake.agents.count == 2 && bot.messages.last?.role == .bot && !bot.isWorking }
        let launch = try #require(fake.agents.last?.launch)
        #expect(launch.engine == engine)
        #expect(!launch.resume) // A model change must not override the engine handoff.
        #expect(engine == .claude ? launch.model == .opus : launch.codexModel == "selected-model")
        #expect(Array(bot.messages.prefix(history.count)) == history)
    }

}
