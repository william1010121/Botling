import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CodexToolSchemaMigrationTests {
    @Test func oldTwoToolMarkerMigratesWithoutLosingThreadLineageOrWorkerRecords() throws {
        let root = FileManager.default.temporaryDirectory.appending(path:"ccb-schema-migration-\(UUID())")
        defer { try? FileManager.default.removeItem(at:root) }
        let threads = CodexThreads(folder:root), sessionID = UUID()
        threads.save("old-two-tool-thread",for:sessionID)
        let marker = root.appending(path:sessionID.uuidString.lowercased()+".managed")
        try Data("old-two-tool-thread".utf8).write(to:marker) // Actual pre-upgrade stamp.
        let record = CodexManagedWorkerRecord(id:"task-preserved",name:"integration",instructions:"finish authorized work",
            thread:"same-worker-thread",run:4,wasActive:false,reportPending:true,report:"evidence",status:"completed",reconciliationAttempt:1)
        threads.saveWorkers([record],for:sessionID)
        let workerFile = root.appending(path:sessionID.uuidString.lowercased()+".workers.json")
        let workerBytes = try Data(contentsOf:workerFile)
        var launch = AgentLaunch(engine:.codex,model:.sonnet,sessionID:sessionID,resume:true,
            workingDirectory:root,systemPrompt:"current coordinator policy")
        launch.codexWorkerInstructions = "execute"
        let config = try CodexAgentProcess.config(for:launch,threads:threads)
        #expect(config.resumeThread == nil)
        #expect(config.restoredWorkers == [record])
        #expect(threads.thread(for:sessionID) == "old-two-tool-thread")
        threads.save("new-three-tool-thread",for:sessionID)
        threads.markManaged("new-three-tool-thread",for:sessionID)
        #expect(threads.isManaged(sessionID,thread:"new-three-tool-thread"))
        #expect(try CodexAgentProcess.config(for:launch,threads:threads).resumeThread == "new-three-tool-thread")
        #expect(try String(contentsOf:root.appending(path:sessionID.uuidString.lowercased()+".previous-threads"),encoding:.utf8) == "old-two-tool-thread\n")
        #expect(try Data(contentsOf:workerFile) == workerBytes)
        // A changed schema with the same tool count also requires migration.
        var stamp = try #require(JSONSerialization.jsonObject(with:Data(contentsOf:marker)) as? [String:Any])
        stamp["tools"] = "old schema with three names"
        try JSONSerialization.data(withJSONObject:stamp).write(to:marker)
        #expect(!threads.isManaged(sessionID,thread:"new-three-tool-thread"))
    }

    @Test(.enabled(if:ProcessInfo.processInfo.environment["CCB_TOOL_MIGRATION_EXPORT"] != nil))
    func exportActualCoordinatorStartForRecordingOnlyLiveProbe() throws {
        let root = URL(filePath:try #require(ProcessInfo.processInfo.environment["CCB_TOOL_MIGRATION_EXPORT"]))
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        let prompts = BotPrompts(profile:.manager(name:"botling",avatar:"square",folder:root),engine:.codex)
        var session = CodexSession(config:.init(workingDirectory:root,instructions:prompts.system,workerInstructions:prompts.codexWorkerSystem))
        let initialize = try #require(CodexSessionTests.Out(session.start()).writes.first)
        let response:[String:Any] = ["id":initialize["id"]!,"result":[:]]
        let start = CodexSessionTests.Out(session.receive(String(decoding:try JSONSerialization.data(withJSONObject:response),as:UTF8.self)))
        let params = try #require(start.params("thread/start"))
        let tools = try #require(params["dynamicTools"] as? [[String:Any]])
        #expect(Set(tools.compactMap { $0["name"] as? String }) == ["app_handoff","app_send_message","app_task_checkpoint","app_routines","app_monitor_start","app_monitor_status","app_monitor_cancel"])
        try JSONSerialization.data(withJSONObject:params,options:[.sortedKeys,.prettyPrinted]).write(to:root.appending(path:"production-start.json"))
    }
}
