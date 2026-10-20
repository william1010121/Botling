import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

/// The right panel while a component spec is open (its chip pressed): the chat page in spec mode
/// (`chat.html?spec=1`), drawing `SpecPayload`. What you do there comes back as actions; a test
/// run goes through the component command allow flow like any card (see `Workspace+Specs`).
struct SpecPanelView: NSViewRepresentable {
    let specID: UUID
    @ObservedObject var bot: Bot
    @ObservedObject var workspace: Workspace
    @ObservedObject var components: ComponentLibrary
    /// Test runs: a run finishing redraws the panel.
    @ObservedObject var commands: ComponentCommands

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let view = Self.makeWebView(handler: context.coordinator)
        context.coordinator.view = view
        context.coordinator.panel = self
        return view
    }

    /// A web view loading the page in spec mode, reporting to `handler`.
    static func makeWebView(handler: WKScriptMessageHandler) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(handler, name: "ccb")
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        configuration.setURLSchemeHandler(PreviewSchemeHandler.shared, forURLScheme: PagePreview.scheme)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        if let page = ChatSurface.pageURL, var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) {
            parts.queryItems = [URLQueryItem(name: "spec", value: "1")]
            if let url = parts.url { view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/")) }
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.panel = self
        context.coordinator.push()
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "ccb")
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        var panel: SpecPanelView?
        weak var view: WKWebView?
        private var ready = false
        private var lastJSON = ""

        func push() {
            guard ready, let panel, let view, let payload = panel.workspace.specPayload(panel.specID) else { return }
            let json = payload.json()
            guard json != lastJSON else { return }
            lastJSON = json
            view.evaluateJavaScript("ccb.setSpec(\(json))")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String, let panel,
                  PageMessages.accepts(type, fromMainFrame: message.frameInfo.isMainFrame) else { return }
            let workspace = panel.workspace
            let bot = panel.bot
            // The page names the spec it shows; an old page's actions for another spec are dropped.
            let id = (body["id"] as? String).flatMap(UUID.init(uuidString:))
            if body["id"] != nil, id != panel.specID { return }
            let specID = panel.specID
            switch type {
            case "ready":
                ready = true
                lastJSON = ""
                push()
            case "specEdit":
                if let key = body["key"] as? String, let value = body["value"] as? String {
                    workspace.editSpec(specID, key: key, value: value, in: bot)
                }
            case "specAnswer":
                if let question = body["question"] as? String, let option = body["option"] as? Int {
                    workspace.answerSpec(specID, question: question, option: option, in: bot)
                }
            case "specSay":
                workspace.saySpec(specID, text: body["text"] as? String ?? "", in: bot)
            case "specTestRun":
                // Allowing needs the command and folder the panel showed; nothing else runs.
                let approve = body["approve"] as? Bool ?? false
                let command = body["command"] as? String, folder = body["folder"] as? String
                Task { await workspace.testRunSpec(specID, in: bot, command: command, folder: folder, approve: approve) }
            case "specBuild":
                workspace.buildSpec(specID, in: bot)
            case "specCancel":
                workspace.cancelSpec(specID, in: bot)
            case "specClose":
                withAnimation(.easeInOut(duration: 0.2)) { workspace.closeSpec() }
            case "specWide":
                withAnimation(.easeInOut(duration: 0.2)) { workspace.setSpecPanelWide(body["wide"] as? Bool ?? false) }
            case "openURL":
                if let text = body["url"] as? String, let url = URL(string: text) {
                    let label = (body["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? url.lastPathComponent
                    ResultWindows.open(Chip(label: label, url: url))
                }
            default:
                break
            }
        }
    }
}
