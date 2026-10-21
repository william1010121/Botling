import Foundation

/// A version as the CLIs print it ("2.1.304 (Claude Code)", "codex-cli 0.163.0"): the first run
/// of dotted numbers. Missing parts count as 0, so 2.1 == 2.1.0.
public struct CLIVersion: Comparable, Sendable, CustomStringConvertible {
    public let parts: [Int]

    public init(parts: [Int]) {
        self.parts = parts
    }

    public init?(_ text: String) {
        guard let range = text.range(of: #"\d+(\.\d+)+"#, options: .regularExpression) else { return nil }
        parts = text[range].split(separator: ".").compactMap { Int($0) }
    }

    public var description: String { parts.map(String.init).joined(separator: ".") }

    public static func == (a: CLIVersion, b: CLIVersion) -> Bool {
        compare(a, b) == 0
    }

    public static func < (a: CLIVersion, b: CLIVersion) -> Bool {
        compare(a, b) < 0
    }

    private static func compare(_ a: CLIVersion, _ b: CLIVersion) -> Int {
        for index in 0..<max(a.parts.count, b.parts.count) {
            let x = index < a.parts.count ? a.parts[index] : 0
            let y = index < b.parts.count ? b.parts[index] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        return 0
    }
}

/// Whether a CLI is signed in, as far as it says without a model call.
public enum DoctorAuth: Equatable, Sendable {
    /// Signed in, and how ("Claude subscription (max)", "API key", "ChatGPT").
    case signedIn(String)
    case signedOut
    /// It did not say (an old version, an error, a timeout).
    case unknown
}

public enum DoctorStatus: Sendable {
    case ok, warning, failing
}

/// One row of Settings → Doctor.
public struct DoctorCheck: Identifiable, Sendable {
    public let tool: DoctorTool
    public var status: DoctorStatus
    public var version: String?
    public var path: String?
    public var auth: String?
    public var latest: String?
    /// One line on what is right or wrong.
    public var summary: String
    /// A command that fixes it (or updates), for the copy button.
    public var fix: String?

    public var id: DoctorTool { tool }
    public var isRequired: Bool { tool.isRequired }
}

/// The two CLIs the app runs: Claude Code for every bot, Codex for reviews.
public enum DoctorTool: String, CaseIterable, Sendable {
    case claude, codex

    public var name: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        }
    }

    /// The npm package, for the latest version and the install command.
    public var package: String {
        switch self {
        case .claude: "@anthropic-ai/claude-code"
        case .codex: "@openai/codex"
        }
    }

    /// The oldest version that takes every flag the app passes.
    /// Claude Code: `--effort xhigh` arrived in 2.1.111; the others the app uses (`--permission-mode
    /// auto`, repeated `--plugin-dir`, stream-json with `rate_limit_event`, `auth status`) are older.
    /// Codex: `codex exec --ephemeral` arrived in 0.99.0; `--output-schema`, `-o` and `--sandbox
    /// read-only` are older.
    public var minimum: CLIVersion {
        switch self {
        case .claude: CLIVersion(parts: [2, 1, 111])
        case .codex: CLIVersion(parts: [0, 99, 0])
        }
    }

    var minimumReason: String {
        switch self {
        case .claude: L("the oldest that takes --effort xhigh")
        case .codex: L("the oldest whose codex exec takes --ephemeral")
        }
    }

    /// Bots cannot start without Claude Code; without Codex only reviews stop.
    public var isRequired: Bool { self == .claude }

    /// Asks for the sign-in without spending tokens.
    var authArguments: [String] {
        switch self {
        case .claude: ["auth", "status"]
        case .codex: ["login", "status"]
        }
    }

    func parseAuth(_ output: String, exitCode: Int32) -> DoctorAuth {
        switch self {
        case .claude: Self.parseClaudeAuth(output)
        case .codex: Self.parseCodexAuth(output, exitCode: exitCode)
        }
    }

    /// `claude auth status` prints JSON: `loggedIn`, `authMethod` ("claude.ai" for a subscription),
    /// `subscriptionType`.
    static func parseClaudeAuth(_ output: String) -> DoctorAuth {
        guard let start = output.firstIndex(of: "{"), let end = output.lastIndex(of: "}"), start < end,
              let object = try? JSONSerialization.jsonObject(with: Data(output[start...end].utf8)) as? [String: Any],
              let loggedIn = object["loggedIn"] as? Bool else { return .unknown }
        guard loggedIn else { return .signedOut }
        let method = (object["authMethod"] as? String) ?? ""
        if method == "claude.ai" {
            let plan = (object["subscriptionType"] as? String).map { " (\($0))" } ?? ""
            return .signedIn("Claude subscription\(plan)")
        }
        if method.lowercased().contains("api") { return .signedIn("API key") }
        return .signedIn(method.isEmpty ? "signed in" : method)
    }

    /// `codex login status` has no JSON: it exits 0 when signed in ("Logged in using ChatGPT",
    /// "Logged in using an API key - sk-…"; the key is never kept) and 1 otherwise, for "Not
    /// logged in" and for an error alike. The exit status decides signed in; the words only name
    /// how, and tell signing out from an error.
    static func parseCodexAuth(_ output: String, exitCode: Int32) -> DoctorAuth {
        let lines = output.split(whereSeparator: \.isNewline).map(String.init)
        guard exitCode == 0 else {
            return lines.contains { $0.localizedCaseInsensitiveContains("not logged in") } ? .signedOut : .unknown
        }
        let how = lines.lazy.compactMap { line in line.range(of: "Logged in using ").map { String(line[$0.upperBound...]) } }.first ?? ""
        if how.localizedCaseInsensitiveContains("API key") { return .signedIn("API key") }
        if how.localizedCaseInsensitiveContains("ChatGPT") { return .signedIn("ChatGPT") }
        return .signedIn(how.split(separator: " ").first.map(String.init) ?? "signed in")
    }

    var installFix: String { "npm i -g \(package)@latest" }

    func updateFix(_ path: URL) -> String {
        switch self {
        case .claude: "\(Self.quoted(path)) update"
        case .codex: installFix
        }
    }

    func loginFix(_ path: URL?) -> String {
        let command = path.map(Self.quoted) ?? rawValue
        switch self {
        case .claude: return "\(command) auth login"
        case .codex: return "\(command) login"
        }
    }

    private static func quoted(_ path: URL) -> String { "'\(path.path)'" }

    /// The row for what was found. `versionOutput` is nil when `--version` gave nothing usable.
    public func evaluate(path: URL?, versionOutput: String?, versionTimedOut: Bool = false, auth: DoctorAuth, latest: CLIVersion?) -> DoctorCheck {
        var check = DoctorCheck(tool: self, status: .ok, path: path?.path, latest: latest?.description, summary: "")
        guard let path else {
            check.status = isRequired ? .failing : .warning
            check.summary = isRequired ? L("Not found. Bots can't start without it.") : L("Not found. Codex reviews won't run.")
            check.fix = installFix
            return check
        }
        if case .signedIn(let how) = auth { check.auth = how }
        guard let version = versionOutput.flatMap(CLIVersion.init) else {
            check.status = .warning
            check.summary = versionTimedOut
                ? L("Found, but `{0} --version` did not answer in {1} s.", rawValue, Int(Doctor.timeout))
                : L("Found, but its version could not be read.")
            return check
        }
        check.version = version.description
        if version < minimum {
            check.status = .failing
            check.summary = L("Version {0} is older than {1}, {2}.", version, minimum, minimumReason)
            check.fix = updateFix(path)
            return check
        }
        switch auth {
        case .signedOut:
            check.status = .failing
            check.summary = L("Not signed in.")
            check.fix = loginFix(path)
            return check
        case .unknown:
            check.status = .warning
            check.summary = L("Couldn't tell whether it is signed in.")
            check.fix = loginFix(path)
            return check
        case .signedIn(let how):
            check.summary = L("Signed in with {0}.", how)
        }
        if let latest, version < latest {
            check.summary += " " + L("{0} is available.", latest)
            check.fix = updateFix(path)
        }
        return check
    }
}

/// What a command printed (stdout and stderr together) and how it ended.
public struct CommandResult: Equatable, Sendable {
    public var output: String
    public var exitCode: Int32
    public var timedOut: Bool

    public init(output: String, exitCode: Int32, timedOut: Bool = false) {
        self.output = output
        self.exitCode = exitCode
        self.timedOut = timedOut
    }
}

/// Runs a short command off the main thread and stops it at a timeout.
public enum CommandRunner {
    /// nil when the executable is missing or could not start.
    public static func run(_ executable: URL, _ arguments: [String], timeout: TimeInterval) async -> CommandResult? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: runBlocking(executable, arguments, timeout: timeout))
            }
        }
    }

    private final class Output: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        private var _timedOut = false

        func append(_ more: Data) { lock.withLock { data.append(more) } }
        var text: String { lock.withLock { String(decoding: data, as: UTF8.self) } }
        func markTimedOut() { lock.withLock { _timedOut = true } }
        var timedOut: Bool { lock.withLock { _timedOut } }
    }

    /// `environment` adds to (or, with nil, takes out of) the environment it would otherwise get.
    static func runBlocking(_ executable: URL, _ arguments: [String], timeout: TimeInterval, environment changes: [String: String?] = [:]) -> CommandResult? {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        // A GUI app's PATH is short; npm and the CLIs' own scripts need node beside them.
        var environment = CodexCLI.environment()
        let folder = executable.deletingLastPathComponent().path
        environment["PATH"] = ([folder] + (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { $0 != folder }).joined(separator: ":")
        environment["NO_COLOR"] = "1"
        for (key, value) in changes { environment[key] = value }
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        let output = Output()
        let drained = DispatchGroup()
        drained.enter()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                drained.leave()
            } else {
                output.append(data)
            }
        }
        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        let stop = DispatchWorkItem { [process] in
            guard process.isRunning else { return }
            output.markTimedOut()
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: stop)
        process.waitUntilExit()
        stop.cancel()
        // Something it started may hold the pipe open; don't wait on that for long.
        if drained.wait(timeout: .now() + 1) == .timedOut {
            pipe.fileHandleForReading.readabilityHandler = nil
        }
        return CommandResult(output: output.text, exitCode: process.terminationStatus, timedOut: output.timedOut)
    }
}

/// Settings → Doctor's checks: each CLI found the way bots find it, its version against the
/// minimum, its sign-in, and (when asked) the latest release on npm. Every command has a timeout;
/// nothing here spends tokens or changes what bots may do.
public struct Doctor: Sendable {
    public typealias Run = @Sendable (URL, [String], TimeInterval) async -> CommandResult?

    public static let timeout: TimeInterval = 10

    var locateClaude: @Sendable () -> URL?
    var locateCodex: @Sendable () -> URL?
    var run: Run
    var latest: @Sendable (String) async -> String?

    public init(
        locateClaude: @escaping @Sendable () -> URL? = { ClaudeExecutableLocator().locate() },
        locateCodex: @escaping @Sendable () -> URL? = { CodexCLI.newestExecutable() },
        run: @escaping Run = { await CommandRunner.run($0, $1, timeout: $2) },
        latest: @escaping @Sendable (String) async -> String? = { await Doctor.npmLatest($0) }
    ) {
        self.locateClaude = locateClaude
        self.locateCodex = locateCodex
        self.run = run
        self.latest = latest
    }

    /// One row per tool, Claude Code first. `includeLatest` asks npm (the network) too.
    public func check(includeLatest: Bool) async -> [DoctorCheck] {
        async let claude = check(.claude, includeLatest: includeLatest)
        async let codex = check(.codex, includeLatest: includeLatest)
        return await [claude, codex]
    }

    func check(_ tool: DoctorTool, includeLatest: Bool) async -> DoctorCheck {
        let locate = tool == .claude ? locateClaude : locateCodex
        async let latestText: String? = includeLatest ? latest(tool.package) : nil
        let path = await Task.detached { locate() }.value
        var versionOutput: String?
        var versionTimedOut = false
        var auth = DoctorAuth.unknown
        if let path {
            async let versionResult = run(path, ["--version"], Self.timeout)
            async let authResult = run(path, tool.authArguments, Self.timeout)
            if let result = await versionResult {
                versionTimedOut = result.timedOut
                if !result.timedOut { versionOutput = result.output }
            }
            if let result = await authResult, !result.timedOut {
                auth = tool.parseAuth(result.output, exitCode: result.exitCode)
            }
        }
        let latest = await latestText.flatMap(CLIVersion.init)
        return tool.evaluate(path: path, versionOutput: versionOutput, versionTimedOut: versionTimedOut, auth: auth, latest: latest)
    }

    /// `npm view <package> version`; nil offline, without npm, or past the timeout.
    public static func npmLatest(_ package: String) async -> String? {
        guard let npm = await Task.detached(operation: { ClaudeExecutableLocator(command: "npm").locate() }).value,
              let result = await CommandRunner.run(npm, ["view", package, "version"], timeout: timeout),
              !result.timedOut, result.exitCode == 0 else { return nil }
        return parseLatest(result.output)
    }

    /// The version npm printed, or nil when it printed something else (an error).
    static func parseLatest(_ output: String) -> String? {
        let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = lines.last(where: { !$0.isEmpty }),
              last.range(of: #"^\d+(\.\d+)+$"#, options: .regularExpression) != nil else { return nil }
        return last
    }
}

/// Settings → Doctor's state: the last rows, whether a check is running, and whether a required
/// one failed (the gear's warning dot).
@MainActor
public final class DoctorModel: ObservableObject {
    @Published public private(set) var checks: [DoctorCheck] = []
    @Published public private(set) var isRunning = false
    @Published public private(set) var checkedAt: Date?
    /// Whether the last run asked npm for the latest versions.
    public private(set) var includedLatest = false
    private let doctor: Doctor

    public init(doctor: Doctor = Doctor()) {
        self.doctor = doctor
    }

    public var needsAttention: Bool {
        checks.contains { $0.isRequired && $0.status == .failing }
    }

    public func run(includeLatest: Bool) async {
        guard !isRunning else { return }
        isRunning = true
        let doctor = doctor
        checks = await doctor.check(includeLatest: includeLatest)
        includedLatest = includeLatest
        checkedAt = Date()
        isRunning = false
    }
}
