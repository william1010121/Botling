import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct SummarySourceTests {
    @Test func promptCarriesActualMessageIDsAndPersistedDecision() {
        var message = ChatMessage(role: .bot, text: "Which release?")
        message.choices = [Choice(label: "Stable", detail: "After review", recommended: true)]
        message.chosen = 0
        message.answer = "Keep the signing note"
        let prompt = CatchUp.prompt(for: [message], language: .english) { _ in "Garden · Codex" }
        #expect(prompt.contains("[source:\(message.id.uuidString)] Garden · Codex: Which release?"))
        #expect(prompt.contains("Option 0: Stable — After review"))
        #expect(prompt.contains("Selected option: 0"))
        #expect(prompt.contains("Answer / notes: Keep the signing note"))
        #expect(CatchUp.instructions(language: .english).contains("Never invent ids, quotes, speakers or selections"))
    }

    @Test func requesterIsPersistedWithoutInventingHistoricalActors() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "summary-source-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "cache.json")
        let cache = CatchUpCache(url: url)
        cache.store(["New"], model: "actual-model", for: "new", requestedBy: "user")
        #expect(CatchUpCache(url: url)["new"]?.requestedBy == "user")
        // Historical cache entries have model metadata but no requester field.
        try Data(#"{"old":{"bullets":["Old"],"model":"old-model","date":0}}"#.utf8).write(to: url)
        let old = CatchUpCache(url: url)["old"]
        #expect(old?.model == "old-model")
        #expect(old?.requestedBy == nil)
    }
    @Test @MainActor func payloadUsesPersistedSourceEngineAndDateWithoutGuessingOldMessages() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "summary-payload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        var known = ChatMessage(role: .bot, text: "Known source", date: Date(timeIntervalSince1970: 1_792_855_000))
        known.engine = .codex
        let unknown = ChatMessage(role: .bot, text: "Old source")
        let store = BotStore(directory: root)
        store.save(messages: [known, unknown])
        let chat = Bot(profile: .main(home: root), launcher: FakeLauncher().launcher, store: store)
        let payload = ChatPayload.make(bot: chat, components: nil, pending: [], replyingTo: nil) { _ in "" }
        #expect(payload.messages[0].sourceEngine == "codex")
        #expect(payload.messages[0].sourceAuthor == chat.name)
        #expect(payload.messages[0].sourceTime == CatchUp.time(known.date))
        #expect(payload.messages[1].sourceEngine == nil)
        #expect(chat.messages == [known, unknown])
    }

}
