import Foundation

/// How a task ended, read once from Claude Code's status word for every place that asks (the
/// stop hook's `background_tasks`, a `task_notification`, a subagent's end). Nil: the word is no
/// end (`running`, `pending`, or one this build does not know), so the task still runs.
public enum TaskEnd: Sendable {
    case completed, failed, killed

    /// The words claude uses for an ended task, by how it ended.
    static let words: [String: TaskEnd] = [
        "completed": .completed, "done": .completed,
        "failed": .failed, "error": .failed,
        "killed": .killed, "stopped": .killed, "cancelled": .killed, "canceled": .killed,
    ]

    public init?(_ status: String?) {
        guard let status, let end = Self.words[status.lowercased()] else { return nil }
        self = end
    }
}

/// Work a bot's turn left running in the background: a Bash call with `run_in_background`, an
/// Agent call that was not told to wait (`task_started` with `is_backgrounded`), a Monitor (a watch
/// that wakes the bot on each event), or something scheduled to wake it later (ScheduleWakeup,
/// CronCreate). Drawn as a chip under the reply of that turn, and kept in the message, so it shows
/// how it ended even after the turn, or the app, is long gone.
public struct BackgroundTask: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case command, agent
        /// A Monitor call: claude runs its command (or holds its socket) and wakes the bot on each
        /// line, until it ends, times out or is stopped.
        case monitor
        /// A ScheduleWakeup call (a dynamic /loop): claude wakes the bot once, at `fireAt`.
        case wakeup
        /// A CronCreate call: claude wakes the bot on `schedule`, again and again (`recurring`) or
        /// once, until CronDelete (`jobID`) or the session ends.
        case cron

        /// Waits on a clock rather than on a process.
        public var isScheduled: Bool { self == .wakeup || self == .cron }
    }

    public enum Status: String, Codable, Sendable {
        case running, completed, failed, killed
        /// Its bot's process went away (it stopped, restarted, crashed) before it reported.
        case stopped
        /// The app quit (a new build installed, a restart) while it ran: it went with the app.
        case interrupted

        /// How a `task_notification` says it ended: an end word claude does not use yet counts
        /// as killed (it did end).
        public init(notification status: String) {
            switch TaskEnd(status) {
            case .completed: self = .completed
            case .failed: self = .failed
            case .killed, nil: self = .killed
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
    /// When it fires next, for a wake-up or a one-shot cron job.
    public var fireAt: Date?
    /// A cron job's five fields ("*/30 * * * *").
    public var schedule: String?
    /// A cron job that fires on every match (not once).
    public var recurring: Bool?
    /// The cron job's id ("5381432a"), which CronDelete names.
    public var jobID: String?

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
    /// claude lets a recurring cron job go after this long (and a bot stays up for one until then:
    /// sleeping would end the session it lives in).
    static let cronLasts: TimeInterval = 7 * 24 * 3600
    /// A wake-up that should have fired this long ago, with no word from its bot since, no longer
    /// keeps it awake.
    static let wakeupGrace: TimeInterval = 15 * 60

    /// It keeps its bot awake now (sleeping would end it, or the session it fires in).
    func holdsBotAwake(now: Date) -> Bool {
        guard isRunning else { return false }
        switch kind {
        case .wakeup: return now < (fireAt ?? startedAt).addingTimeInterval(Self.wakeupGrace)
        case .cron:
            if recurring == false, let fireAt { return now < fireAt.addingTimeInterval(Self.wakeupGrace) }
            return now.timeIntervalSince(startedAt) < Self.cronLasts
        default: return now.timeIntervalSince(startedAt) < Self.holdsBotAwakeFor
        }
    }

    /// When it is due to be over without a word from claude: a wake-up or one-shot job fires
    /// (`fireAt`); a recurring job expires. Nil for work that reports its own end.
    var dueAt: Date? {
        guard isRunning else { return nil }
        switch kind {
        case .wakeup: return fireAt ?? startedAt
        case .cron: return recurring == false ? fireAt : startedAt.addingTimeInterval(Self.cronLasts)
        default: return nil
        }
    }

    mutating func end(_ status: String, summary: String?, at date: Date) {
        self.status = Status(notification: status)
        // A watch that timed out or was stopped did its job; only a failed one is an error.
        if kind == .monitor, self.status == .killed { self.status = .completed }
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

    /// Scheduled work a call took back: a cron job (CronDelete), or every wake-up still to come
    /// (ScheduleWakeup with `stop`). Read from the call's structured result, not its words.
    public enum Cancellation: Equatable, Sendable {
        case cron(String)
        case wakeups

        public init?(tool: String, result: ScheduleResult?) {
            guard let result else { return nil }
            switch tool {
            case "CronDelete":
                guard let id = result.jobID else { return nil }
                self = .cron(id)
            case "ScheduleWakeup":
                guard result.stopped else { return nil }
                self = .wakeups
            default:
                return nil
            }
        }

        func matches(_ task: BackgroundTask) -> Bool {
            guard task.isRunning else { return false }
            switch self {
            case let .cron(id): return task.kind == .cron && task.jobID == id
            case .wakeups: return task.kind == .wakeup
            }
        }
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

extension BackgroundTask {
    /// As it is once its time came (see `settleDueSchedules`); unchanged when not due.
    func settled(now: Date) -> BackgroundTask {
        guard let due = dueAt, due <= now else { return self }
        var task = self
        task.status = .completed
        task.endedAt = kind == .cron && recurring != false ? due : max(due, startedAt)
        task.summary = kind == .cron && recurring != false ? "Expired (claude ends a recurring job after 7 days)." : "Fired."
        return task
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

    /// Background work still going that its bot started not too long ago, or scheduled work still
    /// to fire (sleeping would end it).
    func hasBackgroundWorkRunning(now: Date = Date()) -> Bool {
        contains { message in
            message.backgroundTasks?.contains { $0.holdsBotAwake(now: now) } == true
        }
    }

    /// Scheduled work taken back (a cron job deleted, a loop stopped): it leaves the list, as it
    /// will never run. True if any went.
    @discardableResult
    mutating func cancelScheduled(_ cancellation: BackgroundTask.Cancellation) -> Bool {
        var any = false
        for index in indices {
            guard let tasks = self[index].backgroundTasks, tasks.contains(where: cancellation.matches) else { continue }
            let kept = tasks.filter { !cancellation.matches($0) }
            self[index].backgroundTasks = kept.isEmpty ? nil : kept
            any = true
        }
        return any
    }

    /// Scheduled work whose time came: a wake-up or one-shot job fired (its bot is at work again, so
    /// it did), a recurring job expired. True if any changed.
    @discardableResult
    mutating func settleDueSchedules(now: Date) -> Bool {
        var any = false
        for index in indices {
            guard let tasks = self[index].backgroundTasks, tasks.contains(where: { $0.dueAt.map { $0 <= now } == true }) else { continue }
            self[index].backgroundTasks = tasks.map { $0.settled(now: now) }
            any = true
        }
        return any
    }

    /// The soonest time scheduled work is due, nil when none is.
    var nextScheduleDue: Date? {
        flatMap { $0.backgroundTasks ?? [] }.compactMap(\.dueAt).min()
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

/// The structured result (`tool_use_result`) claude gives a ScheduleWakeup, CronCreate or
/// CronDelete call, beside its words for the model, which change between versions. As claude
/// 2.1.304 sends them: ScheduleWakeup `{scheduledFor (ms), …}`, or `{stopped: true,
/// cancelledWakeups}` for `stop`; CronCreate `{id, recurring, humanSchedule, nextFireAt (ms)}`
/// (`nextFireAt` since about 2.1.300); CronDelete `{id}`. A refused call's is a string: nil.
public struct ScheduleResult: Equatable, Sendable {
    /// When it fires: ScheduleWakeup's `scheduledFor`, CronCreate's `nextFireAt`.
    public var fireAt: Date?
    /// The job a CronCreate made or a CronDelete removed.
    public var jobID: String?
    /// A ScheduleWakeup `stop`: the loop ended and its pending wake-ups were cancelled.
    public var stopped = false

    public init(fireAt: Date? = nil, jobID: String? = nil, stopped: Bool = false) {
        self.fireAt = fireAt
        self.jobID = jobID
        self.stopped = stopped
    }

    /// Nil when it has none of these fields (another tool's result, or an error).
    init?(_ value: Any?) {
        guard let object = value as? [String: Any] else { return nil }
        let millis = (object["scheduledFor"] as? NSNumber ?? object["nextFireAt"] as? NSNumber)?.doubleValue
        fireAt = millis.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
        jobID = (object["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        stopped = object["stopped"] as? Bool ?? false
        guard fireAt != nil || jobID != nil || stopped || object["scheduledFor"] != nil else { return nil }
    }
}

/// The structured result (`tool_use_result`) claude gives a call that started background work:
/// an Agent call `{status: "async_launched", agentId, outputFile, …}` (a subagent that finished at
/// once: `{status: "completed", agentId, …}`), a Bash call sent to the background
/// `{backgroundTaskId, …}`. Read instead of the words for the model, which change between versions.
public struct LaunchResult: Equatable, Sendable {
    /// The id SendMessage continues the subagent with.
    public var agentID: String?
    /// The file its output goes to.
    public var outputFile: String?
    /// It went on in the background: the call's return is not its result.
    public var background = false

    public init(agentID: String? = nil, outputFile: String? = nil, background: Bool = false) {
        self.agentID = agentID
        self.outputFile = outputFile
        self.background = background
    }

    /// Nil when it has none of these fields (another tool's result, or an error).
    init?(_ value: Any?) {
        guard let object = value as? [String: Any] else { return nil }
        func text(_ key: String) -> String? { (object[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        agentID = text("agentId")
        outputFile = text("outputFile") ?? text("output_file") ?? text("outputPath")
        background = object["status"] as? String == "async_launched" || object["isAsync"] as? Bool == true || text("backgroundTaskId") != nil
        guard agentID != nil || outputFile != nil || background else { return nil }
    }
}

/// The words claude gives the model when a call starts background work, for results that come
/// without a structured result (a subagent's own calls, older claude): the one place they are read.
enum LaunchText {
    /// The file named in the result: "Output is being written to: …" (Bash), "output_file: …" (Agent).
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

    /// "agentId: a1b2c3" in an Agent tool result.
    static func agentID(in output: String) -> String? {
        guard let range = output.range(of: #"agentId: ([A-Za-z0-9_\-]+)"#, options: .regularExpression) else { return nil }
        return String(output[range].dropFirst("agentId: ".count))
    }

    /// The result of an Agent call that went to the background.
    static func launchedInBackground(_ output: String) -> Bool {
        output.hasPrefix("Async agent launched")
    }
}
