import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The claude processes an app run started, written down so the next run can end the ones the
/// last left behind (an app that crashed or was replaced by a new build).
@Suite(.integration)
struct ChildProcessLedgerTests {
    func ledgerFile() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "ccb-children-\(UUID().uuidString).json")
    }

    /// A shell that started a command of its own in the background, as claude does: both must go.
    func spawnTree() throws -> (Process, URL) {
        let marker = FileManager.default.temporaryDirectory.appending(path: "ccb-grandchild-\(UUID().uuidString)")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 120 & echo $! > '\(marker.path)'; wait"]
        try process.run()
        return (process, marker)
    }

    func grandchild(_ marker: URL) async -> pid_t? {
        for _ in 0..<100 {
            if let text = try? String(contentsOf: marker, encoding: .utf8), let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)) { return pid }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return nil
    }

    func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

    @Test func recordsAndForgetsChildren() throws {
        let file = ledgerFile()
        let ledger = ChildProcessLedger(file: file)
        let (process, _) = try spawnTree()
        defer { process.terminate() }
        ledger.record(process.processIdentifier)
        #expect(ChildProcessLedger(file: file).entries.map(\.pid) == [process.processIdentifier])
        #expect(ChildProcessLedger(file: file).entries.first?.app == getpid())
        ledger.forget(process.processIdentifier)
        #expect(ChildProcessLedger(file: file).entries.isEmpty)
    }

    @Test func aLaterRunEndsWhatAnEarlierRunLeftBehindWithItsChildren() async throws {
        let file = ledgerFile()
        let (process, marker) = try spawnTree()
        let child = try #require(await grandchild(marker))
        // Written by an app run that is gone (no process has this pid now).
        let start = try #require(ChildProcessLedger.startTime(of: process.processIdentifier))
        try JSONEncoder().encode([ChildProcessLedger.Entry(pid: process.processIdentifier, started: start, app: 999_999)]).write(to: file)

        let ended = ChildProcessLedger(file: file).endLeftovers(grace: 0.5)
        #expect(ended == [process.processIdentifier])
        for _ in 0..<150 where alive(child) || process.isRunning { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(!process.isRunning)
        #expect(!alive(child))
        #expect(ChildProcessLedger(file: file).entries.isEmpty)
    }

    @Test func aReusedPidOrALiveAppsChildIsLeftAlone() throws {
        let file = ledgerFile()
        let (process, _) = try spawnTree()
        defer { process.terminate() }
        let start = try #require(ChildProcessLedger.startTime(of: process.processIdentifier))
        try JSONEncoder().encode([
            // Same pid, but a different process started then: the pid was reused.
            ChildProcessLedger.Entry(pid: process.processIdentifier, started: start - 100, app: 999_999),
        ]).write(to: file)
        #expect(ChildProcessLedger(file: file).endLeftovers(grace: 0.2).isEmpty)
        #expect(process.isRunning)
        // Another app run still going (this test process) owns it.
        try JSONEncoder().encode([ChildProcessLedger.Entry(pid: process.processIdentifier, started: start, app: getpid())]).write(to: file)
        #expect(ChildProcessLedger(file: file).endLeftovers(grace: 0.2).isEmpty)
        #expect(process.isRunning)
        #expect(ChildProcessLedger(file: file).entries.count == 1)
    }

    @Test func quittingEndsItsOwnChildrenAndTheirs() async throws {
        let file = ledgerFile()
        let ledger = ChildProcessLedger(file: file)
        let (process, marker) = try spawnTree()
        let child = try #require(await grandchild(marker))
        ledger.record(process.processIdentifier)
        ledger.endAll(grace: 0.5)
        for _ in 0..<150 where alive(child) || process.isRunning { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(!process.isRunning)
        #expect(!alive(child))
    }
}
