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
    /// Sign-in and pop-up pages on these hosts (or under them) open inside the view: the site's
    /// own and the sign-in providers it offers. Others open in the browser.
    public let insideDomains: [String]
    /// Its face's colour.
    public let accent: UInt32
    /// Its face's SF Symbol (no company logo).
    public let symbol: String
    /// Stands for it where a bot's id would go (the column's selection).
    public let selectionID: UUID
    /// Its own cookies and sign-in, kept over restarts (`WKWebsiteDataStore(forIdentifier:)`).
    public let dataStoreID: UUID

    public init(id: String, name: String, startURL: URL, host: String, conversationMarker: String, insideDomains: [String],
                accent: UInt32, symbol: String, selectionID: UUID, dataStoreID: UUID) {
        self.id = id
        self.name = name
        self.startURL = startURL
        self.host = host
        self.conversationMarker = conversationMarker
        self.insideDomains = insideDomains
        self.accent = accent
        self.symbol = symbol
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
        insideDomains: ["google.com"],
        accent: 0x4C7DF0,
        symbol: "sparkle",
        selectionID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000E1")!,
        dataStoreID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000D1")!
    )

    /// `chatgpt.com/c/<id>` (also inside a GPT or project, `/g/<gpt>/c/<id>`); signs in at
    /// auth.openai.com, or with Google, Apple or Microsoft.
    public static let chatgpt = WebSite(
        id: "chatgpt",
        name: "ChatGPT",
        startURL: URL(string: "https://chatgpt.com/")!,
        host: "chatgpt.com",
        conversationMarker: "c",
        insideDomains: ["chatgpt.com", "openai.com", "accounts.google.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com"],
        accent: 0x10A37F,
        symbol: "hexagon",
        selectionID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000E2")!,
        dataStoreID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000D2")!
    )

    /// `claude.ai/chat/<id>`; a new question at `/new`. Signs in on claude.ai (an emailed
    /// code), or with Google or Apple.
    public static let claude = WebSite(
        id: "claude",
        name: "Claude",
        startURL: URL(string: "https://claude.ai/new")!,
        host: "claude.ai",
        conversationMarker: "chat",
        insideDomains: ["claude.ai", "accounts.google.com", "appleid.apple.com"],
        accent: 0xD97757,
        symbol: "asterisk",
        selectionID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000E3")!,
        dataStoreID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000D3")!
    )

    /// Grok's website, with its own persistent sign-in profile (separate from the API).
    public static let grok = WebSite(
        id: "grok",
        name: "Grok",
        startURL: URL(string: "https://grok.com/")!,
        host: "grok.com",
        conversationMarker: "c",
        insideDomains: ["grok.com", "accounts.x.ai", "auth.x.ai", "accounts.google.com", "appleid.apple.com", "x.com", "twitter.com", "github.com"],
        accent: 0x555D68,
        symbol: "bolt",
        selectionID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000E4")!,
        dataStoreID: UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000D4")!
    )

    /// Every site the column lists, in its order. More are added here as data, each with its
    /// page reader (`<id>.js`) in the plugin.
    public static let all: [WebSite] = [.gemini, .chatgpt, .claude, .grok]

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

    /// A conversation's own page, from its id (`https://<host>/<marker>/<id>`).
    public func conversationURL(_ id: String) -> URL {
        URL(string: "https://\(host)")!.appending(path: conversationMarker).appending(path: id)
    }

    /// Whether a page opened from the site (sign-in, a pop-up) stays inside the view.
    public func keepsInside(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        return insideDomains.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

/// One conversation with a web AI, as listed under it in the left column (until you settle it,
/// as a bot's subagents are) and always in the right panel's "Questions".
public struct WebConversation: Codable, Identifiable, Equatable, Sendable, Settleable {
    /// From its URL (`WebSite.conversationID`); a question sent on a page that has no id in its
    /// address yet gets one of its own ("new-…") until the page has one.
    public var id: String
    /// Its page; the site's start page while it has no id of its own.
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
    /// The question still waiting for its answer, from the moment the page showed it sent; nil
    /// once an answer was read. A row with no id yet keeps its first question here.
    public var question: String?
    /// When that question was first seen.
    public var askedAt: Date?
    /// When it left the left column (you viewed it and moved on, or its clock); it stays in
    /// the right panel's "Questions", and opening it from there brings it back.
    public var settledAt: Date?
    public var unsettledAt: Date?
    /// The account it was asked in (`WebAccount.id`); nil is the site's first account, as every
    /// row from before accounts is.
    public var accountID: String?

    public init(id: String, url: URL, title: String, messages: Int = 0, savedAt: Date? = nil, file: String? = nil, updatedAt: Date) {
        self.id = id
        self.url = url
        self.title = title
        self.messages = messages
        self.savedAt = savedAt
        self.file = file
        self.updatedAt = updatedAt
    }

    /// A question was sent and no answer has been read since.
    public var isAwaiting: Bool { askedAt != nil }

    /// Its account's id (the first account's for a row from before accounts).
    public var account: String { accountID ?? WebAccount.firstID }
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
    public mutating func upsert(id: String, url: URL, title: String?, at now: Date, account: String? = nil) -> WebConversation {
        var item = conversation(id) ?? {
            var row = WebConversation(id: id, url: url, title: title ?? "", updatedAt: now)
            // A new row is of the account its page is signed in to (the first stays nil).
            if let account, account != WebAccount.firstID { row.accountID = account }
            return row
        }()
        item.url = url
        if let title, !title.isEmpty { item.title = title }
        item.updatedAt = now
        conversations.removeAll { $0.id == id }
        conversations.insert(item, at: 0)
        return item
    }

    /// Changes the conversation in place, if it is listed.
    public mutating func update(_ id: String, _ change: (inout WebConversation) -> Void) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        change(&conversations[index])
    }

    /// A row made before its page had an id is that conversation (`id`, at `url`): it takes the
    /// id, or, when that conversation is listed already, folds into it.
    public mutating func adopt(_ old: String, as id: String, url: URL) {
        guard old != id, let index = conversations.firstIndex(where: { $0.id == old }) else { return }
        var row = conversations.remove(at: index)
        guard conversation(id) == nil else { return }
        row.id = id
        row.url = url
        conversations.insert(row, at: min(index, conversations.count))
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
                description: "Reads the conversation on a web AI's page (\(WebSite.all.map(\.name).joined(separator: ", "))) into text for the main bot. One script per site; README.md has the contract.",
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
    /// A question was sent and its answer has not come yet.
    case waiting
    case saved(messages: Int, at: Date)
    /// The page reader found nothing: shown, and no file written.
    case unreadable(String)
}

/// Every web site's conversations, their saved text, and what the open page's status is.
///
/// A site may have several pages (web views) open at once: the one in the chat column (its
/// front page) and ones put behind it while a question on them still waits for its answer.
/// Each page follows one row, so an answer that comes on a page you left is still saved to the
/// row its question made.
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
    /// The row that request is for, when it is for one.
    @Published public private(set) var requestedRow: [String: String] = [:]
    @Published public private(set) var status: [String: WebPageStatus] = [:]
    /// The page each site shows in the chat column, by site id (`firstPage` until another).
    @Published public private(set) var front: [String: UUID] = [:]
    /// The site picked in the left column, if one is: an answer read on its front page then
    /// counts as seen.
    public private(set) var shown: String?
    /// The text last written per conversation (`site/id`), so an unchanged page writes nothing.
    private var written: [String: [WebTurn]] = [:]
    /// The row each open page follows, by page.
    private var pages: [UUID: String] = [:]
    /// Each open page's last address, so a move inside the site is told from a title change.
    private var addresses: [UUID: URL] = [:]
    /// Conversations (`site/id`) whose answer you have seen: leaving one settles its row.
    private var seen: Set<String> = []
    /// Whether the page reader's two readings (the page, its traffic) agreed on the front page's
    /// last settled read, by site id.
    @Published public private(set) var readerCheck: [String: WebReaderCheck] = [:]
    /// When a changed page reader first read a page the one before it could not: "updated", by site id.
    @Published public private(set) var readerFixedAt: [String: Date] = [:]
    /// The page reader (its hash) that last could not read the front page, by site id.
    private var failingReader: [String: String] = [:]
    /// Each site's accounts, by site id (the first account only, until you add one).
    @Published public private(set) var accountLists: [String: WebAccountList] = [:]
    /// The account the chat column shows each site in, by site id (the first when absent).
    @Published public private(set) var currentAccount: [String: String] = [:]
    /// The account each open page is signed in to, by page (the first when absent).
    private var pageAccounts: [UUID: String] = [:]

    /// Captures (`~/.claudecodebot/captures`), next to `web`.
    public var capturesFolder: URL { WebCapturePack.root(besides: folder) }

    /// The page a site shows before any other was put in front.
    nonisolated public static let firstPage = UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000F1")!

    public init(folder: URL, library: URL) {
        self.folder = folder
        self.library = library
        for site in WebSite.all {
            stores[site.id] = WebConversationStore(folder: siteFolder(site))
            accountLists[site.id] = WebAccountList(site: site, folder: siteFolder(site))
        }
    }

    // MARK: Accounts

    /// The site's accounts (its first, then those you added).
    public func accounts(of site: WebSite) -> WebAccountList {
        accountLists[site.id] ?? WebAccountList(site: site, folder: siteFolder(site))
    }

    /// The account the chat column shows the site in now.
    public func account(of site: WebSite) -> WebAccount {
        accounts(of: site).resolved(currentAccount[site.id])
    }

    /// The account a row was asked in (the first, for a row from before accounts or of one
    /// removed since).
    public func account(of conversation: WebConversation, on site: WebSite) -> WebAccount {
        accounts(of: site).resolved(conversation.accountID)
    }

    /// The account an open page is signed in to.
    public func account(ofPage page: UUID, on site: WebSite) -> WebAccount {
        accounts(of: site).resolved(pageAccounts[page])
    }

    /// A page was opened signed in to `account` (its data store): what it reads is that account's.
    public func attach(_ page: UUID, account: WebAccount) {
        pageAccounts[page] = account.isFirst ? nil : account.id
    }

    /// "Add account…": a new account on a fresh store of its own, saved.
    @discardableResult
    public func addAccount(on site: WebSite, name: String = "", now: Date = Date()) -> WebAccount {
        var list = accounts(of: site)
        let account = list.add(name: name, now: now)
        list.save()
        accountLists[site.id] = list
        return account
    }

    public func renameAccount(_ id: String, to name: String, on site: WebSite) {
        var list = accounts(of: site)
        list.rename(id, to: name)
        guard list != accounts(of: site) else { return }
        list.save()
        accountLists[site.id] = list
    }

    /// Takes an added account off the list (never the first): the column shows the first
    /// account again if it showed this one. Its rows and saved text stay (they open in the first
    /// account from then on). Returns it, so its data store can be removed once its pages close.
    @discardableResult
    public func removeAccount(_ id: String, on site: WebSite, now: Date = Date()) -> WebAccount? {
        var list = accounts(of: site)
        guard let removed = list.remove(id) else { return nil }
        list.save()
        accountLists[site.id] = list
        for (page, account) in pageAccounts where account == id { pageAccounts[page] = nil }
        if currentAccount[site.id] == id {
            currentAccount[site.id] = nil
            startNew(on: site, account: list.first, now: now)
        }
        return removed
    }

    public func siteFolder(_ site: WebSite) -> URL { folder.appending(path: site.id) }

    /// Every conversation of the site, newest first (the right panel's "Questions").
    public func conversations(of site: WebSite) -> [WebConversation] {
        stores[site.id]?.conversations ?? []
    }

    /// The rows the left column lists under the site: the ones you did not settle, those
    /// still waiting for an answer first, then newest first.
    public func listed(of site: WebSite) -> [WebConversation] {
        let rows = conversations(of: site).filter { !$0.isSettled }
        return rows.filter(\.isAwaiting) + rows.filter { !$0.isAwaiting }
    }

    public func conversation(_ id: String, of site: WebSite) -> WebConversation? {
        stores[site.id]?.conversation(id)
    }

    public func openConversation(of site: WebSite) -> WebConversation? {
        open[site.id].flatMap { stores[site.id]?.conversation($0) }
    }

    /// Whether the conversation has its own page to load (an id in its address).
    public func hasAddress(_ conversation: WebConversation, on site: WebSite) -> Bool {
        site.conversationID(in: conversation.url) != nil
    }

    /// The saved text's file, once there is one.
    public func fileURL(of conversation: WebConversation, site: WebSite) -> URL? {
        conversation.file.map { siteFolder(site).appending(path: $0) }
    }

    /// The page reader's source for `site`.
    public func extractor(for site: WebSite) -> String? {
        WebExtractors.script(for: site, library: library, bundled: bundledExtractors)?.source
    }

    /// The conversation a saved text file is of (a bot's link to it): by the list, else by the
    /// file's own "- URL:" line, and then it is listed again. Nil for any other file.
    public func conversation(savedIn file: URL, now: Date = Date()) -> (site: WebSite, conversation: WebConversation)? {
        guard file.isFileURL else { return nil }
        let path = file.standardizedFileURL.resolvingSymlinksInPath()
        for site in WebSite.all where path.deletingLastPathComponent().path == siteFolder(site).standardizedFileURL.resolvingSymlinksInPath().path {
            let name = path.lastPathComponent
            if let known = conversations(of: site).first(where: { $0.file == name }) { return (site, known) }
            guard let text = try? String(contentsOf: path, encoding: .utf8) else { return nil }
            // The header: "# <title>", then "- <field>: <value>" lines, before the first message.
            let header = text.components(separatedBy: "\n").prefix { !$0.hasPrefix("## ") }
            let title = header.first { $0.hasPrefix("# ") }.map { String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
            guard let line = header.first(where: { $0.hasPrefix("- URL: ") }),
                  let url = URL(string: String(line.dropFirst("- URL: ".count)).trimmingCharacters(in: .whitespaces)),
                  let id = site.conversationID(in: url), var store = stores[site.id] else { return nil }
            store.upsert(id: id, url: url, title: title, at: now)
            store.update(id) { row in
                if row.file == nil { row.file = name }
            }
            store.save()
            stores[site.id] = store
            return store.conversation(id).map { (site, $0) }
        }
        return nil
    }

    // MARK: Pages

    public func frontPage(of site: WebSite) -> UUID { front[site.id] ?? Self.firstPage }

    /// The row a page follows, if it follows one.
    public func row(of page: UUID, on site: WebSite) -> WebConversation? {
        pages[page].flatMap { stores[site.id]?.conversation($0) }
    }

    /// A page is now the one in the chat column (a fresh one for a request, or one brought back
    /// from behind it).
    public func bringToFront(_ page: UUID, on site: WebSite) {
        front[site.id] = page
        if let id = pages[page] { open[site.id] = id }
    }

    /// A page was closed.
    public func closed(_ page: UUID) {
        pages[page] = nil
        addresses[page] = nil
        pageAccounts[page] = nil
    }

    /// Rows still waiting for an answer that no open page follows and that have their own page:
    /// what to read again (after a restart, or once the page that asked was closed).
    public func toReadAgain(on site: WebSite) -> [WebConversation] {
        let followed = Set(pages.values)
        return conversations(of: site).filter { $0.isAwaiting && !followed.contains($0.id) && hasAddress($0, on: site) }
    }

    /// The same, only the rows of one account (read again on pages signed in to it).
    public func toReadAgain(on site: WebSite, account: WebAccount) -> [WebConversation] {
        toReadAgain(on: site).filter { self.account(of: $0, on: site).id == account.id }
    }

    // MARK: What you do

    /// The site picked in the left column now (nil: a bot).
    public func showing(_ site: WebSite?) {
        shown = site?.id
    }

    /// A row clicked (in the left column or the right panel): its page loads, and it is listed
    /// in the left column again until you leave it.
    public func show(_ conversation: WebConversation, of site: WebSite, now: Date = Date()) {
        // It opens in its own account (signed in on that account's store).
        let account = account(of: conversation, on: site)
        currentAccount[site.id] = account.isFirst ? nil : account.id
        setOpen(conversation.id, on: site, now: now)
        if !conversation.isAwaiting { seen.insert("\(site.id)/\(conversation.id)") }
        if stores[site.id]?.conversation(conversation.id)?.isSettled == true {
            stores[site.id]?.update(conversation.id) { $0.unsettle(at: now) }
            stores[site.id]?.save()
        }
        requested[site.id] = conversation.url
        requestedRow[site.id] = conversation.id
        status[site.id] = conversation.isAwaiting ? .waiting : .reading
    }

    /// "New question" (or the site's own row): the site's start page, fresh, in `account` (an
    /// account picked in its menu), else the account shown now.
    public func startNew(on site: WebSite, account: WebAccount? = nil, now: Date = Date()) {
        if let account, accounts(of: site).account(account.id) != nil {
            currentAccount[site.id] = account.isFirst ? nil : account.id
        }
        setOpen(nil, on: site, now: now)
        requested[site.id] = site.startURL
        requestedRow[site.id] = nil
        status[site.id] = .newQuestion
    }

    /// The row's clock: it leaves the left column (it stays under "Questions").
    public func settle(_ conversation: WebConversation, of site: WebSite, now: Date = Date()) {
        stores[site.id]?.update(conversation.id) { $0.settle(at: now) }
        stores[site.id]?.save()
    }

    /// The view loaded what was asked for.
    public func handled(_ site: WebSite) {
        requested[site.id] = nil
        requestedRow[site.id] = nil
    }

    /// The front page shows `id` now: the one it showed before, once you saw its answer, leaves
    /// the left column, as a subagent you are done with does. One still waiting stays.
    private func setOpen(_ id: String?, on site: WebSite, now: Date) {
        let before = open[site.id]
        guard before != id else { return }
        open[site.id] = id
        guard let before, seen.remove("\(site.id)/\(before)") != nil,
              let row = stores[site.id]?.conversation(before), !row.isAwaiting else { return }
        stores[site.id]?.update(before) { $0.settle(at: now) }
        stores[site.id]?.save()
    }

    // MARK: What the pages show

    /// The page moved to `url` (a new question got its id, a link inside the site).
    public func pageChanged(on site: WebSite, page: UUID = firstPage, url: URL, pageTitle: String?, now: Date = Date()) {
        let isFront = page == frontPage(of: site)
        let moved = addresses[page].map { $0 != url } ?? false
        addresses[page] = url
        guard let id = site.conversationID(in: url) else {
            // Moved off a conversation inside the site (its own "New chat"): it no longer
            // follows it. A question with no id yet stays followed: its page did not move.
            if moved, let row = row(of: page, on: site), hasAddress(row, on: site) { pages[page] = nil }
            if isFront {
                let following = row(of: page, on: site)
                setOpen(following?.id, on: site, now: now)
                status[site.id] = following?.isAwaiting == true ? .waiting : .newQuestion
            }
            return
        }
        follow(page, id: id, url: url, on: site, questions: [])
        if isFront {
            if open[site.id] != id { status[site.id] = .reading }
            setOpen(id, on: site, now: now)
        }
        let title = WebTranscript.clean(pageTitle, site: site)
        if stores[site.id]?.conversation(id) == nil || title != nil {
            stores[site.id]?.upsert(id: id, url: url, title: title ?? stores[site.id]?.conversation(id)?.title ?? site.name, at: now, account: pageAccounts[page])
            stores[site.id]?.save()
        }
    }

    /// The page follows conversation `id` now. The row its question made before the page had
    /// an id becomes that conversation; so does a row whose page was closed before it had one,
    /// once a conversation shows the same question.
    private func follow(_ page: UUID, id: String, url: URL, on site: WebSite, questions: Set<String>) {
        guard var store = stores[site.id] else { return }
        let before = store.conversations
        if let previous = pages[page], previous != id, let row = store.conversation(previous), !hasAddress(row, on: site) {
            store.adopt(previous, as: id, url: url)
            if open[site.id] == previous { open[site.id] = id }
        }
        let followed = Set(pages.filter { $0.key != page }.values)
        // Only a row asked in this page's account: another account's conversation is never it.
        let own = account(ofPage: page, on: site).id
        for row in store.conversations where row.id != id && !hasAddress(row, on: site) && !followed.contains(row.id)
            && accounts(of: site).resolved(row.accountID).id == own {
            if let question = row.question, questions.contains(question) { store.adopt(row.id, as: id, url: url) }
        }
        pages[page] = id
        if store.conversations != before {
            store.save()
            stores[site.id] = store
        }
    }

    /// What the page reader found on a page. `settled` is a read once the page went quiet (an
    /// answer finished): the text is saved (its file returned), or "couldn't read this page"
    /// with no file written. A read while the page still changes only notes a question just
    /// sent, so its row shows at once (titled from it), before the page has an id or an answer.
    @discardableResult
    public func record(on site: WebSite, page: UUID = firstPage, url: URL, pageTitle: String?, reading: WebReading, settled: Bool = true, now: Date = Date()) -> URL? {
        let isFront = page == frontPage(of: site)
        guard case .read(let extracted, let turns) = reading else {
            guard settled else { return nil }
            guard let id = site.conversationID(in: url) else {
                if isFront, row(of: page, on: site) == nil { status[site.id] = .newQuestion }
                return nil
            }
            follow(page, id: id, url: url, on: site, questions: [])
            if isFront {
                setOpen(id, on: site, now: now)
                if case .nothing(let reason) = reading { status[site.id] = .unreadable(reason) }
            }
            if stores[site.id]?.conversation(id) == nil {
                stores[site.id]?.upsert(id: id, url: url, title: WebTranscript.clean(pageTitle, site: site) ?? site.name, at: now, account: pageAccounts[page])
                stores[site.id]?.save()
            }
            return nil
        }
        let title = WebTranscript.title(extracted: extracted, pageTitle: pageTitle, turns: turns, site: site)
        guard let id = site.conversationID(in: url) else {
            noteNewQuestion(on: site, page: page, turns: turns, title: title, isFront: isFront, now: now)
            return nil
        }
        follow(page, id: id, url: url, on: site, questions: Set(turns.filter { $0.role == .user }.map(\.text)))
        if isFront { setOpen(id, on: site, now: now) }
        guard var store = stores[site.id] else { return nil }
        // The last message yours: its answer has not come yet.
        let asked = turns.last?.role == .user ? turns.last?.text : nil
        let known = store.conversation(id)
        if let asked {
            store.upsert(id: id, url: url, title: title, at: now, account: pageAccounts[page])
            store.update(id) { row in
                if row.askedAt == nil {
                    row.askedAt = now
                    row.unsettle(at: now)
                }
                row.question = asked
            }
            seen.remove("\(site.id)/\(id)")
        } else if settled {
            store.update(id) { row in
                row.askedAt = nil
                row.question = nil
            }
            if isFront && shown == site.id { seen.insert("\(site.id)/\(id)") }
        }
        guard settled else {
            if known == nil { store.upsert(id: id, url: url, title: title, at: now, account: pageAccounts[page]) }
            if store.conversations != stores[site.id]?.conversations {
                store.save()
                stores[site.id] = store
            }
            if isFront, asked != nil { status[site.id] = .waiting }
            return nil
        }
        let shownStatus = { (saved: WebPageStatus) in
            if isFront { self.status[site.id] = asked == nil ? saved : .waiting }
        }
        let key = "\(site.id)/\(id)"
        if written[key] == turns, let known = store.conversation(id), let file = known.file, let savedAt = known.savedAt,
           FileManager.default.fileExists(atPath: siteFolder(site).appending(path: file).path) {
            if store.conversations != stores[site.id]?.conversations {
                store.save()
                stores[site.id] = store
            }
            shownStatus(.saved(messages: known.messages, at: savedAt))
            return siteFolder(site).appending(path: file)
        }
        let file = store.fileName(for: id, title: title)
        let target = siteFolder(site).appending(path: file)
        try? FileManager.default.createDirectory(at: siteFolder(site), withIntermediateDirectories: true)
        let text = WebTranscript.markdown(title: title, url: url, site: site, turns: turns, savedAt: now)
        guard (try? Data(text.utf8).write(to: target, options: .atomic)) != nil else {
            if isFront { status[site.id] = .unreadable("The text could not be saved to \(target.path).") }
            return nil
        }
        store.upsert(id: id, url: url, title: title, at: now, account: pageAccounts[page])
        store.recordSave(id: id, messages: turns.count, file: file, at: now)
        store.save()
        stores[site.id] = store
        written[key] = turns
        shownStatus(.saved(messages: turns.count, at: now))
        return target
    }

    /// The front page's settled read went through the page reader `readerHash`: whether its page
    /// and traffic readings agreed. A reader that could not read the page (or whose readings
    /// differed) and is then changed so that it reads it is "updated" (`readerFixedAt`).
    public func noteReader(_ check: WebReaderCheck, reading: WebReading, on site: WebSite, page: UUID = firstPage, url: URL, readerHash: String?, now: Date = Date()) {
        guard page == frontPage(of: site) else { return }
        readerCheck[site.id] = check
        let failed: Bool = {
            if check.isMismatch { return true }
            if case .nothing = reading { return site.conversationID(in: url) != nil }
            return false
        }()
        if failed {
            if let readerHash { failingReader[site.id] = readerHash }
            readerFixedAt[site.id] = nil
        } else if case .read = reading, let before = failingReader.removeValue(forKey: site.id), let readerHash, before != readerHash {
            readerFixedAt[site.id] = now
        }
    }

    /// A question on a page with no id in its address yet: a row of its own at once, titled
    /// from it, which becomes the conversation once the page has an id. The page's first
    /// question tells its row from one an earlier question on the same page made.
    private func noteNewQuestion(on site: WebSite, page: UUID, turns: [WebTurn], title: String, isFront: Bool, now: Date) {
        guard let first = turns.first(where: { $0.role == .user })?.text, var store = stores[site.id] else {
            if isFront, row(of: page, on: site) == nil { status[site.id] = .newQuestion }
            return
        }
        let id: String
        if let row = row(of: page, on: site), !hasAddress(row, on: site), row.question == first {
            id = row.id
        } else {
            id = "new-" + UUID().uuidString.prefix(13).lowercased()
            store.upsert(id: id, url: site.startURL, title: title, at: now, account: pageAccounts[page])
            store.update(id) { row in
                row.question = first
                row.askedAt = now
            }
            store.save()
            stores[site.id] = store
        }
        pages[page] = id
        if isFront {
            setOpen(id, on: site, now: now)
            status[site.id] = .waiting
        }
    }
}
