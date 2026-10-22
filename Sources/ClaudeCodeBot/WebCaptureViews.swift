import AppKit
import ClaudeCodeBotCore
import SwiftUI
import WebKit

// Capture: a web bot's page and its traffic, saved for Maintainer to fix the page reader from
// (WebNetwork.swift, WebCapturePack.swift). The Capture button in the page's strip records;
// "Re-capture" shows there when the reader could not read the page or its two readings differ.

/// The scripts a capture uses, from the app's resources.
@MainActor
enum WebCaptureScripts {
    /// The tap's message name, in the page's world.
    static let messageName = "ccbWebNet"
    static let netTap = source("net-tap.js")
    static let outline = source("outline.js")

    private static func source(_ name: String) -> String? {
        AppResources.bundle.url(forResource: "web-capture", withExtension: nil)
            .flatMap { try? String(contentsOf: $0.appending(path: name), encoding: .utf8) }
    }

    /// The command Maintainer tests a page reader with.
    static var testCommand: String? {
        Bundle.main.executablePath.map { "'\($0)' \(WebCaptureRun.testFlag)" }
    }
}

/// One site's capture: recording, saving, or what was saved.
@MainActor
final class WebCapture: ObservableObject {
    struct Saved: Equatable {
        let pack: URL
        let seconds: Int
        let counts: WebNetCounts
        let stoppedBy: String
        /// What the reader read from the page (nil: nothing) and from the traffic (nil: it does
        /// not read the traffic, or the traffic held nothing).
        let pageMessages: Int?
        let networkMessages: Int?
        let readsNetwork: Bool
        let check: WebReaderCheck
        let pageProblem: String?
    }

    enum State: Equatable {
        case idle
        case recording(since: Date)
        case saving
        case saved(Saved)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var counts = WebNetCounts()
    let site: WebSite
    private weak var tab: WebTab?
    private weak var shelf: WebShelf?
    private var timer: Timer?

    private static var captures: [String: WebCapture] = [:]

    static func of(_ site: WebSite) -> WebCapture {
        if let capture = captures[site.id] { return capture }
        let capture = WebCapture(site: site)
        captures[site.id] = capture
        return capture
    }

    init(site: WebSite) {
        self.site = site
    }

    /// A snapshot's sample state (nothing is recorded).
    func show(_ state: State, counts: WebNetCounts = WebNetCounts()) {
        self.state = state
        self.counts = counts
    }

    var isBusy: Bool {
        switch state {
        case .recording, .saving: true
        default: false
        }
    }

    /// Starts recording `tab` (the page in front). What it saw in the minutes before is kept too.
    func start(on tab: WebTab, shelf: WebShelf, now: Date = Date()) {
        guard !isBusy else { return }
        self.tab = tab
        self.shelf = shelf
        tab.startRecording(at: now)
        counts = WebNetCounts()
        state = .recording(since: now)
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard case .recording(let since) = state, let tab else { return }
        counts = WebNetCounts.of(tab.network.events(since: since.timeIntervalSince1970 * 1000))
        if Date().timeIntervalSince(since) >= WebCapturePack.maxSeconds {
            stop(by: "time")
        } else if counts.bytes >= WebCapturePack.maxBytes {
            stop(by: "size")
        }
    }

    /// Stop (`by` "you", "time" or "size"): the capture is written, then its summary shows.
    func stop(by reason: String = "you") {
        guard case .recording(let since) = state, let tab, let shelf else { return }
        timer?.invalidate()
        timer = nil
        state = .saving
        Task { await save(tab: tab, shelf: shelf, since: since, reason: reason) }
    }

    /// Writes the capture; `done` gets its folder (the `--capture-test` run waits on it).
    func save(tab: WebTab, shelf: WebShelf, since: Date, reason: String, done: ((URL?) -> Void)? = nil) async {
        let now = Date()
        let events = tab.stopRecording(at: now)
        let url = tab.webView.url ?? site.startURL
        let parts = await tab.pageParts()
        let screenshot = await tab.screenshot()
        let script = WebExtractors.script(for: site, library: shelf.library, bundled: shelf.bundledExtractors)
        var both: (page: WebReading, network: WebReading?, json: String?)?
        if let script { both = await tab.readBoth(script.source, url: url, events: events) }
        let fromPlugin = script.map { $0.url.path.hasPrefix(shelf.library.path) } ?? false
        let input = WebCaptureInput(
            site: site, url: url, pageTitle: tab.webView.title, startedAt: since, endedAt: now, stoppedBy: reason, events: events,
            html: parts.html, outline: parts.outline, screenshot: screenshot,
            extractor: script.map { ($0.source, $0.url, fromPlugin) }, output: both?.json, appVersion: Self.appVersion
        )
        let root = shelf.capturesFolder
        let written = await Task.detached { Result { try WebCapturePack.write(input, in: root) } }.value
        switch written {
        case .success(let pack):
            let merged = both.map { WebReaderMerge.merge(page: $0.page, network: $0.network) }
            let count = { (reading: WebReading?) -> Int? in
                if case .read(_, let turns)? = reading { return turns.count }
                return nil
            }
            var problem: String?
            if case .nothing(let reason)? = both?.page { problem = reason }
            if script == nil { problem = L("No page reader for {0} was found.", site.name) }
            state = .saved(Saved(
                pack: pack.folder, seconds: Int(now.timeIntervalSince(since).rounded()),
                counts: WebNetCounts.of(events.filter { $0.t >= since.timeIntervalSince1970 * 1000 }), stoppedBy: reason,
                pageMessages: count(both?.page), networkMessages: count(both?.network),
                readsNetwork: script.map { WebExtractors.readsNetwork($0.source) } ?? false,
                check: merged?.check ?? .pageOnly, pageProblem: problem
            ))
            done?(pack.folder)
        case .failure(let error):
            state = .failed(error.localizedDescription)
            done?(nil)
        }
    }

    func dismiss() {
        guard !isBusy else { return }
        state = .idle
    }

    func delete() {
        guard case .saved(let saved) = state else { return }
        try? FileManager.default.removeItem(at: saved.pack)
        state = .idle
    }

    func reveal() {
        guard case .saved(let saved) = state else { return }
        NSWorkspace.shared.activateFileViewerSelecting([saved.pack])
    }

    func sendToMaintainer(_ workspace: Workspace) {
        guard case .saved(let saved) = state else { return }
        workspace.sendCaptureToMaintainer(WebCapturePack(folder: saved.pack), site: site, summary: Self.summary(saved), testCommand: WebCaptureScripts.testCommand)
        state = .idle
    }

    /// What Maintainer is told went wrong (English: it is for Maintainer).
    static func summary(_ saved: Saved) -> String {
        var parts: [String] = []
        if let problem = saved.pageProblem { parts.append("The page reader could not read the page: \(problem)") }
        if case .mismatch(let why) = saved.check { parts.append("Its readings of the page and of the traffic differ: \(why)") }
        if !saved.readsNetwork { parts.append("The reader does not read the traffic yet (no extractNetwork).") }
        if parts.isEmpty { parts.append("The reader read \(saved.pageMessages ?? 0) messages from the page\(saved.networkMessages.map { " and \($0) from the traffic" } ?? ""); the user captured it anyway, so check it against the screenshot.") }
        return parts.joined(separator: " ")
    }

    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

/// "0:42"
private func clock(_ seconds: Int) -> String {
    String(format: "%d:%02d", seconds / 60, seconds % 60)
}

/// "58 requests · 4 streams · 3.4 MB"
func captureCounts(_ counts: WebNetCounts) -> String {
    L("{0} requests · {1} streams · {2}", counts.requests, counts.streams, ByteCountFormatter.string(fromByteCount: Int64(counts.bytes), countStyle: .file))
}

/// The capture's card over the page: recording (time, numbers, what to do, Stop), saving, or
/// what was saved and what the page reader read, with what to do with it.
struct WebCaptureCard: View {
    @ObservedObject var capture: WebCapture
    @ObservedObject var workspace: Workspace

    var body: some View {
        switch capture.state {
        case .idle:
            EmptyView()
        case .recording(let since):
            card {
                TimelineView(.periodic(from: since, by: 1)) { context in
                    HStack(spacing: 10) {
                        Circle().fill(Theme.errorText).frame(width: 9, height: 9)
                        Text(L("Recording {0}", clock(Int(context.date.timeIntervalSince(since)))))
                            .font(.system(size: 13, weight: .semibold))
                            .monospacedDigit()
                        Text(captureCounts(capture.counts))
                            .font(.system(size: 12))
                            .monospacedDigit()
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Button { capture.stop() } label: {
                            Label(L("Stop"), systemImage: "stop.fill")
                                .font(.system(size: 12, weight: .medium))
                                .padding(.horizontal, 10)
                                .frame(height: 26)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.chip))
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.escape, modifiers: [])
                    }
                }
                Text(L("Open an older conversation, send a message, and scroll up a little. It stops by itself after 3 minutes or 100 MB."))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .saving:
            card {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(L("Saving the capture…")).font(.system(size: 13))
                    Spacer()
                }
            }
        case .saved(let saved):
            card {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.green)
                    Text(L("Capture saved · {0}", clock(saved.seconds)))
                        .font(.system(size: 13, weight: .semibold))
                        .monospacedDigit()
                    Text(captureCounts(saved.counts))
                        .font(.system(size: 12))
                        .monospacedDigit()
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Button { capture.dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 22, height: 22)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.faint)
                    .help(L("Close"))
                }
                readerLine(saved)
                Text(saved.pack.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 8) {
                    button(L("Send to Maintainer"), symbol: "paperplane", primary: true) { capture.sendToMaintainer(workspace) }
                        .help(L("Maintainer fixes the page reader from this capture, writes the right answer for you to confirm, and tests the reader on every capture"))
                    button(L("Reveal in Finder"), symbol: "folder") { capture.reveal() }
                    button(L("Delete"), symbol: "trash") { capture.delete() }
                    Spacer()
                }
            }
        case .failed(let reason):
            card {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.orange)
                    Text(L("The capture could not be saved: {0}", reason)).font(.system(size: 13)).lineLimit(2)
                    Spacer()
                    Button(L("Close")) { capture.dismiss() }
                }
            }
        }
    }

    @ViewBuilder private func readerLine(_ saved: WebCapture.Saved) -> some View {
        let page = saved.pageMessages.map { L("{0} messages on the page", $0) } ?? L("nothing on the page")
        let traffic: String = if !saved.readsNetwork {
            L("the reader does not read the traffic yet")
        } else if let count = saved.networkMessages {
            L("{0} in the traffic", count)
        } else {
            L("nothing about it in the traffic")
        }
        let (verdict, color): (String, Color) = switch saved.check {
        case .agree: (L("they agree"), Theme.green)
        case .mismatch: (L("they differ"), Theme.orange)
        case .pageOnly: (saved.pageMessages == nil ? L("the reader may be out of date") : "", saved.pageMessages == nil ? Theme.orange : Theme.muted)
        }
        HStack(spacing: 6) {
            Text(L("Page reader:")).foregroundStyle(Theme.muted)
            Text([page, traffic].joined(separator: " · ")).foregroundStyle(Theme.text)
            if !verdict.isEmpty { Text("· " + verdict).foregroundStyle(color) }
        }
        .font(.system(size: 12))
        .lineLimit(2)
        .help({
            if case .mismatch(let why) = saved.check { return why }
            return saved.pageProblem ?? ""
        }())
    }

    private func button(_ title: String, symbol: String, primary: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.system(size: 12, weight: primary ? .semibold : .regular))
                .foregroundStyle(primary ? Color.white : Theme.text)
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 8).fill(primary ? Theme.blue : Theme.chip))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) { content() }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bubble)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

/// The strip's right end: the reader's warning (with Re-capture) or its "updated" news, and Capture.
struct WebCaptureControls: View {
    @ObservedObject var capture: WebCapture
    @ObservedObject var shelf: WebShelf
    let site: WebSite
    /// Starts a capture on the page in front (nil in a snapshot).
    let start: (() -> Void)?

    private var readerProblem: String? {
        if case .mismatch(let why)? = shelf.readerCheck[site.id] { return why }
        if case .unreadable(let reason)? = shelf.status[site.id] { return reason }
        return nil
    }

    var body: some View {
        HStack(spacing: 10) {
            if let problem = readerProblem {
                if case .mismatch? = shelf.readerCheck[site.id] {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.orange)
                        .accessibilityLabel(L("Page reader may be out of date"))
                        .help(L("Page reader may be out of date") + ". " + L("What it read from the page and from the site's traffic differ. {0}", problem))
                }
                captureButton(L("Re-capture"), emphasized: true)
                    .help(L("Records the page and its traffic so Maintainer can fix the page reader"))
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    if let fixed = shelf.readerFixedAt[site.id], context.date.timeIntervalSince(fixed) < 120 {
                        Label(shelf.readerCheck[site.id] == .agree ? L("Page reader updated · page and traffic agree") : L("Page reader updated"), systemImage: "checkmark.seal")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.green)
                            .lineLimit(1)
                    }
                }
                captureButton(L("Capture"), emphasized: false)
                    .help(L("Records the page and its traffic for a few minutes, for Maintainer to fix or test the page reader. Saved privately in ~/.claudecodebot/captures"))
            }
        }
    }

    private func captureButton(_ title: String, emphasized: Bool) -> some View {
        Button { start?() } label: {
            Label(title, systemImage: "record.circle")
                .font(.system(size: 12, weight: emphasized ? .semibold : .regular))
                .foregroundStyle(emphasized ? Theme.orange : Theme.muted)
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 7).stroke(emphasized ? Theme.orange.opacity(0.6) : Theme.line))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(capture.isBusy)
        .accessibilityLabel(title)
    }
}

/// The right panel's "Captures": a site's saved captures, and a card to confirm the right answer
/// Maintainer wrote for one.
struct WebCapturesSection: View {
    @ObservedObject var shelf: WebShelf
    let site: WebSite
    @State private var packs: [WebCapturePack]

    init(shelf: WebShelf, site: WebSite) {
        self.shelf = shelf
        self.site = site
        _packs = State(initialValue: WebCapturePack.list(site, in: shelf.capturesFolder))
    }

    var body: some View {
        VStack(spacing: 0) {
            if !packs.isEmpty {
                PanelSection(L("Captures")) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(packs.filter { $0.expected?.confirmed == false }) { pack in
                            confirmCard(pack)
                        }
                        VStack(spacing: 0) {
                            ForEach(packs) { pack in row(pack) }
                        }
                        .padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
            }
        }
        .task(id: site.id) {
            while !Task.isCancelled {
                reload()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func reload() {
        let found = WebCapturePack.list(site, in: shelf.capturesFolder)
        if found != packs { packs = found }
    }

    private func row(_ pack: WebCapturePack) -> some View {
        Button { NSWorkspace.shared.activateFileViewerSelecting([pack.folder]) } label: {
            HStack(spacing: 8) {
                Image(systemName: "record.circle").font(.system(size: 12)).foregroundStyle(Theme.faint)
                Text(pack.manifest.map { WebPanel.when($0.endedAt) } ?? pack.name)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.muted)
                Spacer(minLength: 8)
                Text(status(pack))
                    .font(.system(size: 12))
                    .foregroundStyle(pack.expected?.confirmed == true ? Theme.green : Theme.faint)
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(L("Show in Finder"))
        .contextMenu {
            Button(L("Show in Finder")) { NSWorkspace.shared.activateFileViewerSelecting([pack.folder]) }
            Button(L("Delete"), role: .destructive) {
                try? FileManager.default.removeItem(at: pack.folder)
                reload()
            }
        }
    }

    private func status(_ pack: WebCapturePack) -> String {
        guard let expected = pack.expected else { return L("No answer yet") }
        return expected.confirmed ? L("Test case · {0} messages", expected.turns.count) : L("Waiting for your OK")
    }

    private func confirmCard(_ pack: WebCapturePack) -> some View {
        let expected = pack.expected!
        return VStack(alignment: .leading, spacing: 8) {
            Text(L("Is this what the conversation says?"))
                .font(.system(size: 13, weight: .semibold))
            Text(L("Maintainer wrote the right answer for the capture of {0}: {1} messages. Once you confirm, every change to the page reader is tested against it.", pack.manifest.map { WebPanel.when($0.endedAt) } ?? pack.name, expected.turns.count))
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                if let title = expected.title, !title.isEmpty {
                    Text(title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                }
                ForEach(Array(expected.turns.prefix(4).enumerated()), id: \.offset) { _, turn in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(turn.role == .user ? L("You") : site.name)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.faint)
                            .frame(width: 52, alignment: .leading)
                        Text(turn.text.replacingOccurrences(of: "\n", with: " "))
                            .font(.system(size: 12))
                            .lineLimit(2)
                    }
                }
                if expected.turns.count > 4 {
                    Text(L("and {0} more", expected.turns.count - 4)).font(.system(size: 11)).foregroundStyle(Theme.faint)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.side))
            HStack(spacing: 8) {
                Button {
                    try? pack.confirmExpected()
                    reload()
                } label: {
                    Text(L("Confirm"))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.blue))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button { NSWorkspace.shared.open(pack.folder.appending(path: "expected.json")) } label: {
                    Text(L("Open"))
                        .font(.system(size: 13))
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.chip))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L("Opens expected.json, to check every message or fix one before you confirm"))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.blue.opacity(0.5)))
    }
}
