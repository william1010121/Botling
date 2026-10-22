import CryptoKit
import Foundation

// Captures: what a web bot's page showed and fetched, saved as a folder ("a pack") Maintainer
// fixes the page reader from and tests it against (`--test-extractor`). They are private: they
// live under ~/.claudecodebot/captures, outside the plugin library (so no plugin commit carries
// one) and outside any repo (/share never sees them).
//
//   captures/<site>/<yyyyMMdd-HHmmss>/
//     manifest.json   address, versions, files, what was masked
//     events.jsonl    each request and each piece of its answer, in time order
//     network.har     the same as HAR
//     dom.html        the page's HTML then (inline scripts removed)
//     outline.json    visible elements: tag, classes, text, position (for writing selectors)
//     screenshot.png  the page as it looked
//     extractor/      the page reader then (<site>.js) and what it read (output.json)
//     expected.json   the right answer: Maintainer writes it, you confirm it in the app

/// What a page reader read from the page and from its traffic, and whether the two agree.
public enum WebReaderCheck: Equatable, Sendable {
    /// The reader reads only the page (no `extractNetwork`), or the traffic held nothing about
    /// this conversation.
    case pageOnly
    /// Both read it and every message one found, the other found too.
    case agree
    /// They differ: the reader may be out of date (why, in plain words).
    case mismatch(String)

    public var isMismatch: Bool {
        if case .mismatch = self { return true }
        return false
    }
}

/// The page reader's two readings put together: the traffic first, the page's text second.
public enum WebReaderMerge {
    /// How alike two texts must be to count as the same message.
    static let alike = 0.8

    /// What to save, and the check. With both readings, a message the traffic has replaces the
    /// page's text of it (the traffic's is the site's own Markdown); one only the page has stays.
    /// When they disagree the page's reading is kept, as before there was any traffic.
    public static func merge(page: WebReading, network: WebReading?) -> (reading: WebReading, check: WebReaderCheck) {
        guard let network, case .read(let networkTitle, let networkTurns) = network else {
            if case .nothing(let reason)? = network, case .read = page {
                return (page, .mismatch("The traffic reader failed: \(reason)"))
            }
            return (page, .pageOnly)
        }
        guard case .read(let pageTitle, let pageTurns) = page else {
            return (network, .mismatch("The page reader found no messages; the traffic has \(networkTurns.count)."))
        }
        let title = networkTitle ?? pageTitle
        // Every message of the traffic, in order, among the page's.
        if let matched = match(networkTurns, in: pageTurns) {
            var turns = pageTurns
            for (networkIndex, pageIndex) in matched.enumerated() { turns[pageIndex] = networkTurns[networkIndex] }
            return (.read(title: title, turns: turns), .agree)
        }
        // Every message of the page among the traffic's (the page shows only part of it).
        if match(pageTurns, in: networkTurns) != nil {
            return (.read(title: title, turns: networkTurns), .agree)
        }
        return (page, .mismatch(difference(page: pageTurns, network: networkTurns)))
    }

    /// Where each of `part` is in `whole`, in order; nil when one is missing.
    static func match(_ part: [WebTurn], in whole: [WebTurn]) -> [Int]? {
        var found: [Int] = []
        var from = 0
        for turn in part {
            guard let index = whole[from...].firstIndex(where: { $0.role == turn.role && similarity($0.text, turn.text) >= alike }) else { return nil }
            found.append(index)
            from = index + 1
        }
        return found
    }

    static func difference(page: [WebTurn], network: [WebTurn]) -> String {
        for (index, turn) in network.enumerated() where !page.contains(where: { $0.role == turn.role && similarity($0.text, turn.text) >= alike }) {
            return "Message \(index + 1) in the traffic (\(turn.role.rawValue): \"\(preview(turn.text))\") is not on the page (\(page.count) messages there, \(network.count) in the traffic)."
        }
        return "The page and the traffic have their messages in a different order (\(page.count) on the page, \(network.count) in the traffic)."
    }

    static func preview(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.count > 60 ? String(line.prefix(59)) + "…" : line
    }

    /// Letters and digits only, lower-cased: Markdown's marks, spacing and punctuation aside.
    static func normalized(_ text: String) -> [Character] {
        text.lowercased().filter { $0.isLetter || $0.isNumber }.map { $0 }
    }

    /// How alike two texts are (0…1), by their pairs of letters (Dice), so the page's rendering
    /// and the traffic's Markdown of one message count as the same.
    public static func similarity(_ a: String, _ b: String) -> Double {
        let x = normalized(a), y = normalized(b)
        if x == y { return 1 }
        guard x.count > 1, y.count > 1 else { return 0 }
        var pairs: [String: Int] = [:]
        for index in 0..<(x.count - 1) { pairs[String(x[index...index + 1]), default: 0] += 1 }
        var shared = 0
        for index in 0..<(y.count - 1) {
            let pair = String(y[index...index + 1])
            if let count = pairs[pair], count > 0 {
                pairs[pair] = count - 1
                shared += 1
            }
        }
        return 2 * Double(shared) / Double(x.count + y.count - 2)
    }
}

/// The right answer for a capture: Maintainer writes it, you confirm it in the app.
public struct WebCaptureExpected: Codable, Equatable, Sendable {
    public var title: String?
    public var turns: [WebTurn]
    /// You pressed Confirm on its card.
    public var confirmed: Bool
    public var confirmedAt: Date?
    public var note: String?

    public init(title: String?, turns: [WebTurn], confirmed: Bool = false, confirmedAt: Date? = nil, note: String? = nil) {
        self.title = title
        self.turns = turns
        self.confirmed = confirmed
        self.confirmedAt = confirmedAt
        self.note = note
    }

    /// Whether a reading is this answer: the same messages, in order, with the same words (spacing
    /// at the ends of lines and runs of blank lines aside), and the title when one is given.
    /// Nil when it is; else the first difference, in words.
    public func difference(from reading: WebReading) -> String? {
        guard case .read(let title, let turns) = reading else {
            if case .nothing(let reason) = reading { return "Nothing was read: \(reason)" }
            return "Nothing was read."
        }
        if let expected = self.title, !expected.isEmpty, Self.tidy(expected) != Self.tidy(title ?? "") {
            return "The title is \"\(title ?? "none")\", expected \"\(expected)\"."
        }
        for index in 0..<max(self.turns.count, turns.count) {
            guard index < turns.count else { return "Message \(index + 1) (\(self.turns[index].role.rawValue)) is missing: \(turns.count) read, \(self.turns.count) expected." }
            guard index < self.turns.count else { return "Message \(index + 1) is extra: \(turns.count) read, \(self.turns.count) expected." }
            let want = self.turns[index], got = turns[index]
            if want.role != got.role { return "Message \(index + 1) is \(got.role.rawValue)'s, expected \(want.role.rawValue)'s." }
            let a = Self.tidy(want.text), b = Self.tidy(got.text)
            if a != b {
                let at = zip(a, b).prefix { $0 == $1 }.count
                let context = { (text: String) in String(text.dropFirst(max(0, at - 20)).prefix(60)).replacingOccurrences(of: "\n", with: "⏎") }
                return "Message \(index + 1) (\(want.role.rawValue)) differs at character \(at + 1): expected \"\(context(a))\", read \"\(context(b))\"."
            }
        }
        return nil
    }

    static func tidy(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
            .joined(separator: "\n")
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A capture's `manifest.json`.
public struct WebCaptureManifest: Codable, Equatable, Sendable {
    public struct Extractor: Codable, Equatable, Sendable {
        public var file: String
        public var sha256: String
        /// "plugin" (the library's copy) or "app" (the app's own).
        public var source: String
        /// It has `extractNetwork` (reads the traffic too).
        public var readsNetwork: Bool
    }

    public struct Counts: Codable, Equatable, Sendable {
        public var requests: Int
        public var streams: Int
        public var bytes: Int
        public var events: Int
    }

    public var format = 1
    public var site: String
    public var url: String
    public var pageTitle: String?
    /// The recording's start and end, and how much before it the memory held.
    public var startedAt: Date
    public var endedAt: Date
    public var preRollSeconds: Double
    /// "you" (Stop), "time" (3 minutes) or "size" (100 MB).
    public var stoppedBy: String
    public var appVersion: String
    public var extractor: Extractor?
    public var counts: Counts
    /// What was masked before writing, by kind.
    public var redacted: [String: Int]
    public var files: [String]
    /// Always true: never shared, never committed.
    public var `private` = true
    public var notes: [String]
}

/// One capture folder, as listed.
public struct WebCapturePack: Identifiable, Equatable, Sendable {
    public static let maxSeconds: Double = 3 * 60
    public static let maxBytes = 100 * 1_000_000
    /// Kept per site: the newest few, none older than this.
    public static let keepPerSite = 5
    public static let keepDays: Double = 30

    public let folder: URL
    public let manifest: WebCaptureManifest?
    public let expected: WebCaptureExpected?

    public var id: String { folder.path }
    public var name: String { folder.lastPathComponent }

    /// `captures` next to `web` in the app's data folder.
    public static func root(besides web: URL) -> URL {
        web.deletingLastPathComponent().appending(path: "captures")
    }

    public static func siteFolder(_ site: WebSite, in root: URL) -> URL { root.appending(path: site.id) }

    /// A new capture's folder name, by its time (`20261022-153000`).
    public static func folderName(at date: Date, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }

    public init(folder: URL) {
        self.folder = folder
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        manifest = (try? Data(contentsOf: folder.appending(path: "manifest.json"))).flatMap { try? decoder.decode(WebCaptureManifest.self, from: $0) }
        expected = (try? Data(contentsOf: folder.appending(path: "expected.json"))).flatMap { try? decoder.decode(WebCaptureExpected.self, from: $0) }
    }

    /// A site's captures, newest first.
    public static func list(_ site: WebSite, in root: URL) -> [WebCapturePack] {
        let folder = siteFolder(site, in: root)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.filter { !$0.hasPrefix(".") }.sorted(by: >)
            .map { folder.appending(path: $0) }
            .filter { FileManager.default.fileExists(atPath: $0.appending(path: "manifest.json").path) }
            .map(WebCapturePack.init(folder:))
    }

    /// The captures a path stands for: one capture, a site's, or every site's.
    public static func packs(at path: URL) -> [WebCapturePack] {
        if FileManager.default.fileExists(atPath: path.appending(path: "manifest.json").path) { return [WebCapturePack(folder: path)] }
        if let site = WebSite.all.first(where: { $0.id == path.lastPathComponent }) {
            return list(site, in: path.deletingLastPathComponent())
        }
        return WebSite.all.flatMap { list($0, in: path) }
    }

    /// Keeps the newest `keepPerSite` of each site and none older than `keepDays`. Returns what
    /// it deleted.
    @discardableResult
    public static func prune(in root: URL, now: Date = Date()) -> [URL] {
        var deleted: [URL] = []
        for site in WebSite.all {
            for (index, pack) in list(site, in: root).enumerated() {
                let made = pack.manifest?.endedAt ?? (try? pack.folder.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? now
                if index >= keepPerSite || now.timeIntervalSince(made) > keepDays * 24 * 3600 {
                    try? FileManager.default.removeItem(at: pack.folder)
                    deleted.append(pack.folder)
                }
            }
        }
        return deleted
    }

    /// You confirmed its right answer.
    public func confirmExpected(at now: Date = Date()) throws {
        guard var expected else { return }
        expected.confirmed = true
        expected.confirmedAt = now
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(expected).write(to: folder.appending(path: "expected.json"), options: .atomic)
    }

    /// The events it saved.
    public func events() -> [WebNetEvent] {
        (try? String(contentsOf: folder.appending(path: "events.jsonl"), encoding: .utf8)).map(WebNetEvent.parse(jsonl:)) ?? []
    }

    public func html() -> String? {
        try? String(contentsOf: folder.appending(path: "dom.html"), encoding: .utf8)
    }

    /// What the page reader read when it was captured (`extractor/output.json`).
    public func output() -> (page: WebReading, network: WebReading?)? {
        guard let data = try? Data(contentsOf: folder.appending(path: "extractor/output.json")) else { return nil }
        return WebExtractors.decodeBoth(String(decoding: data, as: UTF8.self))
    }
}

/// Everything a capture is written from (the page's parts come from the web view).
public struct WebCaptureInput: Sendable {
    public var site: WebSite
    public var url: URL
    public var pageTitle: String?
    public var startedAt: Date
    public var endedAt: Date
    public var stoppedBy: String
    public var events: [WebNetEvent]
    public var html: String?
    /// `outline.js`'s JSON.
    public var outline: String?
    public var screenshot: Data?
    public var extractor: (source: String, url: URL, fromPlugin: Bool)?
    /// The reader's raw output (`{page, network}` JSON).
    public var output: String?
    public var appVersion: String

    public init(site: WebSite, url: URL, pageTitle: String?, startedAt: Date, endedAt: Date, stoppedBy: String, events: [WebNetEvent],
                html: String?, outline: String?, screenshot: Data?, extractor: (source: String, url: URL, fromPlugin: Bool)?, output: String?, appVersion: String) {
        self.site = site
        self.url = url
        self.pageTitle = pageTitle
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.stoppedBy = stoppedBy
        self.events = events
        self.html = html
        self.outline = outline
        self.screenshot = screenshot
        self.extractor = extractor
        self.output = output
        self.appVersion = appVersion
    }
}

extension WebCapturePack {
    /// Writes a capture under `root` (masking secrets first), then prunes old ones.
    public static func write(_ input: WebCaptureInput, in root: URL) throws -> WebCapturePack {
        let files = FileManager.default
        let siteFolder = siteFolder(input.site, in: root)
        var name = folderName(at: input.endedAt)
        var suffix = 2
        while files.fileExists(atPath: siteFolder.appending(path: name).path) {
            name = folderName(at: input.endedAt) + "-\(suffix)"
            suffix += 1
        }
        let folder = siteFolder.appending(path: name)
        try files.createDirectory(at: folder.appending(path: "extractor"), withIntermediateDirectories: true)
        var redactor = WebRedactor()
        let events = redactor.redact(input.events)
        let url = redactor.forgetLearned(in: redactor.redact(url: input.url.absoluteString))
        var written: [String] = ["manifest.json"]
        func put(_ data: Data, _ path: String) throws {
            try data.write(to: folder.appending(path: path), options: .atomic)
            written.append(path)
        }
        try put(Data(events.map { $0.jsonLine() + "\n" }.joined().utf8), "events.jsonl")
        let exchanges = WebNetExchange.assemble(events)
        try put(WebHAR.make(exchanges, pageURL: url, pageTitle: input.pageTitle, startedAt: input.startedAt.timeIntervalSince1970 * 1000, appVersion: input.appVersion), "network.har")
        if let html = input.html { try put(Data(redactor.forgetLearned(in: redactor.redact(html: html)).utf8), "dom.html") }
        if let outline = input.outline { try put(Data(redactor.forgetLearned(in: redactor.redact(text: outline)).utf8), "outline.json") }
        if let screenshot = input.screenshot { try put(screenshot, "screenshot.png") }
        var extractor: WebCaptureManifest.Extractor?
        if let script = input.extractor {
            let file = input.site.extractorFile
            try put(Data(script.source.utf8), "extractor/\(file)")
            extractor = .init(file: file, sha256: WebExtractors.hash(script.source), source: script.fromPlugin ? "plugin" : "app",
                              readsNetwork: WebExtractors.readsNetwork(script.source))
        }
        if let output = input.output { try put(Data(redactor.forgetLearned(in: redactor.redact(text: output)).utf8), "extractor/output.json") }
        let counts = WebNetCounts.of(events.filter { $0.t >= input.startedAt.timeIntervalSince1970 * 1000 })
        let held = events.first.map { max(0, input.startedAt.timeIntervalSince1970 - $0.t / 1000) } ?? 0
        var notes = ["The screenshot is not masked: it shows the page as it looked, your account's name or picture included."]
        if events.isEmpty { notes.append("No traffic was seen. The page's own workers (and anything outside fetch, XHR, EventSource and WebSocket) are not captured.") }
        let manifest = WebCaptureManifest(
            site: input.site.id, url: url, pageTitle: input.pageTitle.map { redactor.forgetLearned(in: redactor.redact(text: $0)) },
            startedAt: input.startedAt, endedAt: input.endedAt, preRollSeconds: held.rounded(),
            stoppedBy: input.stoppedBy, appVersion: input.appVersion, extractor: extractor,
            counts: .init(requests: counts.requests, streams: counts.streams, bytes: counts.bytes, events: events.count),
            redacted: redactor.counts, files: written.sorted(), notes: notes
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(manifest).write(to: folder.appending(path: "manifest.json"), options: .atomic)
        prune(in: root, now: input.endedAt)
        return WebCapturePack(folder: folder)
    }
}

extension WebExtractors {
    /// A page reader's fingerprint (its source's SHA-256), to tell a changed one.
    public static func fingerprint(_ source: String) -> String { hash(source) }

    /// What `extractNetwork` gets as its `context`: the site, the page's address and its
    /// conversation's id (null on a new question's page), as JSON.
    public static func context(site: WebSite, url: URL) -> String {
        let object: [String: Any] = ["site": site.id, "url": url.absoluteString, "conversationID": site.conversationID(in: url) ?? NSNull()]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    /// Whether a page reader also reads the traffic (declares `function extractNetwork`).
    public static func readsNetwork(_ source: String) -> Bool {
        source.range(of: "function\\s+extractNetwork\\s*\\(", options: .regularExpression) != nil
            || source.range(of: "extractNetwork\\s*=", options: .regularExpression) != nil
    }

    /// The body of an async function run in the page that tells what the reader declares:
    /// `{network: bool, urls: [patterns]}` (its `NETWORK.urls`).
    public static func declaration(_ source: String) -> String {
        """
        try {
        \(source)
        ;const urls = (typeof NETWORK !== "undefined" && NETWORK && Array.isArray(NETWORK.urls)) ? NETWORK.urls.map(String) : [];
        return JSON.stringify({ network: typeof extractNetwork === "function", urls });
        } catch (e) { return JSON.stringify({ network: false, urls: [], error: String(e && e.message || e) }); }
        """
    }

    /// `declaration`'s answer: whether it reads the traffic, and which requests.
    public static func decodeDeclaration(_ json: String?) -> (network: Bool, urls: [String]) {
        guard let data = json?.data(using: .utf8), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return (false, []) }
        return (object["network"] as? Bool ?? false, object["urls"] as? [String] ?? [])
    }

    /// The body of an async function run in the page with `net` (the exchanges' JSON, or null)
    /// and `context` (`{url, conversationID, site}` JSON): the reader's `extract(document)`, and
    /// its `extractNetwork(exchanges, context)` when it has one and there is traffic, as
    /// `{page, network}` JSON. Each one's thrown error comes back as its `{error}`.
    public static func callBoth(_ source: String) -> String {
        """
        const fail = (e) => ({ error: "The page reader failed: " + String(e && e.message || e) });
        try {
        \(source)
        ;const out = { page: null, network: null };
        try { out.page = extract(document); } catch (e) { out.page = fail(e); }
        if (typeof extractNetwork === "function" && net) {
          try { out.network = extractNetwork(JSON.parse(net), JSON.parse(context)); } catch (e) { out.network = fail(e); }
        }
        return JSON.stringify(out);
        } catch (e) { return JSON.stringify({ page: fail(e), network: null }); }
        """
    }

    /// `callBoth`'s answer. The traffic's reading is nil when the reader has none, gave null, or
    /// found no messages there (the traffic held nothing about this conversation).
    public static func decodeBoth(_ json: String?) -> (page: WebReading, network: WebReading?) {
        guard let json, let data = json.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return (.nothing("The page reader gave back nothing it understood."), nil)
        }
        let encode = { (value: Any?) -> String? in
            guard let value, !(value is NSNull), JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return String(decoding: data, as: UTF8.self)
        }
        let page = WebReading.decode(encode(object["page"]))
        var network: WebReading?
        if let text = encode(object["network"]) {
            let reading = WebReading.decode(text)
            switch reading {
            case .read: network = reading
            case .nothing:
                // An error is a failure; no messages is no news.
                if let error = (object["network"] as? [String: Any])?["error"] as? String, !error.isEmpty { network = reading }
            }
        }
        return (page, network)
    }
}

extension Workspace {
    /// "Send to Maintainer" on a capture: Maintainer may read the captures folder (allowed
    /// without asking: you pressed the button), and gets the job with the screenshot attached.
    public func sendCaptureToMaintainer(_ pack: WebCapturePack, site: WebSite, summary: String, testCommand: String?) {
        prepareLibrary()
        let text = Self.webCaptureHandoff(pack, site: site, plugin: WebExtractors.folder(in: Layout.plugins(in: root)), summary: summary, testCommand: testCommand)
        let screenshot = pack.folder.appending(path: "screenshot.png")
        let files = FileManager.default.fileExists(atPath: screenshot.path) ? [screenshot] : []
        let maintainer = maintainer
        allowMaintainerToRead(web.capturesFolder) {
            maintainer.relay(text, files: files)
        }
    }

    /// What "Send to Maintainer" hands over: the capture, what went wrong, and the steps.
    public static func webCaptureHandoff(_ pack: WebCapturePack, site: WebSite, plugin: URL, summary: String, testCommand: String?) -> String {
        let folder = pack.folder.path
        let all = pack.folder.deletingLastPathComponent().path
        let test = testCommand.map { "\($0) <capture folder>" } ?? "(no test command this time: compare the reader's output with expected.json by hand)"
        return """
        (App: Web capture) The user captured \(site.name)'s page and its traffic so you can fix its page reader. \(summary)
        The capture: \(folder)/ — screenshot.png (what the page showed: the right answer), events.jsonl and network.har (each request and each piece of its answer, in time order), dom.html and outline.json (the page's elements, for selectors), extractor/ (the reader then, and what it read), manifest.json (what was masked). It is private: read it, never copy it into the plugin library, never commit or share it.
        Steps:
        1. Look at screenshot.png to know what the conversation really says.
        2. Find its structure in events.jsonl (the site's answers, often streamed) and in outline.json / dom.html.
        3. Fix \(plugin.appending(path: site.extractorFile).path): `extract(doc)` reads the page; add or fix `extractNetwork(exchanges, context)` to read the same conversation from the traffic, with `NETWORK = { urls: [...] }` naming the requests it reads (README.md in that folder has the contract). Read only what the page already fetched: never send a request.
        4. Write \(folder)/expected.json: {"title": "…" or null, "turns": [{"role": "user"|"assistant", "text": "…"}], "confirmed": false}, the messages as the screenshot shows them, in the reader's Markdown. This file is the only thing you write outside the plugin library. The user confirms it on a card in the app; do not set confirmed yourself.
        5. Run \(test) on this capture, and on \(all) for every older one of \(site.name); all must pass (the page and the traffic must agree too) before you commit.
        6. Bump the plugin's version, check and commit it as usual, then tell the user in one sentence that the reader is fixed and that a card asks them to confirm the expected answer.
        """
    }
}
