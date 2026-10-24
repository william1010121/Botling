// Synthetic inference with real Bot / ChatPayload / production WebKit bundle and settings view.
import AppKit
import ClaudeCodeBotCore
import SwiftUI
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
final class Probe: NSObject, WKNavigationDelegate {
    let repo = URL(filePath: CommandLine.arguments[1])
    let output = URL(filePath: CommandLine.arguments[2])
    var view: WKWebView!
    var window: NSWindow!
    var loaded = false
    var results: [[String: Any]] = []
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func require(_ condition: Bool, _ reason: String) throws {
        if !condition { throw NSError(domain: reason, code: 1) }
    }
    func wait(_ ready: () -> Bool) async throws {
        for _ in 0..<250 {
            if ready() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw NSError(domain: "Timed out", code: 2)
    }
    func js(_ script: String) async throws -> Any { try await view.evaluateJavaScript(script) ?? NSNull() }
    func push(_ bot: Bot) async throws {
        let art = try Data(contentsOf: repo.appending(path: "Sources/ClaudeCodeBotCore/Resources/CharacterArt/animation-posters/avatars/claude/idle.png"))
        let avatar = "data:image/png;base64," + art.base64EncodedString()
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in avatar }
        _ = try await js("ccb.setState(\(payload.json()));true")
        try await Task.sleep(for: .milliseconds(120))
    }
    func snapshot(_ name: String) async throws {
        let image = try await view.takeSnapshot(configuration: WKSnapshotConfiguration())
        let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        try png.write(to: output.appending(path: name))
    }
    func run() async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        L10n.language = .traditionalChinese
        for width in [360, 900] {
            loaded = false
            let transport = Transport()
            let bot = Bot(profile: .main(home: output.appending(path: "runtime-\(width)")), launcher: { transport.start($0) })
            bot.language = { .traditionalChinese }
            bot.sessionExists = { _, _ in true }
            let gate = AsyncStream<Void>.makeStream()
            bot.promiseCheck = { _ in
                for await _ in gate.stream { break }
                return .init(verdict: .complete, reason: "已核對測試輸出與交付內容。")
            }
            bot.send("請完成這次檢查。")
            let agent = transport.agent(.claude)
            agent.reply("檢查已完成，結果已保存在本機。")
            try await wait { bot.messages.last?.completionVerification?.state == .checking }
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
            view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 820), configuration: config)
            window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.alphaValue = 0
            window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
            window.contentView = view
            view.navigationDelegate = self
            view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
            try await wait { self.loaded }
            try await push(bot)
            try require(try await js("document.querySelector('.completion-verification').dataset.state") as! String == "checking", "checking must render")
            try await snapshot("checking-\(width).png")
            gate.continuation.yield(); gate.continuation.finish()
            try await wait { bot.messages.last?.completionVerification?.state == .judged }
            try await push(bot)
            try require(try await js("document.querySelector('.completion-verification').dataset.verdict") as! String == "COMPLETE", "complete must render")
            try await snapshot("completed-\(width).png")
            bot.promiseCheck = { _ in .init(verdict: .unavailable, reason: "所選模型目前無法存取，請檢查 Codex 登入或模型權限。") }
            bot.send("再做一次檢查。")
            try await Task.sleep(for: .milliseconds(50))
            transport.agent(.claude).reply("第二次檢查已回覆。")
            try await Task.sleep(for: .milliseconds(100))
            try await wait { bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == .unavailable }
            try await push(bot)
            // Scroll to show both verified reply and the failure record; no hidden success fallback.
            _ = try await js("document.querySelector('.completion-verification[data-verdict=UNAVAILABLE]').scrollIntoView({block:'center'});true")
            let facts = try await js("(() => ({states:[...document.querySelectorAll('.completion-verification')].map(e=>e.dataset.state),verdicts:[...document.querySelectorAll('.completion-verification')].map(e=>e.dataset.verdict),models:[...document.querySelectorAll('.verification-model')].map(e=>e.textContent),overflow:document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.completion-verification')].some(e=>e.scrollWidth>e.clientWidth+1),text:document.querySelector('.completion-verification[data-verdict=UNAVAILABLE]').textContent}))()") as! [String: Any]
            try require(facts["verdicts"] as? [String] == ["COMPLETE", "UNAVAILABLE"], "real results must survive redraw")
            try require(facts["overflow"] as? Bool == false, "no horizontal overflow")
            try require((facts["text"] as? String)?.contains("驗證無法使用") == true, "failure cannot look complete")
            try await snapshot("unavailable-\(width).png")
            results.append(["width": width, "facts": facts])
            bot.stop(); view.stopLoading(); window.close()
        }
        // Render the actual settings component, under an isolated workspace, with fixture capabilities.
        let workspace = Workspace(root: output.appending(path: "settings-root")) { profile, store in
            Bot(profile: profile, launcher: { _ in throw CocoaError(.featureUnsupported) }, store: store)
        }
        let models = [CodexModel(id: "gpt-6-luna", name: "GPT-6 Luna", isDefault: true, supportedReasoningEfforts: ["medium"]),
                      CodexModel(id: "fixture-alternate", name: "Fixture alternate", isDefault: false, supportedReasoningEfforts: ["medium"])]
        for width in [360, 680] {
            let frame = NSRect(x: 0, y: 0, width: width, height: 410)
            let host = NSHostingView(rootView: Form { CompletionVerificationSection(workspace: workspace, models: models) }.formStyle(.grouped).frame(width: frame.width, height: frame.height).preferredColorScheme(.dark))
            let settingsWindow = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
            settingsWindow.isReleasedWhenClosed = false
            settingsWindow.setFrameOrigin(NSPoint(x: -30000, y: -30000)); settingsWindow.alphaValue = 0
            settingsWindow.contentView = host
            for selected in models {
                _ = workspace.setCompletionVerificationModel(selected)
                try await Task.sleep(for: .milliseconds(200))
                host.layoutSubtreeIfNeeded()
                let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
                host.cacheDisplay(in: host.bounds, to: rep)
                try rep.representation(using: .png, properties: [:])!.write(to: output.appending(path: "settings-\(width)-\(selected.id).png"))
            }
            settingsWindow.close()
        }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "native-results.json"))
        print("PASS: production chat WKWebView at 360/900, checking -> COMPLETE and UNAVAILABLE; settings actual component at 360/680; synthetic inference only")
    }
}
@main struct Main {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await Probe().run(); exit(0) } catch { print("FAIL", error); exit(1) }
        }
        NSApplication.shared.run()
    }
}
