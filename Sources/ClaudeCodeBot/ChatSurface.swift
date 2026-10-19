import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

/// Files and reply targets waiting in each bot's composer, kept while you switch between bots.
@MainActor
final class ChatInputs: ObservableObject {
    @Published var files: [UUID: [ChatPayload.Pending]] = [:]
    @Published var replies: [UUID: UUID] = [:]
}

/// The middle column: the web chat surface (messages and the input box) for one bot. The page
/// draws from `ChatPayload`; what you do in it comes back as actions handled here.
struct ChatSurface: NSViewRepresentable {
    @ObservedObject var bot: Bot
    @ObservedObject var workspace: Workspace
    @ObservedObject var components: ComponentLibrary
    @ObservedObject var plugins: PluginRegistry
    @ObservedObject var inputs: ChatInputs

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "ccb")
        // Attachments and result pictures are local files anywhere on disk.
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        if let page = Self.pageURL {
            view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        }
        context.coordinator.view = view
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.surface = self
        context.coordinator.push()
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "ccb")
    }

    static var pageURL: URL? {
        Bundle.module.url(forResource: "chat", withExtension: "html", subdirectory: "web")
    }

    /// The Node plugin host script.
    static var pluginHostScript: URL? {
        Bundle.module.url(forResource: "host", withExtension: "mjs", subdirectory: "host")
    }

    /// The plugins shipped inside the app.
    static var builtInPlugins: URL? {
        Bundle.module.url(forResource: "plugins", withExtension: nil)
    }

    /// `ccb.setPlugins(...)` for every enabled plugin's web part.
    static func setPluginsScript(_ plugins: PluginRegistry) -> String {
        let data = (try? JSONEncoder().encode(plugins.webSpecs())) ?? Data("[]".utf8)
        return "ccb.setPlugins(\(String(decoding: data, as: UTF8.self)))"
    }

    var payload: ChatPayload {
        ChatPayload.make(
            bot: bot,
            components: components,
            pending: inputs.files[bot.id] ?? [],
            replyingTo: inputs.replies[bot.id],
            avatar: { projectID in
                if let projectID, let kind = workspace.avatar(for: projectID) {
                    return AvatarImages.dataURL(kind, eyes: .open)
                }
                return AvatarImages.dataURL(bot.avatarKind, eyes: .open)
            }
        )
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var surface: ChatSurface?
        weak var view: WKWebView?
        private var ready = false
        private var lastJSON = ""
        private var pluginRevision = -1

        /// Sends the latest plugins and state, when the page is ready and something changed.
        func push() {
            guard ready, let surface, let view else { return }
            if surface.plugins.revision != pluginRevision {
                pluginRevision = surface.plugins.revision
                view.evaluateJavaScript(ChatSurface.setPluginsScript(surface.plugins))
            }
            let json = surface.payload.json()
            guard json != lastJSON else { return }
            lastJSON = json
            view.evaluateJavaScript("ccb.setState(\(json))")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String, let surface else { return }
            let bot = surface.bot
            let inputs = surface.inputs
            let workspace = surface.workspace
            func id(_ key: String) -> UUID? { (body[key] as? String).flatMap(UUID.init(uuidString:)) }

            switch type {
            case "ready":
                ready = true
                lastJSON = ""
                pluginRevision = -1
                push()
                view?.evaluateJavaScript("ccb.focus()")
            case "send":
                let files = inputs.files[bot.id] ?? []
                let reply = inputs.replies[bot.id]
                inputs.files[bot.id] = nil
                inputs.replies[bot.id] = nil
                let text = body["text"] as? String ?? ""
                Task { await workspace.send(text, files: files.map(\.url), replyingTo: reply, to: bot) }
            case "choose":
                if let messageID = id("messageID"), let index = body["index"] as? Int {
                    workspace.choose(index, in: messageID, of: bot)
                }
            case "answer":
                if let messageID = id("messageID"), let text = body["text"] as? String {
                    workspace.answer(text, in: messageID, of: bot)
                }
            case "reply":
                if let messageID = id("messageID") { inputs.replies[bot.id] = messageID }
                view?.evaluateJavaScript("ccb.focus()")
            case "cancelReply":
                inputs.replies[bot.id] = nil
            case "openURL":
                if let text = body["url"] as? String, let url = URL(string: text) {
                    let label = (body["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? url.lastPathComponent
                    workspace.openResult = Chip(label: label, url: url)
                }
            case "openSource":
                if let messageID = id("messageID"),
                   let source = bot.messages.first(where: { $0.id == messageID })?.sourceID {
                    workspace.select(source)
                }
            case "pickFiles":
                let panel = NSOpenPanel()
                panel.canChooseFiles = true
                panel.canChooseDirectories = false
                panel.allowsMultipleSelection = true
                panel.prompt = "加入"
                if panel.runModal() == .OK {
                    inputs.files[bot.id, default: []] += panel.urls.map { ChatPayload.Pending(url: $0) }
                }
            case "removeFile":
                if let fileID = id("id") { inputs.files[bot.id]?.removeAll { $0.id == fileID } }
            case "addFileData":
                if let name = body["name"] as? String, let base64 = body["base64"] as? String,
                   let url = Self.save(base64, named: name) {
                    inputs.files[bot.id, default: []].append(ChatPayload.Pending(url: url))
                }
            case "componentReport":
                if let name = body["name"] as? String, let text = body["text"] as? String {
                    workspace.requestComponentChange(name, request: text, from: "使用者")
                }
            case "componentRevert":
                if let name = body["name"] as? String {
                    let components = surface.components
                    Task {
                        if let problem = await components.revert(name) {
                            workspace.mainBot.notice("組件「\(name)」退不回去：\(problem)")
                        }
                    }
                }
            case "pluginLoaded":
                if let name = body["name"] as? String { surface.plugins.markLoaded(name) }
            default:
                PluginBridge.handle(type, body, workspace: workspace, view: view)
            }
        }

        /// The page itself is the only thing that loads here; links open through actions.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.request.url == ChatSurface.pageURL || action.targetFrame?.isMainFrame == false ? .allow : .cancel
        }

        /// A pasted or dropped file, saved where the bot's copy will be made from.
        static func save(_ base64: String, named name: String) -> URL? {
            guard let data = Data(base64Encoded: base64) else { return nil }
            let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-incoming")
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let safe = name.replacingOccurrences(of: "/", with: "-")
            let url = folder.appending(path: "\(UUID().uuidString.prefix(6))-\(safe)")
            return (try? data.write(to: url)) == nil ? nil : url
        }
    }
}

/// The shape avatars as PNG data URLs, for the web page.
@MainActor
enum AvatarImages {
    private static var cache: [String: String] = [:]

    static func dataURL(_ kind: AvatarKind, eyes: EyeStyle) -> String {
        let key = "\(kind.rawValue)-\(eyes)"
        if let cached = cache[key] { return cached }
        let renderer = ImageRenderer(content: AvatarView(kind: kind, size: 56, eyes: eyes))
        renderer.scale = 2
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return "" }
        let url = "data:image/png;base64," + png.base64EncodedString()
        cache[key] = url
        return url
    }
}
