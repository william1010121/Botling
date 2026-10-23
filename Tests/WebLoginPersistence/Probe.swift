import AppKit
import WebKit

// Synthetic profile only. The runner supplies a fresh bundle identity and store UUID.
@MainActor
final class Probe: NSObject, WKNavigationDelegate {
    var view: WKWebView!
    var window: NSWindow!
    let args = CommandLine.arguments
    func start() {
        guard Bundle.main.bundleIdentifier?.hasPrefix("io.botling.session-probe.") == true,
              let identifier = UUID(uuidString: args[2]),
              !["3E3B0000-0000-4000-8000-0000000000D1", "3E3B0000-0000-4000-8000-0000000000D2", "3E3B0000-0000-4000-8000-0000000000D3", "3E3B0000-0000-4000-8000-0000000000D4"].contains(identifier.uuidString) else {
            finish(false); return
        }
        // An added account removed from its menu: the same public call the app makes
        // (`WKWebsiteDataStore.remove(forIdentifier:)`), here only on a random test profile.
        if args[3] == "remove" {
            // As the app does: WebKit's main run loop is set up first (no page opened here).
            _ = WKWebsiteDataStore.default()
            Task { @MainActor in
                do {
                    try await WKWebsiteDataStore.remove(forIdentifier: identifier)
                    print(#"{"removed":true}"#)
                    finish(true)
                } catch { finish(false) }
            }
            return
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: identifier)
        guard configuration.websiteDataStore.isPersistent else { finish(false); return }
        configuration.preferences.inactiveSchedulingPolicy = .none
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
        window = NSWindow(contentRect: view.frame, styleMask: [], backing: .buffered, defer: false)
        window.contentView = view
        view.navigationDelegate = self
        view.load(URLRequest(url: URL(string: args[1])!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { self.finish(false) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript("return await window.check(phase)", arguments: ["phase": args[3]], in: nil, contentWorld: .page)
                guard let flags = result as? [String: Bool] else { finish(false); return }
                // Only booleans; never return cookie or storage values to the host.
                let data = try JSONSerialization.data(withJSONObject: flags, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
                // Allow WebKit's asynchronous disk writes before a normal process exit.
                try await Task.sleep(for: .seconds(3))
                let storage = ["httpOnlyPersistentCookie", "localStorage", "indexedDB"]
                let expected = args[3] != "empty"
                finish(storage.allSatisfy { flags[$0] == expected } && flags["processBoundary"] == true)
            } catch { finish(false) }
        }
    }
    func finish(_ success: Bool) { exit(success ? 0 : 1) }
}
@main
struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let probe = Probe()
        probe.start()
        app.run()
        withExtendedLifetime(probe) {}
    }
}
