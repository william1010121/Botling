import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Real, opt-in acceptance test of the production process adapter and generated prompts.
/// CCB_LIVE_CODEX_MANAGED=1 swift test --filter LiveCodexManagedWorkersTests
/// The evidence directory is retained even on failure; no agent runs in this repository.
@MainActor
struct LiveCodexManagedWorkersTests {
    private struct TimedEvent {
        let time: TimeInterval
        let event: AgentEvent
    }

    private final class Recording {
        let start = Date()
        var events: [TimedEvent] = []
        var replies: [String] {
            events.compactMap { if case let .reply(text, _) = $0.event { text } else { nil } }
        }
        var running: Set<String> {
            var ids = Set<String>()
            for row in events {
                if case let .trace(.subagentStarted(id, _, _, _, _)) = row.event { ids.insert(id) }
                if case let .trace(.subagentEnded(id, _, _)) = row.event { ids.remove(id) }
            }
            return ids
        }
        var starts: [String] {
            events.compactMap { if case let .trace(.subagentStarted(id, _, _, _, _)) = $0.event { id } else { nil } }
        }
        var workerThreads: Set<String> {
            Set(events.compactMap {
                if case let .trace(.launchResult(_, result, _)) = $0.event { return result.agentID }
                return nil
            })
        }
        var sentMessages: Int {
            events.filter { if case .trace(.messageSent) = $0.event { true } else { false } }.count
        }
        var workerReports: [String] {
            events.compactMap { if case let .trace(.subagentEnded(_, _, summary)) = $0.event { summary } else { nil } }
        }
        var replyAfterLatestWake: Bool {
            guard let wake = events.last(where: { if case .backgroundTurnStarted = $0.event { true } else { false } }),
                  let reply = events.last(where: { if case .reply = $0.event { true } else { false } }) else { return false }
            return reply.time > wake.time
        }
        var backgroundWakes: Int {
            events.filter { if case .backgroundTurnStarted = $0.event { true } else { false } }.count
        }
    }

    private enum ProbeFailure: Error { case timeout(String) }

    private func wait(_ description: String, seconds: TimeInterval = 180, until ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !ready() {
            guard Date() < deadline else { throw ProbeFailure.timeout(description) }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE_CODEX_MANAGED"] == "1"))
    func appOwnsWorkersWhileCoordinatorEndsAndHandlesNewMessages() async throws {
        let real = try #require(CodexCLI.newestExecutable())
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appending(path: "ccb-live-managed-\(UUID().uuidString)")
        let folder = root.appending(path: "fixture")
        try fm.createDirectory(at: folder.appending(path: ".bot"), withIntermediateDirectories: true)
        print("Managed Codex acceptance evidence:", root.path)
        let sourceRoot = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let relay = sourceRoot.appending(path: "LiveCodexManagedWorkers/relay.py")
        #expect(fm.isExecutableFile(atPath: relay.path))
        try "## Current status\n\n## In progress\n\n## Waiting on you\n\n## Decided\n".write(to: folder.appending(path: ".bot/memory.md"), atomically: true, encoding: .utf8)
        try """
        def invoice_total(items, discount=0.0, tax_rate=0.05):
            # Discount is fractional [0,1]. Quantities are positive integers.
            # Apply discount before tax and round the final result to two decimals.
            subtotal = sum(price * quantity for price, quantity in items)
            return round(subtotal * (1 + tax_rate) - discount, 2)
        """.write(to: folder.appending(path: "billing.py"), atomically: true, encoding: .utf8)
        try """
        import unittest
        from billing import invoice_total
        class BillingTests(unittest.TestCase):
            def test_discount(self):
                self.assertEqual(invoice_total([(100, 2)], discount=.1), 189.0)
            def test_quantity(self):
                with self.assertRaises(ValueError): invoice_total([(100, -1)])
        if __name__ == '__main__': unittest.main()
        """.write(to: folder.appending(path: "test_billing.py"), atomically: true, encoding: .utf8)
        try """
        from pathlib import Path
        import subprocess, sys, time
        Path('.check-started').touch()
        deadline = time.monotonic() + 240
        while not Path('.release-check').exists():
            if time.monotonic() > deadline: raise RuntimeError('Acceptance harness did not release check')
            time.sleep(.1)
        result = subprocess.run([sys.executable, '-B', '-m', 'unittest', '-v', 'test_billing'], capture_output=True, text=True)
        print(result.stdout + result.stderr, flush=True)
        sys.exit(result.returncode)
        """.write(to: folder.appending(path: "slow_check.py"), atomically: true, encoding: .utf8)

        let profile = BotProfile.manager(name: "Managed acceptance", avatar: "square", folder: folder)
        let prompts = BotPrompts(profile: profile, language: .traditionalChinese, engine: .codex)
        var launch = AgentLaunch(model: .haiku, sessionID: UUID(), workingDirectory: folder, systemPrompt: prompts.system)
        launch.engine = .codex
        launch.codexModel = "gpt-6.1-sol"
        launch.effort = .high
        launch.codexWorkerInstructions = prompts.codexWorkerSystem
        launch.environment = ["CCB_LIVE_CODEX_REAL": real.path, "CCB_LIVE_CODEX_EVIDENCE": root.path]
        let threads = CodexThreads(folder: root.appending(path: "threads"))
        let process = try CodexAgentProcess(launch, executable: relay, threads: threads)
        let recording = Recording()
        let logURL = root.appending(path: "agent-events.jsonl")
        fm.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        let collector = Task { @MainActor in
            for await event in process.events {
                let elapsed = Date().timeIntervalSince(recording.start)
                recording.events.append(TimedEvent(time: elapsed, event: event))
                let row: [String: Any] = ["t": elapsed, "event": String(reflecting: event)]
                if var data = try? JSONSerialization.data(withJSONObject: row) {
                    data.append(0x0A)
                    try? log.write(contentsOf: data)
                }
                if case let .permission(request) = event {
                    process.answer(request, allow: false, message: "Acceptance test does not grant additional permissions.")
                }
            }
        }
        defer {
            process.stop()
            collector.cancel()
            try? log.close()
        }
        try prompts.system.write(to: root.appending(path: "coordinator-instructions.txt"), atomically: true, encoding: .utf8)
        if let worker = launch.codexWorkerInstructions {
            try worker.write(to: root.appending(path: "worker-instructions.txt"), atomically: true, encoding: .utf8)
        }
        process.send("請交給一位 app worker 修好 billing.py 的折扣、數量驗證，補測試，並執行 python3 -B slow_check.py。只使用一位 worker，交接後先結束這輪。不要修改 slow_check.py 或 .check-started/.release-check；檢查會由測試端放行。完成後回報實際測試結果。", images: [], id: UUID())
        try await wait("Coordinator ends while original worker executes gated check", seconds: 300) {
            !recording.replies.isEmpty && !recording.running.isEmpty && fm.fileExists(atPath: folder.appending(path: ".check-started").path)
        }
        let workerID = try #require(recording.starts.first)
        let firstReplyAt = try #require(recording.events.first { if case .reply = $0.event { true } else { false } }?.time)
        let workerStillRunningAfterParentEnded = recording.running.contains(workerID)

        let statusStart = Date()
        let beforeStatus = recording.replies.count
        process.send("現在進度到哪裡？只簡短回答已知狀態，不要新增工作或聯絡 worker；原工作繼續。", images: [], id: UUID())
        try await wait("Status answered while worker is still running", seconds: 90) { recording.replies.count > beforeStatus }
        let statusLatency = Date().timeIntervalSince(statusStart)
        let workerSurvivedStatus = recording.running.contains(workerID)

        let passphrase = "teal-\(UUID().uuidString.prefix(8))"
        let beforeMessage = recording.replies.count
        process.send("請用 app_send_message 傳給原 worker：『請記住通關碼 \(passphrase)，修復與檢查結束後在回報附上它。』不要新增 worker，也不要替他執行檢查。傳完就結束這輪。", images: [], id: UUID())
        try await wait("Message delivered to existing running worker", seconds: 90) {
            recording.sentMessages > 0 && recording.replies.count > beforeMessage
        }
        try Data().write(to: folder.appending(path: ".release-check"))
        try await wait("Worker completion wakes idle parent", seconds: 300) {
            recording.backgroundWakes > 0 && recording.replyAfterLatestWake && recording.running.isEmpty && recording.replies.last?.contains(passphrase) == true
        }
        let wakesBeforeFollowup = recording.backgroundWakes
        let messagesBeforeFollowup = recording.sentMessages
        process.send("請再用 app_send_message 問同一位 worker：『你剛才記住的通關碼是什麼？只回答通關碼，不讀檔、不執行命令。』沿用原 session，不開新 worker。收到結果後告訴我。", images: [], id: UUID())
        try await wait("Same worker session follows up and wakes parent again", seconds: 180) {
            recording.sentMessages > messagesBeforeFollowup && recording.backgroundWakes > wakesBeforeFollowup && recording.replyAfterLatestWake && recording.running.isEmpty && recording.replies.last?.contains(passphrase) == true
        }

        // Independent acceptance checks run only after the workers finish; the coordinator
        // itself must never reopen source or run these tests.
        let check = Process()
        check.executableURL = URL(filePath: "/usr/bin/env")
        check.arguments = ["python3", "-B", "-c", """
        from billing import invoice_total
        assert invoice_total([(100,2)], discount=.1) == 189.0
        assert invoice_total([(100,2)], discount=1) == 0
        for q in (0,-1,1.5):
            try: invoice_total([(100,q)])
            except ValueError: pass
            else: raise AssertionError(('quantity',q))
        for d in (-.1,1.1):
            try: invoice_total([(100,1)],discount=d)
            except ValueError: pass
            else: raise AssertionError(('discount',d))
        print('independent specification checks passed')
        """]
        check.currentDirectoryURL = folder
        let output = Pipe()
        check.standardOutput = output
        check.standardError = output
        try check.run()
        check.waitUntilExit()
        let independentOutput = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let parentCommands = recording.events.filter {
            if case let .trace(.toolUse(_, tool, _, _, parent)) = $0.event { return parent == nil && ["Bash", "Read", "Write", "Edit"].contains(tool) }
            return false
        }
        let summary: [String: Any] = [
            "first_parent_reply_s": firstReplyAt,
            "worker_running_after_parent_ended": workerStillRunningAfterParentEnded,
            "status_reply_s": statusLatency,
            "worker_survived_status": workerSurvivedStatus,
            "distinct_card_ids": Array(Set(recording.starts)),
            "distinct_worker_threads": Array(recording.workerThreads),
            "card_start_events": recording.starts.count,
            "messages_to_worker": recording.sentMessages,
            "background_parent_wakes": recording.backgroundWakes,
            "coordinator_file_commands": parentCommands.count,
            "worker_reports_containing_passphrase": recording.workerReports.filter { $0.contains(passphrase) }.count,
            "independent_exit_code": check.terminationStatus,
            "independent_output": independentOutput,
            "replies": recording.replies
        ]
        try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]).write(to: root.appending(path: "summary.json"))
        print("Managed Codex acceptance summary:", String(decoding: try JSONSerialization.data(withJSONObject: summary), as: UTF8.self))
        #expect(workerStillRunningAfterParentEnded)
        #expect(workerSurvivedStatus)
        #expect(Set(recording.starts).count == 1)
        #expect(recording.workerThreads.count == 1)
        #expect(recording.sentMessages >= 2)
        #expect(recording.backgroundWakes >= 2)
        #expect(recording.workerReports.filter { $0.contains(passphrase) }.count >= 2)
        #expect(parentCommands.isEmpty)
        #expect(check.terminationStatus == 0, Comment(rawValue: independentOutput))
    }
}
