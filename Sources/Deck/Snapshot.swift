import AppKit
import DeckCore
import SwiftUI
import WebKit

/// `DECK_SNAPSHOT=/path/out.png swift run Deck` draws the web chat surface with sample messages
/// (markdown, LaTeX, choices, a notice, a reply with a picture) in an offscreen window, saves it
/// as a PNG and quits, so the look can be checked without clicking through the app.
@MainActor
enum Snapshot {
    private static var window: NSWindow?
    private static var handler: Handler?

    static func runIfRequested() -> Bool {
        guard let path = ProcessInfo.processInfo.environment["DECK_SNAPSHOT"],
              let page = ChatSurface.pageURL else { return false }
        let root = FileManager.default.temporaryDirectory.appending(path: "deck-snapshot-\(UUID().uuidString)")
        let now = Date()
        let picture = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../prd/flow-4-lifecycle.png").standardizedFileURL
        let answered = UUID()
        var mine = ChatMessage(role: .user, text: "這張是什麼？順便算 $\\int_0^1 x^2\\,dx$", date: now.addingTimeInterval(-50))
        mine.attachments = [Attachment(url: picture)]
        mine.replyTo = answered
        mine.replyPreview = "右側面板 7 成，下午接排程。"
        BotStore(directory: root.appending(path: "main")).save(messages: [
            ChatMessage(id: answered, role: .bot, text: "右側面板 7 成，下午接排程。", date: now.addingTimeInterval(-3600 * 3)),
            mine,
            ChatMessage(role: .bot, text: """
            ## 算一下
            $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$
            softmax 的梯度是 $\\frac{\\partial L}{\\partial z_i} = p_i - y_i$；票價 $5 到 $10 不是公式。
            - **NotchDo**：右側面板好了
            - `排程`：做中

            | 專案 | 狀態 |
            |---|---|
            | blog-site | 等你 |

            成果：[作品集區塊](file:///tmp/portfolio.html)
            """, date: now.addingTimeInterval(-40)),
            ChatMessage(role: .notice, text: "blog-site：40 篇舊文章沒有封面圖，怎麼處理？", date: now.addingTimeInterval(-30), choices: [
                Choice(label: "用預設圖補上", detail: "今天做完", recommended: true),
                Choice(label: "先留白", detail: "之後再說")
            ], sourceID: UUID(), sourceMessageID: UUID()),
            ChatMessage(role: .divider, text: "交接 → Opus", date: now.addingTimeInterval(-20))
        ])
        let workspace = Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw DeckError.claudeNotFound }, store: store)
        }
        let json = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil) { projectID in
            AvatarImages.dataURL(projectID == nil ? .circle : .triangle, eyes: .open)
        }.json()

        let frame = NSRect(x: 0, y: 0, width: 760, height: 1300)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        let configuration = WKWebViewConfiguration()
        let handler = Handler(path: path, json: json, plugins: ChatSurface.setPluginsScript(workspace.plugins))
        configuration.userContentController.add(handler, name: "deck")
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        let view = WKWebView(frame: frame, configuration: configuration)
        handler.view = view
        window.contentView = view
        view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        self.window = window
        self.handler = handler
        return true
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
            view.evaluateJavaScript("\(plugins); deck.setState(\(json))")
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
