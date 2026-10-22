import Foundation

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
        try? Data(thread.utf8).write(to: folder.appending(path: session.uuidString.lowercased()), options: .atomic)
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
    }

    private enum Call {
        case initialize, thread, turn, steer, interrupt, other
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
    /// Questions waiting for the user, by the request's id as text, with the id as it came.
    private var approvals: [String: (rpcID: Any, kind: Approval)] = [:]
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
    /// What each subagent thread said last, for its report.
    private var subagentSaid: [String: String] = [:]

    init(config: Config) {
        self.config = config
    }

    // MARK: From the bot

    mutating func start() -> [CodexOutput] {
        [request("initialize", ["clientInfo": ["name": "claudecodebot", "title": "ClaudeCodeBot", "version": "1"]], as: .initialize)]
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
        if !allow, let message, !message.isEmpty, let turn, let id = turn.id {
            out.append(steer(Input(text: "(App: \(message))"), turnID: id))
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
        return turn == nil && inbox.isEmpty ? [.close] : []
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
            threadID = thread
            var out: [CodexOutput] = [.thread(thread)]
            if !inbox.isEmpty { out += startTurn(inbox.removeFirst()) }
            return out
        case .turn:
            if let error {
                // The turn never started: its message gets an error reply, and the next goes.
                turn = nil
                var out: [CodexOutput] = [.event(.reply(Self.message(error), isError: true))]
                out += next()
                return out
            }
            if let id = (result?["turn"] as? [String: Any])?["id"] as? String { return learnTurn(id) }
            return []
        case .steer:
            // The turn ended just before the message reached it: it goes as a turn of its own.
            guard error != nil, let input = lastSteer else { return [] }
            lastSteer = nil
            if turn == nil { return startTurn(input) }
            inbox.append(input)
            return []
        case .interrupt, .other:
            return []
        }
    }

    private mutating func notification(_ method: String, _ params: [String: Any]) -> [CodexOutput] {
        // A line from one of Codex's own subagents: a step under it, not the bot's turn.
        if let thread = params["threadId"] as? String, let main = threadID, thread != main {
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
        switch method {
        case "item/commandExecution/requestApproval":
            let asked = [params["command"] as? String, Self.command(params)].compactMap { $0 }
            if asked.contains(where: allowedCommands.contains) {
                return [.write(["jsonrpc": "2.0", "id": rpcID, "result": ["decision": "accept"]])]
            }
            approvals[key] = (rpcID, .command)
            var summary = params["command"] as? String ?? ""
            if let reason = params["reason"] as? String, !reason.isEmpty { summary += (summary.isEmpty ? "" : "\n\n") + reason }
            return [.event(.permission(PermissionRequest(id: key, tool: "Bash", summary: summary, input: "{}")))]
        case "item/fileChange/requestApproval":
            approvals[key] = (rpcID, .fileChange)
            let files = (params["itemId"] as? String).flatMap { changedFiles[$0] } ?? []
            var summary = files.joined(separator: "\n")
            if let root = params["grantRoot"] as? String, !root.isEmpty { summary += (summary.isEmpty ? "" : "\n") + root }
            if let reason = params["reason"] as? String, !reason.isEmpty { summary += (summary.isEmpty ? "" : "\n\n") + reason }
            return [.event(.permission(PermissionRequest(id: key, tool: "Edit", summary: summary, input: "{}")))]
        case "item/permissions/requestApproval":
            let asked = params["permissions"] as? [String: Any] ?? [:]
            approvals[key] = (rpcID, .permissions(asked))
            let json = (try? JSONSerialization.data(withJSONObject: asked, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
            let summary = [params["reason"] as? String, json].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            return [.event(.permission(PermissionRequest(id: key, tool: "Permissions", summary: summary, input: "{}")))]
        case "mcpServer/elicitation/request":
            // A form the app cannot show: declined, so nothing waits on it.
            return [.write(["jsonrpc": "2.0", "id": rpcID, "result": ["action": "decline"]])]
        default:
            // Bots ask in the chat (<choices>); anything else is not the app's to answer.
            return [.write(["jsonrpc": "2.0", "id": rpcID, "error": ["code": -32601, "message": "Not supported by ClaudeCodeBot."]])]
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
        if let model = config.model { params["model"] = model }
        if !config.writableRoots.isEmpty {
            params["config"] = ["sandbox_workspace_write": ["writable_roots": config.writableRoots.map(\.path)]]
        }
        if let thread = config.resumeThread {
            params["threadId"] = thread
            params["excludeTurns"] = true
            return request("thread/resume", params, as: .thread)
        }
        return request("thread/start", params, as: .thread)
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
        if let effort = config.effort { params["effort"] = Self.effort(effort) }
        if let reviewer = reviewerNext {
            params["approvalsReviewer"] = reviewer
            reviewerNext = reviewer == "user" ? "auto_review" : nil
        }
        return [request("turn/start", params, as: .turn)]
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
        lastSteer = nil
        var out: [CodexOutput] = []
        let used = tokensTotal - tokensAtTurnStart
        if used.total > 0 { out.append(.event(.usage(totalCost: 0, tokens: used))) }
        switch finished["status"] as? String {
        case "interrupted":
            // Stopped for a message (`interrupt`): an error result the bot does not show, then
            // that message as a turn of its own.
            out.append(.event(.reply(current.interruptAsked ? "" : "Codex stopped this turn.", isError: true)))
            if let input = afterInterrupt {
                afterInterrupt = nil
                inbox.insert(input, at: 0)
            }
        case "failed":
            let error = finished["error"] as? [String: Any]
            if Self.isConnectionLoss(error?["codexErrorInfo"]) { out.append(.event(.connectionLost(parent: nil))) }
            out.append(.event(.reply(error?["message"] as? String ?? "Codex failed.", isError: true)))
        default:
            out.append(.event(.reply(Self.reply(from: current.said), isError: false)))
        }
        out += next()
        return out
    }

    /// The next waiting message's turn, or the end once `finish` asked for it.
    private mutating func next() -> [CodexOutput] {
        if !inbox.isEmpty { return startTurn(inbox.removeFirst()) }
        return finishing ? [.close] : []
    }

    private mutating func steer(_ input: Input, turnID: String) -> CodexOutput {
        request("turn/steer", ["threadId": threadID ?? "", "expectedTurnId": turnID, "input": Self.items(input)], as: .steer)
    }

    private mutating func request(_ method: String, _ params: [String: Any], as call: Call) -> CodexOutput {
        let id = nextID
        nextID += 1
        calls[id] = call
        return .write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
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
            subagentThreads[thread] = nil
            let said = (state["message"] as? String) ?? subagentSaid.removeValue(forKey: thread)
            return .subagentEnded(id: subagent, status: ended, summary: said)
        }
    }

    private mutating func subagentLine(_ method: String, _ params: [String: Any], thread: String) -> [CodexOutput] {
        guard let parent = subagentThreads[thread] else { return [] }
        switch method {
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
            // Its turn ended: it is done unless it is given more (a wait reports that too).
            let status = (params["turn"] as? [String: Any])?["status"] as? String
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
    private let continuation: AsyncStream<AgentEvent>.Continuation
    private let sessionID: UUID
    private let threads: CodexThreads
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
            resume = thread
        }
        return CodexSession.Config(
            workingDirectory: launch.workingDirectory,
            instructions: launch.systemPrompt,
            autoMode: launch.autoMode,
            writableRoots: launch.extraDirectories,
            effort: launch.effort,
            resumeThread: resume,
            model: launch.codexModel
        )
    }

    init(_ launch: AgentLaunch, executable: URL, threads: CodexThreads) throws {
        BrokenPipes.ignore()
        session = CodexSession(config: try Self.config(for: launch, threads: threads))
        sessionID = launch.sessionID
        self.threads = threads
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
            for output in step(&session) {
                switch output {
                case let .write(object):
                    guard !closed, var data = try? JSONSerialization.data(withJSONObject: object) else { continue }
                    data.append(0x0A)
                    try? stdin.write(contentsOf: data)
                case let .event(event):
                    continuation.yield(event)
                case let .thread(id):
                    threads.save(id, for: sessionID)
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
