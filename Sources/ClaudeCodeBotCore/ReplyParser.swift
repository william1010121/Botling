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
    /// `<install-build path="/…/ClaudeCodeBot.app">what changed</install-build>`: developer mode
    /// only. Install a new build of ClaudeCodeBot and restart (the user confirms first).
    case installBuild(path: String, note: String)
    /// `<app-screenshot/>`: developer mode only. A picture of the app's window, sent back.
    case appScreenshot
    /// `<open-question from="project name"/>`: main bot only. Shows, in the main bot's chat, the
    /// card a project or bot is already asking in its own chat (the same decision, not a new card).
    case openQuestion(from: String)
    /// `<codex-review agent="fix-login" folder="/…/worktree" base="main">what it does</codex-review>`:
    /// have Codex review a subagent's change; what it finds goes back to that subagent.
    case codexReview(agent: String, folder: String, base: String?, note: String)
    /// `<give-component bot="garden">weather</give-component>`: Maintainer only. Puts a library
    /// component on that bot's own list (the app refuses past the per-bot limit).
    case giveComponent(bot: String, name: String)
    /// `<take-component bot="garden">weather</take-component>`: Maintainer only. Takes it off that
    /// bot's list; the library copy stays.
    case takeComponent(bot: String, name: String)
    /// `<suggest-component name="test-summary">short draft</suggest-component>`: any bot. Offers to
    /// make what it just showed into a component; the app only adds a quiet chip under the reply,
    /// and nothing opens, runs or is built until the user presses it.
    case suggestComponent(name: String, draft: String)
    /// `<component-spec id="…">JSON</component-spec>`: Maintainer only. Fills in or changes a
    /// component spec the user is shaping in the right panel (see `ComponentSpecs.update`).
    case componentSpec(id: String, json: String)
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
        /// Each `<show name="x">{json}</show>`: draw component x with that data, in the order they
        /// came, each at the place in `body` it was written (`at`).
        public var displays: [ComponentInstance]
    }

    private static let choicesBlock = try! NSRegularExpression(pattern: #"<choices>\s*(.*?)\s*</choices>"#, options: .dotMatchesLineSeparators)
    private static let requestTag = try! NSRegularExpression(
        pattern: #"<(team|component|new-bot)\s+name\s*=\s*"([^"]+)"\s*>\s*(.*?)\s*</\1>"#,
        options: .dotMatchesLineSeparators
    )

    /// The reply carries `<no-reply/>` (outside code): it has nothing for the user. Only a turn
    /// claude started itself (background work told it something) is left unshown for it; in
    /// any other turn the tag is just taken out.
    public static func saysNoReply(_ reply: String) -> Bool {
        let mask = masked(reply)
        return noReplyTag.firstMatch(in: mask as String, range: NSRange(location: 0, length: mask.length)) != nil
    }

    public static func parse(_ reply: String) -> (body: String, choices: [Choice]?) {
        let parsed = parseAll(reply)
        return (parsed.body, parsed.choices)
    }

    private static let pluginTag = try! NSRegularExpression(pattern: #"<plugin>\s*(.*?)\s*</plugin>"#, options: .dotMatchesLineSeparators)
    private static let folderTag = try! NSRegularExpression(pattern: #"<need-folder>\s*(.*?)\s*</need-folder>"#, options: .dotMatchesLineSeparators)
    private static let installTag = try! NSRegularExpression(pattern: #"<install>\s*(.*?)\s*</install>"#, options: .dotMatchesLineSeparators)
    private static let buildTag = try! NSRegularExpression(
        pattern: #"<install-build\s+path\s*=\s*"([^"]+)"\s*(?:/>|>\s*(.*?)\s*</install-build>)"#,
        options: .dotMatchesLineSeparators
    )
    private static let codexTag = try! NSRegularExpression(
        pattern: #"<codex-review((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:/>|>\s*(.*?)\s*</codex-review>)"#,
        options: .dotMatchesLineSeparators
    )
    private static let listTag = try! NSRegularExpression(
        pattern: #"<(give|take)-component\s+bot\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>\s*(.*?)\s*</\1-component>"#,
        options: .dotMatchesLineSeparators
    )
    private static let suggestTag = try! NSRegularExpression(
        pattern: #"<suggest-component\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:/>|>\s*(.*?)\s*</suggest-component>)"#,
        options: .dotMatchesLineSeparators
    )
    private static let specTag = try! NSRegularExpression(
        pattern: #"<component-spec\s+id\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>\s*(.*?)\s*</component-spec>"#,
        options: .dotMatchesLineSeparators
    )
    private static let screenshotTag = try! NSRegularExpression(pattern: #"<app-screenshot\s*/?>(?:\s*</app-screenshot>)?"#)
    /// `<no-reply/>`: the turn claude started itself has nothing for the user.
    private static let noReplyTag = try! NSRegularExpression(pattern: #"<no-reply\s*/>|<no-reply>\s*</no-reply>"#)
    private static let openQuestionTag = try! NSRegularExpression(
        pattern: #"<open-question\s+from\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:/>|>\s*</open-question>)"#
    )
    private static let projectTag = try! NSRegularExpression(
        pattern: #"<new-project\s+folder\s*=\s*"([^"]+)"\s*(?:/>|>\s*(.*?)\s*</new-project>)"#,
        options: .dotMatchesLineSeparators
    )

    /// `<show name="x">JSON</show>`, or with `command="…"` (JSON optional, `<show … />` too).
    /// Attributes may be in either order and quoted with " or '.
    private static let showTag = try! NSRegularExpression(
        pattern: #"<show((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*(?:/>|>\s*(.*?)\s*</show>)"#,
        options: .dotMatchesLineSeparators
    )
    private static let attribute = try! NSRegularExpression(pattern: #"([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)

    /// A tag's attributes, names lowercased, with &quot; &#39; &lt; &gt; &amp; read back.
    static func attributes(_ text: String) -> [String: String] {
        var found: [String: String] = [:]
        let ns = text as NSString
        for match in attribute.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let valueRange = match.range(at: 2).location != NSNotFound ? match.range(at: 2) : match.range(at: 3)
            let value = ns.substring(with: valueRange)
                .replacingOccurrences(of: "&quot;", with: "\"")
                .replacingOccurrences(of: "&#39;", with: "'")
                .replacingOccurrences(of: "&lt;", with: "<")
                .replacingOccurrences(of: "&gt;", with: ">")
                .replacingOccurrences(of: "&amp;", with: "&")
            found[ns.substring(with: match.range(at: 1)).lowercased()] = value
        }
        return found
    }

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
        var displays: [ComponentInstance] = []

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

        // Every <show> with good JSON is kept, its place marked with a character of its own
        // (from the private use area) until the rest is taken out, so it can be found again.
        for match in showTag.matches(in: mask as String, range: NSRange(location: 0, length: mask.length)).reversed() {
            let attributes = attributes(text.substring(with: match.range(at: 1)))
            let body = match.range(at: 2).location == NSNotFound ? "" : text.substring(with: match.range(at: 2))
            let name = attributes["name"] ?? ""
            let command = attributes["command"].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
            var marker = ""
            // A command's data comes from its output, so nothing need be written inside: the
            // command is the tag's own, or the one the component's about.md declares.
            let data = body.isEmpty ? "null" : body
            if !name.isEmpty, body.isEmpty || (try? JSONSerialization.jsonObject(with: Data(data.utf8))) != nil {
                // id="tests" names the card so a later <show> updates it; refresh="2s" reruns its command.
                let id = attributes["id"].map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
                let refresh = attributes["refresh"].flatMap(ComponentRefresh.seconds(from:))
                displays.insert(ComponentInstance(name: name, data: data, command: command, id: id, refresh: refresh), at: 0)
                marker = "\u{E000}"
            }
            text.replaceCharacters(in: match.range, with: marker)
            mask.replaceCharacters(in: match.range, with: marker)
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
        take(buildTag, first: true) { requests.append(.installBuild(path: $0[0].trimmingCharacters(in: .whitespaces), note: $0[1])) }
        take(noReplyTag) { _ in }
        var screenshot = false
        take(screenshotTag) { _ in screenshot = true }
        if screenshot { requests.append(.appScreenshot) }
        take(folderTag) { requests.append(.folder(path: $0[0])) }
        var openQuestions: [BotRequest] = []
        take(openQuestionTag) { groups in
            let name = (groups[0].isEmpty ? groups[1] : groups[0]).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { openQuestions.insert(.openQuestion(from: name), at: 0) }
        }
        requests += openQuestions
        var reviews: [BotRequest] = []
        take(codexTag) { groups in
            let attributes = attributes(groups[0])
            let folder = (attributes["folder"] ?? "").trimmingCharacters(in: .whitespaces)
            guard !folder.isEmpty else { return }
            let base = attributes["base"].map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
            reviews.insert(.codexReview(agent: (attributes["agent"] ?? "").trimmingCharacters(in: .whitespaces), folder: folder, base: base, note: groups[1]), at: 0)
        }
        requests += reviews
        var lists: [BotRequest] = []
        take(listTag) { groups in
            let bot = (groups[1].isEmpty ? groups[2] : groups[1]).trimmingCharacters(in: .whitespaces)
            let name = groups[3].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !bot.isEmpty, !name.isEmpty else { return }
            lists.insert(groups[0] == "give" ? .giveComponent(bot: bot, name: name) : .takeComponent(bot: bot, name: name), at: 0)
        }
        requests += lists
        var suggestions: [BotRequest] = []
        take(suggestTag) { groups in
            let name = (groups[0].isEmpty ? groups[1] : groups[0]).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { suggestions.insert(.suggestComponent(name: name, draft: groups[2]), at: 0) }
        }
        requests += suggestions
        var specs: [BotRequest] = []
        take(specTag) { groups in
            let id = (groups[0].isEmpty ? groups[1] : groups[0]).trimmingCharacters(in: .whitespaces)
            if !id.isEmpty { specs.insert(.componentSpec(id: id, json: groups[2]), at: 0) }
        }
        requests += specs

        // Several blocks (an earlier part of the turn asked, then a later one): the last one
        // is the question; every block comes out of the text.
        var choices: [Choice]?
        take(choicesBlock) { groups in
            guard choices == nil else { return }
            let parsed = groups[0].split(separator: "\n").compactMap(choice(from:))
            choices = parsed.isEmpty ? nil : parsed
        }
        let (body, places) = placing(text as String, count: displays.count)
        for index in displays.indices { displays[index].at = places[index] }
        return Parsed(body: body, choices: choices, requests: requests, displays: displays)
    }

    /// Every tag the app acts on, in the order `parseAll` knows them.
    private static var replyTags: [NSRegularExpression] {
        [showTag, requestTag, pluginTag, installTag, projectTag, buildTag, screenshotTag, folderTag,
         openQuestionTag, codexTag, listTag, suggestTag, specTag, choicesBlock]
    }

    /// Takes the app's tags (`<choices>`, `<show>`, `<plugin>`, …) out of one earlier part of a
    /// turn: claude's `result` holds only the words after the last tool call, so a tag written
    /// before a tool call would be lost. Returns the words left and the tags, as written, in
    /// order; they go in front of the reply (`lifting(_:into:)`). Tags in code stay.
    public static func liftTags(_ segment: String) -> (rest: String, tags: [String]) {
        let mask = masked(segment)
        let whole = NSRange(location: 0, length: mask.length)
        let ranges = replyTags.flatMap { $0.matches(in: mask as String, range: whole).map(\.range) }
            .sorted { $0.location < $1.location }
        var kept: [NSRange] = []
        for range in ranges where kept.last.map({ NSMaxRange($0) <= range.location }) ?? true {
            kept.append(range)
        }
        guard !kept.isEmpty else { return (segment, []) }
        let text = NSMutableString(string: segment)
        let tags = kept.map { text.substring(with: $0) }
        for range in kept.reversed() { text.replaceCharacters(in: range, with: "") }
        let rest = (text as String).replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (rest, tags)
    }

    /// The reply with tags lifted from earlier parts of its turn in front, so they count as if
    /// written in it: requests are acted on, a `<show>` is drawn first (it came first), and its
    /// own `<choices>`, if any, still win over earlier ones (the last block is the question).
    /// A tag the reply already has word for word is not added twice.
    public static func lifting(_ tags: [String], into reply: String) -> String {
        let new = tags.filter { !reply.contains($0) }
        guard !new.isEmpty else { return reply }
        return new.joined(separator: "\n") + "\n\n" + reply
    }

    /// The reply without its markers, trimmed, and where each marker was in it (UTF-16 offsets,
    /// as the page counts). A marker another tag took out with it has no place: drawn at the end.
    private static func placing(_ text: String, count: Int) -> (String, [Int?]) {
        let marker = "\u{E000}".utf16.first!
        var units: [UInt16] = []
        var places: [Int] = []
        for unit in text.utf16 {
            if unit == marker { places.append(units.count) } else { units.append(unit) }
        }
        let untrimmed = String(decoding: units, as: UTF16.self)
        let body = untrimmed.trimmingCharacters(in: .whitespacesAndNewlines)
        let lead = untrimmed.unicodeScalars.prefix { CharacterSet.whitespacesAndNewlines.contains($0) }.reduce(0) { $0 + $1.utf16.count }
        let length = body.utf16.count
        let found = places.map { min(max($0 - lead, 0), length) }
        // Markers line up with the components in order, unless some were lost.
        return (body, found.count == count ? found : Array(repeating: nil, count: count))
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
