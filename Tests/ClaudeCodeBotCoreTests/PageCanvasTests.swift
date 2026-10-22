import AppKit
import Foundation
import Testing
import WebKit
@testable import ClaudeCodeBotCore

/// A result page opened in its own window, in the app's dark look. The window behind the page is
/// near-black, so a page must paint its own canvas the way a browser would.
@MainActor
struct PageCanvasTests {
    /// The page drawn in a dark window: the canvas colour at the corner, and the darkest and
    /// lightest pixel luminance (text) inside the page.
    private func draw(_ html: String, appPage: Bool = false) async throws -> (corner: Double, darkest: Double, lightest: Double) {
        let frame = NSRect(x: 0, y: 0, width: 400, height: 200)
        let window = HeadlessRun.offscreenWindow(frame)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(white: 0.08, alpha: 1)
        let view = WKWebView(frame: frame, configuration: WKWebViewConfiguration())
        PageCanvas.prepare(view, appPage: appPage)
        window.contentView = view
        defer { window.close() }
        let loaded = Loaded()
        view.navigationDelegate = loaded
        view.loadHTMLString(html, baseURL: nil)
        for _ in 0..<200 where !loaded.done { try await Task.sleep(for: .milliseconds(25)) }
        #expect(loaded.done)
        try await Task.sleep(for: .milliseconds(300))
        let image = try await view.takeSnapshot(configuration: nil)
        let rep = try #require(image.cgImage(forProposedRect: nil, context: nil, hints: nil).map(NSBitmapImageRep.init(cgImage:)))
        // Drawn over the window's own colour, as the window shows it.
        func luminance(_ x: Int, _ y: Int) -> Double {
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return 0 }
            let a = c.alphaComponent
            let under = 0.08
            func mix(_ v: Double) -> Double { v * a + under * (1 - a) }
            return 0.2126 * mix(c.redComponent) + 0.7152 * mix(c.greenComponent) + 0.0722 * mix(c.blueComponent)
        }
        var darkest = 1.0, lightest = 0.0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 1) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 1) {
                let l = luminance(x, y)
                darkest = min(darkest, l)
                lightest = max(lightest, l)
            }
        }
        return (luminance(rep.pixelsWide - 2, rep.pixelsHigh - 2), darkest, lightest)
    }

    private let text = "<h1>opensearch MR !32 修改報告</h1><p>Some words in the page.</p>"

    @Test func aPageThatSetsNoColoursIsAWhitePageWithBlackText() async throws {
        let page = try await draw("<!doctype html><meta charset=utf-8>\(text)")
        #expect(page.corner > 0.9)
        #expect(page.darkest < 0.2)
    }

    @Test func aPageThatSetsOnlyLightThemeColoursIsReadable() async throws {
        // The MR !32 report: dark text, light code chips, no background of its own.
        let page = try await draw("<!doctype html><meta charset=utf-8><style>body{color:#222}code{background:#f4f4f6}</style>\(text)<code>x</code>")
        #expect(page.corner > 0.9)
        #expect(page.darkest < 0.2)
    }

    @Test func aPageThatSupportsDarkModeStaysDark() async throws {
        let page = try await draw("<!doctype html><meta charset=utf-8><meta name=color-scheme content='light dark'>\(text)")
        #expect(page.corner < 0.2)
        #expect(page.lightest > 0.8)
    }

    @Test func aPageWithItsOwnDarkStylesKeepsThem() async throws {
        let page = try await draw("<!doctype html><meta charset=utf-8><style>@media (prefers-color-scheme: dark){html{background:#111;color:#eee}}</style>\(text)")
        #expect(page.corner < 0.2)
        #expect(page.lightest > 0.8)
    }

    @Test func theAppsOwnPagesStaySeeThrough() async throws {
        let page = try await draw("<!doctype html><meta charset=utf-8><meta name=color-scheme content=dark><style>html,body{background:transparent;color:#EDEDF0}</style>\(text)", appPage: true)
        #expect(page.corner < 0.2)
        #expect(page.lightest > 0.8)
    }
}

@MainActor
private final class Loaded: NSObject, WKNavigationDelegate {
    var done = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done = true }
}
