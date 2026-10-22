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
                // SwiftUI still makes its window: it is sent offscreen as soon as it exists.
                Color.clear.frame(width: 1, height: 1).background(HiddenWindow())
            } else {
                RootView(workspace: delegate.workspace, settings: delegate.settings)
                    .background(MainWindowProbe())
                    .frame(minWidth: 980, minHeight: 620)
                    .preferredColorScheme(.dark)
            }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button(L("Settings…")) { delegate.settings.open() }
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
        // A web AI (Gemini) picked in the left column: its site shows instead of a chat.
        let web = workspace.selectedWebSite
        let collapsed = workspace.railCollapsed
        let spec = workspace.viewingSubagent == nil && workspace.selectedWebSite == nil ? workspace.openSpec(in: bot) : nil
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
                .shellColumn("rail", height: window.size.height)
                // A new language (Settings) draws the native views again in its words.
                .id(workspace.language)
            ZStack {
                // One web view for every bot: switching bots redraws it instead of reloading.
                // Kept under a web site's page, so coming back does not reload it either.
                ChatSurface(bot: bot, workspace: workspace, components: workspace.components, commands: workspace.componentCommands, plugins: workspace.plugins, inputs: inputs)
                    .modifier(BoardMode(workspace: workspace, inputs: inputs, bot: bot))
                    .opacity(web == nil ? 1 : 0)
                    .allowsHitTesting(web == nil)
                if let web {
                    WebSiteColumn(shelf: workspace.web, site: web, workspace: workspace)
                }
            }
                .frame(minWidth: columns.chat, maxWidth: .infinity)
                .shellColumn("chat", height: window.size.height)
            Group {
                if let web {
                    if rightCollapsed {
                        WebStrip(site: web) { setRightPanel(collapsed: false) }
                    } else {
                        WebPanel(workspace: workspace, site: web)
                    }
                } else if let spec {
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
            .id("\(web?.id ?? bot.id.uuidString)-\(workspace.language.rawValue)")
            .shellColumn("right", height: window.size.height)
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
                .id(workspace.language)
        }
    }
}

/// One of the window's three columns, exactly as tall as the window and drawn from its top. A
/// column whose content is taller (a long "Waiting on you" list) runs off the bottom instead of
/// making the row taller: a taller row is centred in the window, which pushed every column's top
/// and the input box's bottom off the window and left the rail's search bar floating mid-way.
private struct ShellColumn: ViewModifier {
    let name: String
    let height: CGFloat

    func body(content: Content) -> some View {
        content
            .frame(height: height, alignment: .top)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(RailTip.space)) } action: { frame in
                RootView.columnProbe?(name, frame)
            }
    }
}

extension View {
    fileprivate func shellColumn(_ name: String, height: CGFloat) -> some View {
        modifier(ShellColumn(name: name, height: height))
    }
}

extension RootView {
    /// Where each column ("rail", "chat", "right") lands in the window: the window snapshot
    /// checks that none is pushed off the window's edges.
    static var columnProbe: ((String, CGRect) -> Void)?

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
        HeadlessRun.isRequested()
    }

    /// A headless run never shows a Dock icon or takes focus from what you are doing.
    func applicationWillFinishLaunching(_ notification: Notification) {
        if Self.isHeadless {
            HeadlessRun.quiet(NSApp)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Self.isHeadless {
            for window in NSApp.windows { HeadlessRun.hide(window) }
            // `--language ja` (or CCB_LANGUAGE=ja): a snapshot in that language.
            if let language = HeadlessRun.language() { L10n.language = language }
        }
        if Snapshot.runIfRequested() || PluginCheck.runIfRequested() || ComponentShotRun.runIfRequested() || WebCaptureRun.runIfRequested() {
            return
        }
        // Started with `swift run`, the app has no bundle; make it a normal foreground app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        workspace.prepareLibrary()
        // Web AIs' page readers: the plugin's scripts, with the app's own copy as the fallback.
        workspace.web.bundledExtractors = WebSiteColumn.bundledExtractors
        WebExtractors.install(in: Workspace.Layout.plugins(in: workspace.root), bundled: WebSiteColumn.bundledExtractors)
        // Web captures: the newest few per site, none older than 30 days.
        let captures = workspace.web.capturesFolder
        Task.detached(priority: .utility) { WebCapturePack.prune(in: captures) }
        // A bot's link to a saved web conversation opens it in its site, where it was.
        ResultWindows.opensInApp = { [workspace] url in workspace.openSavedWebConversation(url) }
        // A question that was still waiting for its answer when the app quit: its page is read again.
        for site in WebSite.all { WebSession.readAgain(site, shelf: workspace.web) }
        // Preview cards show a picture of their page; a new picture redraws the chats.
        PageShotMaker.shared.install { [workspace] in workspace.objectWillChange.send() }
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
        guard let window = MainWindowProbe.window, window.isVisible,
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
        if let main = MainWindowProbe.window {
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
        // A bot on Codex keeps which Codex thread its session is next to its chats.
        CodexThreads.shared.folder = root.appending(path: "codex-threads")
        let launcher: AgentLauncher = { launch in
            if launch.engine == .codex {
                guard let executable = CodexCLI.locateNewest() else { throw AppError.codexNotFound }
                return try CodexAgentProcess.launcher(executable: executable)(launch)
            }
            guard let executable = locator.locate() else { throw AppError.claudeNotFound }
            return try ClaudeAgentProcess.launcher(executable: executable)(launch)
        }
        // Every bot's turn ends with the app's own check: no ending on a promise nothing will keep.
        let promiseCheck = PromiseCheck.checker(classify: PromiseCheck.claudeClassifier(locate: { locator.locate() }))
        let workspace = Workspace(
            root: root,
            builtInPlugins: ChatSurface.builtInPlugins,
            pluginHostScript: ChatSurface.pluginHostScript,
            validateClaudePart: { folder in
                guard let executable = locator.locate() else { return "claude not found." }
                return await ClaudePluginValidator.validate(folder, executable: executable)
            },
            checkCommand: Bundle.main.executablePath.map { "'\($0)' --check-plugin" },
            shotCommand: Bundle.main.executablePath.map { "'\($0)' --component-shot" },
            launcher: launcher
        ) { profile, store in
            let bot = Bot(profile: profile, idleInterval: idle, launcher: launcher, store: store)
            bot.promiseCheck = promiseCheck
            return bot
        }
        workspace.applyLanguage()
        return workspace
    }
}

enum AppError: LocalizedError {
    case claudeNotFound
    case codexNotFound

    var errorDescription: String? {
        switch self {
        case .claudeNotFound: L("The claude command was not found. Please install Claude Code first.")
        case .codexNotFound: L("The codex command was not found. Please install Codex first.")
        }
    }
}

/// Remembers the window the chat lands in, so "a picture of the main window" is that window and
/// never a result, review or settings window that happens to be as large, and the Dock finds it
/// again by what it holds rather than by its title or SwiftUI's name for it.
private struct MainWindowProbe: NSViewRepresentable {
    @MainActor static weak var window: NSWindow?

    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { MainWindowProbe.window = window }
        }
    }

    func makeNSView(context: Context) -> NSView { Probe() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Sends the window it lands in offscreen (a headless run's SwiftUI window).
private struct HiddenWindow: NSViewRepresentable {
    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { HeadlessRun.hide(window) }
        }
    }

    func makeNSView(context: Context) -> NSView { Probe() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
