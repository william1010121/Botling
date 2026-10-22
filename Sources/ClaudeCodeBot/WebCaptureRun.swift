import AppKit
import ClaudeCodeBotCore
import WebKit

/// Headless runs for web captures:
///
/// `ClaudeCodeBot --test-extractor <capture | site folder | captures folder> [--extractor <file.js>]`
/// replays each capture: its dom.html in an offscreen web view (no page scripts, no network) and
/// its events, through the page reader (the plugin's, else the app's; or `--extractor`), exactly
/// as the app reads a page. A capture passes when what is read is its expected.json and the
/// page and traffic readings agree; one without expected.json is skipped. Exits 0 when at least
/// one passed and none failed.
///
/// `ClaudeCodeBot --capture-test <page URL> --site <id> [--seconds N] [--out <folder>] [--extractor <file.js>]`
/// is for testing the capture itself against a local page that mimics a site: the page loads in
/// a real web bot page (the tap, the reader) while a capture records, then the capture is written
/// under `<folder>/captures` and what the bot saved is printed.
@MainActor
enum WebCaptureRun {
    static let testFlag = "--test-extractor"
    static let captureFlag = "--capture-test"

    private static var window: NSWindow?
    private static var keep: [AnyObject] = []

    static func runIfRequested() -> Bool {
        let arguments = CommandLine.arguments
        let value = { (flag: String) -> String? in
            arguments.firstIndex(of: flag).flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        }
        if let path = value(testFlag) {
            Task { await test(URL(filePath: (path as NSString).expandingTildeInPath).standardizedFileURL, extractor: value("--extractor").map { URL(filePath: $0) }) }
            return true
        }
        if let page = value(captureFlag) {
            guard let url = URL(string: page), let id = value("--site"), let site = WebSite.all.first(where: { $0.id == id }) else {
                fail("Usage: \(captureFlag) <page URL> --site <\(WebSite.all.map(\.id).joined(separator: "|"))> [--seconds N] [--out <folder>] [--extractor <file.js>]")
            }
            let out = value("--out").map { URL(filePath: $0).standardizedFileURL }
                ?? FileManager.default.temporaryDirectory.appending(path: "ccb-capture-test-\(UUID().uuidString)")
            capture(url, site: site, seconds: value("--seconds").flatMap(Double.init) ?? 6, out: out, extractor: value("--extractor").map { URL(filePath: $0) })
            return true
        }
        return false
    }

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }

    // MARK: --test-extractor

    private static func test(_ path: URL, extractor: URL?) async {
        let packs = WebCapturePack.packs(at: path)
        guard !packs.isEmpty else { fail("No captures in \(path.path).") }
        let library = Workspace.Layout.plugins(in: FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claudecodebot"))
        let custom = extractor.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        if extractor != nil, custom == nil { fail("Can't read \(extractor!.path).") }
        let view = await replayView()
        var passed = 0, failed = 0, skipped = 0
        for pack in packs {
            let label = pack.folder.deletingLastPathComponent().lastPathComponent + "/" + pack.name
            guard let manifest = pack.manifest, let site = WebSite.all.first(where: { $0.id == manifest.site }) else {
                print("✗ \(label): manifest.json is missing or unreadable")
                failed += 1
                continue
            }
            guard let expected = pack.expected else {
                print("- \(label): no expected.json yet (skipped)")
                skipped += 1
                continue
            }
            guard let source = custom ?? WebExtractors.script(for: site, library: library, bundled: WebSiteColumn.bundledExtractors)?.source else {
                print("✗ \(label): no page reader for \(site.name)")
                failed += 1
                continue
            }
            let url = URL(string: manifest.url) ?? site.startURL
            await load(pack.html() ?? "<html><body></body></html>", base: url, in: view)
            let both = await WebTab.readBoth(in: view, site: site, source: source, url: url, events: pack.events())
            let merged = WebReaderMerge.merge(page: both.page, network: both.network)
            let unconfirmed = expected.confirmed ? "" : " (expected.json not confirmed yet)"
            if let difference = expected.difference(from: merged.reading) {
                print("✗ \(label): \(difference)\(unconfirmed)")
                failed += 1
            } else if case .mismatch(let why) = merged.check {
                print("✗ \(label): the expected messages were read, but the page and the traffic differ: \(why)")
                failed += 1
            } else {
                let how = merged.check == .agree ? "page and traffic agree" : "page only"
                print("✓ \(label): \(expected.turns.count) messages as expected (\(how))\(unconfirmed)")
                passed += 1
            }
        }
        print("Passed \(passed), failed \(failed), skipped \(skipped)")
        exit(failed == 0 && passed > 0 ? 0 : 1)
    }

    /// A web view that shows a saved page as it was: none of its scripts run and nothing loads
    /// from the network.
    private static func replayView() async -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]"#
        if let list = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ccb-capture-replay", encodedContentRuleList: rules) {
            configuration.userContentController.add(list)
        }
        let frame = NSRect(x: 0, y: 0, width: 1200, height: 900)
        let view = WKWebView(frame: frame, configuration: configuration)
        let window = HeadlessRun.offscreenWindow(frame)
        window.contentView = view
        self.window = window
        return view
    }

    private static func load(_ html: String, base: URL, in view: WKWebView) async {
        let waiter = LoadWaiter()
        view.navigationDelegate = waiter
        await withCheckedContinuation { continuation in
            waiter.done = { continuation.resume() }
            view.loadHTMLString(html, baseURL: base)
        }
        view.navigationDelegate = nil
    }

    private final class LoadWaiter: NSObject, WKNavigationDelegate {
        var done: (() -> Void)?
        private func finish() {
            done?()
            done = nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
    }

    // MARK: --capture-test

    private static func capture(_ url: URL, site real: WebSite, seconds: Double, out: URL, extractor: URL?) {
        guard let host = url.host() else { fail("\(url) has no host.") }
        // The site as it is, at the test page's host.
        let site = WebSite(id: real.id, name: real.name, startURL: url, host: host, conversationMarker: real.conversationMarker, insideDomains: [host],
                           accent: real.accent, symbol: real.symbol, selectionID: UUID(), dataStoreID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000CF")!)
        let shelf = WebShelf(folder: out.appending(path: "web"), library: out.appending(path: "plugins"))
        shelf.bundledExtractors = WebSiteColumn.bundledExtractors
        if let extractor {
            guard let text = try? String(contentsOf: extractor, encoding: .utf8) else { fail("Can't read \(extractor.path).") }
            let folder = WebExtractors.folder(in: shelf.library)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? Data(text.utf8).write(to: folder.appending(path: site.extractorFile))
        }
        // The site's front page, as in the app.
        let tab = WebTab(id: WebShelf.firstPage, site: site, shelf: shelf)
        let frame = NSRect(x: 0, y: 0, width: 1100, height: 800)
        let window = HeadlessRun.offscreenWindow(frame)
        tab.webView.frame = frame
        window.contentView = tab.webView
        self.window = window
        let capture = WebCapture(site: site)
        keep = [tab, shelf, capture]
        let started = Date()
        capture.start(on: tab, shelf: shelf, now: started)
        tab.load(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            Task { @MainActor in
                await capture.save(tab: tab, shelf: shelf, since: started, reason: "you") { folder in
                    guard let folder else { fail("The capture was not written.") }
                    print("Capture: \(folder.path)")
                    if case .saved(let saved) = capture.state {
                        print("Traffic: \(saved.counts.requests) requests, \(saved.counts.streams) streams, \(saved.counts.bytes) bytes")
                        print("Reader: page \(saved.pageMessages.map(String.init) ?? "nothing"), traffic \(saved.networkMessages.map(String.init) ?? "nothing"), \(describe(saved.check))")
                    }
                    if let row = shelf.conversations(of: site).first, let file = shelf.fileURL(of: row, site: site) {
                        print("Saved by the bot: \(file.path) (\(row.messages) messages)")
                    } else {
                        print("Saved by the bot: nothing (\(String(describing: shelf.status[site.id])))")
                    }
                    print("Bot's last check: \(shelf.readerCheck[site.id].map(describe) ?? "none")")
                    exit(0)
                }
            }
        }
    }

    private static func describe(_ check: WebReaderCheck) -> String {
        switch check {
        case .agree: "page and traffic agree"
        case .pageOnly: "page only"
        case .mismatch(let why): "mismatch: \(why)"
        }
    }
}

extension WebCaptureRun {
    /// A snapshot's SAMPLE capture state on `site` (nothing is recorded): `recording`, or `saved`
    /// with the page reader's readings differing (so the strip offers Re-capture), plus two
    /// sample captures on disk, one whose expected answer waits for your OK.
    static func sample(_ mode: String, on site: WebSite, in workspace: Workspace) {
        let now = Date()
        let shelf = workspace.web
        let turns = (0..<6).map { WebTurn(role: $0 % 2 == 0 ? .user : .assistant, text: "Sample message \($0 + 1)") }
        for (index, minutesAgo) in [26.0 * 60, 50].enumerated() {
            let ended = now.addingTimeInterval(-minutesAgo * 60)
            let input = WebCaptureInput(site: site, url: site.conversationURL("8f3a2c1d9e0b"), pageTitle: "Sample", startedAt: ended.addingTimeInterval(-70), endedAt: ended,
                                        stoppedBy: "you", events: [], html: nil, outline: nil, screenshot: nil, extractor: nil, output: nil, appVersion: "sample")
            if let pack = try? WebCapturePack.write(input, in: shelf.capturesFolder) {
                let expected = WebCaptureExpected(title: "WKWebView or iframe?", turns: turns, confirmed: index == 0)
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                try? encoder.encode(expected).write(to: pack.folder.appending(path: "expected.json"))
            }
        }
        let capture = WebCapture.of(site)
        switch mode {
        case "recording":
            capture.show(.recording(since: now.addingTimeInterval(-42)), counts: WebNetCounts(requests: 37, streams: 3, bytes: 2_150_000))
        default:
            let why = "Message 6 in the traffic (assistant: \"Sample message 6\") is not on the page (5 messages there, 6 in the traffic)."
            if let open = shelf.openConversation(of: site) {
                shelf.noteReader(.mismatch(why), reading: .read(title: open.title, turns: turns), on: site, url: open.url, readerHash: "sample")
            }
            capture.show(.saved(WebCapture.Saved(
                pack: shelf.capturesFolder.appending(path: "\(site.id)/\(WebCapturePack.folderName(at: now))"), seconds: 72,
                counts: WebNetCounts(requests: 58, streams: 4, bytes: 3_400_000), stoppedBy: "you",
                pageMessages: 5, networkMessages: 6, readsNetwork: true, check: .mismatch(why), pageProblem: nil
            )))
        }
    }
}
