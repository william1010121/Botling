import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The reported 2026-10-24 sequence, with message content and identities removed.
@MainActor
struct AutoIntervalSummaryTriggerTests {
    @Test func savedDefaultThresholdDoesNotSummarizeThreeRepliesAtNextUser() async throws {
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
        #expect(reloaded.intervalSummaryViews(for: chat).isEmpty)
        chat.post(ChatMessage(role: .bot, text: "acknowledgement"), unread: false)
        chat.post(ChatMessage(role: .user, text: "auto-summary report"), unread: false)
        #expect(reloaded.intervalSummaryViews(for: chat).isEmpty)

        // A subsequent eligible interval still schedules, independently of unread state.
        let boundary = try #require(chat.messages.last)
        var source: [ChatMessage] = []
        for engine in [BotEngine.claude, .codex, .claude, .codex] {
            var reply = ChatMessage(role: .bot, text: "[result](file:///tmp/result.html)")
            reply.engine = engine
            source.append(reply)
            chat.post(reply, unread: false)
        }
        #expect(reloaded.intervalSummaryViews(for: chat).isEmpty)
        let close = ChatMessage(role: .user, text: "next")
        chat.post(close, unread: false)
        let task = try #require(reloaded.intervalSummaryTasks[chat.id]?.values.first)
        reloaded.summarizeClosedInterval(in: chat, after: close)
        reloaded.summarizeInterval(in: chat, after: boundary.id)
        #expect(reloaded.intervalSummaryTasks[chat.id]?.count == 1)
        await task.value
        let view = try #require(reloaded.intervalSummaryViews(for: chat).first)
        #expect(view.state == "ready")
        #expect(view.automatic == true)
        #expect(view.ids == source.map { $0.id.uuidString })
        #expect(view.speakerCounts == ["claude": 2, "codex": 2])
        #expect(reloaded.intervalSummaryTasks[chat.id]?.isEmpty == true)
        #expect(chat.messages.filter { source.map(\.id).contains($0.id) } == source)
        #expect(reloaded.catchUps[chat.id] == nil)
        reloaded.summarizeClosedInterval(in: chat, after: close)
        #expect(reloaded.intervalSummaryTasks[chat.id]?.isEmpty == true)
        #expect(reloaded.intervalSummaryViews(for: chat).count == 1)
    }
}
