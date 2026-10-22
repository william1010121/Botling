import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexDelegationTests {
    private let expectedPolicy = """
    Delegation ownership policy, scoped by agent role:

    If you are a spawned subagent, execute the assigned task yourself and return evidence. Do not delegate it again. The coordinator restrictions below do not apply to you.

    If you are the main parent agent, use Codex's native subagent tools when delegating; the Claude Code Agent tool name in the generic app instructions is not the tool name to call here.

    For building, fixing, and researching requests, your parent role is orchestration: delegate the entire execution scope to workers, communicate with the user, and synthesize their evidence. Do not reserve a coding, testing, or source-inspection lane for yourself merely to stay busy. A separate parent execution task requires an explicit user assignment.

    After a subagent accepts a task, that subagent owns its scope until it returns a completed or failed result. While it is pending, do not read/search the assigned source, run its tests, edit its files, or perform a parallel version of its task. Do not perform work merely to reassure yourself that progress is happening.

    You may do a different task only when it has an explicitly separate scope and no dependency on the subagent's result. If no such work exists, invoke the native agent-wait tool immediately. Waiting on a dependency is correct progress. Use a long event-driven wait, not repeated short status checks, shell sleeps, or work invented to fill the gap. If the wait times out, wait again while the task remains pending.

    An informational progress note or a request for status does not transfer task ownership back to you. Report known status briefly and then wait again. Do not take over due to elapsed time alone.

    When the worker's completed report contains source locations, concrete inputs/outputs, and test results sufficient to answer the request, directly synthesize those results. Do not reopen the assigned source files or rerun its tests just to reconfirm them. For a specific missing or contradictory fact, send a bounded follow-up question to the same worker and wait for the answer; continue to respect its task ownership. Take over only if the worker explicitly reports it cannot continue, the user reassigns the work, or a new authorized task requires it. Routine memory updates and formatting the worker's evidence for the user are allowed, but must not become a second source audit.
    """

    @Test func ownershipPolicyIsCodexOnlyAndPreservesTheTestedWording() {
        let root = URL(filePath: "/tmp/delegation-prompt")
        for profile in [BotProfile.main(home: root), .manager(name: "Probe", avatar: "square", folder: root)] {
            let claude = BotPrompts(profile: profile).system
            let codex = BotPrompts(profile: profile, engine: .codex).system
            #expect(codex.contains(expectedPolicy))
            #expect(!codex.contains("For this one-small-task experiment"))
            #expect(!codex.contains("then check its work yourself"))
            #expect(claude.contains("; then check its work yourself and say what you found."))
            #expect(!claude.contains("Delegation ownership policy"))
        }
    }

    @Test func ownershipPolicyReachesDeveloperInstructionsOnStartAndResume() throws {
        let root = URL(filePath: "/tmp/delegation-prompt")
        let instructions = BotPrompts(profile: .manager(name: "Probe", avatar: "square", folder: root), engine: .codex).system
        for resume in [nil, "existing-thread"] as [String?] {
            var config = CodexSession.Config(workingDirectory: root, instructions: instructions)
            config.resumeThread = resume
            var session = CodexSession(config: config)
            _ = session.start()
            let output = session.receive(#"{"id":1,"result":{}}"#)
            let request = try #require(output.compactMap { if case let .write(value) = $0 { value } else { nil } }.last)
            #expect(request["method"] as? String == (resume == nil ? "thread/start" : "thread/resume"))
            let params = try #require(request["params"] as? [String: Any])
            #expect(params["developerInstructions"] as? String == instructions)
            #expect((params["developerInstructions"] as? String)?.contains(expectedPolicy) == true)
        }
    }

    /// Export the actual app-generated RPC payload for the opt-in real Codex probe.
    /// CCB_CODEX_DELEGATION_EXPORT=/tmp/evidence swift test --filter CodexDelegationTests
    /// python3 Tests/LiveCodexDelegation/probe.py /tmp/evidence
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_CODEX_DELEGATION_EXPORT"] != nil))
    func exportActualAppRequestsForLiveProbe() throws {
        let root = URL(filePath: try #require(ProcessInfo.processInfo.environment["CCB_CODEX_DELEGATION_EXPORT"]))
        for name in ["baseline", "status"] {
            let folder = root.appending(path: name)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let profile = BotProfile.manager(name: "Probe", avatar: "square", folder: folder)
            let instructions = BotPrompts(profile: profile, language: .traditionalChinese, engine: .codex).system
            var session = CodexSession(config: .init(workingDirectory: folder, instructions: instructions))
            _ = session.start()
            let output = session.receive(#"{"id":1,"result":{}}"#)
            let request = try #require(output.compactMap { if case let .write(value) = $0 { value } else { nil } }.last)
            #expect(request["method"] as? String == "thread/start")
            try JSONSerialization.data(withJSONObject: request, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appending(path: "thread-start.json"))
            try instructions.write(to: folder.appending(path: "developer-instructions.txt"), atomically: true, encoding: .utf8)
        }
    }
}
