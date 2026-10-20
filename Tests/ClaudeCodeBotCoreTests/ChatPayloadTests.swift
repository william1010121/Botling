import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct ChatPayloadTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-payload-\(UUID().uuidString)")

    func json(_ payload: ChatPayload) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(payload.json().utf8)) as? [String: Any])
    }

    @Test func carriesWhatThePageDraws() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "Which one?\n<choices>\n* Alpha | fast\n- Beta\n</choices>" }
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let bot = workspace.mainBot
        bot.send("Ask me")
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

        #expect(object["botName"] as? String == "Main bot")
        #expect(object["placeholder"] as? String == "Make a wish, or ask how things are going…")
        #expect(object["avatar"] as? String == "data:bot")
        let messages = try #require(object["messages"] as? [[String: Any]])
        #expect(messages.map { $0["role"] as? String } == ["user", "bot"])
        #expect(messages[0]["avatar"] is NSNull || messages[0]["avatar"] == nil)
        #expect(messages[1]["avatar"] as? String == "data:bot")
        #expect(messages[1]["open"] as? Bool == true)
        let choices = try #require(messages[1]["choices"] as? [[String: Any]])
        #expect(choices.first?["label"] as? String == "Alpha")
        #expect(choices.first?["recommended"] as? Bool == true)
        #expect((messages[0]["stamp"] as? String)?.hasPrefix("Today") == true)
        #expect(messages[1]["stamp"] is NSNull || messages[1]["stamp"] == nil)

        let reply = try #require(object["replyingTo"] as? [String: Any])
        #expect(reply["who"] as? String == "Reply to Main bot")
        #expect(reply["preview"] as? String == "Which one?")
        let pending = try #require(object["pendingFiles"] as? [[String: Any]])
        #expect(pending.first?["kind"] as? String == "image")
        #expect(pending.first?["url"] as? String == "file:///tmp/a.png")
        let components = try #require(object["components"] as? [String: Any])
        let choicesComponent = try #require(components["choices"] as? [String: Any])
        #expect((choicesComponent["template"] as? String)?.contains("ccb.answer") == true)

        // The same chat is the same text every time (keys sorted, though dictionaries have no
        // order), so the page is not sent it again and its components do not load again.
        let text = payload.json()
        #expect(text == payload.json())
        let names = components.keys.sorted()
        let places = names.compactMap { text.range(of: "\"\($0)\":{")?.lowerBound }
        #expect(places.count == names.count && places == places.sorted())
    }

    @Test func noticesShowTheirProjectsFace() throws {
        let home = root.appending(path: "main")
        let store = BotStore(directory: home)
        let project = UUID()
        store.save(messages: [ChatMessage(role: .notice, text: "garden: done", sourceID: project, sourceMessageID: UUID())])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)

        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { id in
            id == project ? "data:garden" : "data:bot"
        }
        let messages = try #require(try json(payload)["messages"] as? [[String: Any]])
        #expect(messages.first?["avatar"] as? String == "data:garden")
        #expect(messages.first?["openable"] as? Bool == true)
    }

    @Test func feedbackRelaysCarryWhoAndTheUsersWordsOldOnesToo() throws {
        let home = root.appending(path: "dev")
        let store = BotStore(directory: home)
        let report = """
        Feedback: the user flagged a reply of Maintainer as not right.
        What is wrong, in their words: The card was empty.

        It had no rows.

        The chat up to that reply, oldest first:
        [2026-10-20 13:16] User: Show me the card
        """
        var marked = ChatMessage(role: .relay, text: report)
        marked.feedback = FeedbackNote(about: "Main bot", words: "Kept words")
        let silent = report.replacingOccurrences(of: "The card was empty.\n\nIt had no rows.", with: "(they did not say)")
        store.save(messages: [
            marked,
            ChatMessage(role: .relay, text: report),
            ChatMessage(role: .relay, text: silent),
            ChatMessage(role: .relay, text: "Fix the card"),
            ChatMessage(role: .user, text: report)
        ])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)

        let messages = try #require(try json(ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "data:bot" })["messages"] as? [[String: Any]])
        let notes = messages.map { $0["feedback"] as? [String: String] }
        #expect(notes[0] == ["about": "Main bot", "words": "Kept words"])
        #expect(notes[1] == ["about": "Maintainer", "words": "The card was empty.\n\nIt had no rows."])
        #expect(notes[2] == ["about": "Maintainer", "words": ""])
        #expect(notes[3] == nil)
        #expect(notes[4] == nil)
        // The page still gets the whole report, to show when you open it.
        #expect(messages[1]["text"] as? String == report)
    }

    @Test func stampsMarkNewStretchesOfTime() {
        let now = Date()
        let messages = [
            ChatMessage(role: .user, text: "a", date: now.addingTimeInterval(-86_400)),
            ChatMessage(role: .bot, text: "b", date: now.addingTimeInterval(-86_390)),
            ChatMessage(role: .user, text: "c", date: now)
        ]
        #expect(ChatPayload.stamp(for: messages, at: 0, now: now)?.hasPrefix("Yesterday") == true)
        #expect(ChatPayload.stamp(for: messages, at: 1, now: now) == nil)
        #expect(ChatPayload.stamp(for: messages, at: 2, now: now)?.hasPrefix("Today") == true)
    }
}
