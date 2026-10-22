import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

// Web AIs (Gemini) as bots: the real site in a web view, each conversation a row under it in the
// left column, and its text saved for the main bot. The page is only read, never typed into or
// clicked; what reads it is the plugin's script (`WebExtractors`).

/// One site's web view and its own sign-in (a persistent data store per site), kept for the
/// whole run: switching bots and back does not reload it.
@MainActor
final class WebSession: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static var sessions: [String: WebSession] = [:]

    static func session(for site: WebSite, shelf: WebShelf) -> WebSession {
        if let session = sessions[site.id] { return session }
        let session = WebSession(site: site, shelf: shelf)
        sessions[site.id] = session
        return session
    }

    /// The page reader's own world: the page's scripts cannot see it, nor it theirs.
    private static let world = WKContentWorld.world(name: "ccb-web-reader")
    private static let messageName = "ccbWebSettled"
    /// Sign-in pages refuse web views that do not look like a browser.
    private static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    /// Quiet this long after the page last changed counts as settled (an answer finished).
    private static let settleMilliseconds = 1500

    let site: WebSite
    let shelf: WebShelf
    let webView: WKWebView
    private var observations: [NSKeyValueObservation] = []
    private var reading = false

    private init(site: WebSite, shelf: WebShelf) {
        self.site = site
        self.shelf = shelf
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: site.dataStoreID)
        let observer = """
        (() => {
          let timer = null;
          const settled = () => { clearTimeout(timer); timer = setTimeout(() => window.webkit.messageHandlers.\(Self.messageName).postMessage(location.href), \(Self.settleMilliseconds)); };
          const start = () => { new MutationObserver(settled).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); settled(); };
          if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: observer, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: Self.world))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = Self.userAgent
        super.init()
        configuration.userContentController.add(self, contentWorld: Self.world, name: Self.messageName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // A new question gets its id by the page changing its address, without a new load.
        observations.append(webView.observe(\.url, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated { self?.addressChanged() }
        })
        observations.append(webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.addressChanged() }
        })
    }

    /// Loads what was asked for (a row, "New question"); on first show, the open conversation.
    func loadIfNeeded() {
        if let url = shelf.requested[site.id] {
            shelf.handled(site)
            webView.load(URLRequest(url: url))
        } else if webView.url == nil {
            webView.load(URLRequest(url: shelf.openConversation(of: site)?.url ?? site.startURL))
        }
    }

    private func addressChanged() {
        guard let url = webView.url else { return }
        shelf.pageChanged(on: site, url: url, pageTitle: webView.title)
    }

    /// The page settled: read it with the plugin's script and save what it found.
    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { read() }
    }

    private func read() {
        guard !reading, let url = webView.url, site.conversationID(in: url) != nil else {
            if let url = webView.url { shelf.pageChanged(on: site, url: url, pageTitle: webView.title) }
            return
        }
        guard let source = shelf.extractor(for: site) else {
            shelf.record(on: site, url: url, pageTitle: webView.title, reading: .nothing(L("No page reader for {0} was found.", site.name)))
            return
        }
        reading = true
        webView.callAsyncJavaScript(WebExtractors.call(source), arguments: [:], in: nil, in: Self.world) { [weak self] result in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.reading = false
                let reading: WebReading = switch result {
                case .success(let value): WebReading.decode(value as? String)
                case .failure(let error): .nothing(error.localizedDescription)
                }
                // The page may have moved on while it was read.
                guard self.webView.url == url else { return }
                self.shelf.record(on: self.site, url: url, pageTitle: self.webView.title, reading: reading)
            }
        }
    }

    // Sign-in and the site's own pop-ups stay inside; other sites open in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.targetFrame?.isMainFrame != false, action.navigationType == .linkActivated,
           ["http", "https"].contains(url.scheme ?? ""), !site.keepsInside(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if site.keepsInside(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }
}

/// The site's web view in the chat column.
private struct WebPage: NSViewRepresentable {
    let session: WebSession

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        place(in: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        if session.webView.superview !== container { place(in: container) }
    }

    private func place(in container: NSView) {
        let view = session.webView
        view.removeFromSuperview()
        view.frame = container.bounds
        view.autoresizingMask = [.width, .height]
        container.addSubview(view)
    }
}

/// A site's face: a rounded tile in its colour with a sparkle (no company logo).
struct WebSiteFace: View {
    let site: WebSite
    var size: CGFloat = 32

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28)
            .fill(Color(hex: site.accent))
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: "sparkle")
                    .font(.system(size: size * 0.5, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }
}

/// The chat column for a web site: the Chat | Board bar (Board is for bots), a strip that says
/// whether the page was saved for the main bot, and the real site.
struct WebSiteColumn: View {
    @ObservedObject var shelf: WebShelf
    let site: WebSite

    /// The page readers shipped in the app (the plugin's fallback).
    static var bundledExtractors: URL? {
        AppResources.bundle.url(forResource: "web-extractors", withExtension: nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            BoardSwitch(board: false, boardAvailable: false) { _ in }
                .padding(.top, BoardSwitch.barTop)
                .padding(.bottom, BoardSwitch.barBottom)
                .frame(maxWidth: .infinity)
            VStack(spacing: 0) {
                strip
                Rectangle().fill(Theme.line).frame(height: 1)
                if HeadlessRun.isRequested() {
                    placeholder
                } else {
                    let session = WebSession.session(for: site, shelf: shelf)
                    WebPage(session: session)
                        .onAppear { session.loadIfNeeded() }
                        .onChange(of: shelf.requested[site.id]) { _, _ in session.loadIfNeeded() }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.ground)
    }

    private var address: String {
        let url = shelf.openConversation(of: site)?.url ?? site.startURL
        let path = url.path()
        return (url.host() ?? "") + (path.count > 24 ? String(path.prefix(23)) + "…" : path)
    }

    private var strip: some View {
        HStack(spacing: 10) {
            Text(address)
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .lineLimit(1)
            Spacer(minLength: 8)
            WebStatusLine(status: shelf.status[site.id] ?? .reading, site: site)
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
    }

    /// Snapshots draw no web page (nothing is loaded or signed into).
    private var placeholder: some View {
        VStack(spacing: 8) {
            WebSiteFace(site: site, size: 40)
            Text(L("{0} shows here, signed in as you.", site.startURL.host() ?? site.name))
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// "● Saved for Main bot · 6 messages", or why not.
struct WebStatusLine: View {
    let status: WebPageStatus
    let site: WebSite

    var body: some View {
        switch status {
        case .saved(let messages, _):
            Label {
                Text(L("Saved for Main bot · {0} messages", messages))
            } icon: {
                Circle().fill(Theme.green).frame(width: 7, height: 7)
            }
            .font(.system(size: 12))
            .foregroundStyle(Theme.green)
        case .unreadable(let reason):
            Label(L("Couldn't read this page"), systemImage: "exclamationmark.triangle")
                .font(.system(size: 12))
                .foregroundStyle(Theme.orange)
                .help(L("Nothing was saved. {0} The page reader is in the plugin ccb-web-extractors; ask Maintainer to fix it.", reason))
        case .newQuestion:
            Text(L("A new question is saved once it has an answer"))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
        case .reading:
            Text(L("Reading…"))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
        }
    }
}

/// The left column's "Web" section: each site, and its conversations under it.
struct WebRailSection: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var shelf: WebShelf

    init(workspace: Workspace) {
        self.workspace = workspace
        shelf = workspace.web
    }

    var body: some View {
        Text(L("Web"))
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 10)
            .frame(height: 28)
            .padding(.top, 6)
        ForEach(WebSite.all) { site in
            WebSiteRow(site: site, count: shelf.conversations(of: site).count, selected: workspace.selectedWebSite == site && shelf.open[site.id] == nil) {
                workspace.select(site)
            }
            WebConversationRows(workspace: workspace, shelf: shelf, site: site)
        }
    }
}

/// A site's row, drawn like a bot's.
private struct WebSiteRow: View {
    let site: WebSite
    let count: Int
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                WebSiteFace(site: site)
                Text(site.name).font(.system(size: 15)).lineLimit(1)
                Spacer(minLength: 4)
                if count > 0 {
                    Text("\(count)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.faint)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 48)
            .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : hovering ? Theme.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(L("{0} in the app: its conversations are saved as text the main bot can search", site.name))
        .accessibilityLabel(L("{0}, web, {1} conversations", site.name, count))
    }
}

/// Under a site: its conversations, newest first, drawn like a bot's subagents.
private struct WebConversationRows: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var shelf: WebShelf
    let site: WebSite
    @State private var showsAll = false
    static let listedAtMost = 5

    var body: some View {
        let all = shelf.conversations(of: site)
        let more = max(0, all.count - Self.listedAtMost)
        ForEach(showsAll ? all : Array(all.prefix(Self.listedAtMost))) { conversation in
            row(conversation)
        }
        if more > 0 {
            Button { showsAll.toggle() } label: {
                Text(showsAll ? L("Show less") : L("Show {0} more", more))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 45)
                    .frame(height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func row(_ conversation: WebConversation) -> some View {
        let open = workspace.selectedWebSite == site && shelf.open[site.id] == conversation.id
        let unreadable = if open, case .unreadable = shelf.status[site.id] { true } else { false }
        return Button {
            workspace.select(site)
            shelf.show(conversation, of: site)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.turn.down.right")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                Text(conversation.title.isEmpty ? site.name : conversation.title)
                    .font(.system(size: 13))
                    .foregroundStyle(open ? Theme.text : Theme.muted)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Group {
                    if unreadable {
                        Image(systemName: "exclamationmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.orange)
                    } else if conversation.file != nil {
                        Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint)
                    }
                }
                .frame(width: 24)
            }
            .padding(.leading, 26)
            .padding(.trailing, 6)
            .frame(minHeight: 30)
            .background(RoundedRectangle(cornerRadius: 10).fill(open ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(conversation.url.absoluteString)
        .accessibilityLabel(L("{0} conversation: {1}", site.name, conversation.title))
        .contextMenu {
            if conversation.file != nil {
                Button(L("Ask Main bot about this")) { workspace.askMainBot(about: conversation, on: site) }
            }
        }
    }
}

/// The right panel for a web site: this question (title, messages, when saved, its file), the
/// buttons, and every question.
struct WebPanel: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var shelf: WebShelf
    let site: WebSite

    init(workspace: Workspace, site: WebSite) {
        self.workspace = workspace
        shelf = workspace.web
        self.site = site
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(spacing: 10) {
                    WebSiteFace(site: site, size: 28)
                    Text(site.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Spacer()
                }
                .frame(height: 40)

                PanelSection(L("This question")) {
                    VStack(alignment: .leading, spacing: 10) {
                        thisQuestion
                    }
                }

                PanelSection(L("Questions")) {
                    VStack(spacing: 6) {
                        questions
                        Button { shelf.startNew(on: site) } label: {
                            Label(L("New question"), systemImage: "plus")
                                .font(.system(size: 14))
                                .frame(maxWidth: .infinity, minHeight: 40)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.chip))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(L("Opens {0} fresh; once it has an id it becomes a row", site.startURL.absoluteString))
                    }
                }
            }
            .padding(20)
            .padding(.top, 16)
        }
        .scrollIndicators(.never)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
    }

    @ViewBuilder private var thisQuestion: some View {
        if let conversation = shelf.openConversation(of: site) {
            VStack(alignment: .leading, spacing: 6) {
                Text(conversation.title.isEmpty ? site.name : conversation.title)
                    .font(.system(size: 14, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let savedAt = conversation.savedAt {
                    Text(L("{0} messages · saved {1}", conversation.messages, savedAt.formatted(date: .omitted, time: .shortened)))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.muted)
                }
                if let file = shelf.fileURL(of: conversation, site: site) {
                    Button { NSWorkspace.shared.activateFileViewerSelecting([file]) } label: {
                        Text(file.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.faint)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .buttonStyle(.plain)
                    .help(L("Show in Finder"))
                } else {
                    WebStatusLine(status: shelf.status[site.id] ?? .reading, site: site)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))

            Button { workspace.askMainBot(about: conversation, on: site) } label: {
                Label(L("Ask Main bot about this"), systemImage: "bubble.left")
                    .font(.system(size: 14))
                    .foregroundStyle(conversation.file == nil ? Theme.faint : Theme.text)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(RoundedRectangle(cornerRadius: 10).stroke(Theme.blue.opacity(0.7), lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(conversation.file == nil)
            .help(L("Sends the main bot a message naming the saved file, so it can read it"))
        } else {
            Text(L("Ask {0} something; the conversation is listed and saved once it has an answer.", site.name))
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var questions: some View {
        let all = shelf.conversations(of: site)
        if !all.isEmpty {
            VStack(spacing: 0) {
                ForEach(all.prefix(12)) { conversation in
                    let open = shelf.open[site.id] == conversation.id
                    Button { shelf.show(conversation, of: site) } label: {
                        HStack {
                            Text(conversation.title.isEmpty ? site.name : conversation.title)
                                .font(.system(size: 13))
                                .foregroundStyle(open ? Theme.text : Theme.muted)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            Text(Self.when(conversation.updatedAt))
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.faint)
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 36)
                        .background(open ? Theme.selected : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }

    /// "15:42" today, else the weekday or date.
    static func when(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// The right column folded, for a web site: its face opens the panel again.
struct WebStrip: View {
    let site: WebSite
    let open: () -> Void

    var body: some View {
        VStack {
            Button(action: open) { WebSiteFace(site: site, size: 28) }
                .buttonStyle(.plain)
                .padding(.top, 52)
                .help(L("Show right panel"))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.side)
    }
}
