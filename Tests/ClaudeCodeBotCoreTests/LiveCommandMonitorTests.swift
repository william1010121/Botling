import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Opt-in local harmless execution through the production adapter and real Codex app-server.
/// No bot workspace, external task or app installation is touched.
@MainActor
struct LiveCommandMonitorTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE_COMMAND_MONITOR"] == "1"))
    func realCommandCompletionAutomaticallyWakesOwningCodex() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-monitor-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        print("Monitor live evidence:", root.path)
        let threads = CodexThreads(folder: root.appending(path: "threads"))
        let owner = UUID()
        var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: owner,
            workingDirectory: root, systemPrompt: """
            You are a bounded acceptance probe. Follow the user's exact monitor commands.
            Use only app_monitor_start; do not call any other tool or delegate. The user has
            authorized only harmless printf/sleep/exit commands in this temporary workspace.
            After each start receipt, end your turn immediately with STARTED. Do not poll.
            On app_monitor_result, finish with MONITOR_RESULT followed by the exact result
            monitor_id, owner_session_id, status, exit_code, stdout and stderr. No further tools.
            """)
        launch.codexModel = "gpt-6-luna"
        launch.effort = .low
        launch.codexWorkerInstructions = "Unused; no worker is authorized in this probe."
        let process = try CodexAgentProcess(launch, executable: #require(CodexCLI.newestExecutable()), threads: threads)
        var rows: [[String: Any]] = []
        var replies: [String] = []
        var wakes = 0
        var approvals = 0
        var exited = false
        let log = root.appending(path: "events.json")
        let collector = Task { @MainActor in
            for await event in process.events {
                rows.append(["t": Date().timeIntervalSince1970, "event": String(reflecting: event)])
                if case let .permission(request) = event {
                    // This exact, harmless command is authorized by this acceptance test.
                    if request.tool == "Monitored command" {
                        approvals += 1
                        process.answer(request, allow: true, message: nil)
                    } else { process.answer(request, allow: false, message: "No other execution authorized.") }
                }
                if case .backgroundTurnStarted = event { wakes += 1 }
                if case let .reply(text, _) = event { replies.append(text) }
                if case .exited = event { exited = true }
                try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]).write(to: log, options: .atomic)
            }
        }
        defer { process.stop(); collector.cancel() }
        for (index, code) in [0, 7].enumerated() {
            let target = index + 1
            process.send("Call app_monitor_start exactly once with command: sleep 1; printf 'monitor-proof-\(code)'; printf 'stderr-proof-\(code)' >&2; exit \(code). End this turn with STARTED after acceptance. Do not run any other action.")
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline, !exited {
                let records = try threads.monitors(for: owner)
                if records.count == target, records.allSatisfy({ $0.wake == .delivered }),
                   replies.filter({ $0.contains("MONITOR_RESULT") }).count == target { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            let records = try threads.monitors(for: owner)
            let record = try #require(records.first { $0.command.contains("monitor-proof-\(code)") })
            #expect(record.exitCode == code)
            #expect(record.stdout == "monitor-proof-\(code)")
            #expect(record.stderr == "stderr-proof-\(code)")
            #expect(record.state == (code == 0 ? .succeeded : .failed))
            #expect(record.wake == .delivered)
            #expect(replies.contains { $0.contains("MONITOR_RESULT") && $0.contains(record.id) && $0.contains(owner.uuidString.lowercased()) })
            #expect(wakes == target)
            #expect(approvals == target)
        }
        try JSONSerialization.data(withJSONObject: ["owner": owner.uuidString.lowercased(), "wakes": wakes, "approvals": approvals, "replies": replies], options: [.prettyPrinted, .sortedKeys]).write(to: root.appending(path: "summary.json"))
    }
}
