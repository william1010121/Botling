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
    /// `<new-bot name="Morning news">job</new-bot>`: a bot of its own, added to the left column.
    case newBot(name: String, job: String)
    /// `<new-project folder="/path">first task</new-project>`: make a folder a project with its
    /// own manager (ClaudeCodeBot asks the user first), then hand it the task, if any.
    case newProject(folder: String, task: String)
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
        pattern: #"<(team|component|new-bot)\s+name\s*=\s*"([^"]+)"\s*>\s*(.*?)\s*</\1>"#,
        options: .dotMatchesLineSeparators
    )

    public static func parse(_ reply: String) -> (body: String, choices: [Choice]?) {
        let parsed = parseAll(reply)
        return (parsed.body, parsed.choices)
    }

    private static let pluginTag = try! NSRegularExpression(pattern: #"<plugin>\s*(.*?)\s*</plugin>"#, options: .dotMatchesLineSeparators)
    private static let folderTag = try! NSRegularExpression(pattern: #"<need-folder>\s*(.*?)\s*</need-folder>"#, options: .dotMatchesLineSeparators)
    private static let installTag = try! NSRegularExpression(pattern: #"<install>\s*(.*?)\s*</install>"#, options: .dotMatchesLineSeparators)
    private static let projectTag = try! NSRegularExpression(
        pattern: #"<new-project\s+folder\s*=\s*"([^"]+)"\s*(?:/>|>\s*(.*?)\s*</new-project>)"#,
        options: .dotMatchesLineSeparators
    )

    private static let showTag = try! NSRegularExpression(
        pattern: #"<show\s+name\s*=\s*"([^"]+)"\s*>\s*(.*?)\s*</show>"#,
        options: .dotMatchesLineSeparators
    )

    /// Code in a reply (```fenced``` or `inline`): tags in it are examples, not requests.
    private static let codeRegion = try! NSRegularExpression(pattern: #"(?s)(`{3,}|~{3,}).*?(?:\1|\z)|`[^`\n]+`"#)

    /// The reply with every code character replaced by a space, same length, so tags are looked
    /// for only outside code while ranges still match the reply itself.
    private static func masked(_ text: String) -> NSMutableString {
        let mask = NSMutableString(string: text)
        for match in codeRegion.matches(in: text, range: NSRange(location: 0, length: mask.length)).reversed() {
            mask.replaceCharacters(in: match.range, with: String(repeating: " ", count: match.range.length))
        }
        return mask
    }

    public static func parseAll(_ reply: String) -> Parsed {
        let text = NSMutableString(string: reply)
        let mask = masked(reply)
        var requests: [BotRequest] = []
        var display: ComponentInstance?

        /// Matches of `pattern` outside code, last first; each is taken out of the reply.
        func take(_ pattern: NSRegularExpression, first only: Bool = false, _ found: ([String]) -> Void) {
            var matches = pattern.matches(in: mask as String, range: NSRange(location: 0, length: mask.length))
            if only { matches = Array(matches.prefix(1)) }
            for match in matches.reversed() {
                // A group that took no part in the match (an optional one) reads as empty.
                found((1..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : text.substring(with: match.range(at: $0)) })
                text.replaceCharacters(in: match.range, with: "")
                mask.replaceCharacters(in: match.range, with: "")
            }
        }

        take(showTag, first: true) { groups in
            if (try? JSONSerialization.jsonObject(with: Data(groups[1].utf8))) != nil {
                display = ComponentInstance(name: groups[0], data: groups[1])
            }
        }
        var tagged: [BotRequest] = []
        take(requestTag) { groups in
            let name = groups[1].trimmingCharacters(in: .whitespaces)
            let content = groups[2]
            let request: BotRequest = switch groups[0] {
            case "team": .team(name: name, task: content)
            case "new-bot": .newBot(name: name, job: content)
            default: .component(name: name, request: content)
            }
            tagged.insert(request, at: 0)
        }
        requests += tagged
        take(pluginTag) { requests.append(.plugin(request: $0[0])) }
        take(installTag) { requests.append(.install(source: $0[0])) }
        var projects: [BotRequest] = []
        take(projectTag) { projects.insert(.newProject(folder: $0[0].trimmingCharacters(in: .whitespaces), task: $0[1]), at: 0) }
        requests += projects
        take(folderTag) { requests.append(.folder(path: $0[0])) }

        var choices: [Choice]?
        take(choicesBlock, first: true) { groups in
            let parsed = groups[0].split(separator: "\n").compactMap(choice(from:))
            choices = parsed.isEmpty ? nil : parsed
        }
        return Parsed(body: (text as String).trimmingCharacters(in: .whitespacesAndNewlines), choices: choices, requests: requests, display: display)
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
