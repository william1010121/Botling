import Foundation

/// App-wide defaults for subagents and Codex workers (Settings → Engines and subagents). A
/// change is applied at once to every bot, like "Engine and model for all bots", and new bots
/// start on it; each bot's own settings page may still override it afterwards.
extension Workspace {
    /// Picks the model every bot's Claude subagents use (nil: the same as the bot).
    public func setSubagentModelDefault(_ model: BotModel?) async {
        guard model != settings.subagentModelDefault else { return }
        settings.subagentModelDefault = model
        settings.save(to: settingsURL)
        for bot in modelSettingsBots { await bot.setSubagentModel(model) }
    }

    /// Follow Codex's config, or start workers on `choice`; the choice is kept either way.
    public func setCodexWorkerDefaults(follow: Bool, choice: CodexWorkerDefaults) async {
        let before = settings.appliedCodexWorkerDefaults
        guard follow != settings.codexWorkersFollowConfig || choice != settings.codexWorkerChoice else { return }
        settings.codexWorkersFollow = follow
        settings.codexWorkerChoice = choice
        settings.save(to: settingsURL)
        let applied = settings.appliedCodexWorkerDefaults
        guard applied != before else { return }
        for bot in modelSettingsBots { await bot.setCodexWorkerDefaults(applied) }
    }

    /// Saves the defaults into a new bot's folder before it is made, so it loads them.
    func seedEngineDefaults(for id: UUID) {
        let store = BotStore(directory: Layout.bot(id, in: root))
        if let model = settings.subagentModelDefault { store.save(subagentModel: model) }
        let workers = settings.appliedCodexWorkerDefaults
        if workers != CodexWorkerDefaults() { store.save(codexWorkerDefaults: workers) }
    }

    /// How long a quiet run waits before you are reminded (0: never).
    public func setStallReminderMinutes(_ minutes: Int) {
        let minutes = max(0, minutes)
        guard minutes != settings.stallReminderMinutes else { return }
        settings.stallReminderMinutes = minutes
        settings.save(to: settingsURL)
    }
}
