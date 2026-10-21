import AppKit
import ClaudeCodeBotCore
import WebKit

/// Takes the pictures 「網頁預覽卡片」 cards show (see `PageShots`): each page is loaded in an
/// offscreen view at the card's desktop size (`PagePreview.viewport`), given a moment to draw, and saved as
/// JPEG. One page at a time; `made` runs after each, so open chats redraw with the picture.
@MainActor
final class PageShotMaker: NSObject, WKNavigationDelegate {
    static let shared = PageShotMaker()

    /// Runs after a picture is saved.
    var made: () -> Void = {}

    private var queue: [(page: URL, destination: URL)] = []
    private var busy = false
    private var window: NSWindow?
    private var view: WKWebView?
    private var finish: ((Bool) -> Void)?
    /// Which page is loading: a timer left from an earlier page does nothing.
    private var generation = 0

    /// Makes `PageShots` ask this for pictures.
    func install(made: @escaping () -> Void) {
        self.made = made
        PageShots.maker = { page, destination in
            Task { @MainActor in PageShotMaker.shared.add(page, destination) }
        }
    }

    private func add(_ page: URL, _ destination: URL) {
        queue.append((page, destination))
        next()
    }

    private func next() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let (page, destination) = queue.removeFirst()
        let view = makeView()
        generation += 1
        finish = { [weak self] loaded in
            guard let self else { return }
            self.finish = nil
            Task { @MainActor in
                if loaded, await self.save(view, to: destination) { self.made() }
                view.stopLoading()
                view.loadHTMLString("", baseURL: nil)
                self.busy = false
                self.next()
            }
        }
        view.load(URLRequest(url: page))
        // A page that never finishes loading (a stuck request) is pictured as it is after 8 s.
        settle(after: 8)
    }

    private func makeView() -> WKWebView {
        if let view { return view }
        let frame = NSRect(x: 0, y: 0, width: PagePreview.viewport.width, height: PagePreview.viewport.height)
        let window = HeadlessRun.offscreenWindow(frame)
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(PreviewSchemeHandler.shared, forURLScheme: PagePreview.scheme)
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: frame, configuration: configuration)
        view.navigationDelegate = self
        window.contentView = view
        self.window = window
        self.view = view
        return view
    }

    /// The picture, at 960 px wide (the card is at most about that on a Retina screen).
    private func save(_ view: WKWebView, to destination: URL) async -> Bool {
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = 960
        guard let image = try? await view.takeSnapshot(configuration: configuration),
              let tiff = image.tiffRepresentation,
              let jpeg = NSBitmapImageRep(data: tiff)?.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return false }
        try? FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard (try? jpeg.write(to: destination, options: .atomic)) != nil else { return false }
        PageShots.prune()
        return true
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.scheme == PagePreview.scheme else { return }
        // Fonts, pictures and a page's own scripts draw a little after the load ends.
        settle(after: 1.2)
    }

    /// Pictures the current page `seconds` from now, unless another page is loading by then.
    private func settle(after seconds: Double) {
        let generation = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.generation == generation else { return }
            self.finish?(true)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish?(false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish?(false)
    }

    /// Only the page itself loads; its links do not navigate the offscreen view.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.targetFrame?.isMainFrame == false || action.request.url?.scheme == PagePreview.scheme || action.request.url?.absoluteString == "about:blank" ? .allow : .cancel
    }
}
