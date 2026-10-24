import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Records the prompts a fake summary model was given, and answers with fixed bullets.
private final class FakeSummaries: @unchecked Sendable {
    private let lock = NSLock()
    private var _prompts: [String] = []
    private var _models: [String] = []
    var failure: Error?
    var bullets = ["Garden finished the build", "Two tests still fail"]

    var prompts: [String] { lock.withLock { _prompts } }
    var models: [String] { lock.withLock { _models } }

    var summarizer: (String) -> CatchUp.Summarizer {
        { [self] model in
            { prompt in
                self.lock.withLock {
                    self._prompts.append(prompt)
                    self._models.append(model)
                }
                if let failure = self.failure { throw failure }
                return self.bullets
            }
        }
    }
}

private struct SummaryDown: Error, LocalizedError {
    var errorDescription: String? { "model offline" }
}

@MainActor
struct CatchUpTests {
    private func makeWorkspace(_ root: URL) -> Workspace {
        Workspace(root: root) { profile, store in Bot(profile: profile, launcher: FakeLauncher().launcher, store: store) }
    }

    private func tempRoot(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appending(path: "ccb-catchup-\(name)-\(UUID().uuidString)")
    }

    private func project(in workspace: Workspace, root: URL) throws -> (Workspace.Project, Bot) {
        let folder = root.appending(path: "garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder, select: false)
        return (project, try #require(workspace.bot(for: project)))
    }

    /// Waits for the summary task the workspace started.
    private func settle(_ workspace: Workspace, _ chat: Bot) async {
        for _ in 0..<200 {
            if workspace.catchUps[chat.id]?.phase != .loading && !(workspace.intervalSummaries[chat.id]?.values.contains { $0.phase == .loading } ?? false) { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    // MARK: Settings

    @Test func settingsDefaultOnThreeAndJudgeModelAndSurviveReload() throws {
        let old = try JSONDecoder().decode(AppSettings.self, from: Data("{\"developerMode\":false}".utf8))
        #expect(old.catchUpEnabled)
        #expect(old.catchUpThreshold == 3)
        #expect(old.catchUpModel == PromiseCheck.judgeModel)
        #expect(SettingsSection.matching("Catch-up summary", in: SettingsSection.allCases) == [.general])

        let root = tempRoot("settings")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        workspace.setCatchUpEnabled(false)
        workspace.setCatchUpThreshold(7)
        let medium = CodexModel(id: "gpt-test", name: "GPT Test", isDefault: false, supportedReasoningEfforts: ["low", "medium"])
        let noMedium = CodexModel(id: "gpt-fast", name: "Fast", isDefault: false, supportedReasoningEfforts: ["low"])
        #expect(workspace.setCatchUpModel(medium))
        #expect(!workspace.setCatchUpModel(noMedium))
        let reloaded = makeWorkspace(root).settings
        #expect(!reloaded.catchUpEnabled)
        #expect(reloaded.catchUpThreshold == 7)
        #expect(reloaded.catchUpModel == "gpt-test")
        // Out-of-range thresholds are clamped.
        workspace.setCatchUpThreshold(0)
        #expect(workspace.settings.catchUpThreshold == CatchUp.thresholdRange.lowerBound)
        workspace.setCatchUpThreshold(10_000)
        #expect(workspace.settings.catchUpThreshold == CatchUp.thresholdRange.upperBound)
        // The completion verification model is untouched.
        #expect(workspace.settings.completionVerificationModel == PromiseCheck.judgeModel)
    }

    // MARK: Which messages are unread

    @Test func unreadMessagesAreTheLastRepliesTheCounterCounted() {
        let messages = [
            ChatMessage(role: .bot, text: "old"),
            ChatMessage(role: .user, text: "do it"),
            ChatMessage(role: .bot, text: "one"),
            ChatMessage(role: .notice, text: "two"),
            ChatMessage(role: .divider, text: ""),
            ChatMessage(role: .error, text: "three"),
        ]
        let unread = CatchUp.unreadMessages(in: messages, unread: 3)
        #expect(unread.map(\.text) == ["one", "two", "", "three"])
        #expect(CatchUp.unreadMessages(in: messages, unread: 0).isEmpty)
        // A counter larger than the chat takes everything from the first reply.
        #expect(CatchUp.unreadMessages(in: messages, unread: 50).first?.text == "old")
    }

    @Test func promptCarriesTheMessagesTheLanguageAndTreatsThemAsData() {
        let messages = [ChatMessage(role: .bot, text: "Build passed"), ChatMessage(role: .error, text: "Disk full")]
        let prompt = CatchUp.prompt(for: messages, language: .traditionalChinese) { $0.role == .bot ? "Garden" : "Botling" }
        #expect(prompt.contains("Garden: Build passed"))
        #expect(prompt.contains("Botling: Disk full"))
        #expect(CatchUp.instructions(language: .traditionalChinese).contains("Traditional Chinese"))
        // Very long messages are cut so one reply cannot blow up the call.
        let long = CatchUp.prompt(for: [ChatMessage(role: .bot, text: String(repeating: "a", count: 50_000))], language: .english) { _ in "Bot" }
        #expect(long.count < CatchUp.promptLimit + 200)
    }

    @Test func codexCallUsesTheChosenModelAtMediumEffortReadOnlyAndEphemeral() {
        let folder = URL(filePath: "/tmp/catchup")
        let arguments = CatchUp.arguments(prompt: "hello", folder: folder, model: "gpt-test", language: .japanese)
        #expect(arguments.first == "exec")
        #expect(arguments.contains("--ephemeral"))
        #expect(arguments.contains("--ignore-user-config"))
        let sandbox = arguments.firstIndex(of: "--sandbox").map { arguments[$0 + 1] }
        #expect(sandbox == "read-only")
        let model = arguments.firstIndex(of: "--model").map { arguments[$0 + 1] }
        #expect(model == "gpt-test")
        #expect(arguments.contains(#"model_reasoning_effort="medium""#))
        #expect(arguments.contains("shell_tool"))
        #expect(arguments.last?.contains("hello") == true)
    }

    @Test func bulletsAreParsedTrimmedAndCappedAtFive() throws {
        let json = #"{"bullets":[" a ","","b","c","d","e","f"]}"#
        #expect(try CatchUp.parseBullets(json) == ["a", "b", "c", "d", "e"])
        #expect(throws: (any Error).self) { try CatchUp.parseBullets(#"{"bullets":[]}"#) }
        #expect(throws: (any Error).self) { try CatchUp.parseBullets("not json") }
    }

    // MARK: Opening a chat

    @Test func openingAChatWithMoreThanKUnreadGroupsThemAndSummarizesWithoutTouchingTheChat() async throws {
        let root = tempRoot("open")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let (project, garden) = try project(in: workspace, root: root)
        garden.post(ChatMessage(role: .user, text: "earlier, read"), unread: false)
        for index in 1...5 { garden.post(ChatMessage(role: .bot, text: "update \(index)")) }
        #expect(garden.unreadCount == 5)
        let before = garden.messages

        workspace.select(project.id)
        #expect(garden.unreadCount == 0)
        let state = try #require(workspace.catchUps[garden.id])
        #expect(state.messageIDs == garden.messages.suffix(5).map(\.id))
        await settle(workspace, garden)
        let ready = try #require(workspace.catchUps[garden.id])
        #expect(ready.phase == .ready)
        #expect(ready.bullets == fake.bullets)
        #expect(fake.models == [PromiseCheck.judgeModel])
        #expect(fake.prompts.count == 1)
        #expect(fake.prompts[0].contains("update 5"))
        #expect(!fake.prompts[0].contains("earlier, read"))
        // UI only: the chat, its archive and the bot's processes never see the summary.
        #expect(garden.messages == before)
        #expect(!garden.isWorking)
        for file in FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap({ $0 as? URL }) ?? []
            where file.lastPathComponent != CatchUpCache.fileName && !file.hasDirectoryPath {
            let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            #expect(!text.contains("Garden finished the build"), "summary leaked into \(file.path)")
        }

        // The payload carries the group for the page.
        let view = try #require(workspace.catchUpView(for: garden))
        #expect(view.ids == ready.messageIDs.map(\.uuidString))
        #expect(view.state == "ready")
        let json = ChatPayload.make(bot: garden, components: nil, pending: [], replyingTo: nil, catchUp: view) { _ in "a" }.json()
        #expect(json.contains("\"catchUp\""))
        #expect(json.contains("Two tests still fail"))

        // A message arriving while you look is read at once and not collapsed.
        _ = workspace.tell(garden, "new while viewing")
        #expect(garden.unreadCount == 0)
        #expect(workspace.catchUps[garden.id]?.messageIDs.contains(garden.messages.last!.id) == false)
    }

    @Test func atOrBelowThresholdOrTurnedOffNothingIsGrouped() async throws {
        let root = tempRoot("threshold")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let (project, garden) = try project(in: workspace, root: root)
        for index in 1...3 { garden.post(ChatMessage(role: .bot, text: "u\(index)")) }
        workspace.select(project.id)
        #expect(workspace.catchUps[garden.id] == nil)
        #expect(garden.unreadCount == 0)

        workspace.select(nil)
        workspace.setCatchUpEnabled(false)
        for index in 1...6 { garden.post(ChatMessage(role: .bot, text: "v\(index)")) }
        workspace.select(project.id)
        #expect(workspace.catchUps[garden.id] == nil)
        #expect(garden.unreadCount == 0)
        #expect(fake.prompts.isEmpty)
    }

    @Test func aFailedSummaryStillGroupsWithAShortError() async throws {
        let root = tempRoot("failure")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        fake.failure = SummaryDown()
        workspace.catchUpSummarizer = fake.summarizer
        let (project, garden) = try project(in: workspace, root: root)
        for index in 1...4 { garden.post(ChatMessage(role: .bot, text: "u\(index)")) }
        workspace.select(project.id)
        await settle(workspace, garden)
        let state = try #require(workspace.catchUps[garden.id])
        #expect(state.phase == .failed)
        #expect(state.messageIDs.count == 4)
        #expect(state.error == "model offline")
        #expect(workspace.catchUpView(for: garden)?.state == "failed")
    }

    @Test func retryAfterAFailureSummarizesTheSameRangeWithTheCurrentModel() async throws {
        let root = tempRoot("retry")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        fake.failure = SummaryDown()
        workspace.catchUpSummarizer = fake.summarizer
        let (project, garden) = try project(in: workspace, root: root)
        for index in 1...4 { garden.post(ChatMessage(role: .bot, text: "u\(index)")) }
        workspace.select(project.id)
        await settle(workspace, garden)
        let failed = try #require(workspace.catchUps[garden.id])
        #expect(failed.phase == .failed)

        // Retry is only for a failed group: a ready one is left alone.
        fake.failure = nil
        let medium = CodexModel(id: "gpt-retry", name: "Retry", isDefault: false, supportedReasoningEfforts: ["medium"])
        #expect(workspace.setCatchUpModel(medium))
        workspace.retryCatchUp(in: garden)
        #expect(workspace.catchUps[garden.id]?.phase == .loading)
        #expect(workspace.catchUps[garden.id]?.error == nil)
        await settle(workspace, garden)
        let ready = try #require(workspace.catchUps[garden.id])
        #expect(ready.phase == .ready)
        #expect(ready.key == failed.key)
        #expect(ready.messageIDs == failed.messageIDs)
        #expect(ready.model == "gpt-retry")
        #expect(fake.models == [PromiseCheck.judgeModel, "gpt-retry"])
        workspace.retryCatchUp(in: garden)
        #expect(fake.prompts.count == 2)
    }

    @Test func aWebSiteSelectionIsNoChatSoTheMainBotStaysUnread() throws {
        let root = tempRoot("website")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let chat = workspace.mainBot
        let site = try #require(WebSite.all.first)
        workspace.select(site.selectionID)
        #expect(workspace.selectedBot === chat)
        #expect(!workspace.isViewing(chat))
        for index in 1...5 { chat.post(ChatMessage(role: .bot, text: "behind the site \(index)")) }
        #expect(chat.unreadCount == 5)
        #expect(workspace.catchUps[chat.id] == nil)

        // Back to the main chat: the unread lines fold into a group.
        workspace.select(nil)
        #expect(workspace.isViewing(chat))
        #expect(chat.unreadCount == 0)
        #expect(workspace.catchUps[chat.id]?.messageIDs.count == 5)
    }

    @Test func theSameRangeIsSummarizedOnceEvenAfterARelaunch() async throws {
        let root = tempRoot("cache")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeSummaries()
        let workspace = makeWorkspace(root)
        workspace.catchUpSummarizer = fake.summarizer
        let (project, garden) = try project(in: workspace, root: root)
        for index in 1...4 { garden.post(ChatMessage(role: .bot, text: "u\(index)")) }
        workspace.startCatchUp(for: garden, unread: 4)
        await settle(workspace, garden)
        workspace.startCatchUp(for: garden, unread: 4)
        #expect(workspace.catchUps[garden.id]?.phase == .ready)
        #expect(fake.prompts.count == 1)

        let again = makeWorkspace(root)
        again.catchUpSummarizer = fake.summarizer
        let gardenAgain = try #require(again.bot(for: project))
        again.startCatchUp(for: gardenAgain, unread: 4)
        #expect(again.catchUps[gardenAgain.id]?.phase == .ready)
        #expect(again.catchUps[gardenAgain.id]?.bullets == fake.bullets)
        #expect(fake.prompts.count == 1)
    }

    // MARK: Window focus

    @Test func messagesStayUnreadWhileTheWindowIsAwayAndGroupOnReturn() async throws {
        let root = tempRoot("focus")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let chat = workspace.mainBot
        workspace.setWindowFocused(false)
        for index in 1...4 { chat.post(ChatMessage(role: .bot, text: "while away \(index)")) }
        #expect(chat.unreadCount == 4)
        workspace.setWindowFocused(true)
        #expect(chat.unreadCount == 0)
        let state = try #require(workspace.catchUps[chat.id])
        #expect(state.messageIDs.count == 4)
        await settle(workspace, chat)
        #expect(workspace.catchUps[chat.id]?.phase == .ready)

        // Focused again: new lines are read at once, and the earlier group stays as it was.
        _ = workspace.tell(chat, "seen right away")
        #expect(chat.unreadCount == 0)
        #expect(workspace.catchUps[chat.id]?.messageIDs.count == 4)
    }

    @Test func manualSummaryIgnoresAutomaticSettingsAndUsesWholeOpenInterval() async throws {
        let root = tempRoot("manual")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.setCatchUpEnabled(false)
        workspace.setCatchUpThreshold(50)
        let chat = workspace.mainBot
        workspace.manuallyCatchUp(in: chat)
        #expect(workspace.catchUps[chat.id] == nil)
        chat.post(ChatMessage(role: .user, text: "first question"), unread: false)
        for index in 1...24 { chat.post(ChatMessage(role: .bot, text: "reply \(index)"), unread: false) }
        let before = chat.messages
        workspace.manuallyCatchUp(in: chat)
        let loading = try #require(workspace.catchUps[chat.id])
        #expect(loading.phase == .loading)
        #expect(loading.manual)
        #expect(loading.messageIDs == before.dropFirst().map(\.id))
        workspace.manuallyCatchUp(in: chat) // A double-click cannot launch another call.
        await settle(workspace, chat)
        #expect(fake.prompts.count == 1)
        #expect(workspace.catchUpView(for: chat)?.manual == true)
        #expect(workspace.catchUps[chat.id]?.phase == .ready)
        #expect(chat.messages == before)
        #expect(!chat.isWorking)
    }

    @Test func manualSummaryIgnoresUnreadStatusAndRetriesItsFrozenInterval() async throws {
        let root = tempRoot("manual-unread")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        fake.failure = SummaryDown()
        workspace.catchUpSummarizer = fake.summarizer
        let chat = workspace.mainBot
        chat.post(ChatMessage(role: .user, text: "question"), unread: false)
        chat.post(ChatMessage(role: .bot, text: "read"), unread: false)
        chat.post(ChatMessage(role: .bot, text: "unread"))
        workspace.manuallyCatchUp(in: chat)
        await settle(workspace, chat)
        let failed = try #require(workspace.catchUps[chat.id])
        #expect(failed.phase == .failed)
        #expect(failed.messageIDs == chat.messages.dropFirst().map(\.id))
        #expect(chat.unreadCount == 1)
        chat.post(ChatMessage(role: .bot, text: "later"))
        fake.failure = nil
        workspace.retryCatchUp(in: chat)
        await settle(workspace, chat)
        #expect(workspace.catchUps[chat.id]?.phase == .ready)
        #expect(workspace.catchUps[chat.id]?.messageIDs == failed.messageIDs)
        #expect(!fake.prompts.last!.contains("later"))
    }

    @Test func manualUnavailableServiceFailsClearlyForAnOpenInterval() async throws {
        let root = tempRoot("manual-unavailable")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let chat = workspace.mainBot
        chat.post(ChatMessage(role: .user, text: "question"), unread: false)
        chat.post(ChatMessage(role: .bot, text: "answer"), unread: false)
        workspace.manuallyCatchUp(in: chat)
        #expect(workspace.catchUps[chat.id]?.phase == .failed)
        #expect(workspace.catchUps[chat.id]?.error?.isEmpty == false)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.retryCatchUp(in: chat)
        await settle(workspace, chat)
        #expect(workspace.catchUps[chat.id]?.phase == .ready)
        #expect(fake.prompts.first?.contains("answer") == true)
    }
    @Test func manualUsesOnlyLatestClosedUserIntervalAndLeavesBoundariesVisible() async throws {
        let root = tempRoot("closed-interval")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let chat = workspace.mainBot
        let first = ChatMessage(role: .user, text: "first boundary")
        let reply = ChatMessage(role: .bot, text: "inside interval")
        let notice = ChatMessage(role: .notice, text: "source [report](file:///tmp/interval.html)")
        let second = ChatMessage(role: .user, text: "second boundary")
        for line in [ChatMessage(role: .bot, text: "unrelated old"), first, reply, notice, second,
                     ChatMessage(role: .bot, text: "still open")] { chat.post(line, unread: false) }
        let before = chat.messages
        workspace.manuallyCatchUp(in: chat)
        await settle(workspace, chat)
        #expect(workspace.catchUps[chat.id]?.messageIDs == [reply.id, notice.id])
        #expect(fake.prompts.first?.contains("unrelated old") == false)
        #expect(fake.prompts.first?.contains("still open") == false)
        #expect(chat.messages == before)
    }

    @Test func emptyClosedIntervalNeverFallsBackToUnrelatedReplies() async throws {
        let root = tempRoot("empty-interval")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let chat = workspace.mainBot
        for line in [ChatMessage(role: .bot, text: "old"), ChatMessage(role: .user, text: "one"),
                     ChatMessage(role: .user, text: "two")] { chat.post(line, unread: false) }
        workspace.manuallyCatchUp(in: chat)
        await settle(workspace, chat)
        #expect(workspace.catchUps[chat.id] == nil)
        #expect(fake.prompts.isEmpty)
    }

    @Test func intervalSettingsAreOptInSeparateAndPreserveLegacyChoices() throws {
        let legacy = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"developerMode":false,"catchUpEnabledChoice":false,"catchUpThresholdChoice":7,"catchUpModelChoice":"saved-model"}"#.utf8))
        #expect(!legacy.catchUpEnabled)
        #expect(!legacy.intervalSummaryEnabled)
        #expect(legacy.catchUpThreshold == 7)
        #expect(legacy.intervalSummaryThreshold == 3)
        #expect(legacy.summaryThresholdsCustomized)
        #expect(legacy.catchUpModel == "saved-model")
        let root = tempRoot("interval-settings")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        #expect(!workspace.settings.intervalSummaryEnabled)
        #expect(!workspace.settings.summaryThresholdsCustomized)
        workspace.setSummaryThresholdsCustomized(true)
        workspace.setCatchUpEnabled(false)
        workspace.setIntervalSummaryEnabled(true)
        workspace.setCatchUpThreshold(8)
        workspace.setIntervalSummaryThreshold(5)
        let saved = makeWorkspace(root).settings
        #expect(!saved.catchUpEnabled && saved.intervalSummaryEnabled)
        #expect(saved.catchUpThreshold == 8 && saved.intervalSummaryThreshold == 5)
        #expect(saved.summaryThresholdsCustomized)
        workspace.setSummaryThresholdsCustomized(false)
        let defaults = makeWorkspace(root).settings
        #expect(defaults.catchUpThreshold == 3 && defaults.intervalSummaryThreshold == 3)
        #expect(!defaults.summaryThresholdsCustomized)
        #expect(!defaults.catchUpEnabled && defaults.intervalSummaryEnabled)
        #expect(SettingsSection.matching("Interval threshold", in: SettingsSection.allCases) == [.general])
    }

    @Test func intervalSelectionUsesTranscriptOrderAndNeedsAUserBoundary() {
        let old = ChatMessage(role: .bot, text: "old")
        let user = ChatMessage(role: .user, text: "first", date: Date(timeIntervalSince1970: 30))
        let reply = ChatMessage(role: .bot, text: "reply", date: Date(timeIntervalSince1970: 10))
        let next = ChatMessage(role: .user, text: "next", date: Date(timeIntervalSince1970: 20))
        #expect(CatchUp.intervalMessages(in: [old]).isEmpty)
        #expect(CatchUp.intervalMessages(in: [old, user]).isEmpty)
        #expect(CatchUp.intervalMessages(in: [old, user, reply]).map(\.id) == [reply.id])
        #expect(CatchUp.intervalMessages(in: [old, user, reply, next, old]).map(\.id) == [reply.id])
        #expect(CatchUp.intervalMessages(in: [user, ChatMessage(role: .divider, text: ""), next]).isEmpty)
    }

    @Test func automaticIntervalClosesOnlyOnPersistedUserAndCountsBothHeadsOnce() async throws {
        let root = tempRoot("auto-interval")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.setCatchUpEnabled(false)
        workspace.setIntervalSummaryEnabled(true)
        let chat = workspace.mainBot
        chat.post(ChatMessage(role: .user, text: "first"), unread: false)
        var source: [ChatMessage] = []
        for index in 0..<4 {
            var reply = ChatMessage(role: .bot, text: "reply \(index)")
            reply.engine = index.isMultiple(of: 2) ? .claude : .codex
            source.append(reply)
            chat.post(reply, unread: false)
        }
        let notice = ChatMessage(role: .notice, text: "[full source](file:///tmp/retained.html)")
        chat.post(notice, unread: false)
        source.append(notice)
        #expect(workspace.catchUps[chat.id] == nil) // Crossing k alone does nothing.
        let closing = ChatMessage(role: .user, text: "next")
        chat.post(closing, unread: false)
        let before = chat.messages
        await settle(workspace, chat)
        #expect(workspace.intervalSummaryViews(for: chat).first?.ids == source.map { $0.id.uuidString })
        #expect(workspace.intervalSummaryViews(for: chat).first?.speakerCounts == ["claude": 2, "codex": 2])
        #expect(fake.prompts.count == 1)
        workspace.summarizeClosedInterval(in: chat, after: closing)
        workspace.summarizeInterval(in: chat, after: chat.messages.first!.id) // Reuses the exact same interval/cache.
        await settle(workspace, chat)
        #expect(fake.prompts.count == 1)
        #expect(chat.messages == before)
        #expect(!chat.isWorking)
        let again = makeWorkspace(root)
        again.catchUpSummarizer = fake.summarizer
        again.summarizeInterval(in: again.mainBot, after: again.mainBot.messages.first!.id)
        #expect(again.intervalSummaryViews(for: again.mainBot).first?.state == "ready")
        #expect(fake.prompts.count == 1)
    }

    @Test func intervalThresholdIsStrictAndNoticesErrorsRelaysDoNotCount() async throws {
        let root = tempRoot("strict-interval")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.setIntervalSummaryEnabled(true)
        let chat = workspace.mainBot
        chat.post(ChatMessage(role: .user, text: "first"), unread: false)
        for index in 0..<3 { chat.post(ChatMessage(role: .bot, text: "reply \(index)"), unread: false) }
        for role in [ChatMessage.Role.notice, .error, .relay, .divider] {
            chat.post(ChatMessage(role: role, text: "metadata"), unread: false)
        }
        chat.post(ChatMessage(role: .user, text: "second"), unread: false)
        #expect(workspace.catchUps[chat.id] == nil)
        #expect(fake.prompts.isEmpty)
        workspace.setIntervalSummaryEnabled(false)
        for index in 0..<4 { chat.post(ChatMessage(role: .bot, text: "reply \(index)"), unread: false) }
        chat.post(ChatMessage(role: .user, text: "third"), unread: false)
        #expect(workspace.catchUps[chat.id] == nil)
        #expect(fake.prompts.isEmpty)
    }

    @Test func unreadThresholdCountsOnlyBotRepliesButRetainsOtherSources() async throws {
        let root = tempRoot("unread-count")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        let chat = workspace.mainBot
        workspace.setWindowFocused(false)
        for role in [ChatMessage.Role.bot, .notice, .relay, .error] {
            chat.post(ChatMessage(role: role, text: "unread source"))
        }
        workspace.setWindowFocused(true)
        #expect(fake.prompts.isEmpty)
        workspace.setWindowFocused(false)
        for index in 0..<4 { chat.post(ChatMessage(role: .bot, text: "bot \(index)")) }
        let notice = ChatMessage(role: .notice, text: "keep source")
        chat.post(notice)
        workspace.setWindowFocused(true)
        await settle(workspace, chat)
        #expect(workspace.catchUps[chat.id]?.messageIDs.contains(notice.id) == true)
        #expect(workspace.catchUpView(for: chat)?.count == 4)
        #expect(fake.prompts.count == 1)
    }

    @Test func groupUserPostsCloseIntervalsWithoutStartingAGroupRound() async throws {
        let root = tempRoot("group-interval")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.setIntervalSummaryEnabled(true)
        let group = try #require(workspace.createGroup(name: "Summary group", members: [Workspace.mainBotID]))
        let chat = try #require(workspace.groupChats[group.id])
        chat.post(ChatMessage(role: .user, text: "first"), unread: false)
        for index in 0..<4 { chat.post(ChatMessage(role: .bot, text: "group reply \(index)"), unread: false) }
        chat.post(ChatMessage(role: .user, text: "next"), unread: false)
        await settle(workspace, chat)
        #expect(fake.prompts.count == 1)
        #expect(workspace.intervalSummaryViews(for: chat).first?.ids.count == 4)
        #expect(!chat.isWorking)
    }

    @Test func onlyAnAcceptedPersistedUserSendClosesTheInterval() async throws {
        let root = tempRoot("accepted-send")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.setIntervalSummaryEnabled(true)
        let chat = workspace.mainBot
        chat.post(ChatMessage(role: .user, text: "first"), unread: false)
        for index in 0..<4 { chat.post(ChatMessage(role: .bot, text: "reply \(index)"), unread: false) }
        let question = ChatMessage(role: .notice, text: "decision", choices: [Choice(label: "OK")])
        chat.post(question, unread: false)
        chat.markChosen(0, in: question.id)
        await workspace.send("   ", to: chat)
        #expect(chat.messages.filter { $0.role == .user }.count == 1)
        #expect(fake.prompts.isEmpty)
        await workspace.send("accepted next message", to: chat)
        await settle(workspace, chat)
        #expect(chat.messages.filter { $0.role == .user }.count == 2)
        #expect(fake.prompts.count == 1)
        #expect(workspace.intervalSummaryViews(for: chat).first?.ids.count == 5)
    }

    @Test func historicalIntervalsRunIndependentlyAndRetryFrozenSources() async throws {
        let root = tempRoot("historical-targets")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        workspace.setCatchUpEnabled(false)
        let chat = workspace.mainBot
        let first = ChatMessage(role: .user, text: "old boundary")
        var old = ChatMessage(role: .bot, text: "OLD [old](file:///tmp/old.html)")
        old.engine = .codex
        let second = ChatMessage(role: .user, text: "new boundary")
        let latest = ChatMessage(role: .bot, text: "NEW unknown head")
        for message in [first, old, second, latest] { chat.post(message, unread: false) }
        workspace.catchUpSummarizer = { _ in { prompt in
            try await Task.sleep(for: .milliseconds(prompt.contains("OLD") ? 40 : 5))
            return [prompt.contains("OLD") ? "old result" : "new result"]
        } }
        workspace.summarizeInterval(in: chat, after: first.id)
        workspace.summarizeInterval(in: chat, after: second.id)
        #expect(workspace.intervalSummaries[chat.id]?.count == 2)
        await settle(workspace, chat)
        let views = workspace.intervalSummaryViews(for: chat)
        #expect(views.map(\.bullets) == [["old result"], ["new result"]])
        #expect(views.map(\.ids) == [[old.id.uuidString], [latest.id.uuidString]])
        #expect(views.last?.speakerCounts == ["unknown": 1])
        #expect(workspace.catchUps[chat.id] == nil)
        // A failed older range retries its frozen IDs while the latest continues to grow.
        let key = try #require(views.first?.key)
        workspace.intervalSummaries[chat.id]?[key]?.phase = .failed
        chat.post(ChatMessage(role: .bot, text: "NEW later source"), unread: false)
        workspace.retryIntervalSummary(in: chat, key: key)
        await settle(workspace, chat)
        #expect(workspace.intervalSummaryViews(for: chat).first?.ids == [old.id.uuidString])
        #expect(workspace.intervalSummaryViews(for: chat).first?.bullets == ["old result"])
        workspace.summarizeInterval(in: chat, after: second.id)
        await settle(workspace, chat)
        #expect(workspace.intervalSummaryViews(for: chat).count == 2)
        #expect(workspace.intervalSummaryViews(for: chat).last?.count == 2)
        #expect(chat.messages.filter { $0.role == .user }.count == 2)
    }

    @Test func manualOpenIntervalBecomesAutomaticWithoutReplacingUnreadState() async throws {
        let root = tempRoot("manual-auto-unread")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = makeWorkspace(root)
        let fake = FakeSummaries()
        workspace.catchUpSummarizer = fake.summarizer
        workspace.setCatchUpEnabled(false)
        workspace.setIntervalSummaryEnabled(true)
        workspace.setIntervalSummaryThreshold(1)
        let chat = workspace.mainBot
        let user = ChatMessage(role: .user, text: "source boundary")
        for message in [user, ChatMessage(role: .bot, text: "one"), ChatMessage(role: .bot, text: "two")] { chat.post(message, unread: false) }
        workspace.startCatchUp(for: chat, unread: 2)
        workspace.summarizeInterval(in: chat, after: user.id)
        await settle(workspace, chat)
        let unread = workspace.catchUps[chat.id]
        let calls = fake.prompts.count
        #expect(workspace.intervalSummaryViews(for: chat).first?.automatic == false)
        chat.post(ChatMessage(role: .user, text: "accepted next message"), unread: false)
        await settle(workspace, chat)
        #expect(workspace.intervalSummaryViews(for: chat).count == 1)
        #expect(workspace.intervalSummaryViews(for: chat).first?.automatic == true)
        #expect(workspace.catchUps[chat.id] == unread)
        #expect(fake.prompts.count == calls)
    }

}
