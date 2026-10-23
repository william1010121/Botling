import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

/// `CCB_SNAPSHOT=/path/out.png swift run botling` draws the web chat surface with sample messages
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
        if let path = ProcessInfo.processInfo.environment["CCB_CHIBI_SNAPSHOT"] {
            drawChibiSheet(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_RAIL_SNAPSHOT"] {
            if ProcessInfo.processInfo.environment["CCB_RAIL_HERO"] != nil { drawHeroRail(to: path) } else { drawRail(to: path) }
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_RAIL_PINS_SNAPSHOT"] {
            drawRailPins(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_WINDOW_SNAPSHOT"] {
            drawWindow(to: path)
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
        if let path = ProcessInfo.processInfo.environment["CCB_LIMITS_SNAPSHOT"] {
            drawLimits(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_BOT_SETTINGS_SNAPSHOT"] {
            drawBotSettings(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_RELEASES_SNAPSHOT"] {
            drawReleases(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_SPEC_SNAPSHOT"] {
            drawSpec(to: path)
            return true
        }
        if let path = ProcessInfo.processInfo.environment["CCB_SHARE_SNAPSHOT"] {
            drawShare(to: path, blocked: ProcessInfo.processInfo.environment["CCB_SHARE_BLOCKED"] != nil)
            return true
        }
        if let (chat, path) = chatRequest() {
            drawChat(chat, to: path)
            return true
        }
        guard let path = ProcessInfo.processInfo.environment["CCB_SNAPSHOT"] else { return false }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let now = Date()
        // `CCB_SNAPSHOT_SAMPLE=design`: a /design request answered with a Claude Design's link.
        if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_SAMPLE"] == "design" {
            BotStore(directory: root.appending(path: "main")).save(messages: [
                ChatMessage(role: .user, text: "/design three looks for the folded left column, so I can pick one", date: now.addingTimeInterval(-300)),
                ChatMessage(role: .bot, text: """
                Here is a Claude Design with three directions side by side: [Folded left column](https://claude.ai/artifact/3f9c2a7e-5b14-4d0e-9a61-c8e2f04b7d35)

                - **A. Faces only**: 56 pt, a ring while a bot works, a dot when it waits on you
                - **B. Faces and unread counts**: the same strip with a badge per chat
                - **C. Icons by kind**: main bot, groups, projects and bots in four rows

                Open it on claude.ai to compare them or share the link. Tell me which one, and Maintainer builds it into the app.
                """, date: now.addingTimeInterval(-240)),
                ChatMessage(role: .user, text: "B, but keep A's ring while it works.", date: now.addingTimeInterval(-60)),
                ChatMessage(role: .bot, text: "Got it: B with A's working ring. I've handed it to Maintainer to build; it will say here when the new strip is in.", date: now.addingTimeInterval(-50)),
            ])
            draw(root: root, to: path)
            return true
        }
        // `CCB_SNAPSHOT_SAMPLE=heads`: a bot with two heads (Claude and Codex), each reply under
        // the head that wrote it, a hand-off line, and "Answer with" over the input box. Sample data.
        if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_SAMPLE"] == "heads" {
            let store = BotStore(directory: root.appending(path: "main"))
            store.save(heads: HeadsSettings(engines: [.claude, .codex]))
            func line(_ role: ChatMessage.Role, _ text: String, _ ago: TimeInterval, by engine: BotEngine? = nil, to: AnswerTarget? = nil, seen: [BotEngine]) -> ChatMessage {
                var message = ChatMessage(role: role, text: text, date: now.addingTimeInterval(-ago))
                message.engine = engine
                message.to = to
                message.seenBy = seen
                return message
            }
            store.save(messages: [
                ChatMessage(role: .divider, text: "SAMPLE DATA", date: now.addingTimeInterval(-700)),
                line(.user, "Fix the hover toolbar covering the card, and check it on the Board too", 600, seen: [.claude, .codex]),
                line(.bot, "I take the toolbar fix in chat.css. Fixed and merged in PR #5.", 500, by: .claude, seen: [.claude, .codex]),
                line(.bot, "I took the Board check: Board cards have four buttons, so the offset is one button short there. Told Claude.", 450, by: .codex, seen: [.claude, .codex]),
                ChatMessage(role: .divider, text: "Claude → Codex: review the diff of PR #5 for regressions", date: now.addingTimeInterval(-400)),
                line(.bot, "No regressions found.", 300, by: .codex, seen: [.claude, .codex]),
                line(.user, "Is the nit worth a follow-up?", 120, to: .codex, seen: [.codex]),
                line(.bot, "Yes, a small one: I can make the offset count the buttons.", 60, by: .codex, seen: [.codex]),
            ])
            draw(root: root, to: path)
            return true
        }
        // `CCB_SNAPSHOT_SAMPLE=rounds`: two heads discussing (Round 2 of 3 · Stop now), and the
        // card a review shows at its limit. Sample data.
        if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_SAMPLE"] == "rounds" {
            let store = BotStore(directory: root.appending(path: "main"))
            store.save(heads: HeadsSettings(engines: [.claude, .codex], answerWith: .both))
            var ask = ChatMessage(role: .user, text: "Should the release card read git or a JSON file?", date: now.addingTimeInterval(-600))
            var claude1 = ChatMessage(role: .bot, text: "Read git, and cache the last result so a refresh costs one `git log`.", date: now.addingTimeInterval(-540))
            claude1.engine = .claude
            var codex1 = ChatMessage(role: .bot, text: "A JSON file written on each merge is cheaper: no git on refresh.", date: now.addingTimeInterval(-480))
            codex1.engine = .codex
            var claude2 = ChatMessage(role: .bot, text: "The JSON goes stale when a merge happens outside the app.", date: now.addingTimeInterval(-420))
            claude2.engine = .claude
            let card = ChatMessage(role: .notice, text: "2 review rounds done. 1 blocking issue(s) left.\n\nCodex: the toolbar still overlaps at phone width.", date: now.addingTimeInterval(-60), choices: [
                Choice(label: "Keep it as is", detail: nil, recommended: true),
                Choice(label: "Fix it, one more round", detail: nil, recommended: false),
                Choice(label: "Let Codex fix it", detail: nil, recommended: false),
            ])
            store.save(messages: [
                ChatMessage(role: .divider, text: "SAMPLE DATA", date: now.addingTimeInterval(-700)),
                ask, claude1, codex1, claude2,
                ChatMessage(role: .divider, text: "Codex review 2 of 2: 1 blocking", date: now.addingTimeInterval(-90)),
            ])
            draw(root: root, to: path) { workspace in
                // Posted after loading: a saved app card is closed when the app starts.
                workspace.mainBot.post(card, unread: false)
                workspace.mainBot.showRoundsForSnapshot(RoundsProgress(kind: .discussion, round: 2, limit: 3))
            }
            return true
        }
        // `CCB_SNAPSHOT_SAMPLE=subagent`: a subagent's view (read only), still at work: its task
        // and a later message from its bot, each finished run of calls folded to "N steps" (a long
        // one, with a failed command, among them), the run under way in sight, its last call spinning.
        if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_SAMPLE"] == "subagent" {
            var subagent = Subagent(id: "toolu_review", description: "Review PR #7", type: "general-purpose",
                                    prompt: "Review the diff of PR #7 for regressions. Report blocking issues only.", startedAt: now.addingTimeInterval(-600))
            subagent.model = "sonnet"
            subagent.steps = [
                Step(id: "s1", kind: .tool, tool: "Bash", title: "Run git diff main...bot/web-gemini --stat", detail: "git diff main...bot/web-gemini --stat",
                     output: " Sources/ClaudeCodeBot/WebBot/WebBotView.swift | 84 +++++++---\n Sources/ClaudeCodeBotCore/WebBot.swift        | 31 ++++\n 2 files changed, 96 insertions(+), 19 deletions(-)", done: true),
                Step(id: "s2", kind: .tool, tool: "Read", title: "Read WebBotView.swift", detail: "/repo/Sources/ClaudeCodeBot/WebBot/WebBotView.swift", output: "import SwiftUI\nimport WebKit\n…", done: true),
            ] + ["WebBot.swift", "WebSites.swift", "Workspace+Web.swift", "WebTurn.swift", "WebBotStore.swift", "ChatSurface.swift"].enumerated().flatMap { index, file in
                [Step(id: "r\(index)", kind: .tool, tool: "Read", title: "Read \(file)", detail: "/repo/Sources/ClaudeCodeBotCore/\(file)", output: "import Foundation\n…", done: true),
                 Step(id: "g\(index)", kind: .tool, tool: "Grep", title: "Search \(file.split(separator: ".")[0]) in Tests", detail: "\(file.split(separator: ".")[0])  in /repo/Tests", output: "", done: true)]
            } + [
                Step(id: "f1", kind: .tool, tool: "Bash", title: "Run swift build --target ClaudeCodeBotCore", detail: "swift build --target ClaudeCodeBotCore",
                     output: "error: no such module 'WebKit'", failed: true, done: true),
                Step(id: "s3", kind: .text, title: "The view keeps one `WKWebsiteDataStore` for every site; checking whether that is meant.", done: true),
                Step(id: "s4", kind: .tool, tool: "Grep", title: "Search WKWebsiteDataStore", detail: "WKWebsiteDataStore", output: "WebBotView.swift:41", done: true),
                Step(id: "m1", kind: .message, tool: "SendMessage", title: "Also check the sign-in data store is per site.", done: true, at: now.addingTimeInterval(-240)),
            ] + ["WebBotView.swift", "WebBotStore.swift", "WebSites.swift", "Workspace+Web.swift", "WebBotTests.swift", "WebSitesTests.swift", "SettingsView.swift"].enumerated().map { index, file in
                Step(id: "p\(index)", kind: .tool, tool: "Read", title: "Read \(file)", detail: "/repo/\(file)", output: "…", done: true)
            } + [
                Step(id: "s5", kind: .tool, tool: "Bash", title: "Run swift test --filter WebBot", detail: "swift test --filter WebBot"),
            ]
            draw(root: root, to: path, subagent: subagent)
            return true
        }
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
        BotStore(directory: Workspace.Layout.mainBot(in: root)).save(messages: [
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

    /// `botling --snapshot "<chat name>" out.png`: the chat as this build draws it, with its
    /// pinned components (`--pins file.json` for others, `--board` for its Board).
    static func chatRequest() -> (String, String)? {
        let arguments = CommandLine.arguments
        guard let at = arguments.firstIndex(of: "--snapshot"), arguments.count > at + 2 else { return nil }
        return (arguments[at + 1], arguments[at + 2])
    }

    /// A real chat from `~/.claudecodebot`, copied first so nothing there is touched: the main bot
    /// ("Main bot"), Maintainer, or a project or bot by name.
    private static func drawChat(_ name: String, to path: String) {
        let data = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claudecodebot")
        let folder: URL?
        switch name.lowercased() {
        case "main bot", "main":
            folder = Workspace.Layout.mainBot(in: data)
        case "maintainer":
            folder = Workspace.Layout.bot(Workspace.maintainerID, in: data)
        default:
            let projects = (try? Data(contentsOf: Workspace.Layout.projectsFile(in: data)))
                .flatMap { try? JSONDecoder().decode([Workspace.Project].self, from: $0) } ?? []
            folder = projects.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
                .map { Workspace.Layout.bot($0.id, in: data) }
        }
        guard let folder, BotStore(directory: folder).hasChat else {
            FileHandle.standardError.write(Data("No chat called \"\(name)\" in \(data.path).\n".utf8))
            exit(1)
        }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let copy = BotStore(directory: Workspace.Layout.mainBot(in: root))
        BotStore(directory: folder).copyChat(to: copy)
        // `--pins file.json`: pins to draw instead of the chat's own (to look at them without pinning).
        let arguments = CommandLine.arguments
        if let at = arguments.firstIndex(of: "--pins"), arguments.count > at + 1 {
            copy.replacePins(with: URL(filePath: arguments[at + 1]))
        }
        // The components as installed, so cards and pins draw as they do in the app (a copy).
        let installed = Workspace.Layout.components(in: data)
        let components = Workspace.Layout.components(in: root)
        try? FileManager.default.createDirectory(at: components.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.copyItem(at: installed, to: components)
        draw(root: root, to: path, pins: true)
    }

    /// Draws the main bot's chat under `root` in an offscreen window, saves it as a PNG, quits.
    /// `pins`: with the chat's pinned components (chips; `--board` draws its Board instead).
    /// `prepare` adds to the chat once loaded (an app card saved open is closed at load).
    /// `CCB_BOT_LOOK=original`: bots with two heads drawn in the Original look (default Cute).
    static var look: BotLook {
        ProcessInfo.processInfo.environment["CCB_BOT_LOOK"].flatMap(BotLook.init(rawValue:)) ?? .cute
    }

    private static func draw(root: URL, to path: String, pins: Bool = false, subagent: Subagent? = nil, prepare: (Workspace) -> Void = { _ in }) {
        guard let page = ChatSurface.pageURL else { exit(1) }
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        prepare(workspace)
        let board = CommandLine.arguments.contains("--board")
        let json = if let watched = subagent {
            ChatPayload.make(subagent: watched, of: workspace.mainBot, components: workspace.components, avatar: AvatarImages.dataURL(.circle, eyes: .open)).json()
        } else {
            ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil, pins: pins ? workspace.pinContext(for: workspace.mainBot, board: board) : nil, specs: pins, look: look == .cute ? ChibiImages.look(for: .circle) : nil) { projectID in
                AvatarImages.dataURL(projectID == nil ? .circle : .triangle, eyes: .open)
            }.json()
        }

        // `CCB_SNAPSHOT_HEIGHT=900`: a shorter (or taller) window than 1300 points.
        let height = ProcessInfo.processInfo.environment["CCB_SNAPSHOT_HEIGHT"].flatMap(Double.init) ?? 1300
        let frame = NSRect(x: 0, y: 0, width: 760, height: height)
        let window = HeadlessRun.offscreenWindow(frame)
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

    /// `CCB_SHARE_SNAPSHOT=/path/out.png`: developer mode's /share in a chat, from sample
    /// features: the list, then a feature's checklist ready to open its pull request
    /// (`CCB_SHARE_BLOCKED=1`: one the privacy check stops).
    private static func drawShare(to path: String, blocked: Bool) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let now = Date()
        let reactions = CommunityShare.Feature(branch: "bot/pin-reactions", title: "Add emoji reactions to pinned messages", commits: 3, files: ["Web/src/pins.ts", "Web/src/pins.css", "Sources/ClaudeCodeBotCore/Pins.swift"], subjects: [])
        let search = CommunityShare.Feature(branch: "bot/chat-search", title: "Search inside a chat with Cmd-F", commits: 5, files: Array(repeating: "x", count: 7), subjects: [])
        let list = CommunityShare.listCard([reactions, search], base: "upstream/main")
        let feature = blocked ? search : reactions
        let checks: [CommunityShare.Check] = [
            .init(state: .ok, text: "Up to date with upstream/main"),
            blocked
                ? .init(state: .failed, text: "Privacy check: Sources/ClaudeCodeBotCore/Search.swift: an Anthropic API key; Web/src/search.ts: your home folder's path")
                : .init(state: .ok, text: "Privacy check: no keys, tokens or personal paths in the diff"),
            .init(state: .ok, text: "Your fork: mei-lin/ClaudeCodeBot"),
            .init(state: .ok, text: "Description drafted from its \(feature.commits) commits"),
            .init(state: .warning, text: "Label: community-feature, added when the pull request opens (made on william1010121/ClaudeCodeBot if it is missing); if GitHub refuses it, you are told"),
        ]
        let card = CommunityShare.checklistCard(feature, checks: checks, owner: "mei-lin")
        var picked = ChatMessage(role: .notice, text: list.text, date: now.addingTimeInterval(-20), choices: list.choices)
        picked.chosen = blocked ? 1 : 0
        BotStore(directory: Workspace.Layout.mainBot(in: root)).save(messages: [
            ChatMessage(role: .bot, text: "Merged **emoji reactions on pins** into main and kept its branch `bot/pin-reactions`. Type /share when you want to send it upstream.", date: now.addingTimeInterval(-60)),
            ChatMessage(role: .user, text: "/share", date: now.addingTimeInterval(-30)),
            picked,
        ])
        draw(root: root, to: path) { workspace in
            workspace.mainBot.notice(card.text, choices: card.ready ? [Choice(label: "Open pull request", recommended: true), Choice(label: "Not now")] : nil)
        }
    }

    /// `CCB_RAIL_SNAPSHOT=/path/out.png`: the left column open and folded side by side, from
    /// sample projects with unread lines, with the folded one's hover tip on Maintainer.
    /// `CCB_RAIL_SNAPSHOT=/path/out.png CCB_RAIL_HERO=1`: the open left column alone, 1060 pt tall,
    /// with one sample project (Botling) and a subagent at work under it: the README's hero
    /// picture takes its left column from this.
    private static func drawHeroRail(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let folder = root.appending(path: "code/botling")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = Workspace.Project(id: UUID(), name: "Botling", folder: folder, avatar: "square")
        try? JSONEncoder().encode([project]).write(to: Workspace.Layout.projectsFile(in: root))
        var subagent = Subagent(id: "toolu_1", description: "Fix login loop", prompt: "Fix it", startedAt: Date())
        subagent.name = "fix-login"
        BotStore(directory: Workspace.Layout.bot(project.id, in: root)).save(subagents: [subagent])
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let width = RailLayout.width(collapsed: false)
        let content = RailView(workspace: workspace, settings: SettingsNavigator())
            .frame(width: width, height: 1060)
            .foregroundStyle(Theme.text)
            .background(Theme.side)
            .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: width, height: 1060)
        let window = HeadlessRun.offscreenWindow(frame)
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

    /// `CCB_CHIBI_SNAPSHOT=/path/out.png`: the Claude and Codex characters (Bot look Cute) in
    /// each mood at the sizes the app draws them, on dark and on light, marked as sample data.
    private static func drawChibiSheet(to path: String) {
        let moods: [(Chibi.Mood, String)] = [(.work, "working"), (.normal, "awake"), (.think, "waiting"), (.sleep, "asleep")]
        func sheet(dark: Bool) -> some View {
            VStack(alignment: .leading, spacing: 14) {
                ForEach([BotEngine.claude, .codex], id: \.self) { head in
                    HStack(spacing: 18) {
                        Text(head.displayName).font(.system(size: 13, weight: .semibold)).frame(width: 52, alignment: .leading)
                        ForEach(moods, id: \.1) { mood, label in
                            VStack(spacing: 6) {
                                HStack(alignment: .bottom, spacing: 8) {
                                    ChibiHeadView(head: head, mood: mood, hat: .circle, size: 64)
                                    ChibiHeadView(head: head, mood: mood, hat: .square, size: 32)
                                    ChibiHeadView(head: head, mood: mood, size: 14)
                                }
                                Text(label).font(.system(size: 11))
                            }
                        }
                    }
                }
                HStack(spacing: 18) {
                    Text("Seen").font(.system(size: 13, weight: .semibold)).frame(width: 52, alignment: .leading)
                    HStack(spacing: 2) {
                        ChibiHeadView(head: .claude, size: 14)
                        ChibiHeadView(head: .codex, size: 14).opacity(0.32).grayscale(1)
                    }
                    Text("Claude seen, Codex not yet (14 pt)").font(.system(size: 11))
                    ForEach([AvatarKind.triangle, .star, .heart, .ghost, .moon], id: \.self) { kind in
                        ChibiHeadView(head: .claude, hat: kind, size: 32)
                    }
                }
            }
            .padding(20)
            .foregroundStyle(dark ? Color.white : Color.black)
            .background(dark ? Color(hex: 0x1E1E20) : Color.white)
            .environment(\.colorScheme, dark ? .dark : .light)
        }
        let content = VStack(alignment: .leading, spacing: 12) {
            Text("SAMPLE DATA").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
            sheet(dark: true)
            sheet(dark: false)
        }
        .padding(20)
        .frame(width: 1100, height: 640, alignment: .topLeading)
        .background(Color(hex: 0x0A0A0C))
        let frame = NSRect(x: 0, y: 0, width: 1100, height: 640)
        let window = HeadlessRun.offscreenWindow(frame)
        let host = NSHostingView(rootView: content)
        host.frame = frame
        window.contentView = host
        self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
            exit(0)
        }
    }

    private static func drawRail(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let samples: [(String, String, Int)] = [("Botling", "square", 0), ("Arbor", "triangle", 0), ("Morning news", "star", 5), ("Paper research", "hexagon", 0), ("Home server", "pill", 0)]
        let projects = samples.map { name, avatar, _ in
            Workspace.Project(id: UUID(), name: name, folder: root.appending(path: "code/\(name)"), avatar: avatar)
        }
        try? JSONEncoder().encode(projects).write(to: Workspace.Layout.projectsFile(in: root))
        for (project, sample) in zip(projects, samples) where sample.2 > 0 {
            BotStore(directory: Workspace.Layout.bot(project.id, in: root)).save(unread: sample.2)
        }
        BotStore(directory: Workspace.Layout.bot(Workspace.maintainerID, in: root)).save(unread: 2)
        // `CCB_SNAPSHOT_HEADS=1`: the first project has Claude and Codex ("C + X").
        if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_HEADS"] != nil {
            BotStore(directory: Workspace.Layout.bot(projects[0].id, in: root)).save(heads: HeadsSettings(engines: [.claude, .codex], answerWith: .claude))
            // Side-by-side regression fixture: both, Codex only, then Claude only.
            BotStore(directory: Workspace.Layout.bot(projects[1].id, in: root)).save(heads: .single(.codex))
        }
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
            .environment(\.botLook, look)
            .overlay(alignment: .topLeading) {
                if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_HEADS"] != nil {
                    Text("SAMPLE DATA").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint).offset(y: -20)
                }
            }
            .padding(30)
            .frame(width: 1140, height: 620)
            .foregroundStyle(Theme.text)
            .background(Color(hex: 0x0A0A0C))
            .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 1140, height: 620)
        let window = HeadlessRun.offscreenWindow(frame)
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

    /// `CCB_RAIL_PINS_SNAPSHOT=/path/out.png`: the left column with two bots pinned on top
    /// (open and folded), then searching it: "news" keeps two rows, "zzz" none.
    private static func drawRailPins(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let samples: [(String, String, String, Int)] = [
            ("Botling", "square", "botling", 0), ("Arbor", "triangle", "arbor", 0), ("Morning news", "star", "morning-news", 5),
            ("Paper research", "hexagon", "papers", 0), ("Home server", "pill", "home-server", 0), ("News digest", "circle", "digest", 1),
        ]
        let projects = samples.map { name, avatar, folder, _ in
            Workspace.Project(id: UUID(), name: name, folder: root.appending(path: "code/\(folder)"), avatar: avatar)
        }
        try? JSONEncoder().encode(projects).write(to: Workspace.Layout.projectsFile(in: root))
        for (project, sample) in zip(projects, samples) where sample.3 > 0 {
            BotStore(directory: Workspace.Layout.bot(project.id, in: root)).save(unread: sample.3)
        }
        var settings = AppSettings()
        // Pinned Home server first, then Arbor.
        settings.pinnedBots = [projects[4].id, projects[1].id]
        if let data = try? JSONEncoder().encode(settings) { try? data.write(to: root.appending(path: "settings.json")) }
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let pane = { (collapsed: Bool, query: String, label: String) in
            VStack(alignment: .leading, spacing: 8) {
                Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                HStack(spacing: 0) {
                    RailView(workspace: workspace, settings: SettingsNavigator(), collapsed: collapsed, query: query)
                        .frame(width: RailLayout.width(collapsed: collapsed))
                        .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
                    VStack(alignment: .leading, spacing: 10) {
                        RoundedRectangle(cornerRadius: 12).fill(Theme.bubble).frame(height: 34)
                        RoundedRectangle(cornerRadius: 12).fill(Theme.userBubble).frame(width: 60, height: 34).frame(maxWidth: .infinity, alignment: .trailing)
                        Spacer()
                        RoundedRectangle(cornerRadius: 10).stroke(Theme.chip).frame(height: 36)
                    }
                    .padding(EdgeInsets(top: 44, leading: 12, bottom: 16, trailing: 12))
                }
                .frame(width: collapsed ? 200 : 340, height: 640)
                .background(Theme.ground)
                .overlay(alignment: .topLeading) { RailChrome(collapsed: collapsed, tip: nil) {} }
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
        let content = HStack(alignment: .top, spacing: 30) {
            pane(false, "", "(a) Two bots pinned on top")
            pane(true, "", "(a) Folded: pinned first")
            pane(false, "news", "(b) Search \"news\"")
            pane(false, "zzz", "(b) Search \"zzz\"")
        }
            .padding(30)
            .frame(width: 1430, height: 740)
            .foregroundStyle(Theme.text)
            .background(Color(hex: 0x0A0A0C))
            .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 1430, height: 740)
        let window = HeadlessRun.offscreenWindow(frame)
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
        // `CCB_SETTINGS_LIMITS=1`: sample Claude and Codex subscription limits under Usage.
        if ProcessInfo.processInfo.environment["CCB_SETTINGS_LIMITS"] == "1" {
            let now = Date()
            let claude = RateLimits(fiveHour: RateLimitWindow(used: 0.42, resetsAt: now.addingTimeInterval(2 * 3600 + 780), seen: now),
                                    week: RateLimitWindow(used: 0.18, resetsAt: now.addingTimeInterval(3 * 86400), seen: now))
            let codex = RateLimits(fiveHour: RateLimitWindow(used: 0.07, resetsAt: now.addingTimeInterval(4 * 3600), seen: now),
                                   week: RateLimitWindow(used: 0.31, resetsAt: now.addingTimeInterval(5 * 86400), seen: now))
            try? JSONEncoder().encode(claude).write(to: root.appending(path: "rate-limits.json"))
            try? JSONEncoder().encode(codex).write(to: root.appending(path: "codex-rate-limits.json"))
        }
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        // `CCB_LANGUAGE=ja`: drawn in that language, picked in Settings → General.
        if let language = HeadlessRun.language() { workspace.setLanguage(language) }
        workspace.setBotLook(look)
        let navigator = SettingsNavigator()
        // CCB_SETTINGS_SECTION=plugins draws another section.
        navigator.section = ProcessInfo.processInfo.environment["CCB_SETTINGS_SECTION"].flatMap(SettingsSection.init(rawValue:)) ?? .doctor
        Task { @MainActor in
            // `CCB_SETTINGS_LATEST=0`: the real checks without npm's latest versions (no "is available").
            if ProcessInfo.processInfo.environment["CCB_SETTINGS_LATEST"] == "0" {
                workspace.doctor = DoctorModel(doctor: Doctor(latest: { _ in nil }))
            }
            await workspace.doctor.run(includeLatest: true)
            let frame = NSRect(x: 0, y: 0, width: SettingsWindow.size.width, height: ProcessInfo.processInfo.environment["CCB_SETTINGS_HEIGHT"].flatMap(Double.init) ?? SettingsWindow.size.height)
            let window = HeadlessRun.offscreenWindow(frame)
            // `CCB_SETTINGS_APPEARANCE=light`: drawn in light mode (the window follows either).
            let light = ProcessInfo.processInfo.environment["CCB_SETTINGS_APPEARANCE"] == "light"
            window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
            let host = NSHostingView(rootView: SettingsWindow(workspace: workspace, navigator: navigator, height: frame.height)
                .frame(width: frame.width, height: frame.height)
                .preferredColorScheme(light ? .light : .dark))
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

    /// `CCB_RELEASES_SNAPSHOT=/path/out.png`: Settings → Release planner with sample community PRs
    /// from a pretend gh (nothing reaches GitHub), as the repo's owner with two picked;
    /// `CCB_RELEASES_OWNER=0` draws it as someone who can only vote.
    private static func drawReleases(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let code = root.appending(path: "code/botling")
        try? FileManager.default.createDirectory(at: code, withIntermediateDirectories: true)
        let workspace = Workspace(root: root.appending(path: "ccb"), builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let project = workspace.addProject(folder: code, select: false)
        workspace.setDeveloperMode(true, project: project.id)
        let owner = ProcessInfo.processInfo.environment["CCB_RELEASES_OWNER"] != "0"
        let samples: [(Int, String, String, Int, Bool)] = [
            (41, "Voice input in the composer", "amy-chen", 12, false),
            (37, "Weekly spending report component", "kenji", 9, false),
            (44, "Dark/light theme switch", "lin.yu", 6, false),
            (39, "Drag files onto a bot to attach them", "mo", 3, false),
            (45, "日曆組件：顯示今天的行程", "pei", 1, true)
        ]
        let json = "[" + samples.map { number, title, login, votes, draft in
            #"{"number":\#(number),"title":"\#(title)","author":{"login":"\#(login)"},"url":"https://github.com/william1010121/ClaudeCodeBot/pull/\#(number)","isDraft":\#(draft),"reactionGroups":[{"content":"THUMBS_UP","users":{"totalCount":\#(votes)}}]}"#
        }.joined(separator: ",") + "]"
        let gitHub = GitHubCLI { arguments, _ in
            arguments.first == "pr" ? (true, json) : (true, #"{"viewerPermission":"\#(owner ? "ADMIN" : "READ")"}"#)
        }
        ReleasePlan(picked: owner ? [41, 37] : []).save(to: workspace.releasePlanFile)
        let planner = workspace.makeReleasePlanner(gitHub: gitHub)
        let navigator = SettingsNavigator()
        navigator.section = .releases
        Task { @MainActor in
            await planner.refresh()
            let frame = NSRect(x: 0, y: 0, width: SettingsWindow.size.width, height: SettingsWindow.size.height)
            let window = HeadlessRun.offscreenWindow(frame)
            let light = ProcessInfo.processInfo.environment["CCB_SETTINGS_APPEARANCE"] == "light"
            window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
            let host = NSHostingView(rootView: SettingsWindow(workspace: workspace, navigator: navigator, releasePlanner: planner).preferredColorScheme(light ? .light : .dark))
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
    /// `CCB_WINDOW_SNAPSHOT=/path/out.png`: the whole window (rail, chat, right panel) at
    /// 1280×820 on the main bot, with `CCB_WINDOW_WAITING` (default 14) things waiting on you.
    /// It prints the size the window's content needs and fails when that is bigger than the
    /// window: content that cannot shrink pushes every column off the window's edges.
    private static func drawWindow(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let count = ProcessInfo.processInfo.environment["CCB_WINDOW_WAITING"].flatMap(Int.init) ?? 14
        var projects = (0..<count).map { index in
            let code = root.appending(path: "code/project-\(index)")
            try? FileManager.default.createDirectory(at: code.appending(path: ".bot"), withIntermediateDirectories: true)
            try? Data("## Waiting on you\n- Project \(index): pick one of the two layouts for the settings page before I go on\n".utf8)
                .write(to: code.appending(path: ".bot/memory.md"))
            return Workspace.Project(id: UUID(), name: "project-\(index)", folder: code, avatar: "square")
        }
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Integration-only fixture: exercise the actual load-time own-project migration and
        // native sidebar together. All metadata/source markers are synthetic and temporary.
        if ProcessInfo.processInfo.environment["CCB_WINDOW_NAMING"] == "1" {
            let code = root.appending(path: "own-source/ClaudeCodeBot")
            let entry = code.appending(path: "Sources/ClaudeCodeBot/ClaudeCodeBotApp.swift")
            try? FileManager.default.createDirectory(at: entry.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data("struct BotlingApp: App {}".utf8).write(to: entry)
            try? Data(#"name: "botling", name: "ClaudeCodeBotCore""#.utf8).write(to: code.appending(path: "Package.swift"))
            let own = Workspace.Project(id: UUID(), name: "ClaudeCodeBot", folder: code, avatar: "square")
            projects.insert(own, at: 0)
            try? JSONEncoder().encode(AppSettings(developerProjectID: own.id)).write(to: root.appending(path: "settings.json"))
        }
        try? JSONEncoder().encode(projects).write(to: Workspace.Layout.projectsFile(in: root))
        // `CCB_WINDOW_TEAM=1`: saved teams from BOTH heads, a Codex child open, and a
        // settled Codex child in the native right panel; sample data, no engine launch.
        let teamSample = ProcessInfo.processInfo.environment["CCB_WINDOW_TEAM"] == "1"
        if teamSample {
            let store = BotStore(directory: Workspace.Layout.mainBot(in: root))
            store.save(heads: HeadsSettings(engines: [.claude, .codex]))
            let now = Date()
            var claude = Subagent(id: "sample-claude", description: "Claude: Review routing", type: "claude", prompt: "Review message routing (sample data)", status: .completed, startedAt: now)
            claude.endedAt = now
            store.save(subagents: [claude])
            var codex = Subagent(id: "sample-codex", description: "Codex: Check protocol", type: "codex", prompt: "Check subagent events (sample data)", status: .completed, startedAt: now)
            codex.endedAt = now
            codex.model = "gpt-6.1-sol"
            codex.steps = [Step(id: "sample-read", kind: .tool, tool: "Bash", title: "Read protocol schema", detail: "pwd", output: "/tmp/sample", done: true), Step(id: "sample-report", kind: .text, title: "Verified both child runs on the parent's stream (sample data).", done: true)]
            codex.result = codex.steps.last?.title
            var settled = Subagent(id: "sample-settled", description: "Codex: Check persistence", type: "codex", prompt: "Check saved team (sample data)", status: .completed, startedAt: now)
            settled.endedAt = now
            settled.settledAt = now
            BotStore(directory: store.directory.appending(path: "partner-codex")).save(subagents: [codex, settled])
        }
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        if ProcessInfo.processInfo.environment["CCB_WINDOW_NAMING"] == "1" {
            guard let own = workspace.projects.first, own.name == "botling", workspace.bot(for: own)?.name == "botling" else {
                FileHandle.standardError.write(Data("Own-project load/sidebar fixture did not migrate to lowercase botling.\n".utf8))
                exit(1)
            }
            print("PASS: isolated workspace loaded old own-project label as lowercase botling before sidebar rendering")
        }
        workspace.refreshWaiting()
        if teamSample { workspace.view(subagent: "sample-codex", of: workspace.mainBot) }
        // `CCB_WINDOW_WEB=gemini` (or `chatgpt`, `claude`): that web site picked, with sample
        // saved conversations, and one on each other site (the page itself is a placeholder: a
        // snapshot loads and signs into nothing).
        if let id = ProcessInfo.processInfo.environment["CCB_WINDOW_WEB"], let site = WebSite.all.first(where: { $0.id == id }) {
            for (index, other) in WebSite.all.enumerated() where other != site {
                sampleWebConversation(on: other, index: index, in: workspace)
            }
            sampleWebConversations(on: site, in: workspace)
            // `CCB_WINDOW_CAPTURE=recording` (or `saved`): its capture card, with sample captures.
            if let mode = ProcessInfo.processInfo.environment["CCB_WINDOW_CAPTURE"] { WebCaptureRun.sample(mode, on: site, in: workspace) }
        }
        let size = CGSize(width: 1280, height: 820)
        let content = RootView(workspace: workspace, settings: SettingsNavigator())
            .frame(minWidth: 980, minHeight: 620)
            .overlay(alignment: .bottomLeading) {
                if teamSample {
                    Text("SAMPLE DATA · two-head team").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.faint).padding(8).background(Theme.ground)
                }
            }
            .preferredColorScheme(.dark)
        var columns: [String: CGRect] = [:]
        RootView.columnProbe = { name, frame in columns[name] = frame }
        let frame = NSRect(origin: .zero, size: size)
        let window = HeadlessRun.offscreenWindow(frame)
        window.appearance = NSAppearance(named: .darkAqua)
        let host = NSHostingView(rootView: content)
        host.frame = frame
        window.contentView = host
        self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            let bounds = CGRect(origin: .zero, size: size)
            let off = columns.filter { !bounds.insetBy(dx: -0.5, dy: -0.5).contains($0.value) || $0.value.minY != 0 }
            for (name, column) in columns.sorted(by: { $0.key < $1.key }) {
                print("\(name): x \(Int(column.minX))…\(Int(column.maxX)), y \(Int(column.minY))…\(Int(column.maxY))")
            }
            print("waiting: \(workspace.waiting.count), window: \(Int(size.width))x\(Int(size.height)), " + (columns.count == 3 && off.isEmpty ? "columns fit" : "columns off the window: \(off.keys.sorted())"))
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
            }
            exit(columns.count == 3 && off.isEmpty ? 0 : 2)
        }
    }

    /// Three saved sample conversations on `site`, the newest open and the oldest settled (only
    /// under "Questions"), and a question just sent on a page left behind, still waiting.
    private static func sampleWebConversations(on site: WebSite, in workspace: Workspace) {
        let samples: [(id: String, title: String, turns: Int, minutesAgo: Double)] = [
            ("c0a9e1f27b3d", "CHANGELOG merge conflicts", 4, 60 * 26),
            ("7d21b0c4e9aa", "Release card every 60 s?", 2, 95),
            ("8f3a2c1d9e0b", "WKWebView or iframe?", 6, 3),
        ]
        for sample in samples {
            let url = site.conversationURL(sample.id)
            let turns = (0..<sample.turns).map { WebTurn(role: $0 % 2 == 0 ? .user : .assistant, text: "Sample message \($0 + 1)") }
            workspace.web.record(on: site, url: url, pageTitle: nil, reading: .read(title: sample.title, turns: turns), now: Date().addingTimeInterval(-sample.minutesAgo * 60))
        }
        workspace.select(site)
        if let newest = workspace.web.conversations(of: site).first {
            workspace.web.show(newest, of: site)
            workspace.web.record(on: site, url: newest.url, pageTitle: nil, reading: .read(title: newest.title, turns: (0..<6).map { WebTurn(role: $0 % 2 == 0 ? .user : .assistant, text: "Sample message \($0 + 1)") }), now: newest.savedAt ?? Date())
        }
        if let oldest = workspace.web.conversations(of: site).last {
            workspace.web.settle(oldest, of: site)
        }
        workspace.web.record(on: site, page: UUID(), url: site.startURL, pageTitle: nil, reading: .read(title: nil, turns: [
            WebTurn(role: .user, text: "Does a hidden WKWebView keep running?"),
        ]), settled: false)
    }

    /// One saved sample conversation on another site, so the column shows every site with a row.
    private static func sampleWebConversation(on site: WebSite, index: Int, in workspace: Workspace) {
        let titles = ["Changelog wording", "Load factor bounds", "Release checklist"]
        let turns = (0..<2).map { WebTurn(role: $0 % 2 == 0 ? .user : .assistant, text: "Sample message \($0 + 1)") }
        workspace.web.record(on: site, url: site.conversationURL("5a1e\(index)c0ffee"), pageTitle: nil,
                             reading: .read(title: titles[index % titles.count], turns: turns), now: Date().addingTimeInterval(-Double(40 + index * 30) * 60))
    }

    private static func drawRightPanel(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let code = root.appending(path: "code/botling")
        try? FileManager.default.createDirectory(at: code.appending(path: ".bot"), withIntermediateDirectories: true)
        try? Data("## In progress\n- v1.9.0: fold the right panel into a strip of icons\n".utf8).write(to: code.appending(path: ".bot/memory.md"))
        let project = Workspace.Project(id: UUID(), name: "Botling", folder: code, avatar: "square")
        try? JSONEncoder().encode([project]).write(to: Workspace.Layout.projectsFile(in: root))
        let store = BotStore(directory: Workspace.Layout.bot(project.id, in: root))
        // `CCB_SNAPSHOT_HEADS=1`: the bot has Claude and Codex (each head's state under Now).
        if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_HEADS"] != nil {
            store.save(heads: HeadsSettings(engines: [.claude, .codex], answerWith: .claude))
        }
        store.save(messages: [
            ChatMessage(role: .bot, text: "Done: [Sidebar option A](file:///tmp/a.html), [Sidebar collapse](file:///tmp/b.html), [Botling v1.7.1](file:///tmp/c.html)", date: Date())
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
            detail: RightPanelLayout.nowDetail(status: bot.statusText, doing: MemoryFile.items(at: bot.profile.memoryURL, section: .inProgress).first),
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
            .environment(\.botLook, look)
            .overlay(alignment: .topLeading) {
                if ProcessInfo.processInfo.environment["CCB_SNAPSHOT_HEADS"] != nil {
                    Text("SAMPLE DATA").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint).offset(y: -20)
                }
            }
            .padding(30)
            .frame(width: 1500, height: 920)
            .foregroundStyle(Theme.text)
            .background(Color(hex: 0x0A0A0C))
            .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 1500, height: 920)
        let window = HeadlessRun.offscreenWindow(frame)
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

    /// `CCB_LIMITS_SNAPSHOT=/path/out.png`: the gear's popover with Claude's limits and
    /// Codex's, each under its name. Sample data.
    private static func drawLimits(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let now = Date()
        let claude = RateLimits(fiveHour: RateLimitWindow(used: 0.47, resetsAt: now.addingTimeInterval(2 * 3600), seen: now), week: RateLimitWindow(used: 0.22, resetsAt: now.addingTimeInterval(4 * 86400), seen: now))
        let codex = RateLimits(fiveHour: nil, week: RateLimitWindow(used: 0.05, resetsAt: now.addingTimeInterval(5 * 86400), seen: now))
        try? JSONEncoder().encode(claude).write(to: root.appending(path: "rate-limits.json"))
        try? JSONEncoder().encode(codex).write(to: root.appending(path: "codex-rate-limits.json"))
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        let content = VStack(alignment: .leading, spacing: 6) {
            Text("SAMPLE DATA").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
            SettingsPopover(workspace: workspace, registry: workspace.plugins, open: { _ in })
        }
        .padding(16)
        .frame(width: 360, height: 620, alignment: .top)
        .foregroundStyle(Theme.text)
        .background(Theme.ground)
        .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 360, height: 620)
        let window = HeadlessRun.offscreenWindow(frame)
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

    /// `CCB_BOT_SETTINGS_SNAPSHOT=/path/out.png`: a sample bot's own settings, running on Codex
    /// (`CCB_BOT_ENGINE=claude` for Claude), marked as sample data.
    private static func drawBotSettings(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let folder = root.appending(path: "code/SampleProject")
        try? FileManager.default.createDirectory(at: folder.appending(path: ".bot"), withIntermediateDirectories: true)
        let store = BotStore(directory: root.appending(path: "bot"))
        // `CCB_BOT_ENGINE=both`: Claude and Codex in one bot.
        let engineName = ProcessInfo.processInfo.environment["CCB_BOT_ENGINE"] ?? ""
        store.save(engine: BotEngine(rawValue: engineName) ?? .codex)
        if engineName == "both" { store.save(heads: HeadsSettings(engines: [.claude, .codex])) }
        let bot = Bot(profile: .manager(name: "Sample project", avatar: "square", folder: folder), launcher: { _ in throw AppError.claudeNotFound }, store: store)
        let content = VStack(alignment: .leading, spacing: 0) {
            Text("SAMPLE DATA").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint).padding(.leading, 20).padding(.top, 10)
            SettingsPage(bot: bot) {}.padding(.horizontal, 20)
        }
        .frame(width: 380, height: 1100, alignment: .top)
        .foregroundStyle(Theme.text)
        .background(Theme.ground)
        .preferredColorScheme(.dark)
        let frame = NSRect(x: 0, y: 0, width: 380, height: 1100)
        let window = HeadlessRun.offscreenWindow(frame)
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
    /// (its card asks Allow and run), `edit` (done, with Edit spec's panel open), `filling` (built
    /// without a command, the bot that wrote the reply drawing it), `filled` (what it drew, under
    /// the reply). `CCB_SPEC_PANEL=1`
    /// opens the panel in any state; `CCB_SPEC_WIDE=1` spreads it wide; `CCB_SPEC_WINDOW=<width>`
    /// draws a whole window that wide.
    private static func drawSpec(to path: String) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let home = Workspace.Layout.mainBot(in: root)
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
        // `CCB_SPEC_FOLDER`: the project folder the spec panel shows (the sample still runs in `home`).
        let shownFolder = ProcessInfo.processInfo.environment["CCB_SPEC_FOLDER"] ?? home.path
        var spec = ComponentSpec(messageID: reply.id, name: "test-summary", about: "Pass and fail counts per test suite", folder: shownFolder, bots: ["Main bot"])
        spec.command = "swift test --parallel 2>&1 | python3 .bot/scripts/test-summary.py"
        spec.fields = [
            .init(name: "total", type: "int", by: .maintainer), .init(name: "passed", type: "int", by: .maintainer),
            .init(name: "failed", type: "int", by: .maintainer), .init(name: "seconds", type: "num", by: .maintainer),
            .init(name: "failures", type: "[suite, test, message]", by: .user),
        ]
        spec.samples = [
            .init(.reply, data: #"{"total":382,"passed":382,"failed":0,"seconds":41.2,"suites":[{"name":"WebBridgeTests","passed":112},{"name":"ChatStoreTests","passed":86}]}"#),
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
        spec.testRun = ComponentSpec.TestRun(command: spec.command!, folder: shownFolder)
        let state = ProcessInfo.processInfo.environment["CCB_SPEC_STATE"] ?? ""
        let filling = ["filling", "filled"].contains(state)
        let built = ["done", "done-ask", "edit"].contains(state) || filling
        switch state {
        case "filling", "filled":
            // No command: the bot that wrote the reply draws it with the reply's data.
            spec.status = .done
            spec.built = "test-summary"
            spec.command = nil
            spec.testRun = nil
            spec.questions = []
            spec.purpose = "每個測試套件通過幾個、失敗幾個，一眼看完"
            spec.filledBy = "Main bot"
            spec.conversation = [
                .init(kind: .event, text: "Sent to Maintainer to build the first version"),
                .init(kind: .maintainer, text: "做好了 test-summary：about.md 寫了資料格式，由 Main bot 照它的回覆填。"),
                .init(kind: .event, text: "test-summary added to Main bot"),
                .init(kind: .event, text: "Asked Main bot to fill it from its reply"),
            ]
            if state == "filled" {
                spec.filled = #"{"total":382,"passed":382,"failed":0,"seconds":41.2,"suites":[{"name":"WebBridgeTests","passed":112},{"name":"ChatStoreTests","passed":86},{"name":"MarkdownTests","passed":79}]}"#
                spec.conversation.append(.init(kind: .event, text: "Filled by Main bot"))
            }
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
                    command: spec.command!, folder: shownFolder,
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
            try? "Pass and fail counts per test suite.\n\(spec.command.map { "Command: \($0)" } ?? "Data: {total, passed, failed, seconds, suites: [{name, passed}]}")\n".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
            workspace.components.rescan()
            if state != "done-ask", let command = spec.command { workspace.componentCommands.approve(command, in: URL(filePath: shownFolder)) }
        }
        let panelOpen = state.isEmpty || state == "edit" || ProcessInfo.processInfo.environment["CCB_SPEC_PANEL"] == "1"
        if panelOpen { workspace.openSpec(spec.id, in: workspace.mainBot) }
        workspace.setSpecPanelWide(ProcessInfo.processInfo.environment["CCB_SPEC_WIDE"] == "1")
        let commands = ChatPayload.CommandContext(runs: workspace.componentCommands) { _ in URL(filePath: shownFolder) }
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
            let window = HeadlessRun.offscreenWindow(frame)
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
            // CCB_SNAPSHOT_JS='…': run this in the page a moment after it is drawn (to show a
            // tile hovered, a menu open, a panel resized), before the picture is taken.
            if let script = ProcessInfo.processInfo.environment["CCB_SNAPSHOT_JS"], !script.isEmpty {
                view.evaluateJavaScript("setTimeout(() => { \(script) }, 600)")
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
