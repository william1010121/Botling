import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

// Web AIs (Gemini) as bots: the real site in a web view, each conversation a row under it in the
// left column, and its text saved for the main bot. The page is only read, never typed into or
// clicked; what reads it is the plugin's script (`WebExtractors`).

/// One page of a site: a web view that reads its conversation as it changes and saves it once it
/// settles. It reports by its id, so what it reads goes to the row it follows, in front or not.
@MainActor
final class WebTab: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// The page reader's own world: the page's scripts cannot see it, nor it theirs.
    private static let world = WKContentWorld.world(name: "ccb-web-reader")
    private static let messageName = "ccbWebPage"
    /// Sign-in pages refuse web views that do not look like a browser.
    private static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    /// Quiet this long after the page last changed counts as settled (an answer finished).
    private static let settleMilliseconds = 1500
    /// While it changes, it says so at most this often (a question just sent shows at once).
    private static let changedMilliseconds = 1000

    let id: UUID
    let site: WebSite
    let shelf: WebShelf
    let webView: WKWebView
    let openedAt = Date()
    /// When the page last changed (its settled reads), for closing one left behind.
    private(set) var changedAt = Date()
    private var observations: [NSKeyValueObservation] = []
    private var reading = false
    /// Asked to read while a read was under way: read again once it ends (settled if any was).
    private var readAgain: Bool?

    init(id: UUID = UUID(), site: WebSite, shelf: WebShelf) {
        self.id = id
        self.site = site
        self.shelf = shelf
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: site.dataStoreID)
        // A page out of sight (behind the one in front, or while a bot is picked) keeps running,
        // so an answer still comes and is read.
        configuration.preferences.inactiveSchedulingPolicy = .none
        let observer = """
        (() => {
          let timer = null, last = 0;
          const post = (kind) => window.webkit.messageHandlers.\(Self.messageName).postMessage(kind);
          const changed = () => {
            clearTimeout(timer);
            timer = setTimeout(() => post("settled"), \(Self.settleMilliseconds));
            const now = Date.now();
            if (now - last > \(Self.changedMilliseconds)) { last = now; post("changed"); }
          };
          const start = () => { new MutationObserver(changed).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); changed(); };
          if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: observer, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: Self.world))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = Self.userAgent
        super.init()
        configuration.userContentController.add(self, contentWorld: Self.world, name: Self.messageName)
        // LaTeX snippets and live preview in the site's input box (web-laas, in the app's resources).
        WebLaas.shared(resources: AppResources.bundle.url(forResource: "web-laas", withExtension: nil))?.install(in: webView)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // A new question gets its id by the page changing its address, without a new load.
        observations.append(webView.observe(\.url, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.addressChanged() }
        })
        observations.append(webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.addressChanged() }
        })
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    func close() {
        observations = []
        webView.stopLoading()
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.removeFromSuperview()
        shelf.closed(id)
    }

    private func addressChanged() {
        guard let url = webView.url else { return }
        shelf.pageChanged(on: site, page: id, url: url, pageTitle: webView.title)
    }

    /// The page settled ("settled"), or changes still ("changed"): read it with the plugin's
    /// script. A read while it changes is only for a question just sent, so it is skipped while
    /// the row this page follows already waits for its answer.
    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            let settled = (message.body as? String) != "changed"
            if settled { changedAt = Date() }
            if !settled, shelf.row(of: id, on: site)?.isAwaiting == true { return }
            read(settled: settled)
        }
    }

    private func read(settled: Bool) {
        guard let url = webView.url, url.host()?.lowercased() == site.host else {
            if let url = webView.url { shelf.pageChanged(on: site, page: id, url: url, pageTitle: webView.title) }
            return
        }
        guard !reading else {
            readAgain = (readAgain ?? false) || settled
            return
        }
        guard let source = shelf.extractor(for: site) else {
            if settled { shelf.record(on: site, page: id, url: url, pageTitle: webView.title, reading: .nothing(L("No page reader for {0} was found.", site.name))) }
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
                if self.webView.url == url {
                    self.shelf.record(on: self.site, page: self.id, url: url, pageTitle: self.webView.title, reading: reading, settled: settled)
                }
                if let again = self.readAgain {
                    self.readAgain = nil
                    self.read(settled: again)
                }
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

/// One site's pages and their sign-in (a persistent data store per site), kept for the whole
/// run: switching bots and back does not reload them. The page in front is in the chat column;
/// one you leave while its question still waits for an answer goes on behind it until the answer
/// is read and saved, so a new question or another bot never loses it.
@MainActor
final class WebSession {
    private static var sessions: [String: WebSession] = [:]
    /// A page left behind is looked at this often; it closes once quiet with nothing waiting.
    private static let checkSeconds: Double = 15
    /// Quiet this long after its answer was read, a page left behind closes.
    private static let quietSeconds: TimeInterval = 20
    /// A page left behind never stays longer than this; its row, if still waiting, is read
    /// again from its address later.
    private static let longestBehind: TimeInterval = 15 * 60
    /// Pages opened at once only to read a waiting row again.
    private static let readingAgainAtMost = 2

    static func session(for site: WebSite, shelf: WebShelf) -> WebSession {
        if let session = sessions[site.id] { return session }
        let session = WebSession(site: site, shelf: shelf)
        sessions[site.id] = session
        return session
    }

    /// Opens pages behind to read rows still waiting for an answer (after a restart), only
    /// when there are any.
    static func readAgain(_ site: WebSite, shelf: WebShelf) {
        guard !HeadlessRun.isRequested(), !shelf.toReadAgain(on: site).isEmpty else { return }
        session(for: site, shelf: shelf).readAgain()
    }

    let site: WebSite
    let shelf: WebShelf
    private(set) var front: WebTab
    private(set) var behind: [WebTab] = []
    /// Rows read again this run, so one whose answer never comes is not opened over and over.
    private var readAgainRows: Set<String> = []

    private init(site: WebSite, shelf: WebShelf) {
        self.site = site
        self.shelf = shelf
        front = WebTab(id: WebShelf.firstPage, site: site, shelf: shelf)
    }

    /// Loads what was asked for (a row, "New question"); on first show, the open conversation.
    func loadIfNeeded() {
        if let url = shelf.requested[site.id] {
            let row = shelf.requestedRow[site.id]
            shelf.handled(site)
            if let row, shelf.row(of: front.id, on: site)?.id == row {
                // Already in front.
            } else if let row, let index = behind.firstIndex(where: { shelf.row(of: $0.id, on: site)?.id == row }) {
                let tab = behind.remove(at: index)
                leaveFront()
                put(tab)
            } else if front.webView.url == nil {
                front.load(url)
            } else {
                leaveFront()
                let tab = WebTab(site: site, shelf: shelf)
                put(tab)
                tab.load(url)
            }
        } else if front.webView.url == nil {
            front.load(shelf.openConversation(of: site).flatMap { shelf.hasAddress($0, on: site) ? $0.url : nil } ?? site.startURL)
        }
        readAgain()
    }

    private func put(_ tab: WebTab) {
        front = tab
        shelf.bringToFront(tab.id, on: site)
    }

    /// The page in front goes behind: a question on it may have just been sent, so it is kept
    /// until it is quiet with nothing waiting.
    private func leaveFront() {
        behind.append(front)
        scheduleCheck()
    }

    /// Reads rows still waiting for an answer from their own address, on pages behind.
    func readAgain() {
        let reading = behind.filter { tab in readAgainRows.contains { shelf.row(of: tab.id, on: site)?.id == $0 } }.count
        for row in shelf.toReadAgain(on: site).prefix(max(0, Self.readingAgainAtMost - reading)) where !readAgainRows.contains(row.id) {
            readAgainRows.insert(row.id)
            let tab = WebTab(site: site, shelf: shelf)
            behind.append(tab)
            tab.load(row.url)
        }
        if !behind.isEmpty { scheduleCheck() }
    }

    private var checking = false

    private func scheduleCheck() {
        guard !checking else { return }
        checking = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.checkSeconds) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.checking = false
                self.closeFinished()
                if !self.behind.isEmpty { self.scheduleCheck() }
            }
        }
    }

    /// Closes pages behind whose question was answered and saved (and that went quiet), and any
    /// kept too long.
    private func closeFinished() {
        let now = Date()
        behind.removeAll { tab in
            let waiting = shelf.row(of: tab.id, on: site)?.isAwaiting == true
            let done = (!waiting && now.timeIntervalSince(tab.changedAt) >= Self.quietSeconds) || now.timeIntervalSince(tab.openedAt) >= Self.longestBehind
            if done { tab.close() }
            return done
        }
    }
}

/// The site's web view in the chat column: the page in front, with the ones behind it under it
/// (in the window, so they keep drawing).
private struct WebPage: NSViewRepresentable {
    let session: WebSession
    /// The page in front, so a new one is put in place.
    let front: UUID

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        place(in: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        place(in: container)
    }

    private func place(in container: NSView) {
        let views = session.behind.map(\.webView) + [session.front.webView]
        for view in container.subviews where !views.contains(where: { $0 === view }) { view.removeFromSuperview() }
        for view in views {
            if view.superview !== container {
                view.removeFromSuperview()
                view.frame = container.bounds
                view.autoresizingMask = [.width, .height]
                container.addSubview(view)
            }
        }
        // The front page on top; only it takes clicks and keys.
        let front = session.front.webView
        if container.subviews.last !== front { container.addSubview(front, positioned: .above, relativeTo: nil) }
        if let window = container.window, let responder = window.firstResponder as? NSView,
           session.behind.contains(where: { responder.isDescendant(of: $0.webView) }) {
            window.makeFirstResponder(front)
        }
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

/// The chat column for a web site: a strip that says whether the page was saved for the main
/// bot, and the real site, from the top (no Chat | Board switch: a web site has no Board).
struct WebSiteColumn: View {
    @ObservedObject var shelf: WebShelf
    let site: WebSite

    /// The page readers shipped in the app (the plugin's fallback).
    static var bundledExtractors: URL? {
        AppResources.bundle.url(forResource: "web-extractors", withExtension: nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                strip
                Rectangle().fill(Theme.line).frame(height: 1)
                if HeadlessRun.isRequested() {
                    placeholder
                } else {
                    let session = WebSession.session(for: site, shelf: shelf)
                    WebPage(session: session, front: shelf.frontPage(of: site))
                        .onAppear { session.loadIfNeeded() }
                        .onChange(of: shelf.requested[site.id]) { _, _ in session.loadIfNeeded() }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
            .padding(.horizontal, 20)
            .padding(.vertical, 20)
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
        case .waiting:
            Label(L("Waiting for {0}'s answer…", site.name), systemImage: "hourglass")
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .help(L("Listed already; its answer is saved when it comes, even if you open something else"))
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
                workspace.openFresh(site)
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
        .help(L("{0} in the app: a new question; conversations are saved as text the main bot can search", site.name))
        .accessibilityLabel(L("{0}, web, {1} conversations", site.name, count))
    }
}

/// Under a site: its questions that you have not settled, drawn and settled like a bot's
/// subagents. One still waiting for its answer comes first, with a live dot; once you have
/// viewed one and moved on (or press its clock) it leaves for the right panel's "Questions".
private struct WebConversationRows: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var shelf: WebShelf
    let site: WebSite
    @State private var showsAll = false
    static let listedAtMost = TraceBook.listedAtMost

    var body: some View {
        let all = shelf.listed(of: site)
        let more = max(0, all.count - Self.listedAtMost)
        ForEach(showsAll ? all : Array(all.prefix(Self.listedAtMost))) { conversation in
            WebConversationRow(conversation: conversation, workspace: workspace, shelf: shelf, site: site)
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
}

/// One question's row, like a subagent's: a live dot while it waits for its answer, and once
/// answered (or while the pointer is on it) the clock that settles it.
private struct WebConversationRow: View {
    let conversation: WebConversation
    @ObservedObject var workspace: Workspace
    @ObservedObject var shelf: WebShelf
    let site: WebSite
    @State private var hovering = false

    private var open: Bool { workspace.selectedWebSite == site && shelf.open[site.id] == conversation.id }

    /// How it is marked: like a subagent at work while it waits, else done (or failed when its
    /// page could not be read).
    private var mark: Subagent.Mark {
        if conversation.isAwaiting { return .live }
        if open, case .unreadable = shelf.status[site.id] { return .failed }
        return .done
    }

    var body: some View {
        let showsSettle = hovering || !conversation.isAwaiting
        HStack(spacing: 0) {
            Button { workspace.open(conversation, on: site) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.faint)
                    Text(conversation.title.isEmpty ? site.name : conversation.title)
                        .font(.system(size: 13))
                        .foregroundStyle(open || conversation.isAwaiting ? Theme.text : Theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                }
                .padding(.leading, 26)
                .padding(.trailing, 4)
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(conversation.question ?? conversation.url.absoluteString)
            .accessibilityLabel(L("{0} conversation: {1}", site.name, conversation.title))
            Button { shelf.settle(conversation, of: site) } label: {
                Group {
                    if showsSettle {
                        SubagentRow.settleIcon(mark)
                    } else {
                        SubagentRows.mark(mark)
                    }
                }
                .frame(width: 24, height: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(showsSettle)
            .help(conversation.isAwaiting ? L("Settle: move to Questions in the right panel (its answer is still saved)") : L("Settle: move to Questions in the right panel"))
            .accessibilityLabel(L("Settle {0}", conversation.title))
            .padding(.trailing, 6)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(open ? Theme.selected : .clear))
        .onHover { hovering = $0 }
        .contextMenu {
            if conversation.file != nil {
                Button(L("Ask Main bot about this")) { workspace.askMainBot(about: conversation, on: site) }
            }
            Button(L("Settle")) { shelf.settle(conversation, of: site) }
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
                        .help(L("Opens {0} fresh; a question you send there is a row at once", site.startURL.absoluteString))
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
            Text(L("Ask {0} something: it is listed as soon as you send it, and saved once it has an answer.", site.name))
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var questions: some View {
        let all = shelf.conversations(of: site)
        if !all.isEmpty {
            VStack(spacing: 0) {
                ForEach(all) { conversation in
                    let open = shelf.open[site.id] == conversation.id
                    Button { workspace.open(conversation, on: site) } label: {
                        HStack {
                            Text(conversation.title.isEmpty ? site.name : conversation.title)
                                .font(.system(size: 13))
                                .foregroundStyle(open ? Theme.text : Theme.muted)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            if conversation.isAwaiting {
                                SubagentRows.mark(.live)
                            } else {
                                Text(Self.when(conversation.updatedAt))
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.faint)
                            }
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 36)
                        .background(open ? Theme.selected : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(conversation.isSettled ? L("Opens it, and lists it in the left column again") : L("Opens it"))
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
