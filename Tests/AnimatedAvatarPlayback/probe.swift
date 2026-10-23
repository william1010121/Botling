// Synthetic WKWebView verification. Compile with swiftc -parse-as-library; no app installation.
import AppKit
import CryptoKit
import WebKit

@MainActor
final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let view: WKWebView
    let window: NSWindow
    let output: URL
    let width: Int
    let fixture: String
    var started = false
    init(repo: URL, output: URL, width: Int) throws {
        self.output = output
        self.width = width
        fixture = try String(contentsOf: output.appending(path: "fixture.json"), encoding: .utf8)
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 680), configuration: config)
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        window.orderOut(nil)
        window.contentView = view
        config.userContentController.add(self, name: "ccb")
        view.navigationDelegate = self
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: URL(filePath: "/"))
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !started, (message.body as? [String: Any])?["type"] as? String == "ready" else { return }
        started = true
        Task { do { try await run(); exit(0) } catch { print("FAIL",error); exit(1) } }
    }
    func evaluate(_ script: String) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            view.evaluateJavaScript(script) { result, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: result ?? NSNull()) }
            }
        }
    }
    func snapshot(name: String, rect: CGRect? = nil) async throws -> String {
        let config = WKSnapshotConfiguration()
        if let rect { config.rect = rect }
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            view.takeSnapshot(with: config) { image, error in
                if let image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: error ?? NSError(domain:"Snapshot",code:1)) }
            }
        }
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: output.appending(path: name))
        let raw = bitmap.cgImage!.dataProvider!.data! as Data
        return SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
    }
    func run() async throws {
        // An intentionally offscreen window is correctly reported hidden by WebKit. Simulate a
        // visible document for this fixture only, without showing/focusing any user's window.
        _ = try await evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true,get:()=> 'visible'}); true")
        _ = try await evaluate("ccb.setState(\(fixture)); true")
        var ready = false
        for _ in 0..<60 {
            if (try await evaluate("!!document.querySelector('.typing .animated-avatar.playing')") as? Bool) == true { ready = true; break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard ready else {
            print(try await evaluate("JSON.stringify({hidden:document.visibilityState,body:document.body.className,io:typeof IntersectionObserver,avatars:[...document.querySelectorAll('.animated-avatar')].map(a=>({rect:a.getBoundingClientRect().toJSON(),pose:a.dataset.pose,src:a.querySelector('.avatar-motion')?.getAttribute('src'),loaded:a.querySelector('.avatar-motion')?.naturalWidth})),imgs:[...document.images].map(i=>({src:i.src.slice(0,100),width:i.naturalWidth}))})"))
            throw NSError(domain:"GIF did not load",code:1)
        }
        // Exact crop excludes typing dots and all text; the computed CSS animation must be none.
        let facts = try await evaluate("(() => { const a=document.querySelector('.typing .avatar'); const r=a.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,animation:getComputedStyle(a).animationName,transform:getComputedStyle(a).transform,src:a.querySelector('.avatar-motion').src,overflow:document.documentElement.scrollWidth>innerWidth}; })()") as! [String: Any]
        guard facts["animation"] as? String == "none", facts["transform"] as? String == "none", facts["overflow"] as? Bool == false else { throw NSError(domain:"Unexpected motion or overflow",code:2) }
        let rect = CGRect(x: facts["x"] as! Double, y: facts["y"] as! Double, width: facts["width"] as! Double, height: facts["height"] as! Double)
        var hashes: [String] = []
        for index in 0..<8 {
            hashes.append(try await snapshot(name:"webkit-\(width)-frame-\(index).png", rect:rect))
            try await Task.sleep(for: .milliseconds(120))
        }
        guard Set(hashes).count > 1 else { throw NSError(domain:"GIF avatar pixels did not change",code:3) }
        _ = try await snapshot(name:"webkit-\(width)-chat.png")
        _ = try await evaluate("document.querySelector('.typing button.animated-avatar').click(); true")
        let clips = try await evaluate("document.querySelectorAll('.avatar-library-grid button').length") as! Int
        guard clips == 12 else { throw NSError(domain:"Missing clips",code:4) }
        _ = try await evaluate("document.querySelector('[data-clip=\"claude-stickers-wave\"]').click(); true")
        try await Task.sleep(for: .milliseconds(300))
        _ = try await snapshot(name:"webkit-\(width)-library.png")
        _ = try await evaluate("document.querySelector('dialog').close(); ccb.setWindowVisible(false); true")
        let hidden = try await evaluate("document.querySelectorAll('.avatar-motion[src]').length") as! Int
        guard hidden == 0 else { throw NSError(domain:"Hidden GIF still running",code:5) }
        let result: [String: Any] = ["synthetic":true,"syntheticVisibilityOverride":true,"engine":"WKWebView","width":width,"facts":facts,"distinctAvatarFrames":Set(hashes).count,"frameHashes":hashes,"libraryClips":clips,"hiddenGifSources":hidden]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appending(path:"webkit-\(width).json"))
        print("PASS WKWebView",width,"distinct avatar frames",Set(hashes).count,"clips",clips,"hidden GIF sources",hidden)
    }
}

@main
struct Main {
    @MainActor static func main() throws {
        let app=NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let args=CommandLine.arguments
        let probe=try Probe(repo:URL(filePath:args[1]),output:URL(filePath:args[2]),width:Int(args[3])!)
        DispatchQueue.main.asyncAfter(deadline:.now()+30) { print("FAIL timeout"); exit(1) }
        withExtendedLifetime(probe) { app.run() }
    }
}
