// Synthetic fixtures in the actual generated chat bundle; never touches the installed app.
import AppKit
import WebKit

@MainActor final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var loaded = false
    var actions = [[String: Any]]()
    let view: WKWebView
    let window: NSWindow
    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 760, height: 850), configuration: configuration)
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        configuration.userContentController.add(self, name: "ccb")
        view.navigationDelegate = self
        window.contentView = view
        window.alphaValue = 0
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let action = message.body as? [String: Any] { actions.append(action) }
    }
    func run(repo: URL, output: URL) async throws {
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
        for _ in 0..<200 where !loaded { try await Task.sleep(for: .milliseconds(50)) }
        guard loaded else { throw NSError(domain: "Chat failed to load", code: 1) }
        let fixture = try String(contentsOf: URL(filePath: CommandLine.arguments[3]), encoding: .utf8)
        _ = try await view.evaluateJavaScript("window.fixture=" + fixture + ";ccb.setState(fixture);true")
        var results = [[String: Any]]()
        let before = CommandLine.arguments.contains("--expect-bug")
        for width in [760, 360] {
            view.setFrameSize(NSSize(width: width, height: 1050)); window.setContentSize(view.frame.size)
            for open in [false, true, false] {
                if open || results.last?["open"] as? Bool == true {
                    _ = try await view.evaluateJavaScript("document.querySelector('[data-action=toggle]').click();true")
                }
                _ = try await view.evaluateJavaScript("document.querySelectorAll('img').forEach(i=>i.loading='eager');true")
                for _ in 0..<100 {
                    let ready = try await view.evaluateJavaScript("[...document.images].every(i=>i.complete&&i.naturalWidth>0)") as? Bool
                    if ready == true { break }
                    try await Task.sleep(for: .milliseconds(50))
                }
                let result = try await view.evaluateJavaScript("""
                (()=>{
                  const images=[...document.images];
                  const ids=fixture.catchUp.ids;
                  const wrappers=ids.map(id=>{const r=document.querySelector('[data-id="'+id+'"]');return r.closest('.stamped')||r});
                  return {width:\(width),open:\(open),hidden:wrappers.filter(r=>getComputedStyle(r).display==='none').length,total:ids.length,
                    decoded:images.filter(i=>i.complete&&i.naturalWidth>0).length,images:images.length,
                    missing:images.filter(i=>!i.complete||!i.naturalWidth).map(i=>({src:i.getAttribute('src')?.slice(0,100),class:i.className})),links:document.querySelectorAll('.catchup-links [data-url]').length,
                    overflow:document.documentElement.scrollWidth>innerWidth,
                    visibleRequests:wrappers.filter(r=>r.querySelector('.row.relay')&&getComputedStyle(r).display!=='none').length};
                })()
                """) as! [String: Any]
                let hidden = result["hidden"] as! Int, total = result["total"] as! Int
                guard open ? hidden == 0 : (before ? hidden < total : hidden == total),
                      result["decoded"] as? Int == result["images"] as? Int,
                      result["overflow"] as? Bool == false else { throw NSError(domain: "Fold/decode/layout failed: \(result)", code: 2) }
                results.append(result)
                let image = try await view.takeSnapshot(configuration: nil)
                let name = "\(before ? "before" : "after")-\(width)-\(results.count).png"
                try NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: output.appending(path: name))
            }
        }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted,.sortedKeys]).write(to: output.appending(path: before ? "wk-before.json" : "wk-after.json"))
        print("PASS: production WKWebView exact copied transcript, 760/360 fold/expand/refold, decoded images, no overflow; expectBug=\(before)")
    }
}
@main struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let probe = Probe()
        Task { @MainActor in
            do { try await probe.run(repo: URL(filePath: CommandLine.arguments[1]), output: URL(filePath: CommandLine.arguments[2])); exit(0) }
            catch { print("FAIL", error); exit(1) }
        }
        app.run()
    }
}
