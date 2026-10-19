import AppKit
import Combine
import ClaudeCodeBotCore
import SwiftUI

@main
struct ClaudeCodeBotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // `ClaudeCodeBot --check-plugin <folder>` checks a plugin and quits (see PluginCheck).
        PluginCheck.exitIfRequested()
    }

    var body: some Scene {
        WindowGroup("指揮台") {
            // Snapshot and plugin-check runs never open the real ~/.claudecodebot.
            if AppDelegate.isHeadless {
                Color.clear.frame(width: 1, height: 1)
            } else {
                RootView(workspace: delegate.workspace)
                    .frame(minWidth: 980, minHeight: 620)
                    .preferredColorScheme(.dark)
            }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 820)
    }
}

struct RootView: View {
    @ObservedObject var workspace: Workspace
    @StateObject private var inputs = ChatInputs()

    var body: some View {
        let bot = workspace.selectedBot
        HStack(spacing: 0) {
            RailView(workspace: workspace).frame(width: 240)
            // One web view for every bot: switching bots redraws it instead of reloading.
            ChatSurface(bot: bot, workspace: workspace, components: workspace.components, plugins: workspace.plugins, inputs: inputs)
                .frame(minWidth: workspace.openResult == nil ? 480 : 360, maxWidth: workspace.openResult == nil ? .infinity : 460)
            if let result = workspace.openResult {
                // Looking at a result: the page gets the room, the chat narrows.
                ResultViewer(result: result) { workspace.openResult = nil }
            } else {
                DetailPanel(workspace: workspace, bot: bot).frame(width: 340).id(bot.id)
            }
        }
        // Chips and result rows open pages here instead of in a browser.
        .environment(\.openURL, OpenURLAction { url in
            workspace.openResult = Chip(label: Self.label(for: url, in: workspace), url: url)
            return .handled
        })
        .foregroundStyle(Theme.text)
        .background(Theme.ground)
        .ignoresSafeArea()
    }
}

extension RootView {
    /// The chip text a bot used for `url`, else its file name.
    static func label(for url: URL, in workspace: Workspace) -> String {
        let bots = [workspace.mainBot] + workspace.projects.compactMap(workspace.bot(for:))
        return bots.lazy.flatMap(\.results).first { $0.url == url }?.label ?? url.deletingPathExtension().lastPathComponent
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    lazy var workspace = AppDelegate.makeWorkspace()
    private var badge: AnyCancellable?

    /// A run that only draws a snapshot or checks a plugin, then quits.
    static var isHeadless: Bool {
        let environment = ProcessInfo.processInfo.environment
        return environment["CCB_SNAPSHOT"] != nil || environment["CCB_COMPONENT_SNAPSHOT"] != nil
            || CommandLine.arguments.contains("--check-plugin")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Self.isHeadless {
            for window in NSApp.windows { window.orderOut(nil) }
        }
        if Snapshot.runIfRequested() || PluginCheck.runIfRequested() {
            return
        }
        // Started with `swift run`, the app has no bundle; make it a normal foreground app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        workspace.prepareLibrary()
        workspace.startRoutines()
        workspace.components.startWatching()
        workspace.plugins.startWatching()
        // The Dock icon counts what is waiting for a decision.
        badge = workspace.$waiting.sink { waiting in
            NSApp.dockTile.badgeLabel = waiting.isEmpty ? nil : "\(waiting.count)"
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !Self.isHeadless
    }

    /// Lets awake bots write memory.md before the app goes away.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !Self.isHeadless else { return .terminateNow }
        Task {
            await workspace.putEveryoneToSleep()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// `~/.claudecodebot` holds the main bot's memory.md, every chat, and the project list.
    /// `CCB_IDLE_SECONDS` shortens the 50-minute nap for testing.
    static func makeWorkspace() -> Workspace {
        let root = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claudecodebot")
        // Data from when the app was called Deck moves over once.
        let legacy = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".deck")
        if !FileManager.default.fileExists(atPath: root.path), FileManager.default.fileExists(atPath: legacy.path) {
            try? FileManager.default.moveItem(at: legacy, to: root)
        }
        let idle = ProcessInfo.processInfo.environment["CCB_IDLE_SECONDS"].flatMap(TimeInterval.init) ?? 50 * 60
        let locator = ClaudeExecutableLocator()
        let launcher: AgentLauncher = { launch in
            guard let executable = locator.locate() else { throw AppError.claudeNotFound }
            return try ClaudeAgentProcess.launcher(executable: executable)(launch)
        }
        return Workspace(
            root: root,
            builtInPlugins: ChatSurface.builtInPlugins,
            pluginHostScript: ChatSurface.pluginHostScript,
            validateClaudePart: { folder in
                guard let executable = locator.locate() else { return "找不到 claude。" }
                return await ClaudePluginValidator.validate(folder, executable: executable)
            },
            checkCommand: Bundle.main.executablePath.map { "'\($0)' --check-plugin" },
            launcher: launcher
        ) { profile, store in
            Bot(profile: profile, idleInterval: idle, launcher: launcher, store: store)
        }
    }
}

enum AppError: LocalizedError {
    case claudeNotFound

    var errorDescription: String? {
        switch self {
        case .claudeNotFound: "找不到 claude 指令，請先安裝 Claude Code。"
        }
    }
}
