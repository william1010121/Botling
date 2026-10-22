import CryptoKit
import Foundation

/// A web AI shown as a bot in the left column ("Web"): its real site in a web view, each of its
/// conversations a row under it, and each conversation's text saved for the main bot to read.
/// A site is data only; what reads its page is a script in the plugin library (`WebExtractors`).
public struct WebSite: Identifiable, Equatable, Sendable {
    /// Its folder under `web/` and its extractor's file name (`<id>.js`).
    public let id: String
    public let name: String
    /// Where "New question" goes.
    public let startURL: URL
    /// The site's own host: only its pages are conversations.
    public let host: String
    /// The path part right before a conversation's id (`/app/<id>`).
    public let conversationMarker: String
    /// Sign-in and pop-up pages under this domain open inside the view; others in the browser.
    public let domain: String
    /// Its face's colour.
    public let accent: UInt32
    /// Stands for it where a bot's id would go (the column's selection).
    public let selectionID: UUID
    /// Its own cookies and sign-in, kept over restarts (`WKWebsiteDataStore(forIdentifier:)`).
    public let dataStoreID: UUID

    public init(id: String, name: String, startURL: URL, host: String, conversationMarker: String, domain: String,
                accent: UInt32, selectionID: UUID, dataStoreID: UUID) {
        self.id = id
        self.name = name
        self.startURL = startURL
        self.host = host
        self.conversationMarker = conversationMarker
        self.domain = domain
        self.accent = accent
        self.selectionID = selectionID
        self.dataStoreID = dataStoreID
    }

    /// The extractor script's file name in the plugin.
    public var extractorFile: String { "\(id).js" }

    public static let gemini = WebSite(
        id: "gemini",
        name: "Gemini",
        startURL: URL(string: "https://gemini.google.com/app")!,
        host: "gemini.google.com",
        conversationMarker: "app",
        domain: "google.com",
        accent: 0x4C7DF0,
        selectionID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000E1")!,
        dataStoreID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000D1")!
    )

    /// Every site the column lists. More (ChatGPT, Claude, Grok) are added here as data.
    public static let all: [WebSite] = [.gemini]

    /// The site a column selection stands for.
    public static func site(selection: UUID?) -> WebSite? {
        all.first { $0.selectionID == selection }
    }

    /// The conversation id in one of its page's URLs (`gemini.google.com/app/<id>`, also with an
    /// account prefix like `/u/1/app/<id>`); nil for a new question's page or another site.
    public func conversationID(in url: URL) -> String? {
        guard url.host()?.lowercased() == host else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard let at = parts.firstIndex(of: conversationMarker), at + 1 < parts.count else { return nil }
        let id = parts[at + 1]
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard id.count >= 4, id.unicodeScalars.allSatisfy({ allowed.contains($0) && $0.isASCII }) else { return nil }
        return id
    }

    /// Whether a page opened from the site (sign-in, a pop-up) stays inside the view.
    public func keepsInside(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        return host == domain || host.hasSuffix("." + domain)
    }
}

/// One conversation with a web AI, as listed under it in the left column.
public struct WebConversation: Codable, Identifiable, Equatable, Sendable {
    /// From its URL (`WebSite.conversationID`).
    public var id: String
    public var url: URL
    public var title: String
    /// Messages in the last saved text (yours and its).
    public var messages: Int
    /// When its text was last saved; nil until it was read once.
    public var savedAt: Date?
    /// Its saved text's file name in the site's folder, kept once chosen.
    public var file: String?
    /// Last opened or changed: the list's order, newest first.
    public var updatedAt: Date

    public init(id: String, url: URL, title: String, messages: Int = 0, savedAt: Date? = nil, file: String? = nil, updatedAt: Date) {
        self.id = id
        self.url = url
        self.title = title
        self.messages = messages
        self.savedAt = savedAt
        self.file = file
        self.updatedAt = updatedAt
    }
}

/// A site's conversation list, in `web/<site>/conversations.json`.
public struct WebConversationStore: Sendable {
    public let folder: URL
    public private(set) var conversations: [WebConversation] = []

    public init(folder: URL) {
        self.folder = folder
        conversations = Self.load(from: listURL)
    }

    public var listURL: URL { folder.appending(path: "conversations.json") }

    static func load(from url: URL) -> [WebConversation] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return ((try? decoder.decode([WebConversation].self, from: data)) ?? []).sorted { $0.updatedAt > $1.updatedAt }
    }

    public func save() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(conversations) { try? data.write(to: listURL, options: .atomic) }
    }

    public func conversation(_ id: String) -> WebConversation? {
        conversations.first { $0.id == id }
    }

    /// Adds the conversation or brings it up to date (its URL, a better title), newest first.
    @discardableResult
    public mutating func upsert(id: String, url: URL, title: String?, at now: Date) -> WebConversation {
        var item = conversation(id) ?? WebConversation(id: id, url: url, title: title ?? "", updatedAt: now)
        item.url = url
        if let title, !title.isEmpty { item.title = title }
        item.updatedAt = now
        conversations.removeAll { $0.id == id }
        conversations.insert(item, at: 0)
        return item
    }

    /// Its text was saved to `file` with `messages` messages.
    public mutating func recordSave(id: String, messages: Int, file: String, at now: Date) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].messages = messages
        conversations[index].file = file
        conversations[index].savedAt = now
    }

    /// The file name for a conversation's text: its own once chosen, else its title's slug (its
    /// id when the title has no Latin letters or digits), with the id added when another
    /// conversation has that name already.
    public func fileName(for id: String, title: String) -> String {
        if let file = conversation(id)?.file { return file }
        let slug = WebTranscript.slug(title)
        let base = slug.isEmpty ? id : slug
        let taken = Set(conversations.filter { $0.id != id }.compactMap(\.file))
        let name = base + ".md"
        return taken.contains(name) ? "\(base)-\(id.prefix(8)).md" : name
    }
}

/// One message read from a web AI's page.
public struct WebTurn: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable {
        case user, assistant
    }

    public var role: Role
    public var text: String

    public init(role: Role, text: String) {
        self.role = role
        self.text = text
    }
}

/// What an extractor script found on the page: its `{title, turns}`, or why nothing.
public enum WebReading: Equatable, Sendable {
    case read(title: String?, turns: [WebTurn])
    case nothing(String)

    /// The script's JSON result (see the plugin's README for the contract). Turns with no text
    /// are dropped; no turns at all is `nothing`, never an empty transcript.
    public static func decode(_ json: String?) -> WebReading {
        guard let json, let data = json.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .nothing("The page reader gave back nothing it understood.")
        }
        if let error = object["error"] as? String, !error.isEmpty { return .nothing(error) }
        let turns = (object["turns"] as? [[String: Any]] ?? []).compactMap { turn -> WebTurn? in
            guard let role = (turn["role"] as? String).flatMap(WebTurn.Role.init(rawValue:)),
                  let text = (turn["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            return WebTurn(role: role, text: text)
        }
        guard !turns.isEmpty else { return .nothing("No messages were found on the page.") }
        let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return .read(title: title?.isEmpty == true ? nil : title, turns: turns)
    }
}

/// A conversation's saved text: Markdown with a short header, one section per message.
public enum WebTranscript {
    /// Characters a page title hides around its words.
    static let invisible = CharacterSet(charactersIn: "\u{200B}\u{200E}\u{200F}\u{FEFF}").union(.whitespacesAndNewlines)

    /// A name for the conversation: the page reader's title, else the tab's title without the
    /// site's name, else the first thing you asked (cut short).
    public static func title(extracted: String?, pageTitle: String?, turns: [WebTurn], site: WebSite) -> String {
        for candidate in [extracted, pageTitle] {
            if let cleaned = clean(candidate, site: site) { return cleaned }
        }
        if let first = turns.first(where: { $0.role == .user }) {
            let line = first.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? first.text
            return line.count > 60 ? String(line.prefix(59)).trimmingCharacters(in: .whitespaces) + "…" : line
        }
        return site.name
    }

    /// `title` without the site's name around it; nil when nothing else is left.
    static func clean(_ title: String?, site: WebSite) -> String? {
        guard var text = title?.trimmingCharacters(in: invisible), !text.isEmpty else { return nil }
        for separator in [" - ", " | ", " – ", " — "] {
            if text.lowercased().hasSuffix((separator + site.name).lowercased()) {
                text = String(text.dropLast(separator.count + site.name.count))
            }
            if text.lowercased().hasPrefix((site.name + separator).lowercased()) {
                text = String(text.dropFirst(separator.count + site.name.count))
            }
        }
        text = text.trimmingCharacters(in: invisible)
        return text.isEmpty || text.caseInsensitiveCompare(site.name) == .orderedSame ? nil : text
    }

    /// A file name from a title: lower-case Latin letters and digits joined by dashes.
    public static func slug(_ title: String) -> String {
        let folded = title.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        var slug = ""
        for scalar in folded.unicodeScalars {
            if scalar.isASCII, CharacterSet.alphanumerics.contains(scalar) {
                slug.unicodeScalars.append(scalar)
            } else if !slug.isEmpty, !slug.hasSuffix("-") {
                slug += "-"
            }
        }
        while slug.hasSuffix("-") { slug.removeLast() }
        if slug.count > 60 {
            slug = String(slug.prefix(60))
            while slug.hasSuffix("-") { slug.removeLast() }
        }
        return slug
    }

    /// The saved file's text.
    public static func markdown(title: String, url: URL, site: WebSite, turns: [WebTurn], savedAt: Date, timeZone: TimeZone = .current) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = timeZone
        formatter.formatOptions = [.withInternetDateTime]
        var lines = [
            "# \(title)",
            "",
            "- Site: \(site.name)",
            "- URL: \(url.absoluteString)",
            "- Saved: \(formatter.string(from: savedAt))",
            "- Messages: \(turns.count)",
        ]
        for turn in turns {
            lines += ["", "## " + (turn.role == .user ? "You" : site.name), "", turn.text]
        }
        return lines.joined(separator: "\n") + "\n"
    }
}

/// The page readers: one script per site in the plugin library's `ccb-web-extractors` (Maintainer's
/// to fix when a site changes its page), with the copy shipped in the app as the fallback.
public enum WebExtractors {
    public static let plugin = "ccb-web-extractors"
    /// What was last written from the app's copy, by file name: a file still the same is the
    /// app's to update; one changed since is kept.
    static let shippedRecord = ".shipped.json"

    public static func folder(in library: URL) -> URL { library.appending(path: plugin) }

    /// Puts the app's README and scripts in the plugin (and its package.json), once, and again
    /// when the app ships a new copy of a file nobody edited.
    public static func install(in library: URL, bundled: URL?) {
        let files = FileManager.default
        let folder = folder(in: library)
        try? files.createDirectory(at: folder, withIntermediateDirectories: true)
        let manifest = folder.appending(path: "package.json")
        if !files.fileExists(atPath: manifest.path) {
            let text = PluginManifest.builtIn(
                name: plugin, displayName: "Web page readers",
                description: "Reads the conversation on a web AI's page (Gemini) into text for the main bot. One script per site; README.md has the contract.",
                permissions: []
            ).fileText
            try? Data(text.utf8).write(to: manifest)
        }
        guard let bundled else { return }
        let recordURL = folder.appending(path: shippedRecord)
        var record = (try? Data(contentsOf: recordURL)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
        let before = record
        let shipped = ((try? files.contentsOfDirectory(at: bundled, includingPropertiesForKeys: nil)) ?? [])
            .filter { ["js", "md"].contains($0.pathExtension) }
        for source in shipped {
            guard let text = try? String(contentsOf: source, encoding: .utf8) else { continue }
            let name = source.lastPathComponent
            let target = folder.appending(path: name)
            let current = try? String(contentsOf: target, encoding: .utf8)
            if current == text {
                record[name] = hash(text)
            } else if current == nil || current.map(hash) == record[name] {
                try? Data(text.utf8).write(to: target)
                record[name] = hash(text)
            }
        }
        if record != before, let data = try? JSONEncoder().encode(record) { try? data.write(to: recordURL) }
    }

    /// The script that reads `site`'s page: the plugin's, else the app's own copy.
    public static func script(for site: WebSite, library: URL, bundled: URL?) -> (source: String, url: URL)? {
        let candidates = [folder(in: library).appending(path: site.extractorFile)] + (bundled.map { [$0.appending(path: site.extractorFile)] } ?? [])
        for url in candidates {
            if let text = try? String(contentsOf: url, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (text, url)
            }
        }
        return nil
    }

    /// The body of an async function run in the page: the script, then its `extract(document)`
    /// as JSON (a script error comes back as `{error}`).
    public static func call(_ source: String) -> String {
        """
        try {
        \(source)
        ;return JSON.stringify(extract(document));
        } catch (e) { return JSON.stringify({ error: "The page reader failed: " + String(e && e.message || e) }); }
        """
    }

    static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// What the web view shows about the page now.
public enum WebPageStatus: Equatable, Sendable {
    /// Not read yet (loading, or an answer still coming).
    case reading
    /// A new question's page: nothing to save until it has an id.
    case newQuestion
    case saved(messages: Int, at: Date)
    /// The page reader found nothing: shown, and no file written.
    case unreadable(String)
}

/// Every web site's conversations, their saved text, and what the open page's status is.
@MainActor
public final class WebShelf: ObservableObject {
    /// `~/.claudecodebot/web`.
    public let folder: URL
    /// The plugin library (where the page readers are).
    public let library: URL
    /// The app's own copy of the page readers.
    public var bundledExtractors: URL?
    @Published public private(set) var stores: [String: WebConversationStore] = [:]
    /// The conversation each site shows (nil: a new question), by site id.
    @Published public private(set) var open: [String: String] = [:]
    /// The page each site shows asked to load (a row clicked, "New question"), by site id.
    @Published public private(set) var requested: [String: URL] = [:]
    @Published public private(set) var status: [String: WebPageStatus] = [:]
    /// The text last written per conversation (`site/id`), so an unchanged page writes nothing.
    private var written: [String: [WebTurn]] = [:]

    public init(folder: URL, library: URL) {
        self.folder = folder
        self.library = library
        for site in WebSite.all {
            stores[site.id] = WebConversationStore(folder: siteFolder(site))
        }
    }

    public func siteFolder(_ site: WebSite) -> URL { folder.appending(path: site.id) }

    public func conversations(of site: WebSite) -> [WebConversation] {
        stores[site.id]?.conversations ?? []
    }

    public func openConversation(of site: WebSite) -> WebConversation? {
        open[site.id].flatMap { stores[site.id]?.conversation($0) }
    }

    /// The saved text's file, once there is one.
    public func fileURL(of conversation: WebConversation, site: WebSite) -> URL? {
        conversation.file.map { siteFolder(site).appending(path: $0) }
    }

    /// The page reader's source for `site`.
    public func extractor(for site: WebSite) -> String? {
        WebExtractors.script(for: site, library: library, bundled: bundledExtractors)?.source
    }

    /// A row clicked: its page loads.
    public func show(_ conversation: WebConversation, of site: WebSite) {
        open[site.id] = conversation.id
        requested[site.id] = conversation.url
        status[site.id] = .reading
    }

    /// "New question": the site's start page, fresh.
    public func startNew(on site: WebSite) {
        open[site.id] = nil
        requested[site.id] = site.startURL
        status[site.id] = .newQuestion
    }

    /// The view loaded what was asked for.
    public func handled(_ site: WebSite) {
        requested[site.id] = nil
    }

    /// The page moved to `url` (a new question got its id, a link inside the site).
    public func pageChanged(on site: WebSite, url: URL, pageTitle: String?, now: Date = Date()) {
        guard let id = site.conversationID(in: url) else {
            open[site.id] = nil
            status[site.id] = .newQuestion
            return
        }
        if open[site.id] != id { status[site.id] = .reading }
        open[site.id] = id
        let title = WebTranscript.clean(pageTitle, site: site)
        if stores[site.id]?.conversation(id) == nil || title != nil {
            stores[site.id]?.upsert(id: id, url: url, title: title ?? stores[site.id]?.conversation(id)?.title ?? site.name, at: now)
            stores[site.id]?.save()
        }
    }

    /// What the page reader found once the page settled: the text saved (its file returned),
    /// or "couldn't read this page" with no file written.
    @discardableResult
    public func record(on site: WebSite, url: URL, pageTitle: String?, reading: WebReading, now: Date = Date()) -> URL? {
        guard let id = site.conversationID(in: url) else {
            status[site.id] = .newQuestion
            return nil
        }
        open[site.id] = id
        guard case .read(let extracted, let turns) = reading else {
            if case .nothing(let reason) = reading { status[site.id] = .unreadable(reason) }
            if stores[site.id]?.conversation(id) == nil {
                stores[site.id]?.upsert(id: id, url: url, title: WebTranscript.clean(pageTitle, site: site) ?? site.name, at: now)
                stores[site.id]?.save()
            }
            return nil
        }
        guard var store = stores[site.id] else { return nil }
        let title = WebTranscript.title(extracted: extracted, pageTitle: pageTitle, turns: turns, site: site)
        let key = "\(site.id)/\(id)"
        let known = store.conversation(id)
        if written[key] == turns, let known, let file = known.file, let savedAt = known.savedAt,
           FileManager.default.fileExists(atPath: siteFolder(site).appending(path: file).path) {
            status[site.id] = .saved(messages: known.messages, at: savedAt)
            return siteFolder(site).appending(path: file)
        }
        let file = store.fileName(for: id, title: title)
        let target = siteFolder(site).appending(path: file)
        try? FileManager.default.createDirectory(at: siteFolder(site), withIntermediateDirectories: true)
        let text = WebTranscript.markdown(title: title, url: url, site: site, turns: turns, savedAt: now)
        guard (try? Data(text.utf8).write(to: target, options: .atomic)) != nil else {
            status[site.id] = .unreadable("The text could not be saved to \(target.path).")
            return nil
        }
        store.upsert(id: id, url: url, title: title, at: now)
        store.recordSave(id: id, messages: turns.count, file: file, at: now)
        store.save()
        stores[site.id] = store
        written[key] = turns
        status[site.id] = .saved(messages: turns.count, at: now)
        return target
    }
}
