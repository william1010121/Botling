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
        try? Data(thread.utf8).write(to: folder.appending(path: session.uuidString.lowercased()), options: .atomic)
    }
    func isManaged(_ session: UUID, thread: String) -> Bool {
        let url = folder.appending(path: session.uuidString.lowercased() + ".managed")
        return (try? String(contentsOf: url, encoding: .utf8)) == thread
    }

    func markManaged(_ thread: String, for session: UUID) {
        let folder = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? Data(thread.utf8).write(to: folder.appending(path: session.uuidString.lowercased() + ".managed"), options: .atomic)
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
        var restoredWorkers: [CodexManagedWorkerRecord] = []
    }

    private enum Call {
        case initialize, thread, turn, interrupt, other
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
                    turn: record.turn, run: record.run, status: status, report: report))
            } else if record.wasActive {
                workerResults.append(ManagedResult(task: record.id, name: record.name, thread: record.thread,
                    turn: nil, run: record.run, status: "interrupted",
                    report: "The app stopped before this worker completed. Send a message to the same task_id to resume its session."))
            }
        }
    }

    // MARK: From the bot

    mutating func start() -> [CodexOutput] {
        [request("initialize", ["clientInfo": ["name": "claudecodebot", "title": "ClaudeCodeBot", "version": "1"], "capabilities": ["experimentalApi": true]], as: .initialize)]
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
            threadID = thread
            var out: [CodexOutput] = [.thread(thread)]
            if !inbox.isEmpty { out += startTurn(inbox.removeFirst()) }
            else { out += next() }
            out += pendingChanged()
            return out
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
