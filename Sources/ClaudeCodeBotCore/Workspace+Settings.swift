import Combine
import Foundation

/// The sections of Botling's settings window, in the order its sidebar lists them.
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
    case general
    case usage
    case permissions
    case plugins
    case developer
    case releases
    case doctor

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .general: L("General")
        case .usage: L("Usage")
        case .permissions: L("Permissions")
        case .plugins: L("Plugins")
        case .developer: L("Developer mode")
        case .releases: L("Release planner")
        case .doctor: L("Doctor")
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
