import Foundation

/// What the bot needs from one running `claude` session.
public protocol AgentProcess: AnyObject, Sendable {
    var events: AsyncStream<AgentEvent> { get }
    /// Sends a user message. While a turn is running, Claude merges it into that turn.
    func send(_ text: String)
    /// Sends a user message with images Claude looks at directly.
    func send(_ text: String, images: [Attachment])
    /// Closes stdin: Claude finishes what it is doing, then exits.
    func finish()
    /// Ends the process now.
    func stop()
    /// Answers a `.permission` request: let the tool run, or not (`message` says why to Claude).
    func answer(_ request: PermissionRequest, allow: Bool, message: String?)
    /// Stops the turn under way; it ends with an error result, and the session goes on.
    func interrupt()
}

extension AgentProcess {
    public func send(_ text: String, images: [Attachment]) {
        send(text)
    }

    public func answer(_ request: PermissionRequest, allow: Bool, message: String?) {}

    public func interrupt() {}
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
    /// What it is doing on the way: a tool call, its result, a subagent.
    case trace(TraceEvent)
    /// It is waiting for the user to allow a tool.
    case permission(PermissionRequest)
    /// It no longer needs the answer to that permission request (its id).
    case permissionCancelled(String)
    case exited(status: Int32, stderr: String)
}

public struct AgentLaunch: Equatable, Sendable {
    public var model: BotModel
    public var sessionID: UUID
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
}

public typealias AgentLauncher = @Sendable (AgentLaunch) throws -> AgentProcess

/// One long-lived `claude -p --input-format stream-json` process. It stays alive while stdin is
/// open, so it can be steered mid-turn (verified in prototypes/steering-probe).
public final class ClaudeAgentProcess: AgentProcess, @unchecked Sendable {
    public let events: AsyncStream<AgentEvent>
    private let process: Process
    private let stdin: FileHandle
    private let lock = NSLock()
    private var closed = false

    /// Writing to a `claude` that already exited would otherwise raise SIGPIPE and end the app.
    private static let ignoreBrokenPipes: Void = {
        signal(SIGPIPE, SIG_IGN)
    }()

    public static func launcher(executable: URL) -> AgentLauncher {
        { launch in try ClaudeAgentProcess(launch, executable: executable) }
    }

    static func arguments(for launch: AgentLaunch) -> [String] {
        var arguments = [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--session-id", launch.sessionID.uuidString.lowercased(),
            "--model", launch.model.rawValue,
            "--permission-mode", "acceptEdits",
            // Plugins' skills are used through the Skill tool.
            "--allowedTools", (launch.tools + (launch.pluginDirectories.isEmpty || launch.tools.contains("Skill") ? [] : ["Skill"]) + launch.pluginTools).joined(separator: ","),
            "--append-system-prompt", launch.systemPrompt
        ]
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
        return arguments
    }

    init(_ launch: AgentLaunch, executable: URL) throws {
        Self.ignoreBrokenPipes
        process = Process()
        process.executableURL = executable
        process.arguments = Self.arguments(for: launch)
        process.currentDirectoryURL = launch.workingDirectory
        process.environment = Self.environment().merging(launch.environment) { _, plugin in plugin }

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
        responder.send = { [weak self] response in self?.writeControlResponse(response) }
    }

    public func send(_ text: String) {
        send(text, images: [])
    }

    /// Images go in as base64 blocks, so the model sees them; bigger than Claude takes, they are
    /// left to the file paths the text already names.
    public func send(_ text: String, images: [Attachment]) {
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
        let message: [String: Any] = [
            "type": "user",
            "message": ["role": "user", "content": content.count == 1 ? text as Any : content as Any]
        ]
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

    /// `{"type":"control_request","request":{"subtype":"interrupt"}}`: claude answers with a
    /// control_response, then ends the turn with an `error_during_execution` result.
    public func interrupt() {
        let line: [String: Any] = [
            "type": "control_request",
            "request_id": "interrupt-\(UUID().uuidString.lowercased())",
            "request": ["subtype": "interrupt"]
        ]
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        lock.withLock {
            guard !closed else { return }
            try? stdin.write(contentsOf: data)
        }
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
