import Foundation

/// The five time fields of a crontab line: minute, hour, day of month, month, day of week.
/// Supports `*`, numbers, ranges `1-5`, lists `1,3,5`, and steps `*/15` or `0-30/10`.
/// Day of week is 0–7 with 0 and 7 both Sunday. As in cron, when both day of month and day of
/// week are restricted, either one matching is enough.
public struct CronSchedule: Equatable, Sendable {
    public let text: String
    let minutes: Set<Int>
    let hours: Set<Int>
    let days: Set<Int>
    let months: Set<Int>
    let weekdays: Set<Int>
    let daysRestricted: Bool
    let weekdaysRestricted: Bool

    public init?(_ text: String) {
        let fields = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 5,
              let minutes = Self.values(fields[0], 0...59),
              let hours = Self.values(fields[1], 0...23),
              let days = Self.values(fields[2], 1...31),
              let months = Self.values(fields[3], 1...12),
              var weekdays = Self.values(fields[4], 0...7) else { return nil }
        if weekdays.contains(7) { weekdays.insert(0) }
        self.text = fields.joined(separator: " ")
        self.minutes = minutes
        self.hours = hours
        self.days = days
        self.months = months
        self.weekdays = weekdays
        daysRestricted = fields[2] != "*"
        weekdaysRestricted = fields[4] != "*"
    }

    public func matches(_ date: Date, calendar: Calendar = .current) -> Bool {
        let parts = calendar.dateComponents([.minute, .hour, .day, .month, .weekday], from: date)
        guard let minute = parts.minute, let hour = parts.hour, let day = parts.day,
              let month = parts.month, let weekday = parts.weekday else { return false }
        guard minutes.contains(minute), hours.contains(hour), months.contains(month) else { return false }
        let dayMatch = days.contains(day)
        let weekdayMatch = weekdays.contains(weekday - 1)
        switch (daysRestricted, weekdaysRestricted) {
        case (true, true): return dayMatch || weekdayMatch
        case (true, false): return dayMatch
        case (false, true): return weekdayMatch
        case (false, false): return true
        }
    }

    /// The latest minute at or before `now`, and not before `earliest`, when this would run.
    public func lastTime(atOrBefore now: Date, notBefore earliest: Date, calendar: Calendar = .current) -> Date? {
        guard var minute = calendar.dateInterval(of: .minute, for: now)?.start else { return nil }
        while minute >= earliest {
            if matches(minute, calendar: calendar) { return minute }
            minute = minute.addingTimeInterval(-60)
        }
        return nil
    }

    /// `HH:mm` when it runs once a day at one time; nil for anything else.
    public var dailyTime: (hour: Int, minute: Int)? {
        guard minutes.count == 1, hours.count == 1, let minute = minutes.first, let hour = hours.first else { return nil }
        return (hour, minute)
    }

    /// 「每天 08:15」「週一到週五 09:00」, or the cron fields when it is not that simple.
    public var description: String {
        let fields = text.split(separator: " ").map(String.init)
        guard let time = dailyTime, fields[2] == "*", fields[3] == "*" else { return text }
        let clock = String(format: "%02d:%02d", time.hour, time.minute)
        switch fields[4] {
        case "*": return "每天 \(clock)"
        case "1-5": return "週一到週五 \(clock)"
        case "0,6", "6,0", "6-7": return "週末 \(clock)"
        default:
            let names = ["日", "一", "二", "三", "四", "五", "六"]
            let days = weekdays.subtracting([7]).sorted().map { "週" + names[$0] }
            return days.joined(separator: "、") + " \(clock)"
        }
    }

    private static func values(_ field: String, _ range: ClosedRange<Int>) -> Set<Int>? {
        var result = Set<Int>()
        for part in field.split(separator: ",") {
            let pieces = part.split(separator: "/", maxSplits: 1).map(String.init)
            let step = pieces.count == 2 ? Int(pieces[1]) : 1
            guard let step, step > 0 else { return nil }
            let span: ClosedRange<Int>
            if pieces[0] == "*" {
                span = range
            } else if let dash = pieces[0].firstIndex(of: "-") {
                guard let low = Int(pieces[0][..<dash]), let high = Int(pieces[0][pieces[0].index(after: dash)...]),
                      low <= high, range.contains(low), range.contains(high) else { return nil }
                span = low...high
            } else {
                guard let single = Int(pieces[0]), range.contains(single) else { return nil }
                span = pieces.count == 2 ? single...range.upperBound : single...single
            }
            result.formUnion(stride(from: span.lowerBound, through: span.upperBound, by: step))
        }
        return result.isEmpty ? nil : result
    }
}

/// One job: a line of the bot's routines.cron.
public struct Routine: Identifiable, Equatable, Sendable {
    /// The schedule and task, which is what makes it the same job across edits elsewhere.
    public var id: String { "\(schedule.text) \(task)" }
    public var schedule: CronSchedule
    /// The task as written: 「名稱：要做的事」, or 「名稱：@檔案」.
    public var task: String
    /// A line starting with `#` is paused.
    public var enabled: Bool

    public init(schedule: CronSchedule, task: String, enabled: Bool = true) {
        self.schedule = schedule
        self.task = task
        self.enabled = enabled
    }

    /// The part before 「：」, or the start of the task.
    public var title: String {
        if let colon = task.firstIndex(where: { $0 == "：" || $0 == ":" }) {
            let name = task[..<colon].trimmingCharacters(in: .whitespaces)
            if !name.isEmpty && name.count <= 20 { return name }
        }
        return task.count > 16 ? String(task.prefix(16)) + "…" : task
    }

    /// What to do: the part after 「：」, or the whole task.
    public var instruction: String {
        guard let colon = task.firstIndex(where: { $0 == "：" || $0 == ":" }),
              task[..<colon].trimmingCharacters(in: .whitespaces).count <= 20 else { return task }
        return task[task.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }

    /// `@path`: a file the bot should open and follow.
    public var file: String? {
        let text = instruction
        guard text.hasPrefix("@") else { return nil }
        let path = text.dropFirst().trimmingCharacters(in: .whitespaces)
        return path.isEmpty ? nil : path
    }

    var line: String { (enabled ? "" : "#") + "\(schedule.text) \(task)" }

    /// Parses `15 8 * * * 每日摘要：…`, with an optional leading `#` for paused. Plain comments
    /// (whose text is not a cron line) are not jobs.
    static func parse(_ line: String) -> Routine? {
        var text = line.trimmingCharacters(in: .whitespaces)
        var enabled = true
        if text.hasPrefix("#") {
            enabled = false
            text = text.dropFirst().trimmingCharacters(in: .whitespaces)
        }
        let fields = text.split(maxSplits: 5, whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 6,
              let schedule = CronSchedule(fields[0..<5].joined(separator: " ")) else { return nil }
        let task = fields[5].trimmingCharacters(in: .whitespaces)
        guard !task.isEmpty else { return nil }
        return Routine(schedule: schedule, task: task, enabled: enabled)
    }
}

/// A bot's `routines.cron`: one job per line in crontab format, which the bot edits directly and
/// the settings page edits too. Comments and blank lines are kept as they are.
public struct RoutineFile: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    static let header = """
    # Routines：每行一個 job，crontab 格式。
    # 分 時 日 月 週  名稱：要做的事（一行 prompt，或 @檔案路徑 照那個檔案做）
    # 行首加 # 就是暫停，刪掉整行就是移除。
    """

    public static let dailySummary = "15 8 * * * 每日摘要：讀各專案的記憶檔，先列等你決定的事，再每個專案一行現在狀態，最多 5 行。不要叫醒主管。"

    public var exists: Bool { FileManager.default.fileExists(atPath: url.path) }

    public func load() -> [Routine] {
        lines().compactMap(Routine.parse)
    }

    /// Writes the file with its header and `jobs`, when it does not exist yet.
    public func create(with jobs: [String]) {
        guard !exists else { return }
        write(Self.header.split(separator: "\n").map(String.init) + jobs)
    }

    public func add(_ routine: Routine) {
        write(lines() + [routine.line])
    }

    public func remove(_ id: String) {
        write(lines().filter { Routine.parse($0)?.id != id })
    }

    public func setEnabled(_ id: String, _ enabled: Bool) {
        replace(id) { $0.enabled = enabled }
    }

    /// Moves a once-a-day job to a new time, keeping its other fields.
    public func setTime(_ id: String, hour: Int, minute: Int) {
        replace(id) { routine in
            var fields = routine.schedule.text.split(separator: " ").map(String.init)
            fields[0] = String(minute)
            fields[1] = String(hour)
            if let schedule = CronSchedule(fields.joined(separator: " ")) { routine.schedule = schedule }
        }
    }

    private func replace(_ id: String, _ change: (inout Routine) -> Void) {
        write(lines().map { line in
            guard var routine = Routine.parse(line), routine.id == id else { return line }
            change(&routine)
            return routine.line
        })
    }

    private func lines() -> [String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var lines = text.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    private func write(_ lines: [String]) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url, options: .atomic)
    }
}
