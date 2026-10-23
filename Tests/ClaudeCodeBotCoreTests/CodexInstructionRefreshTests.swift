import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexInstructionRefreshTests {
    typealias Out = CodexSessionTests.Out

    private func reply(_ write: [String: Any], result: [String: Any] = [:], error: String? = nil,
                       to session: inout CodexSession) throws -> Out {
        var response: [String: Any] = ["id": write["id"]!]
        if let error { response["error"] = ["message": error] } else { response["result"] = result }
        return Out(session.receive(String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self)))
    }

    @Test func resumedCoordinatorRefreshesDeveloperHistoryBeforeAnyQueuedInputWithoutReplacingTools() throws {
        var session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp/refresh"),
            instructions: "current Scope contract policy", resumeThread: "same-thread", workerInstructions: "execute"))
        let initialize = try #require(Out(session.start()).writes.first)
        _ = session.send(.init(text: "research only"))
        let resume = try #require(try reply(initialize, to: &session).writes.last)
        let resumeParams = try #require(resume["params"] as? [String: Any])
        #expect(resume["method"] as? String == "thread/resume")
        #expect(resumeParams["dynamicTools"] == nil)
        #expect(resumeParams["sandbox"] as? String == "workspace-write")
        #expect(resumeParams["approvalPolicy"] as? String == "on-request")
        let refreshed = try reply(resume, result: ["thread": ["id": "same-thread"]], to: &session)
        #expect(!refreshed.methods.contains("turn/start"))
        let injection = try #require(refreshed.writes.first { $0["method"] as? String == "thread/inject_items" })
        let params = try #require(injection["params"] as? [String: Any])
        #expect(params["threadId"] as? String == "same-thread")
        let item = try #require((params["items"] as? [[String: Any]])?.first)
        #expect(item["role"] as? String == "developer")
        #expect((item["content"] as? [[String: Any]])?.first?["text"] as? String == "current Scope contract policy")
        let ready = try reply(injection, to: &session)
        #expect(ready.threads == ["same-thread"])
        #expect((ready.params("turn/start")?["input"] as? [[String: Any]])?.first?["text"] as? String == "research only")
    }

    @Test func failedRefreshDoesNotExecuteQueuedInputUnderStalePolicy() throws {
        var session = CodexSession(config: .init(workingDirectory: URL(filePath: "/tmp/refresh"),
            instructions: "new authorization policy", resumeThread: "same-thread", workerInstructions: "execute"))
        let initialize = try #require(Out(session.start()).writes.first)
        _ = session.send(.init(text: "do work"))
        let resume = try #require(try reply(initialize, to: &session).writes.last)
        let refresh = try reply(resume, result: ["thread": ["id": "same-thread"]], to: &session)
        let injection = try #require(refresh.writes.first { $0["method"] as? String == "thread/inject_items" })
        let failure = try reply(injection, error: "unsupported method", to: &session)
        #expect(failure.failed?.contains("unsupported method") == true)
        #expect(!failure.methods.contains("turn/start"))
    }
    @Test func managedWorkerUsageFeedsThroughputWithoutLosingRuntimeMetadata() throws {
        let helper = CodexManagedWorkerTests()
        var (session, _) = helper.ready()
        helper.rootTurn(&session)
        let (task, _) = helper.launch(&session)
        let out = helper.receive(["method":"thread/tokenUsage/updated", "params":[
            "threadId":"worker", "tokenUsage":["total":["inputTokens":100,"cachedInputTokens":20,"outputTokens":42]]
        ]], &session)
        #expect(out.traces.contains { event in
            if case let .subagentOutput(id, counter, tokens) = event {
                return id == task && counter == "thread:worker" && tokens == 42
            }
            return false
        })
        #expect(session.managedWorkerRecords.first?.tokens?.output == 42)
    }

}
