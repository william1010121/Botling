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
