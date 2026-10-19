import Foundation

/// Reads `claude --output-format stream-json` lines. The bot only needs each turn's final
/// text, which arrives as the `result` line.
enum StreamEvent {
    /// The result line as a reply, and each tool call as an activity line.
    static func events(in line: String) -> [AgentEvent] {
        if let reply = reply(in: line) { return [reply] }
        if let request = permission(in: line) { return [.permission(request)] }
        if let id = cancelledRequest(in: line) { return [.permissionCancelled(id)] }
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

    /// `{"type":"control_request","request":{"subtype":"can_use_tool",…}}`: it asks to use a tool.
    static func permission(in line: String) -> PermissionRequest? {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "control_request",
              let id = object["request_id"] as? String,
              let request = object["request"] as? [String: Any],
              request["subtype"] as? String == "can_use_tool",
              let tool = request["tool_name"] as? String else { return nil }
        let input = request["input"] as? [String: Any] ?? [:]
        let inputJSON = (try? JSONSerialization.data(withJSONObject: input)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return PermissionRequest(id: id, tool: tool, summary: permissionSummary(tool: tool, input: input, description: request["description"] as? String), input: inputJSON)
    }

    /// What the user is asked to allow. What will actually run comes first and in full (a
    /// command, a whole path), not the model's own description of it.
    static func permissionSummary(tool: String, input: [String: Any], description: String?) -> String {
        if let command = input["command"] as? String {
            return command.count > 2000 ? String(command.prefix(2000)) + "\n… (\(command.count) characters in all)" : command
        }
        for key in ["file_path", "notebook_path", "path", "url"] {
            if let value = input[key] as? String, !value.isEmpty { return value }
        }
        if let description, !description.isEmpty { return description.count > 300 ? String(description.prefix(300)) + "…" : description }
        let json = (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
        return json.count > 600 ? String(json.prefix(600)) + "…" : json
    }

    /// `{"type":"control_cancel_request","request_id":…}`: an earlier request no longer needs an answer.
    static func cancelledRequest(in line: String) -> String? {
        guard line.contains("control_cancel_request"),
              let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "control_cancel_request" else { return nil }
        return object["request_id"] as? String
    }

    /// The id of a control request the app does not handle (anything but can_use_tool).
    static func unsupportedRequest(in line: String) -> String? {
        guard line.contains("control_request"),
              let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "control_request",
              let id = object["request_id"] as? String,
              (object["request"] as? [String: Any])?["subtype"] as? String != "can_use_tool" else { return nil }
        return id
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
