import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Bot look Cute: Claude and Codex drawn as characters, with either or both engines enabled.
@MainActor
struct ChibiTests {
    let hat = Chibi.Hat(path: "M22.5 1.5 L41.5 1.5 L41.5 20.5 Z", color: "#2F86F6", eyes: [(29.3, 10.6), (34.7, 10.6)])

    @Test func everyHeadAndMoodIsWellFormedSVG() throws {
        for head in BotEngine.allCases {
            for mood in Chibi.Mood.allCases {
                for hat in [nil, hat] {
                    let svg = Chibi.svg(head, mood: mood, hat: hat)
                    let parser = XMLParser(data: Data(svg.utf8))
                    #expect(parser.parse(), "\(head) \(mood) hat: \(hat != nil)")
                    #expect(svg.contains("viewBox='0 0 64 64'"))
                }
            }
        }
    }

    @Test func everyStatusUsesDistinctBundledTransparentArt() throws {
        for head in BotEngine.allCases {
            var variants = Set<Data>()
            for mood in Chibi.Mood.allCases {
                let data = Chibi.assetData(head, mood: mood)
                #expect(Array(data.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10])
                // PNG IHDR color type 6 is RGBA: transparent hair and horns are retained.
                #expect(data[25] == 6)
                #expect(Chibi.svg(head, mood: mood).contains(data.base64EncodedString()))
                variants.insert(data)
            }
            #expect(variants.count == Chibi.Mood.allCases.count)
        }
        #expect(Chibi.assetData(.claude) != Chibi.assetData(.codex))
        #expect(Chibi.assetURL(.claude).path.contains("/claude/"))
        #expect(Chibi.assetURL(.codex).path.contains("/gpt/"))
    }

    @Test func theBotsFaceIsWornAsAHatOnlyWhenGiven() {
        let with = Chibi.svg(.claude, hat: hat)
        #expect(with.contains(hat.path))
        #expect(with.contains("fill='#2F86F6'"))
        #expect(!Chibi.svg(.claude).contains("#2F86F6"))
    }

    @Test func aHeadsMoodFollowsItsProcess() {
        #expect(Chibi.mood(asleep: true, working: false, waiting: false) == .sleep)
        #expect(Chibi.mood(asleep: true, working: true, waiting: true) == .sleep)
        #expect(Chibi.mood(asleep: false, working: true, waiting: true) == .think)
        #expect(Chibi.mood(asleep: false, working: true, waiting: false) == .work)
        #expect(Chibi.mood(asleep: false, working: false, waiting: false) == .normal)
    }

    @Test func theDataURLDecodesBackToTheSVG() {
        let svg = Chibi.svg(.codex, mood: .think, hat: hat)
        let url = Chibi.dataURL(svg)
        #expect(url.hasPrefix("data:image/svg+xml;charset=utf-8,"))
        #expect(!url.contains("#") && !url.contains("\"") && !url.contains("<"))
        #expect(url.dropFirst("data:image/svg+xml;charset=utf-8,".count).removingPercentEncoding == svg)
    }

    @Test func numbersAreShort() {
        #expect(Chibi.format(10) == "10")
        #expect(Chibi.format(10.5) == "10.5")
        #expect(Chibi.format(1.234) == "1.23")
    }

    @Test func cuteIsTheDefaultAndOriginalIsKept() throws {
        #expect(AppSettings().botLook == .cute)
        let old = try JSONDecoder().decode(AppSettings.self, from: Data("{\"developerMode\":false}".utf8))
        #expect(old.botLook == .cute)
        var settings = AppSettings()
        settings.botLookChoice = .original
        let again = try JSONDecoder().decode(AppSettings.self, from: JSONEncoder().encode(settings))
        #expect(again.botLook == .original)
    }

    @Test func settingTheLookSavesIt() {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-look-\(UUID().uuidString)")
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        #expect(workspace.settings.botLook == .cute)
        workspace.setBotLook(.original)
        #expect(workspace.settings.botLook == .original)
        #expect(AppSettings.load(from: workspace.settingsURL).botLook == .original)
    }

    func bot(heads: [BotEngine], messages: [ChatMessage]) -> Bot {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-look-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        store.save(heads: HeadsSettings(engines: heads))
        store.save(messages: messages)
        return Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
    }

    func twoHeaded() -> Bot {
        var mine = ChatMessage(role: .user, text: "Fix it")
        mine.seenBy = [.claude]
        var claude = ChatMessage(role: .bot, text: "On it")
        claude.engine = .claude
        var codex = ChatMessage(role: .bot, text: "Reviewing")
        codex.engine = .codex
        var fromSubagent = ChatMessage(role: .bot, text: "Found it")
        fromSubagent.engine = .codex
        fromSubagent.subagentID = "s1"
        return bot(heads: [.claude, .codex], messages: [mine, claude, codex, fromSubagent])
    }

    let look = ChatPayload.HeadLook(avatar: { "hat-\($0.rawValue)" }, mark: { "mark-\($0.rawValue)" })

    @Test func cuteRepliesShowTheirHeadAndMarksShowTinyHeads() {
        let bot = twoHeaded()
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "own" }
        #expect(payload.messages.map(\.avatar) == [nil, "hat-claude", "hat-codex", "own"])
        #expect(payload.seenHeads == ["C": "mark-claude", "X": "mark-codex"])
        // The marks themselves are unchanged: the page draws them as heads.
        #expect(payload.messages[0].seen?.map(\.seen) == [true, false])
    }

    @Test func userRecipientsStayIndependentOfWhoLaterReadsTheMessage() throws {
        let targets: [AnswerTarget?] = [.claude, .codex, .both, nil]
        let receipts: [[BotEngine]] = [[], [.claude], [.codex], [.claude, .codex]]
        for target in targets {
            for reached in receipts {
                var message = ChatMessage(role: .user, text: "Take this one")
                message.to = target
                message.seenBy = reached
                let bot = bot(heads: [.claude, .codex], messages: [message])
                // A later composer selection cannot rewrite this message's recipients.
                bot.setAnswerWith(target == .claude ? .codex : .claude)
                let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "own" }
                let json = try #require(JSONSerialization.jsonObject(with: Data(payload.json().utf8)) as? [String: Any])
                let messages = try #require(json["messages"] as? [[String: Any]])
                let heads = try #require(messages.first?["seen"] as? [[String: Any]])
                #expect(heads.map { $0["recipient"] as? Bool } == [target != .codex, target != .claude])
                #expect(heads.map { $0["seen"] as? Bool } == [reached.contains(.claude), reached.contains(.codex)])
            }
        }
        let replyBot = twoHeaded()
        let reply = try #require(replyBot.messages.first { $0.role == .bot })
        let marks = try #require(ChatPayload.seenMarks(reply, in: replyBot))
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(marks)) as? [[String: Any]])
        #expect(encoded.allSatisfy { $0["recipient"] == nil })
    }

    @Test func originalKeepsTheBotsFaceAndLetters() {
        let bot = twoHeaded()
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "own" }
        #expect(payload.messages.map(\.avatar) == [nil, "own", "own", "own"])
        #expect(payload.seenHeads == nil)
    }

    @Test func singleEngineRepliesWearTheirOwnCharacter() {
        for head in BotEngine.allCases {
            var reply = ChatMessage(role: .bot, text: "Hi")
            reply.engine = head
            var subagent = ChatMessage(role: .bot, text: "Subagent reply")
            subagent.engine = head
            subagent.subagentID = "s1"
            let bot = bot(heads: [head], messages: [reply, subagent])
            let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "own" }
            #expect(payload.messages.map(\.avatar) == ["hat-\(head.rawValue)", "own"])
            #expect(payload.messages.allSatisfy { $0.seen == nil })
        }
    }

    @Test func liveSingleEngineWorkUsesItsCharacter() async throws {
        for head in BotEngine.allCases {
            let fake = FakeLauncher()
            fake.respond = { _ in nil }
            let bot = makeBot(fake)
            await bot.switchEngine(to: head)
            bot.send("Look into it")
            await eventually { fake.agents.count == 1 && bot.isWorking }
            let agent = try #require(fake.agents.first)
            agent.emit(.trace(.text("Checking the toolbar.", parent: nil)))
            await eventually { !bot.liveSteps.isEmpty }
            let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "own" }
            #expect(payload.working)
            #expect(payload.avatar == "hat-\(head.rawValue)")
            #expect(payload.live.map(\.title).contains("Checking the toolbar."))
            let original = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "own" }
            #expect(original.avatar == "own")
            agent.reply("Done.")
        }
    }

    @Test func livePartnerAvatarFollowsTheProcessWhoseStepsAreShown() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.send("Review it", to: .codex)
        await eventually { bot.partner?.isWorking == true && fake.agents.count == 1 }
        let agent = try #require(fake.agents.first)
        agent.emit(.trace(.text("Codex is reviewing.", parent: nil)))
        await eventually { bot.partner?.liveSteps.isEmpty == false }
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "own" }
        #expect(!bot.isWorking)
        #expect(payload.avatar == "hat-codex")
        #expect(payload.live.map(\.title).contains("Codex is reviewing."))
        // A pending call-in does not take the face away from the partner's live steps.
        let guest = UUID()
        let callIn = ChatPayload.GroupView(typing: guest) { _ in "Guest" }
        let alongsideGuest = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, callIn: callIn, look: look) { $0 == guest ? "guest" : "own" }
        #expect(alongsideGuest.avatar == "hat-codex")
        #expect(alongsideGuest.live == payload.live)
        agent.reply("Reviewed.")
    }

    @Test func groupAndCalledInSpeakersKeepTheirOwnFaces() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("Check it")
        await eventually { fake.agents.count == 1 && bot.isWorking }
        let guest = UUID()
        let context = ChatPayload.GroupView(typing: guest, working: bot) { _ in "Guest" }
        let group = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, group: context, look: look) { $0 == guest ? "guest" : "own" }
        #expect(group.avatar == "guest")
        #expect(group.seenHeads == nil)
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-look-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var reply = ChatMessage(role: .bot, text: "Guest reply", sourceID: guest)
        reply.engine = .codex
        store.save(messages: [reply])
        let host = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        let calledIn = ChatPayload.make(bot: host, components: nil, pending: [], replyingTo: nil, callIn: context, look: look) { $0 == guest ? "guest" : "own" }
        #expect(calledIn.avatar == "guest")
        #expect(calledIn.messages.first?.avatar == "guest")
        #expect(calledIn.live == ChatPayload.liveSteps(of: bot))
        fake.agents.first?.reply("Done.")
    }
}
