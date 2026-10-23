import Foundation

/// One sign-in on a web site (a Google account on Gemini): its own persistent website data store,
/// so its cookies never mix with another's. The site's first account is the store the site always
/// had (`WebSite.dataStoreID`), so the sign-in from before accounts existed is kept as it is; each
/// account added later gets a random store id of its own, kept on disk.
public struct WebAccount: Codable, Identifiable, Equatable, Sendable {
    /// The first account's id: the site's own, original data store.
    public static let firstID = "first"

    public var id: String
    /// What you called it (optional; "Account 2" when empty). Never read from the page.
    public var name: String
    /// Its place in `palette`.
    public var color: Int
    /// The address you gave it, if any (not scraped from the site).
    public var email: String?
    /// Its own cookies and sign-in (`WKWebsiteDataStore(forIdentifier:)`).
    public var dataStoreID: UUID
    public var addedAt: Date?

    public init(id: String, name: String = "", color: Int, email: String? = nil, dataStoreID: UUID, addedAt: Date? = nil) {
        self.id = id
        self.name = name
        self.color = color
        self.email = email
        self.dataStoreID = dataStoreID
        self.addedAt = addedAt
    }

    public var isFirst: Bool { id == Self.firstID }

    /// The account every site has: the site's own data store, unchanged.
    public static func first(of site: WebSite) -> WebAccount {
        WebAccount(id: firstID, color: 0, dataStoreID: site.dataStoreID)
    }

    /// Account colours (on the dark ground), told apart at a glance. No blue: a blue dot means a
    /// row is waiting for its answer.
    public static let palette: [UInt32] = [0xA58BFF, 0xF2A64A, 0x4CC38A, 0xF27AB0, 0xE3C452, 0xFF8A80]

    public var colorValue: UInt32 { Self.palette[((color % Self.palette.count) + Self.palette.count) % Self.palette.count] }
}

/// A site's accounts, in `web/<site>/accounts.json`. Until you add one there is no file, and the
/// site has only its first account.
public struct WebAccountList: Equatable, Sendable {
    public let site: WebSite
    public let folder: URL
    public private(set) var accounts: [WebAccount]

    public init(site: WebSite, folder: URL) {
        self.site = site
        self.folder = folder
        accounts = Self.load(from: folder.appending(path: Self.fileName), site: site)
    }

    public static let fileName = "accounts.json"
    public var fileURL: URL { folder.appending(path: Self.fileName) }

    /// The saved list, with the first account always first and always on the site's own store
    /// (whatever the file says), and no other account on any built-in site's store.
    static func load(from url: URL, site: WebSite) -> [WebAccount] {
        var first = WebAccount.first(of: site)
        guard let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder.webAccounts.decode([WebAccount].self, from: data) else { return [first] }
        if let own = saved.first(where: \.isFirst) {
            first.name = own.name
            first.email = own.email
            first.color = own.color
        }
        let reserved = Set(WebSite.all.map(\.dataStoreID))
        var seen: Set<String> = [WebAccount.firstID]
        var stores: Set<UUID> = [site.dataStoreID]
        let others = saved.filter { account in
            guard !account.isFirst, !reserved.contains(account.dataStoreID), seen.insert(account.id).inserted,
                  stores.insert(account.dataStoreID).inserted else { return false }
            return true
        }
        return [first] + others
    }

    public func save() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(accounts) { try? data.write(to: fileURL, options: .atomic) }
    }

    public var first: WebAccount { accounts[0] }
    public var hasSeveral: Bool { accounts.count > 1 }

    public func account(_ id: String?) -> WebAccount? {
        accounts.first { $0.id == (id ?? WebAccount.firstID) }
    }

    /// The account `id` names, else the first (a row from before accounts, or of one removed).
    public func resolved(_ id: String?) -> WebAccount {
        account(id) ?? first
    }

    /// "work", else "Account 2".
    public func label(of account: WebAccount) -> String {
        let name = account.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        let number = (accounts.firstIndex { $0.id == account.id } ?? accounts.count) + 1
        return L("Account {0}", number)
    }

    /// The badge's letter: the name's first letter, else (no name, or another account's name
    /// starts the same: "user1", "user2") its number.
    public func letter(of account: WebAccount) -> String {
        let number = "\((accounts.firstIndex { $0.id == account.id } ?? accounts.count) + 1)"
        guard let first = Self.initial(account) else { return number }
        let shared = accounts.contains { $0.id != account.id && Self.initial($0) == first }
        return shared ? number : first
    }

    private static func initial(_ account: WebAccount) -> String? {
        account.name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() }
    }

    /// A new account on a fresh store of its own (never a built-in site's), in the first colour
    /// not taken.
    @discardableResult
    public mutating func add(name: String = "", now: Date = Date(), store: UUID = UUID()) -> WebAccount {
        let reserved = Set(WebSite.all.map(\.dataStoreID)).union(accounts.map(\.dataStoreID))
        var dataStoreID = store
        while reserved.contains(dataStoreID) { dataStoreID = UUID() }
        let taken = Set(accounts.map { $0.color % WebAccount.palette.count })
        let color = (0..<WebAccount.palette.count).first { !taken.contains($0) } ?? accounts.count % WebAccount.palette.count
        var id = "a-" + UUID().uuidString.prefix(8).lowercased()
        while account(id) != nil { id = "a-" + UUID().uuidString.prefix(8).lowercased() }
        let account = WebAccount(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), color: color, dataStoreID: dataStoreID, addedAt: now)
        accounts.append(account)
        return account
    }

    public mutating func rename(_ id: String, to name: String) {
        guard let index = accounts.firstIndex(where: { $0.id == id }) else { return }
        accounts[index].name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Takes an added account off the list; its store is the caller's to remove. The first
    /// account (the site's own store) is never removed.
    public mutating func remove(_ id: String) -> WebAccount? {
        guard id != WebAccount.firstID, let index = accounts.firstIndex(where: { $0.id == id }) else { return nil }
        return accounts.remove(at: index)
    }

    /// Whether a data store may be removed with an account: an added account's, never a built-in
    /// site's.
    public static func isRemovableStore(_ id: UUID) -> Bool {
        !WebSite.all.contains { $0.dataStoreID == id }
    }
}

extension JSONDecoder {
    static var webAccounts: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

extension WebSite {
    /// Whether the column offers more than one account on it (Gemini only, for now; the rest of
    /// the model is the same for every site).
    public var offersAccounts: Bool { id == WebSite.gemini.id }
}
