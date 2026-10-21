import Foundation

/// A kind of temporary team the main bot can pull up for a wish that belongs to no project.
/// Defined by a markdown file in `~/.claudecodebot/teams/` so the user can read and change it:
///
///     ---
///     name: research
///     title: Research team
///     model: sonnet
///     tools: Read, Write, WebSearch, WebFetch
///     description: Looks things up, compares options, hands back a one-page report.
///     ---
///     (the team's role, as its system prompt)
public struct TeamSpec: Equatable, Sendable {
    public var name: String
    public var title: String
    public var model: BotModel
    public var tools: [String]
    public var description: String
    public var role: String

    public init(name: String, title: String, model: BotModel, tools: [String], description: String, role: String) {
        self.name = name
        self.title = title
        self.model = model
        self.tools = tools
        self.description = description
        self.role = role
    }

    public static func parse(_ text: String) -> TeamSpec? {
        let parts = text.components(separatedBy: "---")
        guard parts.count >= 3 else { return nil }
        var fields: [String: String] = [:]
        for line in parts[1].split(separator: "\n") {
            let pair = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if pair.count == 2 { fields[pair[0]] = pair[1] }
        }
        guard let name = fields["name"], !name.isEmpty else { return nil }
        return TeamSpec(
            name: name,
            title: fields["title"] ?? name,
            model: fields["model"].flatMap(BotModel.init(rawValue:)) ?? .sonnet,
            tools: (fields["tools"] ?? "Read, Write").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) },
            description: fields["description"] ?? "",
            role: parts.dropFirst(2).joined(separator: "---").trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    var fileText: String {
        """
        ---
        name: \(name)
        title: \(title)
        model: \(model.rawValue)
        tools: \(tools.joined(separator: ", "))
        description: \(description)
        ---
        \(role)

        """
    }

    public static let defaults: [TeamSpec] = [
        TeamSpec(
            name: "research",
            title: "Research team",
            model: .sonnet,
            tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
            description: "Looks things up, compares options, hands back a one-page report.",
            role: "You are a research team started for one job. Get the facts straight, compare the options, give a recommendation. Link your sources; if you cannot find something, say so instead of guessing."
        ),
        TeamSpec(
            name: "prototype",
            title: "Prototype team",
            model: .sonnet,
            tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            description: "Builds a small working prototype or tool in its own folder, hands back a preview page.",
            role: "You are a prototype team started for one job. Build the smallest version that runs in your working folder: working first, pretty later. When done, make sure it really runs."
        )
    ]
}

/// One team at work. It lives in its own folder under `~/.claudecodebot/runs/` and ends after one reply.
public struct TeamRun: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var spec: TeamSpec
    public var task: String
    public var folder: URL
    public var startedAt: Date
}

enum TeamPrompts {
    static func system(_ spec: TeamSpec, folder: URL, results: ResultPublishing = .artifactUnlessSensitive, language: AppLanguage = .english) -> String {
        """
        \(spec.role)
        - \(BotPrompts.languageRule(language)) The task below may be written in the user's language. Your working folder is \(folder.path); read and write only there.
        - \(BotPrompts.resultsRule(results, folder: folder.appending(path: "artifacts").path))
        - Do not ask questions: when unsure, make reasonable assumptions and write them down in the result page.
        - Your final reply is at most 3 sentences: what you did, the conclusion, then the result's link, [result name](url).
        """
    }

    /// The tools a team runs with: its own, plus the Artifact tool when results may be published.
    static func tools(_ spec: TeamSpec, results: ResultPublishing) -> [String] {
        results == .localOnly || spec.tools.contains(ResultPublishing.tool) ? spec.tools : spec.tools + [ResultPublishing.tool]
    }

    static func task(_ task: String) -> String {
        "(App: A task from the main bot)\n\(task)"
    }
}
