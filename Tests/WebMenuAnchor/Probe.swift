import AppKit
import WebKit

@MainActor
final class Harness {
    let view: WKWebView
    let window: NSWindow
    let html: String
    let out: URL
    var laas: WebLaas?
    var checks: [String: Bool] = [:]
    var states: [String: Any] = [:]
    init(fixture: URL, out: URL, repair: Bool) throws {
        self.out = out
        html = try String(contentsOf: fixture, encoding: .utf8)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        if repair { WebMenuAnchoring.install(in: config, host: "gemini.google.com") }
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 912, height: 680), configuration: config)
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        if let flag = CommandLine.arguments.firstIndex(of: "--app-injections") {
            let resources = URL(fileURLWithPath: CommandLine.arguments[flag + 1])
            let tap = try String(contentsOf: resources.appendingPathComponent("web-capture/net-tap.js"), encoding: .utf8)
            config.userContentController.addUserScript(WKUserScript(source: tap, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            laas = WebLaas(folder: resources.appendingPathComponent("web-laas"), defaults: UserDefaults(suiteName: "WebMenuAnchorFixture-" + UUID().uuidString)!)
            laas?.install(in: view)
        }
        window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.orderBack(nil)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    }
    func js(_ source: String) async throws -> Any? { try await view.evaluateJavaScript(source) }
    func act(_ source: String) async throws -> Any? { try await js("(()=>{\(source)})()") }
    func settle() async throws {
        // Top-layer changes in WKWebView can settle after the initial observer frame.
        _ = try await view.callAsyncJavaScript("for(let i=0;i<6;i++) await new Promise(requestAnimationFrame); return true", arguments: [:], in: nil, contentWorld: .page)
    }
    func load(setup: String = "", host: String = "gemini.google.com", staticCoordinates: String? = nil) async throws {
        let token = UUID().uuidString
        var document = html
        if let style = staticCoordinates {
            document = document.replacingOccurrences(of: "<div id=\"sub-overlay\" class=", with: "<div id=\"sub-overlay\" style=\"\(style)\" class=")
            document = document.replacingOccurrences(of: "p.style.cssText='inset:auto;width:202px;height:172px;left:'+(a.right-4)+'px;top:'+a.top+'px';", with: "")
        }
        view.loadHTMLString(document.replacingOccurrences(of: "window.ready=true;", with: setup + "\nwindow.ready='\(token)';"), baseURL: URL(string: "https://\(host)/app")!)
        var ready = false
        for _ in 0..<100 {
            if (try? await js("window.ready==='\(token)'")) as? Bool == true { ready = true; break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard ready else { throw NSError(domain: "FixtureLoad", code: 1) }
        try await settle()
    }
    func capture(_ name: String) async throws {
        let image = try await view.takeSnapshot(configuration: nil)
        try NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name + ".png"))
    }
    func check(_ name: String, trigger: String = "trigger", menu: String = "sub-menu") async throws {
        try await settle()
        // The expected location is computed independently from the actual trigger and viewport.
        let result = try await js("""
        (()=>{const a=document.getElementById('\(trigger)').getBoundingClientRect(),s=document.getElementById('\(menu)').getBoundingClientRect(),v=visualViewport;
        const l=v.offsetLeft,t=v.offsetTop,w=v.width,h=v.height,R=l+w-a.right,L=a.left-l,rtl=getComputedStyle(document.getElementById('\(trigger)')).direction==='rtl';
        const right=rtl ? L<s.width&&R>L : R>=s.width||R>=L;
        const x=Math.max(l,Math.min(right?a.right:a.left-s.width,l+Math.max(0,w-s.width))),y=Math.max(t,Math.min(a.top,t+Math.max(0,h-s.height)));
        return JSON.stringify({pass:Math.abs(s.left-x)<=1&&Math.abs(s.top-y)<=1&&s.right<=l+w+1&&s.bottom<=t+h+1,a:a.toJSON(),s:s.toJSON(),expected:{x,y},viewport:{w,h},zoom:document.documentElement.style.zoom,portals:[...document.querySelectorAll('[popover]')].map(e=>({id:e.id,open:e.matches(':popover-open'),style:e.getAttribute('style'),computed:[getComputedStyle(e).inset,getComputedStyle(e).width,getComputedStyle(e).height,getComputedStyle(e).display],rect:e.getBoundingClientRect().toJSON()})),triggers:[...document.querySelectorAll('[aria-haspopup]')].map(e=>({id:e.id,controls:e.getAttribute('aria-controls'),expanded:e.getAttribute('aria-expanded')}))});})()
        """) as! String
        let state = try JSONSerialization.jsonObject(with: Data(result.utf8)) as! [String: Any]
        checks[name] = state["pass"] as? Bool == true
        states[name] = state
        print("\(checks[name]! ? "PASS" : "FAIL") \(name)")
    }
    func expect(_ name: String, _ source: String) async throws { checks[name] = try await js(source) as? Bool == true }
    func finish() throws -> Bool {
        let report: [String: Any] = ["checks": checks, "states": states,
          "engine": "native WKWebView, macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
          "fixture": "local de-identified Gemini CDK reduction; valid dynamic coordinates; no app scripts in before control"]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("checks.json"))
        for name in checks.keys.sorted() { print("\(checks[name]! ? "PASS" : "FAIL") \(name)") }
        print("\(checks.values.filter { $0 }.count)/\(checks.count) checks passed")
        return checks.values.allSatisfy { $0 }
    }
}

@MainActor
func run() async throws {
    let repair = CommandLine.arguments.contains("--repair")
    let h = try Harness(fixture: URL(fileURLWithPath: CommandLine.arguments[1]), out: URL(fileURLWithPath: CommandLine.arguments[2]), repair: repair)
    if CommandLine.arguments.contains("--app-injections") {
        h.checks["production-net-tap-and-web-laas-installed"] = h.view.configuration.userContentController.userScripts.count == 5
    }
    try await h.load()
    try await h.check("reported-912x680")
    try await h.capture("reported")
    if !repair { exit(try h.finish() ? 0 : 1) }
    try await h.expect("same-menu-dom-and-pane-transform", "document.getElementById('sub-menu').closest('[popover]').id==='sub-overlay' && getComputedStyle(document.getElementById('sub-pane')).transform==='matrix(1, 0, 0, 1, 4, 0)'")
    _ = try await h.act("window.mutations=0;new MutationObserver(r=>window.mutations+=r.length).observe(document.getElementById('sub-overlay'),{attributes:true});")
    try await Task.sleep(for: .milliseconds(150))
    try await h.expect("no-self-mutation-animation-loop", "window.mutations===0")
    for (width, height) in [(640, 480), (360, 640), (1120, 520)] {
        h.window.setContentSize(NSSize(width: width, height: height))
        try await h.check("resize-\(width)x\(height)")
        if width == 640 { try await h.capture("edge-flip") }
    }
    h.window.setContentSize(NSSize(width: 912, height: 680))
    for zoom in [0.8, 1.25, 1.5] {
        h.view.pageZoom = zoom
        try await h.check("native-page-zoom-\(zoom)")
    }
    h.view.pageZoom = 1
    for zoom in [0.8, 1.25] {
        _ = try await h.act("document.documentElement.style.zoom='\(zoom)'")
        try await h.check("css-zoom-\(zoom)")
    }
    _ = try await h.act("document.documentElement.style.zoom='';document.getElementById('trigger').style.direction='rtl'")
    try await h.check("rtl-opens-left")
    _ = try await h.act("document.getElementById('trigger').style.direction='';let p=document.getElementById('main-overlay');p.style.inset='auto 10px 5px auto'")
    try await h.check("bottom-right-flips-and-clamps")
    try await h.capture("bottom-right")
    // True scrolling ancestor, without moving the controlled top-layer portal in the DOM.
    _ = try await h.act("""
    const menu=document.getElementById('main-menu'),sc=document.createElement('div');
    sc.id='scroller';sc.style.cssText='height:180px;overflow:auto';
    menu.parentElement.insertBefore(sc,menu);sc.append(menu);menu.style.marginTop='100px';
    sc.scrollTop=230;
    for(const p of document.querySelectorAll('[popover]')) if(!p.matches(':popover-open'))p.showPopover();
    """)
    try await h.check("scroll-start")
    _ = try await h.act("document.getElementById('scroller').scrollTop=270")
    try await h.check("scroll-capture-reanchors")
    // A third menu lives in a nested popover under the second menu's transformed pane.
    _ = try await h.act("""
    const a=document.querySelector('#sub-menu [role=menuitem]');a.id='deep-trigger';
    a.setAttribute('aria-haspopup','menu');a.setAttribute('aria-controls','deep-menu');a.setAttribute('aria-expanded','true');
    const p=document.createElement('div');p.id='deep-overlay';p.className='cdk-overlay-popover cdk-overlay-connected-position-bounding-box';p.setAttribute('popover','manual');
    p.innerHTML='<div class="cdk-overlay-pane" style="transform:translateX(4px)"><gem-menu role="menu" id="deep-menu"><gem-menu-item role="menuitem">Nested option</gem-menu-item></gem-menu></div>';
    document.getElementById('sub-pane').append(p);p.showPopover();
    """)
    try await h.check("nested-third-portal", trigger: "deep-trigger", menu: "deep-menu")
    try await h.capture("nested")
    _ = try await h.act("document.getElementById('deep-overlay').remove();document.getElementById('trigger').setAttribute('aria-expanded','false');document.getElementById('sub-overlay').hidePopover()")
    try await h.settle()
    try await h.expect("closed-menu-restores-site-styles-and-parent", "document.getElementById('sub-overlay').getAttribute('style')===window.initialSiteStyle && document.getElementById('sub-overlay').parentElement.id==='main-menu'")
    _ = try await h.act("document.getElementById('sub-overlay').showPopover();document.getElementById('trigger').setAttribute('aria-expanded','true')")
    try await h.check("reopened-menu")
    try await h.load(setup: """
    document.getElementById('sub-menu').setAttribute('tabindex','-1');
    document.getElementById('sub-menu').focus();
    window.selected=0;document.getElementById('sub-menu').addEventListener('click',()=>window.selected++);
    """)
    try await h.expect("focused-node-survives-portal-repair", "document.activeElement.id==='sub-menu'")
    _ = try await h.act("document.querySelector('#sub-menu [role=menuitem]').click()")
    try await h.expect("menu-listeners-survive-portal-repair", "window.selected===1")
    let initial = h.states["reported-912x680"] as! [String: Any]
    let a = initial["a"] as! [String: Double], m = initial["s"] as! [String: Double]
    let correct = "inset:auto;left:\(a["right"]! - 4)px;top:\(a["top"]!)px;width:\(m["width"]!)px;height:\(m["height"]!)px"
    try await h.load(setup: "window.normalStyle=document.getElementById('sub-overlay').getAttribute('style');", staticCoordinates: correct)
    try await h.expect("correct-site-position-untouched", "document.getElementById('sub-overlay').getAttribute('style')===window.normalStyle && document.getElementById('sub-overlay').parentElement.id==='main-menu'")
    try await h.check("normal-site-placement")
    try await h.load(host: "example.invalid")
    try await h.expect("cross-host-navigation-no-op", "document.getElementById('sub-overlay').getAttribute('style')===window.initialSiteStyle")
    let config = WKWebViewConfiguration()
    WebMenuAnchoring.install(in: config, host: "claude.ai")
    h.checks["other-providers-no-injection"] = config.userContentController.userScripts.isEmpty
    exit(try h.finish() ? 0 : 1)
}

@main struct Probe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await run() } catch { fputs("\(error)\n", stderr); exit(2) }
        }
        app.run()
    }
}
