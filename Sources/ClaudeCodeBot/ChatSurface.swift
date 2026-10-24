import AppKit
import ClaudeCodeBotCore
import SwiftUI
import UniformTypeIdentifiers
import WebKit

extension Notification.Name {
    /// Puts the cursor back in the chat's input box.
    static let focusComposer = Notification.Name("ClaudeCodeBot.focusComposer")
    /// Scrolls the chat to a task's latest line ("Jump to chat" on its card): `userInfo` has
    /// "bot", "message" and "task" (UUIDs).
    static let jumpToTask = Notification.Name("ClaudeCodeBot.jumpToTask")
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
        context.coordinator.jumpObserver = NotificationCenter.default.addObserver(forName: .jumpToTask, object: nil, queue: .main) { [weak view, weak coordinator = context.coordinator] note in
            MainActor.assumeIsolated {
                guard let view, let info = note.userInfo, let bot = info["bot"] as? UUID, coordinator?.surface?.bot.id == bot,
                      let message = info["message"] as? UUID, let task = info["task"] as? UUID else { return }
                view.evaluateJavaScript("ccb.jumpToTask(\"\(message.uuidString)\", \"\(task.uuidString)\")")
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
        if let observer = coordinator.jumpObserver { NotificationCenter.default.removeObserver(observer) }
        coordinator.stopWatchingWindow()
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
        if let id = workspace.viewingSubagent, let subagent = bot.subagent(id) {
            return ChatPayload.make(subagent: subagent, of: bot, components: components, avatar: AvatarImages.dataURL(bot.avatarKind, eyes: .open), chatAvatarSize: workspace.settings.chatAvatarSizeChoice)
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
            pins: !bot.profile.capabilities.board ? nil : workspace.pinContext(for: bot, board: inputs.boards.contains(bot.id)),
            specs: bot.profile.capabilities.specs,
            openSpec: workspace.openSpecID,
            selectedTask: workspace.selectedTask,
            floating: workspace.floatingPinViews(in: bot),
            look: workspace.settings.botLook == .cute ? ChibiImages.look(for: bot.avatarKind) : nil,
            sourceLook: { id in
                workspace.settings.botLook == .cute ? ChibiImages.look(for: workspace.avatar(for: id) ?? .ghost) : nil
            },
            chatAvatarSize: workspace.settings.chatAvatarSizeChoice,
            catchUp: workspace.catchUpView(for: bot),
            intervalSummaries: workspace.intervalSummaryViews(for: bot),
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
        var jumpObserver: NSObjectProtocol?
        private var ready = false
        /// What the page was last sent, so the next update carries only what changed.
        private var patcher = ChatPayload.Patcher()
        /// While a bot works, updates come many times a second (each streamed step): the page is
        /// sent at most one every `workingInterval`, the latest, and the rest are skipped.
        private static let workingInterval: TimeInterval = 0.1
        private var lastPush = Date.distantPast
        private var pushLater = false
        private var pluginRevision = -1

        /// Whether the window was shown when last told to the page and the workspace.
        private var windowShown: Bool?
        private var windowObservers: [NSObjectProtocol] = []

        /// Cards that refresh by themselves run only while the window is shown: not minimized,
        /// not hidden with the app, not fully covered by other windows (its occlusion state).
        func watchWindow() {
            if windowObservers.isEmpty {
                let center = NotificationCenter.default
                let names: [Notification.Name] = [
                    NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                    NSWindow.didDeminiaturizeNotification, NSApplication.didHideNotification, NSApplication.didUnhideNotification,
                    NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                ]
                windowObservers = names.map { name in
                    center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                        MainActor.assumeIsolated { self?.windowChanged() }
                    }
                }
            }
            windowChanged()
        }

        /// Tells the page and the workspace when the window is shown or no longer is.
        func windowChanged() {
            guard ready, let view, let surface else { return }
            let window = view.window
            let shown = window.map {
                RefreshSight.windowShows(occlusionVisible: $0.occlusionState.contains(.visible), miniaturized: $0.isMiniaturized, appHidden: NSApp.isHidden)
            } ?? false
            // Catch-up: messages count as read only while you can see them (app active, window shown).
            // Not during a view update (push runs in one): it may publish.
            let focused = shown && NSApp.isActive
            if surface.workspace.windowFocused != focused {
                let workspace = surface.workspace
                Task { @MainActor in workspace.setWindowFocused(focused) }
            }
            guard shown != windowShown else { return }
            windowShown = shown
            view.evaluateJavaScript("ccb.setWindowVisible(\(shown))")
            let workspace = surface.workspace
            Task { await workspace.setWindowVisible(shown) }
        }

        func stopWatchingWindow() {
            for observer in windowObservers { NotificationCenter.default.removeObserver(observer) }
            windowObservers = []
        }

        /// Sends the latest plugins and state, when the page is ready and something changed.
        func push() {
            guard ready, let surface, let view else { return }
            // The view may have reached its window after the page was ready.
            windowChanged()
            if surface.plugins.revision != pluginRevision {
                pluginRevision = surface.plugins.revision
                view.evaluateJavaScript(ChatSurface.setPluginsScript(surface.plugins))
            }
            let group = surface.workspace.group(of: surface.bot)
            let working = surface.bot.isWorking || group.map { surface.workspace.groupSpeakers[$0.id] != nil } ?? false
            let wait = Self.workingInterval - Date().timeIntervalSince(lastPush)
            if working && wait > 0 {
                guard !pushLater else { return }
                pushLater = true
                DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                    self?.pushLater = false
                    self?.push()
                }
                return
            }
            lastPush = Date()
            guard let script = patcher.script(for: surface.payload) else { return }
            view.evaluateJavaScript(script)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String, let surface,
                  PageMessages.accepts(type, fromMainFrame: message.frameInfo.isMainFrame) else { return }
            let bot = surface.bot
            let inputs = surface.inputs
            let workspace = surface.workspace
            func id(_ key: String) -> UUID? { (body[key] as? String).flatMap(UUID.init(uuidString:)) }
            // A pin's message goes to the bot that holds it: a floating card shown in all bots
            // is another bot's. Another bot's change redraws this chat too.
            func pinBot(_ pinID: UUID?) -> Bot {
                guard let pinID, let owner = workspace.bot(holdingPin: pinID), owner !== bot else { return bot }
                workspace.objectWillChange.send()
                return owner
            }

            switch type {
            case "ready":
                ready = true
                patcher.reset()
                pluginRevision = -1
                // The drafts before the first state, so the first chat shows its own.
                view?.evaluateJavaScript(workspace.drafts.script)
                push()
                windowShown = nil
                watchWindow()
                view?.evaluateJavaScript("ccb.focus()")
            case "send":
                let files = inputs.files[bot.id] ?? []
                let reply = inputs.replies[bot.id]
                inputs.files[bot.id] = nil
                inputs.replies[bot.id] = nil
                let text = body["text"] as? String ?? ""
                // A bot with two heads: the head (or both) picked above the input box.
                let target = (body["to"] as? String).flatMap(AnswerTarget.init(rawValue:))
                Task { await workspace.send(text, files: files.map(\.url), replyingTo: reply, answerWith: target, to: bot) }
            case "setAnswerWith":
                // Bind the save to the chat whose chip was clicked, even if the user switched
                // bots before WebKit delivered the action. Mentions only set `send.to` above.
                if let chatID = id("botID"), let requestID = body["requestID"] as? Int,
                   let target = (body["to"] as? String).flatMap(AnswerTarget.init(rawValue:)),
                   let owner = ([workspace.mainBot] + Array(workspace.managers.values)).first(where: { $0.id == chatID }) {
                    if owner.heads.targets.contains(target) { owner.setAnswerWith(target) }
                    // Also acknowledge unchanged/rejected saves: no object change may fire.
                    let ack: [String: Any] = ["botID": chatID.uuidString, "requestID": requestID, "chosen": owner.heads.answerWith.rawValue]
                    if let data = try? JSONSerialization.data(withJSONObject: ack), let json = String(data: data, encoding: .utf8) {
                        view?.evaluateJavaScript("ccb.answerWithSaved(\(json))")
                    }
                }
            case "draft":
                if let chat = body["botID"] as? String {
                    let text = body["text"] as? String ?? ""
                    workspace.drafts.set(chat, ComposerDrafts.Draft(text: text, cursor: body["cursor"] as? Int ?? text.utf16.count))
                }
            case "choose":
                if let messageID = id("messageID"), let index = body["index"] as? Int {
                    workspace.choose(index, in: messageID, of: bot, notes: body["text"] as? String, files: Self.pictures(body["images"]))
                }
            case "answer":
                // Words, pictures the user attached in the component, or both.
                if let messageID = id("messageID") {
                    let text = body["text"] as? String ?? ""
                    workspace.answer(text, files: Self.pictures(body["images"]), in: messageID, of: bot)
                }
            case "setReaction":
                if let messageID = id("messageID"), let emoji = body["emoji"] as? String,
                   let present = body["present"] as? Bool {
                    do { try bot.setUserReaction(messageID: messageID, emoji: emoji, present: present) }
                    catch { view?.evaluateJavaScript("alert('Could not save reaction. Please try again.')") }
                }
            case "reply":
                if let messageID = id("messageID") { inputs.replies[bot.id] = messageID }
                view?.evaluateJavaScript("ccb.focus()")
            case "cancelReply":
                inputs.replies[bot.id] = nil
            case "stopHandoff":
                // A stale page event may arrive after the user switched conversations.
                guard id("botID") == bot.id, let handoffID = id("handoffID") else { return }
                bot.stopHandoff(handoffID)
            case "stopRounds":
                bot.stopRounds()
            case "catchUpManual":
                guard id("botID") == bot.id, workspace.viewingSubagent == nil else { return }
                guard let userID = id("userMessageID") else { return }
                workspace.summarizeInterval(in: bot, after: userID)
            case "catchUpRetry":
                guard id("botID") == bot.id else { return }
                if let key = body["key"] as? String { workspace.retryIntervalSummary(in: bot, key: key) }
                else { workspace.retryCatchUp(in: bot) }
            case "openURL":
                if let text = body["url"] as? String, let url = URL(string: text) {
                    let label = (body["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? url.lastPathComponent
                    ResultWindows.open(Chip(label: label, url: url))
                }
            case "openExternal", "revealFile":
                // The lightbox's secondary buttons: only a picture file on disk, never an app or a script.
                if let text = body["url"] as? String, let url = URL(string: text), ImageFile.isOpenable(url) {
                    if type == "revealFile" { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    else { NSWorkspace.shared.open(url) }
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
                panel.prompt = L("Add")
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
                if body["problem"] as? Bool == true {
                    // "Report a problem…" from a card's ⋯ menu: the card's own bot (a floating
                    // card may be another bot's), its pin, and the screenshot kept with that bot.
                    let pinID = id("pinID")
                    let owner = pinBot(pinID)
                    Task { @MainActor [weak view] in
                        var shot: URL?
                        if let rect, let view { shot = await Self.snapshot(of: view, in: rect, named: name) }
                        workspace.reportComponentProblem(name, text: text, in: owner, pinID: pinID, screenshot: shot, pictures: files)
                        if let shot { try? FileManager.default.removeItem(at: shot) }
                    }
                    break
                }
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
                            workspace.mainBot.notice(L("Couldn't revert component \"{0}\": {1}", name, problem))
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
                // answer goes back to the page, which hands it to the frame that asked. With a card
                // (`{save: true}`) its output is that card's data: it finishes into the card even
                // when another chat is opened meanwhile and this page is gone.
                if let requestID = body["requestID"] as? Int, let name = body["name"] as? String,
                   let folder = body["folder"] as? String {
                    let values = ComponentCommands.detailValues(body["values"])
                    let card = body["card"] as? String, command = body["command"] as? String
                    Task { @MainActor [weak view] in
                        let outcome: CommandOutcome
                        if let values {
                            outcome = await workspace.runComponentDetail(name, values: values, folder: folder, card: card, command: command, in: bot)
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
                if let pinID = id("id") { workspace.unpin(pinID, in: pinBot(pinID)) }
            case "movePin":
                if let pinID = id("id"), let to = body["to"] as? Int { workspace.movePin(pinID, to: to, in: pinBot(pinID)) }
            case "resizePin":
                if let pinID = id("id"), let size = (body["size"] as? String).flatMap(PinnedComponent.Size.init(spelled:)) {
                    workspace.resizePin(pinID, to: size, in: pinBot(pinID))
                }
            case "arrangePins":
                // Board cards dropped, resized or pushed down: each one's top-left cell (and size).
                let places: [(id: UUID, place: PinnedComponent.Place, size: PinnedComponent.Size?)] = (body["places"] as? [[String: Any]] ?? []).compactMap { entry in
                    guard let pinID = (entry["id"] as? String).flatMap(UUID.init(uuidString:)), let col = entry["col"] as? Int, let row = entry["row"] as? Int else { return nil }
                    return (pinID, PinnedComponent.Place(col: col, row: row), (entry["size"] as? String).flatMap(PinnedComponent.Size.init(spelled:)))
                }
                if let first = places.first { workspace.arrangePins(places, in: pinBot(first.id)) }
            case "setPinHeight":
                // An opened pin's panel dragged taller or shorter (null: back to its content's height).
                if let pinID = id("id") { workspace.setPinPanelHeight(pinID, to: (body["height"] as? NSNumber)?.intValue, in: pinBot(pinID)) }
            case "pinStatus":
                // A pinned component's ccb.setStatus: its chip's short value and tone (text null: cleared).
                if let pinID = id("id") {
                    workspace.setPinStatus(pinID, text: body["text"] as? String, tone: body["tone"] as? String, in: pinBot(pinID))
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
                    workspace.savePinData(data, pin: pinID, in: pinBot(pinID))
                }
            case "floatPin":
                // Float in corner / Stop floating, from its menu (at most two float at once).
                if let pinID = id("id"), let on = body["floating"] as? Bool { workspace.floatPin(pinID, on, in: pinBot(pinID)) }
            case "setPinGlobal":
                // A floating card's "Show in all bots" / "Only in <its bot>".
                if let pinID = id("id"), let on = body["global"] as? Bool { workspace.setPinGlobal(pinID, on, in: pinBot(pinID)) }
            case "setPinFloat":
                // A floating card dragged to another corner, resized, or folded to one line.
                if let pinID = id("id") {
                    let corner = (body["corner"] as? String).flatMap(PinnedComponent.Floating.Corner.init(rawValue:))
                    workspace.setPinFloat(pinID, corner: corner, width: (body["width"] as? NSNumber)?.intValue, height: (body["height"] as? NSNumber)?.intValue, collapsed: body["collapsed"] as? Bool, in: pinBot(pinID))
                }
            case "setPinRefresh":
                if let pinID = id("id"), let refresh = (body["refresh"] as? String).flatMap(PinnedComponent.Refresh.init(rawValue:)) {
                    workspace.setPinRefresh(pinID, to: refresh, minutes: body["minutes"] as? Int, seconds: body["seconds"] as? Int, in: pinBot(pinID))
                }
            case "pinCommand":
                // A pinned card: Allow (with the command and folder it showed) or ↻. Only what
                // the user allowed runs, as for a card in the chat.
                if let pinID = id("id") {
                    let approve = body["approve"] as? Bool ?? false
                    let force = body["force"] as? Bool ?? false
                    let command = body["command"] as? String, folder = body["folder"] as? String, detail = body["detail"] as? String
                    let owner = pinBot(pinID)
                    Task { await workspace.runPin(pinID, in: owner, command: command, folder: folder, detail: detail, approve: approve, force: force) }
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
            case "selectTask":
                workspace.selectTask(id("id"))
            case "openSpec":
                // "Edit spec": the spec in the right panel (pressed again, folded back).
                if let specID = id("id") {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if workspace.openSpecID == specID { workspace.closeSpec() } else { workspace.openSpec(specID, in: bot) }
                    }
                }
            case "pinsVisible":
                // The pins the user can see now: only those refresh by themselves.
                let ids = (body["ids"] as? [String])?.compactMap(UUID.init(uuidString:)) ?? []
                Task { await workspace.pinsVisible(ids, in: bot) }
            case "pinShown":
                let ids = (body["ids"] as? [String])?.compactMap(UUID.init(uuidString:))
                let owner = pinBot(ids?.first)
                Task { await workspace.pinsShown(ids, in: owner) }
            case "resync":
                // The page could not apply an update: it gets the whole state next.
                patcher.reset()
                push()
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
            panel.prompt = L("Attach")
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

/// Where the web chat, built-in plugins and plugin host are. In Botling.app SwiftPM's
/// resource bundle sits in Contents/Resources (its own lookup only checks beside the .app, which a
/// signed app cannot have); under `swift run` it is SwiftPM's usual place.
enum AppResources {
    static let bundle: Bundle = {
        for name in ["botling_ClaudeCodeBot.bundle", "ClaudeCodeBot_ClaudeCodeBot.bundle"] {
            if let url = Bundle.main.resourceURL?.appending(path: name), let bundle = Bundle(url: url) {
                return bundle
            }
        }
        return Bundle.module
    }()
}
