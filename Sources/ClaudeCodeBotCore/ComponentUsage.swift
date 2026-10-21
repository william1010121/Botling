import Foundation

/// How often each chat component has been drawn: one use each time a card is made for a new
/// message (a bot's `<show>`, a `<choices>` block, a linked result page), never when a chat is
/// drawn again. Kept in `component-usage.json` so you can see which components are worth keeping.
@MainActor
public final class ComponentUsage {
    public struct Entry: Codable, Equatable {
        public var count: Int
        public var lastUsed: String
        public var byBot: [String: Int]
    }

    public struct Record: Codable, Equatable {
        public var since: String
        public var components: [String: Entry]
    }

    public let url: URL
    private var record: Record?

    public init(url: URL) {
        self.url = url
    }

    /// What the file holds; a missing or unreadable file is an empty record.
    public static func load(from url: URL) -> Record {
        guard let data = try? Data(contentsOf: url),
              let record = try? JSONDecoder().decode(Record.self, from: data) else {
            return Record(since: stamp(Date()), components: [:])
        }
        return record
    }

    /// Adds one use of each name in `names` (a name twice is two uses), by `bot`.
    public func record(_ names: [String], bot: String, at date: Date = Date()) {
        guard !names.isEmpty else { return }
        var record = record ?? Self.load(from: url)
        let now = Self.stamp(date)
        for name in names {
            var entry = record.components[name] ?? Entry(count: 0, lastUsed: now, byBot: [:])
            entry.count += 1
            entry.lastUsed = now
            entry.byBot[bot, default: 0] += 1
            record.components[name] = entry
        }
        self.record = record
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(record) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /// The component cards a new message gets: its `<show>` components, "choices" for its
    /// buttons, and a 「網頁預覽卡片」 for each result page it links to (when `previews` is on,
    /// i.e. that component is installed).
    public static func components(in message: ChatMessage, previews: Bool) -> [String] {
        var names = message.shown.map(\.name)
        if let choices = message.choices, !choices.isEmpty { names.append(ComponentLibrary.choices) }
        if previews, message.role == .bot || message.role == .notice, message.text.contains("](file:") {
            let shown = message.shown.compactMap { $0.name == PagePreview.component ? PagePreview.page(inCard: $0.data) : nil }
            names += PagePreview.linkedCards(in: message.text, skipping: shown).map { _ in PagePreview.component }
        }
        return names
    }

    static func stamp(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
