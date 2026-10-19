import Foundation
import Testing
@testable import DeckCore

@MainActor
struct ChatPayloadTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-payload-\(UUID().uuidString)")

    func json(_ payload: ChatPayload) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(payload.json().utf8)) as? [String: Any])
    }

    @Test func carriesWhatThePageDraws() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "要哪個？\n<choices>\n* 甲 | 快\n- 乙\n</choices>" }
        let workspace = Workspace(root: root.appending(path: "deck"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let bot = workspace.mainBot
        bot.send("問我")
        await eventually { bot.messages.count == 2 }
        let question = try #require(bot.messages.last)
        let picture = URL(filePath: "/tmp/a.png")

        let payload = ChatPayload.make(
            bot: bot,
            components: workspace.components,
            pending: [ChatPayload.Pending(url: picture)],
            replyingTo: question.id
        ) { projectID in projectID == nil ? "data:bot" : "data:project" }
        let object = try json(payload)

        #expect(object["botName"] as? String == "主 bot")
        #expect(object["placeholder"] as? String == "許個願，或問進度…")
        #expect(object["avatar"] as? String == "data:bot")
        let messages = try #require(object["messages"] as? [[String: Any]])
        #expect(messages.map { $0["role"] as? String } == ["user", "bot"])
        #expect(messages[0]["avatar"] is NSNull || messages[0]["avatar"] == nil)
        #expect(messages[1]["avatar"] as? String == "data:bot")
        #expect(messages[1]["open"] as? Bool == true)
        let choices = try #require(messages[1]["choices"] as? [[String: Any]])
        #expect(choices.first?["label"] as? String == "甲")
        #expect(choices.first?["recommended"] as? Bool == true)
        #expect((messages[0]["stamp"] as? String)?.hasPrefix("今天") == true)
        #expect(messages[1]["stamp"] is NSNull || messages[1]["stamp"] == nil)

        let reply = try #require(object["replyingTo"] as? [String: Any])
        #expect(reply["who"] as? String == "回覆 主 bot")
        #expect(reply["preview"] as? String == "要哪個？")
        let pending = try #require(object["pendingFiles"] as? [[String: Any]])
        #expect(pending.first?["kind"] as? String == "image")
        #expect(pending.first?["url"] as? String == "file:///tmp/a.png")
        let components = try #require(object["components"] as? [String: Any])
        let choicesComponent = try #require(components["choices"] as? [String: Any])
        #expect((choicesComponent["template"] as? String)?.contains("deck.answer") == true)
    }

    @Test func noticesShowTheirProjectsFace() throws {
        let home = root.appending(path: "main")
        let store = BotStore(directory: home)
        let project = UUID()
        store.save(messages: [ChatMessage(role: .notice, text: "garden：好了", sourceID: project, sourceMessageID: UUID())])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)

        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { id in
            id == project ? "data:garden" : "data:bot"
        }
        let messages = try #require(try json(payload)["messages"] as? [[String: Any]])
        #expect(messages.first?["avatar"] as? String == "data:garden")
        #expect(messages.first?["openable"] as? Bool == true)
    }

    @Test func stampsMarkNewStretchesOfTime() {
        let now = Date()
        let messages = [
            ChatMessage(role: .user, text: "a", date: now.addingTimeInterval(-86_400)),
            ChatMessage(role: .bot, text: "b", date: now.addingTimeInterval(-86_390)),
            ChatMessage(role: .user, text: "c", date: now)
        ]
        #expect(ChatPayload.stamp(for: messages, at: 0, now: now)?.hasPrefix("昨天") == true)
        #expect(ChatPayload.stamp(for: messages, at: 1, now: now) == nil)
        #expect(ChatPayload.stamp(for: messages, at: 2, now: now)?.hasPrefix("今天") == true)
    }
}
