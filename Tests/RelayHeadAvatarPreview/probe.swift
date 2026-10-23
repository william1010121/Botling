// Synthetic WKWebView screenshots of the actual bundled renderer. No installed app control.
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
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 760), configuration: config)
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        window.alphaValue = 0; window.isReleasedWhenClosed = false
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000)); window.contentView = view
        view.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func run() async throws {
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: URL(filePath: "/"))
        for _ in 0..<200 where !loaded { try await Task.sleep(for: .milliseconds(50)) }
        guard loaded else { throw NSError(domain: "No chat document", code: 1) }
        _ = try await view.evaluateJavaScript("Object.defineProperty(document, 'visibilityState', {configurable:true,get:()=> 'visible'}); ccb.setWindowVisible(true); true")
        var results = [[String: Any]]()
        for (name, width) in [("before", 900), ("after", 900), ("after", 360), ("original", 900), ("live", 900)] {
            view.setFrameSize(NSSize(width: width, height: 760))
            window.setContentSize(NSSize(width: width, height: 760))
            let fixture = try String(contentsOf: output.appending(path: name + ".json"), encoding: .utf8)
            _ = try await view.evaluateJavaScript("ccb.setState(\(fixture)); true")
            try await Task.sleep(for: .milliseconds(400))
            var result = try await view.callAsyncJavaScript("""
              const rows=[...document.querySelectorAll('.row.bot:not(.typing)')];
              await Promise.all([...document.images].filter(i=>i.src).map(i=>i.decode().catch(()=>{})));
              const avatars=rows.map(r=> {const a=r.querySelector('.avatar-still')||r.querySelector('img.avatar');return {id:r.dataset.id,width:a?.naturalWidth||0,head:r.querySelector('.animated-avatar')?.dataset.animatedHead||null,hat:r.querySelector('.avatar-hat')?.getAttribute('src')||null};});
              return {synthetic:true,visibilityOverride:true,name:'\(name)',width:\(width),speakers:rows.map(r=>r.querySelector('.speaker')?.textContent),avatars,overflow:document.documentElement.scrollWidth>innerWidth,typingHead:document.querySelector('.typing .animated-avatar')?.dataset.animatedHead||null};
            """, arguments: [:], in: nil, contentWorld: .page) as! [String: Any]
            guard let avatars = result["avatars"] as? [[String: Any]], avatars.count == 2,
                  avatars.allSatisfy({ ($0["width"] as? Int ?? 0) > 0 }), result["overflow"] as? Bool == false else {
                throw NSError(domain: "Avatar decode/overflow \(result)", code: 2)
            }
            let speakers = result["speakers"] as! [String]
            guard speakers.last == (name == "before" ? "Maintainer" : "Maintainer · Codex") else { throw NSError(domain: "Wrong speaker", code: 3) }
            if name == "after" || name == "live" {
                guard avatars.last?["head"] as? String == "codex" else { throw NSError(domain: "Wrong head", code: 4) }
            }
            if name == "live", result["typingHead"] as? String != "codex" { throw NSError(domain: "Wrong live head", code: 5) }
            if name == "after", width == 360 {
                let sizes = try await view.evaluateJavaScript("""
                (() => {
                  const state=\(fixture), {messages,components,...base}=state;
                  const row=document.querySelectorAll('.row.bot:not(.typing)')[1], a=row.querySelector('.avatar');
                  return [32,48,96,48].map(size=>{
                    ccb.patchState({base:{...base,chatAvatarSize:size},order:messages.map(m=>m.id),changed:[]});
                    const sc=document.querySelector('#scroller');
                    return {expected:size,width:parseFloat(getComputedStyle(a).width),sameNode:a===document.querySelectorAll('.row.bot:not(.typing)')[1].querySelector('.avatar'),overflow:sc.scrollWidth>sc.clientWidth};
                  });
                })()
                """) as! [[String: Any]]
                guard sizes.allSatisfy({ $0["expected"] as? Int == $0["width"] as? Int && $0["sameNode"] as? Bool == true && $0["overflow"] as? Bool == false }) else { throw NSError(domain: "Size patch \(sizes)", code: 6) }
                result["sizePatches"] = sizes
            }
            let shot = try await view.takeSnapshot(configuration: nil)
            let png = NSBitmapImageRep(data: shot.tiffRepresentation!)!.representation(using: .png, properties: [:])!
            try png.write(to: output.appending(path: "\(name)-\(width).png"))
            results.append(result)
        }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "render-results.json"))
        print("PASS: 5 native screenshots, 10 decoded reply avatars, correct source engine/bot hat, no overflow")
    }
}

@main struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let probe = Probe(repo: URL(filePath: CommandLine.arguments[1]), output: URL(filePath: CommandLine.arguments[2]))
        Task { @MainActor in
            do { try await probe.run(); exit(0) } catch { print("FAIL", error); exit(1) }
        }
        app.run()
    }
}
