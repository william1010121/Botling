import AppKit
import Foundation
import Testing
import WebKit
@testable import ClaudeCodeBotCore

/// web-laas in a real web view, as the web bots get it (`WebLaas.install`): typing a snippet in a
/// textarea, a contenteditable like Quill's (Gemini) and one like ProseMirror's (ChatGPT, Claude)
/// expands it, and the live preview loads into the frame and draws the formula, also on a page
/// whose CSP allows no inline styles and requires Trusted Types (as Gemini's does).
/// `CCB_WEB_LAAS_SHOTS=<folder>` saves a picture of each page with its preview.
@MainActor
@Suite(.integration)
struct WebLaasTests {
    static let folder = TestPaths.repo.appending(path: "Sources/ClaudeCodeBot/Resources/web-laas")

    static let editors = """
    <textarea id="ta" rows="3" cols="50"></textarea>
    <div class="ql-container"><div id="quill" class="ql-editor" contenteditable="true"><p><br></p></div></div>
    <div id="pm" class="ProseMirror" contenteditable="true"><p><br></p></div>
    """
    static let strictCSP = "style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'"

    private func page(csp: String? = nil, settings: [String: Any] = [:]) async throws -> (WKWebView, NSWindow, UserDefaults) {
        let defaults = try #require(UserDefaults(suiteName: "WebLaasTests-\(UUID().uuidString)"))
        if !settings.isEmpty { defaults.set(settings, forKey: WebLaas.settingsKey) }
        let frame = NSRect(x: 0, y: 0, width: 640, height: 420)
        let window = HeadlessRun.offscreenWindow(frame)
        // as the web bots' pages (`WebTab`): kept running out of sight
        let configuration = WKWebViewConfiguration()
        configuration.preferences.inactiveSchedulingPolicy = .none
        let view = WKWebView(frame: frame, configuration: configuration)
        WebLaas(folder: Self.folder, defaults: defaults).install(in: view)
        window.contentView = view
        // the formula under the caret is read on an animation frame, which a page out of sight never
        // gets: this window is ordered in (off every display, see-through) and counts as seen
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if view.responds(to: occlusion) { view.perform(occlusion, with: false) }
        window.orderFrontRegardless()
        let meta = csp.map { "<meta http-equiv=\"Content-Security-Policy\" content=\"\($0)\">" } ?? ""
        let loaded = Loaded()
        view.navigationDelegate = loaded
        view.loadHTMLString("<!doctype html><meta charset=utf-8>\(meta)<body style=\"font:16px system-ui\">\(Self.editors)</body>", baseURL: URL(string: "https://laas.test/"))
        for _ in 0..<200 where !loaded.done { try await Task.sleep(for: .milliseconds(25)) }
        #expect(loaded.done)
        // the engine says it is ready once its settings arrive
        for _ in 0..<100 {
            if try await run(view, "return !!window.__webLaas") as? Bool == true { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        return (view, window, defaults)
    }

    @discardableResult
    private func run(_ view: WKWebView, _ body: String, in world: WKContentWorld = .page) async throws -> Any? {
        try await view.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: world)
    }

    /// Types `text` into `#id` key by key, as a browser does: keydown, then (unless the engine took
    /// the key) the character goes in with its input event.
    private func type(_ view: WKWebView, _ id: String, _ text: String) async throws {
        for ch in text {
            try await run(view, """
            const el = document.getElementById(\(json(id)));
            el.focus();
            const down = new KeyboardEvent("keydown", { key: \(json(String(ch))), bubbles: true, cancelable: true });
            if (el.dispatchEvent(down)) {
              if (el instanceof HTMLTextAreaElement) {
                el.setRangeText(down.key, el.selectionStart, el.selectionEnd, "end");
                el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: down.key, bubbles: true }));
              } else document.execCommand("insertText", false, down.key);
            }
            el.dispatchEvent(new KeyboardEvent("keyup", { key: down.key, bubbles: true }));
            """)
            try await Task.sleep(for: .milliseconds(30))
        }
        try await Task.sleep(for: .milliseconds(150))
    }

    private func text(_ view: WKWebView, _ id: String) async throws -> String {
        try await run(view, "const el = document.getElementById(\(json(id))); return el.value ?? el.innerText") as? String ?? ""
    }

    /// The live preview's card: whether it is on the page, and whether its own styles hold (its card
    /// is `position: fixed` in a shadow root, so a styled host takes no room in the page).
    private func preview(_ view: WKWebView) async throws -> (shown: Bool, styled: Bool) {
        for _ in 0..<120 {
            let found = try await run(view, """
            const host = document.querySelector("[data-web-laas-preview]");
            return host ? host.getBoundingClientRect().height : -1
            """) as? Double ?? -1
            if found >= 0 { return (true, found == 0) }
            try await Task.sleep(for: .milliseconds(50))
        }
        return (false, false)
    }

    private func shot(_ view: WKWebView, _ name: String) async throws {
        guard let folder = ProcessInfo.processInfo.environment["CCB_WEB_LAAS_SHOTS"], !folder.isEmpty else { return }
        try await Task.sleep(for: .milliseconds(200))
        let image = try await view.takeSnapshot(configuration: nil)
        let rep = try #require(image.cgImage(forProposedRect: nil, context: nil, hints: nil).map(NSBitmapImageRep.init(cgImage:)))
        try rep.representation(using: .png, properties: [:])?.write(to: URL(filePath: folder).appending(path: "\(name).png"))
    }

    private func json(_ s: String) -> String {
        String(decoding: try! JSONEncoder().encode(s), as: UTF8.self)
    }

    @Test func snippetsExpandInATextareaAndBothKindsOfContentEditable() async throws {
        let (view, window, _) = try await page()
        defer { window.close() }
        for id in ["ta", "quill", "pm"] {
            try await type(view, id, "x $;a")
            let typed = try await text(view, id)
            #expect(typed.contains("\\alpha"), "\(id): \(typed)")
        }
    }

    @Test func thePreviewLoadsOnFirstMathAndDrawsTheFormula() async throws {
        let (view, window, _) = try await page()
        defer { window.close() }
        // not loaded until the caret is in math
        let early = try await run(view, "return !!window.__webLaasPreviewAlive", in: WebLaas.world) as? Bool
        #expect(early == false)
        try await type(view, "quill", "$;a^2")
        let card = try await preview(view)
        #expect(card.shown)
        #expect(card.styled)
        let loaded = try await run(view, "return !!window.__webLaasPreviewAlive", in: WebLaas.world) as? Bool
        #expect(loaded == true)
        try await shot(view, "web-laas-preview")
    }

    @Test func thePreviewSurvivesAStrictStyleAndTrustedTypesPolicy() async throws {
        let (view, window, _) = try await page(csp: Self.strictCSP)
        defer { window.close() }
        // the policy holds for the page itself
        let pageStyle = try await run(view, """
        const s = document.createElement("style"); s.textContent = "#ta { width: 333px }"; document.head.append(s);
        return document.getElementById("ta").getBoundingClientRect().width
        """) as? Double
        #expect(pageStyle != 333)
        let probe = try await run(view, """
        let html; try { document.createElement("div").innerHTML = "<b>x</b>"; html = "allowed" } catch (e) { html = e.name }
        return [typeof window.trustedTypes, html].join()
        """)
        let ours = try await run(view, "try { document.createElement('div').innerHTML = '<b>x</b>'; return 'allowed' } catch (e) { return e.name }", in: WebLaas.world)
        print("web-laas strict CSP page: trustedTypes, innerHTML in the page's world =", probe ?? "nil", "; in the app's world =", ours ?? "nil")
        // the preview's MathJax markup goes in by innerHTML: Trusted Types hold for the page's world only
        #expect(ours as? String == "allowed")
        try await type(view, "pm", "$;b")
        let typed = try await text(view, "pm")
        #expect(typed.contains("\\beta"))
        let card = try await preview(view)
        #expect(card.shown)
        #expect(card.styled)
        try await shot(view, "web-laas-preview-strict-csp")
    }

    @Test func thePageCannotSeeTheAppsSide() async throws {
        let (view, window, _) = try await page()
        defer { window.close() }
        let seen = try await run(view, "return [typeof chrome, typeof __ccbLaasShim, typeof __ccbLaasState, typeof window.webkit?.messageHandlers?.ccbWebLaas].join()") as? String
        #expect(seen == "undefined,undefined,undefined,undefined")
        // nor its DOM changed (the app's world adopts refused <style>s in its own prototypes)
        let native = try await run(view, "return [Element.prototype.append, Element.prototype.remove, DocumentFragment.prototype.append].every(f => String(f).includes('[native code]'))") as? Bool
        #expect(native == true)
    }

    @Test func pausingIsKeptAndTheEngineStopsExpanding() async throws {
        let (view, window, defaults) = try await page()
        defer { window.close() }
        // ⌥⇧L, as the extension's in-page shortcut
        try await run(view, """
        document.getElementById("ta").focus();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Ï", code: "KeyL", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        """)
        for _ in 0..<40 where defaults.dictionary(forKey: WebLaas.settingsKey)?["enabled"] as? Bool != false { try await Task.sleep(for: .milliseconds(25)) }
        #expect(defaults.dictionary(forKey: WebLaas.settingsKey)?["enabled"] as? Bool == false)
        try await type(view, "ta", "$;a")
        let typed = try await text(view, "ta")
        #expect(typed == "$;a")
    }

    @Test func aPausedEngineStartsPausedInANewPage() async throws {
        let (view, window, _) = try await page(settings: ["enabled": false])
        defer { window.close() }
        try await type(view, "ta", "$;a")
        let typed = try await text(view, "ta")
        #expect(typed == "$;a")
    }
}

private final class Loaded: NSObject, WKNavigationDelegate {
    var done = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done = true }
}
