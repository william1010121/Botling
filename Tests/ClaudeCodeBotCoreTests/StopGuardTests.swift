import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct StopGuardTests {
    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var _messages: [String] = []
        func add(_ message: String) { lock.withLock { _messages.append(message) } }
        var messages: [String] { lock.withLock { _messages } }
    }

    private func input(_ fields: [String: Any]) -> Data {
        var object: [String: Any] = ["hook_event_name": "Stop", "stop_hook_active": false, "background_tasks": [], "session_crons": []]
        for (key, value) in fields { object[key] = value }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func classifier(_ verdict: Bool, _ calls: Calls) -> StopGuard.Classifier {
        { message in calls.add(message); return verdict }
    }

    @Test func blocksAPromiseTheClassifierFlags() async {
        let calls = Calls()
        let decision = await StopGuard.decide(input: input(["last_assistant_message": "好的，接下來我會確認測試結果再回報。"]), environment: [:], classify: classifier(true, calls))
        #expect(decision == .block(reason: StopGuard.blockReason))
        #expect(calls.messages == ["好的，接下來我會確認測試結果再回報。"])
        let output = try! #require(StopGuard.output(for: decision))
        let object = try! JSONSerialization.jsonObject(with: Data(output.utf8)) as! [String: String]
        #expect(object["decision"] == "block")
        #expect(object["reason"]?.contains("background task") == true)
    }

    @Test func allowsWhatTheClassifierPasses() async {
        let decision = await StopGuard.decide(input: input(["last_assistant_message": "Done: all tests pass."]), environment: [:], classify: classifier(false, Calls()))
        #expect(decision == .allow)
        #expect(StopGuard.output(for: decision) == nil)
    }

    @Test func allowsWithoutAskingWhenTheHookAlreadyBlocked() async {
        let calls = Calls()
        let decision = await StopGuard.decide(input: input(["stop_hook_active": true, "last_assistant_message": "I'll check."]), environment: [:], classify: classifier(true, calls))
        #expect(decision == .allow)
        #expect(calls.messages.isEmpty)
    }

    @Test func allowsWithoutAskingWhileBackgroundWorkRuns() async {
        let calls = Calls()
        let task: [String: Any] = ["id": "b1", "type": "shell", "status": "running", "command": "sleep 8"]
        let running = await StopGuard.decide(input: input(["background_tasks": [task], "last_assistant_message": "I'll report back."]), environment: [:], classify: classifier(true, calls))
        #expect(running == .allow)
        let cron = await StopGuard.decide(input: input(["session_crons": [["id": "c1"]], "last_assistant_message": "I'll report back."]), environment: [:], classify: classifier(true, calls))
        #expect(cron == .allow)
        #expect(calls.messages.isEmpty)
        // A finished task wakes nothing.
        var done = task
        done["status"] = "completed"
        let finished = await StopGuard.decide(input: input(["background_tasks": [done], "last_assistant_message": "I'll report back."]), environment: [:], classify: classifier(true, calls))
        #expect(finished == .block(reason: StopGuard.blockReason))
    }

    @Test func allowsOnErrors() async throws {
        let failing: StopGuard.Classifier = { _ in throw CocoaError(.executableLoad) }
        #expect(await StopGuard.decide(input: input(["last_assistant_message": "I'll check."]), environment: [:], classify: failing) == .allow)
        #expect(await StopGuard.decide(input: Data("not json".utf8), environment: [:], classify: classifier(true, Calls())) == .allow)
        #expect(throws: (any Error).self) { try StopGuard.parseVerdict("Error: rate limited") }
        #expect(throws: (any Error).self) { try StopGuard.parseVerdict("TOKEN BROKEN") }
        #expect(try StopGuard.parseVerdict("PROMISE\n") == true)
        #expect(try StopGuard.parseVerdict("OK") == false)
        #expect(try StopGuard.parseVerdict("沒有剩下的工作。結論：OK") == false)
        #expect(try StopGuard.parseVerdict("Nothing is OK yet: it will check the logs itself.\nPROMISE") == true)
        #expect(try StopGuard.parseVerdict("It promised to check, but a subagent is doing it.\nOK\n") == false)
    }

    @Test func choicesAndTheClassifiersOwnRunNeverAsk() async {
        let calls = Calls()
        let choices = await StopGuard.decide(input: input(["last_assistant_message": "Which one?\n<choices>\n- A\n- B\n</choices>"]), environment: [:], classify: classifier(true, calls))
        #expect(choices == .allow)
        let child = await StopGuard.decide(input: input(["last_assistant_message": "I'll check."]), environment: [StopGuard.childMarker: "1"], classify: classifier(true, calls))
        #expect(child == .allow)
        #expect(calls.messages.isEmpty)
        // The classifier's claude runs without hooks or tools.
        let arguments = StopGuard.classifierArguments(message: "hi")
        #expect(arguments.contains(#"{"disableAllHooks":true}"#))
        #expect(arguments.firstIndex(of: "--tools").map { arguments[$0 + 1] } == "")
        #expect(arguments.firstIndex(of: "--model").map { arguments[$0 + 1] } == "haiku")
        #expect(arguments.firstIndex(of: "-p").map { arguments[$0 + 1] } == "<message>\nhi\n</message>")
    }

    @Test func readsTheLastReplyFromTheTranscriptWhenNotGiven() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "ccb-stop-\(UUID().uuidString).jsonl")
        defer { try? FileManager.default.removeItem(at: file) }
        let lines = [
            #"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"接下來我會確認"}]}}"#,
            #"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent text"}]}}"#,
            #"{"type":"system","subtype":"stop_hook_summary"}"#
        ]
        try lines.joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
        let calls = Calls()
        let decision = await StopGuard.decide(input: input(["transcript_path": file.path]), environment: [:], classify: classifier(true, calls))
        #expect(calls.messages == ["接下來我會確認"])
        #expect(decision == .block(reason: StopGuard.blockReason))
    }

    @Test func argumentsCarryTheStopHook() throws {
        var launch = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp"), systemPrompt: "", allowRules: ["Bash(rm -rf build)"])
        launch.stopHookCommand = StopGuard.command(app: "/Applications/Claude Code Bot.app/Contents/MacOS/ClaudeCodeBot", claude: "/Users/me/.local/bin/claude")
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        let json = try #require(arguments.firstIndex(of: "--settings").map { arguments[$0 + 1] })
        let settings = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let stop = try #require(((settings["hooks"] as? [String: Any])?["Stop"] as? [[String: Any]])?.first?["hooks"] as? [[String: Any]])
        #expect(stop.first?["type"] as? String == "command")
        #expect(stop.first?["command"] as? String == "'/Applications/Claude Code Bot.app/Contents/MacOS/ClaudeCodeBot' --stop-guard '/Users/me/.local/bin/claude'")
        #expect((settings["permissions"] as? [String: Any])?["allow"] as? [String] == ["Bash(rm -rf build)"])

        // Without allow rules it still goes in; without the hook nothing changes.
        launch.allowRules = []
        let alone = ClaudeAgentProcess.arguments(for: launch)
        let only = try #require(alone.firstIndex(of: "--settings").map { alone[$0 + 1] })
        #expect(only.contains("Stop") && !only.contains("permissions"))
        launch.stopHookCommand = nil
        #expect(!ClaudeAgentProcess.arguments(for: launch).contains("--settings"))
        #expect(StopGuard.shellQuoted("it's") == #"'it'\''s'"#)
    }
}
