import Foundation

/// Reads `claude --output-format stream-json` lines. The bot only needs each turn's final
/// text, which arrives as the `result` line.
enum StreamEvent {
    /// The result line as a reply, and each tool call as an activity line.
    static func events(in line: String) -> [AgentEvent] {
        if let reply = reply(in: line) { return [reply] }
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "assistant",
              let message = object["message"] as? [String: Any],
              let blocks = message["content"] as? [[String: Any]] else { return [] }
        return blocks.compactMap { block in
            guard block["type"] as? String == "tool_use", let name = block["name"] as? String else { return nil }
            return .activity(activity(tool: name, input: block["input"] as? [String: Any] ?? [:]))
        }
    }

    /// "Edit template.html", "Run swift build", "Search GitHub API": the verb, then what.
    static func activity(tool: String, input: [String: Any]) -> String {
        let verb = ["Read": "Read", "Write": "Write", "Edit": "Edit", "Bash": "Run", "Glob": "Find files", "Grep": "Search",
                    "WebSearch": "Search", "WebFetch": "Open page", "Task": "Delegate", "Agent": "Delegate"][tool] ?? tool
        let target: String? = {
            if let path = input["file_path"] as? String { return (path as NSString).lastPathComponent }
            for key in ["command", "pattern", "query", "url", "description"] {
                if let value = input[key] as? String, !value.isEmpty {
                    let line = value.split(whereSeparator: \.isNewline).first.map(String.init) ?? value
                    return line.count > 60 ? String(line.prefix(60)) + "…" : line
                }
            }
            return nil
        }()
        return target.map { "\(verb) \($0)" } ?? verb
    }

    static func reply(in line: String) -> AgentEvent? {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "result" else { return nil }
        return .reply(
            (object["result"] as? String) ?? "",
            isError: (object["is_error"] as? Bool) ?? false
        )
    }
}
