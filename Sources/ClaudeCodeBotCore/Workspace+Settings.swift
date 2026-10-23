import Combine
import Foundation

/// The sections of Botling's settings window, in the order its sidebar lists them; the last two
/// sit under "Advanced".
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
    case general
    case engines
    case permissions
    case usage
    case plugins
    case doctor
    case developer
    case releases

    public var id: String { rawValue }

    public var title: String { L(englishTitle) }

    /// Listed under "Advanced" in the sidebar.
    public var isAdvanced: Bool { self == .developer || self == .releases }

    /// What the sidebar's search also finds a section by: the names of its rows (English keys,
    /// shown in the app's language).
    var searchTerms: [String] {
        switch self {
        case .general: ["Language", "App language", "Bot look", "Chat avatars", "Chat avatar size", "Reminders", "Remind after no new step for"]
        case .engines: ["Claude subagents", "Codex workers", "Follow Codex config file", "Model", "Reasoning effort", "Fast mode", "Component editor", "Engine and model for all bots"]
        case .permissions: ["Auto mode", "Auto-approve safe actions", "Reports and results", "Publish as", "Approved component commands", "Ignored"]
        case .usage: ["App context savings", "Send only reaction changes", "Send only component changes", "Usage today", "Cost", "Tokens", "Subscription limits", "By bot", "Earlier days"]
        case .plugins: ["Installed", "Add plugin"]
        case .doctor: ["Command-line tools", "Run again"]
        case .developer: ["Develop Botling itself", "Its source"]
        case .releases: []
        }
    }

    /// The sections of `shown` whose title or rows contain `query`, in English or the app's
    /// language, ignoring case; all of them for an empty query.
    public static func matching(_ query: String, in shown: [SettingsSection]) -> [SettingsSection] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return shown }
        return shown.filter { section in
            let english = [section.rawValue, section.englishTitle] + section.searchTerms
            let words = english + [section.title] + section.searchTerms.map { L($0) }
            return words.contains { $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        }
    }

    private var englishTitle: String {
        switch self {
        case .general: "General"
        case .engines: "Engines and subagents"
        case .usage: "Usage"
        case .permissions: "Permissions"
        case .plugins: "Plugins"
        case .developer: "Developer mode"
        case .releases: "Release planner"
        case .doctor: "Doctor"
        }
    }
}

/// Whether the settings window is open and at which section. The gear's popover opens it at
/// the section a row is about; "All settings…" and ⌘, open it where it was last.
@MainActor
public final class SettingsNavigator: ObservableObject {
    @Published public var isOpen = false
    @Published public var section: SettingsSection = .usage

    public init() {}

    /// Opens the window, at `section` if given, else where it was last.
    public func open(_ section: SettingsSection? = nil) {
        if let section { self.section = section }
        isOpen = true
    }

    public func close() {
        isOpen = false
    }
}

extension Workspace {
    /// A component command the user allowed, and whose folder it runs in.
    public struct ApprovedCommand: Identifiable, Equatable, Sendable {
        public var folder: String
        public var command: String
        /// The bot working in that folder, else the folder's name.
        public var owner: String

        public var id: String { folder + "\u{0}" + command }
    }

    /// Every allowed component command, for Settings > Permissions.
    public var approvedCommands: [ApprovedCommand] {
        componentCommands.approvals.map { folder, command in
            ApprovedCommand(folder: folder, command: command, owner: owner(ofFolder: folder))
        }
    }

    /// Takes back an allowed component command; its cards ask again before running it.
    public func forget(_ approved: ApprovedCommand) {
        componentCommands.forget(approved.command, inFolderPath: approved.folder)
    }

    /// How many plugins are on.
    public var enabledPluginCount: Int {
        plugins.plugins.filter(\.enabled).count
    }

    private func owner(ofFolder path: String) -> String {
        let bots = [mainBot] + everyProject.compactMap(bot(for:))
        if let bot = bots.first(where: { $0.profile.workingDirectory.standardizedFileURL.path == path }) {
            return bot.profile.name
        }
        return URL(filePath: path).lastPathComponent
    }
}

/// One explicit batch operation. Other per-bot settings and inactive models are retained.
/// This is not a continuously enforced default: later per-bot edits and new bots stay independent.
extension Workspace {
    public var modelSettingsBots: [Bot] {
        [mainBot] + everyProject.compactMap(bot(for:))
    }

    @discardableResult
    public func applyModelToAllBots(engine: BotEngine, claudeModel: BotModel, codexModel: String?) async -> Int {
        guard !isApplyingBotModel else { return 0 }
        isApplyingBotModel = true
        defer { isApplyingBotModel = false }
        let bots = modelSettingsBots
        for bot in bots {
            // Select the model first so an engine handoff remains the pending restart reason.
            switch engine {
            case .claude: await bot.switchModel(to: claudeModel)
            case .codex: await bot.setCodexModel(codexModel)
            }
            await bot.setHeads([engine])
        }
        return bots.count
    }
}


extension Workspace {
    /// Saved immediately; existing heads and newly attached bots use it on their next normal turn.
    public func setReactionChangesOnly(_ on: Bool) {
        guard on != settings.reactionChangesOnly else { return }
        settings.reactionChangesOnlyChoice = on
        settings.save(to: settingsURL)
        for bot in modelSettingsBots { bot.reactionChangesOnly = on }
    }

    public func setComponentChangesOnly(_ on: Bool) {
        guard on != settings.componentChangesOnly else { return }
        settings.componentChangesOnlyChoice = on
        settings.save(to: settingsURL)
        for bot in modelSettingsBots { bot.componentChangesOnly = on }
    }
}
