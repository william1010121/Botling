// Run against the isolated branch's generated assets; never controls the installed app.
import AppKit
import WebKit

@MainActor final class Probe: NSObject, WKNavigationDelegate {
    var loaded = false
    let view: WKWebView
    let window: NSWindow
    let repo: URL
    let output: URL
    init(repo: URL, output: URL) {
        self.repo = repo; self.output = output
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 760), configuration: config)
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        window.alphaValue = 0; window.isReleasedWhenClosed = false
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000)); window.contentView = view
        view.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func run() async throws {
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
        for _ in 0..<200 where !loaded { try await Task.sleep(for: .milliseconds(50)) }
        guard loaded else { throw NSError(domain: "Chat did not load", code: 1) }
        let fixture = try String(contentsOf: repo.appending(path: "Tests/CompletionVerificationPreview/fixture.js"), encoding: .utf8)
        var results = [[String: Any]]()
        for width in [900, 360, 320] {
            view.setFrameSize(NSSize(width: width, height: 760)); window.setContentSize(view.frame.size)
            _ = try await view.evaluateJavaScript(fixture + "\nccb.setState({...verificationFixture,botID:'preview-\(width)'});true")
            for expanded in [false, true] {
                if expanded { _ = try await view.evaluateJavaScript("document.querySelectorAll('.completion-verification > summary').forEach(s=>s.click()); true") }
                try await Task.sleep(for: .milliseconds(150))
                var result = try await view.evaluateJavaScript("verificationMeasure()") as! [String: Any]
                let cards = result["cards"] as! [[String: Any]]
                guard result["overflow"] as? Bool == false, cards.count == 2,
                      cards.allSatisfy({ $0["open"] as? Bool == expanded && ($0["summary"] as? String)?.contains("gpt-6-luna") == false && ($0["model"] as? String) == "gpt-6-luna · medium" }),
                      cards.allSatisfy({ expanded ? ($0["height"] as! Double) > ($0["summaryHeight"] as! Double) + 20 : ($0["height"] as! Double) <= ($0["summaryHeight"] as! Double) + 2 }) else {
                    throw NSError(domain: "Disclosure layout failed: \(result)", code: 2)
                }
                let name = "\(expanded ? "expanded" : "collapsed")-\(width)"
                result["name"] = name; results.append(result)
                let shot = try await view.takeSnapshot(configuration: nil)
                let png = NSBitmapImageRep(data: shot.tiffRepresentation!)!.representation(using: .png, properties: [:])!
                try png.write(to: output.appending(path: name + ".png"))
            }
        }
        _ = try await view.evaluateJavaScript("""
        document.querySelector('.completion-verification summary').focus();
        ccb.patchState({order:['claude','codex'],changed:[{...verificationFixture.messages[0],completionVerification:{model:'actual-updated-model',state:'interrupted'}}]}); true
        """)
        let live = try await view.evaluateJavaScript("({open:document.querySelector('.completion-verification').open,focus:document.activeElement===document.querySelector('.completion-verification summary'),text:document.querySelector('.completion-verification').textContent})") as! [String: Any]
        guard live["open"] as? Bool == true, live["focus"] as? Bool == true,
              (live["text"] as? String)?.contains("Interrupted; no verdict") == true,
              (live["text"] as? String)?.contains("actual-updated-model") == true else { throw NSError(domain: "Live update failed: \(live)", code: 3) }
        results.append(live)
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "webkit-results.json"))
        print("PASS: 6 WKWebView screenshots; both heads; 900/360/320px; default one-line, click expansion, no overflow; live interruption/model/focus preserved")
    }
}
@main struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let probe = Probe(repo: URL(filePath: CommandLine.arguments[1]), output: URL(filePath: CommandLine.arguments[2]))
        Task { @MainActor in do { try await probe.run(); exit(0) } catch { print("FAIL", error); exit(1) } }
        app.run()
    }
}
