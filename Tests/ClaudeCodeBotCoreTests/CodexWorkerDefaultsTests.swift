import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The model, effort and speed app-managed Codex workers start on. Each one left unset follows
/// what workers did before: the coordinator's choice, else `~/.codex/config.toml`.
@MainActor
struct CodexWorkerDefaultsTests {
    typealias Out = CodexSessionTests.Out

    private func receive(_ value: [String: Any], _ session: inout CodexSession) -> Out {
        let data = try! JSONSerialization.data(withJSONObject: value)
        return Out(session.receive(String(decoding: data, as: UTF8.self)))
    }
    private func response(_ write: [String: Any], _ result: [String: Any], _ session: inout CodexSession) -> Out {
        receive(["id": write["id"]!, "result": result], &session)
    }
    private func write(_ out: Out, _ method: String) -> [String: Any] {
        out.writes.first { $0["method"] as? String == method }!
    }

    /// The coordinator's thread/start, then the worker's thread/start and turn/start params.
    private func handoff(model: String? = nil, effort: EffortLevel? = nil, workers: CodexWorkerDefaults = .init())
        throws -> (coordinator: [String: Any], thread: [String: Any], turn: [String: Any]) {
        var session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp/bot"), instructions: "coordinate",
            effort: effort, model: model, workerInstructions: "execute", workerDefaults: workers))
        let initialize = Out(session.start()).writes[0]
        let start = response(initialize, [:], &session)
        let coordinator = try #require(start.params("thread/start"))
        _ = response(write(start, "thread/start"), ["thread": ["id": "root"]], &session)
        let turn = Out(session.send(.init(text: "fix billing")))
        _ = response(write(turn, "turn/start"), ["turn": ["id": "parent-1"]], &session)
        let call = receive(["method": "item/tool/call", "id": 100, "params": ["threadId": "root", "turnId": "parent-1",
            "callId": "call-100", "tool": "app_handoff", "arguments": ["instructions": "fix and test", "name": "billing"]]], &session)
        let thread = try #require(call.params("thread/start"))
        let ready = response(write(call, "thread/start"), ["thread": ["id": "worker"], "model": "whatever"], &session)
        let workerTurn = try #require(ready.params("turn/start"))
        return (coordinator, thread, workerTurn)
    }

    @Test func unsetDefaultsKeepTodaysInheritance() throws {
        let plain = try handoff()
        #expect(plain.thread["model"] == nil)
        #expect(plain.thread["serviceTier"] == nil)
        #expect(plain.turn["effort"] == nil)

        let inherited = try handoff(model: "gpt-6-sol", effort: .high)
        #expect(inherited.thread["model"] as? String == "gpt-6-sol")
        #expect(inherited.thread["serviceTier"] == nil)
        #expect(inherited.turn["effort"] as? String == "high")
    }

    @Test func chosenDefaultsReachTheWorkerLaunchOnly() throws {
        let sent = try handoff(model: "gpt-6-sol", effort: .high,
            workers: CodexWorkerDefaults(model: "gpt-6-luna", effort: .medium, fast: false))
        #expect(sent.thread["model"] as? String == "gpt-6-luna")
        #expect(sent.thread["serviceTier"] as? String == "default")
        #expect(sent.turn["effort"] as? String == "medium")
        // The coordinator keeps its own choices.
        #expect(sent.coordinator["model"] as? String == "gpt-6-sol")
        #expect(sent.coordinator["serviceTier"] == nil)

        let fast = try handoff(workers: CodexWorkerDefaults(fast: true))
        #expect(fast.thread["serviceTier"] as? String == "priority")
        #expect(fast.thread["model"] == nil)
        #expect(fast.turn["effort"] == nil)
    }

    @Test func launchCarriesDefaultsIntoTheSessionConfig() throws {
        let threads = CodexThreads(folder: FileManager.default.temporaryDirectory.appending(path: "ccb-worker-defaults-\(UUID().uuidString)"))
        var launch = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp/bot"), systemPrompt: "")
        launch.codexWorkerInstructions = "execute"
        launch.codexWorkerDefaults = CodexWorkerDefaults(model: "gpt-6-luna", effort: .low, fast: true)
        let config = try CodexAgentProcess.config(for: launch, threads: threads)
        #expect(config.workerDefaults == CodexWorkerDefaults(model: "gpt-6-luna", effort: .low, fast: true))
    }

    // MARK: Saved and applied by the bot

    @Test func storeKeepsWorkerDefaultsAndToleratesUnknownValues() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ccb-worker-defaults-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = BotStore(directory: directory)
        #expect(store.loadCodexWorkerDefaults() == CodexWorkerDefaults())
        store.save(codexWorkerDefaults: CodexWorkerDefaults(model: "gpt-6-luna", effort: .medium, fast: false))
        #expect(BotStore(directory: directory).loadCodexWorkerDefaults() == CodexWorkerDefaults(model: "gpt-6-luna", effort: .medium, fast: false))
        store.save(codexWorkerDefaults: CodexWorkerDefaults())
        #expect(store.loadCodexWorkerDefaults() == CodexWorkerDefaults())

        let newer = #"{"codexWorkers":{"model":"gpt-7","effort":"ultra","fast":true}}"#
        try Data(newer.utf8).write(to: directory.appending(path: "bot.json"))
        #expect(BotStore(directory: directory).loadCodexWorkerDefaults() == CodexWorkerDefaults(model: "gpt-7", fast: true))
    }

    @Test func botSavesDefaultsAndHandsThemToItsNextLaunch() async {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ccb-worker-defaults-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let fake = FakeLauncher()
        let store = BotStore(directory: directory)
        store.save(engine: .codex)
        let bot = Bot(profile: .main(home: directory), launcher: fake.launcher, store: store)
        #expect(bot.codexWorkerDefaults == CodexWorkerDefaults())

        let chosen = CodexWorkerDefaults(model: "gpt-6-luna", effort: .medium, fast: false)
        await bot.setCodexWorkerDefaults(chosen)
        #expect(fake.agents.isEmpty)
        #expect(Bot(profile: .main(home: directory), launcher: fake.launcher, store: BotStore(directory: directory)).codexWorkerDefaults == chosen)

        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        #expect(fake.agents[0].launch.codexWorkerDefaults == chosen)
        bot.stop()
    }

    @Test func changingWhileAwakeOnCodexRestartsBeforeTheNextMessage() async {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ccb-worker-defaults-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let fake = FakeLauncher()
        let store = BotStore(directory: directory)
        store.save(engine: .codex)
        let bot = Bot(profile: .main(home: directory), launcher: fake.launcher, store: store)
        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }

        await bot.setCodexWorkerDefaults(CodexWorkerDefaults(fast: true))
        bot.send("next")
        await eventually { fake.agents.count == 2 && bot.phase == .awake && !bot.isWorking }
        #expect(fake.agents[1].launch.codexWorkerDefaults == CodexWorkerDefaults(fast: true))
        bot.stop()
    }
}
