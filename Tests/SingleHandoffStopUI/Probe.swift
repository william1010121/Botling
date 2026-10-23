// Synthetic transport, real Bot/Conductor, ChatPayload and shipped chat bundle in WKWebView.
// No provider is launched and no installed app is changed. Arguments: repo output-directory.
import AppKit
import ClaudeCodeBotCore
import WebKit

final class ProbeAgent: AgentProcess, @unchecked Sendable {
    let events: AsyncStream<AgentEvent>
    let continuation: AsyncStream<AgentEvent>.Continuation
    let engine: BotEngine
    private let lock = NSLock()
    private var inputs: [String] = []
    private var stops = 0
    var sent: [String] { lock.withLock { inputs } }
    var interrupts: Int { lock.withLock { stops } }
    init(_ launch: AgentLaunch) {
        engine = launch.engine
        (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
    }
    func send(_ text: String) { lock.withLock { inputs.append(text) } }
    func reply(_ text: String) { continuation.yield(.reply(text, isError: false)) }
    func interrupt() {
        lock.withLock { stops += 1 }
        continuation.yield(.reply("", isError: true))
    }
    func finish() { continuation.finish() }
    func stop() { continuation.finish() }
}

final class Transport: @unchecked Sendable {
    private let lock = NSLock()
    private var agents: [BotEngine: ProbeAgent] = [:]
    func start(_ launch: AgentLaunch) -> AgentProcess {
        let agent = ProbeAgent(launch)
        lock.withLock { agents[launch.engine] = agent }
        return agent
    }
    func agent(_ engine: BotEngine) -> ProbeAgent { lock.withLock { agents[engine]! } }
}

@MainActor
final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var loaded = false
    var view: WKWebView!
    var window: NSWindow!
    var bot: Bot!
    var actions: [[String: Any]] = []
    var results: [[String: Any]] = []
    let repo = URL(filePath: CommandLine.arguments[1])
    let output = URL(filePath: CommandLine.arguments[2])
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        actions.append(body)
        // Same UUID validation and public backend endpoint used by ChatSurface.Coordinator.
        if body["type"] as? String == "stopHandoff",
           let owner = body["botID"] as? String, UUID(uuidString: owner) == bot?.id,
           let raw = body["handoffID"] as? String, let id = UUID(uuidString: raw) {
            bot.stopHandoff(id)
        }
    }
    func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: message, code: 1) }
    }
    func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw NSError(domain: "Timed out", code: 2)
    }
    func js(_ script: String) async throws -> Any {
        try await view.evaluateJavaScript(script) ?? NSNull()
    }
    func push() async throws {
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "" }
        _ = try await js("ccb.setState(\(payload.json()));true")
    }
    func snapshot(_ name: String) async throws {
        let config = WKSnapshotConfiguration()
        let top = try await js("Math.floor(document.querySelector('.handoff-panel').getBoundingClientRect().top)") as! Double
        config.rect = CGRect(x: 0, y: top, width: view.bounds.width, height: view.bounds.height - top)
        let image = try await view.takeSnapshot(configuration: config)
        let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        try png.write(to: output.appending(path: name))
    }
    func run() async throws {
        L10n.language = .traditionalChinese
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for width in [360, 900] {
            loaded = false
            actions = []
            let transport = Transport()
            bot = Bot(profile: .main(home: output.appending(path: "synthetic-\(width)")), launcher: { transport.start($0) })
            bot.language = { .traditionalChinese }
            await bot.setHeads([.claude, .codex])
            bot.send("檢查工具列", to: .claude)
            let sender = transport.agent(.claude)
            sender.reply("已交接。<handoff to=\"codex\">檢查工具列</handoff>")
            try await wait { self.bot.handoffs.count == 1 }
            let recipient = transport.agent(.codex)
            let a = bot.handoffs[0].id
            bot.send("另外檢查發佈流程", to: .claude)
            sender.reply("第二筆交接。<handoff to=\"codex\">檢查發佈流程</handoff>")
            try await wait { self.bot.handoffs.count == 2 }
            let b = bot.handoffs[1].id
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
            config.userContentController.add(self, name: "ccb")
            view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 800), configuration: config)
            window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
            window.alphaValue = 0
            window.contentView = view
            view.navigationDelegate = self
            view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
            try await wait { self.loaded }
            try await push()
            _ = try await js("document.querySelector('.handoff-toggle').click();document.querySelector('.handoff-row[data-id=\"\(a.uuidString)\"] .handoff-row-head').click();true")
            try await Task.sleep(for: .milliseconds(120))
            let before = try await js("document.querySelector('.handoff-stop-one').textContent") as! String
            try require(before == "停止這筆", "Selected stop label")
            try require(try await js("document.querySelector('.handoff-stop-all').textContent") as! String == "全部停止", "Global stop label")
            try await snapshot("handoff-\(width)-before.png")
            _ = try await js("document.querySelector('.handoff-stop-one').click();true")
            try await wait { self.bot.handoffs.first { $0.id == a }?.state == .stopped }
            try await wait { recipient.sent.contains { $0.contains("hands you this") && $0.contains("檢查發佈流程") } }
            try require(bot.handoffs.first { $0.id == b }?.state == .running, "Other handoff remains active")
            try require(recipient.interrupts == 1 && sender.interrupts == 0, "Only target turn interrupted")
            try await push()
            try await Task.sleep(for: .milliseconds(120))
            let facts = try await js("(() => {let p=document.querySelector('.handoff-panel');return {states:[...p.querySelectorAll('.handoff-row')].map(r=>r.dataset.state),overflow:document.documentElement.scrollWidth>innerWidth||p.scrollWidth>p.clientWidth+1,selectedButton:p.querySelector('.handoff-stop-one')!==null,globalStop:p.querySelector('.handoff-stop-all').textContent}})()") as! [String: Any]
            try require(facts["states"] as? [String] == ["stopped", "running"], "Native panel scoped update")
            try require(facts["overflow"] as? Bool == false, "Native panel horizontal overflow")
            try require(facts["selectedButton"] as? Bool == false, "Stopped row control removed")
            try await snapshot("handoff-\(width)-after.png")
            recipient.reply("發佈流程檢查完成。")
            try await wait { sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("發佈流程檢查完成") } }
            sender.reply("第二筆完成。")
            try await wait { self.bot.handoffs.first { $0.id == b }?.state == .done }
            results.append(["width": width, "before": before, "selected": a.uuidString, "kept": b.uuidString,
                            "afterClick": facts, "finalStates": bot.handoffs.map { $0.state.rawValue },
                            "recipientInterrupts": recipient.interrupts, "senderInterrupts": sender.interrupts,
                            "actions": actions.filter { $0["type"] as? String == "stopHandoff" }])
            bot.stop()
            config.userContentController.removeScriptMessageHandler(forName: "ccb")
            view.stopLoading()
            window.close()
        }
        let data = try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: output.appending(path: "native-webkit.json"))
        print(String(decoding: data, as: UTF8.self))
    }
}

@main struct Main {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await Probe().run(); exit(0) }
            catch { print("FAIL", error); exit(1) }
        }
        NSApplication.shared.run()
    }
}
