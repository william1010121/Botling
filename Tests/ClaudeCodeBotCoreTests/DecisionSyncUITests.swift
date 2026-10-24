import AppKit
import WebKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Isolated synthetic transcript, actual generated chat renderer and native answer handling.
@MainActor
struct DecisionSyncUITests {
    @Test func linkedCardsCollapsePersistAndDispatchOnceInProductionWK() async throws {
        _ = NSApplication.shared
        let evidence = ProcessInfo.processInfo.environment["DECISION_SYNC_EVIDENCE_DIR"].map { URL(filePath: $0) }
        if let evidence { try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true) }
        let repo = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        for mode in ["choice", "notes", "freeform", "skip"] {
            for width in [760,360] {
                let fake = FakeLauncher(); fake.respond = { _ in nil }
                let folder = FileManager.default.temporaryDirectory.appending(path: "decision-wk-\(UUID())")
                let store = BotStore(directory: folder)
                var yes = Choice(label: "Implement"); yes.id = UUID()
                var no = Choice(label: "Revise"); no.id = UUID()
                var source = ChatMessage(role: .bot, text: "Claude: Approve the reviewed design?", choices: [yes,no]); source.decisionID = source.id; source.engine = .claude
                var copy = ChatMessage(role: .bot, text: "Codex: Same handoff decision", choices: [no,yes]); copy.decisionID = source.id; copy.engine = .codex
                let control = ChatMessage(role: .bot, text: "Independent similar design decision", choices: [yes,no])
                store.save(messages: [source,copy,control]); store.save(heads: HeadsSettings(engines: [.claude,.codex]))
                let bot = Bot(profile: .main(home: folder), launcher: fake.launcher, store: store)
                let probe = DecisionWKProbe(bot: bot, width: width)
                defer { bot.stop(); bot.partner?.stop(); probe.close(); try? FileManager.default.removeItem(at: folder) }
                probe.view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
                await eventually { probe.loaded || !probe.failures.isEmpty }
                guard probe.loaded else { throw NSError(domain: "WK load failed: \(probe.failures)", code: 1) }
                try await probe.draw(bot)
                let initial = try await probe.metrics()
                #expect(initial["folded"] as? Int == 0)
                #expect(initial["choices"] as? Int == 6)
                #expect((initial["bodies"] as? [String])?.prefix(3).allSatisfy { !$0.isEmpty } == true)
                if let evidence { try await probe.shot(evidence.appending(path: "\(mode)-\(width)-before.png")) }
                if mode == "choice" {
                    // A real rendered button, repeated before state redraw, exercises double-click claims.
                    _ = try await probe.view.evaluateJavaScript("document.querySelectorAll('.row[data-id=\"\(copy.id)\"] .choice')[1].click();document.querySelectorAll('.row[data-id=\"\(source.id)\"] .choice')[0].click();true")
                } else {
                    let action: [String:Any] = mode == "notes"
                        ? ["type":"choose","messageID":copy.id.uuidString,"index":1,"text":"Only this reviewed version"]
                        : ["type":"answer","messageID":copy.id.uuidString,"text":mode == "skip" ? "(Skipped)" : "Use my revised design"]
                    let json = String(data: try JSONSerialization.data(withJSONObject: action), encoding: .utf8)!
                    _ = try await probe.view.evaluateJavaScript("webkit.messageHandlers.ccb.postMessage(\(json));true")
                }
                await eventually { probe.accepted == 1 }
                try await probe.draw(bot)
                let settled = try await probe.metrics()
                #expect(settled["folded"] as? Int == 2)
                #expect(settled["choices"] as? Int == 2)
                let labels = try #require(settled["labels"] as? [String])
                #expect(labels.count == 2 && labels[0] == labels[1])
                if mode == "notes" { #expect(labels[0].contains("Only this reviewed version")) }
                if mode == "skip" { #expect(labels[0].contains("(Skipped)")) }
                #expect(settled["overflow"] as? Bool == false)
                #expect((settled["bodies"] as? [String])?.prefix(3).allSatisfy { !$0.isEmpty } == true)
                #expect(bot.messages[2].isOpenQuestion)
                #expect(bot.messages.filter { $0.role == .user }.count == 1)
                #expect(!bot.answer("(Skipped)", in: source.id))
                await eventually { fake.agents.first?.wireSent.contains { $0.contains("resolved once") } == true }
                #expect(fake.agents.flatMap(\.wireSent).filter { $0.contains("resolved once") && !$0.contains("only; you need not answer") }.count == 1)
                #expect(fake.agents.filter { $0.launch.engine == .codex }.isEmpty)
                if let evidence { try await probe.shot(evidence.appending(path: "\(mode)-\(width)-resolved.png")) }
                let reloaded = Bot(profile: .main(home: folder), launcher: fake.launcher, store: store)
                // Actual page reload clears renderer state, then draws persisted native records.
                probe.loaded = false; probe.view.reload()
                await eventually { probe.loaded }
                try await probe.draw(reloaded)
                let restored = try await probe.metrics()
                #expect(restored["folded"] as? Int == 2 && restored["choices"] as? Int == 2)
                #expect(restored["overflow"] as? Bool == false)
                #expect((restored["bodies"] as? [String])?.prefix(3).allSatisfy { !$0.isEmpty } == true)
                if let evidence {
                    let result: [String:Any] = ["mode":mode,"width":width,"before":initial,"resolved":settled,"reloaded":restored,"accepted":probe.accepted,"semanticDispatches":1,"synthetic":true]
                    try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted,.sortedKeys]).write(to: evidence.appending(path: "\(mode)-\(width).json"))
                    try await probe.shot(evidence.appending(path: "\(mode)-\(width)-reload.png"))
                }
            }
        }
    }
}

@MainActor private final class DecisionWKProbe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let bot: Bot
    let view: WKWebView
    let window: NSWindow
    var loaded = false
    var failures = [String]()
    var accepted = 0
    init(bot: Bot, width: Int) {
        self.bot = bot
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        view = WKWebView(frame: NSRect(x:0,y:0,width:width,height:900), configuration: configuration)
        window = NSWindow(contentRect: view.frame, styleMask:.borderless, backing:.buffered, defer:false)
        super.init()
        view.configuration.userContentController.add(self, name:"ccb")
        view.navigationDelegate = self; window.contentView = view; window.isReleasedWhenClosed = false
        window.alphaValue = 1; window.setFrameOrigin(NSPoint(x:-30000,y:-30000)); window.orderFront(nil)
    }
    func close() { view.configuration.userContentController.removeScriptMessageHandler(forName:"ccb"); window.close() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failures.append(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failures.append("Web content process terminated") }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String:Any], let raw = body["messageID"] as? String, let id = UUID(uuidString:raw) else { return }
        let result: Bool
        if body["type"] as? String == "choose", let index = body["index"] as? Int { result = bot.choose(index,in:id,notes:body["text"] as? String) }
        else if body["type"] as? String == "answer", let text = body["text"] as? String { result = bot.answer(text,in:id) }
        else { return }
        if result { accepted += 1 }
    }
    func draw(_ bot: Bot) async throws {
        let repo = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let art = repo.appending(path: "Sources/ClaudeCodeBotCore/Resources/CharacterArt/animation-posters/avatars")
        var portraits = [BotEngine:String]()
        for engine in BotEngine.allCases {
            let name = engine == .claude ? "claude" : "gpt"
            portraits[engine] = "data:image/png;base64," + (try Data(contentsOf: art.appending(path: "\(name)/idle.png"))).base64EncodedString()
        }
        let look = ChatPayload.HeadLook(avatar: { portraits[$0]! }, mark: { portraits[$0]! })
        let payload = ChatPayload.make(bot:bot,components:nil,pending:[],replyingTo:nil,look:look,avatar:{ _ in portraits[.claude]! })
        let json = String(data:try JSONEncoder().encode(payload),encoding:.utf8)!
        _ = try await view.evaluateJavaScript("ccb.setState(\(json));true")
        try await Task.sleep(for:.milliseconds(120))
        // Original production portrait bytes are embedded directly; every image must decode.
        // CodeMirror uses a source-free, aria-hidden img as a caret buffer; it is not media.
        // Leave that structural node intact and decode every actual image, including portraits.
        let decoded = try await view.callAsyncJavaScript("const media=[...document.images].filter(i=>!(i.classList.contains('cm-widgetBuffer')&&!i.hasAttribute('src')&&i.getAttribute('aria-hidden')==='true'));const failures=[]; await Promise.all(media.map(async i=>{try{await i.decode()}catch(e){failures.push({src:i.getAttribute('src')?.slice(0,80),html:i.outerHTML.slice(0,200),error:String(e)})}}));return {ok:media.length>0&&failures.length===0&&media.every(i=>i.complete&&i.naturalWidth>0),failures}", arguments:[:],in:nil,contentWorld:.page) as! [String:Any]
        guard decoded["ok"] as? Bool == true else { throw NSError(domain: "Image decode failed: \(decoded)", code: 2) }
    }
    func metrics() async throws -> [String:Any] {
        try await view.evaluateJavaScript("({folded:document.querySelectorAll('.folded-choice').length,choices:document.querySelectorAll('.choice').length,labels:[...document.querySelectorAll('.folded-choice')].map(n=>n.textContent),bodies:[...document.querySelectorAll('.row.bot .markdown')].map(n=>n.textContent.trim()),overflow:document.querySelector('#scroller').scrollWidth>document.querySelector('#scroller').clientWidth,ignoredCaretBuffers:[...document.images].filter(i=>i.classList.contains('cm-widgetBuffer')&&!i.hasAttribute('src')&&i.getAttribute('aria-hidden')==='true').length,images:[...document.images].filter(i=>!(i.classList.contains('cm-widgetBuffer')&&!i.hasAttribute('src')&&i.getAttribute('aria-hidden')==='true')).map(i=>({complete:i.complete,width:i.naturalWidth}))})") as! [String:Any]
    }
    func shot(_ url: URL) async throws {
        _ = try await view.evaluateJavaScript("document.querySelector('#scroller').scrollTop=0;true")
        _ = try await view.callAsyncJavaScript("await document.fonts.ready;return true",arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(for:.milliseconds(400))
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        let configuration = WKSnapshotConfiguration(); configuration.afterScreenUpdates = true
        let shot = try await view.takeSnapshot(configuration:configuration)
        try NSBitmapImageRep(data:shot.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:url)
    }
}
