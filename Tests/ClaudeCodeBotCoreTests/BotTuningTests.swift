import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A bot's subagent model and thinking effort: saved in bot.json, handed to `claude` as
/// `--effort` and `CLAUDE_CODE_SUBAGENT_MODEL`.
@MainActor
struct BotTuningTests {
    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "ccb-tuning-\(UUID().uuidString)")
    }

    private func launch(effort: EffortLevel? = nil, subagentModel: BotModel? = nil, environment: [String: String] = [:], subagentHourCache: Bool = false) -> AgentLaunch {
        var launch = AgentLaunch(
            model: .sonnet,
            sessionID: UUID(),
            workingDirectory: FileManager.default.temporaryDirectory,
            systemPrompt: "",
            environment: environment,
            effort: effort,
            subagentModel: subagentModel
        )
        launch.subagentHourCache = subagentHourCache
        return launch
    }

    // MARK: Persistence

    @Test func storeKeepsSubagentModelAndEffort() {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = BotStore(directory: directory)
        #expect(store.loadSubagentModel() == nil)
        #expect(store.loadEffort() == nil)

        store.save(model: .opus)
        store.save(subagentModel: .haiku)
        store.save(effort: .high)

        let reopened = BotStore(directory: directory)
        #expect(reopened.loadModel() == .opus)
        #expect(reopened.loadSubagentModel() == .haiku)
        #expect(reopened.loadEffort() == .high)

        // Back to the defaults.
        reopened.save(subagentModel: nil)
        reopened.save(effort: nil)
        #expect(store.loadSubagentModel() == nil)
        #expect(store.loadEffort() == nil)
        #expect(store.loadModel() == .opus)
    }

    @Test func oldBotFileStillLoads() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let old = #"{"model":"haiku","alwaysAllowed":["Bash"],"unread":3}"#
        try Data(old.utf8).write(to: directory.appending(path: "bot.json"))

        let store = BotStore(directory: directory)
        #expect(store.loadModel() == .haiku)
        #expect(store.loadAlwaysAllowed() == ["Bash"])
        #expect(store.loadUnread() == 3)
        #expect(store.loadSubagentModel() == nil)
        #expect(store.loadEffort() == nil)
    }

    @Test func unknownSavedValuesFallBackWithoutLosingTheRest() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let newer = #"{"model":"opus","subagentModel":"fable","effort":"ultra","unread":2}"#
        try Data(newer.utf8).write(to: directory.appending(path: "bot.json"))

        let store = BotStore(directory: directory)
        #expect(store.loadModel() == .opus)
        #expect(store.loadUnread() == 2)
        #expect(store.loadSubagentModel() == nil)
        #expect(store.loadEffort() == nil)
    }

    // MARK: Launch arguments and environment

    @Test func defaultEffortPassesNoFlag() {
        let arguments = ClaudeAgentProcess.arguments(for: launch())
        #expect(!arguments.contains("--effort"))
    }

    @Test func eachEffortIsPassedAsTheEffortFlag() {
        for level in EffortLevel.allCases {
            let arguments = ClaudeAgentProcess.arguments(for: launch(effort: level))
            let index = arguments.firstIndex(of: "--effort")
            #expect(index.map { arguments[$0 + 1] } == level.rawValue)
            #expect(arguments.filter { $0 == "--effort" }.count == 1)
        }
        #expect(EffortLevel.allCases.map(\.rawValue) == ["low", "medium", "high", "xhigh", "max"])
    }

    @Test func sameAsBotSetsNoSubagentModel() {
        let environment = ClaudeAgentProcess.launchEnvironment(for: launch(environment: ["TOKEN": "x"]), inherited: [:])
        #expect(environment == ["TOKEN": "x", "CLAUDE_CODE_ARTIFACT": "1"])
    }

    private let ttl = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"

    @Test func subagentHourCacheOffSetsNothing() {
        #expect(ClaudeAgentProcess.launchEnvironment(for: launch(), inherited: [:])[ttl] == nil)
        // The user's own value still goes through as before.
        #expect(ClaudeAgentProcess.launchEnvironment(for: launch(environment: [ttl: "1h"]), inherited: [:])[ttl] == "1h")
    }

    @Test func subagentHourCacheOnSetsAnHourUnlessTheUserSaysOtherwise() {
        #expect(ClaudeAgentProcess.launchEnvironment(for: launch(subagentHourCache: true), inherited: [:])[ttl] == "1h")
        let set = [ttl: "5m"]
        // Set in the app's own environment: left there (the child inherits it), not overridden.
        #expect(ClaudeAgentProcess.launchEnvironment(for: launch(subagentHourCache: true), inherited: set)[ttl] == nil)
        #expect(ClaudeAgentProcess.launchEnvironment(for: launch(environment: set, subagentHourCache: true), inherited: [:])[ttl] == "5m")
    }

    @Test func subagentHourCacheSettingIsOffByDefaultSavedAndReachesTheLaunch() async throws {
        let old = try JSONDecoder().decode(AppSettings.self, from: Data("{\"developerMode\":false}".utf8))
        #expect(!old.subagentHourCache)
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let open = { Workspace(root: root, launcher: fake.launcher) { profile, store in Bot(profile: profile, launcher: fake.launcher, store: store) } }
        let workspace = open()
        #expect(!workspace.settings.subagentHourCache)
        workspace.mainBot.send("hello")
        await eventually { !workspace.mainBot.isWorking }
        #expect(fake.agents.last?.launch.subagentHourCache == false)
        workspace.mainBot.stop()
        workspace.setSubagentHourCache(true)
        let reloaded = open()
        #expect(reloaded.settings.subagentHourCache)
        reloaded.mainBot.send("hello again")
        await eventually { !reloaded.mainBot.isWorking }
        defer { reloaded.mainBot.stop() }
        #expect(fake.agents.last?.launch.subagentHourCache == true)
        #expect(SettingsSection.matching("Keep subagents' prompt cache for 1 hour", in: SettingsSection.allCases) == [.engines])
    }

    @Test func eachSubagentModelGoesInTheEnvironment() {
        for model in BotModel.allCases {
            let environment = ClaudeAgentProcess.launchEnvironment(for: launch(subagentModel: model, environment: ["TOKEN": "x"]))
            #expect(environment["CLAUDE_CODE_SUBAGENT_MODEL"] == model.rawValue)
            #expect(environment["TOKEN"] == "x")
        }
    }

    // MARK: The bot

    @Test func botStartsWithItsSavedSettings() async {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = BotStore(directory: directory)
        store.save(subagentModel: .opus)
        store.save(effort: .low)
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: directory), launcher: fake.launcher, store: store)
        #expect(bot.subagentModel == .opus)
        #expect(bot.effort == .low)

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents[0].launch.subagentModel == .opus)
        #expect(fake.agents[0].launch.effort == .low)
    }

    @Test func newBotUsesTodaysDefaults() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        #expect(bot.subagentModel == nil)
        #expect(bot.effort == nil)

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents[0].launch.subagentModel == nil)
        #expect(fake.agents[0].launch.effort == nil)
    }

    @Test func changingWhileAsleepAppliesAtTheNextWake() async {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fake = FakeLauncher()
        let bot = Bot(profile: .main(home: directory), launcher: fake.launcher, store: BotStore(directory: directory))

        await bot.setEffort(.max)
        await bot.setSubagentModel(.haiku)
        #expect(fake.agents.isEmpty)
        #expect(bot.effort == .max)
        #expect(bot.subagentModel == .haiku)

        let reopened = Bot(profile: .main(home: directory), launcher: fake.launcher, store: BotStore(directory: directory))
        #expect(reopened.effort == .max)
        #expect(reopened.subagentModel == .haiku)

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents[0].launch.effort == .max)
        #expect(fake.agents[0].launch.subagentModel == .haiku)
    }

    @Test func changingWhileAwakeHandsOverAndRestarts() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }

        bot.sessionExists = { _, _ in false }
        await bot.setEffort(.high)
        #expect(fake.agents.count == 1)
        bot.send("next")
        await eventually { fake.agents.count == 2 && bot.phase == .awake && !bot.isWorking }
        #expect(fake.agents[0].sent.last == bot.prompts.handoff)
        #expect(fake.agents[0].finished)
        #expect(fake.agents[1].launch.effort == .high)
        #expect(fake.agents[1].launch.model == .sonnet)
        #expect(fake.agents[1].sent == [bot.prompts.resume, "next"])

        await bot.setSubagentModel(.haiku)
        bot.send("and next")
        await eventually { fake.agents.count == 3 && bot.phase == .awake }
        #expect(fake.agents[2].launch.subagentModel == .haiku)
        #expect(fake.agents[2].launch.effort == .high)

        // Picking what it already has does nothing.
        await bot.setSubagentModel(.haiku)
        await bot.setEffort(.high)
        #expect(fake.agents.count == 3)
    }
}
