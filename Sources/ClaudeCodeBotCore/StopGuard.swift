import Foundation

/// Claude Code's `Stop` hook for every bot: a bot may not end its turn on a promise ("接下來我會確認…",
/// "I'll check and report back") that nothing will make it keep. Nothing wakes a bot between
/// turns but a message, so such a promise would just hang there.
///
/// The app runs itself as the hook (`ClaudeCodeBot --stop-guard <claude>`). It reads the hook's
/// stdin JSON and lets the turn end at once when the hook already blocked this stop
/// (`stop_hook_active`, so it never loops), when background tasks are still running or crons are
/// set (they will wake the bot), or when the reply asks the user to pick (`<choices>`).
/// Otherwise Haiku reads the last reply; a promise blocks the stop with a reason Claude reads.
/// Any error or a slow answer lets the turn end.
public enum StopGuard {
    /// Set in the classifier's own `claude -p`; a hook that sees it lets the stop through.
    public static let childMarker = "CCB_STOP_GUARD_CHILD"
    /// The classifier's own cap; the hook's timeout in the settings is above it.
    public static let classifierTimeout: TimeInterval = 15
    public static let hookTimeout = 30

    public enum Decision: Equatable, Sendable {
        case allow
        case block(reason: String)
    }

    /// Whether this final message promises work nothing will trigger. Throws when it can't tell.
    public typealias Classifier = @Sendable (String) async throws -> Bool

    public static let blockReason = """
        Your last message promises work you have not done ("I'll check…", "接下來我會…", "will report back"), \
        but your turn is ending and nothing will wake you to do it: the user will be left waiting. \
        Do it now, in this turn. If it has to wait, start it as a background task (Bash with \
        run_in_background, or a background subagent) that will wake you when it is done. \
        If you really meant to hand it back to the user, say so plainly instead of promising.
        """

    struct Input: Decodable {
        var stop_hook_active: Bool?
        var last_assistant_message: String?
        var transcript_path: String?
        var background_tasks: [BackgroundTask]?
        var session_crons: [JSONValue]?

        struct BackgroundTask: Decodable {
            var status: String?
        }
    }

    /// What to do with this hook input (`input`: the stdin JSON).
    public static func decide(input: Data, environment: [String: String] = ProcessInfo.processInfo.environment, classify: Classifier) async -> Decision {
        if environment[childMarker] != nil { return .allow }
        guard let hook = try? JSONDecoder().decode(Input.self, from: input) else { return .allow }
        if hook.stop_hook_active == true { return .allow }
        // A task still going (shell, subagent, monitor) wakes the bot when it ends.
        let running = (hook.background_tasks ?? []).contains { task in
            let status = task.status?.lowercased() ?? "running"
            return !["completed", "failed", "killed", "stopped", "done", "cancelled"].contains(status)
        }
        if running || !(hook.session_crons ?? []).isEmpty { return .allow }
        let message = hook.last_assistant_message ?? hook.transcript_path.flatMap { lastAssistantText(transcript: URL(filePath: $0)) } ?? ""
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        // Nothing said, or a question the user answers by picking: the user moves next.
        if text.isEmpty || text.contains("<choices") { return .allow }
        guard let promises = try? await classify(String(text.suffix(4000))) else { return .allow }
        return promises ? .block(reason: blockReason) : .allow
    }

    /// The hook's stdout for this decision (nothing lets the stop through).
    public static func output(for decision: Decision) -> String? {
        guard case let .block(reason) = decision else { return nil }
        let object: [String: String] = ["decision": "block", "reason": reason]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) }
    }

    /// The text of the last assistant message of the main conversation in a transcript (JSONL).
    static func lastAssistantText(transcript: URL) -> String? {
        guard let data = try? Data(contentsOf: transcript) else { return nil }
        for line in String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).reversed() {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  object["isSidechain"] as? Bool != true,
                  let message = object["message"] as? [String: Any],
                  message["role"] as? String == "assistant",
                  let content = message["content"] as? [[String: Any]] else { continue }
            let text = content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            if !text.isEmpty { return text }
        }
        return nil
    }

    static let classifierPrompt = """
        You check the final message an AI assistant sent before ending its turn in a chat. After this \
        message nothing happens until the user writes again.
        Answer PROMISE if the message says the assistant will now do something itself without the user \
        ("I'll check…", "Let me look into it and report back", "接下來我會確認…", "我去看一下再回報", \
        "稍後回報") and no background task, subagent, team, build, schedule or app notification is \
        named as what will bring the result back.
        Answer OK if the work is done or reported; if it asks the user a question or waits for the \
        user's answer, choice or permission; if it says a background task, subagent, team, build or \
        notification will wake it or report back; or if it only suggests next steps the user may ask for.
        Reply with exactly one word: PROMISE or OK.
        """

    /// The classifier's `claude -p` arguments: Haiku, no tools, no hooks, no MCP, no session kept.
    static func classifierArguments(message: String) -> [String] {
        [
            "-p", message,
            "--model", BotModel.haiku.rawValue,
            "--system-prompt", classifierPrompt,
            "--tools", "",
            "--settings", #"{"disableAllHooks":true}"#,
            "--strict-mcp-config",
            "--no-session-persistence",
            "--output-format", "text"
        ]
    }

    /// Reads the classifier's answer; throws when it said neither.
    static func parseVerdict(_ output: String) throws -> Bool {
        let words = output.uppercased()
        if words.contains("PROMISE") { return true }
        if words.contains("OK") { return false }
        throw CocoaError(.formatting)
    }

    /// Haiku through the `claude` at `executable`, stopped after `timeout` seconds.
    public static func claudeClassifier(executable: URL, timeout: TimeInterval = classifierTimeout) -> Classifier {
        { message in
            let result = await blocking {
                CommandRunner.runBlocking(executable, classifierArguments(message: message), timeout: timeout, environment: [childMarker: "1", "CLAUDECODE": nil])
            }
            guard let result, !result.timedOut, result.exitCode == 0 else { throw CocoaError(.executableLoad) }
            return try parseVerdict(result.output)
        }
    }

    /// The hook entry in Claude Code's settings for `command`.
    static func hooksSettings(command: String) -> [String: Any] {
        ["Stop": [["hooks": [["type": "command", "command": command, "timeout": hookTimeout]]]]]
    }

    /// The hook's command line: this app's executable with `--stop-guard` and the claude to ask.
    public static func command(app: String, claude: String) -> String {
        "\(shellQuoted(app)) --stop-guard \(shellQuoted(claude))"
    }

    static func shellQuoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    /// `ClaudeCodeBot --stop-guard <claude>`: reads stdin, prints a block when it blocks, exits 0.
    public static func run(claude: URL) -> Never {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let semaphore = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var decision = Decision.allow
        Task.detached {
            decision = await decide(input: input, classify: claudeClassifier(executable: claude))
            semaphore.signal()
        }
        semaphore.wait()
        if let output = output(for: decision) {
            FileHandle.standardOutput.write(Data((output + "\n").utf8))
        }
        exit(0)
    }
}
