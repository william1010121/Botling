import Foundation
import WebKit

/// web-laas in the web bots' pages: LaTeX snippets as you type (`$;a` → `\alpha`) and the live
/// preview of the formula under the caret, as the browser extension gives them. Its scripts are
/// built from web-laas by `scripts/build-web-laas.sh` into the app's `web-laas` resources:
///  - `web-laas-main.js`, the snippet engine, in the page's world (it reaches the editors there);
///  - `web-laas-isolated.js`, the extension's settings script, in the app's own world (`world`),
///    with `chrome.*` answered by the app;
///  - `web-laas-preview.js` (MathJax, ~1.9 MB), run in a frame only the first time its caret is in
///    math, when the isolated script asks (`load-preview`), as the extension's background does.
/// Settings are web-laas's own defaults; what the page changes (⌥⇧L pauses it) is kept here and
/// handed to the other web views.
@MainActor
public final class WebLaas: NSObject, WKScriptMessageHandler {
    /// The app's world for the isolated and preview scripts: the page's scripts cannot see it.
    public static let world = WKContentWorld.world(name: "ccb-web-laas")
    static let messageName = "ccbWebLaas"
    static let settingsKey = "webLaas.settings"

    private let folder: URL
    private let defaults: UserDefaults
    private var previewSource: String?
    private let webViews = NSHashTable<WKWebView>.weakObjects()

    public init(folder: URL, defaults: UserDefaults = .standard) {
        self.folder = folder
        self.defaults = defaults
    }

    /// The one the app's web views share, from the app's resources (nil when they are missing).
    public static func shared(resources: URL?) -> WebLaas? {
        if let made = sharedInstance { return made }
        guard let folder = resources, FileManager.default.fileExists(atPath: folder.appending(path: "web-laas-main.js").path) else { return nil }
        sharedInstance = WebLaas(folder: folder)
        return sharedInstance
    }
    private static var sharedInstance: WebLaas?

    /// Puts web-laas into `webView`'s pages (every frame) from its next load on.
    public func install(in webView: WKWebView) {
        let controller = webView.configuration.userContentController
        guard let main = script("web-laas-main.js"), let isolated = script("web-laas-isolated.js") else { return }
        let state = "window.__ccbLaasState = \(Self.json(settings));"
        controller.addUserScript(WKUserScript(source: main, injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: .page))
        controller.addUserScript(WKUserScript(source: state, injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: Self.world))
        controller.addUserScript(WKUserScript(source: isolated, injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: Self.world))
        controller.add(self, contentWorld: Self.world, name: Self.messageName)
        webViews.add(webView)
    }

    /// What the pages changed, over web-laas's defaults.
    var settings: [String: Any] {
        defaults.dictionary(forKey: Self.settingsKey) ?? [:]
    }

    nonisolated public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? [String: Any], let webView = message.webView else { return }
            switch body["type"] as? String {
            case "load-preview":
                if previewSource == nil { previewSource = script("web-laas-preview.js") }
                guard let source = previewSource else { return }
                webView.evaluateJavaScript(source, in: message.frameInfo, in: Self.world) { _ in }
            case "set":
                guard let patch = body["patch"] as? [String: Any] else { return }
                defaults.set(settings.merging(patch) { $1 }, forKey: Self.settingsKey)
                // the frame that changed it has it already; the other pages' top frames get it
                let call = "window.__ccbLaasSet?.(\(Self.json(patch)));"
                for other in webViews.allObjects where other !== webView || !message.frameInfo.isMainFrame {
                    other.evaluateJavaScript(call, in: nil, in: Self.world) { _ in }
                }
            default:
                break
            }
        }
    }

    private func script(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: name), encoding: .utf8)
    }

    private static func json(_ value: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
