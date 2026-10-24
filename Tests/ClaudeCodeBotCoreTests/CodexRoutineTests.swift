import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexRoutineTests {
    @Test func coordinatorDiscoversFirstClassRoutineTool() throws {
        let helpers = CodexManagedWorkerTests()
        var session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp/bot"),
            instructions: "coordinate", workerInstructions: "execute"))
        let initialize = CodexSessionTests.Out(session.start()).writes[0]
        let start = helpers.response(initialize, [:], &session)
        let tools = try #require(start.params("thread/start")?["dynamicTools"] as? [[String: Any]])
        let routine = try #require(tools.first { $0["name"] as? String == "app_routines" })
        #expect((routine["description"] as? String)?.contains("once") == true)
        #expect((routine["description"] as? String)?.contains("recurring") == true)
    }
}

extension CodexRoutineTests {
    @Test func routineToolPersistsIDsAndHandlesRetryCancelAndErrors() throws {
        let helpers = CodexManagedWorkerTests()
        let root = FileManager.default.temporaryDirectory.appending(path: "codex-routines-\(UUID())")
        var config = CodexSession.Config(workingDirectory: root, instructions: "coordinate", workerInstructions: "execute")
        config.routinesURL = root.appending(path: "routines.cron")
        var session = CodexSession(config: config)
        let initialize = CodexSessionTests.Out(session.start()).writes[0]
        let start = helpers.response(initialize, [:], &session)
        _ = helpers.response(helpers.write(start, "thread/start"), ["thread": ["id": "root"]], &session)
        helpers.rootTurn(&session)
        func payload(_ output: CodexSessionTests.Out) throws -> (Bool, [String: Any]) {
            let result = try #require(output.writes.first?["result"] as? [String: Any])
            let content = try #require(result["contentItems"] as? [[String: Any]])
            let text = try #require(content.first?["text"] as? String)
            return (result["success"] as? Bool == true, try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]))
        }
        let args: [String: Any] = ["operation": "create", "kind": "once", "at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
            "task": "Check: run once", "timezone": "Asia/Taipei", "request_id": "codex-test"]
        let accepted = try payload(helpers.tool(200, name: "app_routines", arguments: args, &session))
        #expect(accepted.0)
        let id = try #require(accepted.1["id"] as? String)
        #expect(try payload(helpers.tool(200, name: "app_routines", arguments: args, &session)).1["id"] as? String == id)
        #expect(try payload(helpers.tool(201, name: "app_routines", arguments: args, &session)).1["id"] as? String == id)
        let store = ScheduledRoutineStore(url: root.appending(path: "scheduled-routines.json"))
        #expect(try store.load().count == 1)
        #expect(try store.load().first?.id == id)
        #expect(try payload(helpers.tool(202, name: "app_routines", arguments: ["operation": "list"], &session)).0)
        #expect(try payload(helpers.tool(203, name: "app_routines", arguments: ["operation": "cancel", "id": id], &session)).1["status"] as? String == "cancelled")
        let error = try payload(helpers.tool(204, name: "app_routines", arguments: ["operation": "cancel", "id": "missing"], &session))
        #expect(!error.0)
        #expect((error.1["error"] as? String)?.contains("list") == true)
        let wrongThread = helpers.receive(["method": "item/tool/call", "id": 205,
            "params": ["threadId": "worker", "tool": "app_routines", "arguments": args]], &session)
        #expect(try !payload(wrongThread).0)
        #expect(try store.load().count == 1)
    }

    @Test func routineToolDoesNotGrantExecutionOrExposeCallerSelectedPaths() throws {
        let root = URL(filePath: "/tmp/routine-scope")
        var launch = AgentLaunch(engine: .codex, model: .sonnet, sessionID: UUID(), workingDirectory: root, systemPrompt: "coordinate")
        launch.codexWorkerInstructions = "execute"
        launch.routinesURL = root.appending(path: "routines.cron")
        let config = try CodexAgentProcess.config(for: launch, threads: CodexThreads(folder: root.appending(path: "threads")))
        #expect(config.routinesURL == launch.routinesURL)
        #expect(config.writableRoots.isEmpty)
        let prompt = BotPrompts(profile: .manager(name: "test", avatar: "square", folder: root), engine: .codex).system
        #expect(prompt.contains("app_routines directly"))
        #expect(prompt.contains("request_id"))
        #expect(prompt.contains("delivery_uncertain"))
        #expect(!prompt.contains("memory/routines updates"))
    }
}
