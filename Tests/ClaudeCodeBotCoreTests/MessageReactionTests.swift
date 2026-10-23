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
        #expect(agent.sent[0].contains(target.uuidString))
        try bot.setUserReaction(messageID: target, emoji: "👀", present: true)
        #expect(agent.sent.count == 1)
        let tag = "<reaction message=\"\(target)\" emoji=\"👍\" present=\"true\"/>"
        agent.emit(.earlyReply(tag))
        agent.reply(tag)
        await eventually { !bot.isWorking }
        #expect(bot.messages.count == 1)
        #expect(bot.messages.first?.reactions?.count == 2)
        #expect(bot.unreadCount == 0)
        bot.send("next")
        await eventually { agent.sent.count == 2 }
        #expect(agent.sent[1].contains("head:claude"))
        agent.reply("text\n" + tag.replacingOccurrences(of: "true", with: "false"))
        await eventually { !bot.isWorking }
        #expect(bot.messages.last?.text == "text")
        #expect(bot.messages.first?.reactions?.map(\.actor) == ["user"])
        try bot.setUserReaction(messageID: target, emoji: "👀", present: false)
        bot.send("after removal")
        await eventually { agent.sent.count == 3 }
        #expect(agent.sent[2].contains("\"reactions\":[]"))
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
        try bot.setUserReaction(messageID: id, emoji: "❤️", present: false)
        partner.post(ChatMessage(role: .notice, text: "another update"), unread: false)
        #expect(bot.messages.first { $0.id == id }?.reactions == [])
        bot.send("next", to: .codex)
        await eventually { codex.sent.count >= 2 }
        #expect(codex.sent.last?.contains(id.uuidString) == true)
        #expect(codex.sent.last?.contains("\"reactions\":[]") == true)
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
