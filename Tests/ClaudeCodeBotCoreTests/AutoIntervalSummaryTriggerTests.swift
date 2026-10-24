import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The reported 2026-10-24 sequence, with message content and identities removed.
@MainActor
struct AutoIntervalSummaryTriggerTests {
    @Test func savedDefaultThresholdSummarizesThreeRepliesOnlyAtNextUser() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "auto-interval-report-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        func workspace() -> Workspace {
            Workspace(root: root) { profile, store in
                Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
            }
        }
        let initial = workspace()
        initial.setIntervalSummaryEnabled(true)
        initial.setCatchUpEnabled(false)
        initial.setSummaryThresholdsCustomized(false)
        let reloaded = workspace()
        #expect(reloaded.settings.intervalSummaryEnabled)
        #expect(reloaded.settings.intervalSummaryThresholdChoice == nil)
        #expect(reloaded.settings.intervalSummaryThreshold == 3)
        #expect(!reloaded.settings.catchUpEnabled)
        reloaded.catchUpSummarizer = { _ in { _ in ["summary"] } }
        let chat = reloaded.mainBot
        chat.post(ChatMessage(role: .user, text: "first"), unread: false)
        for role in [ChatMessage.Role.bot, .divider, .relay, .bot, .notice, .bot] {
            var message = ChatMessage(role: role, text: "source")
            if role == .bot { message.engine = .codex }
            chat.post(message, unread: false)
        }
        chat.post(ChatMessage(role: .user, text: "custom prompt request"), unread: false)
        let firstTask = try #require(reloaded.intervalSummaryTasks[chat.id]?.values.first)
        await firstTask.value
        #expect(reloaded.intervalSummaryViews(for: chat).count == 1)
        #expect(reloaded.intervalSummaryViews(for: chat).first?.count == 3)
        chat.post(ChatMessage(role: .bot, text: "acknowledgement"), unread: false)
        chat.post(ChatMessage(role: .user, text: "auto-summary report"), unread: false)
        #expect(reloaded.intervalSummaryViews(for: chat).count == 1)

        // A subsequent eligible interval still schedules, independently of unread state.
        let boundary = try #require(chat.messages.last)
        var source: [ChatMessage] = []
        for engine in [BotEngine.claude, .codex, .claude, .codex] {
            var reply = ChatMessage(role: .bot, text: "[result](file:///tmp/result.html)")
            reply.engine = engine
            source.append(reply)
            chat.post(reply, unread: false)
        }
        #expect(reloaded.intervalSummaryViews(for: chat).count == 1)
        let close = ChatMessage(role: .user, text: "next")
        chat.post(close, unread: false)
        let task = try #require(reloaded.intervalSummaryTasks[chat.id]?.values.first)
        reloaded.summarizeClosedInterval(in: chat, after: close)
        reloaded.summarizeInterval(in: chat, after: boundary.id)
        #expect(reloaded.intervalSummaryTasks[chat.id]?.count == 1)
        await task.value
        let view = try #require(reloaded.intervalSummaryViews(for: chat).last)
        #expect(view.state == "ready")
        #expect(view.automatic == true)
        #expect(view.ids == source.map { $0.id.uuidString })
        #expect(view.speakerCounts == ["claude": 2, "codex": 2])
        #expect(reloaded.intervalSummaryTasks[chat.id]?.isEmpty == true)
        #expect(chat.messages.filter { source.map(\.id).contains($0.id) } == source)
        #expect(reloaded.catchUps[chat.id] == nil)
        reloaded.summarizeClosedInterval(in: chat, after: close)
        #expect(reloaded.intervalSummaryTasks[chat.id]?.isEmpty == true)
        #expect(reloaded.intervalSummaryViews(for: chat).count == 2)
    }

    @Test(arguments: [1, 3, 5])
    func inclusiveThresholdSurvivesReloadAndTriggersOnceAtPersistedBoundary(threshold: Int) async throws {
        for count in (threshold - 1)...(threshold + 1) {
            let root = FileManager.default.temporaryDirectory.appending(path: "auto-inclusive-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            func workspace() -> Workspace {
                Workspace(root: root) { profile, store in
                    Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
                }
            }
            let initial = workspace()
            initial.setIntervalSummaryEnabled(true)
            initial.setIntervalSummaryThreshold(threshold)
            initial.setCatchUpEnabled(false)
            initial.setCatchUpThreshold(8)
            let reloaded = workspace()
            #expect(reloaded.settings.intervalSummaryThresholdChoice == threshold)
            #expect(reloaded.settings.intervalSummaryThreshold == threshold)
            #expect(reloaded.settings.catchUpThreshold == 8)
            #expect(!reloaded.settings.catchUpEnabled)
            let calls = SummaryTriggerCalls()
            reloaded.catchUpSummarizer = { _ in { _ in calls.record(); return ["summary"] } }
            let chat = reloaded.mainBot
            let opening = ChatMessage(role: .user, text: "opening")
            chat.post(opening, unread: false)
            var source: [ChatMessage] = []
            for index in 0..<count {
                var reply = ChatMessage(role: .bot, text: "[original](file:///tmp/result.html) \(index)")
                reply.engine = index.isMultiple(of: 2) ? .claude : .codex
                source.append(reply)
                chat.post(reply, unread: false)
            }
            for role in [ChatMessage.Role.notice, .relay, .error, .divider] {
                let metadata = ChatMessage(role: role, text: "[source](file:///tmp/metadata.html)")
                source.append(metadata)
                chat.post(metadata, unread: false)
            }
            #expect(reloaded.intervalSummaryViews(for: chat).isEmpty)
            #expect(calls.count == 0)
            let closing = ChatMessage(role: .user, text: "closing")
            chat.post(closing, unread: false)
            if count < threshold {
                #expect(reloaded.intervalSummaryViews(for: chat).isEmpty)
                #expect(reloaded.intervalSummaryTasks[chat.id] == nil)
                #expect(calls.count == 0)
                continue
            }
            let task = try #require(reloaded.intervalSummaryTasks[chat.id]?.values.first)
            reloaded.summarizeClosedInterval(in: chat, after: closing)
            reloaded.summarizeInterval(in: chat, after: opening.id)
            #expect(reloaded.intervalSummaryTasks[chat.id]?.count == 1)
            await task.value
            #expect(calls.count == 1)
            let view = try #require(reloaded.intervalSummaryViews(for: chat).first)
            #expect(view.state == "ready")
            #expect(view.automatic == true)
            #expect(view.count == count)
            #expect(view.ids == source.map { $0.id.uuidString })
            #expect(chat.messages == [opening] + source + [closing])
            #expect(reloaded.catchUps[chat.id] == nil)
            #expect(reloaded.intervalSummaryTasks[chat.id]?.isEmpty == true)
            reloaded.summarizeInterval(in: chat, after: opening.id)
            reloaded.summarizeClosedInterval(in: chat, after: closing)
            #expect(reloaded.intervalSummaryViews(for: chat).count == 1)
            #expect(reloaded.intervalSummaryTasks[chat.id]?.isEmpty == true)
            #expect(calls.count == 1)
        }
    }
}

private final class SummaryTriggerCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded = 0
    var count: Int { lock.withLock { recorded } }
    func record() { lock.withLock { recorded += 1 } }
}
