import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

/// `CCB_SNAPSHOT=/path/out.png swift run ClaudeCodeBot` draws the web chat surface with sample messages
/// (markdown, LaTeX, choices, a notice, a reply with a picture) in an offscreen window, saves it
/// as a PNG and quits, so the look can be checked without clicking through the app.
@MainActor
enum Snapshot {
    private static var window: NSWindow?
    private static var handler: Handler?

    static func runIfRequested() -> Bool {
        if let icon = ProcessInfo.processInfo.environment["CCB_ICON"] {
            drawIcon(to: icon)
        }
        if let path = ProcessInfo.processInfo.environment["CCB_CODEX_SNAPSHOT"] {
            drawCodex(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_RAIL_SNAPSHOT"] {
            drawRail(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_RIGHT_SNAPSHOT"] {
            drawRightPanel(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_SETTINGS_SNAPSHOT"] {
            drawSettings(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_SPEC_SNAPSHOT"] {
            drawSpec(to: path)
            return true
        }
        if let (chat, path) = chatRequest() {
            drawChat(chat, to: path)
            return true
        }
        guard let path = ProcessInfo.processInfo.environment["CCB_SNAPSHOT"] else { return false }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let now = Date()
        let picture = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../docs/flowcharts/flow-4-lifecycle.png").standardizedFileURL
        // A result page, so the sample shows it as a 「網頁預覽卡片」 card.
        let page = root.appending(path: "main/artifacts/portfolio.html")
        try? FileManager.default.createDirectory(at: page.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data("""
        <!doctype html><meta charset="utf-8"><body style="margin:0;font:28px -apple-system,sans-serif;background:#F6F4EF;color:#222">
        <header style="padding:56px 72px;background:#1F3B57;color:#fff"><h1 style="margin:0;font-size:64px">作品集</h1><p style="margin:12px 0 0;opacity:.8">Portfolio section · 3 projects</p></header>
        <main style="display:flex;gap:32px;padding:48px 72px">\(["NotchDo", "blog-site", "scheduling"].map { "<section style=\"flex:1;height:360px;border-radius:24px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:32px\"><h2 style=\"margin:0\">\($0)</h2></section>" }.joined())</main>
        """.utf8).write(to: page)
        let answered = UUID()
        var mine = ChatMessage(role: .user, text: "What is this? And work out $\\int_0^1 x^2\\,dx$", date: now.addingTimeInterval(-50))
        mine.attachments = [Attachment(url: picture)]
        mine.replyTo = answered
        mine.replyPreview = "Right panel 70% done, scheduling this afternoon."
        BotStore(directory: root.appending(path: "main")).save(messages: [
            ChatMessage(id: answered, role: .bot, text: "Right panel 70% done, scheduling this afternoon.", date: now.addingTimeInterval(-3600 * 3)),
            mine,
            ChatMessage(role: .bot, text: """
            ## Working it out
            $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$
            The softmax gradient is $\\frac{\\partial L}{\\partial z_i} = p_i - y_i$; ticket prices of $5 to $10 are not math.
            - **NotchDo**: right panel done
            - `scheduling`: in progress

            | Project | Status |
            |---|---|
            | blog-site | Waiting on you |

            Result: [Portfolio section](\(page.absoluteString))
            """, date: now.addingTimeInterval(-40)),
            ChatMessage(role: .notice, text: "blog-site: 40 old posts have no cover image. What should we do?", date: now.addingTimeInterval(-30), choices: [
                Choice(label: "Fill in with a placeholder image", detail: "Done today", recommended: true),
                Choice(label: "Leave it blank for now", detail: "Decide later")
            ], sourceID: UUID(), sourceMessageID: UUID()),
            ChatMessage(role: .divider, text: "Handoff → Opus", date: now.addingTimeInterval(-20))
        ])
        draw(root: root, to: path)
        return true
    }

    /// `ClaudeCodeBot --snapshot "<chat name>" out.png`: the chat as this build draws it, with its
    /// pinned components (`--pins file.json` for others, `--board` for its Board).
    static func chatRequest() -> (String, String)? {
        let arguments = CommandLine.arguments
        guard let at = arguments.firstIndex(of: "--snapshot"), arguments.count > at + 2 else { return nil }
        return (arguments[at + 1], arguments[at + 2])
    }

    static var isChatRequest: Bool { CommandLine.arguments.contains("--snapshot") }

    /// A real chat from `~/.claudecodebot`, copied first so nothing there is touched: the main bot
    /// ("Main bot"), Maintainer, or a project or bot by name.
    private static func drawChat(_ name: String, to path: String) {
        let data = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claudecodebot")
        let folder: URL?
        switch name.lowercased() {
        case "main bot", "main":
            folder = data.appending(path: "main")
        case "maintainer":
            folder = data.appending(path: "projects/\(Workspace.maintainerID.uuidString)")
        default:
            let projects = (try? Data(contentsOf: data.appending(path: "projects.json")))
                .flatMap { try? JSONDecoder().decode([Workspace.Project].self, from: $0) } ?? []
            folder = projects.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
                .map { data.appending(path: "projects/\($0.id.uuidString)") }
        }
        guard let folder, FileManager.default.fileExists(atPath: folder.appending(path: "chat.json").path) else {
            FileHandle.standardError.write(Data("No chat called \"\(name)\" in \(data.path).\n".utf8))
            exit(1)
        }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let copy = root.appending(path: "main")
        try? FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
        for file in ["chat.json", "subagents.json", "pins.json", "specs.json"] {
            try? FileManager.default.copyItem(at: folder.appending(path: file), to: copy.appending(path: file))
        }
        // `--pins file.json`: pins to draw instead of the chat's own (to look at them without pinning).
        let arguments = CommandLine.arguments
        if let at = arguments.firstIndex(of: "--pins"), arguments.count > at + 1 {
            try? FileManager.default.removeItem(at: copy.appending(path: "pins.json"))
            try? FileManager.default.copyItem(at: URL(filePath: arguments[at + 1]), to: copy.appending(path: "pins.json"))
        }
        // The components as installed, so cards and pins draw as they do in the app (a copy).
        let installed = data.appending(path: "plugins/ccb-components/components")
        let components = root.appending(path: "plugins/ccb-components/components")
        try? FileManager.default.createDirectory(at: components.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.copyItem(at: installed, to: components)
        draw(root: root, to: path, pins: true)
    }

    /// Draws the main bot's chat under `root` in an offscreen window, saves it as a PNG, quits.
    /// `pins`: with the chat's pinned components (chips; `--board` draws its Board instead).
    private static func draw(root: URL, to path: String, pins: Bool = false) {
        guard let page = ChatSurface.pageURL else { exit(1) }
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let board = CommandLine.arguments.contains("--board")
        let json = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil, pins: pins ? workspace.pinContext(for: workspace.mainBot, board: board) : nil, specs: pins) { projectID in
            AvatarImages.dataURL(projectID == nil ? .circle : .triangle, eyes: .open)
        }.json()

        let frame = NSRect(x: 0, y: 0, width: 760, height: 1300)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        let configuration = WKWebViewConfiguration()
        let handler = Handler(path: path, json: json, plugins: ChatSurface.setPluginsScript(workspace.plugins))
        configuration.userContentController.add(handler, name: "ccb")
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        configuration.setURLSchemeHandler(PreviewSchemeHandler.shared, forURLScheme: PagePreview.scheme)
        let view = WKWebView(frame: frame, configuration: configuration)
        handler.view = view
        window.contentView = view
        view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        self.window = window
        self.handler = handler
    }

    /// `CCB_CODEX_SNAPSHOT=/path/out.png`: the left column with Codex and a subagent in a review
    /// loop, a project's panel with its Codex reviews, and a report, from sample reviews.
    private static func drawCodex(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let folder = root.appending(path: "code/ClaudeCodeBot")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let projectID = UUID()
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let project = Workspace.Project(id: projectID, name: "ClaudeCodeBot", folder: folder, avatar: "square")
        try? JSONEncoder().encode([project]).write(to: root.appending(path: "projects.json"))
        let item = { (file: String, line: Int, severity: CodexSeverity, title: String) in
            CodexOutput.Item(file: file, line: line, severity: severity, title: title, scenario: "Two quick taps on Send start two runs; the second overwrites the first one's result.")
        }
        var loop = CodexReview(kind: .loop, ownerID: projectID, agent: "fix-login", title: "Codex review · fix-login", folder: folder.path, base: "main", note: "Stop the sign-in loop")
        loop.absorb(CodexOutput(summary: "Two real problems in the session handling.", findings: [
            item("Sources/ClaudeCodeBotCore/Codex.swift", 120, .high, "Token is never refreshed after the first expiry"),
            item("Sources/ClaudeCodeBotCore/GitDiff.swift", 60, .medium, "Session leaks on logout"),
            item("Web/src/main.ts", 17, .low, "Log line misspells the user id")
        ]))
        loop.markSent(Set(loop.findings.filter { $0.severity != .low }.map(\.id)))
        loop.absorb(CodexOutput(summary: "One left.", findings: [item("Sources/ClaudeCodeBotCore/Codex.swift", 122, .high, "Token is never refreshed after the first expiry")]))
        loop.markSent([loop.findings[0].id])
        loop.state = .fixing
        var single = CodexReview(kind: .single, ownerID: projectID, title: "Codex review · bot/codex", folder: folder.path, base: "main")
        single.absorb(CodexOutput(summary: "The loop logic holds up; two edge cases.", findings: [item("Sources/ClaudeCodeBotCore/CodexReview.swift", 150, .medium, "A skipped finding reported again stays skipped")]))
        single.state = .open
        CodexReviewStore(url: root.appending(path: "codex/reviews.json")).save([single, loop])
        let subagents = [Subagent(id: "toolu_1", description: "Fix login loop", prompt: "Fix it", startedAt: Date())]
        var named = subagents
        named[0].name = "fix-login"
        BotStore(directory: root.appending(path: "projects/\(projectID.uuidString)")).save(subagents: named)

        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        guard let bot = workspace.bot(for: project) else { exit(1) }
        let content = HStack(alignment: .top, spacing: 0) {
            RailView(workspace: workspace, settings: SettingsNavigator()).frame(width: 240)
            DetailPanel(workspace: workspace, bot: bot).frame(width: 340)
            CodexReportView(workspace: workspace, reviewID: loop.id) {}
                .padding(20).frame(width: 340).background(Theme.side)
            CodexReportView(workspace: workspace, reviewID: single.id)
                .padding(20).frame(width: 560).background(Theme.side)
        }
        .frame(width: 1480, height: 900)
        .foregroundStyle(Theme.text)
        .background(Theme.ground)
        .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 1480, height: 900)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        let host = NSHostingView(rootView: content)
        host.frame = frame
        window.contentView = host
        self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
            exit(0)
        }
    }

    /// `CCB_RAIL_SNAPSHOT=/path/out.png`: the left column open and folded side by side, from
    /// sample projects with unread lines, with the folded one's hover tip on Maintainer.
    private static func drawRail(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let samples: [(String, String, Int)] = [("ClaudeCodeBot", "square", 0), ("Arbor", "triangle", 0), ("Morning news", "star", 5), ("Paper research", "hexagon", 0), ("Home server", "pill", 0)]
        let projects = samples.map { name, avatar, _ in
            Workspace.Project(id: UUID(), name: name, folder: root.appending(path: "code/\(name)"), avatar: avatar)
        }
        try? JSONEncoder().encode(projects).write(to: root.appending(path: "projects.json"))
        for (project, sample) in zip(projects, samples) where sample.2 > 0 {
            BotStore(directory: root.appending(path: "projects/\(project.id.uuidString)")).save(unread: sample.2)
        }
        BotStore(directory: root.appending(path: "projects/\(Workspace.maintainerID.uuidString)")).save(unread: 2)
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        // Main bot's icon (36 + 40) and the gap (4), then half of Maintainer's.
        let tip = RailTip(title: workspace.maintainer.name, detail: RailLayout.tipDetail(status: "Done, click to see", unread: 2, waiting: false), midY: 36 + 40 + 4 + 20)
        let pane = { (collapsed: Bool) in
            HStack(spacing: 0) {
                RailView(workspace: workspace, settings: SettingsNavigator(), collapsed: collapsed)
                    .frame(width: RailLayout.width(collapsed: collapsed))
                    .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
                VStack(alignment: .leading, spacing: 10) {
                    RoundedRectangle(cornerRadius: 12).fill(Theme.bubble).frame(width: 180, height: 34)
                    RoundedRectangle(cornerRadius: 12).fill(Theme.userBubble).frame(width: 120, height: 34).frame(maxWidth: .infinity, alignment: .trailing)
                    RoundedRectangle(cornerRadius: 12).fill(Theme.bubble).frame(height: 64)
                    Spacer()
                    RoundedRectangle(cornerRadius: 10).stroke(Theme.chip).frame(height: 36)
                }
                .padding(EdgeInsets(top: 44, leading: 16, bottom: 16, trailing: 16))
            }
            .frame(width: 520, height: 560)
            .background(Theme.ground)
            .overlay(alignment: .topLeading) { RailChrome(collapsed: collapsed, tip: collapsed ? tip : nil) {} }
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        let content = HStack(spacing: 40) { pane(false); pane(true) }
            .padding(30)
            .frame(width: 1140, height: 620)
            .foregroundStyle(Theme.text)
            .background(Color(hex: 0x0A0A0C))
            .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 1140, height: 620)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        let host = NSHostingView(rootView: content)
        host.frame = frame
        window.contentView = host
        self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
            exit(0)
        }
    }

    /// `CCB_SETTINGS_SNAPSHOT=/path/out.png`: the settings window at Doctor, after the real
    /// checks of this Mac's Claude Code and Codex (latest versions included) have run.
    private static func drawSettings(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let navigator = SettingsNavigator()
        // CCB_SETTINGS_SECTION=plugins draws another section.
        navigator.section = ProcessInfo.processInfo.environment["CCB_SETTINGS_SECTION"].flatMap(SettingsSection.init(rawValue:)) ?? .doctor
        Task { @MainActor in
            await workspace.doctor.run(includeLatest: true)
            let frame = NSRect(x: 0, y: 0, width: 760, height: 600)
            let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: .darkAqua)
            let host = NSHostingView(rootView: SettingsWindow(workspace: workspace, navigator: navigator).preferredColorScheme(.dark))
            host.frame = frame
            window.contentView = host
            self.window = window
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
                exit(0)
            }
        }
    }

    /// `CCB_RIGHT_SNAPSHOT=/path/out.png`: the right panel open and folded side by side, for a
    /// sample project with results and settled subagents, with the folded one's hover tip on the
    /// face and its Results popped out (drawn in place, as a popover is not in the picture).
    private static func drawRightPanel(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let code = root.appending(path: "code/ClaudeCodeBot")
        try? FileManager.default.createDirectory(at: code.appending(path: ".bot"), withIntermediateDirectories: true)
        try? Data("## In progress\n- v1.9.0: fold the right panel into a strip of icons\n".utf8).write(to: code.appending(path: ".bot/memory.md"))
        let project = Workspace.Project(id: UUID(), name: "ClaudeCodeBot", folder: code, avatar: "square")
        try? JSONEncoder().encode([project]).write(to: root.appending(path: "projects.json"))
        let store = BotStore(directory: root.appending(path: "projects/\(project.id.uuidString)"))
        store.save(messages: [
            ChatMessage(role: .bot, text: "Done: [Sidebar option A](file:///tmp/a.html), [Sidebar collapse](file:///tmp/b.html), [ClaudeCodeBot v1.7.1](file:///tmp/c.html)", date: Date())
        ])
        store.save(subagents: ["Fix choices block not rendering", "Fix markdown table column widths", "Design collapsible sidebar options", "Fix duplicate decision cards"].enumerated().map { index, title in
            var subagent = Subagent(id: "s\(index)", description: title, prompt: title, status: .completed)
            subagent.endedAt = Date()
            subagent.settledAt = Date()
            return subagent
        })
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        workspace.select(project.id)
        let bot = workspace.selectedBot
        let tip = RightTip(
            title: bot.name,
            detail: RightPanelLayout.nowDetail(status: bot.statusText, doing: MemoryFile.items(at: bot.profile.memoryURL, section: "In progress").first),
            color: bot.statusColor,
            midY: 36 + 20
        )
        let chat = VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 12).fill(Theme.userBubble).frame(width: 220, height: 34).frame(maxWidth: .infinity, alignment: .trailing)
            RoundedRectangle(cornerRadius: 12).fill(Theme.bubble).frame(height: 120)
            RoundedRectangle(cornerRadius: 12).fill(Theme.bubble).frame(height: 64)
            Spacer()
            RoundedRectangle(cornerRadius: 22).stroke(Theme.chip).frame(height: 44)
        }
        .padding(EdgeInsets(top: 44, leading: 16, bottom: 16, trailing: 16))
        let pane = { (collapsed: Bool) in
            HStack(spacing: 0) {
                chat
                Group {
                    if collapsed {
                        RightStrip(workspace: workspace, bot: bot, group: nil, tip: .constant(nil)) {} openSettings: {}
                    } else {
                        DetailPanel(workspace: workspace, bot: bot)
                    }
                }
                .frame(width: RightPanelLayout.width(collapsed: collapsed))
                .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).opacity(collapsed ? 1 : 0) }
            }
            .frame(width: 700, height: 860)
            .background(Theme.ground)
            .overlay(alignment: .topTrailing) { RightChrome(collapsed: collapsed, tip: collapsed ? tip : nil) {} }
            .overlay(alignment: .topTrailing) {
                if collapsed {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Results").font(.system(size: 12)).foregroundStyle(Theme.faint)
                        ForEach(bot.results, id: \.self) { chip in
                            Text(chip.label).fontWeight(.semibold).lineLimit(1)
                                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.selected))
                        }
                    }
                    .padding(12)
                    .frame(width: 300)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.tipLine))
                    .padding(.trailing, RightPanelLayout.collapsedWidth + 10)
                    .padding(.top, 260)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        let content = HStack(spacing: 40) { pane(false); pane(true) }
            .padding(30)
            .frame(width: 1500, height: 920)
            .foregroundStyle(Theme.text)
            .background(Color(hex: 0x0A0A0C))
            .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 1500, height: 920)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        let host = NSHostingView(rootView: content)
        host.frame = frame
        window.contentView = host
        self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
            exit(0)
        }
    }

    /// `CCB_SPEC_SNAPSHOT=/path/out.png` ("Make into component"): a sample chat whose test-run
    /// reply has its spec chip (and a later reply with a bot's suggestion chip) beside the spec
    /// workspace open in the right panel, with Maintainer's draft, a question and a test run to
    /// allow. `CCB_SPEC_STATE` draws it later on, the chat alone: `building` (the chip says
    /// Building…), `done` (the component under the reply, its command allowed and run), `done-ask`
    /// (its card asks Allow and run), `edit` (done, with Edit spec's panel open). `CCB_SPEC_PANEL=1`
    /// opens the panel in any state; `CCB_SPEC_WIDE=1` spreads it wide; `CCB_SPEC_WINDOW=<width>`
    /// draws a whole window that wide.
    private static func drawSpec(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let home = root.appending(path: "main")
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let now = Date()
        var reply = ChatMessage(role: .bot, text: "測試全部跑完了：382 個測試，0 個失敗，共 41.2 秒。WebBridgeTests 112、ChatStoreTests 86、MarkdownTests 79，全部通過。", date: now.addingTimeInterval(-120))
        reply.steps = [Step(id: "1", kind: .tool, tool: "Bash", title: "Run swift test", detail: "swift test --parallel", output: "382 passed", done: true)]
        let later = ChatMessage(role: .bot, text: "README 的安裝步驟還寫 1.7，我先列出要改的三個地方給你看。", date: now.addingTimeInterval(-30))
        let store = BotStore(directory: home)
        store.save(messages: [
            ChatMessage(role: .user, text: "跑一下全部測試，跟我說結果。", date: now.addingTimeInterval(-180)),
            reply,
            ChatMessage(role: .user, text: "好，那順便看一下 README。", date: now.addingTimeInterval(-60)),
            later,
        ])
        var spec = ComponentSpec(messageID: reply.id, name: "test-summary", about: "Pass and fail counts per test suite", folder: home.path, bots: ["Main bot"])
        spec.command = "swift test --parallel 2>&1 | python3 .bot/scripts/test-summary.py"
        spec.fields = [
            .init(name: "total", type: "int", by: .maintainer), .init(name: "passed", type: "int", by: .maintainer),
            .init(name: "failed", type: "int", by: .maintainer), .init(name: "seconds", type: "num", by: .maintainer),
            .init(name: "failures", type: "[suite, test, message]", by: .user),
        ]
        spec.samples = [
            .init(label: "This reply", data: #"{"total":382,"passed":382,"failed":0,"seconds":41.2,"suites":[{"name":"WebBridgeTests","passed":112},{"name":"ChatStoreTests","passed":86}]}"#),
            .init(label: "Failing run", data: #"{"total":382,"passed":380,"failed":2,"seconds":41.2,"failures":[{"suite":"WebBridgeTests","test":"testDropOrder"}]}"#),
            .init(label: "Empty", data: "null"),
        ]
        spec.similar = "build-status"
        spec.origins = ["command": .user, "fields": .maintainer, "about": .maintainer, "name": .maintainer]
        spec.questions = [.init(id: "refresh", key: "refresh", text: "測試要跑 40 秒左右：每次顯示都重跑，還是按 ↻ 才跑？", options: [.init(label: "按 ↻ 才跑", value: "manual"), .init(label: "每次顯示都跑", value: "shown")], suggested: 0)]
        spec.conversation = [
            .init(kind: .maintainer, text: "其他欄位我照這則回覆填好了，只剩一件事要你決定。"),
            .init(kind: .user, text: "失敗的測試要列出名字。"),
            .init(kind: .event, text: "You edited Command · swift test --parallel 2>&1 | python3 …"),
        ]
        spec.draft = 2
        spec.opened = true
        spec.asked = true
        spec.testRun = ComponentSpec.TestRun(command: spec.command!, folder: home.path)
        let state = ProcessInfo.processInfo.environment["CCB_SPEC_STATE"] ?? ""
        let built = ["done", "done-ask", "edit"].contains(state)
        switch state {
        case "building":
            spec.status = .building
            spec.questions = []
            spec.conversation = [.init(kind: .event, text: "Sent to Maintainer to build the first version")]
        case "done", "done-ask", "edit":
            spec.status = .done
            spec.built = "test-summary"
            spec.questions = []
            spec.conversation = [
                .init(kind: .event, text: "Sent to Maintainer to build the first version"),
                .init(kind: .maintainer, text: "照這則回覆做好了 test-summary：每次按 ↻ 跑 swift test，列出通過與失敗的數字。"),
                .init(kind: .event, text: "test-summary added to Main bot"),
            ]
            spec.origins = ["command": .maintainer, "fields": .maintainer, "about": .maintainer, "name": .maintainer]
            spec.fields[4].by = .maintainer
            if state != "done-ask" {
                spec.testRun = ComponentSpec.TestRun(
                    command: spec.command!, folder: home.path,
                    output: #"{"total":382,"passed":380,"failed":2,"seconds":41.2,"failures":[{"suite":"WebBridgeTests","test":"testDropOrder"},{"suite":"ChatStoreTests","test":"testMergeOnSave"}]}"#,
                    ranAt: now.addingTimeInterval(-20), matches: true
                )
            }
        default:
            break
        }
        var suggestion = ComponentSpec(messageID: later.id, name: "readme-check", about: "What in README is out of date", folder: home.path, bots: ["Main bot"])
        suggestion.suggestedBy = "Main bot"
        store.save(specs: [spec, suggestion])
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        if built {
            // The component Maintainer built, in the library; its command allowed unless asked.
            let folder = workspace.components.folder.appending(path: "test-summary")
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? snapshotTestSummary.write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
            try? "Pass and fail counts per test suite.\nCommand: \(spec.command!)\n".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
            workspace.components.rescan()
            if state != "done-ask" { workspace.componentCommands.approve(spec.command!, in: home) }
        }
        let panelOpen = state.isEmpty || state == "edit" || ProcessInfo.processInfo.environment["CCB_SPEC_PANEL"] == "1"
        if panelOpen { workspace.openSpec(spec.id, in: workspace.mainBot) }
        workspace.setSpecPanelWide(ProcessInfo.processInfo.environment["CCB_SPEC_WIDE"] == "1")
        let commands = ChatPayload.CommandContext(runs: workspace.componentCommands) { _ in home }
        let chatJSON = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil, commands: commands, specs: true, openSpec: workspace.openSpecID) { projectID in
            AvatarImages.dataURL(projectID == nil ? .circle : .triangle, eyes: .open)
        }.json()
        guard let specJSON = workspace.specPayload(spec.id)?.json(), let page = ChatSurface.pageURL else { exit(1) }
        let height: CGFloat = 900
        // `CCB_SPEC_WINDOW=1000`: the whole window that wide, its columns split as the app splits
        // them (the rail as a plain column, the Chat | Board bar above the chat).
        let windowWidth = ProcessInfo.processInfo.environment["CCB_SPEC_WINDOW"].flatMap(Double.init)
        let rail: CGFloat = windowWidth == nil ? 0 : CGFloat(RailLayout.expandedWidth)
        let wanted = RightPanelLayout.specWidth(wide: workspace.specPanelWide)
        let panelWidth = panelOpen ? CGFloat(windowWidth.map { RightPanelLayout.columns(window: $0, rail: Double(rail), right: wanted).right } ?? wanted) : 0
        let chatWidth = windowWidth.map { CGFloat($0) - rail - panelWidth } ?? 640
        let bar: NSImage? = windowWidth == nil ? nil : {
            let renderer = ImageRenderer(content: BoardSwitch(board: false) { _ in }
                .padding(.top, BoardSwitch.barTop).padding(.bottom, BoardSwitch.barBottom)
                .frame(width: chatWidth).background(Theme.ground).preferredColorScheme(.dark))
            renderer.scale = 2
            return renderer.nsImage
        }()
        let barHeight = bar?.size.height ?? 0
        var shots: [Int: NSImage] = [:]
        let finish = {
            guard let chat = shots[0], let panel = panelOpen ? shots[1] : NSImage() else { return }
            let size = NSSize(width: rail + chatWidth + panelWidth, height: height)
            let image = NSImage(size: size)
            image.lockFocus()
            NSColor(red: 0.055, green: 0.055, blue: 0.063, alpha: 1).setFill()
            NSRect(origin: .zero, size: size).fill()
            if rail > 0 {
                NSColor(red: 0.075, green: 0.075, blue: 0.085, alpha: 1).setFill()
                NSRect(x: 0, y: 0, width: rail, height: height).fill()
            }
            chat.draw(in: NSRect(x: rail, y: 0, width: chatWidth, height: height - barHeight))
            bar?.draw(in: NSRect(x: rail, y: height - barHeight, width: chatWidth, height: barHeight))
            if panelOpen {
                panel.draw(in: NSRect(x: rail + chatWidth, y: 0, width: panelWidth, height: height))
                NSColor(red: 0.137, green: 0.137, blue: 0.153, alpha: 1).setFill()
                NSRect(x: rail + chatWidth, y: 0, width: 1, height: height).fill()
            }
            image.unlockFocus()
            if let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(filePath: path))
            }
            exit(0)
        }
        for (index, width, url, script) in [
            (0, chatWidth, page, "\(ChatSurface.setPluginsScript(workspace.plugins)); ccb.setState(\(chatJSON))"),
            (1, panelWidth, URLComponents(url: page, resolvingAgainstBaseURL: false).flatMap { parts -> URL? in
                var parts = parts
                parts.queryItems = [URLQueryItem(name: "spec", value: "1")]
                return parts.url
            } ?? page, "document.body.style.background='#141417'; ccb.setSpec(\(specJSON))"),
        ] where index == 0 || panelOpen {
            let frame = NSRect(x: 0, y: 0, width: width, height: index == 0 ? height - barHeight : height)
            let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
            let shot = Shot(script: script) { image in
                shots[index] = image
                finish()
            }
            let view = SpecPanelView.makeWebView(handler: shot)
            view.frame = frame
            shot.view = view
            window.contentView = view
            view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/"))
            keep.append((window, shot))
        }
    }

    private static var keep: [(NSWindow, Shot)] = []

    /// The snapshot's built test-summary component: counts, then the failures by name.
    private static let snapshotTestSummary = """
    <style>
    .t{font:13px -apple-system,"PingFang TC",sans-serif;color:#EDEDF0;background:#141417;border:1px solid #2A2A31;border-radius:12px;padding:12px 14px}
    .n{display:flex;gap:18px;align-items:baseline}.n b{font-size:22px;font-weight:600}.n span{color:#8E8E96;font-size:12px;margin-left:4px}
    .ok{color:#7FD1A4}.bad{color:#F08A8A}.f{margin-top:10px;border-top:1px solid #2A2A31;padding-top:8px}
    .r{display:flex;gap:8px;padding:2px 0;font-size:12px}.s{color:#8E8E96;min-width:120px}
    </style><div class="t" id="t"></div><script>
    (() => {
      const d = window.ccb.data || {};
      const t = document.getElementById('t');
      const n = document.createElement('div'); n.className = 'n';
      const add = (v, label, cls) => { const x = document.createElement('div'); const b = document.createElement('b'); b.textContent = v; if (cls) b.className = cls; const s = document.createElement('span'); s.textContent = label; x.append(b, s); n.append(x); };
      add(d.passed ?? '–', 'passed', 'ok'); add(d.failed ?? '–', 'failed', d.failed ? 'bad' : ''); add(d.total ?? '–', 'total'); add((d.seconds ?? '–') + 's', 'time');
      t.append(n);
      if ((d.failures || []).length) {
        const f = document.createElement('div'); f.className = 'f';
        for (const x of d.failures) { const r = document.createElement('div'); r.className = 'r'; const s = document.createElement('span'); s.className = 's'; s.textContent = x.suite; const m = document.createElement('span'); m.textContent = x.test; r.append(s, m); f.append(r); }
        t.append(f);
      }
    })();
    </script>
    """

    /// A page that, once ready, runs `script` and gives back a picture of itself.
    private final class Shot: NSObject, WKScriptMessageHandler {
        let script: String
        let done: (NSImage) -> Void
        weak var view: WKWebView?
        private var taken = false

        init(script: String, done: @escaping (NSImage) -> Void) {
            self.script = script
            self.done = done
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !taken, (message.body as? [String: Any])?["type"] as? String == "ready", let view else { return }
            taken = true
            view.evaluateJavaScript(script)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [done] in
                view.takeSnapshot(with: nil) { image, _ in
                    if let image { done(image) } else { exit(1) }
                }
            }
        }
    }

    /// `CCB_ICON=/path/icon.png`: the app icon (the main bot's face on a dark tile), 1024 px.
    private static func drawIcon(to path: String) -> Never {
        let tile = ZStack {
            RoundedRectangle(cornerRadius: 186, style: .continuous)
                .fill(LinearGradient(colors: [Color(hex: 0x24242B), Color(hex: 0x111114)], startPoint: .top, endPoint: .bottom))
                .frame(width: 824, height: 824)
            AvatarView(kind: .circle, size: 500, eyes: .open)
        }
        .frame(width: 1024, height: 1024)
        let renderer = ImageRenderer(content: tile)
        renderer.scale = 1
        if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(filePath: path))
        }
        exit(0)
    }

    private final class Handler: NSObject, WKScriptMessageHandler {
        let path: String
        let json: String
        let plugins: String
        weak var view: WKWebView?

        init(path: String, json: String, plugins: String) {
            self.path = path
            self.json = json
            self.plugins = plugins
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard (message.body as? [String: Any])?["type"] as? String == "ready", let view else { return }
            view.evaluateJavaScript("\(plugins); ccb.setState(\(json))")
            // CCB_SNAPSHOT_STEP_IMAGES=1: unfold the last tool call that gave back a picture and
            // scroll to it, to check how its OUT box looks.
            if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_STEP_IMAGES"] == "1" {
                view.evaluateJavaScript("""
                setTimeout(() => {
                  const line = [...document.querySelectorAll('.step.tool')].filter((l) => l.querySelector('img.step-image')).pop();
                  if (!line) return;
                  const list = line.closest('.steps');
                  if (list && !list.classList.contains('open')) list.querySelector('.steps-toggle')?.click();
                  if (!line.classList.contains('open')) line.querySelector('.step-head')?.click();
                  setTimeout(() => line.scrollIntoView({ block: 'center' }), 300);
                }, 500)
                """)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [path] in
                view.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation,
                       let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(filePath: path))
                    }
                    exit(0)
                }
            }
        }
    }
}
