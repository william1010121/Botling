import Foundation

/// A component being made from a bot's reply ("Make into component", or a bot's own
/// `<suggest-component>`): what it shows (its data fields), where the data comes from (a command
/// run in the bot's folder), how it refreshes, which bots get it, and whether a component already
/// in the library would do. "Make into component" (or pressing a bot's suggestion chip) has
/// Maintainer infer it and build the first version right away; the chip says Building…, then the
/// component itself shows under the reply. Its "Edit spec" opens it as a workspace in the right
/// panel, shaped with Maintainer in a side conversation; Build it there makes a new version. Its
/// command runs only once the user allows it (the usual command allow flow), never by itself.
/// Saved per bot in `specs.json` beside its chat.
public struct ComponentSpec: Codable, Equatable, Identifiable, Sendable {
    /// Who set a value: the user (blue), Maintainer (purple), or the app's first draft.
    public enum Origin: String, Codable, Sendable {
        case user, maintainer, app
    }

    public enum Status: String, Codable, Sendable {
        case draft, building, done
    }

    /// One field of the data the component draws.
    public struct Field: Codable, Equatable, Sendable {
        public var name: String
        /// "int", "num", "text", "bool", "time", "[a, b]" (a list of such), "{…}".
        public var type: String
        public var by: Origin

        public init(name: String, type: String, by: Origin = .app) {
            self.name = name
            self.type = type
            self.by = by
        }
    }

    /// Data to preview it with ("This reply", "Failing run", "Empty").
    public struct Sample: Codable, Equatable, Sendable {
        /// The app's own samples. Which one is which goes by this, never by the label.
        public enum Kind: String, Codable, Sendable {
            /// The output of the last test run of its command.
            case testRun
            /// The reply's own content (or what the bot drew from it).
            case reply
            /// The result page it was made from.
            case page

            /// The tab's words for it, in the app's language.
            public var label: String {
                switch self {
                case .testRun: L("Test run")
                case .reply: L("This reply")
                case .page: L("This page")
                }
            }

            /// Its English label, which a spec saved before samples had a kind was known by.
            var englishLabel: String {
                switch self {
                case .testRun: "Test run"
                case .reply: "This reply"
                case .page: "This page"
                }
            }
        }

        /// What the tab says; only shown.
        public var label: String
        /// Nil: one of Maintainer's (or the user's).
        public var kind: Kind?
        public var data: String

        public init(label: String, kind: Kind? = nil, data: String) {
            self.label = label
            self.kind = kind
            self.data = data
        }

        public init(_ kind: Kind, data: String) {
            self.init(label: kind.label, kind: kind, data: data)
        }

        private enum CodingKeys: String, CodingKey { case label, kind, data }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            label = try container.decode(String.self, forKey: .label)
            data = try container.decode(String.self, forKey: .data)
            // Saved before samples had a kind: the app's own were known by their English label.
            kind = try container.decodeIfPresent(Kind.self, forKey: .kind)
                ?? (container.contains(.kind) ? nil : [Kind.testRun, .reply, .page].first { $0.englishLabel == label })
        }

        /// Writes `kind` even when nil, so one of Maintainer's that reads like the app's stays Maintainer's.
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(label, forKey: .label)
            try container.encode(kind, forKey: .kind)
            try container.encode(data, forKey: .data)
        }
    }

    /// The sample shown until you pick one: with live data (a command), the real run; otherwise
    /// the reply's own content, or the page it came from; else the first. Nil when there are none.
    public static func preferredSample(in samples: [Sample], live: Bool) -> Int? {
        (live ? samples.firstIndex { $0.kind == .testRun } : nil)
            ?? samples.firstIndex { $0.kind == .reply }
            ?? samples.firstIndex { $0.kind == .page }
            ?? (samples.isEmpty ? nil : 0)
    }

    /// Something Maintainer could not infer, with answers to pick (one suggested).
    public struct Question: Codable, Equatable, Sendable {
        public struct Option: Codable, Equatable, Sendable {
            public var label: String
            /// What picking it sets `key` to; nil: the label is only said to Maintainer.
            public var value: String?

            public init(label: String, value: String? = nil) {
                self.label = label
                self.value = value
            }
        }

        public var id: String
        /// The spec value it decides ("refresh", "reuse", "command", …), if any.
        public var key: String?
        public var text: String
        public var options: [Option]
        public var suggested: Int?

        public init(id: String, key: String? = nil, text: String, options: [Option], suggested: Int? = nil) {
            self.id = id
            self.key = key
            self.text = text
            self.options = options
            self.suggested = suggested
        }
    }

    /// A line of the side conversation with Maintainer.
    public struct Line: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            case user, maintainer, event
        }

        public var kind: Kind
        public var text: String

        public init(kind: Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// The last test run of its command: what it printed, and whether that fits the fields.
    public struct TestRun: Codable, Equatable, Sendable {
        public var command: String
        public var folder: String
        public var output: String?
        public var error: String?
        public var ranAt: Date?
        public var matches: Bool?

        public init(command: String, folder: String, output: String? = nil, error: String? = nil, ranAt: Date? = nil, matches: Bool? = nil) {
            self.command = command
            self.folder = folder
            self.output = output
            self.error = error
            self.ranAt = ranAt
            self.matches = matches
        }
    }

    /// A change to a built component, asked in its panel: the version it makes and how it goes.
    public struct Change: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable {
            /// Maintainer is making `version`.
            case working
            /// Maintainer asked one question first; the answer sends the change again.
            case asking
            /// `version` is in the library.
            case updated
            /// Maintainer's turn ended without it (`error` says why).
            case failed
        }

        public var state: State
        /// The version it makes (v2 after the first build).
        public var version: Int
        /// What the user asked for, in order (empty: a rebuild with the panel's edits).
        public var said: [String]
        public var startedAt: Date
        public var endedAt: Date?
        public var error: String?
        /// Maintainer was busy when it was sent: the turn that ends first is not the answer to it.
        public var waitTurn: Bool

        public init(version: Int, said: [String], startedAt: Date = Date(), waitTurn: Bool = false) {
            state = .working
            self.version = version
            self.said = said
            self.startedAt = startedAt
            self.waitTurn = waitTurn
        }
    }

    public var id: UUID
    /// The reply it is made from.
    public var messageID: UUID?
    /// The result page it is made from, when made from an HTML result card.
    public var page: String?
    public var name: String
    /// What it shows, in a sentence (its about.md's first line).
    public var about: String
    public var fields: [Field]
    /// What gives it its data, run in `folder`; nil: it draws the data a bot writes.
    public var command: String?
    public var folder: String
    public var refresh: PinnedComponent.Refresh
    public var minutes: Int
    /// The bots whose lists it goes on.
    public var bots: [String]
    /// A component in the library that already does much of this, and whether to use it instead.
    public var similar: String?
    public var reuse: Bool
    public var samples: [Sample]
    public var questions: [Question]
    public var conversation: [Line]
    /// Who last set each value ("name", "about", "command", "refresh", "bots", "reuse", …).
    public var origins: [String: Origin]
    public var status: Status
    /// Bumps each time Maintainer updates it.
    public var draft: Int
    /// The bot that suggested it with `<suggest-component>`; nil when the user made it.
    public var suggestedBy: String?
    /// It has been opened (the panel shown) at least once; Maintainer drafts it then.
    public var opened: Bool
    /// Maintainer was asked to draft it.
    public var asked: Bool
    /// The reply already is this library component: only which bots get it is left.
    public var existing: String?
    /// The component drawn in the reply, whose look the preview borrows before it is built.
    public var shownAs: String?
    /// The library component it became (its first version or a reused one), drawn under the reply
    /// from then on, also while a new version is built.
    public var built: String?
    public var testRun: TestRun?
    /// The user's changes Maintainer has not heard yet (said with the next message or Build).
    public var pendingEdits: [String]
    /// What it is for, in the words of whoever asked for it: the bot's `<suggest-component>` text,
    /// or what the user typed. Maintainer's request starts with it.
    public var purpose: String?
    /// The bot that wrote the reply, asked (once the component is built) to draw it under that
    /// reply with `<show>`, filling the data from its own reply; nil: not asked (live data from a
    /// command, or the reply already is the component).
    public var filledBy: String?
    /// What that bot drew: the component's data, shown under the reply.
    public var filled: String?
    /// Why it did not draw it (it answered without the component, or could not answer).
    public var fillError: String?
    /// What a fork of the bot that wrote the reply told Maintainer about it (`ComponentBrief`):
    /// its purpose, the user's message, each field and whether a command can get it.
    public var brief: String?
    /// The version in the library: 1 once first built, one more each change that lands.
    public var version: Int?
    /// The last (or current) change asked for in the panel once it was built.
    public var change: Change?
    /// What the user typed while a build was under way: sent together as the next change.
    public var queued: [String]?
    public var createdAt: Date

    public init(id: UUID = UUID(), messageID: UUID? = nil, name: String, about: String = "", folder: String, bots: [String], createdAt: Date = Date()) {
        self.id = id
        self.messageID = messageID
        page = nil
        self.name = name
        self.about = about
        fields = []
        command = nil
        self.folder = folder
        refresh = .manual
        minutes = PinnedComponent.defaultMinutes
        self.bots = bots
        similar = nil
        reuse = false
        samples = []
        questions = []
        conversation = []
        origins = [:]
        status = .draft
        draft = 1
        suggestedBy = nil
        opened = false
        asked = false
        existing = nil
        shownAs = nil
        built = nil
        testRun = nil
        pendingEdits = []
        self.createdAt = createdAt
    }

    /// The card key its test runs go under (`ComponentCommands`), apart from chat cards and pins.
    public var card: String { "spec/\(id.uuidString)" }

    /// The version a change now makes: the next after the one in the library.
    public var nextVersion: Int { (version ?? 1) + 1 }

    /// The bot that wrote the reply is drawing it now.
    public var filling: Bool { filledBy != nil && filled == nil && fillError == nil }
}

/// Making specs: the app's first draft from a reply, Maintainer's updates, the user's edits.
@MainActor
public enum ComponentSpecs {
    // MARK: The first draft

    /// What the app can tell from a reply alone: the data a component in it was drawn with (its
    /// fields and a sample), the command that gave that card its data (the card's own), a name and
    /// the bot's folder. Whether a library component already does the same is Maintainer's call
    /// (its `similar`), not a match of words. The reply's own content is the
    /// data: a shell command the bot ran while writing it (reading a file, running the tests) is
    /// only a hint for Maintainer (`lastCommand`), never the component's command by itself.
    @MainActor
    public static func draft(from message: ChatMessage, bot: String, folder: URL, library: ComponentLibrary?, page: String? = nil) -> ComponentSpec {
        let names = Set(library?.names ?? [])
        let shown = message.shown.filter { !ComponentLibrary.isBuiltIn($0.name) }
        let existing = page == nil ? shown.first(where: { names.contains($0.name) })?.name : nil
        let first = shown.first
        let command = page == nil ? first?.command : nil
        let ran = command ?? lastCommand(in: message)
        let name: String = if let existing { existing }
            else if let page { slug((page as NSString).lastPathComponent.replacingOccurrences(of: ".html", with: "")) }
            else if let first { slug(first.name) }
            else if let ran { slug(ran) }
            else { slug(message.text) }
        var spec = ComponentSpec(messageID: message.id, name: name.isEmpty ? "component" : name, folder: folder.path, bots: [bot], createdAt: Date())
        spec.existing = existing
        spec.page = page
        spec.command = command
        if let first, first.data != "null" {
            spec.fields = fields(fromJSON: first.data)
            spec.samples = [ComponentSpec.Sample(.reply, data: first.data)]
            spec.shownAs = names.contains(first.name) ? first.name : nil
        } else if let page {
            spec.samples = [ComponentSpec.Sample(.page, data: PagePreview.cardData(jsonString(["path": page])))]
            spec.shownAs = names.contains(PagePreview.component) ? PagePreview.component : nil
        } else {
            let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            spec.samples = [ComponentSpec.Sample(.reply, data: jsonString(["text": text]))]
        }
        return spec
    }

    /// The last shell command a reply's work ran that did not fail.
    static func lastCommand(in message: ChatMessage) -> String? {
        message.steps?.last { $0.tool == "Bash" && !$0.failed && !($0.detail ?? "").isEmpty }?.detail?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A short lower-case English name: the first few ASCII words, joined with "-".
    public static func slug(_ text: String, words limit: Int = 2) -> String {
        let words = text.lowercased()
            .split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }
            .map(String.init)
            .filter { !$0.isEmpty && !($0.first?.isNumber ?? false) }
        return words.prefix(limit).joined(separator: "-")
    }

    /// The fields of a JSON object (or of a list's first object), each with a short type.
    public static func fields(fromJSON json: String) -> [ComponentSpec.Field] {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: .fragmentsAllowed) else { return [] }
        let object: [String: Any]?
        let order: [String]
        switch value {
        case let dictionary as [String: Any]:
            object = dictionary
            order = keyOrder(of: json, among: Array(dictionary.keys))
        case let list as [Any]:
            object = list.first as? [String: Any]
            order = object.map { keyOrder(of: json, among: Array($0.keys)) } ?? []
        default:
            object = nil
            order = []
        }
        guard let object else { return [] }
        return order.map { ComponentSpec.Field(name: $0, type: type(of: object[$0] as Any, in: json)) }
    }

    /// Keys in the order the JSON text has them (a dictionary keeps none).
    private static func keyOrder(of json: String, among keys: [String]) -> [String] {
        JSONKeyOrder.sorted(keys, as: json)
    }

    private static let isoDate = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$"#)

    static func type(of value: Any, in json: String) -> String {
        switch value {
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return "bool" }
            return CFNumberIsFloatType(number) ? "num" : "int"
        case let text as String:
            let range = NSRange(location: 0, length: (text as NSString).length)
            return isoDate.firstMatch(in: text, range: range) != nil ? "time" : "text"
        case let list as [Any]:
            if let first = list.first as? [String: Any] {
                return "[" + keyOrder(of: json, among: Array(first.keys)).joined(separator: ", ") + "]"
            }
            return "[…]"
        case is [String: Any]:
            return "{…}"
        default:
            return "text"
        }
    }

    // MARK: Changing it

    /// The keys a user can edit, and their names in the panel.
    static let labels = ["name": "Name", "about": "About", "fields": "Data fields", "command": "Command", "refresh": "Refresh", "bots": "Bots", "reuse": "Similar", "similar": "Similar"]

    /// Sets one value from text, as the panel's fields send it. Returns whether it changed.
    @discardableResult
    static func set(_ key: String, to text: String, by origin: ComponentSpec.Origin, in spec: inout ComponentSpec) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let before = spec
        switch key {
        case "name":
            let name = ComponentLibrary.safeName(value)
            if !name.isEmpty, spec.existing == nil { spec.name = name }
        case "about":
            spec.about = value
        case "command":
            spec.command = value.isEmpty ? nil : value
        case "refresh":
            if let refresh = PinnedComponent.Refresh(rawValue: value) { spec.refresh = refresh }
        case "minutes":
            if let minutes = Int(value) { spec.minutes = PinnedComponent.clampMinutes(minutes) }
        case "bots":
            var seen = Set<String>()
            spec.bots = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
        case "similar":
            spec.similar = value.isEmpty ? nil : value
        case "reuse":
            spec.reuse = ["true", "yes", "1"].contains(value.lowercased())
        case "fields":
            spec.fields = parseFields(value).map { field in
                var field = field
                field.by = spec.fields.first { $0.name == field.name && $0.type == field.type }?.by ?? origin
                return field
            }
        default:
            return false
        }
        guard spec != before else { return false }
        spec.origins[key == "minutes" ? "refresh" : key] = origin
        if key == "command" { spec.testRun = nil }
        return true
    }

    /// "total: int, failures: [suite, test]" as fields; a name alone is text.
    static func parseFields(_ text: String) -> [ComponentSpec.Field] {
        var fields: [ComponentSpec.Field] = []
        var current = ""
        var depth = 0
        for character in text + "," {
            if character == "[" || character == "{" { depth += 1 }
            if character == "]" || character == "}" { depth -= 1 }
            if character == ",", depth <= 0 {
                let part = current.trimmingCharacters(in: .whitespaces)
                current = ""
                guard !part.isEmpty else { continue }
                let pieces = part.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard let name = pieces.first, !name.isEmpty else { continue }
                fields.append(ComponentSpec.Field(name: name, type: pieces.count > 1 && !pieces[1].isEmpty ? pieces[1] : "text"))
            } else {
                current.append(character)
            }
        }
        return fields
    }

    /// The user changed a value in the panel: marked as theirs, said in the side conversation,
    /// and kept to tell Maintainer with the next message.
    @discardableResult
    public static func edit(_ key: String, to value: String, in spec: inout ComponentSpec) -> Bool {
        guard set(key, to: value, by: .user, in: &spec) else { return false }
        let label = labels[key] ?? key.capitalized
        let shown = key == "reuse" ? (spec.reuse ? "use \(spec.similar ?? "the similar one")" : "make a new one") : value
        spec.conversation.append(.init(kind: .event, text: "You edited \(label) · \(clip(shown, 60))"))
        spec.pendingEdits.removeAll { $0.hasPrefix("\(label): ") }
        spec.pendingEdits.append("\(label): \(shown)")
        return true
    }

    /// Picks an answer to one of Maintainer's questions: it sets the value it decides (as the
    /// user's) and goes to the conversation as the user's words.
    @discardableResult
    public static func answer(_ questionID: String, option index: Int, in spec: inout ComponentSpec, by origin: ComponentSpec.Origin = .user) -> Bool {
        guard let at = spec.questions.firstIndex(where: { $0.id == questionID }),
              spec.questions[at].options.indices.contains(index) else { return false }
        let question = spec.questions.remove(at: at)
        let option = question.options[index]
        if let key = question.key, let value = option.value {
            set(key, to: value, by: origin, in: &spec)
        }
        if origin == .user {
            spec.conversation.append(.init(kind: .user, text: option.label))
        }
        spec.pendingEdits.append("\(question.text) → \(option.label)")
        return true
    }

    /// Open questions take their suggested answer (Build it with questions left).
    static func answerOpenQuestions(in spec: inout ComponentSpec) {
        for question in spec.questions {
            answer(question.id, option: question.suggested ?? 0, in: &spec, by: .maintainer)
        }
        spec.questions = []
    }

    /// Maintainer's `<component-spec>` JSON: the values it sets (only those it names), its
    /// questions (replacing the old ones) and samples. A value it repeats unchanged keeps who set
    /// it. Returns whether anything changed.
    @discardableResult
    public static func update(_ spec: inout ComponentSpec, with json: String) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return false }
        let before = spec
        for key in ["name", "about", "command", "refresh", "similar"] {
            if let text = object[key] as? String { set(key, to: text, by: .maintainer, in: &spec) }
        }
        if let minutes = object["minutes"] as? Int { set("minutes", to: String(minutes), by: .maintainer, in: &spec) }
        if let reuse = object["reuse"] as? Bool { set("reuse", to: reuse ? "true" : "false", by: .maintainer, in: &spec) }
        if let fields = object["fields"] as? [Any] {
            let parsed: [ComponentSpec.Field] = fields.compactMap { item in
                if let entry = item as? [String: Any], let name = entry["name"] as? String, !name.isEmpty {
                    return ComponentSpec.Field(name: name, type: (entry["type"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "text")
                }
                if let text = item as? String { return parseFields(text).first }
                return nil
            }
            let merged = parsed.map { field in
                var field = field
                field.by = spec.fields.first { $0.name == field.name && $0.type == field.type }?.by ?? .maintainer
                return field
            }
            if merged != spec.fields {
                spec.fields = merged
                spec.origins["fields"] = .maintainer
            }
        }
        if let samples = object["samples"] as? [Any] {
            for item in samples {
                guard let entry = item as? [String: Any], let label = entry["label"] as? String, !label.isEmpty else { continue }
                let data: String
                if let text = entry["data"] as? String { data = text }
                else if let value = entry["data"], let encoded = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) { data = String(decoding: encoded, as: UTF8.self) }
                else { continue }
                if let at = spec.samples.firstIndex(where: { $0.label == label }) { spec.samples[at].data = data }
                else { spec.samples.append(.init(label: label, data: data)) }
            }
        }
        if let questions = object["questions"] as? [Any] {
            spec.questions = questions.enumerated().compactMap { index, item in
                guard let entry = item as? [String: Any], let text = entry["text"] as? String, !text.isEmpty else { return nil }
                let options: [ComponentSpec.Question.Option] = (entry["options"] as? [Any] ?? []).compactMap { option in
                    if let label = option as? String { return .init(label: label) }
                    guard let choice = option as? [String: Any], let label = choice["label"] as? String else { return nil }
                    let value = choice["value"].map { value -> String in
                        if let bool = value as? Bool { return bool ? "true" : "false" }
                        return "\(value)"
                    }
                    return .init(label: label, value: value)
                }
                guard !options.isEmpty else { return nil }
                let suggested = (entry["suggested"] as? Int).flatMap { options.indices.contains($0) ? $0 : nil }
                return .init(id: (entry["id"] as? String) ?? "q\(index + 1)", key: entry["key"] as? String, text: text, options: options, suggested: suggested)
            }
        }
        guard spec != before else { return false }
        spec.draft += 1
        return true
    }

    // MARK: Checking a test run

    /// Whether a command's output (as component data) has every field: a JSON object with each
    /// field name, or a list whose first object has them. No fields: any output fits.
    public static func outputMatches(_ output: String, fields: [ComponentSpec.Field]) -> Bool {
        guard !fields.isEmpty else { return true }
        guard let value = try? JSONSerialization.jsonObject(with: Data(output.utf8), options: .fragmentsAllowed) else { return false }
        let object = (value as? [String: Any]) ?? ((value as? [Any])?.first as? [String: Any])
        guard let object else { return false }
        return fields.allSatisfy { object[$0.name] != nil }
    }

    // MARK: What Maintainer is told

    /// The spec as Maintainer reads it.
    static func summary(of spec: ComponentSpec) -> String {
        var lines = ["- name: \(spec.name)"]
        if !spec.about.isEmpty { lines.append("- about: \(spec.about)") }
        lines.append("- data fields: " + (spec.fields.isEmpty ? "(none yet)" : spec.fields.map { "\($0.name): \($0.type)" }.joined(separator: ", ")))
        lines.append("- command: " + (spec.command ?? "(none: a bot writes the data)"))
        lines.append("- folder: \(spec.folder)")
        lines.append("- refresh: \(spec.refresh == .interval ? "every \(spec.minutes) min" : spec.refresh.rawValue)")
        lines.append("- bots: " + spec.bots.joined(separator: ", "))
        if let similar = spec.similar { lines.append("- similar in the library: \(similar)" + (spec.reuse ? " (the user wants to reuse it)" : "")) }
        if let run = spec.testRun, let output = run.output {
            lines.append("- test run output: \(clip(output, 600))" + (run.matches == false ? " (it does not have every field)" : ""))
        }
        return lines.joined(separator: "\n")
    }

    static func tagNote(_ spec: ComponentSpec) -> String {
        "Answer in one or two sentences, then <component-spec id=\"\(spec.id.uuidString)\">JSON</component-spec> with only what you set or change (name, about, fields [{name, type}], command, refresh: shown|interval|manual, minutes, similar, reuse, samples [{label, data}], questions [{id, key, text, options [{label, value}], suggested}]). Build nothing yet: it is a draft, built when the user presses Build it. Never run the command yourself: the user test-runs it from the panel."
    }

    /// How much of a reply Maintainer is sent, and of each result page it links (as text).
    static let replyLimit = 12_000
    static let pageLimit = 12_000

    /// A result page the reply links to, shows, or is made from, as Maintainer reads it.
    public struct ReplyPage: Equatable, Sendable {
        public var path: String
        public var text: String
    }

    /// The result pages (`.html` in an `artifacts` folder) a reply is made from, shows or links to,
    /// each as its words, at most `PagePreview.perMessage`: what the bot organised there is part
    /// of the reply's content.
    public static func pages(of message: ChatMessage, page: String? = nil) -> [ReplyPage] {
        var urls: [URL] = page.map { [URL(filePath: $0)] } ?? []
        urls += message.shown.filter { $0.name == PagePreview.component }.compactMap { PagePreview.page(inCard: $0.data) }
        urls += PagePreview.linkedCards(in: message.text).compactMap { PagePreview.page(inCard: $0) }
        var seen = Set<String>()
        var pages: [ReplyPage] = []
        for url in urls where pages.count < PagePreview.perMessage {
            let file = url.standardizedFileURL
            guard PagePreview.isArtifactPage(file), seen.insert(file.path).inserted,
                  let html = try? String(contentsOf: file, encoding: .utf8) else { continue }
            let text = pageText(String(html.prefix(2_000_000)))
            if !text.isEmpty { pages.append(ReplyPage(path: file.path, text: clip(text, pageLimit))) }
        }
        return pages
    }

    private static func replacing(_ pattern: String, in text: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    /// A page's words: no scripts, styles or tags; list items as "- ", table cells split by " | ".
    static func pageText(_ html: String) -> String {
        var text = replacing(#"<(script|style|head|template|svg)\b.*?</\1\s*>|<!--.*?-->"#, in: html, with: "")
        text = replacing(#"<li\b[^>]*>"#, in: text, with: "\n- ")
        text = replacing(#"</t[dh]\s*>"#, in: text, with: " | ")
        text = replacing(#"<(br|/p|/div|/tr|/h[1-6]|/li|/ul|/ol|/table|/section|/article|/header|/footer|/summary|/details|/pre|/blockquote)\b[^>]*>"#, in: text, with: "\n")
        text = replacing(#"<h([1-6])\b[^>]*>"#, in: text, with: "\n\n")
        text = replacing(#"<[^>]+>"#, in: text, with: "")
        for (entity, character) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: character)
        }
        if let numeric = try? NSRegularExpression(pattern: #"&#(x?)([0-9a-fA-F]+);"#) {
            for match in numeric.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
                guard let whole = Range(match.range, in: text), let hex = Range(match.range(at: 1), in: text), let digits = Range(match.range(at: 2), in: text),
                      let code = UInt32(text[digits], radix: text[hex].isEmpty ? 10 : 16), let scalar = Unicode.Scalar(code) else { continue }
                text.replaceSubrange(whole, with: String(Character(scalar)))
            }
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ") }
        var kept: [String] = []
        for line in lines where !(line.isEmpty && (kept.last?.isEmpty ?? true)) { kept.append(line) }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The reply as Maintainer reads it: its words, then the words of each result page it links.
    static func replyBlock(_ reply: String, pages: [ReplyPage]) -> String {
        var text = "The reply:\n" + clip(reply, replyLimit)
        for page in pages {
            text += "\nThe result page it links, \(page.path), says:\n" + page.text
        }
        return text
    }

    /// What the component is for, said first: the words of whoever asked for it (the bot's
    /// suggestion, or what the user typed), else that the user only pressed the button.
    static func purposeLine(_ spec: ComponentSpec, from bot: String) -> String {
        let words = (spec.purpose ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            return "What it is for: \(bot)'s reply below, shown as a component instead of text (the user pressed \"Make into component\" and said nothing more)."
        }
        return "What it is for, in \(spec.suggestedBy.map { "\($0)'s" } ?? "the user's") words: \(words)"
    }

    /// Where its data comes from: the reply's own content, which the bot that wrote it draws once
    /// the component is built; a command only for live data.
    static func dataNote(_ spec: ComponentSpec, ran: String?, from bot: String) -> String {
        var text = "Its data is the reply's own content: what \(bot) wrote and organised above (and on the result page it links), in its words and language, drawn as a component instead of text or a web page."
        if let command = spec.command {
            text += " The component in the reply got its data by running `\(command)` in the bot's folder, so it is live data: keep that as its Command (about.md gets the line \"Command: \(command)\" so the app fills it by running that in the bot's folder, only once the user allows it on the card)."
        } else {
            text += " \(bot) draws it under the reply with that data once it is built, so about.md says exactly what JSON a bot gives it with <show name=\"…\">JSON</show> (every field, lists of any length)."
            text += " Give it a Command only when the user clearly wants live data that changes (test results, git status, a queue) rather than what \(bot) wrote; a summary, table or write-up needs none, and then the command stays empty."
            if let ran { text += " (\(bot) ran `\(ran)` while writing the reply: that is how it read its sources, not the component's data, unless the data is clearly live.)" }
        }
        return text
    }

    /// The two groups of data fields about.md lists, and the suggested Board command: the
    /// component is still filled by a bot in the chat; the Board command is only made its Command
    /// once the user pins it to the Board (`Workspace.makeLive`).
    static func fieldGroups(live: Bool) -> String {
        var text = "In about.md list the data fields in two groups: \"\(ComponentFieldGroup.fromCommand.label)\" (fields a CLI command can get, run in the bot's folder) and \"\(ComponentFieldGroup.botOnly.label)\" (what only a bot can write: explanations, advice, a next step; there only when a bot fills it). The template must draw well when every optional field is missing."
        if !live {
            text += " When there are From command fields, add a line \"Board command: <command>\" to about.md suggesting how to get them (not a \"Command:\" line): it is only a suggestion, used when the user pins the component to the Board, and the component is still filled by a bot in the chat with <show>."
        }
        return text
    }

    /// The user's own message that led to the reply, as Maintainer reads it.
    static func askedBlock(_ asked: String?) -> String? {
        guard let asked = asked?.trimmingCharacters(in: .whitespacesAndNewlines), !asked.isEmpty else { return nil }
        return "The user's own message that led to the reply (verbatim):\n" + clip(asked, 4_000)
    }

    /// The first ask: fill in what can be inferred, ask only what cannot.
    static func draftRequest(_ spec: ComponentSpec, reply: String, pages: [ReplyPage] = [], ran: String? = nil, from bot: String) -> String {
        """
        \(ComponentAction.shape.header(spec.id.uuidString)) \(purposeLine(spec, from: bot))
        The user wants to make \(bot)'s reply into a component and is shaping it in a side panel; the reply is the context. \(replyBlock(reply, pages: pages))
        The app's first draft:
        \(summary(of: spec))
        \(dataNote(spec, ran: ran, from: bot))
        Fill in what you can infer (from the reply and the library), and ask only what you cannot, at most 3 questions, each with 2 or 3 short answers and the one you suggest. If a component in the library already does this, say so in "similar". Add a sample or two (say "Failing run", "Empty") so the preview shows other cases.
        \(tagNote(spec))
        """
    }

    /// "Make into component" (or a suggestion chip) pressed: Maintainer infers the whole spec and
    /// builds the first version now, asking nothing; it may reuse a library component instead.
    /// It starts with what the component is for; the whole reply and the words of each result
    /// page it links follow as context. Maintainer builds only the component (template.html, and
    /// about.md with its data format), no data sample: once it is in the library the app asks the
    /// bot that wrote the reply to draw it there with that reply's data (`fillRequest`).
    static func firstBuildRequest(_ spec: ComponentSpec, reply: String, pages: [ReplyPage] = [], ran: String? = nil, asked: String? = nil, brief: String? = nil, from bot: String) -> String {
        let live = spec.command != nil
        var context = ""
        if let asked = askedBlock(asked) { context += asked + "\n" }
        if let brief = brief?.trimmingCharacters(in: .whitespacesAndNewlines), !brief.isEmpty {
            context += "\(bot)'s brief for you (written by a copy of the session that wrote the reply, so it knows what it did and which commands it ran):\n" + brief + "\n"
        }
        var text = """
        \(ComponentAction.buildFirst.header(spec.id.uuidString)) Build the first version now. \(purposeLine(spec, from: bot))
        The user wants it built right away from \(bot)'s reply, given here as context. \(replyBlock(reply, pages: pages))
        \(context)The app's first draft:
        \(summary(of: spec))
        \(dataNote(spec, ran: ran, from: bot))
        Infer the rest from the reply, the brief and the library, and ask nothing: wherever you are unsure, use your best guess (the answer you would have suggested). If a component in the library already does this, reuse it: build nothing and set "similar" to it and "reuse" to true. Otherwise have the component editor write template.html and about.md under a name not already in the library. \(fieldGroups(live: live))
        """
        text += " Never run the command yourself. Once it is in the library the app adds it to " + spec.bots.joined(separator: ", ")
        text += live ? " and shows it under the reply; do not add it to lists yourself." : ", then asks \(bot), who wrote the reply, to draw it under the reply with all of that reply's data, following about.md; do not add it to lists yourself."
        text += "\nAnswer in one or two sentences, then <component-spec id=\"\(spec.id.uuidString)\">JSON</component-spec> with what you used: name (the component's name as built), about, fields [{name, type}], command (only for live data), refresh: shown|interval|manual, minutes, similar, reuse. Build only the component and send no samples: the data under the reply comes from \(live ? "its command" : bot). No questions."
        return text
    }

    /// What the user said in the side panel, with their edits since.
    static func sayRequest(_ spec: ComponentSpec, text: String) -> String {
        var said = ComponentAction.shape.header(spec.id.uuidString) + " "
        said += text.isEmpty ? "The user changed the spec." : "The user says: \(text)"
        if !spec.pendingEdits.isEmpty { said += "\nTheir edits: " + spec.pendingEdits.joined(separator: "; ") }
        said += "\nThe spec now:\n\(summary(of: spec))\n\(tagNote(spec))"
        return said
    }

    /// What the user typed in a built component's panel ("Ask for changes…"): a change request,
    /// built as the next version right away. Maintainer neither waits for a Build press nor asks
    /// for one; only a request that could mean two different things gets one question first.
    static func changeRequest(_ spec: ComponentSpec, said: [String], version: Int) -> String {
        let id = spec.id.uuidString
        let name = spec.built ?? spec.name
        var text = ComponentAction.change.header(id) + " Change it now: build v\(version) of the component \"\(name)\" with this change, right away."
        let words = said.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if words.count == 1 {
            text += "\nThe user asks: \(words[0])"
        } else if words.count > 1 {
            text += "\nThe user asks (in order, all for this version):\n" + words.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        } else {
            text += "\nThe user asks for a new version as the spec now says."
        }
        if !spec.pendingEdits.isEmpty { text += "\nTheir edits in the panel: " + spec.pendingEdits.joined(separator: "; ") }
        text += "\nThe spec now:\n\(summary(of: spec))"
        text += "\nThis is a change request, not a discussion. Do not wait for a Build press and do not ask the user to press anything: have the component editor change template.html and about.md of \(name) now (the same component and name), keeping its data format unless the change needs other fields. "
        text += fieldGroups(live: spec.command != nil)
        text += " Only if the request is genuinely ambiguous (two readings that would build different things), do not build; ask exactly one question in \"questions\" with 2 or 3 short answers and the one you suggest; the user's answer comes back as the next change request."
        text += " Never run the command yourself. The app sees the new version land in the library and updates it under the reply and on " + spec.bots.joined(separator: ", ") + "; do not add it to lists yourself."
        text += "\nAnswer in one or two sentences, then <component-spec id=\"\(id)\">JSON</component-spec> with only what you changed (name, about, fields [{name, type}], command, refresh: shown|interval|manual, minutes), or with the one question."
        return text
    }

    /// Build it.
    static func buildRequest(_ spec: ComponentSpec) -> String {
        var text = ComponentAction.build.header(spec.id.uuidString) + " Build it: make the component \"\(spec.name)\" now, as the spec says.\n\(summary(of: spec))"
        if !spec.pendingEdits.isEmpty { text += "\nThe user's last edits: " + spec.pendingEdits.joined(separator: "; ") }
        text += "\nHave the component editor write template.html and about.md"
        if let command = spec.command {
            text += "; about.md gets the line \"Command: \(command)\" so the app fills it by running that in the bot's folder (only once the user allows it)"
        } else {
            text += "; about.md says what JSON a bot gives it with <show>: once it is built the app asks the bot that wrote the reply to draw it there with that reply's data"
        }
        text += ". The data fields above are what the template reads. " + fieldGroups(live: spec.command != nil)
        text += " Once it is in the library the app adds it to " + spec.bots.joined(separator: ", ") + "; do not add it to lists yourself."
        return text
    }

    /// The user pinned a bot-filled component to the Board: Maintainer gives it a Command from
    /// its suggested Board command, so the same component refreshes there.
    static func boardCommandRequest(component name: String, suggested: String, folder: String, bot: String, brief: String? = nil) -> String {
        var text = ComponentAction.liveOnBoard.header(name) + " Make it live on the Board: the user pinned \(name) to \(bot)'s Board. A bot fills it today; its about.md suggests \"Board command: \(suggested)\" for its From command fields."
        text += " Have the component editor add a \"Command: …\" line to about.md: a command (or a small script in the component's folder, run by its full path) that prints the same JSON the template reads, with the \(ComponentFieldGroup.fromCommand.label) fields (the \(ComponentFieldGroup.botOnly.label) ones left out: the template already draws without them). It runs in \(folder)."
        text += " Keep the Board command line and the data format as they are: bots still fill it in chats with <show>, and their data wins there. Add a \"Refresh: every …\" line only if the data changes within seconds. It stays the same component (no separate Board version)."
        text += " Never run the command yourself: the user allows it on the pinned card. Once the Command is in the library the app switches the pin to it."
        if let brief, !brief.isEmpty { text += "\nThe brief it was built from:\n" + clip(brief, 4_000) }
        return text
    }

    // MARK: Filled by the bot that wrote the reply

    /// The quiet app message to the bot that wrote the reply, once the component is built: draw
    /// it for that reply with `<show>`, the reply's content in full, as its usage says. Its answer
    /// is not shown as a message: the `<show>` becomes the reply's component.
    static func fillRequest(_ spec: ComponentSpec, component name: String, reply: ChatMessage?, pages: [String] = [], usage: String) -> String {
        let when = reply.map { " from " + $0.date.formatted(date: .omitted, time: .shortened) } ?? ""
        let quote = reply.map { " (\"\(Bot.preview(of: $0))\")" } ?? ""
        let purpose = (spec.purpose ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var text = "(App: Draw the component \"\(name)\" for your reply\(when)\(quote): the user made that reply into this component"
        text += purpose.isEmpty ? "." : ", for this: \(purpose)."
        text += " Answer with only <show name=\"\(name)\">JSON</show> holding that reply's content in full (every item it has, in your words and language), in the data format its usage below gives. No words before or after it: the app shows it under that reply, not as a new message. If the reply's content does not fit this component, answer in one sentence why, without the tag."
        if let reply {
            text += "\nYour reply was:\n" + clip(reply.text, replyLimit)
        }
        for page in pages { text += "\nIt links the result page \(page); what is there is part of its content." }
        if !usage.isEmpty { text += "\nUsage of \(name):\n" + usage }
        return text + ")"
    }

    /// The bot's answer to `fillRequest`: the data of its `<show>` of the component (the first
    /// one it drew, if it named another), else why not.
    static func filledData(from answer: String, component name: String) -> Result<String, FillProblem> {
        let parsed = ReplyParser.parseAll(answer)
        let shown = parsed.displays.first { $0.name == name } ?? parsed.displays.first
        if let data = shown?.data.trimmingCharacters(in: .whitespacesAndNewlines), !data.isEmpty, data != "null" {
            return .success(data)
        }
        let said = parsed.body.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return .failure(FillProblem(text: said.isEmpty ? "it answered without the component" : clip(said, 200)))
    }

    struct FillProblem: Error, Equatable {
        var text: String
    }

    // MARK: Helpers

    static func jsonString(_ object: [String: String]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static func clip(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }
}

/// Keys of a JSON object in the order its text has them, which a decoded dictionary loses.
enum JSONKeyOrder {
    static func sorted(_ keys: [String], as json: String) -> [String] {
        var places: [String: Int] = [:]
        for key in keys {
            let quoted = "\"" + key + "\""
            places[key] = json.range(of: quoted).map { json.distance(from: json.startIndex, to: $0.lowerBound) } ?? Int.max
        }
        return keys.sorted { a, b in
            let x = places[a] ?? Int.max, y = places[b] ?? Int.max
            return x != y ? x < y : a < b
        }
    }
}

/// What the app asks Maintainer to do with a component, named by an id in the message's header
/// (`(Component spec <id>; action: change)`): Maintainer's instructions dispatch on these ids,
/// built from here too, never on the sentence that follows.
public enum ComponentAction: String, CaseIterable, Sendable {
    /// One press on a reply: infer the whole spec and build the first version now.
    case buildFirst = "build-first"
    /// The user shaping a draft in its panel: fill in, ask, build nothing yet.
    case shape
    /// The user pressed Build on a draft.
    case build
    /// A change to a built component, typed in its panel: build the new version now.
    case change
    /// A bot-filled component pinned to a Board: give it its Command.
    case liveOnBoard = "live-on-board"

    /// The header that starts the message, for a spec's id (or, for `liveOnBoard`, the
    /// component's name).
    public func header(_ subject: String) -> String {
        self == .liveOnBoard ? "(Component \(subject); action: \(rawValue))" : "(Component spec \(subject); action: \(rawValue))"
    }
}

/// The two groups about.md lists a component's data fields in. Every prompt that asks for them
/// names them from here, so the brief, the request and the editor's instructions agree.
public enum ComponentFieldGroup: CaseIterable, Sendable {
    /// Fields a CLI command can get.
    case fromCommand
    /// What only a bot can write (explanations, advice); there only when a bot fills it.
    case botOnly

    public var label: String {
        switch self {
        case .fromCommand: "From command"
        case .botOnly: "Optional (bot only)"
        }
    }
}
