import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Bot look Cute: Claude and Codex drawn as characters in a bot with two heads.
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

    @Test func eachMoodHasItsProp() {
        #expect(Chibi.svg(.claude, mood: .work).contains("#B9BCC4"))  // the laptop
        #expect(Chibi.svg(.codex, mood: .sleep).contains(">z</text>"))
        #expect(Chibi.svg(.claude, mood: .think).contains(">?</text>"))
        let awake = Chibi.svg(.codex, mood: .normal)
        #expect(!awake.contains("<text") && !awake.contains("#B9BCC4"))
    }

    @Test func theCharactersCanBeToldApart() {
        // Claude: the orange hair and flower; Codex: the lavender horns and knot ornament.
        #expect(Chibi.svg(.claude).contains("#E2762A"))
        #expect(!Chibi.svg(.claude).contains("#9F96CF"))
        #expect(Chibi.svg(.codex).contains("#9F96CF"))
        #expect(!Chibi.svg(.codex).contains("#E2762A"))
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

    @Test func originalKeepsTheBotsFaceAndLetters() {
        let bot = twoHeaded()
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "own" }
        #expect(payload.messages.map(\.avatar) == [nil, "own", "own", "own"])
        #expect(payload.seenHeads == nil)
    }

    @Test func aBotWithOneHeadLooksAsBefore() {
        var reply = ChatMessage(role: .bot, text: "Hi")
        reply.engine = .claude
        let bot = bot(heads: [.claude], messages: [reply])
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "own" }
        #expect(payload.messages.map(\.avatar) == ["own"])
        #expect(payload.seenHeads == nil)
    }
}
