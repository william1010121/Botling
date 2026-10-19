import Foundation

/// Asks a bot can make by putting a tag in its reply. ClaudeCodeBot acts on them and strips them from
/// what the user sees.
public enum BotRequest: Equatable, Sendable {
    /// `<team name="research">task</team>`: pull up a temporary team.
    case team(name: String, task: String)
    /// `<component name="choices">request</component>`: ask the component team for a change.
    case component(name: String, request: String)
    /// `<plugin>request</plugin>`: ask Maintainer for a change to ClaudeCodeBot itself.
    case plugin(request: String)
    /// `<need-folder>/path</need-folder>`: Maintainer asks to read a folder outside the library.
    case folder(path: String)
    /// `<install>source</install>`: install a plugin from outside (ClaudeCodeBot asks the user first).
    case install(source: String)
}

/// Splits a bot's reply into the text to show, the buttons to draw, and the requests to act on.
/// A bot asks for a decision by ending its reply with:
///
///     <choices>
///     * Fill in with a placeholder image | Done today
///     - Leave it blank for now | Decide later
///     </choices>
///
/// `*` marks the one it recommends; the part after `|` is what picking it costs.
public enum ReplyParser {
    public struct Parsed: Equatable, Sendable {
        public var body: String
        public var choices: [Choice]?
        public var requests: [BotRequest]
        /// `<show name="x">{json}</show>`: draw component x with that data.
        public var display: ComponentInstance?
    }

    private static let choicesBlock = try! NSRegularExpression(pattern: #"<choices>\s*(.*?)\s*</choices>"#, options: .dotMatchesLineSeparators)
    private static let requestTag = try! NSRegularExpression(
        pattern: #"<(team|component)\s+name\s*=\s*"([^"]+)"\s*>\s*(.*?)\s*</\1>"#,
        options: .dotMatchesLineSeparators
    )

    public static func parse(_ reply: String) -> (body: String, choices: [Choice]?) {
        let parsed = parseAll(reply)
        return (parsed.body, parsed.choices)
    }

    private static let pluginTag = try! NSRegularExpression(pattern: #"<plugin>\s*(.*?)\s*</plugin>"#, options: .dotMatchesLineSeparators)
    private static let folderTag = try! NSRegularExpression(pattern: #"<need-folder>\s*(.*?)\s*</need-folder>"#, options: .dotMatchesLineSeparators)
    private static let installTag = try! NSRegularExpression(pattern: #"<install>\s*(.*?)\s*</install>"#, options: .dotMatchesLineSeparators)

    private static let showTag = try! NSRegularExpression(
        pattern: #"<show\s+name\s*=\s*"([^"]+)"\s*>\s*(.*?)\s*</show>"#,
        options: .dotMatchesLineSeparators
    )

    public static func parseAll(_ reply: String) -> Parsed {
        var text = reply
        var requests: [BotRequest] = []
        var display: ComponentInstance?
        if let match = showTag.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) {
            let ns = text as NSString
            let json = ns.substring(with: match.range(at: 2))
            if (try? JSONSerialization.jsonObject(with: Data(json.utf8))) != nil {
                display = ComponentInstance(name: ns.substring(with: match.range(at: 1)), data: json)
            }
            text = ns.replacingCharacters(in: match.range, with: "")
        }
        for match in requestTag.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let ns = text as NSString
            let kind = ns.substring(with: match.range(at: 1))
            let name = ns.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespaces)
            let content = ns.substring(with: match.range(at: 3))
            requests.insert(kind == "team" ? .team(name: name, task: content) : .component(name: name, request: content), at: 0)
            text = ns.replacingCharacters(in: match.range, with: "")
        }

        for match in pluginTag.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let ns = text as NSString
            requests.append(.plugin(request: ns.substring(with: match.range(at: 1))))
            text = ns.replacingCharacters(in: match.range, with: "")
        }

        for match in installTag.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let ns = text as NSString
            requests.append(.install(source: ns.substring(with: match.range(at: 1))))
            text = ns.replacingCharacters(in: match.range, with: "")
        }
        for match in folderTag.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let ns = text as NSString
            requests.append(.folder(path: ns.substring(with: match.range(at: 1))))
            text = ns.replacingCharacters(in: match.range, with: "")
        }

        var choices: [Choice]?
        let ns = text as NSString
        if let match = choicesBlock.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) {
            let parsedChoices = ns.substring(with: match.range(at: 1))
                .split(separator: "\n")
                .compactMap(choice(from:))
            choices = parsedChoices.isEmpty ? nil : parsedChoices
            text = ns.replacingCharacters(in: match.range, with: "")
        }
        return Parsed(body: text.trimmingCharacters(in: .whitespacesAndNewlines), choices: choices, requests: requests, display: display)
    }

    private static func choice(from line: Substring) -> Choice? {
        var text = line.trimmingCharacters(in: .whitespaces)
        var recommended = false
        if text.hasPrefix("*") || text.hasPrefix("★") {
            recommended = true
            text.removeFirst()
        } else if text.hasPrefix("-") || text.hasPrefix("•") {
            text.removeFirst()
        }
        let parts = text.split(separator: "|", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let label = parts.first, !label.isEmpty else { return nil }
        let detail = parts.count > 1 && !parts[1].isEmpty ? parts[1] : nil
        return Choice(label: label, detail: detail, recommended: recommended)
    }
}
