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
        WindowGroup("ClaudeCodeBot") {
            // Snapshot and plugin-check runs never open the real ~/.claudecodebot.
            if AppDelegate.isHeadless {
                Color.clear.frame(width: 1, height: 1)
            } else {
                RootView(workspace: delegate.workspace, settings: delegate.settings)
                    .frame(minWidth: 980, minHeight: 620)
                    .preferredColorScheme(.dark)
            }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { delegate.settings.open() }
                    .keyboardShortcut(",", modifiers: .command)
            }
        }
    }
}

struct RootView: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var settings: SettingsNavigator
    @StateObject private var inputs = ChatInputs()

    var body: some View {
        let bot = workspace.selectedBot
        HStack(spacing: 0) {
            RailView(workspace: workspace, settings: settings).frame(width: 240)
            // One web view for every bot: switching bots redraws it instead of reloading.
            ChatSurface(bot: bot, workspace: workspace, components: workspace.components, commands: workspace.componentCommands, plugins: workspace.plugins, inputs: inputs)
                .frame(minWidth: 480, maxWidth: .infinity)
            Group {
                if let group = workspace.group(of: bot) {
                    GroupPanel(workspace: workspace, group: group, chat: bot)
                } else {
                    DetailPanel(workspace: workspace, bot: bot)
                }
            }
            .frame(width: 340)
            .id(bot.id)
        }
        // Chips and result rows: web links in the browser, local files in a window of their own.
        .environment(\.openURL, OpenURLAction { url in
            ResultWindows.open(Chip(label: Self.label(for: url, in: workspace), url: url))
            return .handled
        })
        .foregroundStyle(Theme.text)
        .background(Theme.ground)
        .ignoresSafeArea()
        .sheet(isPresented: $settings.isOpen) {
            SettingsWindow(workspace: workspace, navigator: settings)
        }
    }
}

extension RootView {
    /// The chip text a bot used for `url`, else its file name.
    static func label(for url: URL, in workspace: Workspace) -> String {
        let bots = [workspace.mainBot] + workspace.projects.compactMap(workspace.bot(for:)) + Array(workspace.groupChats.values)
        return bots.lazy.flatMap(\.results).first { $0.url == url }?.label ?? url.deletingPathExtension().lastPathComponent
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    lazy var workspace = AppDelegate.makeWorkspace()
    /// The settings window: open or not, and at which section (the gear and ⌘, open it).
    let settings = SettingsNavigator()
    private var badge: AnyCancellable?

    /// A run that only draws a snapshot or checks a plugin, then quits.
    static var isHeadless: Bool {
        let environment = ProcessInfo.processInfo.environment
        return environment["CCB_SNAPSHOT"] != nil || environment["CCB_ICON"] != nil
            || CommandLine.arguments.contains("--check-plugin") || Snapshot.isChatRequest
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
        connectSelfUpdate()
        workspace.startRoutines()
        workspace.startWatching()
        workspace.components.startWatching()
        workspace.plugins.startWatching()
        // The Dock icon counts what is waiting for a decision.
        badge = workspace.$waiting.sink { waiting in
            NSApp.dockTile.badgeLabel = waiting.isEmpty ? nil : "\(waiting.count)"
        }
    }

    /// Developer mode's hooks: which build this is, how to install another (a script outside the
    /// app does it once the app has quit), and a picture of the window. Then, if an install was
    /// under way, how it went.
    private func connectSelfUpdate() {
        workspace.runningBuild = BuildInfo.read(Bundle.main.bundleURL)
        let root = workspace.root
        workspace.launchInstaller = { command in
            let process = Process()
            process.executableURL = URL(filePath: command[0])
            process.arguments = Array(command.dropFirst())
            let log = SelfUpdate.logURL(in: root)
            FileManager.default.createFile(atPath: log.path, contents: nil)
            if let handle = try? FileHandle(forWritingTo: log) {
                process.standardOutput = handle
                process.standardError = handle
            }
            do {
                try process.run()
            } catch {
                return
            }
            // Bots write their memory as the app quits; the script waits for that.
            NSApp.terminate(nil)
        }
        workspace.captureWindow = { await Self.captureMainWindow(into: root) }
        workspace.checkSelfUpdate()
    }

    /// A PNG of the main window as it is on screen, saved under the update folder. The older
    /// CoreGraphics call is used on purpose: for the app's own window it needs no Screen
    /// Recording permission, where ScreenCaptureKit would ask every user first.
    static func captureMainWindow(into root: URL) async -> URL? {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.frame.width > 600 }),
              let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) else { return nil }
        let folder = SelfUpdate.folder(in: root).appending(path: "screenshots")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: "window-\(Int(Date().timeIntervalSince1970)).png")
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
              (try? png.write(to: url)) != nil else { return nil }
        return url
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !Self.isHeadless
    }

    /// Clicking the Dock icon with only result windows open brings the main window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        let main = NSApp.windows.first { $0.identifier?.rawValue.contains("AppWindow") == true || $0.title == "ClaudeCodeBot" }
        if let main {
            main.makeKeyAndOrderFront(nil)
            return false
        }
        return true
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
                guard let executable = locator.locate() else { return "claude not found." }
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
        case .claudeNotFound: "The claude command was not found. Please install Claude Code first."
        }
    }
}
