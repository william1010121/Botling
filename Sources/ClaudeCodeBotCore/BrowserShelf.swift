import Combine
import Foundation

/// General browsing is separate from the four read-only AI conversation readers.
@MainActor
public final class BrowserShelf: ObservableObject {
    public static let selectionID = UUID(uuidString: "3E3B0000-0000-4000-8000-0000000000B0")!
    public struct Page: Codable, Equatable, Identifiable {
        public var id: UUID
        public var account: UUID
        public var url: URL
        public var title: String
        public var pinned: Bool
        public init(url: URL, title: String = "", account: UUID = UUID()) {
            id = UUID(); self.account = account; self.url = url; self.title = title; pinned = false
        }
        public var pinID: String { origin + ":" + account.uuidString }
        public var origin: String { BrowserShelf.origin(url) ?? "" }
        public var scope: JSONValue { .object(["origin": .string(origin), "account": .string(account.uuidString), "tab": .string(id.uuidString)]) }
        public var captureSite: WebSite {
            WebSite(id: "browser-" + id.uuidString.lowercased(), name: title.isEmpty ? (url.host ?? "Website") : title,
                    startURL: url, host: url.host ?? "", conversationMarker: "", insideDomains: [url.host ?? ""],
                    accent: 0x4C7DF0, symbol: "globe", selectionID: id, dataStoreID: account)
        }
    }
    public struct Tool: Identifiable, Equatable {
        public let plugin: String
        public let key: String
        public let title: String
        public let origin: String
        public var id: String { plugin + ":" + key }
    }
    @Published public private(set) var pages: [Page]
    @Published public private(set) var pins: [Page] = []
    @Published public var requestedURL: URL?
    @Published public private(set) var current: UUID
    @Published public private(set) var tools: [Tool] = []
    /// Only available while the app is presenting a browser. AppKit/WebKit stay out of Core.
    @Published public var toolRequest: Tool?
    public var perform: ((String, JSONValue) async throws -> JSONValue)?
    @Published private var clickScopes: Set<String> = []
    private let file: URL
    private struct Saved: Codable { var pages: [Page]; var current: UUID; var pins: [Page]?; var clickScopes: Set<String>? }
    public init(folder: URL) {
        file = folder.appending(path: "browser.json")
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data),
           !saved.pages.isEmpty, saved.pages.allSatisfy({ Self.origin($0.url) != nil }) {
            pins = (saved.pins ?? saved.pages.filter(\.pinned)).filter { pin in
                Self.origin(pin.url) != nil && saved.pages.contains { $0.id == pin.id && $0.account == pin.account }
            }
            clickScopes = saved.clickScopes ?? []
            pages = saved.pages; current = saved.pages.contains(where: { $0.id == saved.current }) ? saved.current : saved.pages[0].id
        } else {
            let page = Page(url: URL(string: "https://example.com")!)
            pages = [page]; current = page.id
        }
    }
    public var page: Page {
        var item = pages.first { $0.id == current } ?? pages[0]
        item.pinned = pins.contains { $0.origin == item.origin && $0.account == item.account }
        return item
    }
    nonisolated public static func address(_ input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let url = URL(string: text.contains("://") ? text : "https://" + text), origin(url) != nil,
              url.user == nil, url.password == nil else { return nil }
        return url
    }
    nonisolated public static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let port = url.port.flatMap { ($0 == 80 && scheme == "http") || ($0 == 443 && scheme == "https") ? nil : ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }
    public func open(_ id: UUID) { guard pages.contains(where: { $0.id == id }) else { return }; current = id; save() }
    /// New account has a separate persistent WebKit store; pins keep their original tab/account.
    public func openPin(_ pin: Page) {
        guard pins.contains(where: { $0.id == pin.id && $0.origin == pin.origin }), let at = pages.firstIndex(where: { $0.id == pin.id }) else { return }
        pages[at].url = pin.url; pages[at].title = pin.title
        current = pin.id; requestedURL = pin.url; save()
    }
    public func newAccount() { let item = Page(url: page.url); pages.append(item); current = item.id; save() }
    public func update(_ id: UUID, url: URL, title: String?) {
        guard Self.origin(url) != nil, let at = pages.firstIndex(where: { $0.id == id }) else { return }
        pages[at].url = url; pages[at].title = title ?? ""
        if let pin = pins.firstIndex(where: { $0.id == id && $0.origin == Self.origin(url) }) {
            pins[pin].url = url; pins[pin].title = title ?? ""
        }
        save()
    }
    public func togglePin() {
        let item = page
        if let at = pins.firstIndex(where: { $0.origin == item.origin && $0.account == item.account }) { pins.remove(at: at) }
        else { var pin = item; pin.pinned = true; pins.append(pin) }
        save()
    }
    public func clicksAllowed(for page: Page) -> Bool { clickScopes.contains(page.pinID) }
    public func allowClicks(_ allowed: Bool, for page: Page) {
        if allowed { clickScopes.insert(page.pinID) } else { clickScopes.remove(page.pinID) }
        save()
    }
    public func tools(for page: Page) -> [Tool] { tools.filter { $0.origin == page.origin } }
    public func register(plugin: String, key: String, title: String, origin: String) throws {
        guard !plugin.isEmpty, !key.isEmpty, !title.isEmpty, let url = URL(string: origin), Self.origin(url) == origin else {
            throw HostMessage.HostError(message: "A browser tool needs an id, title and exact HTTP(S) origin.")
        }
        tools.removeAll { $0.plugin == plugin && $0.key == key }
        tools.append(Tool(plugin: plugin, key: key, title: title, origin: origin))
    }
    public func unregister(plugin: String, key: String) { tools.removeAll { $0.plugin == plugin && $0.key == key } }
    public func retainTools(plugins: Set<String>) { tools.removeAll { !plugins.contains($0.plugin) } }
    public func save() {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Saved(pages: pages, current: current, pins: pins, clickScopes: clickScopes)) { try? data.write(to: file, options: .atomic) }
    }
}
