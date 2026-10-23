import Combine
import Foundation

extension JSONValue {
    /// Any Encodable value as JSON.
    public init<T: Encodable>(encoding value: T) {
        let data = (try? JSONEncoder().encode(value)) ?? Data("null".utf8)
        self = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
    }

    public func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    public subscript(key: String) -> JSONValue? {
        if case let .object(object) = self { object[key] } else { nil }
    }
}

/// One line of the plugin host's protocol: a request (id + method), a notification (method), or
/// a response (id + result or error).
struct HostMessage: Codable {
    var id: Int?
    var method: String?
    var params: JSONValue?
    var result: JSONValue?
    var error: HostError?

    struct HostError: Codable, Error, LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }
}

/// Runs the Node plugin host (`Resources/host/host.mjs`) for every plugin with a program part,
/// and talks to it with one JSON-RPC message per line on stdin/stdout. If the process dies it is
/// started again at once and the plugins reloaded; Botling is told which plugin it was running, so
/// one that keeps bringing it down can be turned off.
@MainActor
public final class PluginHostClient: ObservableObject {
    /// What the host needs to load one plugin (matches `HostPluginSpec` in host.ts).
    public struct Spec: Codable, Equatable, Sendable {
        public var name: String
        public var version: String
        public var main: String
        public var fingerprint: String
        public var settings: [String: JSONValue]
        public var storageDir: String

        public init(name: String, version: String, main: String, fingerprint: String, settings: [String: JSONValue], storageDir: String) {
            self.name = name
            self.version = version
            self.main = main
            self.fingerprint = fingerprint
            self.settings = settings
            self.storageDir = storageDir
        }
    }

    public enum Outcome: Equatable {
        case send(String)
        case stopped(by: String)
    }

    @Published public private(set) var isRunning = false
    /// Hooks and commands the loaded plugins registered.
    @Published public private(set) var beforeSendHooks = 0
    @Published public private(set) var afterReplyHooks = 0
    @Published public private(set) var commands: [String] = []
    /// Why the host cannot run (no Node), shown in settings.
    @Published public private(set) var problem: String?
    public private(set) var restarts = 0

    public let script: URL
    private let locateNode: () -> URL?
    /// The host asks Botling for something (bots.list, routines.add).
    public var onRequest: ((_ method: String, _ params: JSONValue) async throws -> JSONValue)?
    /// The host tells Botling something (notify, bots.send, pluginError).
    public var onNotification: ((_ method: String, _ params: JSONValue) -> Void)?
    /// A plugin's program part threw, or the host died while running it (`fatal`: it failed to
    /// load at all).
    public var onPluginFailure: ((_ plugin: String?, _ message: String, _ fatal: Bool) -> Void)?

    private(set) var specs: [Spec] = []
    private var process: Process?
    private var input: FileHandle?
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    /// Requests running one plugin's code, to blame it if the host dies meanwhile.
    private var running: [Int: String] = [:]
    private var nextID = 1
    private var stopping = false

    /// How long the host is given for each kind of work, in one place (a slower machine or
    /// plugin gets a longer policy, not a hunt through the file).
    public struct Timing: Sendable {
        /// A hook on a message being sent or a reply being shown: it holds up the chat, so it
        /// is short, and when it runs out the message goes as it is.
        public var hook: Duration = .seconds(5)
        /// A command or a web part's call to its program part: work the user asked for.
        public var call: Duration = .seconds(60)
        /// Loading the plugins' program parts (each may import a lot).
        public var load: Duration = .seconds(30)
        /// How long `waitUntilReady` waits by default, and how often it looks.
        public var ready: Duration = .seconds(5)
        public var readyPoll: Duration = .milliseconds(20)
        /// The pause before a host that died is started again (so a crash loop does not spin).
        public var restartDelay: Duration = .milliseconds(300)

        public init() {}
    }

    public let timing: Timing

    public init(script: URL, timing: Timing = Timing(), locateNode: @escaping () -> URL? = { ClaudeExecutableLocator(command: "node").locate() }) {
        self.script = script
        self.timing = timing
        self.locateNode = locateNode
    }

    public var pid: Int32? { process?.processIdentifier }

    /// Runs exactly these plugins; with none, the host is not running at all.
    public func update(_ specs: [Spec]) {
        guard specs != self.specs || (process == nil && !specs.isEmpty) else { return }
        self.specs = specs
        if specs.isEmpty {
            stop()
        } else if process == nil {
            start()
        } else if isRunning {
            Task { await load() }
        }
    }

    public func stop() {
        stopping = true
        process?.terminate()
    }

    /// Waits until the host is up and has loaded its plugins (for tests and first sends).
    public func waitUntilReady(timeout: Duration? = nil) async -> Bool {
        if isRunning { return true }
        let deadline = ContinuousClock.now + (timeout ?? timing.ready)
        while !isRunning, ContinuousClock.now < deadline {
            try? await Task.sleep(for: timing.readyPoll)
        }
        return isRunning
    }

    // MARK: Hooks and calls

    /// Lets plugins change or stop a message you are sending. If the host does not answer in
    /// time, the message goes as it is.
    public func beforeSend(bot: JSONValue, text: String) async -> Outcome {
        guard beforeSendHooks > 0, isRunning else { return .send(text) }
        guard let result = try? await request("beforeSend", .object(["bot": bot, "text": .string(text)])) else { return .send(text) }
        if result["cancel"]?.bool == true { return .stopped(by: result["by"]?.string ?? "") }
        return .send(result["text"]?.string ?? text)
    }

    /// Lets plugins change a bot's reply before it is shown.
    public func afterReply(bot: JSONValue, text: String) async -> String {
        guard afterReplyHooks > 0, isRunning else { return text }
        let result = try? await request("afterReply", .object(["bot": bot, "text": .string(text)]))
        return result?["text"]?.string ?? text
    }

    /// Tells plugins listening with `bots.onReply`.
    public func replied(bot: JSONValue, text: String) {
        guard isRunning else { return }
        write(HostMessage(method: "reply", params: .object(["bot": bot, "text": .string(text)])))
    }

    public func command(_ id: String, args: [JSONValue] = []) async throws -> JSONValue {
        try await request("command", .object(["id": .string(id), "args": .array(args)]), plugin: id.split(separator: ".").first.map(String.init), timeout: timing.call)
    }

    /// A web part's `host.call` to its own program part.
    public func webCall(plugin: String, method: String, params: JSONValue) async throws -> JSONValue {
        try await request("web", .object(["plugin": .string(plugin), "method": .string(method), "params": params]), plugin: plugin, timeout: timing.call)
    }

    /// `timeout`: nil gives a hook's (`timing.hook`).
    public func request(_ method: String, _ params: JSONValue, plugin: String? = nil, timeout: Duration? = nil) async throws -> JSONValue {
        let timeout = timeout ?? timing.hook
        guard input != nil else { throw HostMessage.HostError(message: "The plugin host is not running.") }
        let id = nextID
        nextID += 1
        if let plugin { running[id] = plugin }
        Task { [weak self] in
            try? await Task.sleep(for: timeout)
            self?.finish(id, with: .failure(HostMessage.HostError(message: "The plugin host did not answer within \(timeout).")))
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            write(HostMessage(id: id, method: method, params: params))
        }
    }

    private func finish(_ id: Int, with result: Result<JSONValue, Error>) {
        running[id] = nil
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(with: result)
    }

    // MARK: The process

    private func start() {
        guard let node = locateNode() else {
            problem = "Node not found, so plugin program parts can't run (web parts work as usual)."
            return
        }
        problem = nil
        stopping = false
        BrokenPipes.ignore()
        let process = Process()
        process.executableURL = node
        process.arguments = [script.path]
        var environment = ProcessInfo.processInfo.environment
        environment["CCB_PLUGIN_HOST"] = "1"
        process.environment = environment
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        let buffer = LineBuffer()
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let lines = buffer.append(data)
            Task { @MainActor [weak self] in
                for line in lines { self?.receive(line) }
            }
        }
        process.terminationHandler = { [weak self] ended in
            let status = ended.terminationStatus
            Task { @MainActor [weak self] in self?.exited(ended, status: status) }
        }
        do {
            try process.run()
        } catch {
            problem = "The plugin host failed to start: \(error.localizedDescription)"
            return
        }
        self.process = process
        input = stdin.fileHandleForWriting
    }

    private func exited(_ ended: Process, status: Int32) {
        guard ended === process else { return }
        let blamed = Set(running.values)
        process = nil
        input = nil
        isRunning = false
        for id in Array(pending.keys) {
            finish(id, with: .failure(HostMessage.HostError(message: "The plugin host exited.")))
        }
        guard !stopping else { return }
        if blamed.isEmpty {
            onPluginFailure?(nil, "The plugin host exited (\(status))", false)
        } else {
            for plugin in blamed { onPluginFailure?(plugin, "The plugin host crashed while running it (\(status))", false) }
        }
        restarts += 1
        // Back right away; the plugins load again when it says it is ready.
        let delay = timing.restartDelay
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, process == nil, !stopping, !specs.isEmpty else { return }
            start()
        }
    }

    private func write(_ message: HostMessage) {
        guard let input, var data = try? JSONEncoder().encode(message) else { return }
        data.append(0x0A)
        try? input.write(contentsOf: data)
    }

    private func receive(_ line: String) {
        guard let message = try? JSONDecoder().decode(HostMessage.self, from: Data(line.utf8)) else { return }
        if let method = message.method {
            if let id = message.id {
                // The host asks Botling for something.
                Task { [weak self] in
                    guard let self else { return }
                    do {
                        let result = try await onRequest?(method, message.params ?? .null) ?? .null
                        write(HostMessage(id: id, result: result))
                    } catch {
                        write(HostMessage(id: id, error: .init(message: error.localizedDescription)))
                    }
                }
            } else {
                notified(method, message.params ?? .null)
            }
        } else if let id = message.id {
            if let error = message.error {
                finish(id, with: .failure(error))
            } else {
                finish(id, with: .success(message.result ?? .null))
            }
        }
    }

    private func notified(_ method: String, _ params: JSONValue) {
        switch method {
        case "ready":
            Task { await load() }
        case "registered":
            beforeSendHooks = Int(params["beforeSend"]?.number ?? 0)
            afterReplyHooks = Int(params["afterReply"]?.number ?? 0)
            commands = params["commands"]?.decode([String].self) ?? []
        case "pluginError":
            onPluginFailure?(params["plugin"]?.string, params["message"]?.string ?? "", false)
        default:
            onNotification?(method, params)
        }
    }

    private func load() async {
        let specs = specs
        guard let result = try? await request("load", .object(["plugins": JSONValue(encoding: specs)]), timeout: timing.load) else { return }
        for failure in result["failed"]?.decode([[String: String]].self) ?? [] {
            onPluginFailure?(failure["name"], "The program part failed to load: \(failure["message"] ?? "")", true)
        }
        isRunning = true
    }
}
