import Foundation
import Darwin

/// App-owned schedules. `fired` means handed to Bot.route, never successful task completion.
public struct ScheduledRoutine: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case once, recurring }
    public enum State: String, Codable, Sendable { case pending, paused, claimed, fired, cancelled }
    public var id: String
    public var kind: Kind
    public var task: String
    public var at: Date?
    public var cron: String?
    public var timezone: String
    public var state: State = .pending
    public var createdAt: Date
    public var baseline: Date
    public var lastClaim: Date?
    public var dispatchedAt: Date?
    public var requestID: String

    public var routine: Routine {
        Routine(schedule: CronSchedule(cron ?? "* * * * *")!, task: task)
    }

    public func dueTime(at now: Date) -> Date? {
        guard state == .pending else { return nil }
        if kind == .once { return at.flatMap { $0 <= now ? $0 : nil } }
        var calendar = Calendar(identifier: .gregorian)
        guard let zone = TimeZone(identifier: timezone), let cron, let schedule = CronSchedule(cron) else { return nil }
        calendar.timeZone = zone
        guard let time = schedule.lastTime(atOrBefore: now, notBefore: calendar.startOfDay(for: now), calendar: calendar),
              time > max(lastClaim ?? baseline, baseline) else { return nil }
        return time
    }

    public func status(at now: Date) -> String {
        if state == .claimed { return "delivery_uncertain" }
        return dueTime(at: now) == nil ? state.rawValue : "due"
    }

    func payload(at now: Date) -> [String: Any] {
        var result: [String: Any] = ["id": id, "kind": kind.rawValue, "task": task,
            "timezone": timezone, "status": status(at: now), "request_id": requestID]
        if let at { result["at"] = ISO8601DateFormatter().string(from: at) }
        if let cron { result["cron"] = cron }
        if let dispatchedAt { result["dispatched_at"] = ISO8601DateFormatter().string(from: dispatchedAt) }
        return result
    }
}

/// A short, locked read/modify/atomic-write transaction shared by the UI, scheduler and Codex.
/// Never substitutes empty data on corruption or writes outside this bot's schedule directory.
public struct ScheduledRoutineStore: Sendable {
    public let url: URL
    public init(url: URL) { self.url = url }
    struct Failure: LocalizedError {
        var errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
    private struct Document: Codable { var version = 1; var routines: [ScheduledRoutine] = [] }

    private func transaction<T>(_ body: (inout [ScheduledRoutine]) throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(url.path + ".lock", O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw Failure("Cannot open routine lock. Check this bot's schedule folder permissions.") }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw Failure("Cannot lock routine state; retry after checking schedule storage.") }
        defer { flock(descriptor, LOCK_UN) }
        var document: Document
        if FileManager.default.fileExists(atPath: url.path) {
            do { document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: url)) }
            catch { throw Failure("Cannot read routine state. Preserve scheduled-routines.json and check its data/storage before retrying: " + error.localizedDescription) }
            guard document.version == 1 else { throw Failure("Unsupported routine state version. Update Botling before changing schedules.") }
            guard Set(document.routines.map(\.id)).count == document.routines.count,
                  Set(document.routines.map(\.requestID)).count == document.routines.count,
                  document.routines.allSatisfy({ job in
                      !job.id.isEmpty && !job.requestID.isEmpty && !job.task.isEmpty &&
                      TimeZone(identifier: job.timezone) != nil &&
                      (job.kind == .once ? (job.at != nil && job.cron == nil) : (job.at == nil && job.cron.flatMap(CronSchedule.init) != nil))
                  }) else { throw Failure("Invalid routine state. Preserve scheduled-routines.json for recovery; no schedules were changed or dispatched.") }
        } else { document = Document() }
        let old = document.routines
        let result = try body(&document.routines)
        if old != document.routines {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(document).write(to: url, options: .atomic)
        }
        return result
    }

    public func load() throws -> [ScheduledRoutine] { try transaction { $0 } }

    /// Persistence precedes dispatch. A crash in this window leaves `claimed`, never retries.
    public func claim(_ id: String, now: Date) throws -> ScheduledRoutine? {
        try transaction { jobs in
            guard let index = jobs.firstIndex(where: { $0.id == id }),
                  let occurrence = jobs[index].dueTime(at: now) else { return nil }
            jobs[index].state = .claimed
            jobs[index].lastClaim = occurrence
            return jobs[index]
        }
    }

    public func didDispatch(_ id: String, now: Date) throws {
        try transaction { jobs in
            guard let index = jobs.firstIndex(where: { $0.id == id }), jobs[index].state == .claimed else { return }
            jobs[index].dispatchedAt = now
            jobs[index].state = jobs[index].kind == .once ? .fired : .pending
        }
    }

    /// Same interface for the Codex dynamic tool and native UI. All mutations return saved IDs.
    public func perform(_ arguments: [String: Any], now: Date = Date()) throws -> [String: Any] {
        let operation = arguments["operation"] as? String ?? ""
        if operation == "list" {
            let jobs = try load().map { $0.payload(at: now) }
            let legacy = RoutineFile(url: url.deletingLastPathComponent().appending(path: "routines.cron")).load().map {
                ["id": "cron:" + $0.id, "kind": "legacy_recurring", "task": $0.task,
                 "cron": $0.schedule.text, "timezone": "system_local", "status": $0.enabled ? "enabled" : "paused"]
            }
            return ["routines": jobs + legacy, "checked_at": ISO8601DateFormatter().string(from: now)]
        }
        if operation == "create" {
            let task = (arguments["task"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !task.isEmpty, !task.contains("\n"), !task.contains("\r") else { throw Failure("task must be a nonempty one-line instruction, optionally 'Name: instruction' or 'Name: @file'.") }
            guard let request = arguments["request_id"] as? String, !request.isEmpty else { throw Failure("create requires a unique request_id; reuse it on retries to avoid duplicate schedules.") }
            let zone = arguments["timezone"] as? String ?? TimeZone.current.identifier
            guard TimeZone(identifier: zone) != nil else { throw Failure("Unknown timezone. Supply an IANA name such as Asia/Taipei.") }
            let kind = ScheduledRoutine.Kind(rawValue: arguments["kind"] as? String ?? "")
            guard let kind else { throw Failure("create requires kind='once' with at, or kind='recurring' with cron.") }
            let at = try Self.date(arguments["at"], required: kind == .once)
            let cron = arguments["cron"] as? String
            guard kind != .recurring || cron.flatMap(CronSchedule.init) != nil else { throw Failure("recurring requires cron with five valid fields: minute hour day month weekday.") }
            guard (kind == .once && cron == nil) || (kind == .recurring && at == nil) else { throw Failure("Use at for once, or cron for recurring, never both.") }
            return try transaction { jobs in
                if let existing = jobs.first(where: { $0.requestID == request }) {
                    guard existing.task == task, existing.kind == kind, existing.at == at,
                          existing.cron == cron, (arguments["timezone"] == nil || existing.timezone == zone) else { throw Failure("request_id already belongs to a different schedule. List routines; use a new request_id for new work.") }
                    return existing.payload(at: now)
                }
                guard at == nil || at! > now else { throw Failure("at must be in the future. Supply ISO-8601 with an explicit UTC offset, e.g. 2026-10-25T09:00:00+08:00.") }
                let job = ScheduledRoutine(id: UUID().uuidString.lowercased(), kind: kind, task: task, at: at,
                    cron: cron, timezone: zone, createdAt: now, baseline: now, requestID: request)
                jobs.append(job)
                return job.payload(at: now)
            }
        }
        guard ["cancel", "pause", "resume"].contains(operation) else { throw Failure("Supported operations: list, create, cancel, pause, resume. To reschedule, cancel the saved ID and create a new schedule with a new request_id.") }
        guard let id = arguments["id"] as? String, !id.isEmpty else { throw Failure("This operation requires the persisted id returned by create or list.") }
        if id.hasPrefix("cron:") {
            return try transaction { _ in
                let file = RoutineFile(url: url.deletingLastPathComponent().appending(path: "routines.cron"))
                try file.update(id: String(id.dropFirst(5)), operation: operation)
                return ["id": id, "status": operation == "cancel" ? "cancelled" : (operation == "pause" ? "paused" : "enabled")]
            }
        }
        return try transaction { jobs in
            guard let index = jobs.firstIndex(where: { $0.id == id }) else { throw Failure("Unknown routine id. Call list and use an id from this bot.") }
            if operation == "cancel" {
                // Cancellation stops future dispatch only; it never interrupts already handed-off work.
                guard jobs[index].state != .claimed else { throw Failure("This routine was already claimed for dispatch. Check chat before creating a replacement; cancellation cannot retract dispatched work.") }
                if jobs[index].state != .fired { jobs[index].state = .cancelled }
            } else {
                guard jobs[index].state == .pending || jobs[index].state == .paused else { throw Failure("Only pending or paused routines can be paused/resumed. Fired, cancelled or delivery_uncertain jobs cannot be rearmed; create a new schedule explicitly.") }
                if operation == "resume", jobs[index].state == .paused { jobs[index].baseline = now }
                jobs[index].state = operation == "pause" ? .paused : .pending
            }
            return jobs[index].payload(at: now)
        }
    }

    private static func date(_ value: Any?, required: Bool) throws -> Date? {
        guard let value else {
            if required { throw Failure("once requires at, an ISO-8601 timestamp with Z or an explicit UTC offset.") }
            return nil
        }
        guard let text = value as? String,
              text.range(of: #"T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil else {
            throw Failure("at must be ISO-8601 with seconds and Z or an explicit UTC offset; timezone alone does not resolve ambiguous local times.")
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { throw Failure("Invalid at timestamp. Use e.g. 2026-10-25T09:00:00+08:00.") }
        return date
    }
}
