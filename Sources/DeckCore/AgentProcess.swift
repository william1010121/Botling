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
}

extension AgentProcess {
    public func send(_ text: String, images: [Attachment]) {
        send(text)
    }
}

public enum AgentEvent: Equatable, Sendable {
    /// The final text of one turn.
    case reply(String, isError: Bool)
    /// What it is doing right now, from a tool call: 「改 template.html」.
    case activity(String)
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

        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            for line in lines.append(data) {
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
        // When Deck is started from inside a Claude Code session, these would make the child
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
