import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

@main @MainActor struct BrowserToolsPreview {
    static var windows: [NSWindow] = []
    static var checks: [String] = []
    static func check(_ condition: Bool, _ label: String) throws {
        guard condition else { throw NSError(domain: label, code: 1) }
        checks.append(label); print("PASS \(label)")
    }
    static func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<300 { if condition() { return }; try await Task.sleep(for: .milliseconds(25)) }
        throw NSError(domain: "Timed out", code: 2)
    }
    static func main() {
        let app = NSApplication.shared; HeadlessRun.quiet(app)
        Task {
            do { try await run(); exit(0) } catch { print("FAIL \(error)"); exit(1) }
        }
        app.run()
    }
    static func run() async throws {
        let out = URL(filePath: CommandLine.arguments[1]), repo = URL(filePath: CommandLine.arguments[2])
        let origin = CommandLine.arguments[3], root = out.appending(path: "fixture")
        let restoring = CommandLine.arguments.contains("--restore")
        let library = Workspace.Layout.plugins(in: root)
        let fixture = library.appending(path: "ccb-browser-fixture")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        try Data(#"{"name":"ccb-browser-fixture","version":"1.0.0","engines":{"ccb":"^2.0.0"},"ccb":{"host":"host.mjs"}}"#.utf8).write(to: fixture.appending(path: "package.json"))
        let source = try String(contentsOf: repo.appending(path: "Tests/BrowserTools/fixture-host.mjs"), encoding: .utf8).replacingOccurrences(of: "FIXTURE_ORIGIN", with: origin)
        try Data(source.utf8).write(to: fixture.appending(path: "host.mjs"))
        try check(PluginRegistry.check(fixture).isEmpty, "fixture plugin passes production manifest validation")
        let workspace = Workspace(root: root, pluginHostScript: repo.appending(path: "Sources/ClaudeCodeBot/Resources/host/host.mjs")) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        L10n.language = .english
        workspace.select(BrowserShelf.selectionID)
        let browser = workspace.browser
        if !restoring { browser.update(browser.current, url: URL(string: origin + "/fixture.html")!, title: "Local Tasks"); browser.togglePin() }
        let session = BrowserSession(workspace: workspace)
        session.show()
        let tab = session.tab!, view = tab.webView
        let window = HeadlessRun.offscreenWindow(NSRect(x: 0, y: 0, width: 1000, height: 700))
        window.contentView = view; view.frame = window.contentView!.bounds; windows.append(window)
        try await wait { !view.isLoading && view.url?.path == "/fixture.html" }
        let ready = try await view.evaluateJavaScript("document.getElementById('login')!==null") as? Bool
        try check(ready == true, "general browser loads local page")
        if restoring {
            let value = try await view.evaluateJavaScript("document.cookie.includes('fixture_login=present') && localStorage.getItem('fixture')==='signed-in'") as? Bool
            try check(value == true, "cookie and localStorage survive process restart with saved account identity")
            try check(browser.pins.count == 1, "pin survives process restart")
            try JSONEncoder().encode(checks).write(to: out.appending(path: "restore-checks.json"))
            return
        }
        let params: JSONValue = .object(["origin": .string(origin), "account": .string(browser.page.account.uuidString), "tab": .string(tab.id.uuidString), "operation": .string("observe")])
        func observed() async throws -> [[String: JSONValue]] {
            let value = try await BrowserOperations.perform(params, in: view)
            guard case .array(let values)? = value["targets"] else { throw NSError(domain: "No targets", code: 3) }
            return values.compactMap { if case .object(let item) = $0 { item } else { nil } }
        }
        func operation(_ name: String, target: String) -> JSONValue {
            guard case .object(var object) = params else { return .null }
            object["operation"] = .string(name); object["target"] = .string(target); return .object(object)
        }
        let first = try await observed()
        try check(!first.contains { $0["text"]?.string?.contains("fixture-password") == true }, "password excluded from observations")
        let login = first.first { $0["text"]?.string == "Sign in locally" }!["id"]!.string!
        _ = try await BrowserOperations.perform(operation("click", target: login), in: view)
        var rejected = false
        do { _ = try await BrowserOperations.perform(operation("click", target: login), in: view) } catch { rejected = true }
        try check(rejected, "click consumes previous observation")
        view.reload(); try await wait { !view.isLoading }
        let persisted = try await view.evaluateJavaScript("document.cookie.includes('fixture_login=present') && localStorage.getItem('fixture')==='signed-in'") as? Bool
        try check(persisted == true, "local sign-in persists across reload")
        let beforeMutation = try await observed()
        let detailButton = beforeMutation.first { $0["text"]?.string == "Open details" }!["id"]!.string!
        _ = try await view.evaluateJavaScript("document.getElementById('details').setAttribute('aria-label','Changed');true")
        rejected = false
        do { _ = try await BrowserOperations.perform(operation("click", target: detailButton), in: view) } catch { rejected = true }
        try check(rejected, "DOM mutation rejects stale observed target")
        try await wait { !browser.tools.isEmpty && workspace.pluginHost?.isRunning == true }
        session.run(browser.tools[0]); try await wait { !session.running }
        try check(session.problem?.contains("Allow tool clicks") == true, "tool clicks default to denied for this website account")
        browser.allowClicks(true, for: browser.page)
        session.run(browser.tools[0]); try await wait { !session.running }
        try check(session.result?.contains("Task Alpha") == true && session.problem == nil, "real Node plugin routes observe click fresh-observe extract through App bridge")
        try check(session.result?.contains("rejectedScopes") == true, "wrong account tab and origin rejected inside active tool")
        rejected = false
        do { _ = try await workspace.pluginHost!.onRequest!("browser.perform", .object(["plugin": .string("ccb-browser-fixture")])) } catch { rejected = true }
        try check(rejected, "background operation without user invocation rejected")
        let before = browser.page
        browser.newAccount(); session.show()
        let other = session.tab!
        window.contentView = other.webView
        other.webView.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
        try await wait { !other.webView.isLoading && other.webView.url?.path == "/fixture.html" }
        let separate = try await other.webView.evaluateJavaScript("!document.cookie.includes('fixture_login') && localStorage.getItem('fixture')===null") as? Bool
        try check(separate == true && other.account.dataStoreID != tab.account.dataStoreID, "new browser account isolates cookie and localStorage")
        browser.open(before.id); session.show(); window.contentView = view
        try check(session.tab === tab, "pin restores same live tab and account")
        session.startCapture()
        try await wait { if case .saved? = session.capture?.state { return true }; if case .failed? = session.capture?.state { return true }; return false }
        guard case .saved(let saved)? = session.capture?.state else { throw NSError(domain: "Capture failed", code: 4) }
        let pack = WebCapturePack(folder: saved.pack)
        try check(pack.manifest?.url == origin + "/fixture.html", "capture records actual current URL")
        for name in ["dom.html", "outline.json", "screenshot.png", "events.jsonl", "network.har"] {
            let data = try Data(contentsOf: saved.pack.appending(path: name))
            try check(!data.isEmpty, "capture has " + name)
        }
        try check(!pack.events().isEmpty, "capture includes fixture network events")
        try workspace.sendWebsiteCaptureToMaintainer(pack, page: before, request: "Read task details for this account")
        let record = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: saved.pack.appending(path: "website-request.json")))
        try check(record["request"]?.string == "Read task details for this account" && record["allowClicks"]?.bool == true,
            "capture handoff writes user request and click choice beside private evidence")
        try check(workspace.selection == Workspace.maintainerID, "capture handoff opens Maintainer")
        try await wait { workspace.maintainer.messages.contains { $0.text.contains("Read task details for this account") } }
        try check(workspace.maintainer.messages.contains { $0.text.contains("ccb.browser.registerTool") && $0.text.contains(before.account.uuidString) },
            "Maintainer receives evidence path request and exact browser scope without a live model")
        workspace.select(BrowserShelf.selectionID)
        // Browser history and back navigation use the actual WKWebView.
        session.address = origin + "/next.html"; session.navigate()
        try await wait { !view.isLoading && view.url?.path == "/next.html" }
        try check(view.canGoBack, "address bar navigates arbitrary page")
        view.goBack(); try await wait { !view.isLoading && view.url?.path == "/fixture.html" }
        try check(browser.page.id == before.id && browser.page.account == before.account, "back retains tab account identity")
        // Snapshot actual production SwiftUI, full desktop and the app's supported narrow window.
        for width in [1280, 980] {
            let frame = NSRect(x: 0, y: 0, width: width, height: 820)
            let content = RootView(workspace: workspace, settings: SettingsNavigator()).preferredColorScheme(.dark)
            let host = NSHostingView(rootView: content)
            host.frame = frame
            let previewWindow = HeadlessRun.offscreenWindow(frame)
            previewWindow.appearance = NSAppearance(named: .darkAqua)
            previewWindow.contentView = host; windows.append(previewWindow)
            try await Task.sleep(for: .milliseconds(1000))
            host.layoutSubtreeIfNeeded()
            guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw NSError(domain: "No screenshot", code: 5) }
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: out.appending(path: "browser-\(width).png"))
        }
        try JSONEncoder().encode(checks).write(to: out.appending(path: "checks.json"))
        print("\(checks.count) native checks passed; production snapshots 1280/980; synthetic local fixture only")
    }
}
