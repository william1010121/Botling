import Foundation

/// What the bot needs from one running `claude` session.
public protocol AgentProcess: AnyObject, Sendable {
    var events: AsyncStream<AgentEvent> { get }
    /// Sends a user message. While a turn is running, Claude merges it into that turn.
    func send(_ text: String)
    /// Sends a user message with images Claude looks at directly.
    func send(_ text: String, images: [Attachment])
    /// Sends a user message under `id`, so a process that can (claude) says when that message is
    /// queued and when its turn starts (`.commandQueued`, `.commandStarted`).
    func send(_ text: String, images: [Attachment], id: UUID)
    /// Closes stdin: Claude finishes what it is doing, then exits.
    func finish()
    /// Ends the process now.
    func stop()
    /// Answers a `.permission` request: let the tool run, or not (`message` says why to Claude).
    func answer(_ request: PermissionRequest, allow: Bool, message: String?)
    /// Stops the turn under way to take in the message just sent (send it first); the turn ends
    /// with an error result, and the session goes on. Subagents in the background keep running.
    func interrupt()
    /// Lets these permission rules ("Bash(rm -rf build)") through from now on, in the running
    /// session (`apply_flag_settings`). They add to what it has; one taken away goes next session.
    func allow(rules: [String])
}

extension AgentProcess {
    public func send(_ text: String, images: [Attachment]) {
        send(text)
    }

    public func send(_ text: String, images: [Attachment], id: UUID) {
        send(text, images: images)
    }

    public func answer(_ request: PermissionRequest, allow: Bool, message: String?) {}

    public func interrupt() {}

    public func allow(rules: [String]) {}
}

/// Auto mode's classifier blocked a tool call (claude's `permission_denied` frame, or the tool
/// result saying so). Only the classifier's own blocks: deny rules and safety checks are not
/// the user's to wave through here.
public struct PermissionDenial: Equatable, Sendable {
    public var toolUseID: String
    /// Nil when only the tool result said so (it does not name the tool).
    public var tool: String?
    /// The classifier's reason: "[Irreversible Local Destruction] …".
    public var reason: String
    /// False for the `permission_denied` frame: it names the call and the reason, but the
    /// classifier sends one for a call it gave no verdict on too; the tool result says which.
    public var confirmed: Bool

    public init(toolUseID: String, tool: String?, reason: String, confirmed: Bool = true) {
        self.toolUseID = toolUseID
        self.tool = tool
        self.reason = reason
        self.confirmed = confirmed
    }
}

/// Claude wants to use a tool it is not allowed to use without asking (with
/// `--permission-prompt-tool stdio` it asks on stdout and waits for the answer on stdin).
public struct PermissionRequest: Equatable, Sendable {
    /// The control request's id, to answer it.
    public var id: String
    public var tool: String
    /// What it wants to do, in one line: the command, the file, the page.
    public var summary: String
    /// The tool's input as JSON, handed back unchanged when allowed.
    public var input: String

    public init(id: String, tool: String, summary: String, input: String) {
        self.id = id
        self.tool = tool
        self.summary = summary
        self.input = input
    }
}

public enum AgentEvent: Equatable, Sendable {
    /// The final text of one turn.
    case reply(String, isError: Bool)
    /// The turn's last words, the moment they are said (see `FinalMessageWatch`): Stop hooks may
    /// still run, and may send it back to work; the turn ends with its `.reply`.
    case earlyReply(String)
    /// What it is doing on the way: a tool call, its result, a subagent.
    case trace(TraceEvent)
    /// It is waiting for the user to allow a tool.
    case permission(PermissionRequest)
    /// It no longer needs the answer to that permission request (its id).
    case permissionCancelled(String)
    /// Auto mode's classifier blocked a tool call; nothing waits for an answer.
    case permissionDenied(PermissionDenial)
    /// What this session has cost so far, in US dollars (sent with each turn's result).
    /// With the tokens this turn used.
    case usage(totalCost: Double, tokens: TokenUsage = TokenUsage())
    /// Claude could not reach the API (no HTTP answer at all) and is retrying (`api_retry`).
    case connectionTrouble(attempt: Int, maxRetries: Int)
    /// Claude gave up on the API with no answer from it (`NetworkResume.isConnectionLoss`): the
    /// turn (`parent` nil; its error `.reply` comes next) or that subagent was cut off.
    case connectionLost(parent: String?)
    /// The subscription's 5-hour and weekly limits as the API last reported them (`rate_limit_event`).
    case rateLimits(RateLimits)
    /// A message sent with an id is in claude's queue (`command_lifecycle` "queued"): turns
    /// already under way or waiting end before its turn.
    case commandQueued(UUID)
    /// The turn that takes in that message begins (`command_lifecycle` "started"): the next
    /// result line is its reply.
    case commandStarted(UUID)
    case exited(status: Int32, stderr: String)
}

public struct AgentLaunch: Equatable, Sendable {
    /// The CLI to run: `claude`, or `codex app-server` (`CodexAgentProcess`). What only one of
    /// them reads (Claude's tools and plugins, its models) the other leaves alone.
    public var engine: BotEngine = .claude
    public var model: BotModel
    public var sessionID: UUID
    /// Go on with the session `sessionID` names (`--resume`) instead of starting it.
    public var resume = false
    /// With `resume`: go on in a copy of that session (`--fork-session`), leaving it as it was.
    public var forkSession = false
    /// Keep the session's transcript so it can be resumed; false: `--no-session-persistence`
    /// (a one-off fork nobody resumes).
    public var persistSession = true
    public var workingDirectory: URL
    public var systemPrompt: String
    public var tools: [String] = ["Read", "Write", "Edit"]
    /// Folders outside `workingDirectory` it may read and edit (`--add-dir`).
    public var extraDirectories: [URL] = []
    /// Claude Code plugins it loads: skills, agents, MCP servers (`--plugin-dir`).
    public var pluginDirectories: [URL] = []
    /// Plugin tools it may use without asking (their MCP servers: `mcp__plugin_<p>_<server>`).
    public var pluginTools: [String] = []
    /// Extra environment: plugins' secrets, for MCP servers that read them.
    public var environment: [String: String] = [:]
    /// Ask (a `.permission` event) before using a tool that is not allowed, instead of being
    /// refused. Only bots, which have a chat to ask in; temporary teams are not.
    public var asksPermission = false
    /// Tools it does not have at all (it cannot even ask for them).
    public var disallowedTools: [String] = []
    /// Claude Code's auto mode (`--permission-mode auto`): its classifier approves safe actions
    /// (reads, edits in its folders, ordinary commands) and blocks risky ones (destroying files,
    /// sending data out, force pushes…), instead of asking about every tool not allowed. What it
    /// still asks about (ask rules, repeated blocks) comes as a `.permission` event as before.
    public var autoMode = false
    /// Permission rules let through without asking ("Bash(rm -rf build)"): calls the user allowed
    /// after auto mode blocked them. Passed in `--settings`, as a command may hold commas.
    public var allowRules: [String] = []
    /// How hard it thinks (`--effort`); nil leaves the model's default.
    public var effort: EffortLevel? = nil
    /// The model its subagents use (`CLAUDE_CODE_SUBAGENT_MODEL`); nil: the same as its own.
    /// An agent whose definition names a model keeps that one.
    public var subagentModel: BotModel? = nil
}

public typealias AgentLauncher = @Sendable (AgentLaunch) throws -> AgentProcess

/// One long-lived `claude -p --input-format stream-json` process. It stays alive while stdin is
/// open, so it can be steered mid-turn (verified in prototypes/steering-probe).
/// Writing to a child (`claude`, the plugin host) that already exited would otherwise raise
/// SIGPIPE and end the app; the write fails with EPIPE instead.
public enum BrokenPipes {
    private static let ignored: Void = { signal(SIGPIPE, SIG_IGN) }()
    public static func ignore() { ignored }
}

public final class ClaudeAgentProcess: AgentProcess, @unchecked Sendable {
    public let events: AsyncStream<AgentEvent>
    private let process: Process
    private let stdin: FileHandle
    private let lock = NSLock()
    private var closed = false


    public static func launcher(executable: URL) -> AgentLauncher {
        { launch in try ClaudeAgentProcess(launch, executable: executable) }
    }

    static func arguments(for launch: AgentLaunch) -> [String] {
        var arguments = [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            launch.resume || launch.forkSession ? "--resume" : "--session-id", launch.sessionID.uuidString.lowercased(),
            "--model", launch.model.rawValue,
            "--permission-mode", launch.autoMode ? "auto" : "acceptEdits",
            // Plugins' skills are used through the Skill tool.
            "--allowedTools", (launch.tools + (launch.pluginDirectories.isEmpty || launch.tools.contains("Skill") ? [] : ["Skill"]) + launch.pluginTools).joined(separator: ","),
            "--append-system-prompt", launch.systemPrompt
        ]
        if launch.forkSession {
            arguments.append("--fork-session")
        }
        if !launch.persistSession {
            arguments.append("--no-session-persistence")
        }
        if launch.asksPermission {
            // Bots ask in the chat with <choices>; AskUserQuestion would arrive as a permission
            // request that cannot carry the user's answer.
            arguments += ["--permission-prompt-tool", "stdio"]
        }
        let disallowed = (launch.asksPermission ? ["AskUserQuestion"] : []) + launch.disallowedTools
        if !disallowed.isEmpty {
            arguments += ["--disallowedTools", disallowed.joined(separator: ",")]
        }
        for directory in launch.extraDirectories {
            arguments += ["--add-dir", directory.path]
        }
        for directory in launch.pluginDirectories {
            arguments += ["--plugin-dir", directory.path]
        }
        if !launch.allowRules.isEmpty {
            arguments += ["--settings", Self.settingsJSON(allowing: launch.allowRules)]
        }
        if let effort = launch.effort {
            arguments += ["--effort", effort.rawValue]
        }
        return arguments
    }

    /// `{"permissions":{"allow":[…]}}`: the flag settings layer's allow rules. Only this
    /// session's layer: the user's own settings files stay as they are. It sets no hooks: whether
    /// a reply promised work is the app's own check (`PromiseCheck`).
    static func settingsJSON(allowing rules: [String]) -> String {
        var settings: [String: Any] = [:]
        if !rules.isEmpty { settings["permissions"] = ["allow": rules] }
        return (try? JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    /// What it adds to the app's environment: plugins' secrets, the subagent model, and the
    /// Artifact tool switched on. Claude Code leaves that tool out of `-p` sessions unless
    /// `CLAUDE_CODE_ARTIFACT` asks for it, so without it a bot has no way to publish a result
    /// (and when results stay local, nothing to ask the user for). One set in the app's own
    /// environment (`inherited`), say to switch it off, is left as it is.
    static func launchEnvironment(for launch: AgentLaunch, inherited: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment = launch.environment
        if inherited[artifactSwitch] == nil, environment[artifactSwitch] == nil {
            environment[artifactSwitch] = "1"
        }
        if let model = launch.subagentModel {
            environment["CLAUDE_CODE_SUBAGENT_MODEL"] = model.rawValue
        }
        return environment
    }

    static let artifactSwitch = "CLAUDE_CODE_ARTIFACT"

    /// The whole environment `claude` runs with: the app's, cleaned up, plus `launchEnvironment`.
    static func childEnvironment(for launch: AgentLaunch) -> [String: String] {
        environment().merging(launchEnvironment(for: launch)) { _, launch in launch }
    }

    init(_ launch: AgentLaunch, executable: URL) throws {
        BrokenPipes.ignore()
        process = Process()
        process.executableURL = executable
        process.arguments = Self.arguments(for: launch)
        process.currentDirectoryURL = launch.workingDirectory
        process.environment = Self.childEnvironment(for: launch)

        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        stdin = input.fileHandleForWriting

        let (stream, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
        events = stream
        let lines = LineBuffer()
        let watch = Watch()
        let stderrTail = Tail()
        let responder = Responder()
        let respond: (([String: Any]) -> Void)? = { response in responder.send?(response) }

        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            for line in lines.append(data) {
                if let id = StreamEvent.unsupportedRequest(in: line) {
                    // A request the app does not handle gets an error at once, so claude does not wait.
                    respond?(["subtype": "error", "request_id": id, "error": "Not supported by ClaudeCodeBot."])
                    continue
                }
                for event in StreamEvent.events(in: line) { continuation.yield(event) }
                if let text = watch.read(line) { continuation.yield(.earlyReply(text)) }
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            stderrTail.append(data)
        }
        process.terminationHandler = { process in
            ChildProcessLedger.shared?.forget(process.processIdentifier)
            // Give stdout a moment to drain before reporting the exit.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
                output.fileHandleForReading.readabilityHandler = nil
                errors.fileHandleForReading.readabilityHandler = nil
                if let rest = lines.flush(), let event = StreamEvent.reply(in: rest) {
                    continuation.yield(event)
                }
                continuation.yield(.exited(status: process.terminationStatus, stderr: stderrTail.text))
                continuation.finish()
            }
        }
        try process.run()
        // Written down, so a later app run can end it if this one goes without doing so.
        let pid = process.processIdentifier
        ChildProcessLedger.shared?.record(pid)
        responder.send = { [weak self] response in self?.writeControlResponse(response) }
    }

    public func send(_ text: String) {
        send(text, images: [])
    }

    public func send(_ text: String, images: [Attachment]) {
        write(text, images: images, id: nil)
    }

    public func send(_ text: String, images: [Attachment], id: UUID) {
        write(text, images: images, id: id)
    }

    /// Images go in as base64 blocks, so the model sees them; bigger than Claude takes, they are
    /// left to the file paths the text already names.
    private func write(_ text: String, images: [Attachment], id: UUID?) {
        var content: [[String: Any]] = [["type": "text", "text": text]]
        for image in images {
            guard let mediaType = image.mediaType,
                  let data = try? Data(contentsOf: image.url),
                  data.count <= 4_500_000 else { continue }
            content.append([
                "type": "image",
                "source": ["type": "base64", "media_type": mediaType, "data": data.base64EncodedString()]
            ])
        }
        var message: [String: Any] = [
            "type": "user",
            "message": ["role": "user", "content": content.count == 1 ? text as Any : content as Any]
        ]
        // claude reports the message's progress under this id (`command_lifecycle`).
        if let id { message["uuid"] = id.uuidString.lowercased() }
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        lock.withLock {
            guard !closed else { return }
            try? stdin.write(contentsOf: data)
        }
    }

    public func answer(_ request: PermissionRequest, allow: Bool, message: String?) {
        let decision: [String: Any] = allow
            ? ["behavior": "allow", "updatedInput": (try? JSONSerialization.jsonObject(with: Data(request.input.utf8))) ?? [String: Any]()]
            : ["behavior": "deny", "message": message ?? "The user did not allow this."]
        let line: [String: Any] = [
            "type": "control_response",
            "response": ["subtype": "success", "request_id": request.id, "response": decision]
        ]
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        lock.withLock {
            guard !closed else { return }
            try? stdin.write(contentsOf: data)
        }
    }

    /// `{"type":"control_request","request":{"subtype":"interrupt","send_now":true}}`: claude
    /// stops the turn for the message waiting in its queue and ends it with an
    /// `error_during_execution` result, then answers that message. A plain interrupt (without
    /// `send_now`) would also kill every background task: subagents sent off with
    /// `run_in_background` and their commands. With nothing waiting it stops nothing
    /// (`"send_now":"nothing_waiting"`), so the message goes first.
    public func interrupt() {
        let line = Self.interruptRequest()
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        lock.withLock {
            guard !closed else { return }
            try? stdin.write(contentsOf: data)
        }
    }

    /// `apply_flag_settings` merges into the same layer `--settings` set at launch; the rules
    /// apply to the next tool call (checked against claude 2.1.304).
    public func allow(rules: [String]) {
        let line: [String: Any] = [
            "type": "control_request",
            "request_id": "allow-\(UUID().uuidString.lowercased())",
            "request": ["subtype": "apply_flag_settings", "settings": ["permissions": ["allow": rules]]]
        ]
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        lock.withLock {
            guard !closed else { return }
            try? stdin.write(contentsOf: data)
        }
    }

    static func interruptRequest() -> [String: Any] {
        [
            "type": "control_request",
            "request_id": "interrupt-\(UUID().uuidString.lowercased())",
            "request": ["subtype": "interrupt", "send_now": true]
        ]
    }

    /// Writes a control_response with this body.
    private func writeControlResponse(_ response: [String: Any]) {
        let line: [String: Any] = ["type": "control_response", "response": response]
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        lock.withLock {
            guard !closed else { return }
            try? stdin.write(contentsOf: data)
        }
    }

    public func finish() {
        lock.withLock {
            guard !closed else { return }
            closed = true
            try? stdin.close()
        }
    }

    public func stop() {
        finish()
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [process] in
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private static func environment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        // When ClaudeCodeBot is started from inside a Claude Code session, these would make the child
        // think it is nested in that session.
        for key in ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"] {
            environment.removeValue(forKey: key)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let existing = environment["PATH"].map { $0.split(separator: ":").map(String.init) } ?? []
        environment["PATH"] = (extra + existing.filter { !extra.contains($0) }).joined(separator: ":")
        return environment
    }
}

/// Lets the output reader answer claude before `self` exists.
private final class Responder: @unchecked Sendable {
    var send: (([String: Any]) -> Void)?
}

/// The output reader's `FinalMessageWatch`.
private final class Watch: @unchecked Sendable {
    private let lock = NSLock()
    private var watch = FinalMessageWatch()

    func read(_ line: String) -> String? {
        lock.withLock { watch.read(line) }
    }
}

private final class Tail: @unchecked Sendable {
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
