import AppKit
import ClaudeCodeBotCore
import SwiftUI
import UniformTypeIdentifiers
import WebKit

extension Notification.Name {
    /// Puts the cursor back in the chat's input box.
    static let focusComposer = Notification.Name("ClaudeCodeBot.focusComposer")
}

/// Files and reply targets waiting in each bot's composer, kept while you switch between bots.
@MainActor
final class ChatInputs: ObservableObject {
    @Published var files: [UUID: [ChatPayload.Pending]] = [:]
    @Published var replies: [UUID: UUID] = [:]
    /// Bots whose Board shows instead of their chat (Chat | Board, ⌃⌘B).
    @Published var boards: Set<UUID> = []
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
        // A component's picture picker (ccb.pickImage) is a file input: WebKit asks the delegate.
        view.uiDelegate = context.coordinator
        if let page = Self.pageURL {
            view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        }
        context.coordinator.view = view
        // The left column's search gives the cursor back to the input box (Esc, or a row opened).
        context.coordinator.focusObserver = NotificationCenter.default.addObserver(forName: .focusComposer, object: nil, queue: .main) { [weak view] _ in
            MainActor.assumeIsolated {
                guard let view else { return }
                view.window?.makeFirstResponder(view)
                view.evaluateJavaScript("ccb.focus()")
            }
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.surface = self
        context.coordinator.push()
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "ccb")
        if let observer = coordinator.focusObserver { NotificationCenter.default.removeObserver(observer) }
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
                    working: workspace.groupSpeakers[group.id].flatMap { workspace.member($0) },
                    names: workspace.members(of: group).map(\.name),
                    speaker: { [workspace] id in workspace.speakerName(for: id) }
                )
            },
            callIn: workspace.callInView(for: bot),
            feedback: workspace.developerProject != nil,
            share: workspace.offersShare(in: bot),
            commands: workspace.commandContext(for: bot),
            pins: bot === workspace.codexBot ? nil : workspace.pinContext(for: bot, board: inputs.boards.contains(bot.id)),
            specs: bot !== workspace.codexBot,
            openSpec: workspace.openSpecID,
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
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        var surface: ChatSurface?
        weak var view: WKWebView?
        var focusObserver: NSObjectProtocol?
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
            guard let body = message.body as? [String: Any], let type = body["type"] as? String, let surface,
                  PageMessages.accepts(type, fromMainFrame: message.frameInfo.isMainFrame) else { return }
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
                // Words, pictures the user attached in the component, or both.
                if let messageID = id("messageID") {
                    let text = body["text"] as? String ?? ""
                    workspace.answer(text, files: Self.pictures(body["images"]), in: messageID, of: bot)
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
            case "codexReview":
                // A component's ccb.reviewWithCodex: checked against the bot's repository (a
                // commit that is not in it, a spec outside its folder or home); a bad call is dropped.
                if let call = CodexComponentCall(body, folder: bot.profile.workingDirectory) {
                    workspace.reviewWithCodex(bot, scope: call.scope, spec: call.spec)
                }
            case "taskOutput":
                // A background chip opened: its last lines of output (or what the subagent is
                // doing), sent back to the page.
                if let messageID = id("messageID"), let taskID = body["taskID"] as? String {
                    Task { @MainActor [weak view] in
                        let text = await bot.backgroundTaskOutput(messageID: messageID, taskID: taskID)
                        _ = try? await view?.evaluateJavaScript(BackgroundTask.outputReplyScript(messageID: messageID.uuidString, taskID: taskID, text: text))
                    }
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
                // sends this (frames are not heard, above), with the command and folder it showed.
                if let messageID = id("messageID"), let index = body["index"] as? Int {
                    let approve = body["approve"] as? Bool ?? false
                    let force = body["force"] as? Bool ?? false
                    // The page's timer for a card that refreshes by itself (Refresh: every 2s).
                    let live = body["live"] as? Bool ?? false
                    let command = body["command"] as? String, folder = body["folder"] as? String, detail = body["detail"] as? String
                    Task { await workspace.runComponentCommand(messageID: messageID, index: index, in: bot, command: command, folder: folder, detail: detail, approve: approve, force: force, live: live) }
                }
            case "componentDetail":
                // A component's ccb.runDetail(values), passed on by the page with the folder its
                // card showed. Only a Detail command the user allowed in that folder runs; the
                // answer goes back to the page, which hands it to the frame that asked.
                if let requestID = body["requestID"] as? Int, let name = body["name"] as? String,
                   let folder = body["folder"] as? String {
                    let values = ComponentCommands.detailValues(body["values"])
                    Task { @MainActor [weak view] in
                        let outcome: CommandOutcome
                        if let values {
                            outcome = await workspace.runComponentDetail(name, values: values, folder: folder)
                        } else {
                            outcome = CommandOutcome(error: "ccb.runDetail takes an object of text or whole-number values, like {hash: \"2aed630\"}.")
                        }
                        _ = try? await view?.evaluateJavaScript(ComponentCommands.detailReplyScript(requestID, outcome))
                    }
                }
            case "pin":
                // From a chat card's pin button (a message and its place) or the picker (a name).
                guard let pinID = id("id") else { break }
                let refresh = (body["refresh"] as? String).flatMap(PinnedComponent.Refresh.init(rawValue:)) ?? .shown
                let minutes = body["minutes"] as? Int ?? PinnedComponent.defaultMinutes
                let seconds = body["seconds"] as? Int
                if let specID = id("spec") {
                    // The component made from a reply, drawn under it.
                    workspace.pin(spec: specID, in: bot, id: pinID, refresh: refresh, minutes: minutes, seconds: seconds)
                } else if let messageID = id("messageID"), let index = body["index"] as? Int {
                    workspace.pin(messageID: messageID, index: index, in: bot, id: pinID, refresh: refresh, minutes: minutes, seconds: seconds)
                } else if let name = body["name"] as? String {
                    workspace.pin(named: name, in: bot, id: pinID, refresh: refresh, minutes: minutes, seconds: seconds)
                }
            case "unpin":
                if let pinID = id("id") { workspace.unpin(pinID, in: bot) }
            case "movePin":
                if let pinID = id("id"), let to = body["to"] as? Int { workspace.movePin(pinID, to: to, in: bot) }
            case "resizePin":
                if let pinID = id("id"), let size = (body["size"] as? String).flatMap(PinnedComponent.Size.init(spelled:)) {
                    workspace.resizePin(pinID, to: size, in: bot)
                }
            case "setPinHeight":
                // An opened pin's panel dragged taller or shorter (null: back to its content's height).
                if let pinID = id("id") { workspace.setPinPanelHeight(pinID, to: (body["height"] as? NSNumber)?.intValue, in: bot) }
            case "pinStatus":
                // A pinned component's ccb.setStatus: its chip's short value and tone (text null: cleared).
                if let pinID = id("id") {
                    workspace.setPinStatus(pinID, text: body["text"] as? String, tone: body["tone"] as? String, in: bot)
                }
            case "componentSave":
                // A component's ccb.save(data) in a chat message: kept in the message; nothing
                // is sent, the card is not answered (see `ComponentState`).
                if let messageID = id("messageID"), let index = body["index"] as? Int, let data = body["data"] as? String {
                    workspace.saveComponentData(data, messageID: messageID, index: index, in: bot)
                }
            case "pinSave":
                // A pinned component's ccb.save(data): kept on the pin.
                if let pinID = id("id"), let data = body["data"] as? String {
                    workspace.savePinData(data, pin: pinID, in: bot)
                }
            case "setPinRefresh":
                if let pinID = id("id"), let refresh = (body["refresh"] as? String).flatMap(PinnedComponent.Refresh.init(rawValue:)) {
                    workspace.setPinRefresh(pinID, to: refresh, minutes: body["minutes"] as? Int, seconds: body["seconds"] as? Int, in: bot)
                }
            case "pinCommand":
                // A pinned card: Allow (with the command and folder it showed) or ↻. Only what
                // the user allowed runs, as for a card in the chat.
                if let pinID = id("id") {
                    let approve = body["approve"] as? Bool ?? false
                    let force = body["force"] as? Bool ?? false
                    let command = body["command"] as? String, folder = body["folder"] as? String, detail = body["detail"] as? String
                    Task { await workspace.runPin(pinID, in: bot, command: command, folder: folder, detail: detail, approve: approve, force: force) }
                }
            case "makeComponent":
                // A reply's "Make into component" (or an HTML result card's): its first version is
                // built right away; the chip says Building…, the panel stays shut.
                if let messageID = id("messageID") {
                    let preview = body["preview"] as? Int
                    let purpose = body["purpose"] as? String
                    withAnimation(.easeInOut(duration: 0.2)) { _ = workspace.makeComponent(from: messageID, preview: preview, purpose: purpose, in: bot) }
                }
            case "pressSpec":
                // A chip: a bot's suggestion starts its build; otherwise the spec opens (or folds).
                if let specID = id("id") {
                    withAnimation(.easeInOut(duration: 0.2)) { workspace.pressSpec(specID, in: bot) }
                }
            case "specCommand":
                // A built component's card under its reply: Allow and run (with the command and
                // folder it showed), ↻, or its first draw once allowed.
                if let specID = id("id") {
                    let approve = body["approve"] as? Bool ?? false
                    let force = body["force"] as? Bool ?? false
                    let command = body["command"] as? String, folder = body["folder"] as? String, detail = body["detail"] as? String
                    Task { await workspace.runSpecComponent(specID, in: bot, command: command, folder: folder, detail: detail, approve: approve, force: force) }
                }
            case "openSpec":
                // "Edit spec": the spec in the right panel (pressed again, folded back).
                if let specID = id("id") {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if workspace.openSpecID == specID { workspace.closeSpec() } else { workspace.openSpec(specID, in: bot) }
                    }
                }
            case "pinShown":
                let ids = (body["ids"] as? [String])?.compactMap(UUID.init(uuidString:))
                Task { await workspace.pinsShown(ids, in: bot) }
            case "pluginLoaded":
                if let name = body["name"] as? String { surface.plugins.markLoaded(name) }
            default:
                PluginBridge.handle(type, body, workspace: workspace, view: view)
            }
        }

        /// A file input in the page or a component (ccb.pickImage): pictures, from an open panel.
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.allowedContentTypes = [.image]
            panel.prompt = "Attach"
            panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
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

/// Serves `ccb-preview:` requests: the result pages a preview card (or 開啟完整頁面's window)
/// shows, and the files beside them in an `artifacts` folder. Anything else is refused (see `PagePreview.file(forPreview:)`).
final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    static let shared = PreviewSchemeHandler()

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        // Video and sound are read in byte ranges (WebKit asks for `bytes=0-1` first): answered
        // as HTTP with 206 and Content-Range, or the player stays a black box.
        let range = task.request.value(forHTTPHeaderField: "Range")
        guard let url = task.request.url, let answer = PagePreview.response(for: url, range: range),
              let response = HTTPURLResponse(url: url, statusCode: answer.statusCode, httpVersion: "HTTP/1.1", headerFields: answer.headers) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
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
