import Foundation

/// How bad a finding is, as Codex rates it.
public enum CodexSeverity: String, Codable, CaseIterable, Comparable, Sendable {
    case high, medium, low

    public var displayName: String {
        switch self {
        case .high: L("High")
        case .medium: L("Medium")
        case .low: L("Low")
        }
    }

    private var rank: Int {
        switch self {
        case .high: 0
        case .medium: 1
        case .low: 2
        }
    }

    public static func < (a: Self, b: Self) -> Bool { a.rank < b.rank }
}

/// What one `codex exec` run gave back: a verdict, and the problems it found (none for a
/// question that was no review, or a clean change).
public struct CodexOutput: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public var file: String
        public var line: Int?
        public var severity: CodexSeverity
        public var title: String
        /// The concrete failure: what input or steps make it go wrong, and what happens.
        public var scenario: String

        public init(file: String, line: Int?, severity: CodexSeverity, title: String, scenario: String) {
            self.file = file
            self.line = line
            self.severity = severity
            self.title = title
            self.scenario = scenario
        }
    }

    public var summary: String
    public var findings: [Item]

    public init(summary: String, findings: [Item] = []) {
        self.summary = summary
        self.findings = findings
    }

    /// Codex's last message: the JSON its output schema asks for, possibly fenced or with words
    /// around it. Anything else is taken as a plain answer with no findings. Unknown severities
    /// count as low.
    public static func parse(_ text: String) -> CodexOutput {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for candidate in jsonCandidates(in: trimmed) {
            guard let data = candidate.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            let summary = (object["summary"] as? String) ?? ""
            let raw = object["findings"] as? [[String: Any]] ?? []
            let items = raw.compactMap { entry -> Item? in
                let title = ((entry["title"] as? String) ?? (entry["summary"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty else { return nil }
                let line = (entry["line"] as? NSNumber)?.intValue ?? (entry["line"] as? String).flatMap { Int($0) }
                let severity = (entry["severity"] as? String).flatMap { CodexSeverity(rawValue: $0.lowercased()) } ?? .low
                return Item(
                    file: ((entry["file"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                    line: line.flatMap { $0 > 0 ? $0 : nil },
                    severity: severity,
                    title: title,
                    scenario: ((entry["scenario"] as? String) ?? (entry["failure"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                )
            }
            return CodexOutput(summary: summary.trimmingCharacters(in: .whitespacesAndNewlines), findings: items)
        }
        return CodexOutput(summary: trimmed)
    }

    /// The whole text, a ```json fence's body, then the outermost {…}.
    private static func jsonCandidates(in text: String) -> [String] {
        var found = [text]
        if let fence = text.range(of: #"```(?:json)?\s*\n([\s\S]*?)```"#, options: .regularExpression) {
            let body = text[fence].replacingOccurrences(of: #"^```(?:json)?\s*\n"#, with: "", options: .regularExpression)
            found.append(String(body.dropLast(3)))
        }
        if let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"), open < close {
            found.append(String(text[open...close]))
        }
        return found
    }

    /// The reply Codex's chat shows: the verdict, then one line per finding, worst first.
    public var markdown: String {
        var lines = [summary.isEmpty ? (findings.isEmpty ? L("Nothing to report.") : L("Found {0} to look at.", findings.count)) : summary]
        let sorted = findings.enumerated().sorted { ($0.element.severity, $0.offset) < ($1.element.severity, $1.offset) }.map(\.element)
        if !sorted.isEmpty { lines.append("") }
        for item in sorted {
            lines.append("- **\(item.severity.displayName)** \(Self.place(item.file, item.line)) \(item.title)" + (item.scenario.isEmpty ? "" : " — \(item.scenario)"))
        }
        return lines.joined(separator: "\n")
    }

    /// "`Bot.swift:42`", or nothing for a finding with no file.
    static func place(_ file: String, _ line: Int?) -> String {
        guard !file.isEmpty else { return "" }
        let name = (file as NSString).lastPathComponent
        return "`\(name)\(line.map { ":\($0)" } ?? "")`"
    }

    /// The JSON Schema `codex exec --output-schema` holds the last message to.
    public static let schema = """
    {"type":"object","additionalProperties":false,"required":["summary","findings"],"properties":{"summary":{"type":"string"},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["file","line","severity","title","scenario"],"properties":{"file":{"type":"string"},"line":{"type":["integer","null"]},"severity":{"type":"string","enum":["high","medium","low"]},"title":{"type":"string"},"scenario":{"type":"string"}}}}}}
    """
}

/// One Codex run: what to ask, and in which folder (it reads there, never writes).
public struct CodexRequest: Equatable, Sendable {
    public var prompt: String
    public var folder: URL

    public init(prompt: String, folder: URL) {
        self.prompt = prompt
        self.folder = folder
    }
}

/// Runs Codex. The app's is `CodexCLI`; tests stand in for it.
public protocol CodexRunning: Sendable {
    func run(_ request: CodexRequest) async throws -> CodexOutput
}

public struct CodexError: LocalizedError, Equatable, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// What Codex is told. It keeps no memory: every run starts fresh and read-only.
public enum CodexPrompts {
    static let rules = """
    You are Codex, a careful code reviewer working inside ClaudeCodeBot. You are read-only: never create, change or delete files, never commit, and never run commands that change anything (no installs, no builds that write outside a temporary folder, no git commands that change state).
    """

    /// What to look at in the folder: a branch against its base and what is not committed, or only what is not committed.
    static func scope(base: String?) -> String {
        scope(base.flatMap { $0.isEmpty ? nil : .branch(base: $0) } ?? .uncommitted)
    }

    static func scope(_ scope: CodexScope) -> String {
        switch scope {
        case .uncommitted:
            "the uncommitted changes: staged, unstaged and untracked (git status, git diff HEAD)"
        case .lastCommit:
            "the last commit only (git diff HEAD~1 HEAD, or git show HEAD); leave out uncommitted changes"
        case let .branch(base):
            "the changes on the current branch compared with \(base): the commits not on \(base) (git diff \(base)...HEAD), plus staged, unstaged and untracked changes"
        case let .commit(hash):
            "the commit \(hash) only (git show \(hash)); leave out other commits and uncommitted changes"
        }
    }

    /// A review: the scope, what to report, and, for a later round, what the earlier rounds said
    /// was fixed so Codex checks it is.
    public static func review(base: String?, focus: String? = nil, earlier: [CodexFinding] = []) -> String {
        review(scope: base.flatMap { $0.isEmpty ? nil : .branch(base: $0) } ?? .uncommitted, focus: focus, earlier: earlier)
    }

    /// With a spec, Codex also checks point by point that the change does what it says.
    public static func review(scope: CodexScope, focus: String? = nil, spec: String? = nil, earlier: [CodexFinding] = []) -> String {
        var parts = [rules, "Review \(self.scope(scope)) in this git repository."]
        if let focus = focus?.trimmingCharacters(in: .whitespacesAndNewlines), !focus.isEmpty {
            parts.append("What the change is meant to do: \(focus)")
        }
        if let spec, !spec.isEmpty {
            parts.append("Read the spec at \(spec) and check, point by point, whether the change does what it says. Report each gap (something it asks for that the change leaves out, does differently or gets wrong) as a finding: file and line where the change falls short (the spec's path if no code file fits), and in the title name the point of the spec it misses.")
        }
        if !earlier.isEmpty {
            let list = earlier.map { "- [\($0.severity.rawValue)] \($0.file)\($0.line.map { ":\($0)" } ?? ""): \($0.title)" }.joined(separator: "\n")
            parts.append("An earlier review round reported these and the author says they are fixed now. Check each really is fixed (report it again if not, in the same words) and look for problems the fixes brought in:\n\(list)")
        }
        parts.append("""
        Report only real problems a user or maintainer would hit: wrong behaviour, crashes, data loss, security holes, races, error handling that matters, tests that cannot catch the bug they claim to. No style, naming or taste.
        For each finding: file (path relative to the repository root), line (in the new version of the file; null if none), severity (high: breaks users or loses data; medium: wrong in some real cases; low: minor), title (one sentence: what is wrong), scenario (the concrete failure: which input or steps, what happens, and the fix in a few words).
        summary: one or two sentences with your verdict on the change. When nothing needs fixing, findings is empty.
        Write the summary, titles and scenarios in the language of the code's comments and commit messages.
        """)
        return parts.joined(separator: "\n\n")
    }

    /// Codex's chat (its own, or called into another with @): the user's words, answered
    /// read-only in `folder`.
    public static func chat(_ text: String, folder: URL, language: AppLanguage = .english) -> String {
        """
        \(rules)
        Your working folder is \(folder.path). The user is talking to you in a chat app. If they ask for a review, review what they name (by default \(scope(base: nil)), or the current branch against its base when they say so) and put each problem in findings, as a code reviewer would: file, line, severity (high, medium, low), title (one sentence), scenario (the concrete failure and the fix in a few words). For anything else, answer in summary in at most 3 sentences and leave findings empty. \(BotPrompts.languageRule(language))

        \(text)
        """
    }
}

/// The real `codex exec`: read-only sandbox, nothing kept between runs (`--ephemeral`), the last
/// message held to `CodexOutput.schema`.
public struct CodexCLI: CodexRunning {
    /// Finds the codex command; nil when it is not installed.
    public var locate: @Sendable () -> URL?
    /// How long one run may take before it is stopped.
    public var timeout: TimeInterval

    /// Long enough for a careful review of a big change.
    public static let defaultTimeout: TimeInterval = 20 * 60

    public init(locate: @escaping @Sendable () -> URL? = { CodexCLI.locateNewest() }, timeout: TimeInterval = CodexCLI.defaultTimeout) {
        self.locate = locate
        self.timeout = timeout
    }

    public static func arguments(folder: URL, schema: URL, output: URL, prompt: String) -> [String] {
        ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--color", "never",
         "-C", folder.path, "--output-schema", schema.path, "-o", output.path, prompt]
    }

    public func run(_ request: CodexRequest) async throws -> CodexOutput {
        guard let executable = locate() else {
            throw CodexError("The codex command was not found. Install the Codex CLI (npm install -g @openai/codex) and sign in with `codex login`.")
        }
        let scratch = FileManager.default.temporaryDirectory.appending(path: "ccb-codex-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let schema = scratch.appending(path: "schema.json")
        let output = scratch.appending(path: "last-message.json")
        try Data(CodexOutput.schema.utf8).write(to: schema)

        let process = Process()
        process.executableURL = executable
        process.arguments = Self.arguments(folder: request.folder, schema: schema, output: output, prompt: request.prompt)
        process.currentDirectoryURL = request.folder
        process.environment = Self.environment()
        process.standardInput = FileHandle.nullDevice
        let log = scratch.appending(path: "log.txt")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        defer { try? handle.close() }
        process.standardOutput = handle
        process.standardError = handle

        let box = ProcessBox(process)
        let timeout = timeout
        let status: Int32 = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                process.terminationHandler = { finished in continuation.resume(returning: finished.terminationStatus) }
                do {
                    try process.run()
                } catch {
                    process.terminationHandler = nil
                    continuation.resume(throwing: CodexError("Codex could not start: \(error.localizedDescription)"))
                    return
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { box.stop() }
            }
        } onCancel: {
            box.stop()
        }
        try Task.checkCancellation()
        let message = (try? String(contentsOf: output, encoding: .utf8)) ?? ""
        guard status == 0, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            let tail = ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(whereSeparator: \.isNewline).suffix(6).joined(separator: "\n")
            throw CodexError("Codex stopped (exit \(status))\(tail.isEmpty ? "." : ":\n\(tail)")")
        }
        return CodexOutput.parse(message)
    }

    /// A GUI app's PATH is short; the usual install places come first.
    static func environment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["\(home)/.local/bin", "\(home)/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let existing = environment["PATH"].map { $0.split(separator: ":").map(String.init) } ?? []
        environment["PATH"] = (extra + existing.filter { !extra.contains($0) }).joined(separator: ":")
        return environment
    }

    /// The newest install, looked for once it is first needed (and again while none is found).
    static let found = Found()

    public static func locateNewest() -> URL? { found.get() }

    final class Found: @unchecked Sendable {
        private let lock = NSLock()
        private var url: URL?

        func get() -> URL? {
            lock.withLock {
                if url == nil { url = CodexCLI.newestExecutable() }
                return url
            }
        }
    }

    /// Several installs can sit side by side (a standalone one, npm's); the newest version is
    /// used, since an old one may not read the user's config.
    public static func newestExecutable() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var paths = [".local/bin/codex", ".npm-global/bin/codex", ".bun/bin/codex"].map { home.appending(path: $0).path }
        paths += ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
        if let shell = ClaudeExecutableLocator.askLoginShell(for: "codex") { paths.append(shell) }
        var seen = Set<String>()
        let found = paths.filter { FileManager.default.isExecutableFile(atPath: $0) && seen.insert(URL(filePath: $0).resolvingSymlinksInPath().path).inserted }
        let versioned = found.map { ($0, version(of: $0)) }
        return versioned.max { newer($1.1, than: $0.1) }.map { URL(filePath: $0.0) }
    }

    /// "codex-cli 0.163.0" → [0, 163, 0].
    static func version(of path: String) -> [Int] {
        let process = Process()
        process.executableURL = URL(filePath: path)
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return [] }
        process.waitUntilExit()
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return parseVersion(text)
    }

    static func parseVersion(_ text: String) -> [Int] {
        guard let range = text.range(of: #"\d+(\.\d+)+"#, options: .regularExpression) else { return [] }
        return text[range].split(separator: ".").compactMap { Int($0) }
    }

    /// True when `a` is a later version than `b`.
    static func newer(_ a: [Int], than b: [Int]) -> Bool {
        for index in 0..<max(a.count, b.count) {
            let x = a[safe: index] ?? 0, y = b[safe: index] ?? 0
            if x != y { return x > y }
        }
        return false
    }
}

/// Lets a timeout or a cancel stop the process from another thread.
private final class ProcessBox: @unchecked Sendable {
    private let process: Process
    init(_ process: Process) { self.process = process }

    func stop() {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [process] in
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

/// Where Codex works for the next turn of its chat: the folder of the chat it was called into,
/// or its own.
public final class CodexDesk: @unchecked Sendable {
    private let lock = NSLock()
    private var _folder: URL
    /// Called with each answer that found something, and the folder it was about.
    public var onFindings: (@Sendable (CodexOutput, URL) -> Void)?

    public init(folder: URL) {
        _folder = folder
    }

    public var folder: URL {
        get { lock.withLock { _folder } }
        set { lock.withLock { _folder = newValue } }
    }
}

/// Codex's chat as an `AgentProcess`: each message is one fresh, read-only `codex exec` in the
/// desk's folder; the reply is its verdict and findings. One message at a time, in order.
public final class CodexAgentProcess: AgentProcess, @unchecked Sendable {
    public let events: AsyncStream<AgentEvent>
    private let continuation: AsyncStream<AgentEvent>.Continuation
    private let runner: CodexRunning
    private let desk: CodexDesk
    private let lock = NSLock()
    private var queue: [String] = []
    private var current: Task<Void, Never>?
    private var closed = false

    public init(runner: CodexRunning, desk: CodexDesk) {
        self.runner = runner
        self.desk = desk
        (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
    }

    public static func launcher(runner: CodexRunning, desk: CodexDesk) -> AgentLauncher {
        { _ in CodexAgentProcess(runner: runner, desk: desk) }
    }

    public func send(_ text: String) {
        lock.withLock {
            guard !closed else { return }
            queue.append(text)
        }
        next()
    }

    /// Starts the next message when none is running. Taking it from the queue and starting it
    /// happen under one lock, so two callers never start two at once; the task's own end takes
    /// the lock too, so it cannot clear `current` before it is set.
    private func next() {
        lock.lock()
        guard current == nil, !queue.isEmpty else {
            lock.unlock()
            finishIfDone()
            return
        }
        let text = queue.removeFirst()
        let folder = desk.folder
        let step = "codex-\(UUID().uuidString)"
        continuation.yield(.trace(.toolUse(id: step, tool: "Codex", title: L("Codex reads {0}", folder.lastPathComponent), detail: folder.path, parent: nil)))
        current = Task { [weak self, runner, desk] in
            let event: AgentEvent
            do {
                let output = try await runner.run(CodexRequest(prompt: CodexPrompts.chat(text, folder: folder, language: L10n.language), folder: folder))
                self?.continuation.yield(.trace(.toolResult(id: step, output: "\(output.findings.count) finding(s)", failed: false, parent: nil)))
                if !output.findings.isEmpty { desk.onFindings?(output, folder) }
                event = .reply(output.markdown, isError: false)
            } catch is CancellationError {
                event = .reply("", isError: true)
            } catch {
                self?.continuation.yield(.trace(.toolResult(id: step, output: error.localizedDescription, failed: true, parent: nil)))
                event = .reply(error.localizedDescription, isError: true)
            }
            guard let self else { return }
            continuation.yield(event)
            lock.withLock { self.current = nil }
            next()
        }
        lock.unlock()
    }

    private func finishIfDone() {
        let done = lock.withLock { closed && current == nil && queue.isEmpty }
        if done {
            continuation.yield(.exited(status: 0, stderr: ""))
            continuation.finish()
        }
    }

    public func finish() {
        lock.withLock { closed = true }
        finishIfDone()
    }

    public func stop() {
        let running = lock.withLock { () -> Task<Void, Never>? in
            closed = true
            queue.removeAll()
            return current
        }
        running?.cancel()
        if running == nil { finishIfDone() }
    }

    public func interrupt() {
        lock.withLock { self.current }?.cancel()
    }
}
