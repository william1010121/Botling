import Foundation

/// Reads `claude --output-format stream-json` lines: each turn's final text (the `result` line),
/// questions about tools, and what it did on the way (a trace).
enum StreamEvent {
    /// The result line as a reply; tool calls, their results, words between them and
    /// subagents as trace events.
    static func events(in line: String) -> [AgentEvent] {
        if let reply = reply(in: line) { return (usage(in: line).map { [$0] } ?? []) + [reply] }
        if let request = permission(in: line) { return [.permission(request)] }
        if let id = cancelledRequest(in: line) { return [.permissionCancelled(id)] }
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        let parent = object["parent_tool_use_id"] as? String
        switch object["type"] as? String {
        case "assistant":
            guard let blocks = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] else { return [] }
            return blocks.flatMap { block -> [AgentEvent] in
                switch block["type"] as? String {
                case "tool_use":
                    guard let id = block["id"] as? String, let name = block["name"] as? String else { return [] }
                    let input = block["input"] as? [String: Any] ?? [:]
                    var events: [AgentEvent] = [.trace(.toolUse(id: id, tool: name, title: activity(tool: name, input: input), detail: detail(tool: name, input: input), parent: parent))]
                    // A subagent the bot named can be reached again (SendMessage) by that name.
                    if TraceBook.subagentTools.contains(name), let agent = input["name"] as? String, !agent.isEmpty {
                        events.append(.trace(.subagentNamed(id: id, name: agent)))
                    }
                    return events
                case "text":
                    guard let text = block["text"] as? String, !text.isEmpty else { return [] }
                    return [.trace(.text(text, parent: parent))]
                default:
                    return []
                }
            }
        case "user":
            guard let blocks = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] else { return [] }
            return blocks.flatMap { block -> [AgentEvent] in
                guard block["type"] as? String == "tool_result", let id = block["tool_use_id"] as? String else { return [] }
                var events: [AgentEvent] = [.trace(.toolResult(id: id, output: text(of: block["content"]), failed: block["is_error"] as? Bool ?? false, parent: parent))]
                let pictures = images(of: block["content"])
                if !pictures.isEmpty { events.append(.trace(.toolImages(id: id, images: pictures, parent: parent))) }
                return events
            }
        case "rate_limit_event":
            return RateLimits.parse(object, seen: Date()).map { [.rateLimits($0)] } ?? []
        case "system":
            switch object["subtype"] as? String {
            case "task_started":
                // Background shell commands start tasks too ("local_bash"); only agents are subagents.
                let type = object["task_type"] as? String
                guard let id = object["tool_use_id"] as? String,
                      type == "local_agent" || (type == nil && object["subagent_type"] != nil) else { return [] }
                return [.trace(.subagentStarted(
                    id: id,
                    description: object["description"] as? String ?? "",
                    type: object["subagent_type"] as? String,
                    prompt: object["prompt"] as? String ?? "",
                    background: object["is_backgrounded"] as? Bool ?? false
                ))]
            case "api_retry":
                // An HTTP status means the API answered (overloaded, rate limit): not the network.
                guard object["error_status"] == nil || object["error_status"] is NSNull else { return [] }
                let error = object["error"] as? String
                guard error == nil || error == "unknown" || error == "connection_error" else { return [] }
                return [.connectionTrouble(
                    attempt: (object["attempt"] as? NSNumber)?.intValue ?? 0,
                    maxRetries: (object["max_retries"] as? NSNumber)?.intValue ?? 0
                )]
            case "task_notification":
                guard let id = object["tool_use_id"] as? String else { return [] }
                let status = object["status"] as? String ?? "completed"
                let summary = object["summary"] as? String
                // Not a report: it stopped with a Monitor or background command of its own still
                // running, and claude says so again each time that work wakes it.
                if status == "completed", object["handback"] == nil, summary.map(Self.isStillWaiting) == true {
                    return [.trace(.subagentWaiting(id: id))]
                }
                return [.trace(.subagentEnded(id: id, status: status, summary: summary))]
            default:
                return []
            }
        default:
            return []
        }
    }

    /// claude's summary for a subagent that has not reported yet: "Agent "…" is waiting on its
    /// own background work".
    static func isStillWaiting(_ summary: String) -> Bool {
        summary.hasSuffix("is waiting on its own background work")
    }

    /// A tool result's content: a string, or text blocks (images say so in words).
    static func text(of content: Any?) -> String {
        if let text = content as? String { return text }
        guard let blocks = content as? [[String: Any]] else { return "" }
        return blocks.compactMap { block -> String? in
            switch block["type"] as? String {
            case "text": block["text"] as? String
            case "image": "(image)"
            default: nil
            }
        }.joined(separator: "\n")
    }

    /// The pictures in a tool result's content: `{"type":"image","source":{"type":"base64",…}}`.
    static func images(of content: Any?) -> [ToolImage] {
        guard let blocks = content as? [[String: Any]] else { return [] }
        return blocks.compactMap { block in
            guard block["type"] as? String == "image",
                  let source = block["source"] as? [String: Any],
                  source["type"] as? String ?? "base64" == "base64",
                  let base64 = source["data"] as? String,
                  let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), !data.isEmpty else { return nil }
            return ToolImage(mediaType: source["media_type"] as? String ?? "image/png", data: data)
        }
    }

    /// What went into a tool call, in full: the command, the path, the subagent's task.
    static func detail(tool: String, input: [String: Any]) -> String {
        for key in ["command", "prompt", "file_path", "notebook_path", "url", "query", "pattern"] {
            if let value = input[key] as? String, !value.isEmpty {
                if key == "pattern", let path = input["path"] as? String { return "\(value)  in \(path)" }
                return value
            }
        }
        let json = (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys, .prettyPrinted])).map { String(decoding: $0, as: UTF8.self) }
        return json ?? ""
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

    /// The session's cost so far and this turn's tokens, from a result line.
    static func usage(in line: String) -> AgentEvent? {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "result",
              let cost = (object["total_cost_usd"] as? NSNumber)?.doubleValue else { return nil }
        let usage = object["usage"] as? [String: Any] ?? [:]
        func count(_ key: String) -> Int { (usage[key] as? NSNumber)?.intValue ?? 0 }
        return .usage(totalCost: cost, tokens: TokenUsage(
            input: count("input_tokens"),
            output: count("output_tokens"),
            cacheWrite: count("cache_creation_input_tokens"),
            cacheRead: count("cache_read_input_tokens")
        ))
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
