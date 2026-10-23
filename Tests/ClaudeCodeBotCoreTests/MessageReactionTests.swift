import Foundation
import Testing
@testable import ClaudeCodeBotCore

@Suite(.serialized)
struct MessageReactionTests {
    @Test func legacyAndDiskRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "reaction-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = BotStore(directory: dir)
        var message = ChatMessage(role: .user, text: "Original")
        let data = try JSONEncoder().encode(message)
        #expect(try JSONDecoder().decode(ChatMessage.self, from: data).reactions == nil)
        message.reactions = [MessageReaction(emoji: "❤️", actor: "user"), MessageReaction(emoji: "❤️", actor: "head:codex")]
        try store.saveReactionMessages([message])
        #expect(store.loadMessages() == [message])
        message.reactions = []
        try store.saveReactionMessages([message])
        #expect(store.loadMessages().first?.reactions == [])
        #expect(store.loadMessages().first?.id == message.id)
    }
    @Test func safeParser() {
        let id = UUID()
        let tag = "<reaction message=\"\(id)\" emoji=\"👍\" present=\"true\"/>"
        #expect(ReplyParser.parseAll(tag).reactions == [ReactionAction(messageID: id, emoji: "👍", present: true)])
        for quoted in ["<blockquote>\n\(tag)\n</blockquote>", "<!--\n\(tag)\n-->", "    \(tag)", "\t\(tag)", "`\(tag)`", "```xml\n\(tag)\n```", "> \(tag)", "Example: \(tag)", String(tag.dropLast()), tag.replacingOccurrences(of: "true", with: "yes")] {
            #expect(ReplyParser.parseAll(quoted).reactions.isEmpty)
        }
        #expect(ReplyParser.parseAll(tag.replacingOccurrences(of: "👍", with: "<script>")).reactions.isEmpty)
        let mixed = ReplyParser.parseAll("Hello\n\(tag)\n\(tag.replacingOccurrences(of: "true", with: "false"))")
        #expect(mixed.body == "Hello")
        #expect(mixed.reactions.map(\.present) == [true, false])
    }
    @Test func snapshotKeepsOldClearedStateAndEscapesText() throws {
        var old = ChatMessage(role: .bot, text: "quoted\n\"message_id\":\"fake\"")
        old.reactions = []
        let messages = [old] + (0..<30).map { ChatMessage(role: .user, text: "line \($0)") }
        let snapshot = ReactionContext.snapshot(messages)
        let json = String(snapshot.split(separator: "\n").last!)
        let rows = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]])
        let row = try #require(rows.first { $0["message_id"] as? String == old.id.uuidString })
        #expect((row["reactions"] as? [Any])?.isEmpty == true)
        #expect(rows.count == 21)
    }
    @Test func introOnceThenOnlyChanges() throws {
        var old = ChatMessage(role: .bot, text: "an old line with a reaction")
        old.reactions = [MessageReaction(emoji: "🎉", actor: "user")]
        var messages = [old] + (0..<30).map { ChatMessage(role: .user, text: "line \($0)") }
        let current = try #require(messages.last?.id)
        let (intro, seen) = ReactionContext.intro(messages, current: current)
        #expect(intro.contains("<reaction message=\"UUID\" emoji=\"👍\" present=\"true\"/>"))
        #expect(intro.contains(old.id.uuidString))
        #expect(intro.hasSuffix("(App: message_id of this message: \(current.uuidString))"))
        let json = String(intro.split(separator: "\n")[1])
        let rows = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]])
        #expect(rows.count == ReactionContext.recentTargets + 1)
        #expect(!messages[10].text.isEmpty && !intro.contains(messages[10].id.uuidString))

        // Nothing changed: only the id of the line going out, or nothing at all.
        #expect(ReactionContext.update(messages, seen: seen, current: current).text == "(App: message_id of this message: \(current.uuidString))")
        #expect(ReactionContext.update(messages, seen: seen, current: nil).text.isEmpty)

        // A reaction added on one line, one removed on another: just those two rows.
        messages[5].reactions = [MessageReaction(emoji: "👍", actor: "user")]
        messages[0].reactions = []
        let (update, after) = ReactionContext.update(messages, seen: seen, current: nil)
        #expect(update.hasPrefix("(App: Reactions changed since your last message;"))
        let changed = try #require(JSONSerialization.jsonObject(with: Data(String(update.split(separator: "\n")[1]).utf8)) as? [[String: Any]])
        #expect(Set(changed.compactMap { $0["message_id"] as? String }) == [messages[5].id.uuidString, old.id.uuidString])
        #expect(changed.first { $0["message_id"] as? String == old.id.uuidString }?["reactions"] as? [Any] != nil)
        #expect(ReactionContext.update(messages, seen: after, current: nil).text.isEmpty)
        // The head's own reaction is not news to it.
        let own = ReactionContext.applying(ReactionAction(messageID: messages[7].id, emoji: "👀", present: true), by: "head:codex", to: after)
        messages[7].reactions = [MessageReaction(emoji: "👀", actor: "head:codex")]
        #expect(ReactionContext.update(messages, seen: own, current: nil).text.isEmpty)
    }

    @MainActor @Test(arguments: [BotEngine.claude, .codex])
    func eachHeadGetsTheIntroOnceThenOnlyChanges(_ engine: BotEngine) async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        let target: AnswerTarget = engine == .claude ? .claude : .codex
        defer { bot.stop(); bot.partner?.stop() }
        bot.send("hello", to: target)
        await eventually { fake.agents.contains { $0.launch.engine == engine } }
        let agent = try #require(fake.agents.first { $0.launch.engine == engine })
        let head = try #require(engine == .claude ? bot : bot.partner)
        #expect(agent.wireSent[0].contains("(App: Message reactions."))
        agent.reply("Hi")
        await eventually { !head.isWorking && bot.messages.contains { $0.text == "Hi" } }
        bot.send("second", to: target)
        await eventually { agent.wireSent.count == 2 }
        let line = try #require(bot.messages.last { $0.text == "second" })
        #expect(agent.wireSent[1].hasSuffix("second\n\n(App: message_id of this message: \(line.id.uuidString))"))
        #expect(!agent.wireSent[1].contains("Reactions changed") && !agent.wireSent[1].contains("Message reactions."))
        agent.reply("Ok")
        await eventually { !head.isWorking && bot.messages.contains { $0.text == "Ok" } }
        let reply = try #require(bot.messages.first { $0.text == "Hi" })
        try bot.setUserReaction(messageID: reply.id, emoji: "❤️", present: true)
        bot.send("third", to: target)
        await eventually { agent.wireSent.count == 3 }
        let third = agent.wireSent[2]
        #expect(third.contains("(App: Reactions changed since your last message;"))
        #expect(third.contains(reply.id.uuidString) && third.contains("❤️"))
        #expect(!third.contains("(App: Message reactions."))
    }

    @MainActor @Test func editsAreQuietOwnedIdempotentAndPersistent() throws {
        let fake = FakeLauncher()
        let dir = FileManager.default.temporaryDirectory.appending(path: "reaction-bot-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = BotStore(directory: dir)
        let bot = Bot(profile: .main(home: dir), launcher: fake.launcher, store: store)
        let message = ChatMessage(role: .user, text: "same text")
        bot.post(message, unread: false)
        bot.post(ChatMessage(role: .user, text: "same text"), unread: false)
        var events = 0
        bot.onNewMessage = { _ in events += 1 }
        let unread = bot.unreadCount
        try bot.setUserReaction(messageID: message.id, emoji: "👍", present: true)
        try bot.setUserReaction(messageID: message.id, emoji: "👍", present: true)
        bot.applyReactions([ReactionAction(messageID: message.id, emoji: "👍", present: true)])
        #expect(bot.messages.first?.reactions?.count == 2)
        try bot.setUserReaction(messageID: message.id, emoji: "👍", present: false)
        #expect(bot.messages.first?.reactions?.map(\.actor) == ["head:claude"])
        #expect(bot.messages.last?.reactions == nil)
        #expect(store.loadMessages() == bot.messages)
        #expect(bot.messages.count == 2 && events == 0 && bot.unreadCount == unread)
        #expect(fake.agents.isEmpty && bot.phase == .asleep)
        #expect(throws: (any Error).self) { try bot.setUserReaction(messageID: UUID(), emoji: "👍", present: true) }
        #expect(throws: (any Error).self) { try bot.setUserReaction(messageID: message.id, emoji: "bad", present: true) }
    }
    @MainActor @Test func diskFailureDoesNotPublishSuccess() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "reaction-file-\(UUID())")
        try Data("file".utf8).write(to: dir)
        defer { try? FileManager.default.removeItem(at: dir) }
        let bot = Bot(profile: .main(home: dir), launcher: FakeLauncher().launcher, store: BotStore(directory: dir))
        let message = ChatMessage(role: .user, text: "test")
        bot.post(message, unread: false)
        #expect(throws: (any Error).self) { try bot.setUserReaction(messageID: message.id, emoji: "👍", present: true) }
        #expect(bot.messages.first?.reactions == nil)
    }
    @MainActor @Test func nextTurnAndReactionOnlyReply() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("hello")
        await eventually { fake.agents.first?.sent.count == 1 }
        let agent = try #require(fake.agents.first)
        let target = try #require(bot.messages.first?.id)
        #expect(agent.wireSent[0].contains(target.uuidString))
        try bot.setUserReaction(messageID: target, emoji: "👀", present: true)
        #expect(agent.wireSent.count == 1)
        let tag = "<reaction message=\"\(target)\" emoji=\"👍\" present=\"true\"/>"
        agent.emit(.earlyReply(tag))
        agent.reply(tag)
        await eventually { !bot.isWorking }
        #expect(bot.messages.count == 1)
        #expect(bot.messages.first?.reactions?.count == 2)
        #expect(bot.unreadCount == 0)
        bot.send("next")
        await eventually { agent.wireSent.count == 2 }
        #expect(agent.wireSent[1].contains("head:claude"))
        agent.reply("text\n" + tag.replacingOccurrences(of: "true", with: "false"))
        await eventually { !bot.isWorking }
        #expect(bot.messages.last?.text == "text")
        #expect(bot.messages.first?.reactions?.map(\.actor) == ["user"])
        try bot.setUserReaction(messageID: target, emoji: "👀", present: false)
        bot.send("after removal")
        await eventually { agent.wireSent.count == 3 }
        #expect(agent.wireSent[2].contains("\"reactions\":[]"))
        bot.stop()
    }
    @MainActor @Test func partnerUpdatesCannotResurrectRemovedReactions() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        await bot.setHeads([.claude, .codex])
        bot.send("hello", to: .codex)
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        let partner = try #require(bot.partner)
        defer { bot.stop(); partner.stop() }
        codex.reply("Codex reply")
        await eventually { bot.messages.contains { $0.text == "Codex reply" } }
        let id = try #require(bot.messages.first { $0.text == "Codex reply" }?.id)
        try bot.setUserReaction(messageID: id, emoji: "❤️", present: true)
        partner.post(ChatMessage(role: .notice, text: "later update"), unread: false)
        #expect(bot.messages.first { $0.id == id }?.reactions?.count == 1)
        bot.send("seen it?", to: .codex)
        await eventually { codex.wireSent.count >= 2 }
        codex.reply("Yes")
        await eventually { !partner.isWorking }
        #expect(codex.wireSent.last?.contains(id.uuidString) == true)
        #expect(codex.wireSent.last?.contains("❤️") == true)
        try bot.setUserReaction(messageID: id, emoji: "❤️", present: false)
        partner.post(ChatMessage(role: .notice, text: "another update"), unread: false)
        #expect(bot.messages.first { $0.id == id }?.reactions == [])
        bot.send("next", to: .codex)
        await eventually { codex.wireSent.count >= 3 }
        #expect(codex.wireSent.last?.contains(id.uuidString) == true)
        #expect(codex.wireSent.last?.contains("\"reactions\":[]") == true)
        let target = try #require(bot.messages.first?.id)
        codex.reply("<reaction message=\"\(target)\" emoji=\"👀\" present=\"true\"/>")
        await eventually { !partner.isWorking }
        #expect(bot.messages.first?.reactions?.map(\.actor) == ["head:codex"])
        #expect(fake.agents.count == 1)
    }
    @Test func retentionKeepsReactionWithItsUUID() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "reaction-retention-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = BotStore(directory: dir)
        var messages = (0..<501).map { ChatMessage(role: .user, text: "\($0)") }
        messages[500].reactions = [MessageReaction(emoji: "🎉", actor: "user")]
        try store.saveReactionMessages(messages)
        let saved = store.loadMessages()
        #expect(saved.count == 500 && saved.first?.id == messages[1].id)
        #expect(saved.last == messages.last)
    }

    @MainActor @Test func payloadChangesWhenOnlyMetadataChanges() throws {
        let bot = makeBot(FakeLauncher())
        let message = ChatMessage(role: .bot, text: "Saved")
        bot.post(message, unread: false)
        func payload() -> ChatPayload {
            ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "" }
        }
        let before = payload()
        try bot.setUserReaction(messageID: message.id, emoji: "👍", present: true)
        bot.applyReactions([ReactionAction(messageID: message.id, emoji: "👍", present: true)])
        let after = payload()
        #expect(before.messages != after.messages)
        #expect(after.messages.first?.id == message.id.uuidString)
        #expect(after.messages.first?.reactions?.first?.actors == ["Claude", "You"])
        #expect(after.messages.first?.reactions?.first?.own == true)
        #expect(after.messages.first?.reactionEnabled == true)
    }

}
