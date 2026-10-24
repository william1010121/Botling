import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

@MainActor
final class BrowserSession: ObservableObject {
    let workspace: Workspace
    let browser: BrowserShelf
    @Published var tab: WebTab?
    @Published var address = ""
    @Published var problem: String?
    @Published var result: String?
    @Published var running = false
    @Published var capturedPage: BrowserShelf.Page?
    @Published var capture: WebCapture?
    private var tabs: [UUID: WebTab] = [:]
    private var observations: [NSKeyValueObservation] = []
    private var grant: (plugin: String, page: BrowserShelf.Page)?
    init(workspace: Workspace) { self.workspace = workspace; browser = workspace.browser }
    func show() {
        let page = browser.page
        if let current = tab, current.id == page.id { loadRequested(); return }
        revoke()
        let selected = tabs[page.id] ?? WebTab(id: page.id, site: page.captureSite, shelf: workspace.web, generalBrowsing: true)
        tabs[page.id] = selected
        tab = selected
        address = page.url.absoluteString
        capture = nil; result = nil; problem = nil
        observations = [selected.webView.observe(\.url, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated { self?.changed(view) }
        }, selected.webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.runRequested() }
        }, selected.webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated { self?.changed(view) }
        }]
        browser.perform = { [weak self] plugin, params in
            guard let self, let grant = self.grant, grant.plugin == plugin,
                  let tab = self.tab, self.workspace.selection == BrowserShelf.selectionID, self.browser.current == grant.page.id,
                  params["tab"]?.string == tab.id.uuidString, params["account"]?.string == grant.page.account.uuidString,
                  params["origin"]?.string == grant.page.origin,
                  tab.webView.url.flatMap(BrowserShelf.origin) == grant.page.origin else {
                throw NSError(domain: "Browser", code: 1, userInfo: [NSLocalizedDescriptionKey: "Browser scope changed or this plugin has no active user invocation."])
            }
            if params["operation"]?.string == "click", !self.browser.clicksAllowed(for: grant.page) {
                throw NSError(domain: "Browser", code: 3, userInfo: [NSLocalizedDescriptionKey: "Allow tool clicks for this website and account first."])
            }
            return try await BrowserOperations.perform(params, in: tab.webView)
        }
        if browser.requestedURL != nil { loadRequested() }
        else if selected.webView.url == nil { selected.load(page.url) }
        else { runRequested() }
    }
    func loadRequested() {
        guard let tab, let url = browser.requestedURL, tab.id == browser.current else { return }
        browser.requestedURL = nil
        if tab.webView.url != url { tab.load(url) } else { runRequested() }
    }
    private func changed(_ view: WKWebView) {
        guard let tab, tab.webView === view, let url = view.url else { return }
        address = url.absoluteString
        browser.update(tab.id, url: url, title: view.title)
        objectWillChange.send()
    }
    func navigate() {
        guard let url = BrowserShelf.address(address) else { problem = "Enter an HTTP or HTTPS address."; return }
        problem = nil; tab?.load(url)
    }
    func startCapture() {
        guard let tab, !running, capture?.isBusy != true, !tab.webView.isLoading, let url = tab.webView.url, BrowserShelf.origin(url) != nil else { return }
        browser.update(tab.id, url: url, title: tab.webView.title)
        let capture = WebCapture(site: browser.page.captureSite)
        capturedPage = browser.page
        self.capture = capture
        capture.start(on: tab, shelf: workspace.web)
        capture.stop()
    }
    func revoke() { grant = nil }
    func runRequested() {
        guard let request = browser.toolRequest, let tab, !tab.webView.isLoading, tab.webView.url != nil else { return }
        browser.toolRequest = nil
        run(request)
    }
    func run(_ tool: BrowserShelf.Tool, on page: BrowserShelf.Page? = nil) {
        guard !running else { return }
        if let page { browser.open(page.id); show() }
        guard browser.tools.contains(tool), browser.page.origin == tool.origin else { return }
        guard let url = tab?.webView.url, BrowserShelf.origin(url) == tool.origin, tab?.webView.isLoading == false,
              let host = workspace.pluginHost else { problem = "Wait for this website to finish loading."; return }
        let scope = browser.page
        running = true; problem = nil; result = nil
        grant = (tool.plugin, scope)
        Task {
            defer { grant = nil; running = false }
            do {
                let value = try await host.webCall(plugin: tool.plugin, method: "browser.tool." + tool.key, params: scope.scope)
                let data = try JSONEncoder().encode(value)
                result = String(data: data, encoding: .utf8)
            } catch { problem = error.localizedDescription }
        }
    }
}

private struct BrowserWebView: NSViewRepresentable {
    let tab: WebTab
    func makeNSView(context: Context) -> NSView { let container = NSView(); container.addSubview(tab.webView); return container }
    func updateNSView(_ nsView: NSView, context: Context) {
        if tab.webView.superview !== nsView { nsView.subviews.forEach { $0.removeFromSuperview() }; nsView.addSubview(tab.webView) }
        tab.webView.frame = nsView.bounds
        tab.webView.autoresizingMask = [.width, .height]
    }
}

struct BrowserColumn: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var browser: BrowserShelf
    @StateObject private var session: BrowserSession
    let visible: Bool
    init(workspace: Workspace, visible: Bool) {
        self.workspace = workspace; self.visible = visible; browser = workspace.browser
        _session = StateObject(wrappedValue: BrowserSession(workspace: workspace))
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { session.tab?.webView.goBack() } label: { Image(systemName: "chevron.left") }.help("Back")
                Button { session.tab?.webView.reload() } label: { Image(systemName: "arrow.clockwise") }.help("Reload")
                TextField("Website address", text: $session.address).textFieldStyle(.roundedBorder).onSubmit { session.navigate() }
                    .accessibilityIdentifier("browser-address")
                Button { browser.togglePin() } label: { Image(systemName: browser.page.pinned ? "pin.fill" : "pin") }.help(browser.page.pinned ? "Unpin website" : "Pin website")
                Menu {
                    ForEach(browser.pages) { page in
                        Button((page.id == browser.current ? "✓ " : "") + "Account \((browser.pages.firstIndex(where: { $0.id == page.id }) ?? 0) + 1) · " + (page.title.isEmpty ? (page.url.host ?? "Website") : page.title)) { browser.open(page.id) }
                    }
                    Divider()
                    Button("New account") { browser.newAccount() }
                } label: { Image(systemName: "person.crop.circle") }.menuStyle(.borderlessButton).fixedSize().help("Browser accounts")
                Button { session.startCapture() } label: { Label("Capture", systemImage: "record.circle") }.disabled(session.running || session.capture?.isBusy == true)
            }
            .buttonStyle(.plain).font(.system(size: 13)).foregroundStyle(Theme.muted)
            .padding(12).background(Theme.side)
            if !browser.tools(for: browser.page).isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(browser.tools(for: browser.page)) { tool in Button(tool.title) { session.run(tool) }.disabled(session.running) }
                    }.padding(10)
                }.fixedSize(horizontal: false, vertical: true).background(Theme.bubble)
            }
            if let capture = session.capture, let page = session.capturedPage { BrowserCaptureRequest(capture: capture, workspace: workspace, browser: browser, page: page) }
            if session.running { ProgressView("Running website tool…").controlSize(.small).padding(10) }
            if let problem = session.problem { Text(problem).font(.system(size: 12)).foregroundStyle(Theme.errorText).padding(10) }
            if let result = session.result {
                HStack(alignment: .top) {
                    ScrollView { Text(result).textSelection(.enabled).font(.system(size: 12, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 130)
                    Button { session.result = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }.padding(10).background(Theme.bubble)
            }
            if let tab = session.tab { BrowserWebView(tab: tab).id(tab.id) } else { Spacer() }
        }
        .background(Theme.ground)
        .onAppear { if visible { session.show() } }
        .onChange(of: visible) { _, value in if value { session.show() } else { session.revoke() } }
        .onChange(of: browser.requestedURL) { _, _ in if visible { session.loadRequested() } }
        .onChange(of: browser.toolRequest) { _, _ in if visible { session.runRequested() } }
        .onChange(of: browser.current) { _, _ in if visible { session.show() } }
    }
}

private struct BrowserCaptureRequest: View {
    @ObservedObject var capture: WebCapture
    let workspace: Workspace
    @ObservedObject var browser: BrowserShelf
    let page: BrowserShelf.Page
    @State private var problem: String?
    @State private var request = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch capture.state {
            case .saving, .recording: ProgressView("Saving current page…").controlSize(.small)
            case .saved(let saved):
                TextField("What data or action should this website tool provide?", text: $request).textFieldStyle(.roundedBorder)
                Toggle("Allow tool clicks for this website and account", isOn: Binding(get: { browser.clicksAllowed(for: page) }, set: { browser.allowClicks($0, for: page) })).font(.system(size: 12))
                if let problem { Text(problem).font(.system(size: 12)).foregroundStyle(Theme.errorText) }
                HStack {
                    Button("Send to Maintainer") {
                        do {
                            try workspace.sendWebsiteCaptureToMaintainer(WebCapturePack(folder: saved.pack), page: page, request: request)
                            capture.dismiss()
                        } catch { problem = error.localizedDescription }
                    }.disabled(request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Reveal in Finder") { capture.reveal() }
                    Button("Close") { capture.dismiss() }
                }.font(.system(size: 12))
            case .failed(let reason): Text(reason).foregroundStyle(Theme.errorText)
            case .idle: EmptyView()
            }
        }.padding(capture.state == .idle ? 0 : 12).background(Theme.bubble)
    }
}

struct BrowserRailRows: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var browser: BrowserShelf
    var body: some View {
        row("Browser", symbol: "globe", selected: workspace.selection == BrowserShelf.selectionID) { workspace.select(BrowserShelf.selectionID) }
        ForEach(browser.pins, id: \.pinID) { page in
            row(page.title.isEmpty ? page.url.host! : page.title, symbol: "pin.fill", selected: workspace.selection == BrowserShelf.selectionID && browser.current == page.id && browser.page.origin == page.origin) {
                browser.openPin(page); workspace.select(BrowserShelf.selectionID)
            }
            // A tool opens its pinned website/account before it is invoked.
            ForEach(browser.tools(for: page)) { tool in
                Button(tool.title) {
                    browser.openPin(page); browser.toolRequest = tool; workspace.select(BrowserShelf.selectionID)
                }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.leading, 44)
            }
        }
    }
    private func row(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) { Image(systemName: symbol).frame(width: 28); Text(title).lineLimit(1); Spacer(minLength: 0) }
                .font(.system(size: 14)).foregroundStyle(Theme.text).padding(.horizontal, 10).frame(height: 42)
                .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : .clear)).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct BrowserPanel: View {
    @ObservedObject var browser: BrowserShelf
    let collapsed: Bool
    let expand: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if collapsed { Button(action: expand) { Image(systemName: "sidebar.right") }.buttonStyle(.plain) }
            else {
                Text("Browser").font(.system(size: 18, weight: .semibold))
                Text(browser.page.url.host ?? "Website").font(.system(size: 13)).foregroundStyle(Theme.muted)
                Text("Browse and sign in, then Capture the page and describe the tool you need. Pin keeps this website and its account in Web.").font(.system(size: 13)).foregroundStyle(Theme.muted)
                Toggle("Allow tool clicks for this website and account", isOn: Binding(get: { browser.clicksAllowed(for: browser.page) }, set: { browser.allowClicks($0, for: browser.page) })).font(.system(size: 12))
                ForEach(browser.tools(for: browser.page)) { tool in Text(tool.title).font(.system(size: 13)) }
            }
            Spacer()
        }.padding(collapsed ? 10 : 20).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(Theme.side)
    }
}
