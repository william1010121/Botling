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
        let fixture = #"""
        window.fixture = {botID:'catchup-preview',botName:'Garden',lang:'zh-Hant',working:false,answerWith:{chosen:'both',options:[{id:'both',label:'Both'},{id:'claude',label:'Claude'},{id:'codex',label:'Codex'}]},avatar:'',placeholder:'',replyingTo:null,pendingFiles:[],components:{},messages:[
          {id:'one',role:'bot',text:'[本機報告](file:///tmp/report.html) [另一個標籤](file:///tmp/report.html)\n[研究資料](https://example.org/data)\n![圖片](file:///tmp/picture.png) ![影片](file:///tmp/movie.mp4)',stamp:null,avatar:null,choices:null,chosen:null,answer:null,open:false,attachments:[{name:'資料附件',kind:'file',url:'file:///tmp/data.zip'}],replyTo:null,replyPreview:null,openable:false},
          {id:'two',role:'bot',text:'完成建置，等你確認。',stamp:null,avatar:null,choices:null,chosen:null,answer:null,open:false,attachments:null,replyTo:null,replyPreview:null,openable:false}
        ],catchUp:{key:'preview',ids:['one','two'],count:2,manual:true,state:'ready',bullets:['已完成建置與研究，報告與附件可由下方開啟。','!! 等你確認是否整合。'],model:'test-model',since:'18:04',until:'18:36'}};
        """#
        _ = try await view.evaluateJavaScript(fixture + "ccb.setState(fixture);true")
        var results = [[String: Any]]()
        for width in [760, 360, 320] {
            view.setFrameSize(NSSize(width: width, height: 850)); window.setContentSize(view.frame.size)
            for phase in ["ready", "loading", "failed"] {
                _ = try await view.evaluateJavaScript("fixture.catchUp.state='\(phase)';fixture.catchUp.error='Model offline';ccb.setState(fixture);true")
                try await Task.sleep(for: .milliseconds(150))
                let result = try await view.evaluateJavaScript("""
                (()=>{const card=document.querySelector('.catchup-card');const trigger=document.querySelector('.composer-tools .catchup-button');return {width:\(width),phase:'\(phase)',links:[...card.querySelectorAll('[data-url]')].map(a=>a.dataset.url),overflow:document.documentElement.scrollWidth>innerWidth,triggerDisabled:trigger.disabled,triggerVisible:trigger.getBoundingClientRect().width>0}})()
                """) as! [String: Any]
                guard (result["links"] as? [String])?.count == 5,
                      result["overflow"] as? Bool == false,
                      result["triggerDisabled"] as? Bool == (phase == "loading"),
                      result["triggerVisible"] as? Bool == true else { throw NSError(domain: "Layout failed: \(result)", code: 2) }
                results.append(result)
                let image = try await view.takeSnapshot(configuration: nil)
                try NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: output.appending(path: "\(phase)-\(width).png"))
            }
        }
        _ = try await view.evaluateJavaScript("document.querySelector('.catchup-links a').click();document.querySelector('.composer-tools .catchup-button').click();true")
        try await Task.sleep(for: .milliseconds(150))
        guard actions.contains(where: { $0["type"] as? String == "openURL" && $0["url"] as? String == "file:///tmp/report.html" }),
              actions.contains(where: { $0["type"] as? String == "catchUpManual" }) else { throw NSError(domain: "Missing click bridge actions", code: 3) }
        _ = try await view.evaluateJavaScript("fixture.messages=[];fixture.catchUp=null;ccb.setState(fixture);true")
        let empty = try await view.evaluateJavaScript("document.querySelector('.composer-tools .catchup-button').disabled") as? Bool
        guard empty == true else { throw NSError(domain: "Empty enabled", code: 4) }
        _ = try await view.evaluateJavaScript("fixture.subagent={id:'subagent'};ccb.setState(fixture);true")
        let hidden = try await view.evaluateJavaScript("getComputedStyle(document.querySelector('.composer-tools .catchup-button')).display === 'none'") as? Bool
        guard hidden == true else { throw NSError(domain: "Subagent trigger visible", code: 5) }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "results.json"))
        print("PASS: WKWebView 760/360/320 × ready/loading/failed, 5 links each, no horizontal overflow, trigger states, actual openURL/manual bridge clicks, empty disabled; nine screenshots")
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
