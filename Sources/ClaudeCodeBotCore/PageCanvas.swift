import AppKit
import WebKit

/// What a web view paints behind a page.
public enum PageCanvas {
    /// Sets up `view` for a page: `appPage` for the app's own pages (viewer.html), which are
    /// drawn over the window; anything else is a page a bot or a person wrote.
    ///
    /// A written page gets the canvas a browser gives it. WebKit paints that canvas only while the
    /// view draws its background: white for a page that declares no dark support (so its default
    /// black text, or the light colours it chose, stay readable in the app's dark window), dark for
    /// one that declares `color-scheme: dark` or styles itself for dark mode. Left see-through,
    /// such a page's dark text sat straight on the near-black window.
    @MainActor
    public static func prepare(_ view: WKWebView, appPage: Bool) {
        view.setValue(!appPage, forKey: "drawsBackground")
    }
}
