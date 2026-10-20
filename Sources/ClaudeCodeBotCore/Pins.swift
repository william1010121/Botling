import Foundation

/// A component kept on a bot (the chips above its input box and its Board), not only inside a
/// chat message. One with a command is drawn again with what the command prints (when shown,
/// every few minutes, or only on ↻), once the user has allowed that command for the bot's
/// folder, as for any component card; one without keeps the data it was last drawn with.
/// Saved per bot in `pins.json` beside its chat.
public struct PinnedComponent: Codable, Equatable, Identifiable, Sendable {
    public enum Refresh: String, Codable, CaseIterable, Sendable {
        /// Each time it is shown: its chip opened, or the Board.
        case shown
        /// Every `minutes` minutes, while the app runs.
        case interval
        /// Only when you press ↻.
        case manual
    }

    /// Its card on the Board, in square cells like a home-screen widget: columns × rows.
    public enum Size: String, Codable, CaseIterable, Sendable {
        case small = "1x1", wide = "2x1", tall = "1x2", large = "2x2", extraLarge = "4x2"

        public var columns: Int { Int(rawValue.prefix(1)) ?? 2 }
        public var rows: Int { Int(rawValue.suffix(1)) ?? 2 }
        /// What a template sees in `ccb.size.name`.
        public var name: String {
            switch self {
            case .small: "small"
            case .wide: "wide"
            case .tall: "tall"
            case .large: "large"
            case .extraLarge: "xlarge"
            }
        }

        /// A size as pins.json or an about.md `Sizes:` line spells it: "2x1", "2×1", a name, or
        /// the old S/M/L (small, the 2×2 default, the widest).
        public init?(spelled text: String) {
            let text = text.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "×", with: "x").replacingOccurrences(of: " ", with: "")
            switch text {
            case "s": self = .small
            case "m": self = .large
            case "l": self = .extraLarge
            default:
                guard let size = Size(rawValue: text) ?? Size.allCases.first(where: { $0.name == text }) else { return nil }
                self = size
            }
        }

        /// What a component gets when it is pinned: 2×2 when it has that layout, else its first.
        public static func preferred(among sizes: [Size]) -> Size {
            sizes.contains(.large) ? .large : sizes.first ?? .large
        }
    }

    public var id: UUID
    /// The component's name in the library.
    public var name: String
    /// What gives it its data; nil: it keeps `data` as it was drawn.
    public var command: String?
    /// The data it was last drawn with (JSON).
    public var data: String
    /// When its command last gave `data`.
    public var ranAt: Date?
    public var refresh: Refresh
    /// For `.interval`.
    public var minutes: Int
    /// Its card on the Board.
    public var size: Size

    public static let defaultMinutes = 15
    /// A pin refreshed every so often runs at most this often.
    public static let minimumMinutes = 1

    public init(id: UUID = UUID(), name: String, command: String? = nil, data: String, ranAt: Date? = nil, refresh: Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes, size: Size = .large) {
        self.id = id
        self.name = name
        self.command = command
        self.data = data
        self.ranAt = ranAt
        self.refresh = command == nil ? .manual : refresh
        self.minutes = max(Self.minimumMinutes, minutes)
        self.size = size
    }

    private enum CodingKeys: String, CodingKey { case id, name, command, data, ranAt, refresh, minutes, size }

    // A value this build does not know (a newer refresh mode or size) falls back, so the rest
    // of the file still loads. The old sizes S, M and L become 1×1, 2×2 and 4×2.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        command = try c.decodeIfPresent(String.self, forKey: .command)
        data = try c.decodeIfPresent(String.self, forKey: .data) ?? "null"
        ranAt = try c.decodeIfPresent(Date.self, forKey: .ranAt)
        let refresh: String? = try? c.decodeIfPresent(String.self, forKey: .refresh)
        self.refresh = refresh.flatMap(Refresh.init(rawValue:)) ?? .shown
        let minutes: Int? = try? c.decodeIfPresent(Int.self, forKey: .minutes)
        self.minutes = max(Self.minimumMinutes, minutes ?? Self.defaultMinutes)
        let size: String? = try? c.decodeIfPresent(String.self, forKey: .size)
        self.size = size.flatMap(Size.init(spelled:)) ?? .large
    }

    /// The card key its command's runs go under (`ComponentCommands`), apart from chat cards.
    public var card: String { "pin/\(id.uuidString)" }

    /// Whether a pin refreshed every few minutes should run now, given when it last ran.
    public func isDue(at now: Date, lastRan: Date?) -> Bool {
        guard refresh == .interval, command != nil else { return false }
        guard let lastRan else { return true }
        return now.timeIntervalSince(lastRan) >= TimeInterval(minutes * 60)
    }
}

/// A bot's pins, in the order they show.
public enum Pins {
    /// Pins shown again within this many seconds do not run again ("when shown").
    public static let shownCooldown: TimeInterval = 30

    /// Adds `pin` at the end, unless the same component with the same command is pinned
    /// already. Returns whether it was added.
    @discardableResult
    public static func add(_ pin: PinnedComponent, to pins: inout [PinnedComponent]) -> Bool {
        guard !pins.contains(where: { $0.id == pin.id || ($0.name == pin.name && $0.command == pin.command) }) else { return false }
        pins.append(pin)
        return true
    }

    /// Moves a pin to `index` (clamped), the others keeping their order.
    public static func move(_ id: UUID, to index: Int, in pins: inout [PinnedComponent]) {
        guard let from = pins.firstIndex(where: { $0.id == id }) else { return }
        let pin = pins.remove(at: from)
        pins.insert(pin, at: min(max(index, 0), pins.count))
    }

    /// One short line for a pin's chip, from its data: a `summary`, `headline` or `title` the
    /// data gives; else the first item of a list (its hash, title or name, and the like); else
    /// the first line of text. Empty when there is nothing to say.
    public static func headline(_ json: String, limit: Int = 48) -> String {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: .fragmentsAllowed) else {
            return clip(firstLine(json), limit)
        }
        return clip(headline(of: value, depth: 0), limit)
    }

    private static let summaryKeys = ["summary", "headline", "title"]
    private static let listKeys = ["commits", "rows", "items", "components", "entries", "results"]
    private static let itemKeys = ["hash", "subject", "title", "name", "city", "bot", "label", "condition", "message", "date"]

    private static func headline(of value: Any, depth: Int) -> String {
        switch value {
        case let text as String:
            return firstLine(text)
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "Yes" : "No") : number.stringValue
        case let list as [Any]:
            guard let first = list.first else { return "Nothing yet" }
            let line = depth < 2 ? headline(of: first, depth: depth + 1) : ""
            return list.count > 1 && !line.isEmpty ? "\(line) · \(list.count)" : line
        case let object as [String: Any]:
            for key in summaryKeys {
                if let text = object[key] as? String, !text.trimmingCharacters(in: .whitespaces).isEmpty { return firstLine(text) }
            }
            if depth < 2 {
                for key in listKeys {
                    if let list = object[key] as? [Any] { return headline(of: list, depth: depth + 1) }
                }
            }
            let parts = itemKeys.compactMap { key -> String? in
                switch object[key] {
                case let text as String: let line = firstLine(text); return line.isEmpty ? nil : line
                case let number as NSNumber: return number.stringValue
                default: return nil
                }
            }
            if !parts.isEmpty { return parts.prefix(2).joined(separator: " · ") }
            // Else the first short values it has, in key order (dictionaries keep none).
            let simple = object.keys.sorted().compactMap { key -> String? in
                switch object[key] {
                case let text as String: let line = firstLine(text); return line.isEmpty ? nil : line
                case let number as NSNumber where CFGetTypeID(number) != CFBooleanGetTypeID(): return "\(key) \(number.stringValue)"
                default: return nil
                }
            }
            return simple.prefix(2).joined(separator: " · ")
        default:
            return ""
        }
    }

    private static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    private static func clip(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }
}
