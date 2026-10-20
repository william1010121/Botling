import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

/// Opens what a link points at: web pages in the default browser, local files (result pages,
/// pictures) in a window of their own, one per file.
@MainActor
enum ResultWindows {
    private static var windows: [URL: NSWindow] = [:]

    static func open(_ result: Chip) {
        let url = result.url
        guard url.isFileURL else {
            NSWorkspace.shared.open(url)
            return
        }
        if let window = windows[url] {
            // Again: show it fresh (the file may have changed).
            window.title = result.label
            window.contentView = NSHostingView(rootView: viewer(result, in: window))
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate()
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = result.label
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: viewer(result, in: window))
        window.center()
        // Each new one a little down and right of the last.
        if let last = lastTopLeft { lastTopLeft = window.cascadeTopLeft(from: last) } else { lastTopLeft = window.cascadeTopLeft(from: .zero) }
        windows[url] = window
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { _ in
            MainActor.assumeIsolated {
                _ = windows.removeValue(forKey: url)
                if windows.isEmpty { lastTopLeft = nil }
                if let token { NotificationCenter.default.removeObserver(token) }
            }
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    private static var lastTopLeft: NSPoint?

    private static func viewer(_ result: Chip, in window: NSWindow) -> some View {
        ResultViewer(result: result) { [weak window] in window?.close() }
            .frame(minWidth: 480, minHeight: 360)
            .preferredColorScheme(.dark)
            .id(UUID())
    }
}

/// One result page in its own window: what was made, at a size worth looking at.
struct ResultViewer: View {
    let result: Chip
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 6) {
                Text(result.label)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                Spacer()
                Button { NSWorkspace.shared.open(result.url) } label: {
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open in browser")
                Button(action: close) {
                    Image(systemName: "xmark")
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Close")
            }
            PageView(url: result.url)
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .padding(.horizontal, 24)
        .padding(.top, 36)
        .padding(.bottom, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.side)
    }
}

/// A web view for a local result page (or a web link).
struct PageView: NSViewRepresentable {
    let url: URL

    final class Coordinator {
        var loaded: URL?
        /// What the view was pointed at for `loaded` (a `ccb-preview:` URL for a result page).
        var target: URL?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Result pages in an `artifacts` folder load through `ccb-preview:`, so a video or sound
        // beside them plays (served in byte ranges); see `PagePreview.windowURL(for:)`.
        configuration.setURLSchemeHandler(PreviewSchemeHandler.shared, forURLScheme: PagePreview.scheme)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        load(url, in: view, context.coordinator)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        // Opening the result again also brings it back from a page it linked to.
        if context.coordinator.loaded != url || view.url != context.coordinator.target { load(url, in: view, context.coordinator) }
    }

    /// Text files WebKit would read as Latin-1 when nothing in them names an encoding.
    private static let textTypes = ["html": "text/html", "htm": "text/html", "txt": "text/plain", "md": "text/plain",
                                    "csv": "text/plain", "json": "text/plain", "log": "text/plain"]

    private func load(_ url: URL, in view: WKWebView, _ coordinator: Coordinator) {
        coordinator.loaded = url
        coordinator.target = url
        let served = PagePreview.windowURL(for: url)
        if served != url {
            // Served with its charset (UTF-8 pages read right) and the files beside it.
            coordinator.target = served
            view.load(URLRequest(url: served))
        } else if url.isFileURL, let mime = Self.textTypes[url.pathExtension.lowercased()],
           let data = try? Data(contentsOf: url), Self.isPlainUTF8(data) {
            // Pages bots write often have no <meta charset>, and such a file is read as Latin-1
            // (Chinese turns to mojibake). Valid UTF-8 that names no other encoding is read as
            // UTF-8; pictures beside it still load. Anything else loads as before.
            view.load(data, mimeType: mime, characterEncodingName: "utf-8", baseURL: url)
        } else if url.isFileURL {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            view.load(URLRequest(url: url))
        }
    }

    /// Valid UTF-8 that does not declare some other charset near the top (Big5, GBK…).
    static func isPlainUTF8(_ data: Data) -> Bool {
        guard String(data: data, encoding: .utf8) != nil else { return false }
        let head = String(decoding: data.prefix(4096), as: UTF8.self).lowercased()
        guard let range = head.range(of: #"charset\s*=\s*["']?\s*([a-z0-9_\-]+)"#, options: .regularExpression) else { return true }
        let declared = head[range].split(whereSeparator: { "=\"' ".contains($0) }).last.map(String.init) ?? ""
        return declared == "utf-8" || declared == "utf8"
    }
}
