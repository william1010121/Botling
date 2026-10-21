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

    /// Its card on the Board, in square cells like a home-screen widget: columns × rows, each
    /// from 1 to 4, as the user drags its corner or picks it. The component is told the size and
    /// its real width and height in pixels, and lays itself out for them.
    public struct Size: Hashable, Codable, Sendable, CustomStringConvertible {
        /// The most cells a card spans each way.
        public static let maxColumns = 4
        public static let maxRows = 4

        public let columns: Int
        public let rows: Int

        /// A size of `columns` × `rows`, each kept within 1…4.
        public init(columns: Int, rows: Int) {
            self.columns = min(max(columns, 1), Self.maxColumns)
            self.rows = min(max(rows, 1), Self.maxRows)
        }

        public static let small = Size(columns: 1, rows: 1)
        public static let wide = Size(columns: 2, rows: 1)
        public static let tall = Size(columns: 1, rows: 2)
        public static let large = Size(columns: 2, rows: 2)
        public static let extraLarge = Size(columns: 4, rows: 2)

        /// Every size a card can take, row by row: 1×1, 2×1, … 4×4.
        public static let all: [Size] = (1...maxRows).flatMap { rows in (1...maxColumns).map { Size(columns: $0, rows: rows) } }

        /// The five sizes that have a name, and what a template sees in `ccb.size.name`.
        static let named: [(Size, String)] = [(.small, "small"), (.wide, "wide"), (.tall, "tall"), (.large, "large"), (.extraLarge, "xlarge")]

        /// As pins.json and the page spell it: "3x2".
        public var rawValue: String { "\(columns)x\(rows)" }
        public var description: String { rawValue }

        /// The nearest named size ("small", "wide", "tall", "large" or "xlarge"), for templates
        /// written for the five fixed sizes; of two as near, the earlier.
        public var name: String {
            let distance = { (size: Size) in (size.columns - columns) * (size.columns - columns) + (size.rows - rows) * (size.rows - rows) }
            return Self.named.min { distance($0.0) < distance($1.0) }?.1 ?? "large"
        }

        /// A size as pins.json or an about.md `Sizes:` line spells it: "3x2", "2×1", a name, or
        /// the old S/M/L (small, the 2×2 default, the widest). Nil for anything else, or a size
        /// past 4×4.
        public init?(spelled text: String) {
            let text = text.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "×", with: "x").replacingOccurrences(of: " ", with: "")
            switch text {
            case "s": self = .small
            case "m": self = .large
            case "l": self = .extraLarge
            default:
                if let named = Self.named.first(where: { $0.1 == text }) {
                    self = named.0
                    return
                }
                let parts = text.split(separator: "x", omittingEmptySubsequences: false)
                guard parts.count == 2, let columns = Int(parts[0]), let rows = Int(parts[1]),
                      (1...Self.maxColumns).contains(columns), (1...Self.maxRows).contains(rows) else { return nil }
                self.init(columns: columns, rows: rows)
            }
        }

        public init(from decoder: Decoder) throws {
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let size = Size(spelled: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a size: \(text)"))
            }
            self = size
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }

        /// What a component gets when it is pinned: 2×2 when its `Sizes:` hint names that (or
        /// names none), else the first it names.
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
    /// For `.interval` every few seconds instead of minutes (a live pin); nil: `minutes`.
    public var seconds: Int?
    /// Its card on the Board.
    public var size: Size
    /// Where its card sits on the Board: its top-left cell, columns and rows from 0 (free
    /// placement, gaps kept; see Web/src/board-layout.ts). Nil until the Board first lays it out:
    /// a pin from before free placement, or a new one, takes the first free cells in pin order,
    /// where the old packed Board drew it, and the page then sends that place to keep.
    public var place: Place?
    /// How tall it opens above the input box, in points, once the user has dragged that panel's
    /// edge; nil: as tall as its content (up to the panel's limit).
    public var panelHeight: Int?
    /// What its chip says, as the component last set it (`ccb.setStatus`); nil: its headline.
    public var status: PinStatus?
    /// When the component last kept new data itself (`ccb.save`, see `ComponentState`); nil:
    /// `data` is what it was pinned or last refreshed with.
    public var savedAt: Date?
    /// Filled by a bot (no command) and Maintainer was asked to give its component a Command
    /// from its about.md's `Board command:`, so it refreshes on the Board; it shows the bot's
    /// data, with a small note, until that lands.
    public var makingLive = false
    /// Floated in a corner of its bot's chat window (and the Board), so it can be watched without
    /// asking, and over every bot's chat once shown in all bots (`GlobalFloat`); nil: it does not
    /// float. A chat shows at most `Pins.maxFloating` floating cards.
    public var float: Floating?

    /// A Board card's top-left cell.
    public struct Place: Codable, Equatable, Hashable, Sendable {
        public var col: Int
        public var row: Int

        /// Kept at 0 or more; a column past a narrower Board's edge is moved left by the page when drawn.
        public init(col: Int, row: Int) {
            self.col = max(0, col)
            self.row = max(0, row)
        }

        private enum CodingKeys: String, CodingKey { case col, row }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(col: try c.decode(Int.self, forKey: .col), row: try c.decode(Int.self, forKey: .row))
        }
    }

    /// Where a floating pin sits and how it shows: a corner it snaps to, its card's size in
    /// points once dragged by its corner (nil until then: the page gives it a width that fits a
    /// card's full layout and its content's height), and whether it is folded to one line.
    public struct Floating: Codable, Equatable, Sendable {
        public enum Corner: String, Codable, CaseIterable, Sendable {
            case topRight, topLeft, bottomRight, bottomLeft
        }

        /// The size every floating card had before it fitted its content: one kept with exactly
        /// this size was never resized, and fits its content now.
        static let oldDefault = (width: 280, height: 160)
        /// The sizes its card may be dragged to.
        public static let widths = 200...640
        public static let heights = 100...480

        public var corner: Corner
        /// Its width as the user dragged it; nil: the page's default width.
        public var width: Int?
        /// The most it grows to as the user dragged it (shorter content, shorter card); nil: its content's height, up to the page's limit.
        public var height: Int?
        public var collapsed: Bool

        public init(corner: Corner = .topRight, width: Int? = nil, height: Int? = nil, collapsed: Bool = false) {
            self.corner = corner
            self.width = width.map { Self.clamp($0, Self.widths) }
            self.height = height.map { Self.clamp($0, Self.heights) }
            self.collapsed = collapsed
        }

        /// Whether the user gave it a size of their own.
        public var resized: Bool { width != nil || height != nil }

        static func clamp(_ value: Int, _ range: ClosedRange<Int>) -> Int { min(max(value, range.lowerBound), range.upperBound) }

        private enum CodingKeys: String, CodingKey { case corner, width, height, collapsed }

        // Anything this build does not know falls back to the defaults, so the file still loads.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let corner: String? = try? c.decodeIfPresent(String.self, forKey: .corner)
            var width: Int? = try? c.decodeIfPresent(Int.self, forKey: .width)
            var height: Int? = try? c.decodeIfPresent(Int.self, forKey: .height)
            let collapsed: Bool? = try? c.decodeIfPresent(Bool.self, forKey: .collapsed)
            if width == Self.oldDefault.width, height == Self.oldDefault.height {
                width = nil
                height = nil
            }
            self.init(corner: corner.flatMap(Corner.init(rawValue:)) ?? .topRight, width: width, height: height, collapsed: collapsed ?? false)
        }
    }

    public static let defaultMinutes = 15
    /// A pin refreshed every so often runs at most this often, and at least once a day.
    public static let minimumMinutes = 1
    public static let maximumMinutes = 24 * 60
    /// A pin refreshed every few seconds runs at most every 2 seconds, and at least once a day
    /// (its refresh menu's custom interval; Web/src/refresh.ts keeps the same bounds).
    public static let minimumSeconds = 2
    public static let maximumSeconds = 24 * 60 * 60

    /// Minutes and seconds kept within those bounds.
    public static func clampMinutes(_ minutes: Int) -> Int { min(max(minimumMinutes, minutes), maximumMinutes) }
    public static func clampSeconds(_ seconds: Int) -> Int { min(max(minimumSeconds, seconds), maximumSeconds) }

    /// How long, in seconds, between runs of a pin refreshed every so often.
    public var interval: TimeInterval { TimeInterval(seconds ?? minutes * 60) }
    /// The heights an opened pin's panel may be dragged to.
    public static let panelHeights = 120...1600

    static func clampedPanelHeight(_ height: Int?) -> Int? {
        height.map { min(max($0, panelHeights.lowerBound), panelHeights.upperBound) }
    }

    public init(id: UUID = UUID(), name: String, command: String? = nil, data: String, ranAt: Date? = nil, refresh: Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes, size: Size = .large, status: PinStatus? = nil, panelHeight: Int? = nil, savedAt: Date? = nil, seconds: Int? = nil) {
        self.id = id
        self.name = name
        self.command = command
        self.data = data
        self.ranAt = ranAt
        self.refresh = command == nil ? .manual : refresh
        self.minutes = Self.clampMinutes(minutes)
        self.size = size
        self.status = status
        self.panelHeight = Self.clampedPanelHeight(panelHeight)
        self.savedAt = savedAt
        self.seconds = seconds.map(Self.clampSeconds)
    }

    private enum CodingKeys: String, CodingKey { case id, name, command, data, ranAt, refresh, minutes, size, place, status, panelHeight, savedAt, seconds, makingLive, float }

    // A value this build does not know (a newer refresh mode or size) falls back, so the rest
    // of the file still loads. The old sizes S, M and L become 1×1, 2×2 and 4×2; any WxH up
    // to 4×4 is kept as it is.
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
        self.minutes = Self.clampMinutes(minutes ?? Self.defaultMinutes)
        let size: String? = try? c.decodeIfPresent(String.self, forKey: .size)
        self.size = size.flatMap(Size.init(spelled:)) ?? .large
        place = try? c.decodeIfPresent(Place.self, forKey: .place)
        status = try? c.decodeIfPresent(PinStatus.self, forKey: .status)
        let height: Int? = try? c.decodeIfPresent(Int.self, forKey: .panelHeight)
        panelHeight = Self.clampedPanelHeight(height)
        savedAt = try? c.decodeIfPresent(Date.self, forKey: .savedAt)
        let seconds: Int? = try? c.decodeIfPresent(Int.self, forKey: .seconds)
        self.seconds = seconds.map(Self.clampSeconds)
        makingLive = (try? c.decodeIfPresent(Bool.self, forKey: .makingLive)) ?? false
        float = try? c.decodeIfPresent(Floating.self, forKey: .float)
    }

    /// The card key its command's runs go under (`ComponentCommands`), apart from chat cards.
    public var card: String { "pin/\(id.uuidString)" }

    /// Whether a pin refreshed every few minutes should run now, given when it last ran.
    public func isDue(at now: Date, lastRan: Date?) -> Bool {
        guard refresh == .interval, command != nil else { return false }
        guard let lastRan else { return true }
        return now.timeIntervalSince(lastRan) >= interval
    }
}

/// What a pin's chip shows beside its icon: a short value ("26°", "3 new", "719364f") and a tone,
/// a coloured dot on the icon unless neutral. A component sets it with `ccb.setStatus({text,
/// tone})`; without that the chip shows its headline cut short.
public struct PinStatus: Codable, Equatable, Sendable {
    public enum Tone: String, Codable, CaseIterable, Sendable {
        case neutral, good, warning, bad

        /// A tone as a component may spell it: also ok/success/green, warn/yellow,
        /// error/danger/red/fail. Anything else is neutral.
        public init(spelled text: String?) {
            switch (text ?? "").trimmingCharacters(in: .whitespaces).lowercased() {
            case "good", "ok", "success", "green", "done": self = .good
            case "warning", "warn", "yellow", "orange", "pending": self = .warning
            case "bad", "error", "danger", "red", "fail", "failed": self = .bad
            default: self = .neutral
            }
        }

        public init(from decoder: Decoder) throws {
            self.init(spelled: try decoder.singleValueContainer().decode(String.self))
        }
    }

    /// The most a chip's status shows, in characters (with the "…").
    public static let limit = 14

    public var text: String
    public var tone: Tone

    /// `text`'s first line, cut to `limit`.
    public init(text: String, tone: Tone = .neutral) {
        self.text = Pins.short(text)
        self.tone = tone
    }

    private enum CodingKeys: String, CodingKey { case text, tone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let text: String? = try? c.decodeIfPresent(String.self, forKey: .text)
        let tone: Tone? = try? c.decodeIfPresent(Tone.self, forKey: .tone)
        self.init(text: text ?? "", tone: tone ?? .neutral)
    }
}

/// A floating pin shown over every bot's chat, not only its own ("Show in all bots"): the chat
/// that holds it (`Workspace.pinChatID(of:)`, stable across launches) and the pin's id. Kept in
/// the app's settings; one whose chat or pin is gone, or that no longer floats, is dropped.
public struct GlobalFloat: Codable, Hashable, Sendable {
    public var botID: UUID
    public var pinID: UUID

    public init(botID: UUID, pinID: UUID) {
        self.botID = botID
        self.pinID = pinID
    }
}

/// A bot's pins, in the order they show.
public enum Pins {
    /// Pins shown again within this many seconds do not run again ("when shown").
    public static let shownCooldown: TimeInterval = 30

    /// The most floating cards one chat shows: its own floating pins and those of other bots
    /// shown in all bots.
    public static let maxFloating = 2

    /// A pin's float entry in its menu: Float in corner, Stop floating, or Float shown off when
    /// `maxFloating` float already.
    public enum FloatMenu: String, Codable, Sendable {
        case float, stop, full

        public var label: String {
            switch self {
            case .float: L("Float in corner")
            case .stop: L("Stop floating")
            case .full: L("Float in corner ({0} floating already)", Pins.maxFloating)
            }
        }
    }

    /// `pin`'s float entry, with `floating` cards floating now in its chat.
    public static func floatMenu(for pin: PinnedComponent, floating: Int) -> FloatMenu {
        pin.float != nil ? .stop : floating >= maxFloating ? .full : .float
    }

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

    /// Board cards put where the page laid them out (a drop, a resize and what it pushed down, or
    /// the first layout of pins without a place), with a new size for those that have one. Ids
    /// not pinned are ignored; the pins' order (their chips) is unchanged.
    public static func arrange(_ places: [(id: UUID, place: PinnedComponent.Place, size: PinnedComponent.Size?)], in pins: inout [PinnedComponent]) {
        for entry in places {
            guard let at = pins.firstIndex(where: { $0.id == entry.id }) else { continue }
            pins[at].place = entry.place
            if let size = entry.size { pins[at].size = size }
        }
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
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? L("Yes") : L("No")) : number.stringValue
        case let list as [Any]:
            guard let first = list.first else { return L("Nothing yet") }
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

    /// `text`'s first line cut to a chip's few characters (`PinStatus.limit`).
    public static func short(_ text: String) -> String {
        let line = firstLine(text)
        guard line.count > PinStatus.limit else { return line }
        return String(line.prefix(PinStatus.limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// What a pin's chip shows: how its command stands when that matters (failed; waiting for
    /// your OK or running for the first time, with nothing to show yet), else what the
    /// component set, else `headline` cut short.
    public static func chip(status: PinStatus?, headline: String, command: ComponentCommands.Status?, hasData: Bool) -> PinStatus {
        switch command {
        case .failed: PinStatus(text: "Failed", tone: .bad)
        case .approve where !hasData: PinStatus(text: "Allow?", tone: .warning)
        case .running where !hasData: PinStatus(text: "…")
        default: status ?? PinStatus(text: headline)
        }
    }

    private static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    private static func clip(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }
}
