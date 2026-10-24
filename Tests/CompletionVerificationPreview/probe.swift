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
    func captureRows(_ name: String) async throws {
        let rect = try await view.evaluateJavaScript("(()=>{const rows=[...document.querySelectorAll('.row')].map(n=>n.getBoundingClientRect());const x=Math.min(...rows.map(r=>r.x)),y=Math.min(...rows.map(r=>r.y));return {x,y,width:Math.max(...rows.map(r=>r.right))-x,height:Math.max(...rows.map(r=>r.bottom))-y}})()") as! [String:Double]
        let config=WKSnapshotConfiguration()
        config.rect=CGRect(x:rect["x"]!,y:rect["y"]!,width:rect["width"]!,height:rect["height"]!)
        let shot=try await view.takeSnapshot(configuration:config)
        try NSBitmapImageRep(data:shot.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:output.appending(path:name+".png"))
    }
    func run() async throws {
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
        for _ in 0..<200 where !loaded { try await Task.sleep(for: .milliseconds(50)) }
        guard loaded else { throw NSError(domain: "Chat did not load", code: 1) }
        let fixture = try String(contentsOf: repo.appending(path: "Tests/CompletionVerificationPreview/fixture.js"), encoding: .utf8)
        let assets = repo.appending(path: "Sources/ClaudeCodeBotCore/Resources/CharacterArt/animation-posters/avatars")
        var heads = [String:String]()
        for (mark, name) in [("C", "claude"), ("X", "gpt")] {
            heads[mark] = "data:image/png;base64," + (try Data(contentsOf:assets.appending(path:"\(name)/idle.png"))).base64EncodedString()
        }
        let headJSON = String(data:try JSONSerialization.data(withJSONObject:heads),encoding:.utf8)!
        if CommandLine.arguments.contains("--baseline") {
            for width in [900,320] {
                view.setFrameSize(NSSize(width:width,height:760)); window.setContentSize(view.frame.size)
                _ = try await view.evaluateJavaScript(fixture + "\nverificationFixture.seenHeads=\(headJSON);verificationFixture.messages.forEach((m,i)=>m.avatar=verificationFixture.seenHeads[i ? 'X' : 'C']);ccb.setState({...verificationFixture,botID:'baseline-\(width)'});true")
                try await Task.sleep(for:.milliseconds(150))
                try await captureRows("rows-before-\(width)")
                let shot=try await view.takeSnapshot(configuration:nil)
                try NSBitmapImageRep(data:shot.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:output.appending(path:"before-\(width).png"))
            }
            print("Captured baseline production bundle at 900/320px")
            return
        }
        var results = [[String: Any]]()
        for width in [900, 360, 320] {
            view.setFrameSize(NSSize(width: width, height: 760)); window.setContentSize(view.frame.size)
            _ = try await view.evaluateJavaScript(fixture + "\nverificationFixture.seenHeads=\(headJSON);verificationFixture.messages.forEach((m,i)=>m.avatar=verificationFixture.seenHeads[i ? 'X' : 'C']);ccb.setState({...verificationFixture,botID:'preview-\(width)'});true")
            for expanded in [false, true] {
                view.setFrameSize(NSSize(width: width, height: expanded ? 1100 : 760)); window.setContentSize(view.frame.size)
                if expanded { _ = try await view.evaluateJavaScript("document.querySelectorAll('.completion-verification > .verification-toggle').forEach(s=>s.click()); true") }
                try await Task.sleep(for: .milliseconds(150))
                var result = try await view.evaluateJavaScript("verificationMeasure()") as! [String: Any]
                let cards = result["cards"] as! [[String: Any]]
                guard result["overflow"] as? Bool == false, cards.count == 2,
                      cards[0]["summary"] as? String == "👍",
                      cards.allSatisfy({ $0["open"] as? Bool == expanded && $0["inFooter"] as? Bool == true && $0["model"] as? String == "gpt-6-luna · medium" }) else {
                    throw NSError(domain: "Disclosure state failed: \(result)", code: 2)
                }
                for card in cards {
                    let summary = card["summaryRect"] as! [String:Double]
                    let details = card["detailsRect"] as! [String:Double]
                    let actions = card["actions"] as! [[String:Double]]
                    guard summary["height"]! <= 30,
                          actions.allSatisfy({ abs(($0["y"]! + $0["height"]!/2) - (summary["y"]! + summary["height"]!/2)) < 2 }),
                          expanded ? details["y"]! >= actions.map({$0["bottom"]!}).max()! : details["height"]! == 0 else {
                        throw NSError(domain: "Action row layout failed: \(card)", code: 4)
                    }
                }
                if !expanded { try await captureRows("rows-after-\(width)") }
                let name = "\(expanded ? "expanded" : "collapsed")-\(width)"
                result["name"] = name; results.append(result)
                let shot = try await view.takeSnapshot(configuration: nil)
                let png = NSBitmapImageRep(data: shot.tiffRepresentation!)!.representation(using: .png, properties: [:])!
                try png.write(to: output.appending(path: name + ".png"))
            }
        }
        _ = try await view.evaluateJavaScript("""
        document.querySelector('.completion-verification .verification-toggle').focus();
        ccb.patchState({order:['claude','codex'],changed:[{...verificationFixture.messages[0],completionVerification:{model:'actual-updated-model',state:'interrupted'}}]}); true
        """)
        let live = try await view.evaluateJavaScript("({open:document.querySelector('.completion-verification').classList.contains('open'),focus:document.activeElement===document.querySelector('.completion-verification .verification-toggle'),text:document.querySelector('.completion-verification').textContent})") as! [String: Any]
        guard live["open"] as? Bool == true, live["focus"] as? Bool == true,
              (live["text"] as? String)?.contains("Interrupted; no verdict") == true,
              (live["text"] as? String)?.contains("actual-updated-model") == true else { throw NSError(domain: "Live update failed: \(live)", code: 3) }
        results.append(live)
        let liveShot=try await view.takeSnapshot(configuration:nil)
        try NSBitmapImageRep(data:liveShot.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:output.appending(path:"live-interrupted-320.png"))
        view.setFrameSize(NSSize(width:360,height:1100));window.setContentSize(view.frame.size)
        _ = try await view.evaluateJavaScript("""
        window.statusRecords=[{state:'checking'}, {state:'judged',verdict:'UNAVAILABLE'}, {state:'judged',verdict:'CONTINUE',continuationPaused:true}, {state:'interrupted',verdict:'COMPLETE'}, {state:'judged',verdict:'UNKNOWN'}];
        ccb.setState({...verificationFixture,botID:'status-matrix',messages:statusRecords.map((r,i)=>({...verificationFixture.messages[0],id:'status-'+i,text:'Verification state '+(i+1),completionVerification:{model:'actual-state-model',reason:'Actual state reason',...r}}))});true
        """)
        try await Task.sleep(for:.milliseconds(150))
        let status = try await view.evaluateJavaScript("verificationMeasure()") as! [String:Any]
        let statusCards=status["cards"] as! [[String:Any]]
        guard statusCards.count==5, status["overflow"] as? Bool == false,
              Set(statusCards.compactMap({$0["summary"] as? String})).count==5,
              statusCards.allSatisfy({$0["summary"] as? String != "👍" && $0["open"] as? Bool == false}) else {
            throw NSError(domain:"Non-success statuses failed: \(status)",code:5)
        }
        results.append(status)
        let statusShot=try await view.takeSnapshot(configuration:nil)
        try NSBitmapImageRep(data:statusShot.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:output.appending(path:"states-360.png"))
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "webkit-results.json"))
        print("PASS: 6 WKWebView screenshots; both heads; 900/360/320px; thumbs-only success aligned with tasks/reactions/heads; default collapse, click expansion below row, no overflow; live interruption/model/focus preserved")
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
