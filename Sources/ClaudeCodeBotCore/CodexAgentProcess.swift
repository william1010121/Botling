import Foundation

/// Persisted app task identity. Execution itself belongs to a live app-server process;
/// unfinished records become interrupted results after restart, never phantom running cards.
struct CodexManagedWorkerRecord: Codable, Equatable {
    var id: String
    var name: String
    var instructions: String
    var thread: String?
    var run: Int
    var wasActive: Bool
    var reportPending = false
    var report: String?
    var status: String?
    var turn: String?
    var tokens: TokenUsage?
    var runtime: WorkerRuntimeInfo?
    var reconciliationAttempt: Int?
}

/// Which Codex thread each bot session is: `codex app-server` names its threads itself, while a
/// bot names its session (a UUID) before it starts. One small file per session, holding the
/// thread's id, so a later process can `thread/resume` it. Under `~/.claudecodebot/codex-threads`.
public final class CodexThreads: @unchecked Sendable {
    public static let shared = CodexThreads(folder: FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claudecodebot/codex-threads"))

    private let lock = NSLock()
    private var folderURL: URL

    public init(folder: URL) {
        folderURL = folder
    }

    /// Where the files are; the app points it into its own root.
    public var folder: URL {
        get { lock.withLock { folderURL } }
        set { lock.withLock { folderURL = newValue } }
    }

    public func thread(for session: UUID) -> String? {
        let url = folder.appending(path: session.uuidString.lowercased())
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let id = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    public func save(_ thread: String, for session: UUID) {
        let folder = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let old = self.thread(for: session), old != thread {
            // Keep the old CLI transcript discoverable when tool-schema upgrades require a
            // new coordinator. App chat/session IDs and worker records are never moved.
            let lineage = folder.appending(path: session.uuidString.lowercased() + ".previous-threads")
            var data = (try? Data(contentsOf: lineage)) ?? Data()
            if !String(decoding: data, as: UTF8.self).split(separator: "\n").contains(Substring(old)) {
                data.append(Data((old + "\n").utf8))
                guard (try? data.write(to: lineage, options: .atomic)) != nil else { return }
            }
        }
        try? Data(thread.utf8).write(to: folder.appending(path: session.uuidString.lowercased()), options: .atomic)
    }

    private struct ManagedStamp: Codable {
        var thread: String
        var tools: String
    }

    func isManaged(_ session: UUID, thread: String) -> Bool {
        let url = folder.appending(path: session.uuidString.lowercased() + ".managed")
        guard let data = try? Data(contentsOf: url), let stamp = try? JSONDecoder().decode(ManagedStamp.self, from: data) else { return false }
        return stamp.thread == thread && stamp.tools == CodexSession.managedToolSignature
    }

    func markManaged(_ thread: String, for session: UUID) {
        let folder = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(ManagedStamp(thread: thread, tools: CodexSession.managedToolSignature)) else { return }
        try? data.write(to: folder.appending(path: session.uuidString.lowercased() + ".managed"), options: .atomic)
    }

    func workers(for session: UUID) -> [CodexManagedWorkerRecord] {
        let url = folder.appending(path: session.uuidString.lowercased() + ".workers.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([CodexManagedWorkerRecord].self, from: data)) ?? []
    }

    func saveWorkers(_ records: [CodexManagedWorkerRecord], for session: UUID) {
        guard let data = try? JSONEncoder().encode(records) else { return }
        let folder = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: folder.appending(path: session.uuidString.lowercased() + ".workers.json"), options: .atomic)
    }

}

/// What the Codex protocol asks of the process around it: a JSON-RPC line to write, an event for
/// the bot, a thread id to remember, or the end.
enum CodexOutput {
    case write([String: Any])
    case event(AgentEvent)
    /// The thread started: the bot's session is this thread from now on.
    case thread(String)
    /// Close stdin: nothing more to do (`finish`), or it could not start (`failed`).
    case close
    /// It could not start or resume: end the process; the message goes in its exit's stderr.
    case failed(String)
}

/// One bot session over `codex app-server`'s JSON-RPC (stdio, one JSON object a line), with no
/// process of its own, so recorded lines can be replayed through it: each call gives back what
/// to write and which `AgentEvent`s it means. Checked against codex-cli 0.163.0.
///
/// - The thread starts (or resumes) with the approval policy, sandbox and reviewer said
///   explicitly, so the user's own `~/.codex/config.toml` (`approval_policy = "never"`, full
///   access) does not decide what a bot may do: it asks (`on-request`) and writes only in its
///   folders (`workspace-write`); in auto mode Codex's own reviewer (`auto_review`) answers.
/// - A message while a turn runs joins that turn (`turn/steer`), as with `claude`; one sent with
///   an id waits for a turn of its own (`commandQueued`, then `commandStarted`).
/// - `interrupt` stops the turn (`turn/interrupt`) and the last message sent goes again as a
///   new turn, as `claude`'s `send_now` interrupt does.
/// - The turn's reply is its last agent message that is not commentary; commentary (what it
///   says between tool calls) is a step. Commands, file changes, MCP and web-search calls are
///   steps too, with what came out.
struct CodexSession {
    struct Input {
        var text: String
        var images: [Attachment] = []
        var id: UUID?
        var token = UUID()
    }

    struct Config {
        var workingDirectory: URL
        var instructions: String
        var autoMode = false
        var writableRoots: [URL] = []
        var effort: EffortLevel?
        /// Go on in this thread (`thread/resume`) instead of starting one.
        var resumeThread: String?
        /// The Codex model (`model/list`'s id); nil: Codex's own default.
        var model: String?
        var workerInstructions: String?
        /// What app-managed workers start on; unset values follow `model`/`effort` above.
        var workerDefaults = CodexWorkerDefaults()
        var restoredWorkers: [CodexManagedWorkerRecord] = []

        var workerModel: String? { workerDefaults.model ?? model }
        var workerEffort: EffortLevel? { workerDefaults.effort ?? effort }
    }

    private enum Call {
        case initialize, thread, turn, interrupt, other
        case coordinatorInstructions(String), workerInstructions(String)
        case steer(Input, String)
        case workerThread(String)
        case workerTurn(String, Int)
        case workerSteer(String, Int, String, String)
    }

    private struct Turn {
        var id: String?
        /// Messages sent before its id was known, to steer once it is.
        var waitingSteers: [Input] = []
        var interruptAsked = false
        var interruptSent = false
        /// What its agent messages said, in order, with their phase.
        var said: [(text: String, phase: String?)] = []
    }

    private enum Approval {
        case command, fileChange, permissions([String: Any])
    }

    let config: Config
    private var nextID = 1
    private var calls: [Int: Call] = [:]
    private(set) var threadID: String?
    private var turn: Turn?
    /// Messages waiting for a turn of their own (before the thread is ready, or sent with an id).
    private var inbox: [Input] = []
    /// The message the next turn takes in, to say `commandStarted` for its id.
    private var startingID: UUID?
    /// The last message that joined a running turn: the one an interrupt sends again.
    private var lastSteer: Input?
    private var afterInterrupt: Input?
    private var interruptedSteers: Set<UUID> = []
    /// Questions waiting for the user, by the request's id as text, with the id as it came.
    private var approvals: [String: (rpcID: Any, kind: Approval, thread: String?, turn: String?)] = [:]
    /// The files each file-change item touches, for its approval question.
    private var changedFiles: [String: [String]] = [:]
    /// The thread's token totals as last reported, and as they were when this turn began.
    private var tokensTotal = TokenUsage()
    private var tokensAtTurnStart = TokenUsage()
    private var finishing = false
    /// Commands the user allowed after Codex's reviewer refused them (`allow(rules:)`): asked
    /// about again, they are let through.
    private var allowedCommands: Set<String> = []
    /// The next turn asks the app (not Codex's reviewer), so an allowed command goes through;
    /// the one after goes back to the reviewer.
    private var reviewerNext: String?
    /// Codex's own subagents: each thread it spawned, and the call that spawned it.
    private var subagentThreads: [String: String] = [:]
    /// Keep attribution for a final usage notification arriving after the child completion.
    private var subagentUsageThreads: [String: String] = [:]
    /// What each subagent thread said last, for its report.
    private var subagentSaid: [String: String] = [:]
    /// Subagent threads Codex reports with `subAgentActivity` items (codex-cli 0.163+): a
    /// thread's turn ending is not its end there, the parent's `completed` item is, and it can
    /// be messaged again after.
    private var subagentActivityThreads: Set<String> = []
    /// Activity-backed threads stay registered between turns; only an actual turn start
    /// resumes an ended row, whereas sending a message alone need not start work.
    private var activeSubagentActivityThreads: Set<String> = []
    private var endedSubagentActivityItems: Set<String> = []

    // App-owned independent sessions. Native Codex multi-agent execution is disabled.
    private var workers: [String: ManagedWorker] = [:]
    private var workerResults: [ManagedResult] = []
    private var activeResult: ManagedResult?
    private var toolReplies: [String: [String: Any]] = [:]
    private var managedPending = false
    private var stopped = false

    init(config: Config) {
        self.config = config
        for record in config.restoredWorkers {
            workers[record.id] = ManagedWorker(record: record)
            if record.reportPending, let report = record.report, let status = record.status {
                workerResults.append(ManagedResult(task: record.id, name: record.name, thread: record.thread,
                    turn: record.turn, run: record.run, status: status, report: report,
                    reconciliationAttempt: record.reconciliationAttempt ?? 0))
            } else if record.wasActive {
                workerResults.append(ManagedResult(task: record.id, name: record.name, thread: record.thread,
                    turn: nil, run: record.run, status: "interrupted",
                    report: "The app stopped before this worker completed. Send a message to the same task_id to resume its session."))
            }
        }
    }

    // MARK: From the bot

    mutating func start() -> [CodexOutput] {
        [request("initialize", ["clientInfo": ["name": "claudecodebot", "title": "Botling", "version": "1"], "capabilities": ["experimentalApi": true]], as: .initialize)]
    }

    mutating func send(_ input: Input) -> [CodexOutput] {
        guard threadID != nil else {
            inbox.append(input)
            return []
        }
        guard var turn else { return startTurn(input) }
        if let id = input.id {
            inbox.append(input)
            return [.event(.commandQueued(id))]
        }
        lastSteer = input
        guard let turnID = turn.id else {
            turn.waitingSteers.append(input)
            self.turn = turn
            return []
        }
        return [steer(input, turnID: turnID)]
    }

    mutating func interrupt() -> [CodexOutput] {
        guard var turn, !turn.interruptAsked else { return [] }
        turn.interruptAsked = true
        afterInterrupt = lastSteer
        if let lastSteer { interruptedSteers.insert(lastSteer.token) }
        lastSteer = nil
        var out: [CodexOutput] = []
        if let id = turn.id, let thread = threadID {
            turn.interruptSent = true
            out.append(request("turn/interrupt", ["threadId": thread, "turnId": id], as: .interrupt))
        }
        self.turn = turn
        return out
    }

    mutating func answer(_ requestID: String, allow: Bool, message: String? = nil) -> [CodexOutput] {
        guard let approval = approvals.removeValue(forKey: requestID) else { return [] }
        let result: [String: Any] = switch approval.kind {
        case .command, .fileChange: ["decision": allow ? "accept" : "decline"]
        case let .permissions(asked): allow ? ["permissions": asked, "scope": "turn"] : ["permissions": [String: Any]()]
        }
        var out: [CodexOutput] = [.write(["jsonrpc": "2.0", "id": approval.rpcID, "result": result])]
        // A refusal carries no words in Codex's protocol: why goes to the turn as a message.
        if !allow, let message, !message.isEmpty {
            if let thread = approval.thread, thread != threadID,
               let task = workers.first(where: { $0.value.thread == thread })?.key {
                out += messageWorker(task, text: "(App: \(message))")
            } else if let turn, let id = turn.id {
                out.append(steer(Input(text: "(App: \(message))"), turnID: id))
            }
        }
        return out
    }

    /// The user allowed calls Codex's reviewer refused ("Bash(rm -rf build)"): asked again,
    /// they go through. The next turn asks the app instead of the reviewer, once.
    mutating func allow(rules: [String]) -> [CodexOutput] {
        let commands = rules.compactMap { rule -> String? in
            guard rule.hasPrefix("Bash("), rule.hasSuffix(")") else { return nil }
            return String(rule.dropFirst(5).dropLast())
        }
        let new = Set(commands).subtracting(allowedCommands)
        guard !new.isEmpty else { return [] }
        allowedCommands.formUnion(new)
        if config.autoMode { reviewerNext = "user" }
        return []
    }

    /// Stdin closes once the turn under way (and any waiting) is done.
    mutating func finish() -> [CodexOutput] {
        finishing = true
        return turn == nil && inbox.isEmpty && !hasManagedWork ? [.close] : []
    }

    // MARK: From codex

    mutating func receive(_ line: String) -> [CodexOutput] {
        guard let data = line.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        let method = message["method"] as? String
        let params = message["params"] as? [String: Any] ?? [:]
        if let method, let rpcID = message["id"] {
            return serverRequest(method, id: rpcID, params: params)
        }
        if let method {
            return notification(method, params)
        }
        if let id = (message["id"] as? NSNumber)?.intValue, let call = calls.removeValue(forKey: id) {
            return response(call, result: message["result"] as? [String: Any], error: message["error"] as? [String: Any])
        }
        return []
    }

    private mutating func response(_ call: Call, result: [String: Any]?, error: [String: Any]?) -> [CodexOutput] {
        switch call {
        case .initialize:
            guard error == nil else { return [.failed(Self.message(error))] }
            return [.write(["jsonrpc": "2.0", "method": "initialized"]), startThread()]
        case .thread:
            guard error == nil, let thread = (result?["thread"] as? [String: Any])?["id"] as? String else {
                return [.failed(Self.message(error))]
            }
            if config.resumeThread != nil, config.workerInstructions != nil {
                return [refreshInstructions(config.instructions, thread: thread, as: .coordinatorInstructions(thread))]
            }
            return coordinatorReady(thread)
        case let .coordinatorInstructions(thread):
            guard error == nil else {
                return [.failed("Could not refresh coordinator instructions: " + Self.message(error))]
            }
            return coordinatorReady(thread)
        case let .workerInstructions(task):
            guard error == nil else {
                return failWorker(task, report: "Could not refresh worker instructions: " + Self.message(error))
            }
            guard let worker = workers[task], worker.active, !worker.cancelled, !stopped else { return [] }
            workers[task]?.loaded = true
            return startWorkerTurn(task, text: worker.instructions)
        case .turn:
            if let error {
                // The turn never started: its message gets an error reply, and the next goes.
                turn = nil
                let message = activeResult.map { Self.handbackFallback($0, reason: Self.message(error)) } ?? Self.message(error)
                activeResult = nil
                var out: [CodexOutput] = [.event(.reply(message, isError: true))]
                out += next()
                return out
            }
            if let id = (result?["turn"] as? [String: Any])?["id"] as? String { return learnTurn(id) }
            return []
        case let .steer(input, _):
            // Each rejected message keeps its own input, even after the target turn ended.
            guard error != nil, !interruptedSteers.contains(input.token) else { return [] }
            if turn == nil { return startTurn(input) }
            inbox.append(input)
            return []
        case let .workerThread(task):
            return workerThreadReady(task, result: result, error: error)
        case let .workerTurn(task, run):
            return workerTurnReady(task, run: run, result: result, error: error)
        case let .workerSteer(task, run, targetTurn, text):
            guard error != nil, let worker = workers[task], !worker.cancelled else { return [] }
            if worker.active {
                workers[task]?.messages.append(text)
                return []
            }
            // The old turn completed between dispatch and rejection. Reuse the same session.
            _ = run; _ = targetTurn
            return messageWorker(task, text: text)
        case .interrupt, .other:
            return []
        }
    }

    private mutating func notification(_ method: String, _ params: [String: Any]) -> [CodexOutput] {
        if method == "thread/tokenUsage/updated", let thread = params["threadId"] as? String,
           let parent = subagentThreads[thread] ?? subagentUsageThreads[thread] {
            guard let total = (params["tokenUsage"] as? [String: Any])?["total"] as? [String: Any],
                  let tokens = SubagentTokenCounter.read(total["outputTokens"]) else { return [] }
            return [.event(.trace(.subagentOutput(id: parent, counter: "thread:" + thread, tokens: tokens)))]
        }
        // A line from one of Codex's own subagents: a step under it, not the bot's turn.
        if let thread = params["threadId"] as? String, let main = threadID, thread != main {
            if let task = workers.first(where: { $0.value.thread == thread })?.key {
                return workerLine(method, params, task: task)
            }
            return subagentLine(method, params, thread: thread)
        }
        switch method {
        case "account/rateLimits/updated":
            guard let snapshot = params["rateLimits"] as? [String: Any] else { return [] }
            let limits = Self.rateLimits(snapshot, seen: Date())
            return limits.isEmpty ? [] : [.event(.codexRateLimits(limits))]
        case "item/autoApprovalReview/completed":
            return reviewed(params)
        case "turn/started":
            guard let id = (params["turn"] as? [String: Any])?["id"] as? String else { return [] }
            var out = learnTurn(id)
            if let started = startingID {
                startingID = nil
                out.insert(.event(.commandStarted(started)), at: 0)
            }
            return out
        case "item/started":
            guard let item = params["item"] as? [String: Any] else { return [] }
            return started(item).map { [.event(.trace($0))] } ?? []
        case "item/completed":
            guard let item = params["item"] as? [String: Any] else { return [] }
            return completed(item).map { .event(.trace($0)) }
        case "thread/tokenUsage/updated":
            if let total = (params["tokenUsage"] as? [String: Any])?["total"] as? [String: Any] {
                tokensTotal = Self.tokens(total)
            }
            return []
        case "error":
            // It lost the connection and tries again: the row says so.
            guard params["willRetry"] as? Bool == true,
                  Self.isConnectionLoss((params["error"] as? [String: Any])?["codexErrorInfo"]) else { return [] }
            return [.event(.connectionTrouble(attempt: 1, maxRetries: 0))]
        case "serverRequest/resolved":
            // Answered elsewhere, or no longer needed (the turn ended).
            guard let id = params["requestId"].map(Self.key), approvals.removeValue(forKey: id) != nil else { return [] }
            return [.event(.permissionCancelled(id))]
        case "turn/completed":
            guard let finished = params["turn"] as? [String: Any] else { return [] }
            return turnCompleted(finished)
        default:
            return []
        }
    }

    private mutating func serverRequest(_ method: String, id rpcID: Any, params: [String: Any]) -> [CodexOutput] {
        let key = Self.key(rpcID)
        if method == "item/tool/call" { return managedTool(rpcID, params: params) }
        switch method {
        case "item/commandExecution/requestApproval":
            let asked = [params["command"] as? String, Self.command(params)].compactMap { $0 }
            if asked.contains(where: allowedCommands.contains) {
                return [.write(["jsonrpc": "2.0", "id": rpcID, "result": ["decision": "accept"]])]
            }
            approvals[key] = (rpcID, .command, params["threadId"] as? String, params["turnId"] as? String)
            var summary = params["command"] as? String ?? ""
            if let reason = params["reason"] as? String, !reason.isEmpty { summary += (summary.isEmpty ? "" : "\n\n") + reason }
            return [.event(.permission(PermissionRequest(id: key, tool: "Bash", summary: summary, input: "{}")))]
        case "item/fileChange/requestApproval":
            approvals[key] = (rpcID, .fileChange, params["threadId"] as? String, params["turnId"] as? String)
            let files = (params["itemId"] as? String).flatMap { changedFiles[$0] } ?? []
            var summary = files.joined(separator: "\n")
            if let root = params["grantRoot"] as? String, !root.isEmpty { summary += (summary.isEmpty ? "" : "\n") + root }
            if let reason = params["reason"] as? String, !reason.isEmpty { summary += (summary.isEmpty ? "" : "\n\n") + reason }
            return [.event(.permission(PermissionRequest(id: key, tool: "Edit", summary: summary, input: "{}")))]
        case "item/permissions/requestApproval":
            let asked = params["permissions"] as? [String: Any] ?? [:]
            approvals[key] = (rpcID, .permissions(asked), params["threadId"] as? String, params["turnId"] as? String)
            let json = (try? JSONSerialization.data(withJSONObject: asked, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
            let summary = [params["reason"] as? String, json].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            return [.event(.permission(PermissionRequest(id: key, tool: "Permissions", summary: summary, input: "{}")))]
        case "mcpServer/elicitation/request":
            // A form the app cannot show: declined, so nothing waits on it.
            return [.write(["jsonrpc": "2.0", "id": rpcID, "result": ["action": "decline"]])]
        default:
            // Bots ask in the chat (<choices>); anything else is not the app's to answer.
            return [.write(["jsonrpc": "2.0", "id": rpcID, "error": ["code": -32601, "message": "Not supported by Botling."]])]
        }
    }

    // MARK: Turns

    private mutating func startThread() -> CodexOutput {
        var params: [String: Any] = [
            "cwd": config.workingDirectory.path,
            "approvalPolicy": "on-request",
            "approvalsReviewer": config.autoMode ? "auto_review" : "user",
            "sandbox": "workspace-write",
            "developerInstructions": config.instructions
        ]
        var overrides: [String: Any] = [:]
        if config.workerInstructions != nil {
            params["environments"] = []
            params["dynamicTools"] = Self.managedTools
            overrides = Self.coordinatorConfig
        }
        if let model = config.model { params["model"] = model }
        if !config.writableRoots.isEmpty {
            overrides["sandbox_workspace_write"] = ["writable_roots": config.writableRoots.map(\.path)]
        }
        if !overrides.isEmpty { params["config"] = overrides }
        if let thread = config.resumeThread {
            // Tools are persisted at thread creation. Resume cannot add or replace them.
            params.removeValue(forKey: "dynamicTools")
            params.removeValue(forKey: "environments")
            params["threadId"] = thread
            params["excludeTurns"] = true
            return request("thread/resume", params, as: .thread)
        }
        return request("thread/start", params, as: .thread)
    }

    /// Resume overrides alone can leave the rollout's old developer policy in force on CLI
    /// 0.163. Append the current policy at developer priority without replacing thread/history,
    /// dynamic tools, model/effort, sandbox or approval policy. Await acknowledgment before input.
    private mutating func refreshInstructions(_ text: String, thread: String, as call: Call) -> CodexOutput {
        request("thread/inject_items", ["threadId": thread, "items": [
            ["type": "message", "role": "developer", "content": [["type": "input_text", "text": text]]]
        ]], as: call)
    }

    private mutating func coordinatorReady(_ thread: String) -> [CodexOutput] {
        guard !stopped else { return [] }
        threadID = thread
        var out: [CodexOutput] = [.thread(thread)]
        if !inbox.isEmpty { out += startTurn(inbox.removeFirst()) }
        else { out += next() }
        out += pendingChanged()
        return out
    }

    private mutating func startTurn(_ input: Input) -> [CodexOutput] {
        guard let thread = threadID else {
            inbox.insert(input, at: 0)
            return []
        }
        turn = Turn()
        tokensAtTurnStart = tokensTotal
        startingID = input.id
        var params: [String: Any] = ["threadId": thread, "input": Self.items(input)]
        if config.workerInstructions != nil { params["environments"] = [] }
        if let effort = config.effort { params["effort"] = Self.effort(effort) }
        if let reviewer = reviewerNext {
            params["approvalsReviewer"] = reviewer
            reviewerNext = reviewer == "user" ? "auto_review" : nil
        }
        return [.event(.turnStarted), request("turn/start", params, as: .turn)]
    }

    private mutating func learnTurn(_ id: String) -> [CodexOutput] {
        guard var turn, turn.id == nil else { return [] }
        turn.id = id
        var out = turn.waitingSteers.map { steer($0, turnID: id) }
        turn.waitingSteers = []
        if turn.interruptAsked, !turn.interruptSent, let thread = threadID {
            turn.interruptSent = true
            out.append(request("turn/interrupt", ["threadId": thread, "turnId": id], as: .interrupt))
        }
        self.turn = turn
        return out
    }

    private mutating func turnCompleted(_ finished: [String: Any]) -> [CodexOutput] {
        guard let current = turn else { return [] }
        if let id = current.id, let ended = finished["id"] as? String, ended != id { return [] }
        turn = nil
        let handback = activeResult
        activeResult = nil
        lastSteer = nil
        var out: [CodexOutput] = []
        let used = tokensTotal - tokensAtTurnStart
        if used.total > 0 { out.append(.event(.usage(totalCost: 0, tokens: used))) }
        switch finished["status"] as? String {
        case "interrupted":
            // Stopped for a message (`interrupt`): an error result the bot does not show, then
            // that message as a turn of its own.
            let message = handback.map { Self.handbackFallback($0, reason: "The summary turn was interrupted.") }
                ?? (current.interruptAsked ? "" : "Codex stopped this turn.")
            out.append(.event(.reply(message, isError: true)))
            if let input = afterInterrupt {
                afterInterrupt = nil
                inbox.insert(input, at: 0)
            }
        case "failed":
            let error = finished["error"] as? [String: Any]
            if Self.isConnectionLoss(error?["codexErrorInfo"]) { out.append(.event(.connectionLost(parent: nil))) }
            let reason = error?["message"] as? String ?? "Codex failed."
            out.append(.event(.reply(handback.map { Self.handbackFallback($0, reason: reason) } ?? reason, isError: true)))
        default:
            if let handback, current.said.last(where: { $0.phase != "commentary" })?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                out.append(.event(.reply(Self.handbackFallback(handback, reason: "The summary ended without a final answer."), isError: true)))
            } else if var handback, !handback.reconciled, !stopped {
                if handback.reconciliationAttempt == 0 {
                    // One event-driven decision turn, never a timer or an execution retry.
                    handback.reconciliationAttempt = 1
                    workerResults.insert(handback, at: 0)
                    out.append(.event(.trace(.text("Worker turn ended; reconciling acceptance and next owner action.", parent: nil))))
                } else {
                    out.append(.event(.reply(Self.handbackFallback(handback,
                        reason: "No acceptance checkpoint or next owner action was recorded after one reconciliation. The user objective remains unverified; no automatic retry is scheduled."), isError: true)))
                }
            } else {
                out.append(.event(.reply(Self.reply(from: current.said), isError: false)))
            }
        }
        out += next()
        return out
    }

    /// The next waiting message's turn, or the end once `finish` asked for it.
    private mutating func next() -> [CodexOutput] {
        if !inbox.isEmpty { return startTurn(inbox.removeFirst()) }
        if !workerResults.isEmpty, threadID != nil, !stopped {
            let result = workerResults.removeFirst()
            activeResult = result
            turn = Turn()
            tokensAtTurnStart = tokensTotal
            var params: [String: Any] = ["threadId": threadID!, "input": [],
                "toolOutput": ["name": "app_task_result", "namespace": NSNull(), "output": Self.json(result.payload)]]
            params["environments"] = []
            if let effort = config.effort { params["effort"] = Self.effort(effort) }
            var out: [CodexOutput] = [.event(.managedWorkerReportStarted(taskID: result.task)),
                                     .event(.backgroundTurnStarted), request("turn/start", params, as: .turn)]
            out += pendingChanged()
            return out
        }
        return finishing && !hasManagedWork ? [.close] : []
    }

    private mutating func steer(_ input: Input, turnID: String) -> CodexOutput {
        request("turn/steer", ["threadId": threadID ?? "", "expectedTurnId": turnID, "input": Self.items(input)], as: .steer(input, turnID))
    }

    private mutating func request(_ method: String, _ params: [String: Any], as call: Call) -> CodexOutput {
        let id = nextID
        nextID += 1
        calls[id] = call
        return .write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
    }

    // MARK: App-managed workers

    private struct ManagedWorker {
        var id: String
        var name: String
        var instructions: String
        var thread: String?
        var turnID: String?
        var run = 1
        var active = true
        var loaded = false
        var cancelled = false
        var messages: [String] = []
        var said: [(text: String, phase: String?)] = []
        var completedTurns: Set<String> = []
        var runtime: WorkerRuntimeInfo?
        var pendingEffortOverride: String?
        var tokens = TokenUsage()
        var tokensAtRunStart = TokenUsage()

        init(id: String, name: String, instructions: String) {
            self.id = id; self.name = name; self.instructions = instructions
        }
        init(record: CodexManagedWorkerRecord) {
            id = record.id; name = record.name; instructions = record.instructions
            thread = record.thread; run = record.run; active = false
            runtime = record.runtime
            tokens = record.tokens ?? TokenUsage()
            tokensAtRunStart = tokens
        }
    }

    private struct ManagedResult {
        var task: String
        var name: String
        var thread: String?
        var turn: String?
        var run: Int
        var status: String
        var report: String
        var reconciliationAttempt = 0
        var reconciled = false
        var payload: [String: Any] {
            ["task_id": task, "name": name, "thread_id": thread as Any? ?? NSNull(),
             "turn_id": turn as Any? ?? NSNull(), "run": run, "status": status, "report": report,
             "completion_scope": "worker_turn", "objective_status": "unverified",
             "reconciliation_attempt": reconciliationAttempt]
        }
    }

    private static func handbackFallback(_ result: ManagedResult, reason: String) -> String {
        let evidence = "Reason: \(reason)\nWorker: \(result.name)\nTask: \(result.task)\nStatus: \(result.status)\n\n\(result.report)"
        // Worker evidence may contain examples of the app's control tags. A dynamically
        // sized fence keeps ReplyParser from treating any of it as app instructions.
        let longest = evidence.split(whereSeparator: { $0 != "~" }).map(\.count).max() ?? 0
        let fence = String(repeating: "~", count: max(3, longest + 1))
        return "The coordinator could not summarize a worker result. The original evidence is preserved below.\n\n\(fence)text\n\(evidence)\n\(fence)"
    }

    /// Save task/thread identity separately from the UI cards: follow-ups work after the
    /// app-server process is recreated, without trying to resurrect an in-flight turn.
    var managedWorkerRecords: [CodexManagedWorkerRecord] {
        workers.values.map { worker in
            let result = workerResults.first(where: { $0.task == worker.id && $0.run == worker.run })
                ?? activeResult.flatMap { $0.task == worker.id && $0.run == worker.run ? $0 : nil }
            return CodexManagedWorkerRecord(id: worker.id, name: worker.name, instructions: worker.instructions,
                thread: worker.thread, run: worker.run, wasActive: worker.active, reportPending: result != nil,
                report: result?.report, status: result?.status, turn: result?.turn, tokens: worker.tokens, runtime: worker.runtime,
                reconciliationAttempt: result?.reconciliationAttempt)
        }.sorted { $0.id < $1.id }
    }

    private var hasManagedWork: Bool { workers.values.contains(where: \.active) || !workerResults.isEmpty }

    private mutating func pendingChanged() -> [CodexOutput] {
        let pending = hasManagedWork
        guard pending != managedPending else { return [] }
        managedPending = pending
        return [.event(.managedWorkPending(pending))]
    }

    private static let coordinatorConfig: [String: Any] = [
        "features.multi_agent": false, "agents.enabled": false,
        "features.shell_tool": false, "web_search": "disabled"
    ]

    /// Canonical complete schema, not merely the tool count: old two-tool threads and any
    /// future schema/description changes must acquire a fresh coordinator before execution.
    static var managedToolSignature: String {
        json(managedTools)
    }

    private static let managedTools: [[String: Any]] = [
        ["type": "function", "name": "app_handoff",
         "description": "Assign the whole execution scope to an independent app-managed worker. Returns acceptance immediately. Finish this turn after the receipt; the app will deliver app_task_result in a later turn.",
         "inputSchema": ["type": "object", "properties": ["instructions": ["type": "string"], "name": ["type": "string"]], "required": ["instructions"], "additionalProperties": false]],
        ["type": "function", "name": "app_send_message",
         "description": "Send instructions or a follow-up to the same worker task/session. Busy workers receive steering; idle workers start a new turn. Returns acceptance, not the completed result.",
         "inputSchema": ["type": "object", "properties": ["task_id": ["type": "string"], "message": ["type": "string"]], "required": ["task_id", "message"], "additionalProperties": false]],
        ["type": "function", "name": "app_task_checkpoint",
         "description": "Resolve the active app_task_result against the authorized user objective. Worker completed means only its execution turn ended. Record concrete acceptance evidence, an exact user input/permission needed, a real blocker, or an actively running dependency. If authorized work remains actionable, dispatch it using app_send_message/app_handoff instead. A bare waiting status is not completion. This checkpoint grants no new authorization.",
         "inputSchema": ["type": "object", "properties": [
            "task_id": ["type": "string"],
            "outcome": ["type": "string", "enum": ["complete", "waiting_user", "waiting_dependency", "blocked"]],
            "evidence": ["type": "string"], "dependency_task_id": ["type": "string"]],
            "required": ["task_id", "outcome", "evidence"], "additionalProperties": false]]
    ]

    private mutating func managedTool(_ rpcID: Any, params: [String: Any]) -> [CodexOutput] {
        let key = Self.key(rpcID)
        if let response = toolReplies[key] { return [.write(response)] }
        func reply(_ payload: [String: Any], success: Bool) -> [String: Any] {
            ["jsonrpc": "2.0", "id": rpcID,
             "result": ["success": success, "contentItems": [["type": "inputText", "text": Self.json(payload)]]]]
        }
        guard config.workerInstructions != nil, !stopped,
              (!finishing || params["tool"] as? String == "app_task_checkpoint"),
              params["threadId"] as? String == threadID else {
            let response = reply(["error": "App handoff tools are available only to the active coordinator."], success: false)
            toolReplies[key] = response
            return [.write(response)]
        }
        var arguments = params["arguments"] as? [String: Any]
        if arguments == nil, let string = params["arguments"] as? String, let data = string.data(using: .utf8) {
            arguments = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        let tool = params["tool"] as? String
        var out: [CodexOutput] = []
        let response: [String: Any]
        if tool == "app_handoff", let instructions = arguments?["instructions"] as? String,
           !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let id = UUID().uuidString.lowercased()
            let name = (arguments?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Self.firstLine(instructions)
            workers[id] = ManagedWorker(id: id, name: name, instructions: instructions)
            out += [.event(.trace(.toolUse(id: id, tool: "Agent", title: "Delegate " + name, detail: instructions, parent: nil))),
                    .event(.trace(.subagentStarted(id: id, description: name, type: "codex-worker", prompt: instructions, background: true))),
                    .event(.trace(.subagentNamed(id: id, name: name)))]
            out.append(startWorkerThread(id))
            activeResult?.reconciled = true
            response = reply(["task_id": id, "status": "accepted",
                              "message": "The app owns this task. Finish this turn; app_task_result will arrive when the worker finishes."], success: true)
        } else if tool == "app_send_message", let id = arguments?["task_id"] as? String,
                  let message = arguments?["message"] as? String, !message.isEmpty, workers[id] != nil {
            let queued = workers[id]?.active == true
            let callID = params["callId"] as? String ?? params["itemId"] as? String ?? key
            out.append(.event(.trace(.messageSent(id: callID, to: workers[id]?.thread ?? id,
                summary: nil, message: message, parent: nil))))
            out += messageWorker(id, text: message)
            activeResult?.reconciled = true
            out.append(.event(.trace(.launchResult(id: callID,
                result: LaunchResult(recipient: workers[id]?.thread ?? id), parent: nil))))
            response = reply(["task_id": id, "status": queued ? "queued" : "accepted"], success: true)
        } else if tool == "app_task_checkpoint" {
            let task = arguments?["task_id"] as? String
            let outcome = arguments?["outcome"] as? String ?? ""
            let evidence = (arguments?["evidence"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let dependency = arguments?["dependency_task_id"] as? String
            let outcomes = ["complete", "waiting_user", "waiting_dependency", "blocked"]
            if let task, activeResult?.task == task, outcomes.contains(outcome), !evidence.isEmpty,
               outcome != "waiting_dependency" || (dependency != task && dependency.flatMap { workers[$0]?.active } == true) {
                activeResult?.reconciled = true
                out.append(.event(.trace(.toolUse(id: key, tool: "app_task_checkpoint", title: "Task checkpoint: " + outcome,
                    detail: Self.json(arguments), parent: nil))))
                out.append(.event(.trace(.toolResult(id: key, output: evidence, failed: false, parent: nil))))
                response = reply(["task_id": task, "outcome": outcome, "recorded": true], success: true)
            } else {
                response = reply(["error": "Checkpoint requires the active report task_id, a valid outcome and concrete evidence. A dependency must be another actively running app task; otherwise assign an owner, request exact user input, or report a concrete blocker."], success: false)
            }
        } else {
            response = reply(["error": "Invalid app tool arguments or unknown task_id. Use app_handoff to create a task, then app_send_message with its task_id."], success: false)
        }
        toolReplies[key] = response
        // Receipt precedes worker RPCs, so slow thread startup never keeps the model waiting.
        out.insert(.write(response), at: 0)
        out += pendingChanged()
        return out
    }

    private mutating func startWorkerThread(_ task: String) -> CodexOutput {
        let worker = workers[task]!
        var overrides: [String: Any] = ["features.multi_agent": false, "agents.enabled": false]
        if !config.writableRoots.isEmpty {
            overrides["sandbox_workspace_write"] = ["writable_roots": config.writableRoots.map(\.path)]
        }
        var params: [String: Any] = [
            "cwd": config.workingDirectory.path, "approvalPolicy": "on-request",
            "approvalsReviewer": config.autoMode ? "auto_review" : "user", "sandbox": "workspace-write",
            "developerInstructions": config.workerInstructions ?? "Execute the assigned task yourself and return concrete evidence. Do not delegate.",
            "config": overrides
        ]
        if let model = config.workerModel { params["model"] = model }
        if let tier = config.workerDefaults.serviceTier { params["serviceTier"] = tier }
        if let thread = worker.thread {
            params["threadId"] = thread; params["excludeTurns"] = true
            return request("thread/resume", params, as: .workerThread(task))
        }
        return request("thread/start", params, as: .workerThread(task))
    }

    private mutating func workerThreadReady(_ task: String, result: [String: Any]?, error: [String: Any]?) -> [CodexOutput] {
        guard let worker = workers[task], worker.active, !worker.cancelled, !stopped else { return [] }
        guard error == nil, let thread = (result?["thread"] as? [String: Any])?["id"] as? String else {
            return failWorker(task, report: "Could not start worker session: " + Self.message(error))
        }
        let resumed = worker.thread != nil
        workers[task]?.thread = thread
        workers[task]?.loaded = !resumed
        var out: [CodexOutput] = [.event(.trace(.launchResult(id: task, result: LaunchResult(agentID: thread), parent: nil)))]
        let runtime = WorkerRuntimeInfo.codex(result ?? [:], effortKey: "reasoningEffort")
        workers[task]?.runtime = runtime
        out += workerSettings(task, settings: result ?? [:], runtime: runtime)
        if resumed {
            out.append(refreshInstructions(config.workerInstructions ?? "Execute the assigned task yourself and do not delegate.",
                thread: thread, as: .workerInstructions(task)))
        } else {
            out += startWorkerTurn(task, text: worker.instructions)
        }
        return out
    }

    private mutating func startWorkerTurn(_ task: String, text: String) -> [CodexOutput] {
        guard let worker = workers[task], let thread = worker.thread, !worker.cancelled, !stopped else { return [] }
        let override = config.workerEffort.map(Self.effort)
        workers[task]?.pendingEffortOverride = override
        workers[task]?.turnID = nil
        workers[task]?.said = []
        workers[task]?.tokensAtRunStart = worker.tokens
        var params: [String: Any] = ["threadId": thread, "input": [["type": "text", "text": text]]]
        if let override { params["effort"] = override }
        return [request("turn/start", params, as: .workerTurn(task, worker.run))]
    }

    private mutating func workerTurnReady(_ task: String, run: Int, result: [String: Any]?, error: [String: Any]?) -> [CodexOutput] {
        guard let worker = workers[task], worker.run == run, worker.active, !worker.cancelled, !stopped else { return [] }
        if let error { return failWorker(task, report: "Could not start worker turn: " + Self.message(error)) }
        guard let id = (result?["turn"] as? [String: Any])?["id"] as? String else { return [] }
        return learnWorkerTurn(task, id: id)
    }

    /// A successful turn start accepts the app's explicit effort override. With no override,
    /// retain the resolved thread value (including inherited profile/project configuration).
    private mutating func acceptedWorkerSettings(_ task: String) -> [CodexOutput] {
        guard let effort = workers[task]?.pendingEffortOverride else { return [] }
        workers[task]?.pendingEffortOverride = nil
        var runtime = workers[task]?.runtime ?? WorkerRuntimeInfo()
        runtime.reasoningEffort = effort
        workers[task]?.runtime = runtime
        return [.event(.trace(.subagentRuntime(id: task, runtime: runtime)))]
    }

    private func workerSettings(_ task: String, settings: [String: Any], runtime: WorkerRuntimeInfo) -> [CodexOutput] {
        var out: [CodexOutput] = [.event(.trace(.subagentRuntime(id: task, runtime: runtime)))]
        if let model = settings["model"] as? String, !model.isEmpty {
            out.append(.event(.trace(.subagentModel(id: task, model: model))))
        }
        return out
    }

    private mutating func learnWorkerTurn(_ task: String, id: String) -> [CodexOutput] {
        guard let worker = workers[task], worker.active, worker.turnID == nil,
              !worker.completedTurns.contains(id), !worker.cancelled else { return [] }
        workers[task]?.turnID = id
        workers[task]?.messages = []
        return acceptedWorkerSettings(task) + worker.messages.map { workerSteer(task, text: $0, turnID: id, run: worker.run) }
    }

    private mutating func workerSteer(_ task: String, text: String, turnID: String, run: Int) -> CodexOutput {
        request("turn/steer", ["threadId": workers[task]?.thread ?? "", "expectedTurnId": turnID,
            "input": [["type": "text", "text": text]]], as: .workerSteer(task, run, turnID, text))
    }

    private mutating func messageWorker(_ task: String, text: String) -> [CodexOutput] {
        guard let worker = workers[task], !stopped else { return [] }
        if worker.active {
            if let turnID = worker.turnID {
                return [workerSteer(task, text: text, turnID: turnID, run: worker.run)]
            }
            workers[task]?.messages.append(text)
            return []
        }
        workerResults.removeAll { $0.task == task }
        workers[task]?.run += 1
        workers[task]?.active = true
        workers[task]?.cancelled = false
        workers[task]?.instructions = text
        workers[task]?.turnID = nil
        var out: [CodexOutput] = [.event(.trace(.subagentStarted(id: task, description: worker.name, type: "codex-worker", prompt: text, background: true)))]
        if worker.loaded { out += startWorkerTurn(task, text: text) }
        else { out.append(startWorkerThread(task)) }
        out += pendingChanged()
        return out
    }

    private mutating func workerLine(_ method: String, _ params: [String: Any], task: String) -> [CodexOutput] {
        guard let worker = workers[task] else { return [] }
        switch method {
        case "thread/settings/updated":
            guard let settings = params["threadSettings"] as? [String: Any] else { return [] }
            let runtime = WorkerRuntimeInfo.codex(settings, effortKey: "effort")
            workers[task]?.runtime = runtime
            // A resolved runtime notification is stronger evidence than the requested override.
            workers[task]?.pendingEffortOverride = nil
            return workerSettings(task, settings: settings, runtime: runtime)
        case "thread/tokenUsage/updated":
            if let total = (params["tokenUsage"] as? [String: Any])?["total"] as? [String: Any] {
                workers[task]?.tokens = Self.tokens(total)
                if let tokens = SubagentTokenCounter.read(total["outputTokens"]), let thread = worker.thread {
                    return [.event(.trace(.subagentOutput(id: task, counter: "thread:" + thread, tokens: tokens)))]
                }
            }
            return []
        case "turn/started":
            guard let id = (params["turn"] as? [String: Any])?["id"] as? String else { return [] }
            if worker.cancelled || stopped {
                return [request("turn/interrupt", ["threadId": worker.thread ?? "", "turnId": id], as: .interrupt)]
            }
            return learnWorkerTurn(task, id: id)
        case "item/started", "item/completed":
            guard worker.active, !worker.cancelled,
                  let item = params["item"] as? [String: Any] else { return [] }
            if let itemTurn = params["turnId"] as? String, let current = worker.turnID, itemTurn != current { return [] }
            if method == "item/started" {
                return started(item).map { [.event(.trace(Self.under(task, $0)))] } ?? []
            }
            if item["type"] as? String == "agentMessage" {
                let text = item["text"] as? String ?? ""
                workers[task]?.said.append((text, item["phase"] as? String))
                return text.isEmpty ? [] : [.event(.trace(.text(text, parent: task)))]
            }
            return completed(item).map { .event(.trace(Self.under(task, $0))) }
        case "turn/completed":
            guard worker.active, !worker.cancelled, let ended = params["turn"] as? [String: Any],
                  let id = ended["id"] as? String, !worker.completedTurns.contains(id),
                  worker.turnID == nil || worker.turnID == id else { return [] }
            workers[task]?.completedTurns.insert(id)
            workers[task]?.turnID = nil
            var status = ended["status"] as? String ?? "failed"
            let said = worker.said.last(where: { $0.phase != "commentary" })?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var report = status == "failed" ? (ended["error"] as? [String: Any])?["message"] as? String ?? (said.isEmpty ? "Worker failed." : said) : said
            if status == "completed", said.isEmpty {
                status = "failed"
                report = "Worker turn ended without a final evidence report. Ask the same task_id for the missing result."
            }
            let used = worker.tokens - worker.tokensAtRunStart
            var out: [CodexOutput] = used.total > 0 ? [.event(.usage(totalCost: 0, tokens: used))] : []
            // A rejected steer can have queued a message while the old turn was ending.
            if !worker.messages.isEmpty {
                workers[task]?.messages = []
                workers[task]?.run += 1
                return out + startWorkerTurn(task, text: worker.messages.joined(separator: "\n\n"))
            }
            workers[task]?.active = false
            workerResults.append(ManagedResult(task: task, name: worker.name, thread: worker.thread,
                turn: id, run: worker.run, status: status, report: report))
            out.append(.event(.trace(.subagentEnded(id: task,
                status: status == "interrupted" ? "killed" : status, summary: report))))
            if turn == nil { out += next() }
            out += pendingChanged()
            return out
        case "item/autoApprovalReview/completed":
            return reviewed(params).map { output in
                if case let .event(.trace(trace)) = output { return .event(.trace(Self.under(task, trace))) }
                return output
            }
        case "serverRequest/resolved":
            guard let id = params["requestId"].map(Self.key), approvals.removeValue(forKey: id) != nil else { return [] }
            return [.event(.permissionCancelled(id))]
        case "error":
            guard params["willRetry"] as? Bool == true else { return [] }
            return [.event(.connectionTrouble(attempt: 1, maxRetries: 0))]
        default:
            return []
        }
    }

    private mutating func failWorker(_ task: String, report: String) -> [CodexOutput] {
        guard let worker = workers[task], worker.active else { return [] }
        workers[task]?.active = false
        workers[task]?.turnID = nil
        workers[task]?.messages = []
        workerResults.append(ManagedResult(task: task, name: worker.name, thread: worker.thread,
            turn: nil, run: worker.run, status: "failed", report: report))
        var out: [CodexOutput] = [.event(.trace(.subagentEnded(id: task, status: "failed", summary: report)))]
        if turn == nil { out += next() }
        out += pendingChanged()
        return out
    }

    /// Global app stop cancels independent workers. Interrupting only the coordinator
    /// deliberately leaves their sessions running.
    mutating func cancelManagedWorkers() -> [CodexOutput] {
        var out: [CodexOutput] = []
        workerResults = []
        activeResult = nil
        for (task, worker) in workers where worker.active {
            workers[task]?.active = false
            workers[task]?.cancelled = true
            workers[task]?.messages = []
            if let thread = worker.thread, let turn = worker.turnID {
                out.append(request("turn/interrupt", ["threadId": thread, "turnId": turn], as: .interrupt))
            }
            let used = worker.tokens - worker.tokensAtRunStart
            if used.total > 0 { out.append(.event(.usage(totalCost: 0, tokens: used))) }
            workers[task]?.tokensAtRunStart = worker.tokens
            out.append(.event(.trace(.subagentEnded(id: task, status: "killed", summary: "Stopped by the app."))))
        }
        out += pendingChanged()
        return out
    }

    mutating func stop() -> [CodexOutput] {
        stopped = true
        inbox = []
        afterInterrupt = nil
        return cancelManagedWorkers()
    }

    // MARK: Items

    /// A tool call starting, as the bot's steps show one.
    private mutating func started(_ item: [String: Any]) -> TraceEvent? {
        guard let id = item["id"] as? String else { return nil }
        switch item["type"] as? String {
        case "commandExecution":
            let command = Self.command(item)
            return .toolUse(id: id, tool: "Bash", title: StreamEvent.activity(tool: "Bash", input: ["command": command]), detail: command, parent: nil)
        case "fileChange":
            let changes = item["changes"] as? [[String: Any]] ?? []
            let paths = changes.compactMap { $0["path"] as? String }
            changedFiles[id] = paths
            let adds = changes.allSatisfy { ($0["kind"] as? [String: Any])?["type"] as? String == "add" }
            let tool = !changes.isEmpty && adds ? "Write" : "Edit"
            var title = StreamEvent.activity(tool: tool, input: paths.first.map { ["file_path": $0] } ?? [:])
            if paths.count > 1 { title += " +\(paths.count - 1)" }
            return .toolUse(id: id, tool: tool, title: title, detail: paths.joined(separator: "\n"), parent: nil)
        case "mcpToolCall":
            let server = item["server"] as? String ?? "", tool = item["tool"] as? String ?? ""
            return .toolUse(id: id, tool: "mcp__\(server)__\(tool)", title: "\(server) \(tool)", detail: Self.json(item["arguments"]), parent: nil)
        case "dynamicToolCall":
            let tool = item["tool"] as? String ?? "tool"
            return .toolUse(id: id, tool: tool, title: tool, detail: Self.json(item["arguments"]), parent: nil)
        case "webSearch":
            let query = item["query"] as? String ?? ""
            return .toolUse(id: id, tool: "WebSearch", title: StreamEvent.activity(tool: "WebSearch", input: ["query": query]), detail: query, parent: nil)
        case "collabAgentToolCall" where item["tool"] as? String == "spawnAgent":
            // One of Codex's own subagents: a subagent row, like Claude's Agent calls.
            let prompt = item["prompt"] as? String ?? ""
            return .toolUse(id: id, tool: "Agent", title: "Delegate " + Self.firstLine(prompt), detail: prompt, parent: nil)
        default:
            return nil
        }
    }

    /// An item done: a tool call's result, or words it said.
    private mutating func completed(_ item: [String: Any]) -> [TraceEvent] {
        guard let id = item["id"] as? String else { return [] }
        let status = item["status"] as? String
        switch item["type"] as? String {
        case "agentMessage":
            let text = item["text"] as? String ?? ""
            let phase = item["phase"] as? String
            turn?.said.append((text, phase))
            // Words between tool calls are a step; the final answer is the reply.
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return phase == "commentary" && !words.isEmpty ? [.text(words, parent: nil)] : []
        case "commandExecution":
            let failed = status != "completed" || ((item["exitCode"] as? NSNumber)?.intValue ?? 0) != 0
            return [.toolResult(id: id, output: item["aggregatedOutput"] as? String ?? "", failed: failed, parent: nil)]
        case "fileChange":
            changedFiles[id] = nil
            let diffs = (item["changes"] as? [[String: Any]] ?? []).compactMap { $0["diff"] as? String }
            return [.toolResult(id: id, output: diffs.joined(separator: "\n"), failed: status != "completed", parent: nil)]
        case "mcpToolCall", "dynamicToolCall":
            let error = item["error"]
            let output = error.flatMap { $0 is NSNull ? nil : Self.json($0) } ?? Self.json(item["result"] ?? item["contentItems"])
            return [.toolResult(id: id, output: output, failed: status == "failed", parent: nil)]
        case "webSearch":
            return [.toolResult(id: id, output: Self.json(item["results"]), failed: false, parent: nil)]
        case "collabAgentToolCall":
            return collab(item, id: id)
        case "subAgentActivity":
            return subAgentActivity(item, id: id)
        default:
            return []
        }
    }

    // MARK: Codex's subagents

    /// A spawn names its threads: their lines go under it from now on. A wait or a close says
    /// how each ended, with its last message.
    private mutating func collab(_ item: [String: Any], id: String) -> [TraceEvent] {
        let threads = item["receiverThreadIds"] as? [String] ?? []
        let states = item["agentsStates"] as? [String: [String: Any]] ?? [:]
        if item["tool"] as? String == "spawnAgent" {
            let prompt = item["prompt"] as? String ?? ""
            for thread in threads { subagentThreads[thread] = id }
            return [.subagentStarted(id: id, description: Self.firstLine(prompt), type: "codex", prompt: prompt, background: false)]
        }
        return states.compactMap { thread, state -> TraceEvent? in
            guard let subagent = subagentThreads[thread], let status = state["status"] as? String else { return nil }
            let ended: String? = switch status {
            case "completed", "shutdown": "completed"
            case "errored", "notFound": "failed"
            case "interrupted": "killed"
            default: nil
            }
            guard let ended else { return nil }
            subagentUsageThreads[thread] = subagentThreads[thread]
            subagentThreads[thread] = nil
            let said = (state["message"] as? String) ?? subagentSaid.removeValue(forKey: thread)
            return .subagentEnded(id: subagent, status: ended, summary: said)
        }
    }

    /// codex-cli 0.163+: a subagent's start, a message to it, and its end are `subAgentActivity`
    /// items naming its thread and path (`/root/avatar_coverage`). Its row is the item that
    /// started it; its thread's lines go under that row, and stay there when it is messaged again.
    private mutating func subAgentActivity(_ item: [String: Any], id: String) -> [TraceEvent] {
        guard let thread = item["agentThreadId"] as? String else { return [] }
        switch item["kind"] as? String {
        case "started":
            guard subagentThreads[thread] == nil else { return [] }
            subagentThreads[thread] = id
            subagentActivityThreads.insert(thread)
            activeSubagentActivityThreads.insert(thread)
            let path = item["agentPath"] as? String ?? ""
            var out: [TraceEvent] = [
                .subagentStarted(id: id, description: Self.agentName(path), type: "codex", prompt: "", background: false),
                .launchResult(id: id, result: LaunchResult(agentID: thread), parent: nil),
            ]
            if !path.isEmpty { out.append(.subagentNamed(id: id, name: path)) }
            if let model = item["model"] as? String, !model.isEmpty { out.append(.subagentModel(id: id, model: model)) }
            // The protocol calls this a resolved effort, unlike collabAgentToolCall's requested effort.
            let runtime = WorkerRuntimeInfo.codex(item, effortKey: "reasoningEffort")
            if runtime.reasoningEffort != nil { out.append(.subagentRuntime(id: id, runtime: runtime)) }
            return out
        case "completed", "interrupted":
            guard endedSubagentActivityItems.insert(id).inserted,
                  let subagent = subagentThreads[thread],
                  activeSubagentActivityThreads.remove(thread) != nil else { return [] }
            let status = item["kind"] as? String == "completed" ? "completed" : "killed"
            return [.subagentEnded(id: subagent, status: status, summary: subagentSaid.removeValue(forKey: thread))]
        default:
            return []
        }
    }

    /// A subagent's path as words: `/root/avatar_coverage` → "avatar coverage".
    static func agentName(_ path: String) -> String {
        let last = path.split(separator: "/").last.map(String.init) ?? path
        let words = last.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return words.isEmpty ? "subagent" : words
    }

    private mutating func subagentLine(_ method: String, _ params: [String: Any], thread: String) -> [CodexOutput] {
        guard let parent = subagentThreads[thread] else { return [] }
        switch method {
        case "thread/settings/updated":
            guard let settings = params["threadSettings"] as? [String: Any] else { return [] }
            return workerSettings(parent, settings: settings, runtime: .codex(settings, effortKey: "effort"))
        case "turn/started":
            guard subagentActivityThreads.contains(thread),
                  activeSubagentActivityThreads.insert(thread).inserted else { return [] }
            return [.event(.trace(.subagentStarted(id: parent, description: "", type: "codex", prompt: "", background: false)))]
        case "item/started":
            guard let item = params["item"] as? [String: Any], let step = started(item) else { return [] }
            return [.event(.trace(Self.under(parent, step)))]
        case "item/completed":
            guard let item = params["item"] as? [String: Any], let id = item["id"] as? String else { return [] }
            if item["type"] as? String == "agentMessage" {
                let words = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !words.isEmpty else { return [] }
                subagentSaid[thread] = words
                return [.event(.trace(.text(words, parent: parent)))]
            }
            _ = id
            return completed(item).map { .event(.trace(Self.under(parent, $0))) }
        case "turn/completed":
            // With `subAgentActivity`, the parent's `completed` item says it is done.
            if subagentActivityThreads.contains(thread) { return [] }
            // Its turn ended: it is done unless it is given more (a wait reports that too).
            let status = (params["turn"] as? [String: Any])?["status"] as? String
            subagentUsageThreads[thread] = subagentThreads[thread]
            subagentThreads[thread] = nil
            let ended = status == "completed" ? "completed" : status == "interrupted" ? "killed" : "failed"
            return [.event(.trace(.subagentEnded(id: parent, status: ended, summary: subagentSaid.removeValue(forKey: thread))))]
        default:
            return []
        }
    }

    /// The same step, made by a subagent.
    static func under(_ parent: String, _ step: TraceEvent) -> TraceEvent {
        switch step {
        case let .toolUse(id, tool, title, detail, _): .toolUse(id: id, tool: tool, title: title, detail: detail, parent: parent)
        case let .toolResult(id, output, failed, _): .toolResult(id: id, output: output, failed: failed, parent: parent)
        case let .text(text, _): .text(text, parent: parent)
        default: step
        }
    }

    // MARK: Codex's reviewer (auto mode)

    /// Codex's reviewer refused a call: the same card as auto mode's blocks on Claude, with
    /// its reason. The call is shown as a step first, so the card says what it was.
    private func reviewed(_ params: [String: Any]) -> [CodexOutput] {
        guard let review = params["review"] as? [String: Any], review["status"] as? String == "denied" else { return [] }
        let action = params["action"] as? [String: Any] ?? [:]
        let id = params["targetItemId"] as? String ?? params["reviewId"] as? String ?? UUID().uuidString
        let command = action["command"] as? String ?? (action["argv"] as? [String])?.joined(separator: " ") ?? ""
        var out: [CodexOutput] = []
        if !command.isEmpty {
            out.append(.event(.trace(.toolUse(id: id, tool: "Bash", title: StreamEvent.activity(tool: "Bash", input: ["command": command]), detail: command, parent: nil))))
        }
        let risk = (review["riskLevel"] as? String).map { "[\($0) risk] " } ?? ""
        out.append(.event(.permissionDenied(PermissionDenial(toolUseID: id, tool: command.isEmpty ? nil : "Bash", reason: risk + (review["rationale"] as? String ?? ""), confirmed: true))))
        return out
    }

    /// Codex's limits as the app keeps Claude's: the shorter window as the 5-hour one, the
    /// longer as the week (Codex says how long each is).
    static func rateLimits(_ snapshot: [String: Any], seen: Date) -> RateLimits {
        var limits = RateLimits()
        for key in ["primary", "secondary"] {
            guard let window = snapshot[key] as? [String: Any], let used = (window["usedPercent"] as? NSNumber)?.doubleValue else { continue }
            let resets = (window["resetsAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
            let reading = RateLimitWindow(used: min(max(used / 100, 0), 1), resetsAt: resets, seen: seen)
            let minutes = (window["windowDurationMins"] as? NSNumber)?.intValue ?? 0
            if minutes > 24 * 60 { limits.week = reading } else { limits.fiveHour = reading }
        }
        return limits
    }

    static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.count > 60 ? String(line.prefix(60)) + "…" : line
    }

    // MARK: Reading

    /// The reply: the last message that is not commentary (the final answer); else the last one.
    static func reply(from said: [(text: String, phase: String?)]) -> String {
        (said.last { $0.phase != "commentary" } ?? said.last)?.text ?? ""
    }

    /// What it ran, without the shell wrapping it (`/bin/zsh -lc '…'`) when Codex parsed it.
    static func command(_ item: [String: Any]) -> String {
        let actions = (item["commandActions"] as? [[String: Any]] ?? []).compactMap { $0["command"] as? String }
        if actions.count == 1 { return actions[0] }
        return item["command"] as? String ?? actions.joined(separator: " && ")
    }

    static func items(_ input: Input) -> [[String: Any]] {
        var items: [[String: Any]] = [["type": "text", "text": input.text]]
        for image in input.images where image.kind == .image {
            items.append(["type": "localImage", "path": image.url.path])
        }
        return items
    }

    /// Codex's reasoning efforts go up to `xhigh`; Max is its highest.
    static func effort(_ level: EffortLevel) -> String {
        level == .max ? EffortLevel.xhigh.rawValue : level.rawValue
    }

    /// Codex counts cached input inside its input tokens; the app counts them apart.
    static func tokens(_ breakdown: [String: Any]) -> TokenUsage {
        func count(_ key: String) -> Int { (breakdown[key] as? NSNumber)?.intValue ?? 0 }
        let cached = count("cachedInputTokens")
        return TokenUsage(input: max(0, count("inputTokens") - cached), output: count("outputTokens"), cacheWrite: count("cacheWriteInputTokens"), cacheRead: cached)
    }

    /// The error said it never got an answer from the API (`codexErrorInfo`).
    static func isConnectionLoss(_ info: Any?) -> Bool {
        guard let info = info as? [String: Any] else { return false }
        return ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"].contains { info[$0] != nil }
    }

    static func key(_ id: Any) -> String {
        if let number = id as? NSNumber { return number.stringValue }
        return "\(id)"
    }

    static func message(_ error: [String: Any]?) -> String {
        error?["message"] as? String ?? "Codex did not answer."
    }

    static func json(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "" }
        if let text = value as? String { return text }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted]) else { return "\(value)" }
        return String(decoding: data, as: UTF8.self)
    }
}

extension TokenUsage {
    static func - (a: TokenUsage, b: TokenUsage) -> TokenUsage {
        TokenUsage(input: max(0, a.input - b.input), output: max(0, a.output - b.output), cacheWrite: max(0, a.cacheWrite - b.cacheWrite), cacheRead: max(0, a.cacheRead - b.cacheRead))
    }
}

/// One long-lived `codex app-server` process for one bot session: `CodexSession` over its stdio.
public final class CodexAgentProcess: AgentProcess, @unchecked Sendable {
    public let events: AsyncStream<AgentEvent>
    private let process: Process
    private let stdin: FileHandle
    private let lock = NSLock()
    private var session: CodexSession
    private var closed = false
    private var savedWorkers: [CodexManagedWorkerRecord] = []
    private let continuation: AsyncStream<AgentEvent>.Continuation
    private let sessionID: UUID
    private let threads: CodexThreads
    private let managedMode: Bool
    private let failure = Failure()

    public static func launcher(executable: URL, threads: CodexThreads = .shared) -> AgentLauncher {
        { launch in try CodexAgentProcess(launch, executable: executable, threads: threads) }
    }

    /// What the session starts with, from what the bot asks for: Claude's tools, plugins and
    /// models are not Codex's and are left out.
    static func config(for launch: AgentLaunch, threads: CodexThreads) throws -> CodexSession.Config {
        var resume: String?
        if launch.resume || launch.forkSession {
            guard let thread = threads.thread(for: launch.sessionID) else { throw CocoaError(.fileNoSuchFile) }
            // Dynamic tools cannot change on resume/fork. A missing/outdated schema stamp
            // (including old two-tool managed threads) gets a new coordinator; Bot carries
            // saved memory/recent chat, save preserves the old thread ID, and task records stay.

            if launch.codexWorkerInstructions == nil || threads.isManaged(launch.sessionID, thread: thread) {
                resume = thread
            }
        }
        return CodexSession.Config(
            workingDirectory: launch.workingDirectory,
            instructions: launch.systemPrompt,
            autoMode: launch.autoMode,
            writableRoots: launch.extraDirectories,
            effort: launch.effort,
            resumeThread: resume,
            model: launch.codexModel,
            workerInstructions: launch.codexWorkerInstructions,
            workerDefaults: launch.codexWorkerDefaults,
            restoredWorkers: launch.codexWorkerInstructions == nil ? [] : threads.workers(for: launch.sessionID)
        )
    }

    init(_ launch: AgentLaunch, executable: URL, threads: CodexThreads) throws {
        BrokenPipes.ignore()
        session = CodexSession(config: try Self.config(for: launch, threads: threads))
        sessionID = launch.sessionID
        self.threads = threads
        managedMode = launch.codexWorkerInstructions != nil
        process = Process()
        process.executableURL = executable
        process.arguments = ["app-server"]
        process.currentDirectoryURL = launch.workingDirectory
        process.environment = CodexCLI.environment().merging(launch.environment) { _, launch in launch }

        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        stdin = input.fileHandleForWriting

        let (stream, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
        events = stream
        self.continuation = continuation
        let lines = LineBuffer()
        let stderrTail = CodexTail()
        let reader = Reader()

        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            for line in lines.append(data) { reader.read?(line) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            stderrTail.append(data)
        }
        let failure = self.failure
        process.terminationHandler = { process in
            ChildProcessLedger.shared?.forget(process.processIdentifier)
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
                output.fileHandleForReading.readabilityHandler = nil
                errors.fileHandleForReading.readabilityHandler = nil
                if let rest = lines.flush() { reader.read?(rest) }
                let why = [failure.message, stderrTail.text].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
                continuation.yield(.exited(status: failure.message == nil ? process.terminationStatus : 1, stderr: why))
                continuation.finish()
            }
        }
        reader.read = { [weak self] line in
            guard let self else { return }
            self.run { $0.receive(line) }
        }
        try process.run()
        ChildProcessLedger.shared?.record(process.processIdentifier)
        run { $0.start() }
    }

    /// Steps the session and does what it says, in order, under the lock (writes keep their order).
    private func run(_ step: (inout CodexSession) -> [CodexOutput]) {
        lock.withLock {
            let outputs = step(&session)
            let records = session.managedWorkerRecords
            if records != savedWorkers {
                threads.saveWorkers(records, for: sessionID)
                savedWorkers = records
            }
            for output in outputs {
                switch output {
                case let .write(object):
                    guard !closed, var data = try? JSONSerialization.data(withJSONObject: object) else { continue }
                    data.append(0x0A)
                    try? stdin.write(contentsOf: data)
                case let .event(event):
                    continuation.yield(event)
                case let .thread(id):
                    threads.save(id, for: sessionID)
                    if managedMode { threads.markManaged(id, for: sessionID) }
                case .close:
                    closeInput()
                case let .failed(message):
                    failure.message = message
                    closeInput()
                    if process.isRunning { process.terminate() }
                }
            }
        }
    }

    private func closeInput() {
        guard !closed else { return }
        closed = true
        try? stdin.close()
    }

    public func send(_ text: String) {
        deliver(text, images: [], id: nil)
    }

    public func send(_ text: String, images: [Attachment]) {
        deliver(text, images: images, id: nil)
    }

    public func send(_ text: String, images: [Attachment], id: UUID) {
        deliver(text, images: images, id: id)
    }

    private func deliver(_ text: String, images: [Attachment], id: UUID?) {
        run { $0.send(CodexSession.Input(text: text, images: images, id: id)) }
    }

    public func answer(_ request: PermissionRequest, allow: Bool, message: String?) {
        run { $0.answer(request.id, allow: allow, message: message) }
    }

    public func allow(rules: [String]) {
        run { $0.allow(rules: rules) }
    }

    public func interrupt() {
        run { $0.interrupt() }
    }

    public func finish() {
        run { $0.finish() }
    }

    public func stop() {
        run { $0.stop() }
        lock.withLock { closeInput() }
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [process] in
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

private final class Reader: @unchecked Sendable {
    var read: ((String) -> Void)?
}

private final class Failure: @unchecked Sendable {
    private let lock = NSLock()
    private var text: String?
    var message: String? {
        get { lock.withLock { text } }
        set { lock.withLock { text = newValue } }
    }
}

private final class CodexTail: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.withLock {
            data.append(chunk)
            if data.count > 8_000 { data = data.suffix(8_000) }
        }
    }

    var text: String {
        lock.withLock { String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}

/// A model Codex offers (`model/list`), for the Codex model menu.
public struct CodexModel: Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let isDefault: Bool

    public init(id: String, name: String, isDefault: Bool) {
        self.id = id
        self.name = name
        self.isDefault = isDefault
    }
}

/// The models the local Codex offers, asked of `codex app-server` (`model/list`) once per app
/// run, so the menu lists what this Codex and this account have, not a list kept in the app.
public enum CodexModels {
    private static let cache = Cache()

    public static func load() async -> [CodexModel] {
        if let known = cache.models { return known }
        let found = await Task.detached(priority: .utility) { () -> [CodexModel] in
            guard let executable = CodexCLI.locateNewest() else { return [] }
            return ask(executable)
        }.value
        if !found.isEmpty { cache.models = found }
        return found
    }

    /// The models in a `model/list` response line; nil for any other line.
    static func parse(_ line: String) -> [CodexModel]? {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (object["id"] as? NSNumber)?.intValue == 2,
              let list = (object["result"] as? [String: Any])?["data"] as? [[String: Any]] else { return nil }
        return list.compactMap { model in
            guard model["hidden"] as? Bool != true, let id = model["id"] as? String else { return nil }
            return CodexModel(id: id, name: model["displayName"] as? String ?? id, isDefault: model["isDefault"] as? Bool ?? false)
        }
    }

    private static func ask(_ executable: URL) -> [CodexModel] {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["app-server"]
        process.environment = CodexCLI.environment()
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        BrokenPipes.ignore()
        guard (try? process.run()) != nil else { return [] }
        let box = ProcessBox(process)
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { box.stop() }
        let lines = [
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claudecodebot","version":"1"}}}"#,
            #"{"jsonrpc":"2.0","method":"initialized"}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"model/list","params":{}}"#,
        ]
        try? input.fileHandleForWriting.write(contentsOf: Data((lines.joined(separator: "\n") + "\n").utf8))
        let buffer = LineBuffer()
        var found: [CodexModel] = []
        while true {
            let data = output.fileHandleForReading.availableData
            if data.isEmpty { break }
            if let models = buffer.append(data).lazy.compactMap(parse).first {
                found = models
                break
            }
        }
        try? input.fileHandleForWriting.close()
        box.stop()
        return found
    }

    private final class Cache: @unchecked Sendable {
        private let lock = NSLock()
        private var value: [CodexModel]?
        var models: [CodexModel]? {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }
}
