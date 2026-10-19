import Foundation

/// A kind of temporary team the main bot can pull up for a wish that belongs to no project.
/// Defined by a markdown file in `~/.claudecodebot/teams/` so the user can read and change it:
///
///     ---
///     name: research
///     title: 研究小組
///     model: sonnet
///     tools: Read, Write, WebSearch, WebFetch
///     description: 查資料、比較選項，交回一頁報告。
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
            title: "研究小組",
            model: .sonnet,
            tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
            description: "查資料、比較選項，交回一頁報告。",
            role: "你是臨時拉起的研究小組。查清楚事實、比較選項、給出建議。來源要附連結；查不到的就寫查不到，不要猜。"
        ),
        TeamSpec(
            name: "prototype",
            title: "原型小組",
            model: .sonnet,
            tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            description: "在自己的資料夾做一個能跑的小原型或小工具，交回預覽頁。",
            role: "你是臨時拉起的原型小組。在工作資料夾裡做出能跑的最小版本，先求能用再求好看。做完確認它真的能跑。"
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
    static func system(_ spec: TeamSpec, folder: URL) -> String {
        """
        \(spec.role)
        - 一律用繁體中文。工作資料夾是 \(folder.path)，只在這裡讀寫。
        - 成果做成一頁 HTML：單一檔案、樣式寫在裡面，存到 \(folder.appending(path: "artifacts").path)/<英文檔名>.html。
        - 不要問問題：遇到不確定就做合理的假設，並把假設寫在成果頁裡。
        - 最後的回覆最多 3 句：做了什麼、結論，再附上 [成果名稱](file://成果檔的完整路徑)。
        """
    }

    static func task(_ task: String) -> String {
        "（App：主 bot 交給你的任務）\n\(task)"
    }
}
