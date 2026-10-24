import AppKit
import ClaudeCodeBotCore
import WebKit

/// Separate from the conversation extractor: no selectors or JavaScript supplied by plugins.
/// Targets are opaque handles into the last observation, in an isolated world.
@MainActor
enum BrowserOperations {
    static let world = WKContentWorld.world(name: "ccb-browser-operations")
    static let script = #"""
    if (location.origin !== origin) throw Error("The page origin changed.");
    const state = globalThis.__ccbBrowserObservation;
    if (operation === "observe") {
      const next = { url: location.href, targets: new Map() };
      globalThis.__ccbBrowserObservation = next;
      if (!globalThis.__ccbBrowserMutationObserver) {
        globalThis.__ccbBrowserMutationObserver = new MutationObserver(() => { globalThis.__ccbBrowserObservation = null; });
        globalThis.__ccbBrowserMutationObserver.observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
      }
      const elements = [...document.querySelectorAll('a,button,input:not([type=password]),select,textarea,[role=button],h1,h2,h3,p,li,td,th')]
        .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').slice(0, 500);
      const targets = elements.map(el => {
        const id = crypto.randomUUID();
        next.targets.set(id, { el, text: el.textContent, type: el.getAttribute('type'), href: el.getAttribute('href') });
        return { id, tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 2000) };
      });
      return JSON.stringify({ url: location.href, title: document.title, targets });
    }
    const seen = state && state.url === location.href && state.targets.get(target);
    if (!seen || !seen.el.isConnected || !seen.el.getClientRects().length || getComputedStyle(seen.el).visibility === 'hidden'
        || seen.text !== seen.el.textContent || seen.type !== seen.el.getAttribute('type') || seen.href !== seen.el.getAttribute('href'))
      throw Error("Target is stale. Observe the current page again.");
    if (seen.el.matches('input[type=password]')) throw Error("Password fields are excluded.");
    if (operation === "extract") return JSON.stringify({ text: (seen.el.innerText || '').slice(0, 50000) });
    if (operation === "click") {
      if (!seen.el.matches('a,button,input[type=button],input[type=submit],[role=button]') || seen.el.disabled)
        throw Error("Target is not an enabled clickable element.");
      globalThis.__ccbBrowserObservation = null;
      seen.el.click();
      return JSON.stringify({ clicked: true });
    }
    throw Error("Unknown browser operation.");
    """#
    static func perform(_ params: JSONValue, in view: WKWebView) async throws -> JSONValue {
        let result = try await view.callAsyncJavaScript(script, arguments: [
            "origin": params["origin"]?.string ?? "", "operation": params["operation"]?.string ?? "", "target": params["target"]?.string ?? ""
        ], in: nil, contentWorld: world)
        guard let text = result as? String, let data = text.data(using: .utf8) else { throw NSError(domain: "Browser", code: 2, userInfo: [NSLocalizedDescriptionKey: "No browser result."]) }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
