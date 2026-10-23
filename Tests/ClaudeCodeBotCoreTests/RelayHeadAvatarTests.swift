import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct RelayHeadAvatarTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-relay-head-\(UUID().uuidString)")

    func workspace() -> Workspace {
        Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
    }

    @Test func guestReplyAndOwnHistoryPersistActualEngine() async throws {
        for engine in BotEngine.allCases {
            let workspace = workspace()
            let guest = workspace.maintainer
            await guest.setHeads([engine])
            let member = try #require(workspace.everyMember.first { $0.id == Workspace.maintainerID })
            let text = "已接續原任務處理，會把需要 App 配合的部分交回 botling 專案接通，再完成卡片。"
            let id = try #require(await workspace.postGuestReply(text, steps: nil, from: member, bot: guest,
                into: workspace.mainBot, seen: true, policy: .init(passes: false, tagsAct: false)) { line in
                    guest.keepCallIn(asked: "@Maintainer", at: Date(), reply: line)
                })
            let line = try #require(workspace.mainBot.messages.first { $0.id == id })
            #expect(line.engine == engine)
            #expect(line.sourceID == Workspace.maintainerID)
            #expect(line.text == text)
            #expect(guest.messages.last?.engine == engine)
            let reloaded = BotStore(directory: root.appending(path: "main")).loadMessages()
            #expect(reloaded.first { $0.id == id }?.engine == engine)
        }
    }

    @Test func guestNameIncludesRecordedEngineEvenWhenHostHasAnotherEngine() throws {
        let workspace = workspace()
        var line = ChatMessage(role: .bot, text: "Guest reply", sourceID: Workspace.maintainerID)
        line.engine = .codex
        workspace.mainBot.post(line)
        let payload = ChatPayload.make(bot: workspace.mainBot, components: nil, pending: [], replyingTo: nil,
            callIn: workspace.callInView(for: workspace.mainBot)) { _ in "bot-icon" }
        #expect(payload.messages.last?.speaker == "Maintainer · Codex")
    }

    func look(_ hat: String) -> ChatPayload.HeadLook {
        ChatPayload.HeadLook(avatar: { "\(hat)-\($0.rawValue)" }, mark: { "mark-\($0.rawValue)" },
            animations: BotEngine.allCases.map { engine in
                ChibiAnimation.Head(engine: engine.rawValue, avatar: "\(hat)-\(engine.rawValue)", thinking: "think", sleeping: "sleep", hat: hat, clips: [])
            })
    }

    @Test func savedGuestsKeepTheirRecordedHeadAfterSourceEngineIsDisabled() async throws {
        let workspace = workspace()
        await workspace.mainBot.setHeads([.claude, .codex])
        var lines = BotEngine.allCases.map { engine in
            var line = ChatMessage(role: .bot, text: engine.rawValue, sourceID: Workspace.maintainerID, sourceMessageID: UUID())
            line.engine = engine
            line.seenBy = [.claude]
            line.reactions = [MessageReaction(emoji: "👍", actor: "user")]
            return line
        }
        lines.append(ChatMessage(role: .bot, text: "Legacy: engine unknown", sourceID: Workspace.maintainerID))
        for line in lines { workspace.mainBot.post(line) }
        let store = BotStore(directory: root.appending(path: "main"))
        let reloaded = store.loadMessages().filter { $0.role == .bot }
        #expect(reloaded == lines)
        await workspace.maintainer.setHeads([.claude])
        for heads: [BotEngine] in [[.claude], [.claude, .codex]] {
            store.save(heads: HeadsSettings(engines: heads))
            let reopened = Bot(profile: .main(home: root), launcher: FakeLauncher().launcher, store: store)
            let context = ChatPayload.GroupView(typing: nil) { _ in "Maintainer" }
            for cute in [true, false] {
                for group in [true, false] {
                    let payload = ChatPayload.make(bot: reopened, components: nil, pending: [], replyingTo: nil,
                        group: group ? context : nil, callIn: group ? nil : context,
                        look: cute ? look("host") : nil, sourceLook: { _ in cute ? look("purple") : nil }) { _ in "purple-bot" }
                    let replies = payload.messages.filter { $0.role == "bot" }
                    #expect(replies.map(\.avatar) == (cute ? ["purple-claude", "purple-codex", "purple-bot"] : ["purple-bot", "purple-bot", "purple-bot"]))
                    #expect(replies.map(\.speaker) == ["Maintainer · Claude", "Maintainer · Codex", "Maintainer"])
                    #expect(replies.map(\.id) == lines.map { $0.id.uuidString })
                    #expect(replies[0].reactions?.first?.emoji == "👍")
                    #expect(replies.map(\.text) == lines.map(\.text))
                    #expect(cute ? payload.animatedHeads?.contains { $0.avatar == "purple-codex" } == true : payload.animatedHeads == nil)
                }
            }
        }
    }

    @Test func liveGuestAvatarTracksItsProcessWhileKeepingItsBotHat() async throws {
        let workspace = workspace()
        await workspace.maintainer.setHeads([.codex])
        let context = ChatPayload.GroupView(typing: Workspace.maintainerID, working: workspace.maintainer) { _ in "Maintainer" }
        for group in [true, false] {
            let payload = ChatPayload.make(bot: workspace.mainBot, components: nil, pending: [], replyingTo: nil,
                group: group ? context : nil, callIn: group ? nil : context,
                look: look("green"), sourceLook: { _ in look("purple") }) { _ in "purple-bot" }
            #expect(payload.working)
            #expect(payload.avatar == "purple-codex")
            #expect(payload.animatedHeads?.contains { $0.avatar == payload.avatar } == true)
        }
    }

    @Test func removedBotKeepsKnownEngineAndUnknownEngineNeverUsesHostHead() {
        let workspace = workspace()
        var known = ChatMessage(role: .bot, text: "Known", sourceID: UUID())
        known.engine = .codex
        let unknown = ChatMessage(role: .bot, text: "Unknown", sourceID: UUID())
        workspace.mainBot.post(known)
        workspace.mainBot.post(unknown)
        let payload = ChatPayload.make(bot: workspace.mainBot, components: nil, pending: [], replyingTo: nil,
            callIn: ChatPayload.GroupView(typing: nil) { _ in nil }, look: look("host"), sourceLook: { _ in look("ghost") }) { _ in "ghost-bot" }
        #expect(payload.messages.map(\.avatar) == ["ghost-codex", "ghost-bot"])
        #expect(payload.messages.map(\.speaker) == ["A removed bot · Codex", "A removed bot"])
    }

    @Test func historyWithoutLiveCallInContextNeverBorrowsHostIdentity() {
        let workspace = workspace()
        var line = ChatMessage(role: .bot, text: "Historical guest", sourceID: UUID())
        line.engine = .codex
        workspace.mainBot.post(line)
        let payload = ChatPayload.make(bot: workspace.mainBot, components: nil, pending: [], replyingTo: nil,
            look: look("host"), sourceLook: { _ in look("guest") }) { _ in "guest-bot" }
        #expect(payload.messages.last?.avatar == "guest-codex")
        #expect(payload.messages.last?.speaker == "A removed bot · Codex")
    }
}
