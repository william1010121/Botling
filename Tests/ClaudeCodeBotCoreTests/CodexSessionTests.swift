import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The Codex engine: `CodexSession` driven by lines a real `codex app-server` wrote
/// (`CodexRecordings`).
struct CodexSessionTests {
    let bot = URL(filePath: "/tmp/bot")

    /// What a step wrote and which events it gave, apart.
    struct Out {
        var writes: [[String: Any]] = []
        var events: [AgentEvent] = []
        var threads: [String] = []
        var closed = false
        var failed: String?
        var editors: [ComponentEditorAction] = []

        init(_ outputs: [CodexOutput]) {
            for output in outputs {
                switch output {
                case let .write(object): writes.append(object)
                case let .event(event): events.append(event)
                case let .thread(id): threads.append(id)
                case .close: closed = true
                case let .failed(message): failed = message
                case let .componentEditor(action): editors.append(action)
                }
            }
        }

        var methods: [String] { writes.compactMap { $0["method"] as? String } }
        var replies: [(String, Bool)] {
            events.compactMap { if case let .reply(text, isError) = $0 { return (text, isError) } else { return nil } }
        }
        var traces: [TraceEvent] {
            events.compactMap { if case let .trace(step) = $0 { return step } else { return nil } }
        }
        func params(_ method: String) -> [String: Any]? {
            writes.last { $0["method"] as? String == method }?["params"] as? [String: Any]
        }
    }

    func session(_ change: (inout CodexSession.Config) -> Void = { _ in }) -> CodexSession {
        var config = CodexSession.Config(workingDirectory: bot, instructions: "You are a test bot.")
        change(&config)
        return CodexSession(config: config)
    }

    /// Feeds recorded lines, collecting what they give.
    func replay(_ lines: ArraySlice<String>, into session: inout CodexSession) -> Out {
        Out(lines.flatMap { session.receive($0) })
    }

    func lines(_ recording: [String], from start: String, through end: String) -> ArraySlice<String> {
        let first = recording.firstIndex { $0.hasPrefix(start) } ?? recording.startIndex
        let last = recording[first...].firstIndex { $0.hasPrefix(end) } ?? recording.endIndex - 1
        return recording[first...last]
    }

    /// Starts like a bot does: the message comes before the thread exists and waits for it.
    func started(_ session: inout CodexSession, _ text: String, recording: [String]) -> Out {
        var out = Out(session.start())
        out.writes += Out(session.send(.init(text: text))).writes
        let ready = replay(lines(recording, from: #"{"id":1,"#, through: #"{"id":2,"#), into: &session)
        out.writes += ready.writes
        out.threads += ready.threads
        return out
    }

    @Test func startsAThreadWithTheAppsOwnApprovalAndSandboxThenTheFirstMessage() throws {
        var codex = session { $0.writableRoots = [URL(filePath: "/tmp/other")]; $0.effort = .max }
        let out = started(&codex, "Reply with the single word: hello", recording: CodexRecordings.helloAndApproval)

        #expect(out.methods == ["initialize", "initialized", "thread/start", "turn/start"])
        let thread = try #require(out.params("thread/start"))
        // Not the user's ~/.codex/config.toml: the bot asks, and writes only in its folders.
        #expect(thread["approvalPolicy"] as? String == "on-request")
        #expect(thread["sandbox"] as? String == "workspace-write")
        #expect(thread["approvalsReviewer"] as? String == "user")
        #expect(thread["cwd"] as? String == "/tmp/bot")
        #expect(thread["developerInstructions"] as? String == "You are a test bot.")
        let roots = ((thread["config"] as? [String: Any])?["sandbox_workspace_write"] as? [String: Any])?["writable_roots"] as? [String]
        #expect(roots == ["/tmp/other"])
        #expect(out.threads == ["01a1640c-e2db-7742-998a-553a14d4336f"])
        let turn = try #require(out.params("turn/start"))
        #expect((turn["input"] as? [[String: Any]])?.first?["text"] as? String == "Reply with the single word: hello")
        #expect(turn["effort"] as? String == "xhigh")
    }

    @Test func autoModeLetsCodexsReviewerAnswer() throws {
        var codex = session { $0.autoMode = true }
        let out = started(&codex, "hi", recording: CodexRecordings.helloAndApproval)
        #expect(out.params("thread/start")?["approvalsReviewer"] as? String == "auto_review")
    }

    @Test func aTurnEndsWithItsFinalAnswerAndTheTokensItUsed() {
        var codex = session()
        _ = started(&codex, "Reply with the single word: hello", recording: CodexRecordings.helloAndApproval)
        let out = replay(lines(CodexRecordings.helloAndApproval, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)

        #expect(out.replies.count == 1)
        #expect(out.replies.first?.0 == "hello")
        #expect(out.replies.first?.1 == false)
        let usage = out.events.compactMap { if case let .usage(cost, tokens) = $0 { return (cost, tokens) } else { return nil } }
        #expect(usage.count == 1)
        #expect(usage.first?.0 == 0)
        #expect((usage.first?.1.total ?? 0) > 0)
    }

    @Test func aCommandThatNeedsApprovalAsksAndTheAnswerGoesBack() throws {
        var codex = session()
        let recording = CodexRecordings.helloAndApproval
        _ = started(&codex, "first", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "Run the shell command: echo hi > note.txt")))
        let asked = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"item/commandExecution/requestApproval""#), into: &codex)

        // What it said before the call is a step; the call is a step with the command alone.
        #expect(asked.traces.contains(.text("I’ll run it with the required approval request.", parent: nil)))
        #expect(asked.traces.contains { if case let .toolUse(_, tool, title, detail, _) = $0 { tool == "Bash" && title == "Run echo hi > note.txt" && detail == "echo hi > note.txt" } else { false } })
        let request = try #require(asked.events.compactMap { if case let .permission(request) = $0 { request } else { nil } }.first)
        #expect(request.id == "0")
        #expect(request.tool == "Bash")
        #expect(request.summary.hasPrefix("/bin/zsh -lc 'echo hi > note.txt'"))

        let answer = Out(codex.answer(request.id, allow: true))
        #expect(answer.writes.count == 1)
        #expect(answer.writes.first?["id"] as? Int == 0)
        #expect((answer.writes.first?["result"] as? [String: Any])?["decision"] as? String == "accept")
        // Answered here: its "resolved" line closes nothing more.
        let rest = replay(lines(recording, from: #"{"method":"serverRequest/resolved""#, through: #"{"method":"turn/completed""#).dropFirst(0), into: &codex)
        #expect(!rest.events.contains { if case .permissionCancelled = $0 { true } else { false } })
        #expect(rest.traces.contains { if case let .toolResult(_, _, failed, _) = $0 { !failed } else { false } })
        #expect(rest.replies.map(\.0) == ["Wrote `hi` to `note.txt`."])
    }

    @Test func aQuestionCodexStopsWaitingForIsTakenBack() {
        var codex = session()
        let recording = CodexRecordings.helloAndApproval
        _ = started(&codex, "first", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "second")))
        _ = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"item/commandExecution/requestApproval""#), into: &codex)
        let resolved = replay(lines(recording, from: #"{"method":"serverRequest/resolved""#, through: #"{"method":"serverRequest/resolved""#), into: &codex)
        #expect(resolved.events == [.permissionCancelled("0")])
        // Answering it late writes nothing.
        #expect(Out(codex.answer("0", allow: true)).writes.isEmpty)
    }

    @Test func aFileWrittenWithAPatchIsAWriteStep() {
        var codex = session()
        let recording = CodexRecordings.editSteerInterrupt
        _ = started(&codex, "Create a file a.txt", recording: recording)
        let out = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)

        #expect(out.traces.contains { if case let .toolUse(_, tool, title, detail, _) = $0 { tool == "Write" && title == "Write a.txt" && detail == "/tmp/bot/a.txt" } else { false } })
        #expect(out.traces.contains { if case let .toolResult(_, output, failed, _) = $0 { output == "x\n" && !failed } else { false } })
        #expect(out.replies.map(\.0) == ["done"])
    }

    @Test func aMessageWhileATurnRunsJoinsThatTurn() throws {
        var codex = session()
        let recording = CodexRecordings.editSteerInterrupt
        _ = started(&codex, "Create a file a.txt", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "Run the shell command `sleep 6`")))
        _ = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"turn/started""#), into: &codex)

        let steer = Out(codex.send(.init(text: "Also add the word second")))
        #expect(steer.methods == ["turn/steer"])
        #expect(steer.params("turn/steer")?["expectedTurnId"] as? String == "01a1640e-5237-70d3-8f42-e248278ed135")
        let out = replay(lines(recording, from: #"{"id":5,"#, through: #"{"method":"turn/completed""#), into: &codex)
        // One reply answers both.
        #expect(out.replies.map(\.0) == ["first second"])
    }

    @Test func aMessageSentBeforeTheTurnHasAnIdWaitsToSteer() {
        var codex = session()
        let recording = CodexRecordings.editSteerInterrupt
        _ = started(&codex, "Create a file a.txt", recording: recording)
        #expect(Out(codex.send(.init(text: "and this"))).writes.isEmpty)
        let known = replay(lines(recording, from: #"{"id":3,"#, through: #"{"id":3,"#), into: &codex)
        #expect(known.methods == ["turn/steer"])
    }

    /// Like claude's `send_now` interrupt: the turn stops (an error result the bot hides) and
    /// the message just sent goes as a turn of its own.
    @Test func interruptStopsTheTurnAndSendsTheLastMessageAgain() throws {
        var codex = session()
        let recording = CodexRecordings.editSteerInterrupt
        _ = started(&codex, "first", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "second")))
        _ = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "Run the shell command `sleep 30` then say hi.")))
        _ = replay(lines(recording, from: #"{"id":6,"#, through: #"{"method":"turn/started""#), into: &codex)

        let added = Out(codex.send(.init(text: "All of it, in one")))
        let interrupt = Out(codex.interrupt())
        #expect(added.methods == ["turn/steer"])
        #expect(interrupt.methods == ["turn/interrupt"])
        #expect(interrupt.params("turn/interrupt")?["turnId"] as? String == "01a1640e-79ed-76f2-8886-2d3a444d1fd6")
        // A second interrupt for the same turn sends nothing more.
        #expect(Out(codex.interrupt()).writes.isEmpty)

        let out = replay(lines(recording, from: #"{"id":7,"#, through: #"{"method":"turn/completed""#), into: &codex)
        #expect(out.replies.count == 1)
        #expect(out.replies.first?.0 == "")
        #expect(out.replies.first?.1 == true)
        #expect(out.methods == ["turn/start"])
        let again = try #require(out.params("turn/start"))
        #expect((again["input"] as? [[String: Any]])?.first?["text"] as? String == "All of it, in one")
    }

    @Test(arguments: [false, true])
    func cancellingAssignmentDoesNotReplayContextSteerAndPreservesQueuedInput(queueAnother: Bool) throws {
        var codex = session()
        let recording = CodexRecordings.editSteerInterrupt
        _ = started(&codex, "first", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "second")))
        _ = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "Run the shell command `sleep 30` then say hi.")))
        _ = replay(lines(recording, from: #"{"id":6,"#, through: #"{"method":"turn/started""#), into: &codex)
        _ = codex.send(.init(text: "Peer context from the cancelled assignment"))
        if queueAnother { _ = codex.send(.init(text: "Independent next assignment", id: UUID())) }
        let cancelled = Out(codex.cancelTurn())
        #expect(cancelled.methods == ["turn/interrupt"])
        let out = replay(lines(recording, from: #"{"id":7,"#, through: #"{"method":"turn/completed""#), into: &codex)
        #expect(out.replies.first?.1 == true)
        if queueAnother {
            let next = try #require(out.params("turn/start"))
            #expect((next["input"] as? [[String: Any]])?.first?["text"] as? String == "Independent next assignment")
        } else {
            #expect(!out.methods.contains("turn/start"))
        }
    }

    @Test func aMessageWithAnIdWaitsForATurnOfItsOwn() {
        var codex = session()
        let recording = CodexRecordings.editSteerInterrupt
        _ = started(&codex, "first", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/started""#), into: &codex)
        let id = UUID()
        let queued = Out(codex.send(.init(text: "for the group", id: id)))
        #expect(queued.events == [.commandQueued(id)])
        #expect(queued.writes.isEmpty)

        let ended = replay(lines(recording, from: #"{"method":"item/started""#, through: #"{"method":"turn/completed""#), into: &codex)
        #expect(ended.methods == ["turn/start"])
        let next = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"turn/started""#), into: &codex)
        #expect(next.events.first == .commandStarted(id))
    }

    @Test func finishWaitsForTheTurnThenCloses() {
        var codex = session()
        let recording = CodexRecordings.helloAndApproval
        _ = started(&codex, "hello", recording: recording)
        #expect(!Out(codex.finish()).closed)
        let out = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        #expect(out.closed)
        #expect(out.replies.map(\.0) == ["hello"])
    }

    @Test func finishWhenIdleClosesAtOnce() {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        _ = replay(lines(CodexRecordings.helloAndApproval, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        #expect(Out(codex.finish()).closed)
    }

    @Test func resumingGoesOnInTheSameThread() throws {
        var codex = session { $0.resumeThread = "01a1640e-307d-76b3-ac16-5e7333057ab0" }
        let recording = CodexRecordings.resumed
        let out = started(&codex, "What file did you create earlier? One line.", recording: recording)
        #expect(out.methods == ["initialize", "initialized", "thread/resume", "turn/start"])
        #expect(out.params("thread/resume")?["threadId"] as? String == "01a1640e-307d-76b3-ac16-5e7333057ab0")
        #expect(out.params("thread/resume")?["sandbox"] as? String == "workspace-write")
        let turn = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        #expect(turn.replies.map(\.0) == ["I created `a.txt` containing the single line `x`."])
    }

    @Test func aThreadThatCannotStartEndsTheProcess() {
        var codex = session { $0.resumeThread = "gone" }
        _ = codex.start()
        _ = codex.receive(CodexRecordings.resumed[0])
        let out = Out(codex.receive(#"{"id":2,"error":{"code":-32600,"message":"thread not found: gone"}}"#))
        #expect(out.failed == "thread not found: gone")
    }

    @Test func aTurnCutOffFromTheAPISaysSo() {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        _ = codex.receive(#"{"id":3,"result":{"turn":{"id":"t1","items":[],"status":"inProgress"}}}"#)
        let retry = Out(codex.receive(#"{"method":"error","params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turnId":"t1","willRetry":true,"error":{"message":"stream disconnected","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}}}}}"#))
        #expect(retry.events == [.connectionTrouble(attempt: 1, maxRetries: 0)])
        let failed = Out(codex.receive(#"{"method":"turn/completed","params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turn":{"id":"t1","items":[],"status":"failed","error":{"message":"stream disconnected","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}}}}}}"#))
        #expect(failed.events == [.connectionLost(parent: nil), .reply("stream disconnected", isError: true)])
    }

    @Test func requestsTheAppCannotAnswerGetAnErrorSoNothingWaits() {
        var codex = session()
        let out = Out(codex.receive(#"{"method":"item/tool/requestUserInput","id":9,"params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turnId":"t","itemId":"i","isBlocking":true,"questions":[]}}"#))
        #expect(out.writes.first?["id"] as? Int == 9)
        #expect(out.writes.first?["error"] != nil)
        #expect(out.events.isEmpty)
    }

    @Test func threadsAreRememberedBySession() throws {
        let threads = CodexThreads(folder: FileManager.default.temporaryDirectory.appending(path: "ccb-codex-\(UUID().uuidString)"))
        let session = UUID()
        #expect(threads.thread(for: session) == nil)
        var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: session, resume: true, workingDirectory: bot, systemPrompt: "x")
        #expect(throws: (any Error).self) { try CodexAgentProcess.config(for: launch, threads: threads) }
        threads.save("01a1640e-307d-76b3-ac16-5e7333057ab0", for: session)
        #expect(try CodexAgentProcess.config(for: launch, threads: threads).resumeThread == "01a1640e-307d-76b3-ac16-5e7333057ab0")
        launch.resume = false
        #expect(try CodexAgentProcess.config(for: launch, threads: threads).resumeThread == nil)
    }

    // MARK: P4: limits, the reviewer, refusals, subagents, models

    @Test func codexsLimitsAreItsOwn() {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        let out = Out(codex.receive(#"{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":5,"windowDurationMins":10080,"resetsAt":1793085764},"secondary":{"usedPercent":40,"windowDurationMins":300,"resetsAt":1793000000}}}}"#))
        guard case let .codexRateLimits(limits)? = out.events.first else {
            Issue.record("no limits: \(out.events)")
            return
        }
        #expect(limits.week?.used == 0.05)
        #expect(limits.fiveHour?.used == 0.4)
        #expect(limits.week?.resetsAt == Date(timeIntervalSince1970: 1793085764))
    }

    @Test func aCallTheReviewerRefusedIsACardAndAllowingItLetsItThroughOnce() throws {
        var codex = session { $0.autoMode = true }
        let recording = CodexRecordings.helloAndApproval
        _ = started(&codex, "first", recording: recording)
        _ = codex.receive(#"{"id":3,"result":{"turn":{"id":"t1","items":[],"status":"inProgress"}}}"#)
        let denied = Out(codex.receive(#"{"method":"item/autoApprovalReview/completed","params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turnId":"t1","reviewId":"r1","targetItemId":"exec-1","startedAtMs":1,"completedAtMs":2,"decisionSource":"agent","action":{"type":"command","command":"rm -rf build","cwd":"/tmp/bot","source":"shell"},"review":{"status":"denied","riskLevel":"high","rationale":"Deletes files."}}}"#))
        #expect(denied.traces == [.toolUse(id: "exec-1", tool: "Bash", title: "Run rm -rf build", detail: "rm -rf build", parent: nil)])
        #expect(denied.events.last == .permissionDenied(PermissionDenial(toolUseID: "exec-1", tool: "Bash", reason: "[high risk] Deletes files.", confirmed: true)))

        _ = codex.allow(rules: ["Bash(rm -rf build)"])
        _ = codex.receive(#"{"method":"turn/completed","params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turn":{"id":"t1","items":[],"status":"completed"}}}"#)
        let next = Out(codex.send(.init(text: "(App: The user allowed it. Run it again.)")))
        #expect(next.params("turn/start")?["approvalsReviewer"] as? String == "user")
        _ = codex.receive(#"{"id":4,"result":{"turn":{"id":"t2","items":[],"status":"inProgress"}}}"#)
        let asked = Out(codex.receive(#"{"method":"item/commandExecution/requestApproval","id":7,"params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turnId":"t2","itemId":"exec-2","startedAtMs":1,"command":"/bin/zsh -lc 'rm -rf build'","commandActions":[{"type":"unknown","command":"rm -rf build"}]}}"#))
        #expect(asked.events.isEmpty)
        #expect((asked.writes.first?["result"] as? [String: Any])?["decision"] as? String == "accept")
        _ = codex.receive(#"{"method":"turn/completed","params":{"threadId":"01a1640c-e2db-7742-998a-553a14d4336f","turn":{"id":"t2","items":[],"status":"completed"}}}"#)
        // The turn after goes back to Codex's reviewer.
        #expect(Out(codex.send(.init(text: "next"))).params("turn/start")?["approvalsReviewer"] as? String == "auto_review")
    }

    @Test func whyTheUserSaidNoReachesTheTurn() {
        var codex = session()
        let recording = CodexRecordings.helloAndApproval
        _ = started(&codex, "first", recording: recording)
        _ = replay(lines(recording, from: #"{"id":3,"#, through: #"{"method":"turn/completed""#), into: &codex)
        _ = Out(codex.send(.init(text: "second")))
        _ = replay(lines(recording, from: #"{"id":4,"#, through: #"{"method":"item/commandExecution/requestApproval""#), into: &codex)
        let out = Out(codex.answer("0", allow: false, message: "The user did not allow it and said: use a temp folder"))
        #expect((out.writes.first?["result"] as? [String: Any])?["decision"] as? String == "decline")
        #expect(out.methods == ["turn/steer"])
        let input = (out.params("turn/steer")?["input"] as? [[String: Any]])?.first?["text"] as? String
        #expect(input == "(App: The user did not allow it and said: use a temp folder)")
    }

    @Test func codexsOwnSubagentsAreSubagentRows() {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        _ = codex.receive(#"{"id":3,"result":{"turn":{"id":"t1","items":[],"status":"inProgress"}}}"#)
        let main = "01a1640c-e2db-7742-998a-553a14d4336f"
        let spawn = Out(codex.receive(#"{"method":"item/started","params":{"threadId":"\#(main)","turnId":"t1","startedAtMs":1,"item":{"type":"collabAgentToolCall","id":"call-1","tool":"spawnAgent","prompt":"Read a.txt and report","receiverThreadIds":[],"senderThreadId":"\#(main)","agentsStates":{},"status":"inProgress"}}}"#))
        #expect(spawn.traces == [.toolUse(id: "call-1", tool: "Agent", title: "Delegate Read a.txt and report", detail: "Read a.txt and report", parent: nil)])
        let spawned = Out(codex.receive(#"{"method":"item/completed","params":{"threadId":"\#(main)","turnId":"t1","item":{"type":"collabAgentToolCall","id":"call-1","tool":"spawnAgent","prompt":"Read a.txt and report","receiverThreadIds":["sub-1"],"senderThreadId":"\#(main)","agentsStates":{"sub-1":{"status":"running"}},"status":"completed"}}}"#))
        #expect(spawned.traces == [.subagentStarted(id: "call-1", description: "Read a.txt and report", type: "codex", prompt: "Read a.txt and report", background: false)])
        let step = Out(codex.receive(#"{"method":"item/started","params":{"threadId":"sub-1","turnId":"s1","startedAtMs":1,"item":{"type":"commandExecution","id":"exec-9","command":"cat a.txt","commandActions":[],"cwd":"/tmp/bot","status":"inProgress"}}}"#))
        #expect(step.traces == [.toolUse(id: "exec-9", tool: "Bash", title: "Run cat a.txt", detail: "cat a.txt", parent: "call-1")])
        _ = codex.receive(#"{"method":"item/completed","params":{"threadId":"sub-1","turnId":"s1","item":{"type":"agentMessage","id":"m1","text":"It says hello.","phase":"final_answer"}}}"#)
        let ended = Out(codex.receive(#"{"method":"turn/completed","params":{"threadId":"sub-1","turn":{"id":"s1","items":[],"status":"completed"}}}"#))
        #expect(ended.traces == [.subagentEnded(id: "call-1", status: "completed", summary: "It says hello.")])
        // The subagent's turn is not the bot's: its turn goes on.
        #expect(ended.replies.isEmpty)
    }

    /// codex-cli 0.163 says a subagent started, was messaged and finished with `subAgentActivity`
    /// items (from a real session's rollout), not a `spawnAgent` collab call.
    @Test func codexsSubAgentActivityMakesSubagentRows() {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        _ = codex.receive(#"{"id":3,"result":{"turn":{"id":"t1","items":[],"status":"inProgress"}}}"#)
        let main = "01a1640c-e2db-7742-998a-553a14d4336f"
        let avatar = "01a1649e-b6d9-74e1-af02-f607f7798771", answer = "01a1649e-d729-70a2-9a12-9c82a5b60d43"
        func activity(_ id: String, _ kind: String, _ thread: String, _ path: String, model: String? = nil) -> String {
            let model = model.map { #""\#($0)""# } ?? "null"
            return #"{"method":"item/completed","params":{"threadId":"\#(main)","turnId":"t1","completedAtMs":1,"item":{"type":"subAgentActivity","id":"\#(id)","kind":"\#(kind)","agentThreadId":"\#(thread)","agentPath":"\#(path)","model":\#(model),"reasoningEffort":null}}}"#
        }
        let first = Out(codex.receive(activity("call_b04ae0dd7eaa4188ab14deae2cc56756", "started", avatar, "/root/avatar_coverage", model: "gpt-6.1-sol")))
        #expect(first.traces == [
            .subagentStarted(id: "call_b04ae0dd7eaa4188ab14deae2cc56756", description: "avatar coverage", type: "codex", prompt: "", background: false),
            .launchResult(id: "call_b04ae0dd7eaa4188ab14deae2cc56756", result: LaunchResult(agentID: avatar), parent: nil),
            .subagentNamed(id: "call_b04ae0dd7eaa4188ab14deae2cc56756", name: "/root/avatar_coverage"),
            .subagentModel(id: "call_b04ae0dd7eaa4188ab14deae2cc56756", model: "gpt-6.1-sol"),
        ])
        let second = Out(codex.receive(activity("call_254739fa78b349a9946e2ca4ce0a22a4", "started", answer, "/root/answer_persistence")))
        #expect(second.traces == [
            .subagentStarted(id: "call_254739fa78b349a9946e2ca4ce0a22a4", description: "answer persistence", type: "codex", prompt: "", background: false),
            .launchResult(id: "call_254739fa78b349a9946e2ca4ce0a22a4", result: LaunchResult(agentID: answer), parent: nil),
            .subagentNamed(id: "call_254739fa78b349a9946e2ca4ce0a22a4", name: "/root/answer_persistence"),
        ])
        // Its own thread's steps go under it.
        let step = Out(codex.receive(#"{"method":"item/started","params":{"threadId":"\#(avatar)","turnId":"01a1649e-b726-7851-a6f4-bfa4863745eb","startedAtMs":1,"item":{"type":"commandExecution","id":"exec-9","command":"ls Tests","commandActions":[],"cwd":"/tmp/bot","status":"inProgress"}}}"#))
        #expect(step.traces == [.toolUse(id: "exec-9", tool: "Bash", title: "Run ls Tests", detail: "ls Tests", parent: "call_b04ae0dd7eaa4188ab14deae2cc56756")])
        // Messaging it again is not a new row.
        #expect(Out(codex.receive(activity("call_7654dc23d56746a29d6e1c38811fae41", "interacted", avatar, "/root/avatar_coverage"))).traces.isEmpty)
        _ = codex.receive(#"{"method":"item/completed","params":{"threadId":"\#(answer)","turnId":"01a1649e-d76c-75d3-9590-a40ab468165f","completedAtMs":1,"item":{"type":"agentMessage","id":"m1","text":"Answer choices persist.","phase":"final_answer"}}}"#)
        // Its turn ending is not the end: the parent's activity item says when it is done.
        #expect(Out(codex.receive(#"{"method":"turn/completed","params":{"threadId":"\#(answer)","turn":{"id":"01a1649e-d76c-75d3-9590-a40ab468165f","items":[],"status":"completed"}}}"#)).traces.isEmpty)
        let done = Out(codex.receive(activity("subagent-completed-01a1649e-d76c-75d3-9590-a40ab468165f", "completed", answer, "/root/answer_persistence")))
        #expect(done.traces == [.subagentEnded(id: "call_254739fa78b349a9946e2ca4ce0a22a4", status: "completed", summary: "Answer choices persist.")])
        let stopped = Out(codex.receive(activity("call_x", "interrupted", avatar, "/root/avatar_coverage")))
        #expect(stopped.traces == [.subagentEnded(id: "call_b04ae0dd7eaa4188ab14deae2cc56756", status: "killed", summary: nil)])
        #expect(done.replies.isEmpty && stopped.replies.isEmpty)
    }

    @Test func activitySubagentsResumeOnlyWhenTheirNextTurnStarts() throws {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        let main = "01a1640c-e2db-7742-998a-553a14d4336f"
        func activity(_ id: String, _ kind: String) -> String {
            #"{"method":"item/completed","params":{"threadId":"\#(main)","item":{"type":"subAgentActivity","id":"\#(id)","kind":"\#(kind)","agentThreadId":"child","agentPath":"/root/review_work"}}}"#
        }
        var book = TraceBook()
        func apply(_ out: Out) { for step in out.traces { book.apply(step) } }
        apply(Out(codex.receive(activity("spawn", "started"))))
        #expect(try #require(book.subagent("spawn")).agentID == "child")
        #expect(try #require(book.subagent("spawn")).name == "/root/review_work")
        let firstEnd = Out(codex.receive(activity("done-turn-1", "completed")))
        apply(firstEnd)
        #expect(try #require(book.subagent("spawn")).status == .completed)
        #expect(Out(codex.receive(activity("done-turn-1", "completed"))).traces.isEmpty)
        #expect(Out(codex.receive(activity("another-terminal-before-restart", "interrupted"))).traces.isEmpty)
        // A message to an idle agent does not itself start more work.
        apply(Out(codex.receive(activity("message", "interacted"))))
        #expect(try #require(book.subagent("spawn")).status == .completed)
        let resumed = Out(codex.receive(#"{"method":"turn/started","params":{"threadId":"child","turn":{"id":"child-turn-2","status":"inProgress"}}}"#))
        apply(resumed)
        #expect(try #require(book.subagent("spawn")).isRunning)
        #expect(try #require(book.subagent("spawn")).endedAt == nil)
        #expect(book.subagents.count == 1)
        #expect(Out(codex.receive(activity("done-turn-1", "completed"))).traces.isEmpty)
        let secondEnd = Out(codex.receive(activity("done-turn-2", "completed")))
        #expect(secondEnd.traces == [.subagentEnded(id: "spawn", status: "completed", summary: nil)])
        apply(secondEnd)
        #expect(try #require(book.subagent("spawn")).status == .completed)
        #expect(secondEnd.replies.isEmpty && resumed.replies.isEmpty)
    }

    @Test func realSubagentFollowupStreamKeepsBothRunsUnderOneRow() throws {
        var codex = session()
        _ = started(&codex, "hello", recording: CodexRecordings.helloAndApproval)
        var book = TraceBook()
        var starts = 0, ends = 0
        let spawn = "call_23510994370442fc9af5e9ca6d065525"
        for line in CodexRecordings.subagentFollowup {
            let out = Out(codex.receive(line))
            #expect(out.replies.isEmpty)
            for step in out.traces {
                if case .subagentStarted = step { starts += 1 }
                if case .subagentEnded = step { ends += 1 }
                book.apply(step)
                if case .subagentStarted = step {
                    #expect(try #require(book.subagent(spawn)).isRunning)
                }
            }
        }
        let agent = try #require(book.subagent(spawn))
        #expect(starts == 2 && ends == 2)
        #expect(book.subagents.count == 1)
        #expect(agent.agentID == "probe-child")
        #expect(agent.status == .completed)
        #expect(agent.steps.filter { $0.kind == .tool }.count == 2)
        #expect(agent.steps.filter { $0.kind == .tool }.allSatisfy { $0.done })
        #expect(agent.steps.filter { $0.kind == .text }.count == 2)
    }

    @Test func aPickedModelGoesToTheThread() {
        var codex = session { $0.model = "gpt-5.5-codex" }
        let out = started(&codex, "hi", recording: CodexRecordings.helloAndApproval)
        #expect(out.params("thread/start")?["model"] as? String == "gpt-5.5-codex")
    }

    @Test func theModelListIsRead() {
        let line = #"{"id":2,"result":{"data":[{"id":"a","displayName":"Model A","isDefault":true,"hidden":false},{"id":"b","displayName":"Hidden","isDefault":false,"hidden":true},{"id":"c","displayName":"Model C","isDefault":false,"hidden":false}],"nextCursor":null}}"#
        #expect(CodexModels.parse(line) == [CodexModel(id: "a", name: "Model A", isDefault: true), CodexModel(id: "c", name: "Model C", isDefault: false)])
        #expect(CodexModels.parse(#"{"id":1,"result":{}}"#) == nil)
    }
}
