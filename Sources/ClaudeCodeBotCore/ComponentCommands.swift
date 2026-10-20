import Combine
import Foundation

/// What running a component's command gave.
public struct CommandOutcome: Equatable, Sendable {
    /// JSON for the component's data, when it worked.
    public var data: String?
    /// Why it did not, in a sentence, with the end of what it printed.
    public var error: String?
    public var ranAt: Date

    public init(data: String? = nil, error: String? = nil, ranAt: Date = Date()) {
        self.data = data
        self.error = error
        self.ranAt = ranAt
    }
}

/// Components whose data comes from a CLI command instead of JSON written in the reply:
/// `<show name="x" command="git diff --stat"></show>`, or a component whose about.md has a
/// `Command: …` line. The command runs in the bot's project folder, but only once the user has
/// allowed that command for that folder (remembered in `approved-commands.json`); it gets a time
/// limit and an output cap. Its stdout becomes the data: parsed as JSON when it is JSON, else a
/// JSON string of the text. Each card keeps its own last run and can run it again.
@MainActor
public final class ComponentCommands: ObservableObject {
    public enum Status: String, Encodable, Sendable {
        /// The user has not allowed this command in this folder yet.
        case approve
        /// Allowed, not run yet: the page asks for a run when it draws it.
        case idle
        case running
        case done
        case failed
    }

    /// One card's command as the page draws it.
    public struct State: Equatable, Sendable {
        public var status: Status
        /// The last output's data (kept while it runs again).
        public var data: String?
        public var error: String?
        public var ranAt: Date?
    }

    public typealias Runner = @Sendable (_ command: String, _ folder: URL) -> CommandOutcome

    @Published public private(set) var runs: [String: State] = [:]
    /// Allowed commands, by folder path.
    @Published public private(set) var approved: [String: [String]]
    public let approvalsURL: URL
    private let runner: Runner

    public nonisolated static let timeout: TimeInterval = 60
    public nonisolated static let outputLimit = 1_000_000

    public init(approvalsURL: URL, runner: Runner? = nil) {
        self.approvalsURL = approvalsURL
        self.runner = runner ?? { command, folder in
            ComponentCommands.execute(command, in: folder, timeout: ComponentCommands.timeout, limit: ComponentCommands.outputLimit)
        }
        approved = (try? Data(contentsOf: approvalsURL))
            .flatMap { try? JSONDecoder().decode([String: [String]].self, from: $0) } ?? [:]
    }

    // MARK: Approval

    private static func key(_ folder: URL) -> String { folder.standardizedFileURL.path }

    public func isApproved(_ command: String, in folder: URL) -> Bool {
        approved[Self.key(folder)]?.contains(command) == true
    }

    public func approve(_ command: String, in folder: URL) {
        guard !isApproved(command, in: folder) else { return }
        approved[Self.key(folder), default: []].append(command)
        try? FileManager.default.createDirectory(at: approvalsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try? encoder.encode(approved).write(to: approvalsURL, options: .atomic)
    }

    // MARK: Running

    /// The card `card` (a message and its component's place) with `command` in `folder`.
    public func state(for card: String, command: String, in folder: URL) -> State {
        if let run = runs[card] { return run }
        return State(status: isApproved(command, in: folder) ? .idle : .approve)
    }

    /// Runs it for this card, if allowed and not running already. `force` runs a done or failed
    /// card again (its refresh button); without it only a card not run yet starts.
    public func run(card: String, command: String, in folder: URL, force: Bool = false) async {
        guard isApproved(command, in: folder) else { return }
        let previous = runs[card]
        if previous?.status == .running { return }
        if previous != nil, !force { return }
        runs[card] = State(status: .running, data: previous?.data, error: nil, ranAt: previous?.ranAt)
        let runner = runner
        let outcome = await blocking { runner(command, folder) }
        if let data = outcome.data {
            runs[card] = State(status: .done, data: data, error: nil, ranAt: outcome.ranAt)
        } else {
            runs[card] = State(status: .failed, data: nil, error: outcome.error ?? "The command failed.", ranAt: outcome.ranAt)
        }
    }

    // MARK: Output

    /// stdout as component data: the JSON itself when it is JSON, else a JSON string of the text.
    public nonisolated static func data(fromOutput output: String) -> String {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8), options: .fragmentsAllowed)) != nil {
            return trimmed
        }
        let text = output.hasSuffix("\n") ? String(output.dropLast()) : output
        let encoded = (try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("\"\"".utf8)
        return String(decoding: encoded, as: UTF8.self)
    }

    /// Runs `command` with the user's login shell setup (zsh -lc) in `folder`, without input,
    /// stopping it after `timeout` seconds or once it prints more than `limit` bytes. Blocking.
    public nonisolated static func execute(_ command: String, in folder: URL, timeout: TimeInterval, limit: Int) -> CommandOutcome {
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder), isFolder.boolValue else {
            return CommandOutcome(error: "The project folder \(folder.path) is not there.")
        }
        let process = Process()
        process.executableURL = URL(filePath: "/bin/zsh")
        process.arguments = ["-lc", command]
        process.currentDirectoryURL = folder
        process.environment = environment()
        process.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err

        let collected = Collected(limit: limit)
        let finished = DispatchSemaphore(value: 0)
        // Both pipes reaching their end, so nothing printed last is lost.
        let drained = DispatchGroup()
        drained.enter()
        drained.enter()
        out.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; drained.leave(); return }
            if collected.add(chunk, error: false) { process.terminate() }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; drained.leave(); return }
            _ = collected.add(chunk, error: true)
        }
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            return CommandOutcome(error: "Couldn't start the command: \(error.localizedDescription)")
        }
        var timedOut = false
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            process.terminate()
            if finished.wait(timeout: .now() + 2) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = finished.wait(timeout: .now() + 2)
            }
        }
        // What is left in the pipes (a child still holding them open is not waited for long).
        _ = drained.wait(timeout: .now() + 1)
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        let (stdout, stderr, overflow) = collected.result()
        if overflow {
            return CommandOutcome(error: "The command printed more than \(limit / 1000) KB, so it was stopped.")
        }
        if timedOut {
            return CommandOutcome(error: "The command took longer than \(Int(timeout)) seconds, so it was stopped." + tail(stderr))
        }
        let text = String(decoding: stdout, as: UTF8.self)
        if process.terminationReason == .uncaughtSignal || process.terminationStatus != 0 {
            let said = String(decoding: stderr, as: UTF8.self).isEmpty ? text : String(decoding: stderr, as: UTF8.self)
            return CommandOutcome(error: "The command failed (exit code \(process.terminationStatus))." + tail(Data(said.utf8)))
        }
        return CommandOutcome(data: data(fromOutput: text))
    }

    /// The last lines a failed command printed, after a newline; nothing if it printed nothing.
    private nonisolated static func tail(_ output: Data) -> String {
        let text = String(decoding: output.suffix(2_000), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "" : "\n" + text
    }

    private nonisolated static func environment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        for key in ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"] {
            environment.removeValue(forKey: key)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let existing = environment["PATH"].map { $0.split(separator: ":").map(String.init) } ?? []
        environment["PATH"] = (extra + existing.filter { !extra.contains($0) }).joined(separator: ":")
        environment["NO_COLOR"] = "1"
        return environment
    }
}

/// A command's output as it comes, up to a limit.
private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var stdout = Data()
    private var stderr = Data()
    private var overflow = false

    init(limit: Int) { self.limit = limit }

    /// Adds a chunk; true when stdout just went over the limit (the command should stop).
    func add(_ chunk: Data, error: Bool) -> Bool {
        lock.withLock {
            if error {
                stderr.append(chunk)
                if stderr.count > 8_000 { stderr = stderr.suffix(8_000) }
                return false
            }
            guard !overflow else { return false }
            stdout.append(chunk)
            if stdout.count > limit {
                overflow = true
                stdout = Data()
                return true
            }
            return false
        }
    }

    func result() -> (Data, Data, Bool) {
        lock.withLock { (stdout, stderr, overflow) }
    }
}
