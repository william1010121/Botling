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
    /// Component cards' command runs: a run finishing redraws the chat.
    @ObservedObject var commands: ComponentCommands
    @ObservedObject var plugins: PluginRegistry
    @ObservedObject var inputs: ChatInputs

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "ccb")
        // Attachments and result pictures are local files anywhere on disk.
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        // Result pages shown in 「網頁預覽卡片」 cards (their frames cannot open file: URLs).
        configuration.setURLSchemeHandler(PreviewSchemeHandler.shared, forURLScheme: PagePreview.scheme)
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
        AppResources.bundle.url(forResource: "chat", withExtension: "html", subdirectory: "web")
    }

    /// The Node plugin host script.
    static var pluginHostScript: URL? {
        AppResources.bundle.url(forResource: "host", withExtension: "mjs", subdirectory: "host")
    }

    /// The plugins shipped inside the app.
    static var builtInPlugins: URL? {
        AppResources.bundle.url(forResource: "plugins", withExtension: nil)
    }

    /// `ccb.setPlugins(...)` for every enabled plugin's web part.
    static func setPluginsScript(_ plugins: PluginRegistry) -> String {
        let data = (try? JSONEncoder().encode(plugins.webSpecs())) ?? Data("[]".utf8)
        return "ccb.setPlugins(\(String(decoding: data, as: UTF8.self)))"
    }

    var payload: ChatPayload {
        if let id = workspace.viewingSubagent, let subagent = bot.trace.subagent(id) {
            return ChatPayload.make(subagent: subagent, of: bot, components: components, avatar: AvatarImages.dataURL(bot.avatarKind, eyes: .open))
        }
        return ChatPayload.make(
            bot: bot,
            components: components,
            pending: inputs.files[bot.id] ?? [],
            replyingTo: inputs.replies[bot.id],
            group: workspace.group(of: bot).map { group in
                ChatPayload.GroupView(
                    typing: workspace.groupSpeakers[group.id],
                    names: workspace.members(of: group).map(\.name),
                    speaker: { [workspace] id in workspace.speakerName(for: id) }
                )
            },
            callIn: workspace.callInView(for: bot),
            feedback: workspace.developerProject != nil,
            commands: workspace.commandContext(for: bot),
            avatar: { projectID in
                if let projectID, let kind = workspace.avatar(for: projectID) {
                    return AvatarImages.dataURL(kind, eyes: .open)
                }
                // A group's own lines (the app) and lines of removed bots.
                if workspace.group(of: bot) != nil { return AvatarImages.dataURL(projectID == nil ? .cloud : .ghost, eyes: .open) }
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
                    ResultWindows.open(Chip(label: label, url: url))
                }
            case "openSubagent":
                if let subagent = body["id"] as? String { workspace.view(subagent: subagent, of: bot) }
            case "feedback":
                guard let messageID = id("messageID") else { break }
                let text = body["text"] as? String ?? ""
                let files = Self.pictures(body["images"])
                Task { @MainActor [weak view] in
                    // The page has put the reply in the middle: the chat as you saw it goes along,
                    // or the whole window if the page cannot be captured.
                    var shot: URL?
                    if let view { shot = await Self.snapshot(of: view, in: view.bounds, named: "feedback") }
                    if shot == nil { shot = await workspace.captureWindow?() }
                    workspace.reportFeedback(text, on: messageID, in: bot, screenshot: shot, files: files)
                }
            case "closeSubagent":
                workspace.view(subagent: nil, of: bot)
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
                panel.prompt = "Add"
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
                guard let name = body["name"] as? String else { break }
                let text = body["text"] as? String ?? ""
                var files = Self.pictures(body["images"])
                let rect = (body["rect"] as? [String: Any]).flatMap(Self.rect)
                Task { @MainActor [weak view] in
                    // The component as it looks now, so Maintainer sees what you saw.
                    if let rect, let view, let shot = await Self.snapshot(of: view, in: rect, named: name) {
                        files.insert(shot, at: 0)
                    }
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty else { return }
                    workspace.requestComponentChange(name, request: text, from: "The user", files: files)
                }
            case "componentRevert":
                if let name = body["name"] as? String {
                    let components = surface.components
                    Task {
                        if let problem = await components.revert(name) {
                            workspace.mainBot.notice("Couldn't revert component \"\(name)\": \(problem)")
                        }
                    }
                }
            case "componentCommand":
                // A card whose data comes from a command: allowed by the user (Allow), run again
                // (refresh), or drawn for the first time once allowed. Only the chat page itself
                // sends this, never a component's frame.
                if let messageID = id("messageID"), let index = body["index"] as? Int {
                    let approve = body["approve"] as? Bool ?? false
                    let force = body["force"] as? Bool ?? false
                    Task { await workspace.runComponentCommand(messageID: messageID, index: index, in: bot, approve: approve, force: force) }
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

        static func rect(_ value: [String: Any]) -> CGRect? {
            guard let x = value["x"] as? Double, let y = value["y"] as? Double,
                  let width = value["width"] as? Double, let height = value["height"] as? Double,
                  width >= 1, height >= 1 else { return nil }
            return CGRect(x: x, y: y, width: width, height: height)
        }

        /// A PNG of part of the page (CSS pixels are the view's points), saved like a pasted file.
        static func snapshot(of view: WKWebView, in rect: CGRect, named name: String) async -> URL? {
            let configuration = WKSnapshotConfiguration()
            configuration.rect = rect.intersection(view.bounds)
            guard !configuration.rect.isEmpty,
                  let image = try? await view.takeSnapshot(configuration: configuration),
                  let tiff = image.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
            return save(png.base64EncodedString(), named: "\(name)-screenshot.png")
        }

        /// Pictures pasted or dropped on a report box, saved.
        static func pictures(_ value: Any?) -> [URL] {
            (value as? [[String: Any]] ?? []).compactMap { image in
                guard let name = image["name"] as? String, let base64 = image["base64"] as? String else { return nil }
                return save(base64, named: name)
            }
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

/// Serves `ccb-preview:` requests: the result pages a preview card shows, and the files beside
/// them in an `artifacts` folder. Anything else is refused (see `PagePreview.file(forPreview:)`).
final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    static let shared = PreviewSchemeHandler()

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, let answer = PagePreview.response(for: url) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let response = URLResponse(url: url, mimeType: answer.mimeType, expectedContentLength: answer.data.count, textEncodingName: answer.encoding)
        task.didReceive(response)
        task.didReceive(answer.data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
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

/// Where the web chat, built-in plugins and plugin host are. In ClaudeCodeBot.app SwiftPM's
/// resource bundle sits in Contents/Resources (its own lookup only checks beside the .app, which a
/// signed app cannot have); under `swift run` it is SwiftPM's usual place.
enum AppResources {
    static let bundle: Bundle = {
        if let url = Bundle.main.resourceURL?.appending(path: "ClaudeCodeBot_ClaudeCodeBot.bundle"),
           let bundle = Bundle(url: url) {
            return bundle
        }
        return Bundle.module
    }()
}
