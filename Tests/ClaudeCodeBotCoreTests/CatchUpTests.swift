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
            if workspace.catchUps[chat.id]?.phase != .loading { return }
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
        for index in 1...5 { _ = workspace.tell(chat, "behind the site \(index)") }
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
        for index in 1...4 { _ = workspace.tell(chat, "while away \(index)") }
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
}
