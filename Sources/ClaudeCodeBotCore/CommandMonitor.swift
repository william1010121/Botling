import Foundation

/// One command, one immutable run identity. Only commands started by this app are monitored;
/// an external PID is never adopted and an interrupted command is never replayed.
struct CommandMonitor: Codable, Equatable {
    enum State: String, Codable { case awaitingApproval, running, cancelling, succeeded, failed, cancelled, interrupted }
    enum Wake: String, Codable { case none, pending, dispatching, delivered, suppressed, uncertain }
    let id: String
    let owner: UUID
    let command: String
    let cwd: String
    var state: State = .awaitingApproval
    var exitCode: Int?
    var stdout = ""
    var stderr = ""
    var detail = ""
    var wake: Wake = .none
    let createdAt: Date
    var endedAt: Date?

    var active: Bool { state == .awaitingApproval || state == .running || state == .cancelling }
    static let outputLimit = 8_192 // bytes per stream, also enforced at command/exec.
    static func bounded(_ text: String) -> String {
        var bytes = Array(text.utf8.prefix(outputLimit))
        while String(bytes: bytes, encoding: .utf8) == nil { bytes.removeLast() }
        return String(decoding: bytes, as: UTF8.self)
    }
    var payload: [String: Any] {
        ["monitor_id": id, "run": 1, "owner_session_id": owner.uuidString.lowercased(),
         "command": command, "cwd": cwd, "status": state.rawValue,
         "exit_code": exitCode.map { $0 as Any } ?? NSNull(),
         "stdout": stdout, "stderr": stderr, "output_bytes_cap_per_stream": Self.outputLimit,
         "output_may_be_truncated": true, "detail": detail, "wake": wake.rawValue]
    }

    var summary: [String: Any] {
        ["monitor_id": id, "owner_session_id": owner.uuidString.lowercased(),
         "command": String(command.prefix(240)), "status": state.rawValue,
         "wake": wake.rawValue, "exit_code": exitCode.map { $0 as Any } ?? NSNull()]
    }

    mutating func reconcile() {
        if state == .cancelling {
            state = .cancelled
            exitCode = nil
            endedAt = Date()
            wake = .suppressed
            detail = "Cancellation was requested before restart. Final exit status is unknown; no rerun or callback was sent."
        } else if active {
            let awaitingApproval = state == .awaitingApproval
            state = .interrupted
            exitCode = nil
            endedAt = Date()
            detail = awaitingApproval ? "Restarted while awaiting approval. The command was not started; no rerun was performed." : "The app-server session ended before a terminal result was saved. Execution may have had side effects. Exit status is unknown; the command was not rerun."
            wake = .pending
        } else if wake == .dispatching {
            // There is no idempotency key for turn/start. Replaying after a crash in the
            // write/ack gap could execute a second AI continuation, so expose uncertainty.
            wake = .uncertain
            detail += " Callback dispatch was interrupted before acknowledgement; inspect the owner thread and monitor status before continuing. No duplicate wake was sent."
        }
    }
}

extension CodexThreads {
    func monitors(for session: UUID) throws -> [CommandMonitor] {
        let url = folder.appending(path: session.uuidString.lowercased() + ".monitors.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let records = try JSONDecoder().decode([CommandMonitor].self, from: Data(contentsOf: url))
        guard records.allSatisfy({ $0.owner == session }), Set(records.map(\.id)).count == records.count else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return records
    }

    func saveMonitors(_ records: [CommandMonitor], for session: UUID) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONEncoder().encode(records).write(to: folder.appending(path: session.uuidString.lowercased() + ".monitors.json"), options: .atomic)
    }
}
