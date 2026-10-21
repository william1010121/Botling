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
        // `ClaudeCodeBot --stop-guard <claude>` is every bot's Stop hook (see StopGuard).
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--stop-guard"), index + 1 < arguments.count {
            StopGuard.run(claude: URL(filePath: arguments[index + 1]))
        }
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
    @State private var railTip: RailTip?
    @State private var rightTip: RightTip?
    /// The folded strip's settings button: the panel opens on the bot's settings.
    @State private var panelOpensSettings = false

    var body: some View {
        let bot = workspace.selectedBot
        let collapsed = workspace.railCollapsed
        let spec = workspace.viewingSubagent == nil ? workspace.openSpec(in: bot) : nil
        let rightCollapsed = spec == nil && workspace.rightPanelCollapsed
        GeometryReader { window in
        // The columns never add up to more than the window: a panel too wide for it (the spec
        // workspace spread wide in a half-screen window) narrows instead of pushing the rail
        // and its own right edge off screen.
        let columns = RightPanelLayout.columns(
            window: window.size.width,
            rail: RailLayout.width(collapsed: collapsed),
            right: spec == nil ? RightPanelLayout.width(collapsed: rightCollapsed) : RightPanelLayout.specWidth(wide: workspace.specPanelWide)
        )
        HStack(spacing: 0) {
            RailView(workspace: workspace, settings: settings, collapsed: collapsed, tip: $railTip)
                .frame(width: RailLayout.width(collapsed: collapsed))
                .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1).opacity(collapsed ? 1 : 0) }
            // One web view for every bot: switching bots redraws it instead of reloading.
            ChatSurface(bot: bot, workspace: workspace, components: workspace.components, commands: workspace.componentCommands, plugins: workspace.plugins, inputs: inputs)
                .frame(minWidth: columns.chat, maxWidth: .infinity)
                .modifier(BoardMode(workspace: workspace, inputs: inputs, bot: bot))
            Group {
                if let spec {
                    // A component spec's chip was pressed: its workspace, until collapsed back.
                    SpecPanelView(specID: spec.id, bot: bot, workspace: workspace, components: workspace.components, commands: workspace.componentCommands)
                        .background(Theme.side)
                } else if rightCollapsed {
                    RightStrip(workspace: workspace, bot: bot, group: workspace.group(of: bot), tip: $rightTip) {
                        setRightPanel(collapsed: false)
                    } openSettings: {
                        panelOpensSettings = true
                        setRightPanel(collapsed: false)
                    }
                } else if let group = workspace.group(of: bot) {
                    GroupPanel(workspace: workspace, group: group, chat: bot)
                } else {
                    DetailPanel(workspace: workspace, bot: bot, showingSettings: panelOpensSettings)
                        .onAppear { panelOpensSettings = false }
                }
            }
            .frame(width: columns.right)
            .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).opacity(rightCollapsed || spec != nil ? 1 : 0) }
            .id(bot.id)
        }
        }
        .coordinateSpace(name: RailTip.space)
        .overlay(alignment: .topLeading) { RailChrome(collapsed: collapsed, tip: railTip) { toggleRail() } }
        .overlay(alignment: .topTrailing) {
            // With a spec open, the button folds it back to its chip.
            RightChrome(collapsed: rightCollapsed, tip: rightTip) {
                if spec != nil { withAnimation(.easeInOut(duration: 0.2)) { workspace.closeSpec() } } else { toggleRightPanel() }
            }
        }
        .onChange(of: collapsed) { _, _ in railTip = nil }
        .onChange(of: rightCollapsed) { _, _ in rightTip = nil }
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
    private func toggleRail() {
        withAnimation(.easeInOut(duration: 0.2)) { workspace.toggleRail() }
    }

    private func toggleRightPanel() {
        withAnimation(.easeInOut(duration: 0.2)) { workspace.toggleRightPanel() }
    }

    private func setRightPanel(collapsed: Bool) {
        withAnimation(.easeInOut(duration: 0.2)) { workspace.setRightPanelCollapsed(collapsed) }
    }

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
        return environment["CCB_SNAPSHOT"] != nil || environment["CCB_ICON"] != nil || environment["CCB_CODEX_SNAPSHOT"] != nil || environment["CCB_RAIL_SNAPSHOT"] != nil || environment["CCB_RIGHT_SNAPSHOT"] != nil || environment["CCB_SPEC_SNAPSHOT"] != nil || environment["CCB_SETTINGS_SNAPSHOT"] != nil
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
        workspace.startPinRefresh()
        workspace.startWatching()
        workspace.components.startWatching()
        workspace.plugins.startWatching()
        // Only local commands (no npm): a missing or too old Claude Code puts a dot on the gear.
        Task { await workspace.doctor.run(includeLatest: false) }
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
            // Bots kept awake by background work (and that work) would outlive the app, unseen.
            ChildProcessLedger.shared?.endAll()
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
        // Bots an earlier run left running (it crashed, or a new build replaced it) are ended
        // first: they would go on working, unseen. Their chips say so when the chats load.
        if !isHeadless {
            let ledger = ChildProcessLedger(file: root.appending(path: "children.json"))
            ledger.endLeftovers()
            ChildProcessLedger.shared = ledger
        }
        let idle = ProcessInfo.processInfo.environment["CCB_IDLE_SECONDS"].flatMap(TimeInterval.init) ?? 50 * 60
        let locator = ClaudeExecutableLocator()
        let launcher: AgentLauncher = { launch in
            guard let executable = locator.locate() else { throw AppError.claudeNotFound }
            var launch = launch
            // Every bot gets the stop guard: no ending a turn on a promise nothing will keep.
            if let app = Bundle.main.executablePath {
                launch.stopHookCommand = StopGuard.command(app: app, claude: executable.path)
            }
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
