import Foundation

/// Work a bot's turn left running in the background: a Bash call with `run_in_background`, or an
/// Agent call that was not told to wait (`task_started` with `is_backgrounded`). Drawn as a chip
/// under the reply of that turn, and kept in the message, so it shows how it ended even after the
/// turn, or the app, is long gone.
public struct BackgroundTask: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case command, agent
    }

    public enum Status: String, Codable, Sendable {
        case running, completed, failed, killed
        /// Its bot's process went away (it stopped, restarted, crashed) before it reported.
        case stopped
        /// The app quit (a new build installed, a restart) while it ran: it went with the app.
        case interrupted

        /// How a `task_notification` says it ended.
        public init(notification status: String) {
            switch status {
            case "completed": self = .completed
            case "failed", "error": self = .failed
            default: self = .killed
            }
        }
    }

    /// The tool call that started it.
    public var id: String
    public var kind: Kind
    /// The call's own description ("Run tests and build dev app").
    public var title: String
    public var status: Status
    public var startedAt: Date
    public var endedAt: Date?
    /// Where claude writes what it prints (a command's output; an agent's transcript).
    public var outputFile: String?
    /// What claude said when it ended (an agent's report, a command's exit code).
    public var summary: String?
    /// What it was started with (the command; the agent's task), shortened: for telling the bot
    /// what to start again when it was cut off.
    public var detail: String?
    /// Cut off (stopped or interrupted), and its bot has been told so.
    public var told: Bool?

    public init(id: String, kind: Kind, title: String, status: Status = .running, startedAt: Date = Date()) {
        self.id = id
        self.kind = kind
        self.title = title
        self.status = status
        self.startedAt = startedAt
    }

    public var isRunning: Bool { status == .running }

    /// It ended because the process running it went away, not on its own.
    public var wasCutOff: Bool { status == .stopped || status == .interrupted }

    /// Running for longer than this, with no word, it no longer keeps its bot awake (claude
    /// may have lost track of it): a bot does not stay up forever on a chip.
    static let holdsBotAwakeFor: TimeInterval = 6 * 3600

    mutating func end(_ status: String, summary: String?, at date: Date) {
        self.status = Status(notification: status)
        endedAt = date
        if let summary, !summary.isEmpty { self.summary = TraceBook.shorten(summary) }
    }

    /// The page's answer to an opened chip: `ccb.taskOutput(message, task, text)`.
    public static func outputReplyScript(messageID: String, taskID: String, text: String) -> String {
        func quoted(_ value: String) -> String {
            (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
        }
        return "ccb.taskOutput(\(quoted(messageID)), \(quoted(taskID)), \(quoted(text)))"
    }

    /// The file named in the result of the call that launched it: "Output is being written to:
    /// …" (Bash), "output_file: …" (Agent).
    static func outputFile(in result: String) -> String? {
        for marker in ["Output is being written to: ", "output_file: "] {
            guard let range = result.range(of: marker) else { continue }
            let rest = result[range.upperBound...]
            var line = String(rest.prefix { !$0.isNewline })
            // A path may have spaces; the sentence after it starts ". You will be notified".
            if let end = line.range(of: ". You ") { line = String(line[..<end.lowerBound]) }
            var path = line.trimmingCharacters(in: .whitespaces)
            if path.hasSuffix(".") { path.removeLast() }
            if !path.isEmpty { return path }
        }
        return nil
    }

    /// The last `lines` lines a command printed: colors taken out, a line redrawn in place
    /// (`\r`) as it ended up, blank lines left out. Reads only the end of a big file. Nil when
    /// there is no such file.
    public static func tail(of path: String, lines: Int = 8, maxBytes: Int = 16_384) -> String? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let from = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try? handle.seek(toOffset: from)
        let data = (try? handle.readToEnd()) ?? Data()
        var text = String(decoding: data, as: UTF8.self)
        // A partial first line, when it started mid-file.
        if from > 0, let newline = text.firstIndex(of: "\n") { text = String(text[text.index(after: newline)...]) }
        text = text.replacingOccurrences(of: #"\x{1B}\[[0-9;?]*[A-Za-z]"#, with: "", options: .regularExpression)
        let kept = text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { raw -> String? in
            let line = (raw.split(separator: "\r").last.map(String.init) ?? "").trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { return nil }
            return line.count > 300 ? String(line.prefix(300)) + "…" : line
        }
        return kept.suffix(lines).joined(separator: "\n")
    }
}

extension Array where Element == ChatMessage {
    /// A background task reported back (`task_notification`): the chip of the reply it belongs to
    /// says how it ended. True if one changed (worth saving).
    @discardableResult
    mutating func endBackgroundTask(_ id: String, status: String, summary: String?, at date: Date) -> Bool {
        for index in indices.reversed() {
            guard let at = self[index].backgroundTasks?.firstIndex(where: { $0.id == id }) else { continue }
            guard self[index].backgroundTasks![at].isRunning else { return false }
            self[index].backgroundTasks![at].end(status, summary: summary, at: date)
            return true
        }
        return false
    }

    /// The process that ran them went away (`stopped`), or the app quit while they ran
    /// (`interrupted`, seen at the next launch): whatever had not reported never will. True if any
    /// was still running.
    @discardableResult
    mutating func stopBackgroundTasks(as status: BackgroundTask.Status = .stopped, at date: Date? = nil) -> Bool {
        var any = false
        for index in indices {
            guard let tasks = self[index].backgroundTasks, tasks.contains(where: \.isRunning) else { continue }
            self[index].backgroundTasks = tasks.map { task in
                var task = task
                if task.isRunning {
                    task.status = status
                    task.endedAt = date
                }
                return task
            }
            any = true
        }
        return any
    }

    /// Background work still going that its bot started not too long ago (sleeping would end it).
    func hasBackgroundWorkRunning(now: Date = Date()) -> Bool {
        contains { message in
            message.backgroundTasks?.contains { $0.isRunning && now.timeIntervalSince($0.startedAt) < BackgroundTask.holdsBotAwakeFor } == true
        }
    }

    /// Cut-off work its bot has not been told about yet, oldest first.
    var untoldCutOffTasks: [BackgroundTask] {
        flatMap { $0.backgroundTasks ?? [] }.filter { $0.wasCutOff && $0.told != true }
    }

    /// Marks every cut-off task as told. True if any changed.
    @discardableResult
    mutating func markCutOffTasksTold() -> Bool {
        var any = false
        for index in indices {
            guard let tasks = self[index].backgroundTasks, tasks.contains(where: { $0.wasCutOff && $0.told != true }) else { continue }
            self[index].backgroundTasks = tasks.map { task in
                var task = task
                if task.wasCutOff { task.told = true }
                return task
            }
            any = true
        }
        return any
    }
}
