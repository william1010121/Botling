import Foundation

/// Opt-in only. The token is read from the launching process, never saved in app state.
public struct TelegramConfiguration {
    let token: String
    let ownerID: Int64
    let chatID: Int64
    var identity: String { "\(token.split(separator: ":")[0]):\(ownerID):\(chatID)" }

    public static func read(_ environment: [String: String]) -> TelegramConfiguration? {
        guard environment["CCB_TELEGRAM_ENABLED"] == "1",
              let token = environment["CCB_TELEGRAM_TOKEN"],
              token.range(of: #"^[0-9]+:[A-Za-z0-9_-]{20,}$"#, options: .regularExpression) != nil,
              let owner = environment["CCB_TELEGRAM_OWNER_ID"].flatMap(Int64.init), owner > 0,
              let chat = environment["CCB_TELEGRAM_CHAT_ID"].flatMap(Int64.init), chat > 0
        else { return nil }
        return TelegramConfiguration(token: token, ownerID: owner, chatID: chat)
    }
}

struct TelegramUpdate: Decodable {
    let update_id: Int64
    let message: Message?
    struct Message: Decodable {
        let message_id: Int64
        let date: TimeInterval
        let from: User?
        let chat: Chat
        let text: String?
        let forward_origin: ForwardOrigin?
        let via_bot: User?
    }
    struct User: Decodable { let id: Int64; let is_bot: Bool }
    struct Chat: Decodable { let id: Int64; let type: String }
    struct ForwardOrigin: Decodable {}

    func authorized(by config: TelegramConfiguration, now: Date) -> Bool {
        guard let message, let sender = message.from,
              message.chat.type == "private", message.chat.id == config.chatID,
              sender.id == config.ownerID, !sender.is_bot,
              message.forward_origin == nil, message.via_bot == nil else { return false }
        let age = now.timeIntervalSince1970 - message.date
        return age >= -30 && age <= 600
    }
}

@MainActor
protocol TelegramTransport {
    func updates(offset: Int64, timeout: Int) async throws -> [TelegramUpdate]
    func send(_ text: String, chatID: Int64) async throws
}

enum TelegramFailure: Error { case unavailable, invalidResponse, storage }

/// Never follow redirects: the API token is part of Telegram's URL.
private final class TelegramRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class TelegramHTTP: TelegramTransport {
    private let token: String
    private let session: URLSession
    init(token: String) {
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 35
        config.timeoutIntervalForResource = 40
        session = URLSession(configuration: config, delegate: TelegramRedirectGuard(), delegateQueue: nil)
    }

    func updates(offset: Int64, timeout: Int) async throws -> [TelegramUpdate] {
        let data = try await request("getUpdates", [
            "offset": offset, "timeout": timeout, "limit": 20, "allowed_updates": ["message"]
        ])
        struct Envelope: Decodable { let ok: Bool; let result: [TelegramUpdate]? }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.ok, let updates = envelope.result else { throw TelegramFailure.invalidResponse }
        return updates
    }

    func send(_ text: String, chatID: Int64) async throws {
        let data = try await request("sendMessage", [
            "chat_id": chatID, "text": TelegramBridge.bounded(text),
            "link_preview_options": ["is_disabled": true]
        ])
        struct Envelope: Decodable { let ok: Bool }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.ok
        else { throw TelegramFailure.invalidResponse }
    }

    private func request(_ method: String, _ body: [String: Any]) async throws -> Data {
        // Fixed origin and methods; no user-controlled URL or token-bearing diagnostics.
        let url = URL(string: "https://api.telegram.org/bot\(token)/\(method)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200
            else { throw TelegramFailure.unavailable }
            var data = Data()
            for try await byte in bytes {
                guard data.count < 1_048_576 else { throw TelegramFailure.invalidResponse }
                data.append(byte)
            }
            return data
        } catch {
            // URLSession errors can contain the URL (and hence the token).
            throw TelegramFailure.unavailable
        }
    }
}

/// One tiny checkpoint, replaced atomically. Record before dispatch: never replay a command
/// after a crash. A crash between recording and dispatch can lose it; the owner may resend.
struct TelegramCheckpoint: Codable {
    var identity: String
    var offset: Int64
    var selected: UUID
}

@MainActor
public final class TelegramBridge {
    private let workspace: Workspace
    private let config: TelegramConfiguration
    private let transport: any TelegramTransport
    private let checkpointURL: URL
    private var checkpoint: TelegramCheckpoint?
    private var task: Task<Void, Never>?
    private var watching: [UUID: Set<UUID>] = [:]
    private var outbox: [String] = []
    private let save: (TelegramCheckpoint) throws -> Void
    private var warned = false
    private let delay: (TimeInterval) async throws -> Void

    public static func configured(workspace: Workspace, environment: [String: String]) -> TelegramBridge? {
        guard let config = TelegramConfiguration.read(environment) else { return nil }
        return TelegramBridge(workspace: workspace, config: config, transport: TelegramHTTP(token: config.token))
    }

    init(workspace: Workspace, config: TelegramConfiguration, transport: any TelegramTransport,
         save: ((TelegramCheckpoint) throws -> Void)? = nil,
         delay: @escaping (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.workspace = workspace
        self.config = config
        self.transport = transport
        self.delay = delay
        checkpointURL = workspace.root.appending(path: "telegram-state.json")
        let url = checkpointURL
        self.save = save ?? { value in
            let attributes = try FileManager.default.attributesOfFileSystem(forPath: url.deletingLastPathComponent().path)
            guard let free = attributes[.systemFreeSize] as? NSNumber, free.int64Value >= 512 * 1024 * 1024
            else { throw TelegramFailure.storage }
            let data = try JSONEncoder().encode(value)
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }

    public func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            do { try await initialize() }
            catch { reportFailure(); task = nil; return }
            while !Task.isCancelled {
                do {
                    try await pollOnce()
                    warned = false
                } catch {
                    if Task.isCancelled { break }
                    reportFailure()
                    try? await Task.sleep(for: .seconds(10))
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        watching.removeAll()
        outbox.removeAll()
    }

    func initialize() async throws {
        if FileManager.default.fileExists(atPath: checkpointURL.path) {
            // Corrupt state fails closed rather than replaying an unknown backlog.
            let data = try Data(contentsOf: checkpointURL)
            guard data.count < 4096,
                  let saved = try? JSONDecoder().decode(TelegramCheckpoint.self, from: data),
                  saved.identity == config.identity, saved.offset >= 0 else { throw TelegramFailure.storage }
            checkpoint = saved
        } else {
            // First setup discards pre-setup messages, rather than executing old instructions.
            let tail = try await transport.updates(offset: -1, timeout: 0)
            let offset = (tail.map(\.update_id).max() ?? -1) + 1
            let value = TelegramCheckpoint(identity: config.identity, offset: offset, selected: Workspace.mainBotID)
            try save(value)
            checkpoint = value
        }
    }

    func pollOnce(now: Date = Date()) async throws {
        guard let saved = checkpoint else { throw TelegramFailure.storage }
        let updates = try await transport.updates(offset: saved.offset, timeout: 5)
        try Task.checkCancellation()
        for update in updates.sorted(by: { $0.update_id < $1.update_id }) {
            guard var state = checkpoint, update.update_id >= state.offset,
                  update.update_id < Int64.max else { continue }
            state.offset = update.update_id + 1
            try save(state)
            checkpoint = state
            guard update.authorized(by: config, now: now) else { continue }
            await handle(update)
            try Task.checkCancellation()
        }
        collectReplies()
        // Bounded batch, no retries of uncertain sends. /latest recovers a missed response.
        for _ in 0..<min(3, outbox.count) {
            let text = outbox.removeFirst()
            try await transport.send(text, chatID: config.chatID)
            try await delay(1)
        }
    }

    private func handle(_ update: TelegramUpdate) async {
        guard let message = update.message, let text = message.text, !text.isEmpty else {
            enqueue("This first version accepts text only. Use the Mac for files and approvals.")
            return
        }
        guard text.utf8.count <= 16_384 else { enqueue("Message too long. Please shorten it."); return }
        guard var state = checkpoint else { return }
        let words = text.split(whereSeparator: \.isWhitespace)
        let command = words.first.map(String.init) ?? ""
        if command == "/start" || command == "/help" {
            enqueue("Connected to your Mac. /bots lists chats; /use main, /use codex or /use <project ID> selects one. /status, /latest and /stop work on that selection. Text goes to the same bot and local permission rules apply. Resolve approvals on the Mac. No files, remote approval buttons or group chats yet.")
            return
        }
        if command == "/bots" {
            let rows = ["main — \(workspace.mainBot.name)", "codex — \(workspace.codexBot.name)"] +
                workspace.projects.map { "\($0.id.uuidString) — \($0.name)" }
            enqueue(rows.joined(separator: "\n"))
            return
        }
        if command == "/use" {
            guard words.count == 2 else { enqueue("Use /use main, /use codex or /use <project ID>."); return }
            let value = String(words[1])
            let id = value == "main" ? Workspace.mainBotID : value == "codex" ? Workspace.codexID : UUID(uuidString: value)
            guard let id, let bot = workspace.member(id) else { enqueue("Unknown bot. Use /bots."); return }
            state.selected = id
            do { try save(state); checkpoint = state; enqueue("Selected \(bot.name).") }
            catch { enqueue("Cannot save selection. Resolve local storage, then try again.") }
            return
        }
        guard let bot = workspace.member(state.selected) else { enqueue("That bot is no longer available. Use /use main."); return }
        switch command {
        case "/status":
            enqueue("\(bot.name): \(bot.waitingForPermission ? "waiting for approval on the Mac" : bot.isWorking ? "working" : "idle").")
        case "/latest":
            if let reply = bot.messages.last(where: { $0.role == .bot || $0.role == .error }) {
                enqueue("\(bot.name):\n\(reply.text)")
            } else { enqueue("\(bot.name): no reply yet.") }
        case "/stop":
            bot.stop()
            enqueue("Stopped \(bot.name)'s local session. Other bots are unchanged.")
        default:
            // Unknown slash commands are not forwarded into plugins or app commands.
            guard !text.hasPrefix("/") else { enqueue("Unknown command. Use /help."); return }
            // Text must not resolve an existing approval implicitly.
            guard !bot.waitingForPermission, !bot.messages.contains(where: { $0.isOpenQuestion }) else {
                enqueue("This bot has a pending decision. Resolve it on the Mac before sending more text.")
                return
            }
            if watching[state.selected] == nil {
                guard watching.count < 16 else { enqueue("Too many active chats. Restart the bridge or use /latest."); return }
                watching[state.selected] = Set(bot.messages.map(\.id))
            }
            await workspace.send(text, to: bot)
            enqueue("Sent to \(bot.name).")
        }
    }

    private func collectReplies() {
        for id in Array(watching.keys) {
            guard let bot = workspace.member(id), let seen = watching[id] else { watching[id] = nil; continue }
            // Keep only IDs still in the bounded bot history, not an ever-growing relay archive.
            for message in bot.messages where !seen.contains(message.id) {
                if message.role == .bot || message.role == .error || message.role == .notice {
                    let suffix = message.isOpenQuestion ? "\nDecision required: open ClaudeCodeBot on your Mac." : ""
                    enqueue("\(bot.name):\n\(message.text)\(suffix)")
                }
            }
            watching[id] = Set(bot.messages.map(\.id))
        }
    }

    private func enqueue(_ text: String) {
        guard outbox.count < 32 else { return } // /latest retrieves the newest answer after a burst.
        outbox.append(Self.bounded(text))
    }

    static func bounded(_ text: String) -> String {
        // Telegram measures message length in UTF-16 units. Do not split a grapheme.
        var result = ""
        for character in text {
            let next = String(character)
            if result.utf16.count + next.utf16.count > 3500 { return result + "\n[Truncated; see the Mac for the full result.]" }
            result += next
        }
        return result.isEmpty ? "(No text; open the Mac to view the result.)" : result
    }

    private func reportFailure() {
        guard !warned else { return }
        warned = true
        workspace.mainBot.notice("Telegram is paused or reconnecting. Check the local configuration, connection and free disk space. No API error details are logged because they can contain credentials.")
    }
}
