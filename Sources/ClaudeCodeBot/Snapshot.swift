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
        if let (chat, path) = chatRequest() {
            drawChat(chat, to: path)
            return true
        }
        guard let path = ProcessInfo.processInfo.environment["CCB_SNAPSHOT"] else { return false }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-snapshot-\(UUID().uuidString)")
        let now = Date()
        let picture = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../docs/flowcharts/flow-4-lifecycle.png").standardizedFileURL
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

            Result: [Portfolio section](file:///tmp/portfolio.html)
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
        let view = WKWebView(frame: frame, configuration: configuration)
        handler.view = view
        window.contentView = view
        view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        self.window = window
        self.handler = handler
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
