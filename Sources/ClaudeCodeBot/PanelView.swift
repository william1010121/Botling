import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

/// What any page running plugins (the chat, a panel) can ask of ClaudeCodeBot.
@MainActor
enum PluginBridge {
    static func handle(_ type: String, _ body: [String: Any], workspace: Workspace, view: WKWebView?) {
        let plugins = workspace.plugins
        switch type {
        case "pluginError":
            if let name = body["name"] as? String {
                plugins.markFailed(name, message: body["message"] as? String ?? "")
            }
        case "pluginLoaded":
            if let name = body["name"] as? String { plugins.markLoaded(name) }
        case "pluginNotice":
            if let name = body["name"] as? String, let text = body["text"] as? String {
                let title = plugins.plugin(name)?.manifest.title ?? name
                workspace.group.notice("\(title): \(text)")
            }
        case "command":
            if let id = body["id"] as? String { Task { await workspace.runCommand(id) } }
        case "hostCall":
            guard let plugin = body["plugin"] as? String, let method = body["method"] as? String,
                  let callID = body["callID"] as? Int else { return }
            let params = (try? JSONSerialization.data(withJSONObject: body["params"] ?? NSNull(), options: .fragmentsAllowed))
                .flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
            Task { [weak view] in
                let ok: Bool
                let value: JSONValue
                if let host = workspace.pluginHost {
                    do {
                        value = try await host.webCall(plugin: plugin, method: method, params: params)
                        ok = true
                    } catch {
                        value = .string(error.localizedDescription)
                        ok = false
                    }
                } else {
                    value = .string("The plugin host is not running.")
                    ok = false
                }
                let json = (try? JSONEncoder().encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
                _ = try? await view?.evaluateJavaScript("ccb.hostReply(\(callID), \(ok), \(json))")
            }
        default:
            break
        }
    }
}

/// One plugin's panel in the right column: the chat page in panel mode, running that plugin.
struct PanelView: NSViewRepresentable {
    let key: String
    @ObservedObject var workspace: Workspace
    @ObservedObject var plugins: PluginRegistry

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "ccb")
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.view = view
        context.coordinator.panel = self
        if let page = ChatSurface.pageURL,
           var components = URLComponents(url: page, resolvingAgainstBaseURL: false) {
            components.queryItems = [URLQueryItem(name: "panel", value: key)]
            if let url = components.url {
                view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/"))
            }
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
        var panel: PanelView?
        weak var view: WKWebView?
        private var ready = false
        private var revision = -1

        /// Sends the panel's plugin (again, after it changed) and asks for the panel.
        func push() {
            guard ready, let panel, let view, panel.plugins.revision != revision else { return }
            revision = panel.plugins.revision
            let name = String(panel.key.split(separator: "/").first ?? "")
            let specs = panel.plugins.webSpecs().filter { $0.name == name }
            let data = (try? JSONEncoder().encode(specs)) ?? Data("[]".utf8)
            let key = (try? JSONEncoder().encode(panel.key)).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
            view.evaluateJavaScript("ccb.setPlugins(\(String(decoding: data, as: UTF8.self))).then(() => ccb.showPanel(\(key)))")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String, let panel else { return }
            if type == "ready" {
                ready = true
                revision = -1
                push()
            } else {
                PluginBridge.handle(type, body, workspace: panel.workspace, view: view)
            }
        }
    }
}
