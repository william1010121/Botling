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

    /// `ClaudeCodeBot --snapshot "<chat name>" out.png`: the chat as this build draws it.
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
        for file in ["chat.json", "subagents.json"] {
            try? FileManager.default.copyItem(at: folder.appending(path: file), to: copy.appending(path: file))
        }
        draw(root: root, to: path)
    }

    /// Draws the main bot's chat under `root` in an offscreen window, saves it as a PNG, quits.
    private static func draw(root: URL, to path: String) {
        guard let page = ChatSurface.pageURL else { exit(1) }
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let json = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil) { projectID in
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
