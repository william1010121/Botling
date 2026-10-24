import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ScheduledRoutineStoreTests {
    let folder = FileManager.default.temporaryDirectory.appending(path: "scheduled-routine-\(UUID())")
    var store: ScheduledRoutineStore { ScheduledRoutineStore(url: folder.appending(path: "scheduled-routines.json")) }
    let now = ISO8601DateFormatter().date(from: "2026-10-24T08:00:00Z")!

    func once(_ key: String = "one", at: String = "2026-10-24T17:00:00+08:00") -> [String: Any] {
        ["operation": "create", "kind": "once", "at": at, "timezone": "Asia/Taipei", "task": "Check: inspect result", "request_id": key]
    }
    func id(_ payload: [String: Any]) throws -> String { try #require(payload["id"] as? String) }

    @Test func overdueOnceRecoversAfterRestartAndFiresOnlyOnce() throws {
        let id = try id(store.perform(once(), now: now))
        let due = now.addingTimeInterval(3600)
        #expect(try store.load().first?.status(at: now) == "pending")
        let restarted = ScheduledRoutineStore(url: store.url)
        #expect(try restarted.load().first?.status(at: due.addingTimeInterval(86400)) == "due")
        #expect(try restarted.claim(id, now: due.addingTimeInterval(86400)) != nil)
        try restarted.didDispatch(id, now: due.addingTimeInterval(86400))
        #expect(try store.load().first?.state == .fired)
        #expect(try store.claim(id, now: due.addingTimeInterval(172800)) == nil)
        #expect(try store.perform(once(), now: due)["id"] as? String == id) // retry even after time passed
        #expect(throws: (any Error).self) { try store.perform(["operation": "resume", "id": id], now: due) }
    }

    @Test func crashAfterClaimRemainsUncertainAndNeverRetries() throws {
        let id = try id(store.perform(once(), now: now))
        #expect(try store.claim(id, now: now.addingTimeInterval(3600)) != nil)
        let restarted = ScheduledRoutineStore(url: store.url)
        #expect(try restarted.load().first?.status(at: now) == "delivery_uncertain")
        #expect(try restarted.claim(id, now: now.addingTimeInterval(999999)) == nil)
        #expect(throws: (any Error).self) { try restarted.perform(["operation": "cancel", "id": id]) }
    }

    @Test func cancellationAndPausePersistBeforeDispatch() throws {
        let id = try id(store.perform(once(), now: now))
        _ = try store.perform(["operation": "pause", "id": id], now: now)
        let due = now.addingTimeInterval(3601)
        #expect(try store.claim(id, now: due) == nil)
        _ = try store.perform(["operation": "resume", "id": id], now: due)
        #expect(try store.load().first?.status(at: due) == "due")
        _ = try store.perform(["operation": "cancel", "id": id], now: due)
        #expect(try ScheduledRoutineStore(url: store.url).claim(id, now: due) == nil)
        #expect(try store.perform(once(), now: due)["status"] as? String == "cancelled")
        #expect(throws: (any Error).self) { try store.perform(["operation": "resume", "id": id]) }
    }

    @Test func createIsIdempotentButDifferentPayloadCannotReuseKey() throws {
        let first = try id(store.perform(once(), now: now))
        #expect(try id(store.perform(once(), now: now)) == first)
        #expect(try store.load().count == 1)
        var changed = once(); changed["task"] = "different"
        #expect(throws: (any Error).self) { try store.perform(changed, now: now) }
        var past = once("past"); past["at"] = "2026-10-24T07:59:00Z"
        #expect(throws: (any Error).self) { try store.perform(past, now: now) }
        var ambiguous = once("ambiguous"); ambiguous["at"] = "2026-11-01T01:30:00"
        #expect(throws: (any Error).self) { try store.perform(ambiguous, now: now) }
        var badZone = once("zone"); badZone["timezone"] = "Not/AZone"
        #expect(throws: (any Error).self) { try store.perform(badZone, now: now) }
        #expect(throws: (any Error).self) { try store.perform(["operation": "cancel", "id": "missing"]) }
    }

    @Test func corruptOrUnwritableStateDoesNotDispatchOrOverwrite() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let bytes = Data("not json".utf8)
        try bytes.write(to: store.url)
        #expect(throws: (any Error).self) { try store.claim("anything", now: now) }
        #expect(throws: (any Error).self) { try store.perform(once(), now: now) }
        #expect(try Data(contentsOf: store.url) == bytes)
        let blocked = folder.appending(path: "file-not-folder")
        try Data().write(to: blocked)
        let unwritable = ScheduledRoutineStore(url: blocked.appending(path: "scheduled-routines.json"))
        #expect(throws: (any Error).self) { try unwritable.perform(once(), now: now) }
    }

    @Test func recurringUsesSavedTimezoneAndCatchesUpOnlyToday() throws {
        let args: [String: Any] = ["operation": "create", "kind": "recurring", "cron": "0 18 * * *", "timezone": "Asia/Taipei", "task": "Daily: check", "request_id": "daily"]
        let id = try id(store.perform(args, now: now)) // 16:00 Taipei
        let due = now.addingTimeInterval(7200) // 18:00 Taipei
        #expect(try store.load().first?.dueTime(at: due) == due)
        #expect(try store.claim(id, now: due) != nil)
        try store.didDispatch(id, now: due)
        #expect(try store.claim(id, now: due.addingTimeInterval(60)) == nil)
        #expect(try store.load().first?.dueTime(at: due.addingTimeInterval(86400 - 60)) == nil)
        #expect(try store.claim(id, now: due.addingTimeInterval(86400)) != nil)
    }

    @Test func resumeAfterPriorFireSkipsOccurrencesWhilePaused() throws {
        let args: [String: Any] = ["operation": "create", "kind": "recurring", "cron": "0 18 * * *", "timezone": "Asia/Taipei", "task": "Daily: check", "request_id": "resume"]
        let id = try id(store.perform(args, now: now))
        let first = now.addingTimeInterval(7200)
        #expect(try store.claim(id, now: first) != nil)
        try store.didDispatch(id, now: first)
        _ = try store.perform(["operation": "pause", "id": id], now: first.addingTimeInterval(60))
        let resumed = first.addingTimeInterval(86400 + 3600)
        _ = try store.perform(["operation": "resume", "id": id], now: resumed)
        #expect(try store.claim(id, now: resumed) == nil)
        #expect(try store.claim(id, now: first.addingTimeInterval(172800)) != nil)
    }

    @Test func retryWithOmittedTimezoneRetainsOriginalResolvedTimezone() throws {
        var args = once()
        args.removeValue(forKey: "timezone")
        let id = try id(store.perform(args, now: now))
        // Simulate a store created in a different system zone, then a retry with timezone omitted.
        var text = try String(contentsOf: store.url, encoding: .utf8)
        let old = try #require(store.load().first?.timezone)
        text = text.replacingOccurrences(of: old.replacingOccurrences(of: "/", with: "\\/"), with: "Europe\\/Paris")
        try text.write(to: store.url, atomically: true, encoding: .utf8)
        #expect(try store.perform(args, now: now)["id"] as? String == id)
        #expect(try store.load().first?.timezone == "Europe/Paris")
    }

    @Test func explicitOffsetsKeepDstFoldInstantsDistinct() throws {
        let a = try id(store.perform(once("dst-a", at: "2026-11-01T01:30:00-04:00"), now: now))
        let b = try id(store.perform(once("dst-b", at: "2026-11-01T01:30:00-05:00"), now: now))
        let jobs = try store.load()
        #expect(jobs[1].at!.timeIntervalSince(jobs[0].at!) == 3600)
        #expect(try store.claim(a, now: jobs[0].at!) != nil)
        #expect(try store.claim(b, now: jobs[0].at!) == nil)
    }

    @Test func legacyCronCommentsAndIdsRemainUsable() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: "routines.cron")
        try "# keep me\n0 9 * * * Daily: check\n".write(to: file, atomically: true, encoding: .utf8)
        let list = try #require(store.perform(["operation": "list"])["routines"] as? [[String: Any]])
        let id = try id(try #require(list.first))
        _ = try store.perform(["operation": "pause", "id": id])
        #expect(RoutineFile(url: file).load().first?.enabled == false)
        _ = try store.perform(["operation": "resume", "id": id])
        #expect(RoutineFile(url: file).load().first?.enabled == true)
        _ = try store.perform(["operation": "cancel", "id": id])
        #expect(RoutineFile(url: file).load().isEmpty)
        #expect(try String(contentsOf: file, encoding: .utf8) == "# keep me\n")
    }

    @Test func concurrentClaimsAcrossStoreInstancesHaveOneWinner() async throws {
        let id = try id(store.perform(once(), now: now))
        let url = store.url, due = now.addingTimeInterval(3600)
        let winners = try await withThrowingTaskGroup(of: Bool.self) { group in
            for _ in 0..<40 { group.addTask { try ScheduledRoutineStore(url: url).claim(id, now: due) != nil } }
            var count = 0
            for try await won in group { if won { count += 1 } }
            return count
        }
        #expect(winners == 1)
    }
}

@MainActor
struct ScheduledRoutineDispatchTests {
    @Test func workspaceDispatchesOverdueOnceAfterRestartAndNeverAgain() async throws {
        let helpers = RoutineTests()
        let fake = FakeLauncher()
        fake.respond = { _ in "checked" }
        let first = helpers.makeWorkspace(fake)
        first.mainBot.setRoutine(first.mainBot.routines[0].id, enabled: false)
        let time = Date().addingTimeInterval(3600)
        #expect(first.mainBot.routineOperation(["operation": "create", "kind": "once", "at": ISO8601DateFormatter().string(from: time),
            "task": "Once: inspect once", "request_id": "restart"]))
        let restarted = helpers.makeWorkspace(fake)
        restarted.checkRoutines(now: time.addingTimeInterval(86400))
        await eventually { restarted.mainBot.messages.last?.role == .bot }
        restarted.checkRoutines(now: time.addingTimeInterval(172800))
        #expect(fake.agents.count == 1)
        #expect(fake.agents.flatMap(\.sent).filter { $0.contains("inspect once") }.count == 1)
        #expect(fake.agents.first?.launch.routinesURL == restarted.mainBot.profile.routinesURL)
        #expect(restarted.mainBot.scheduledRoutines.first?.state == .fired)
    }

    @Test func cancelledOnceCannotBeDispatchedByStaleWorkspaceSnapshot() throws {
        let helpers = RoutineTests(), fake = FakeLauncher()
        let workspace = helpers.makeWorkspace(fake)
        let time = Date().addingTimeInterval(3600)
        #expect(workspace.mainBot.routineOperation(["operation": "create", "kind": "once", "at": ISO8601DateFormatter().string(from: time),
            "task": "Once: cancelled", "request_id": "cancel"]))
        let job = try #require(workspace.mainBot.scheduledRoutines.first)
        let store = ScheduledRoutineStore(url: workspace.mainBot.profile.routinesURL.deletingLastPathComponent().appending(path: "scheduled-routines.json"))
        _ = try store.perform(["operation": "cancel", "id": job.id])
        workspace.mainBot.runScheduled(job, prompt: "must not run", at: time)
        #expect(fake.agents.isEmpty)
    }
    @Test func corruptStateStopsWorkspaceDispatchAndPreservesBytes() throws {
        let helpers = RoutineTests(), fake = FakeLauncher()
        let workspace = helpers.makeWorkspace(fake)
        let time = Date().addingTimeInterval(3600)
        #expect(workspace.mainBot.routineOperation(["operation": "create", "kind": "once", "at": ISO8601DateFormatter().string(from: time),
            "task": "Once: never dispatch corrupted state", "request_id": "corrupt"]))
        let url = workspace.mainBot.profile.routinesURL.deletingLastPathComponent().appending(path: "scheduled-routines.json")
        let corrupt = Data("corrupt".utf8)
        try corrupt.write(to: url)
        workspace.checkRoutines(now: time)
        #expect(fake.agents.isEmpty)
        #expect(workspace.mainBot.routineError?.contains("Preserve") == true)
        #expect(try Data(contentsOf: url) == corrupt)
    }

    @Test func launchFailureIsVisibleInChatAndTriggerIsNotRetried() throws {
        let helpers = RoutineTests()
        let workspace = Workspace(root: helpers.root.appending(path: "launch-failure")) { profile, store in
            Bot(profile: profile, launcher: { _ in throw CocoaError(.fileNoSuchFile) }, store: store)
        }
        workspace.mainBot.setRoutine(workspace.mainBot.routines[0].id, enabled: false)
        let time = Date().addingTimeInterval(3600)
        #expect(workspace.mainBot.routineOperation(["operation": "create", "kind": "once", "at": ISO8601DateFormatter().string(from: time),
            "task": "Once: launch fails", "request_id": "launch-failure"]))
        workspace.checkRoutines(now: time)
        workspace.checkRoutines(now: time.addingTimeInterval(86400))
        #expect(workspace.mainBot.messages.filter { $0.role == .error }.count == 1)
        #expect(workspace.mainBot.messages.filter { $0.role == .divider }.count == 1)
        #expect(workspace.mainBot.scheduledRoutines.first?.state == .fired)
    }

}
