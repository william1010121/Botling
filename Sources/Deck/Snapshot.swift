import AppKit
import DeckCore
import SwiftUI
import WebKit

/// `DECK_SNAPSHOT=/path/out.png swift run Deck` renders the avatars and a sample window to a PNG
/// and quits, so the look can be checked without clicking through the app.
@MainActor
enum Snapshot {
    static func runIfRequested() -> Bool {
        guard let path = ProcessInfo.processInfo.environment["DECK_SNAPSHOT"] else { return false }
        let root = FileManager.default.temporaryDirectory.appending(path: "deck-snapshot-\(UUID().uuidString)")
        let now = Date()
        BotStore(directory: root.appending(path: "main")).save(messages: [
            ChatMessage(role: .user, text: "blog 首頁加一個作品集區塊。", date: now.addingTimeInterval(-3600 * 11)),
            ChatMessage(role: .bot, text: "交給 blog-site。", date: now.addingTimeInterval(-3600 * 11 + 20)),
            ChatMessage(role: .bot, text: "做好了，[作品集區塊](https://example.com/portfolio)。", date: now.addingTimeInterval(-3600 * 10)),
            ChatMessage(role: .user, text: "NotchDo 現在怎樣？", date: now.addingTimeInterval(-30)),
            ChatMessage(role: .bot, text: "右側面板 7 成，下午接排程。", date: now)
        ])
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: { _ in throw DeckError.claudeNotFound }, store: store)
        }
        for name in ["NotchDo", "blog-site", "e3-notes"] {
            let folder = root.appending(path: "folders/\(name)")
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let project = workspace.addProject(folder: folder)
            if name == "blog-site" {
                try? "## 現在狀態\n等你選封面圖。\n\n## 等你決定的事\n- 40 篇舊文章沒有封面圖，怎麼處理？\n"
                    .write(to: project.notesFolder.appending(path: "memory.md"), atomically: true, encoding: .utf8)
            }
        }
        workspace.refreshWaiting()
        workspace.select(nil)

        let sheet = VStack(alignment: .leading, spacing: 24) {
            ForEach([EyeStyle.open, .happy, .closed], id: \.self) { eyes in
                HStack(spacing: 14) {
                    ForEach(AvatarKind.allCases, id: \.self) { kind in
                        AvatarView(kind: kind, size: 56, eyes: eyes)
                    }
                }
            }
            // ScrollView and TextField do not render here, so show the rows on their own too.
            VStack(spacing: 14) {
                MessageRow(message: {
                    var mine = ChatMessage(role: .user, text: "這張是什麼？")
                    mine.attachments = [Attachment(url: URL(filePath: "/Users/guoshengwei/tool/MacOSApp/TODO/prd/flow-4-lifecycle.png"))]
                    mine.replyTo = UUID()
                    mine.replyPreview = "右側面板 7 成，下午接排程。"
                    return mine
                }(), avatar: .circle)
                MessageRow(message: ChatMessage(role: .bot, text: """
                ## 今天的進度
                **NotchDo** 做到 7 成，卡在 `排程`。
                - 右側面板：好了
                - 錯誤狀態：做中
                | 專案 | 狀態 |
                |---|---|
                | blog-site | 等你 |
                | e3-notes | 睡著 |
                ![流程圖](file:///Users/guoshengwei/tool/MacOSApp/TODO/prd/flow-2-wish.png)
                """), avatar: .circle)
                ForEach(workspace.mainBot.messages) { MessageRow(message: $0, avatar: .circle) }
                MessageRow(message: ChatMessage(role: .relay, text: "首頁加一個作品集區塊。"), avatar: .triangle)
                MessageRow(
                    message: ChatMessage(role: .notice, text: "blog-site：40 篇舊文章沒有封面圖，怎麼處理？", choices: [
                        Choice(label: "用預設圖補上", detail: "今天做完", recommended: true),
                        Choice(label: "先留白", detail: "之後再說"),
                        Choice(label: "每篇生成一張", detail: "約 2 小時")
                    ], sourceID: UUID(), sourceMessageID: UUID()),
                    avatar: .circle,
                    sourceAvatar: .triangle,
                    onChoose: { _ in },
                    onOpenSource: {}
                )
                MessageRow(
                    message: {
                        var answered = ChatMessage(role: .bot, text: "要支援多肉植物嗎？", choices: [
                            Choice(label: "支援", detail: "多 1 天", recommended: true),
                            Choice(label: "先不要")
                        ])
                        answered.chosen = 0
                        return answered
                    }(),
                    avatar: .triangle,
                    onChoose: { _ in }
                )
            }
            .frame(width: 560)
            .padding(24)
            .background(Theme.ground)
            HStack(alignment: .top, spacing: 24) {
                RootView(workspace: workspace)
                    .frame(width: 1280, height: 520)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                DetailPanel(workspace: workspace, bot: workspace.mainBot, showingSettings: true)
                    .frame(width: 340, height: 520)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(32)
        .background(Color(hex: 0x050506))
        .environment(\.colorScheme, .dark)

        let renderer = ImageRenderer(content: sheet)
        renderer.scale = 1
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return true }
        try? png.write(to: URL(filePath: path))
        return true
    }
}

/// `DECK_COMPONENT_SNAPSHOT=/path/out.png` renders the 「choices」 template in a real web view
/// (twice: open, and picked), which the SwiftUI snapshot above cannot draw.
@MainActor
enum ComponentSnapshot {
    private static var window: NSWindow?
    private static var webView: WKWebView?
    private static var delegate: LoadWaiter?

    static func runIfRequested() -> Bool {
        guard let path = ProcessInfo.processInfo.environment["DECK_COMPONENT_SNAPSHOT"] else { return false }
        let library = ComponentLibrary(
            folder: FileManager.default.temporaryDirectory.appending(path: "deck-components-\(UUID().uuidString)"),
            launcher: { _ in throw DeckError.claudeNotFound }
        )
        let choices = [
            Choice(label: "用預設圖補上", detail: "今天做完", recommended: true),
            Choice(label: "先留白", detail: "之後再說"),
            Choice(label: "每篇生成一張", detail: "約 2 小時")
        ]
        // DECK_COMPONENT_TEMPLATE points at another template.html to draw instead.
        let template = ProcessInfo.processInfo.environment["DECK_COMPONENT_TEMPLATE"]
            .flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? library.template("choices") ?? ""
        let open = ComponentView.page(template: template, data: MessageRow.choicesData(choices, chosen: nil))
        let picked = ComponentView.page(template: template, data: MessageRow.choicesData(choices, chosen: nil, answer: "只做仙人掌"))
        let html = """
        <!doctype html><html><body style="margin:0;background:#1B1B1F;padding:16px;display:flex;flex-direction:column;gap:24px">
        <iframe srcdoc="\(escape(open))" style="border:0;width:440px;height:250px"></iframe>
        <iframe srcdoc="\(escape(picked))" style="border:0;width:440px;height:250px"></iframe>
        </body></html>
        """
        let frame = NSRect(x: 0, y: 0, width: 480, height: 580)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        let configuration = WKWebViewConfiguration()
        // The pages post to `deck`; give them somewhere to post.
        configuration.userContentController.add(Sink(), name: "deck")
        let view = WKWebView(frame: frame, configuration: configuration)
        window.contentView = view
        let waiter = LoadWaiter {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                view.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation,
                       let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(filePath: path))
                    }
                    exit(0)
                }
            }
        }
        view.navigationDelegate = waiter
        view.loadHTMLString(html, baseURL: nil)
        self.window = window
        self.webView = view
        self.delegate = waiter
        return true
    }

    private static func escape(_ html: String) -> String {
        html.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    private final class LoadWaiter: NSObject, WKNavigationDelegate {
        let done: () -> Void
        init(done: @escaping () -> Void) { self.done = done }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
    }

    private final class Sink: NSObject, WKScriptMessageHandler {
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
    }
}
