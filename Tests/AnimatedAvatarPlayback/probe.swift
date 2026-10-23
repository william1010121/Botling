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
    var actions: [[String: Any]] = []
    init(repo: URL, output: URL, width: Int) throws {
        self.output = output
        self.width = width
        fixture = try String(contentsOf: output.appending(path: "fixture.json"), encoding: .utf8)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        // Simulate the OS media-query change in this fixture, while retaining WebKit rendering.
        config.userContentController.addUserScript(WKUserScript(source: """
        const nativeMatchMedia = window.matchMedia.bind(window);
        const reduce = nativeMatchMedia('(prefers-reduced-motion: reduce)');
        let forcedReduce = false;
        Object.defineProperty(reduce, 'matches', {get: () => forcedReduce});
        window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? reduce : nativeMatchMedia(query);
        window.__setReduce = value => { forcedReduce = value; reduce.dispatchEvent(new Event('change')); };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 1000), configuration: config)
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
        if let action = message.body as? [String: Any] { actions.append(action) }
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
        var sizes: [[String: Any]] = []
        for size in [32, 48, 96] {
            let measured = try await evaluate("""
            (() => {
              const before=document.querySelector('.typing > .avatar'), row=document.querySelector('.row.bot');
              const state=\(fixture), {messages,components,...base}=state;
              ccb.patchState({base:{...base,chatAvatarSize:\(size)},order:messages.map(m=>m.id),changed:[]});
              const a=document.querySelector('.typing > .avatar'), f=document.querySelector('.message-footer'), sc=document.querySelector('#scroller');
              return {size:parseFloat(getComputedStyle(a).width),sameAvatar:a===before,sameRow:row===document.querySelector('.row.bot'),overflow:sc.scrollWidth>sc.clientWidth||f.scrollWidth>f.clientWidth+1};
            })()
            """) as! [String: Any]
            guard measured["size"] as? Int == size, measured["sameAvatar"] as? Bool == true, measured["sameRow"] as? Bool == true, measured["overflow"] as? Bool == false else { throw NSError(domain:"Size patch or footer overflow: \(measured)",code:6) }
            sizes.append(measured)
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
        let expanded = try await evaluate("""
        (() => { document.querySelector('.task-group.done').click(); document.querySelector('.reaction-picker summary').click();
          const f=document.querySelector('.message-footer'),sc=document.querySelector('#scroller');
          return {tasks:document.querySelector('.task-group.done').getAttribute('aria-expanded'),picker:document.querySelector('.reaction-picker').open,overflow:sc.scrollWidth>sc.clientWidth||f.scrollWidth>f.clientWidth+1,
            outside:[...f.querySelectorAll('button,summary')].filter(n=>n.getClientRects().length).some(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>innerWidth+.5})}; })()
        """) as! [String: Any]
        guard expanded["tasks"] as? String == "true", expanded["picker"] as? Bool == true, expanded["overflow"] as? Bool == false, expanded["outside"] as? Bool == false else { throw NSError(domain:"Footer interaction: \(expanded)",code:7) }
        _ = try await snapshot(name:"webkit-\(width)-expanded.png")
        _ = try await evaluate("document.querySelector('.reaction-palette button').click(); document.querySelector('.task-group.done').click(); true")
        try await Task.sleep(for: .milliseconds(100))
        guard actions.contains(where: { $0["type"] as? String == "setReaction" }) else { throw NSError(domain:"Reaction bridge was not called: \(actions)",code:8) }
        _ = try await evaluate("document.querySelector('.typing button.animated-avatar').click(); true")
        let clips = try await evaluate("document.querySelectorAll('.avatar-library-grid button').length") as! Int
        guard clips == 12 else { throw NSError(domain:"Missing clips",code:4) }
        let clipIDs = try await evaluate("[...document.querySelectorAll('.avatar-library-grid button')].map(b=>b.dataset.clip)") as! [String]
        var loadedClips: [String] = []
        for id in clipIDs {
            _ = try await evaluate("document.querySelector('[data-clip=\"\(id)\"]').click(); true")
            var loaded = false
            for _ in 0..<30 {
                if try await evaluate("document.querySelector('.avatar-preview .avatar-motion').naturalWidth===512 && document.querySelectorAll('.avatar-motion[src]').length===1") as? Bool == true { loaded = true; break }
                try await Task.sleep(for: .milliseconds(50))
            }
            guard loaded else { throw NSError(domain:"Clip failed: \(id)",code:12) }
            loadedClips.append(id)
        }
        _ = try await evaluate("document.querySelector('[data-clip=\"claude-stickers-wave\"]').click(); true")
        try await Task.sleep(for: .milliseconds(300))
        _ = try await snapshot(name:"webkit-\(width)-library.png")
        _ = try await evaluate("document.querySelector('dialog').close(); ccb.setWindowVisible(false); true")
        let hidden = try await evaluate("document.querySelectorAll('.avatar-motion[src]').length") as! Int
        guard hidden == 0 else { throw NSError(domain:"Hidden GIF still running",code:5) }
        _ = try await evaluate("ccb.setWindowVisible(true); window.__setReduce(true); true")
        let reduced = try await evaluate("document.querySelectorAll('.avatar-motion[src]').length") as! Int
        guard reduced == 0 else { throw NSError(domain:"Reduced motion still running",code:9) }
        _ = try await snapshot(name:"webkit-\(width)-reduced.png")
        _ = try await evaluate("window.__setReduce(false); true")
        try await Task.sleep(for: .milliseconds(250))
        _ = try await evaluate("document.querySelector('.typing .avatar-motion').dispatchEvent(new Event('error')); true")
        let fallback = try await evaluate("""
        (()=>{ const a=document.querySelector('.typing .animated-avatar'), s=a.querySelector('.avatar-still'); return {sources:document.querySelectorAll('.avatar-motion[src]').length,stillVisible:getComputedStyle(s).visibility==='visible',stillLoaded:s.complete&&s.naturalWidth>0,playing:a.classList.contains('playing')}; })()
        """) as! [String: Any]
        guard fallback["sources"] as? Int == 0, fallback["stillVisible"] as? Bool == true, fallback["stillLoaded"] as? Bool == true, fallback["playing"] as? Bool == false else { throw NSError(domain:"Missing fallback: \(fallback)",code:10) }
        try await Task.sleep(for: .milliseconds(150))
        _ = try await snapshot(name:"webkit-\(width)-fallback.png")
        let original = try await evaluate("""
        (()=>{ const s=\(fixture); s.animatedHeads=null;s.seenHeads=null;s.avatarMood=null;s.botID='original';ccb.setState(s);return document.querySelectorAll('.animated-avatar').length===0&&document.querySelector('.typing > img.avatar')?.complete; })()
        """) as! Bool
        guard original else { throw NSError(domain:"Original renderer changed",code:11) }
        let result: [String: Any] = ["synthetic":true,"syntheticVisibilityOverride":true,"engine":"WKWebView","width":width,"facts":facts,"sizes":sizes,"expandedFooter":expanded,"reactionBridge":true,"syntheticReduceMotionOverride":true,"reducedGifSources":reduced,"fallback":fallback,"original":original,"distinctAvatarFrames":Set(hashes).count,"frameHashes":hashes,"libraryClips":clips,"loadedClips":loadedClips,"hiddenGifSources":hidden]
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
