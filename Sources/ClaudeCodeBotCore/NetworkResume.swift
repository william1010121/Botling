import Foundation

/// A bot (or its subagents) stopped because the network went away. What the app sees of that
/// is in claude's stream-json: `system`/`api_retry` lines with no HTTP status while claude
/// retries, then an API error with no HTTP status (`NetworkResume.isConnectionLoss`) that ends
/// the turn (the process stays alive, waiting for the next message) or a subagent, or, rarely,
/// the process exiting with it on stderr (`ConnectionErrorText`).
public struct Outage: Equatable, Sendable {
    /// When the run failed; the 50-minute cache window counts from here.
    public var since: Date
    /// The bot's own turn ended with the connection error.
    public var turnFailed = false
    /// Subagents it cut off, by the id of the tool call that started them.
    public var subagents: [String] = []
    /// The process went away too: the session to `--resume` while its cache is warm.
    public var lostSession: UUID?

    public init(since: Date) {
        self.since = since
    }
}

public enum NetworkResume {
    /// Back within this long, the session (and its subagents) go on where they were: the prompt
    /// cache (1-hour TTL) is still warm. Later, cut-off subagents start over as new ones.
    public static let warmWindow: TimeInterval = 50 * 60
    /// The line added to a cut-off subagent's prompt when it starts over.
    public static let restartLine = "這個任務剛剛被中斷了，請從 worktree 的現況接著做"
    /// The status and chat word for it.
    public static let label = "網路中斷"

    /// claude's API error (`is_api_error_message` on an assistant line) that had no answer from
    /// the API: no HTTP status (`api_error_status`), filed as `server_error` or `unknown` (as claude
    /// 2.1.283–2.1.304 file "Connection refused", "Can't reach the API server", "Connection lost
    /// mid-response", "Your computer went to sleep mid-response"; the API's safeguards refusing a
    /// message, also without a status, is `invalid_request`), and no typed kind (`api_error`) but
    /// `no_response`: a certificate or credential problem is not the network going away. Should
    /// the API have answered after all, the probe sees it at once and the bot goes on.
    static func isConnectionLoss(_ line: [String: Any]) -> Bool {
        guard line["is_api_error_message"] as? Bool == true,
              line["api_error_status"] == nil || line["api_error_status"] is NSNull else { return false }
        let filed = line["error"] as? String ?? "unknown"
        guard filed == "server_error" || filed == "unknown" else { return false }
        let kind = line["api_error"] as? String
        return kind == nil || kind == "no_response"
    }

    /// The chat line when a run fails this way.
    static func lostText(_ detail: String) -> String {
        let detail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(label)：連不上 Claude（\(detail.isEmpty ? "connection lost" : detail)）。網路恢復後會自動接著做。"
    }

    /// How a bot goes on once the network is back.
    public enum Mode: Equatable, Sendable {
        /// The same work (and its subagents, with SendMessage) carries on.
        case carryOn
        /// Cut off too long ago: its subagents start over as new ones.
        case restartSubagents
    }

    /// Back within `warmWindow`, or with no subagent cut off: it carries on; else subagents start over.
    public static func mode(elapsed: TimeInterval, subagents: Int) -> Mode {
        elapsed <= warmWindow || subagents == 0 ? .carryOn : .restartSubagents
    }

    /// The divider when it comes back.
    static func restoredText(elapsed: TimeInterval, mode: Mode) -> String {
        let minutes = max(1, Int((elapsed / 60).rounded()))
        let how = mode == .carryOn ? "接著原本的工作" : "重新開始被中斷的子代理"
        return "網路恢復 · 中斷約 \(minutes) 分鐘 · \(how)"
    }

    /// A subagent that was cut off, with what it takes to continue or restart it.
    public struct CutOff: Equatable, Sendable {
        public var description: String
        public var type: String?
        public var prompt: String
        public var agentID: String?

        public init(description: String, type: String?, prompt: String, agentID: String?) {
            self.description = description
            self.type = type
            self.prompt = prompt
            self.agentID = agentID
        }
    }

    /// A cut-off subagent's prompt for starting over: the original, plus the one line.
    public static func restartPrompt(_ original: String) -> String {
        let original = original.trimmingCharacters(in: .whitespacesAndNewlines)
        return original.isEmpty ? restartLine : original + "\n" + restartLine
    }

    /// What the bot is told when the network is back. Within `warmWindow` it goes on in the same
    /// session and continues its subagents (SendMessage keeps their context and cache); later,
    /// each cut-off subagent starts over as a new one in the same worktree with its prompt and
    /// `restartLine`.
    public static func resumeNote(elapsed: TimeInterval, carryOn: Bool, subagents: [CutOff]) -> String {
        let minutes = max(1, Int((elapsed / 60).rounded()))
        var parts = ["(App: \(label): the network connection was lost about \(minutes) minute\(minutes == 1 ? "" : "s") ago and is back now.)"]
        if carryOn || subagents.isEmpty {
            parts.append("Carry on with what you were doing when it dropped, from where you left off; do not start over or redo finished steps.")
        }
        guard !subagents.isEmpty else { return parts.joined(separator: "\n") }
        if mode(elapsed: elapsed, subagents: subagents.count) == .carryOn {
            parts.append("These subagents were cut off by it. Continue each one where it stopped by sending it a message with SendMessage (to: its agentId), so it keeps its context; only if it can no longer be reached, start a new one of the same type in the same worktree with its original prompt plus the line \"\(restartLine)\".")
            for subagent in subagents {
                parts.append("- \"\(subagent.description)\"" + (subagent.agentID.map { " (agentId: \($0))" } ?? "") + (subagent.type.map { ", subagent_type: \($0)" } ?? ""))
            }
        } else {
            parts.append("These subagents were cut off more than 50 minutes ago, so do not continue them. Start each again as a NEW subagent of the same type, working in the same worktree it used (do not make a new one), with exactly the prompt given here (its original prompt with one line added at the end):")
            for subagent in subagents {
                parts.append("- \"\(subagent.description)\"" + (subagent.type.map { " (subagent_type: \($0))" } ?? "") + ":\n<prompt>\n\(restartPrompt(subagent.prompt))\n</prompt>")
            }
        }
        return parts.joined(separator: "\n")
    }
}

/// Adapter for claude's connection errors in words, for where it gives nothing structured: the
/// stderr of a process that exited, and a subagent's report (a `task_notification` summary or the
/// Agent call's result). Real texts (claude 2.1.283–2.1.304): "API Error: Connection refused — a
/// firewall or proxy may be blocking it (ECONNREFUSED)", "API Error: Can't reach the API server —
/// check your internet or DNS (ENOTFOUND)", "API Error: Connection lost mid-response. …". Words it
/// does not know are no connection error: the run shows as failed, nothing waits for the network.
public enum ConnectionErrorText {
    /// Words in an error line that mean the connection itself failed (not the API saying no).
    static let connectionMarkers = [
        "connection error", "unable to connect", "timed out", "timeout", "econnreset", "econnrefused",
        "enotfound", "etimedout", "eai_again", "enetunreach", "ehostunreach", "enetdown", "econnaborted",
        "socket hang up", "fetch failed", "network", "epipe", "connection closed", "connection reset",
        "connection lost", "connection refused"
    ]

    /// One line of claude's own API error for a lost connection. Certificate problems are not the
    /// network going away.
    static func isConnectionErrorLine(_ line: String) -> Bool {
        let line = line.trimmingCharacters(in: .whitespaces).lowercased()
        let fromAPI = line.contains("api error") || line.hasPrefix("unable to connect to api")
        guard fromAPI, !line.contains("ssl"), !line.contains("certificate") else { return false }
        return connectionMarkers.contains { line.contains($0) }
    }

    /// A subagent's report that is claude's connection error: its first line is, so a report
    /// that merely talks about connection errors does not count.
    public static func isConnectionError(_ text: String) -> Bool {
        guard let first = text.split(whereSeparator: \.isNewline).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { return false }
        return isConnectionErrorLine(String(first))
    }

    /// Any line is (stderr of a process that exited, a failed subagent's notification).
    public static func mentionsConnectionError(_ text: String) -> Bool {
        text.split(whereSeparator: \.isNewline).contains { isConnectionErrorLine(String($0)) }
    }
}

/// Whether Claude's API can be reached again: any HTTP answer from it counts (even an error
/// status), only no answer at all does not.
public enum NetworkProbe {
    public static let anthropic: @Sendable () async -> Bool = {
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/")!, timeoutInterval: 10)
        request.httpMethod = "HEAD"
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        guard let (_, response) = try? await session.data(for: request) else { return false }
        return response is HTTPURLResponse
    }
}

/// A run that shows no new step for this long gets a reminder (Settings: settings.json's
/// `stallReminderMinutes`; 0 turns it off).
public enum StallWatch {
    public static let defaultMinutes = 15
}
