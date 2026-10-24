import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct PromiseCheckTests {
    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var _messages: [String] = []
        func add(_ message: String) { lock.withLock { _messages.append(message) } }
        var messages: [String] { lock.withLock { _messages } }
    }

    @Test func pendingWorkStillGetsSemanticJudgmentWithAuthorizationAndEvidence() async throws {
        let calls = Calls()
        let end = PromiseCheck.TurnEnd(reply: "GPU3 idle; thinking next", workPending: true,
            task: "Analyze while either GPU idle. Research only.", conversation: "[user] continue research",
            dependencies: ["GPU2 experiment", "30 minute fallback monitor"], actions: ["SSH: GPU3 idle"])
        let judgment = await PromiseCheck.check(end) { input in calls.add(input); return .continueWork }
        #expect(judgment.verdict == .continueWork)
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(try #require(calls.messages.first).utf8))
        #expect(decoded == end)
    }

    @Test func emptyReplyIsUnknownAndErrorsAreUnavailable() async {
        #expect(await PromiseCheck.check(.init(reply: " ", workPending: false)) { _ in Issue.record("must not call"); return .complete } == .unknown)
        #expect(await PromiseCheck.check(.init(reply: "I'll check.", workPending: false)) { _ in throw CocoaError(.executableLoad) } == .unavailable)
    }

    @Test func eachSemanticVerdictIsPreservedAndParsingIsStrict() async throws {
        for verdict in [PromiseCheck.Verdict.continueWork, .complete, .waitingUser, .cancelled, .waitingDependency, .unknown] {
            let json = "{\"verdict\":\"\(verdict.rawValue)\",\"reason\":\"Concrete evidence.\"}"
            #expect(try PromiseCheck.parseVerdict(json).verdict == verdict)
            #expect(await PromiseCheck.check(.init(reply: "question or result", workPending: true)) { _ in .init(verdict: verdict, reason: "Concrete evidence.") }.verdict == verdict)
        }
        for malformed in ["Error: CONTINUE", "CONTINUE then COMPLETE", "YES", "UNAVAILABLE", ""] {
            #expect(throws: (any Error).self) { try PromiseCheck.parseVerdict(malformed) }
        }
    }

    @Test func contextIsBoundedWithoutLosingAuthorizationPrefixOrSuffix() throws {
        let end = PromiseCheck.TurnEnd(reply: String(repeating: "r", count: 20000), workPending: true,
            task: "RESEARCH ONLY" + String(repeating: "x", count: 20000) + "DO NOT IMPLEMENT",
            conversation: String(repeating: "c", count: 20000) + "STOP",
            dependencies: Array(repeating: String(repeating: "d", count: 2000), count: 100))
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(PromiseCheck.classifierMessage(end).utf8))
        #expect(decoded.task.hasPrefix("RESEARCH ONLY"))
        #expect(decoded.task.hasSuffix("DO NOT IMPLEMENT"))
        #expect(decoded.reply.count == 6000)
        #expect(decoded.conversation.count == 12000)
        #expect(decoded.conversation.hasSuffix("STOP"))
        #expect(decoded.dependencies.count == 24)
        #expect(decoded.dependencies.allSatisfy { $0.count == 1200 })
    }

    @Test func theClassifierUsesVerifiedLunaIndependentlyOfUserDefaults() {
        let root = URL(filePath: "/tmp/isolated-judge")
        let arguments = PromiseCheck.classifierArguments(message: "hi", folder: root)
        #expect(arguments.first == "exec")
        #expect(arguments.firstIndex(of: "--model").map { arguments[$0 + 1] } == "gpt-6-luna")
        #expect(arguments.contains(#"model_reasoning_effort="medium""#))
        for flag in ["--ephemeral", "--ignore-user-config", "read-only", "shell_tool", "unified_exec", "multi_agent", "plugins", "hooks", "--output-schema", "--output-last-message"] {
            #expect(arguments.contains(flag))
        }
        #expect(!arguments.contains("--dangerously-bypass-approvals-and-sandbox"))
    }

    @Test func providerToolCallsAndMissingCompletionAreRejected() throws {
        try PromiseCheck.validateCodexEvents(#"{"type":"item.completed","item":{"type":"agent_message","text":"result"}}"# + "\n" + #"{"type":"turn.completed"}"#)
        for output in [#"{"type":"item.started","item":{"type":"command_execution"}}"#, #"{"type":"turn.failed"}"#, #"{"type":"thread.started"}"#] {
            #expect(throws: (any Error).self) { try PromiseCheck.validateCodexEvents(output) }
        }
    }

    @Test func missingProviderIsUnavailableWithAConcreteReason() async {
        let verdict = await PromiseCheck.check(.init(reply: "I'll analyze next", workPending: false), classify: PromiseCheck.codexClassifier(locate: { nil }))
        #expect(verdict.verdict == .unavailable)
        #expect(verdict.reason.contains("Codex was not found"))
    }

    @Test func botSettingsHaveNoStopHook() throws {
        let launch = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp"), systemPrompt: "", allowRules: ["Bash(rm -rf build)"])
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        let json = try #require(arguments.firstIndex(of: "--settings").map { arguments[$0 + 1] })
        let settings = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        #expect(settings["hooks"] == nil)
        #expect((settings["permissions"] as? [String: Any])?["allow"] as? [String] == ["Bash(rm -rf build)"])
        #expect(!arguments.contains("--include-partial-messages"))
    }
}

extension PromiseCheckTests {
    @Test(arguments: ["success", "failure", "timeout", "malformed", "tool"])
    func actualProviderProcessTransportValidatesFailureAndStructuredOutput(_ mode: String) async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-judge-transport-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let executable = folder.appending(path: "codex-fixture")
        let script: String
        switch mode {
        case "timeout": script = "#!/bin/sh\nexec /bin/sleep 5\n"
        case "failure": script = "#!/bin/sh\nexit 64\n"
        default:
            let result = mode == "malformed" ? #"{"verdict":"COMPLETE","reason":""}"# : #"{"verdict":"CONTINUE","reason":"GPU3 analysis is unperformed."}"#
            let event = mode == "tool" ? #"{"type":"item.started","item":{"type":"command_execution"}}"# : #"{"type":"item.completed","item":{"type":"agent_message"}}"#
            script = """
            #!/bin/sh
            while [ "$#" -gt 0 ]; do
              if [ "$1" = "--output-last-message" ]; then shift; result_path="$1"; fi
              shift
            done
            printf '%s' '\(result)' > "$result_path"
            printf '%s\\n' '\(event)' '{"type":"turn.completed"}'
            """
        }
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let judgment = await PromiseCheck.check(.init(reply: "GPU3 idle", workPending: false),
            classify: PromiseCheck.codexClassifier(executable: executable, timeout: mode == "timeout" ? 0.1 : 3))
        #expect(judgment.verdict == (mode == "success" ? .continueWork : .unavailable))
        #expect(!judgment.reason.isEmpty)
        if mode == "timeout" { #expect(judgment.reason.contains("time limit")) }
        if mode == "tool" { #expect(judgment.reason.contains("tool call")) }
    }
}

extension PromiseCheckTests {
    @Test func multibyteEvidenceCannotOverflowTheProviderArgumentBudget() throws {
        let huge = String(repeating: "資料分析", count: 20000)
        let end = PromiseCheck.TurnEnd(reply: huge, workPending: true, task: "RESEARCH ONLY" + huge + "NO IMPLEMENTATION",
            conversation: huge + "LATEST USER STOP", dependencies: Array(repeating: huge, count: 24),
            actions: Array(repeating: huge, count: 12), memory: huge,
            signals: Array(repeating: .init(kind: .end, evidence: huge), count: 4))
        let payload = PromiseCheck.classifierMessage(end)
        #expect(payload.utf8.count <= 96000)
        let decoded = try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: Data(payload.utf8))
        #expect(decoded.evidenceTruncated)
        #expect(decoded.task.hasPrefix("RESEARCH ONLY"))
        #expect(decoded.task.hasSuffix("NO IMPLEMENTATION"))
        #expect(decoded.conversation.hasSuffix("LATEST USER STOP"))
    }
}
