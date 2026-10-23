import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Settings → Engines and subagents: what ~/.codex/config.toml says, and app-wide subagent and
/// Codex worker defaults applied to every bot (each bot's settings may still override them).
@MainActor
struct EngineDefaultsTests {
    // MARK: config.toml

    @Test func readsTopLevelModelEffortAndServiceTier() {
        let config = CodexConfig.parse("""
        # Codex
        model = "gpt-6.1-sol"   # the default
        model_reasoning_effort = 'xhigh'
        service_tier = "priority"
        approval_policy = "never"

        [mcp_servers.docs]
        model = "not-this-one"
        """)
        #expect(config.model == "gpt-6.1-sol")
        #expect(config.effortName == "xhigh")
        #expect(config.effort == .xhigh)
        #expect(config.serviceTier == "priority")
        #expect(config.fast == true)
    }

    @Test func missingKeysStayUnset() {
        let config = CodexConfig.parse("[profiles.work]\nmodel = \"x\"\n")
        #expect(config == CodexConfig())
        #expect(config.fast == nil)
        #expect(CodexConfig.parse("") == CodexConfig())
        #expect(CodexConfig.parse("model = ").model == nil)
    }

    @Test func activeProfileOverridesTopLevel() {
        let config = CodexConfig.parse("""
        model = "base"
        model_reasoning_effort = "low"
        profile = "deep"

        [profiles.fast]
        model = "quick"

        [profiles."deep"]
        model_reasoning_effort = "max"
        service_tier = "default"
        """)
        #expect(config.model == "base")
        #expect(config.effort == .max)
        #expect(config.fast == false)
    }

    @Test func hashInsideAStringIsNotAComment() {
        let config = CodexConfig.parse(#"model = "a#b" # note"# + "\nservice_tier=fast")
        #expect(config.model == "a#b")
        #expect(config.fast == true)
    }

    @Test func unknownEffortKeepsItsName() {
        let config = CodexConfig.parse("model_reasoning_effort = \"minimal\"")
        #expect(config.effort == nil)
        #expect(config.effortName == "minimal")
    }

    @Test func loadsFromCodexHome() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-codex-home-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        #expect(CodexConfig.load(home: home) == CodexConfig())
        try Data("model = \"m\"\n".utf8).write(to: home.appending(path: "config.toml"))
        #expect(CodexConfig.load(home: home).model == "m")
    }

    // MARK: Effective values

    @Test func followingConfigShowsConfigValues() {
        let config = CodexConfig(model: "gpt-6.1-sol", effortName: "max", serviceTier: "priority")
        var settings = AppSettings()
        #expect(settings.codexWorkersFollowConfig)
        #expect(settings.appliedCodexWorkerDefaults == CodexWorkerDefaults())
        let shown = settings.effectiveCodexWorker(config: config)
        #expect(shown.model == "gpt-6.1-sol")
        #expect(shown.effort == .max)
        #expect(shown.fast)
        settings.codexWorkersFollow = false
        settings.codexWorkerChoice = CodexWorkerDefaults(model: nil, effort: .low, fast: false)
        #expect(settings.appliedCodexWorkerDefaults == CodexWorkerDefaults(model: nil, effort: .low, fast: false))
        let own = settings.effectiveCodexWorker(config: config)
        #expect(own.model == "gpt-6.1-sol") // Same as bot: config's when the bot names none.
        #expect(own.effort == .low)
        #expect(!own.fast)
    }

    @Test func startingOwnChoiceSeedsFromConfig() {
        let config = CodexConfig(model: "m", effortName: "high", serviceTier: "priority")
        #expect(CodexWorkerDefaults.seeded(from: config) == CodexWorkerDefaults(model: "m", effort: .high, fast: true))
        #expect(CodexWorkerDefaults.seeded(from: CodexConfig()) == CodexWorkerDefaults(model: nil, effort: nil, fast: false))
    }

    // MARK: Applied to all bots

    private func open(_ root: URL, _ fake: FakeLauncher) -> Workspace {
        Workspace(root: root) { profile, store in Bot(profile: profile, launcher: fake.launcher, store: store) }
    }

    @Test func defaultsApplyToEveryBotAndPersist() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-engine-defaults-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = open(root, fake)
        let folder = root.appending(path: "source")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        workspace.addProject(folder: folder)
        _ = try #require(workspace.createBot(name: "News", job: "Read news"))
        let bots = workspace.modelSettingsBots
        #expect(bots.count == 4)
        for bot in bots { await bot.setEffort(.high) }

        await workspace.setSubagentModelDefault(.haiku)
        let own = CodexWorkerDefaults(model: "gpt-x", effort: .medium, fast: true)
        await workspace.setCodexWorkerDefaults(follow: false, choice: own)
        for bot in bots {
            #expect(bot.subagentModel == .haiku)
            #expect(bot.codexWorkerDefaults == own)
            #expect(bot.effort == .high) // Other settings stay.
        }
        #expect(fake.agents.isEmpty) // Sleeping bots are not woken.

        let reopened = open(root, fake)
        #expect(reopened.settings.subagentModelDefault == .haiku)
        #expect(!reopened.settings.codexWorkersFollowConfig)
        #expect(reopened.settings.codexWorkerChoice == own)
        for bot in reopened.modelSettingsBots {
            #expect(bot.subagentModel == .haiku)
            #expect(bot.codexWorkerDefaults == own)
        }

        // Following the config again clears the workers' own choice on every bot, but the
        // choice is kept for the next time the switch is turned off.
        await reopened.setCodexWorkerDefaults(follow: true, choice: own)
        for bot in reopened.modelSettingsBots { #expect(bot.codexWorkerDefaults == CodexWorkerDefaults()) }
        #expect(reopened.settings.codexWorkerChoice == own)
    }

    @Test func aBotsOwnOverrideLastsUntilTheDefaultChangesAgain() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-engine-override-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = open(root, fake)
        await workspace.setSubagentModelDefault(.sonnet)
        await workspace.mainBot.setSubagentModel(.opus)
        let reopened = open(root, fake)
        #expect(reopened.mainBot.subagentModel == .opus) // Opening the app does not re-apply.
        await reopened.setSubagentModelDefault(.sonnet) // Same value: nothing to apply.
        #expect(reopened.mainBot.subagentModel == .opus)
        await reopened.setSubagentModelDefault(nil)
        #expect(reopened.mainBot.subagentModel == nil)
    }

    @Test func newBotsStartOnTheDefaults() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-engine-new-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = open(root, fake)
        let own = CodexWorkerDefaults(model: nil, effort: .low, fast: false)
        await workspace.setSubagentModelDefault(.opus)
        await workspace.setCodexWorkerDefaults(follow: false, choice: own)
        let made = try #require(workspace.createBot(name: "Later", job: "Made after"))
        let bot = try #require(workspace.bot(for: made))
        #expect(bot.subagentModel == .opus)
        #expect(bot.codexWorkerDefaults == own)
        let folder = root.appending(path: "later-project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        #expect(workspace.bot(for: project)?.subagentModel == .opus)
        #expect(workspace.bot(for: project)?.codexWorkerDefaults == own)
    }

    // MARK: Stall reminder

    @Test func stallReminderMinutesAreSaved() {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-stall-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = open(root, fake)
        #expect(workspace.settings.stallReminder == StallWatch.defaultMinutes)
        workspace.setStallReminderMinutes(0)
        #expect(workspace.settings.stallReminderInterval == 0)
        workspace.setStallReminderMinutes(30)
        #expect(AppSettings.load(from: workspace.settingsURL).stallReminderMinutes == 30)
        #expect(AppSettings.stallReminderChoices.contains(StallWatch.defaultMinutes))
    }

    // MARK: Settings search

    @Test func searchFindsSectionsByTitleAndRows() {
        let all = SettingsSection.allCases
        #expect(SettingsSection.matching("", in: all) == all)
        #expect(SettingsSection.matching("  ", in: all) == all)
        #expect(SettingsSection.matching("codex", in: all).contains(.engines))
        #expect(SettingsSection.matching("CODEX", in: all).contains(.engines))
        #expect(SettingsSection.matching("language", in: all) == [.general])
        #expect(SettingsSection.matching("zzzz-nothing", in: all).isEmpty)
        #expect(SettingsSection.matching("release", in: all.filter { $0 != .releases }).isEmpty)
    }
}
