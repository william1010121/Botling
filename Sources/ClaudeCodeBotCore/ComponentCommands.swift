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
    /// What each card's run is of (its folder and command): a card whose command or folder has
    /// changed since does not show the old output, and runs anew.
    private var ranWith: [String: String] = [:]
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
        saveApprovals()
    }

    /// Takes back an allowed command (Settings > Permissions): its cards ask again before it runs.
    public func forget(_ command: String, inFolderPath path: String) {
        guard var commands = approved[path], let at = commands.firstIndex(of: command) else { return }
        commands.remove(at: at)
        approved[path] = commands.isEmpty ? nil : commands
        saveApprovals()
    }

    /// Every allowed command, by folder path then in the order allowed.
    public var approvals: [(folder: String, command: String)] {
        approved.keys.sorted().flatMap { folder in approved[folder, default: []].map { (folder, $0) } }
    }

    private func saveApprovals() {
        try? FileManager.default.createDirectory(at: approvalsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try? encoder.encode(approved).write(to: approvalsURL, options: .atomic)
    }

    // MARK: Running

    /// The card `card` (a message and its component's place) with `command` in `folder`.
    /// `detail` is its component's Detail command, when it has one: the card asks until that is
    /// allowed too.
    public func state(for card: String, command: String, detail: String? = nil, in folder: URL) -> State {
        // A command taken back asks again, even on a card that ran it before.
        guard isApproved(command, in: folder), isApproved(detail: detail, in: folder) else { return State(status: .approve) }
        return run(of: card, command: command, in: folder) ?? State(status: .idle)
    }

    /// The card's last run, if it was of this command in this folder.
    private func run(of card: String, command: String, in folder: URL) -> State? {
        ranWith[card] == Self.what(command, folder) ? runs[card] : nil
    }

    private static func what(_ command: String, _ folder: URL) -> String { key(folder) + "\n" + command }

    /// Runs it for this card, if allowed and not running already. `force` runs a done or failed
    /// card again (its refresh button); without it only a card not run yet starts.
    public func run(card: String, command: String, in folder: URL, force: Bool = false) async {
        guard isApproved(command, in: folder) else { return }
        if runs[card]?.status == .running { return }
        let previous = run(of: card, command: command, in: folder)
        if previous != nil, !force { return }
        ranWith[card] = Self.what(command, folder)
        runs[card] = State(status: .running, data: previous?.data, error: nil, ranAt: previous?.ranAt)
        let runner = runner
        let outcome = await blocking { runner(command, folder) }
        if let data = outcome.data {
            runs[card] = State(status: .done, data: data, error: nil, ranAt: outcome.ranAt)
        } else {
            runs[card] = State(status: .failed, data: nil, error: outcome.error ?? L("The command failed."), ranAt: outcome.ranAt)
        }
    }

    // MARK: Detail commands

    /// What allowing a component's Detail command stores beside the allowed commands (it shows
    /// so in Settings > Permissions, where it can be taken back like any other).
    public nonisolated static func detailKey(_ template: String) -> String { "Detail command: " + template }

    /// Whether the Detail command `template` (as about.md had it when the user allowed it) is
    /// allowed in `folder`; true when there is none.
    public func isApproved(detail template: String?, in folder: URL) -> Bool {
        guard let template else { return true }
        return isApproved(Self.detailKey(template), in: folder)
    }

    public func approve(detail template: String, in folder: URL) {
        approve(Self.detailKey(template), in: folder)
    }

    /// The placeholders a Detail command template names, `{hash}`, in order, each once.
    public nonisolated static func placeholders(in template: String) -> [String] {
        var names: [String] = []
        for match in template.matches(of: placeholder) where !names.contains(String(match.1)) {
            names.append(String(match.1))
        }
        return names
    }

    nonisolated(unsafe) private static let placeholder = #/\{([A-Za-z_][A-Za-z0-9_]*)\}/#

    /// Why a value cannot go into a Detail command, or nil when it can: only letters, digits and
    /// `. _ / -`, at most 200 of them, not starting with `-` (it would read as an option).
    public nonisolated static func problem(withValue value: String, for name: String) -> String? {
        if value.isEmpty { return L("The value for {0} is empty.", "{\(name)}") }
        if value.count > 200 { return L("The value for {0} is longer than 200 characters.", "{\(name)}") }
        if value.hasPrefix("-") { return L("The value for {0} starts with \"-\".", "{\(name)}") }
        if value.unicodeScalars.contains(where: { !allowed.contains($0) }) {
            return L("The value for {0} may only have letters, digits and . _ / -.", "{\(name)}")
        }
        return nil
    }

    private nonisolated static let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-")

    /// The command line `template` makes with `values`: each `{name}` becomes its value as one
    /// single-quoted shell argument. Every placeholder needs a value, every value a placeholder,
    /// and each value must pass `problem(withValue:for:)`; otherwise the reason why.
    public nonisolated static func detailCommand(_ template: String, values: [String: String]) -> Result<String, DetailProblem> {
        let names = placeholders(in: template)
        if let unknown = values.keys.sorted().first(where: { !names.contains($0) }) {
            return .failure(DetailProblem(L("The Detail command has no {0}.", "{\(unknown)}")))
        }
        if let missing = names.first(where: { values[$0] == nil }) {
            return .failure(DetailProblem(L("No value for {0}.", "{\(missing)}")))
        }
        for name in names {
            if let problem = problem(withValue: values[name]!, for: name) { return .failure(DetailProblem(problem)) }
        }
        let command = template.replacing(placeholder) { match in "'" + values[String(match.1)]! + "'" }
        return .success(command)
    }

    public struct DetailProblem: Error, Equatable, Sendable {
        public var message: String
        public init(_ message: String) { self.message = message }
    }

    /// Detail runs whose output becomes their card's data, by card: the command line and its run.
    private var saving: [String: (command: String, run: Task<CommandOutcome, Never>)] = [:]

    /// Runs a component's Detail command `template` with `values` in `folder` (a card's
    /// `ccb.runDetail`): only once the user has allowed that template there, with the same time
    /// limit, output cap and stopping as the card's own command. The data is JSON as for a run.
    /// `saving` (`ccb.runDetail(values, {save: true})`, a card's "scan again" button) makes the
    /// output that card's data, as a run of its `command` would: the card shows it running, and
    /// the run finishes into the card even if the page that asked is left or drawn anew. Asking
    /// again while it runs waits for the same run instead of starting another.
    public func runDetail(_ template: String, values: [String: String], in folder: URL, saving card: (card: String, command: String)? = nil) async -> CommandOutcome {
        guard isApproved(detail: template, in: folder) else {
            return CommandOutcome(error: L("This component's Detail command is not allowed yet: press \"Allow and run\" on its card first."))
        }
        let command: String
        switch Self.detailCommand(template, values: values) {
        case .success(let line): command = line
        case .failure(let problem): return CommandOutcome(error: problem.message)
        }
        let runner = runner
        guard let card, isApproved(card.command, in: folder) else { return await blocking { runner(command, folder) } }
        if let running = saving[card.card] {
            if running.command == command { return await running.run.value }
            return CommandOutcome(error: L("This card is already running a command: try again once it is done."))
        }
        if runs[card.card]?.status == .running {
            return CommandOutcome(error: L("This card's command is running: try again once it is done."))
        }
        let previous = run(of: card.card, command: card.command, in: folder)
        ranWith[card.card] = Self.what(card.command, folder)
        runs[card.card] = State(status: .running, data: previous?.data, error: nil, ranAt: previous?.ranAt)
        let run = Task { await blocking { runner(command, folder) } }
        saving[card.card] = (command, run)
        let outcome = await run.value
        saving[card.card] = nil
        if let data = outcome.data {
            runs[card.card] = State(status: .done, data: data, error: nil, ranAt: outcome.ranAt)
        } else {
            runs[card.card] = State(status: .failed, data: previous?.data, error: outcome.error ?? L("The command failed."), ranAt: outcome.ranAt)
        }
        return outcome
    }

    /// A runDetail call's values as text: strings, and whole numbers written out; nil when
    /// anything else is there (the call is refused, not guessed at).
    public nonisolated static func detailValues(_ value: Any?) -> [String: String]? {
        guard let given = value as? [String: Any] else { return value == nil ? [:] : nil }
        var values: [String: String] = [:]
        for (key, item) in given {
            if let text = item as? String {
                values[key] = text
            } else if let number = item as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue == number.doubleValue.rounded(), abs(number.doubleValue) < 1e15 {
                values[key] = String(number.int64Value)
            } else {
                return nil
            }
        }
        return values
    }

    /// The page's `ccb.detailReply(id, ok, value)` for a finished runDetail: the output's
    /// JSON (as a JSON string the page parses), or why it did not run.
    public nonisolated static func detailReplyScript(_ requestID: Int, _ outcome: CommandOutcome) -> String {
        let ok = outcome.data != nil
        let text = outcome.data ?? outcome.error ?? L("The Detail command failed.")
        let quoted = (try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
        return "ccb.detailReply(\(requestID), \(ok), \(quoted))"
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
            return CommandOutcome(error: L("The project folder {0} is not there.", folder.path))
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
        // The shell ending, or its output going over the limit: either way the wait is over.
        let wake = DispatchSemaphore(value: 0)
        // Both pipes reaching their end, so nothing printed last is lost.
        let drained = DispatchGroup()
        drained.enter()
        drained.enter()
        out.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; drained.leave(); return }
            if collected.add(chunk, error: false) { wake.signal() }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; drained.leave(); return }
            _ = collected.add(chunk, error: true)
        }
        process.terminationHandler = { _ in finished.signal(); wake.signal() }
        do {
            try process.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            return CommandOutcome(error: L("Couldn't start the command: {0}", error.localizedDescription))
        }
        // The shell leads its own process group (Process starts it so), and what it starts joins
        // it: stopping the command stops all of them, not just the shell.
        let pid = process.processIdentifier
        let group = getpgid(pid) == pid ? pid : nil
        func signal(_ number: Int32) {
            if let group { kill(-group, number) } else { kill(pid, number) }
        }
        var timedOut = false
        if wake.wait(timeout: .now() + timeout) == .timedOut { timedOut = true }
        if timedOut || collected.result().2 {
            signal(SIGTERM)
            let ended = finished.wait(timeout: .now() + 2) == .success
            // Whatever shrugged off the polite stop, the shell or anything it left behind.
            signal(SIGKILL)
            if !ended { _ = finished.wait(timeout: .now() + 2) }
        } else {
            finished.wait()
        }
        // What is left in the pipes (a child still holding them open is not waited for long).
        _ = drained.wait(timeout: .now() + 1)
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        try? out.fileHandleForReading.close()
        try? err.fileHandleForReading.close()
        let (stdout, stderr, overflow) = collected.result()
        if overflow {
            return CommandOutcome(error: L("The command printed more than {0} KB, so it was stopped.", limit / 1000))
        }
        if timedOut {
            return CommandOutcome(error: L("The command took longer than {0} seconds, so it was stopped.", Int(timeout)) + tail(stderr))
        }
        let text = String(decoding: stdout, as: UTF8.self)
        if process.terminationReason == .uncaughtSignal || process.terminationStatus != 0 {
            let said = String(decoding: stderr, as: UTF8.self).isEmpty ? text : String(decoding: stderr, as: UTF8.self)
            return CommandOutcome(error: L("The command failed (exit code {0}).", process.terminationStatus) + tail(Data(said.utf8)))
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
