import Foundation

/// Reads `claude --output-format stream-json` lines: each turn's final text (the `result` line),
/// questions about tools, and what it did on the way (a trace).
enum StreamEvent {
    /// The result line as a reply; tool calls, their results, words between them and
    /// subagents as trace events.
    static func events(in line: String) -> [AgentEvent] {
        // `--include-partial-messages` chunks: many per second, and only `FinalMessageWatch`
        // reads them (the whole message comes again as an `assistant` line).
        if isPartial(line) { return [] }
        if let reply = reply(in: line) { return (usage(in: line).map { [$0] } ?? []) + [reply] }
        if let request = permission(in: line) { return [.permission(request)] }
        if let id = cancelledRequest(in: line) { return [.permissionCancelled(id)] }
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        let parent = object["parent_tool_use_id"] as? String
        switch object["type"] as? String {
        case "assistant":
            guard let blocks = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] else { return [] }
            let lost: [AgentEvent] = NetworkResume.isConnectionLoss(object) ? [.connectionLost(parent: parent)] : []
            return lost + blocks.flatMap { block -> [AgentEvent] in
                switch block["type"] as? String {
                case "tool_use":
                    guard let id = block["id"] as? String, let name = block["name"] as? String else { return [] }
                    let input = block["input"] as? [String: Any] ?? [:]
                    var events: [AgentEvent] = [.trace(.toolUse(id: id, tool: name, title: activity(tool: name, input: input), detail: detail(tool: name, input: input), parent: parent))]
                    // A wake-up or cron job it scheduled waits in the background (its own only).
                    if parent == nil, let call = ScheduleCall.from(tool: name, input: input) {
                        events.append(.trace(.scheduleCalled(id: id, call: call)))
                    }
                    // A subagent the bot named can be reached again (SendMessage) by that name.
                    if TraceBook.subagentTools.contains(name), let agent = input["name"] as? String, !agent.isEmpty {
                        events.append(.trace(.subagentNamed(id: id, name: agent)))
                    }
                    // A message for a subagent (or another session): which, the stream says after.
                    if name == TraceBook.messageTool, let to = input["to"] as? String, !to.isEmpty {
                        let message = input["message"] as? String ?? input["content"] as? String ?? ""
                        events.append(.trace(.messageSent(id: id, to: to, summary: input["summary"] as? String, message: message, parent: parent)))
                    }
                    // What it is for, from the call itself rather than its activity line.
                    if TraceBook.subagentTools.contains(name) {
                        let about = (input["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let firstLine = about.split(whereSeparator: \.isNewline).first.map(String.init) ?? about
                        let said = firstLine.isEmpty ? (input["prompt"] as? String ?? "").split(whereSeparator: \.isNewline).first.map(String.init) ?? "" : firstLine
                        if !said.isEmpty { events.append(.trace(.subagentDescribed(id: id, description: said.count > 60 ? String(said.prefix(60)) + "…" : said))) }
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
                let output = text(of: block["content"])
                let failed = block["is_error"] as? Bool ?? false
                var events: [AgentEvent] = []
                // What a scheduling call of its own did, from the structured result.
                if parent == nil, !failed, let result = ScheduleResult(object["tool_use_result"]) {
                    events.append(.trace(.scheduleResult(id: id, result: result)))
                }
                // What a call that started background work or a subagent gave back, structured.
                if !failed, let launch = LaunchResult(object["tool_use_result"]) {
                    events.append(.trace(.launchResult(id: id, result: launch, parent: parent)))
                }
                events.append(.trace(.toolResult(id: id, output: output, failed: failed, parent: parent)))
                if failed, let denial = classifierDenial(id: id, output: output, parent: parent, meta: object["tool_result_meta"]) {
                    events.append(.permissionDenied(denial))
                }
                let pictures = images(of: block["content"])
                if !pictures.isEmpty { events.append(.trace(.toolImages(id: id, images: pictures, parent: parent))) }
                return events
            }
        case "command_lifecycle":
            // A message sent with a `uuid`: queued when claude reads it, started when its turn begins.
            guard let id = (object["command_uuid"] as? String).flatMap(UUID.init(uuidString:)) else { return [] }
            switch object["state"] as? String {
            case "queued": return [.commandQueued(id)]
            case "started": return [.commandStarted(id)]
            default: return []
            }
        case "rate_limit_event":
            return RateLimits.parse(object, seen: Date()).map { [.rateLimits($0)] } ?? []
        case "system":
            switch object["subtype"] as? String {
            case "task_started":
                // Background shell commands start tasks too ("local_bash"); only agents are subagents.
                let type = object["task_type"] as? String
                if type == "local_bash", object["is_backgrounded"] as? Bool == true, let id = object["tool_use_id"] as? String {
                    return [.trace(.backgroundCommandStarted(id: id, description: object["description"] as? String ?? ""))]
                }
                // A Monitor on a socket or an MCP server (not claude's own ambient sockets).
                if type == "monitor_ws" || type == "monitor_mcp", object["ambient"] as? Bool != true, let id = object["tool_use_id"] as? String {
                    return [.trace(.monitorStarted(id: id, description: object["description"] as? String ?? ""))]
                }
                guard let id = object["tool_use_id"] as? String,
                      type == "local_agent" || (type == nil && object["subagent_type"] != nil) else { return [] }
                return [.trace(.subagentStarted(
                    id: id,
                    description: object["description"] as? String ?? "",
                    type: object["subagent_type"] as? String,
                    prompt: object["prompt"] as? String ?? "",
                    background: object["is_backgrounded"] as? Bool ?? false
                ))]
            case "permission_denied":
                // Only the classifier's; deny rules, modes and safety checks stand. It names the
                // call and the reason; the tool result after it says whether it was a block.
                guard object["decision_reason_type"] as? String == "classifier",
                      let id = object["tool_use_id"] as? String,
                      let tool = object["tool_name"] as? String else { return [] }
                let given = (object["decision_reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let reason = given.isEmpty ? ClassifierDenialText.reason(in: object["message"] as? String ?? "") ?? "" : given
                return [.permissionDenied(PermissionDenial(toolUseID: id, tool: tool, reason: reason, confirmed: false))]
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
                // Every notification counts (it may start a turn of the bot's own), so one
                // without its call is still read, by its task.
                guard let id = object["tool_use_id"] as? String ?? object["task_id"] as? String else { return [] }
                let status = object["status"] as? String ?? "completed"
                // A subagent that handed its report back (SubagentHandback): the summary only says
                // it came as a message; the report is with it.
                let report = (object["handback_report"] as? [String: Any])?["text"] as? String
                let summary = report.flatMap { $0.isEmpty ? nil : $0 } ?? object["summary"] as? String
                // Not a report: it stopped with a Monitor or background command of its own still
                // running, and claude says so again each time that work wakes it. Only for the
                // subagent's card (it keeps running); whether the bot's next turn shows is up to
                // the bot (`<no-reply/>`), not these words.
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

    /// A failed tool result that is auto mode's classifier blocking the call. claude says so in
    /// `tool_result_meta` (`non_execution_kind`: "automode-blocked"; a classifier that gave no
    /// verdict is "automode-unavailable" or "automode-parsing-error"), on the bot's own results.
    /// A subagent's results carry no kind, and older claude no meta: only the words tell then.
    static func classifierDenial(id: String, output: String, parent: String?, meta: Any?) -> PermissionDenial? {
        let reason = ClassifierDenialText.reason(in: output)
        if parent == nil, let entries = meta as? [[String: Any]] {
            let kind = entries.first { $0["id"] as? String == id }?["non_execution_kind"] as? String
            guard kind == "automode-blocked" else { return nil }
            return PermissionDenial(toolUseID: id, tool: nil, reason: reason ?? "")
        }
        return reason.map { PermissionDenial(toolUseID: id, tool: nil, reason: $0) }
    }

    /// claude's summary for a subagent that has not reported yet: "Agent "…" is waiting on its
    /// own background work".
    static func isStillWaiting(_ summary: String) -> Bool {
        summary.hasSuffix("is waiting on its own background work")
    }

    /// A tool result's content: a string, or its text blocks. Its pictures come apart
    /// (`images(of:)`, kept on the step), not as words in the text.
    static func text(of content: Any?) -> String {
        if let text = content as? String { return text }
        guard let blocks = content as? [[String: Any]] else { return "" }
        return blocks.compactMap { block -> String? in
            block["type"] as? String == "text" ? block["text"] as? String : nil
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
        // No turn ran (a message claude only took into the transcript, such as a subagent's
        // task-notification whose report came already as its hand-back): nobody said anything.
        if (object["num_turns"] as? NSNumber)?.intValue == 0, object["is_error"] as? Bool != true,
           ((object["result"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        return .reply(
            (object["result"] as? String) ?? "",
            isError: (object["is_error"] as? Bool) ?? false
        )
    }

    /// A `stream_event` line (`--include-partial-messages`), told by its start alone.
    static func isPartial(_ line: String) -> Bool {
        line.hasPrefix(#"{"type":"stream_event""#)
    }
}

/// Spots the turn's last words the moment they are said: the main conversation's message whose
/// `message_delta` (a `--include-partial-messages` chunk) says `stop_reason: "end_turn"`. Claude
/// Code's Stop hooks run after that and the `result` line comes only once they are done, so this
/// shows the reply seconds earlier. Subagents' messages (`parent_tool_use_id`) are left out.
///
/// Verified with claude 2.1.304: the full `assistant` line of a message comes before its
/// `message_delta`, and `assistant` lines themselves always carry `stop_reason: null`. A Stop
/// hook that blocks makes the turn go on: its next last message ends the same way.
public struct FinalMessageWatch: Sendable {
    /// The main conversation's message being said, and its words so far.
    private var messageID: String?
    private var texts: [String] = []

    public init() {}

    /// Takes in one line. Returns the last message's words when this line ends the turn's
    /// last message, else nil.
    public mutating func read(_ line: String) -> String? {
        if StreamEvent.isPartial(line) {
            guard line.contains(#""message_delta""#), line.contains(#""end_turn""#),
                  let object = Self.object(line), Self.isMain(object),
                  let event = object["event"] as? [String: Any],
                  event["type"] as? String == "message_delta",
                  (event["delta"] as? [String: Any])?["stop_reason"] as? String == "end_turn" else { return nil }
            // A chunk of some other message (claude names it in `api_message_id`).
            if let id = object["api_message_id"] as? String, let messageID, id != messageID { return nil }
            let text = texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            messageID = nil
            texts = []
            return text.isEmpty ? nil : text
        }
        guard line.contains(#""type":"assistant""#) || line.contains(#""type":"result""#),
              let object = Self.object(line) else { return nil }
        switch object["type"] as? String {
        case "assistant":
            guard Self.isMain(object), let message = object["message"] as? [String: Any] else { return nil }
            let id = message["id"] as? String
            if id != messageID || id == nil {
                messageID = id
                texts = []
            }
            let blocks = message["content"] as? [[String: Any]] ?? []
            texts += blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.filter { !$0.isEmpty }
        case "result":
            messageID = nil
            texts = []
        default:
            break
        }
        return nil
    }

    private static func object(_ line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// The bot's own conversation, not a subagent's.
    private static func isMain(_ object: [String: Any]) -> Bool {
        object["parent_tool_use_id"] == nil || object["parent_tool_use_id"] is NSNull
    }
}

/// Adapter for the words of auto mode's block, used only where claude gives no structured kind
/// (a subagent's tool results, claude before `tool_result_meta`) and for the reason to show,
/// which claude has only in words. Real text (claude 2.1.283–2.1.304): "Permission for this
/// action was denied by the Claude Code auto mode classifier. Reason: [Code from External]. If you
/// have other tasks …". Words it does not know are no block: no card, the call stays refused.
enum ClassifierDenialText {
    static let prefix = "Permission for this action was denied by the Claude Code auto mode classifier."

    /// The classifier's reason ("[Irreversible Local Destruction]"), "" when the block gives
    /// none, nil when the text is not the classifier's block.
    static func reason(in message: String) -> String? {
        let message = message.hasPrefix("Error: ") ? String(message.dropFirst(7)) : message
        guard message.hasPrefix(prefix) else { return nil }
        var rest = message.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        if rest.hasPrefix("Reason: ") { rest = String(rest.dropFirst(8)) } else { return "" }
        if let end = rest.range(of: " If you have other tasks") ?? rest.range(of: "\n") {
            rest = String(rest[..<end.lowerBound])
        }
        rest = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        if rest.hasSuffix(".") { rest = String(rest.dropLast()) }
        return rest
    }
}
