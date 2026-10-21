import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
private final class FakeTelegram: TelegramTransport {
    var batches: [[TelegramUpdate]] = []
    var offsets: [Int64] = []
    var sent: [(String, Int64)] = []
    var failSend = false
    func updates(offset: Int64, timeout: Int) async throws -> [TelegramUpdate] {
        offsets.append(offset)
        return batches.isEmpty ? [] : batches.removeFirst()
    }
    func send(_ text: String, chatID: Int64) async throws {
        sent.append((text, chatID))
        if failSend { throw TelegramFailure.unavailable }
    }
}

@MainActor
struct TelegramTests {
    let config = TelegramConfiguration(token: "123:TEST_ONLY_NOT_A_REAL_TOKEN", ownerID: 42, chatID: 42)

    func update(_ id: Int64, text: String = "hello", owner: Int64 = 42, chat: Int64 = 42,
                type: String = "private", age: TimeInterval = 0, extra: [String: Any] = [:]) throws -> TelegramUpdate {
        var message: [String: Any] = [
            "message_id": id, "date": Date().timeIntervalSince1970 - age,
            "from": ["id": owner, "is_bot": false], "chat": ["id": chat, "type": type], "text": text
        ]
        message.merge(extra) { _, new in new }
        let data = try JSONSerialization.data(withJSONObject: ["update_id": id, "message": message])
        return try JSONDecoder().decode(TelegramUpdate.self, from: data)
    }

    func workspace(_ root: URL, _ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root) { profile, store in Bot(profile: profile, launcher: fake.launcher, store: store) }
    }

    @Test func disabledUnlessExplicitAndComplete() {
        #expect(TelegramConfiguration.read([:]) == nil)
        let values = ["CCB_TELEGRAM_ENABLED": "1", "CCB_TELEGRAM_TOKEN": config.token,
                      "CCB_TELEGRAM_OWNER_ID": "42", "CCB_TELEGRAM_CHAT_ID": "42"]
        #expect(TelegramConfiguration.read(values) != nil)
        #expect(TelegramConfiguration.read(values.merging(["CCB_TELEGRAM_ENABLED": "0"]) { _, b in b }) == nil)
        #expect(TelegramConfiguration.read(values.merging(["CCB_TELEGRAM_CHAT_ID": "-100"]) { _, b in b }) == nil)
        #expect(TelegramConfiguration.read(values.merging(["CCB_TELEGRAM_TOKEN": "123:bad/path"]) { _, b in b }) == nil)
    }

    @Test func ownerChatFreshnessAndForwardChecks() throws {
        #expect(try update(1).authorized(by: config, now: Date()))
        #expect(try !update(2, owner: 99).authorized(by: config, now: Date()))
        #expect(try !update(3, chat: 99).authorized(by: config, now: Date()))
        #expect(try !update(4, type: "group").authorized(by: config, now: Date()))
        #expect(try !update(5, age: 601).authorized(by: config, now: Date()))
        #expect(try !update(6, extra: ["forward_origin": ["type": "user"]]).authorized(by: config, now: Date()))
        #expect(try !update(7, extra: ["via_bot": ["id": 2, "is_bot": true]]).authorized(by: config, now: Date()))
        #expect(try !update(8, extra: ["from": ["id": 42, "is_bot": true]]).authorized(by: config, now: Date()))
    }

    @Test func firstSetupDiscardsBacklogAndUnauthorizedMessagesNeverLaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), network = FakeTelegram()
        let ws = workspace(root, fake)
        network.batches = [[try update(10)], [try update(11, owner: 9), try update(12, chat: 9)]]
        var saves: [TelegramCheckpoint] = []
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { saves.append($0) }, delay: { _ in })
        try await bridge.initialize()
        try await bridge.pollOnce()
        #expect(network.offsets == [-1, 11])
        #expect(saves.last?.offset == 13)
        #expect(fake.agents.isEmpty)
        #expect(network.sent.isEmpty)
    }

    @Test func textUsesExistingBotAndDuplicateUpdateRunsOnlyOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), network = FakeTelegram()
        let ws = workspace(root, fake)
        let message = try update(1)
        network.batches = [[], [message, message], []]
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in }, delay: { _ in })
        try await bridge.initialize()
        try await bridge.pollOnce()
        await eventually { ws.mainBot.messages.contains { $0.role == .bot } }
        try await bridge.pollOnce()
        #expect(ws.mainBot.messages.filter { $0.role == .user }.count == 1)
        #expect(fake.agents.count == 1)
        #expect(network.sent.contains { $0.0.contains("Got it") && $0.1 == 42 })
    }

    @Test func checkpointFailurePreventsDispatch() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), network = FakeTelegram()
        let ws = workspace(root, fake)
        network.batches = [[], [try update(1)]]
        var writes = 0
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in
            writes += 1
            if writes > 1 { throw TelegramFailure.storage }
        }, delay: { _ in })
        try await bridge.initialize()
        do { try await bridge.pollOnce(); Issue.record("Expected storage failure") } catch {}
        #expect(fake.agents.isEmpty)
        #expect(ws.mainBot.messages.allSatisfy { $0.role != .user })
    }

    @Test func restoredCheckpointDoesNotReplayAndCorruptStateFailsClosed() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let ws = workspace(root), network = FakeTelegram()
        let file = root.appending(path: "telegram-state.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(TelegramCheckpoint(identity: config.identity, offset: 50, selected: Workspace.mainBotID)).write(to: file)
        network.batches = [[try update(49)]]
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in }, delay: { _ in })
        try await bridge.initialize()
        try await bridge.pollOnce()
        #expect(network.offsets == [50])
        #expect(network.sent.isEmpty)
        try Data("invalid".utf8).write(to: file)
        let broken = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in }, delay: { _ in })
        do { try await broken.initialize(); Issue.record("Expected invalid checkpoint to fail") } catch {}
    }

    @Test func approvalsAndUnknownCommandsNeverForward() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), network = FakeTelegram()
        let ws = workspace(root, fake)
        ws.mainBot.notice("Approve?", choices: [Choice(label: "Allow", action: .allowOnce)])
        network.batches = [[], [try update(1, text: "yes"), try update(2, text: "/share"), try update(3, text: "/approve")]]
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in }, delay: { _ in })
        try await bridge.initialize()
        try await bridge.pollOnce()
        #expect(fake.agents.isEmpty)
        #expect(ws.mainBot.messages.first?.chosen == nil)
        #expect(network.sent.contains { $0.0.contains("pending decision") })
    }

    @Test func selectionDoesNotChangeDesktopAndStopOnlyTargetsSelection() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), network = FakeTelegram()
        let ws = workspace(root, fake)
        let folder = root.appending(path: "project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = ws.addProject(folder: folder)
        ws.select(nil)
        ws.mainBot.send("desktop work")
        network.batches = [[], [try update(1, text: "/use \(project.id)"), try update(2), try update(3, text: "/stop")]]
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in }, delay: { _ in })
        try await bridge.initialize()
        try await bridge.pollOnce()
        #expect(ws.selection == nil)
        #expect(ws.mainBot.messages.filter { $0.role == .user }.count == 1)
        #expect(ws.bot(for: project)?.messages.contains { $0.role == .user && $0.text == "hello" } == true)
        #expect(fake.agents.first?.finished == false)
    }

    @Test func unicodeOutputIsBoundedAndUnknownMediaIsNotDownloaded() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-telegram-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), network = FakeTelegram()
        let ws = workspace(root, fake)
        network.batches = [[], [try update(1, extra: ["text": NSNull(), "photo": [["file_id": "never-download"]]])]]
        let bridge = TelegramBridge(workspace: ws, config: config, transport: network, save: { _ in }, delay: { _ in })
        try await bridge.initialize()
        try await bridge.pollOnce()
        #expect(fake.agents.isEmpty)
        #expect(network.sent.first?.0.contains("text only") == true)
        let value = TelegramBridge.bounded(String(repeating: "👨‍👩‍👧‍👦", count: 1000))
        #expect(value.utf16.count < 4096)
        #expect(value.contains("Truncated"))
    }
}
