import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The codex lookup kept for Doctor (and a later Codex bot engine).
struct CodexCLITests {
    @Test func theNewestInstallWins() {
        #expect(CodexCLI.parseVersion("codex-cli 0.163.0\n") == [0, 163, 0])
        #expect(CodexCLI.newer([0, 163, 0], than: [0, 141, 0]))
        #expect(!CodexCLI.newer([0, 141], than: [0, 141, 0]))
        #expect(CodexCLI.newer([1], than: []))
    }

    @Test func theUsualInstallPlacesComeFirstOnPath() {
        let path = CodexCLI.environment()["PATH"] ?? ""
        #expect(path.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.path + "/.local/bin"))
        #expect(path.contains("/opt/homebrew/bin"))
    }

    @Test func aProcessBoxStopsAProcess() throws {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        ProcessBox(process).stop()
        process.waitUntilExit()
        #expect(!process.isRunning)
        #expect(process.terminationReason == .uncaughtSignal)
    }
}
