import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The bot keeps up with you: what you add before it answers joins what you said, a wake-up
/// brings the chat's last lines along, and an answer says which question it answers.
@MainActor
struct ConversationTests {
    @Test func whatYouAddBeforeItAnswersIsAnsweredTogether() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("Can a new bot have a folder? I want every folder under ~/tool")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]

        bot.send("to have a bot")
        #expect(agent.interrupts == 1)
        let merged = try #require(agent.sent.last)
        #expect(merged.hasPrefix("(I sent this in parts before you answered; here is all of it:)"))
        #expect(merged.hasSuffix("Can a new bot have a folder? I want every folder under ~/tool\n\nto have a bot"))
        // The stopped turn's error does not show; the next reply answers it all.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(!bot.messages.contains { $0.role == .error })
        #expect(bot.isWorking)

        // A third part joins the first two.
        bot.send("each its own")
        #expect(agent.interrupts == 2)
        #expect(agent.sent.last == "(I sent this in parts before you answered; here is all of it:)\n\nCan a new bot have a folder? I want every folder under ~/tool\n\nto have a bot\n\neach its own")

        agent.reply("Yes: one project per folder.")
        await eventually { bot.messages.last?.role == .bot }
        #expect(bot.messages.map(\.role) == [.user, .user, .user, .bot])

        // Once it has answered, a new message is a new turn.
        bot.send("Thanks")
        #expect(agent.interrupts == 2)
        #expect(agent.sent.last == "Thanks")
    }

    @Test func workItWasHandedIsNotInterrupted() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.relay("Fix the login page")
        await eventually { fake.agents.count == 1 }
        bot.send("Also, how is it going?")
        #expect(fake.agents[0].interrupts == 0)
        #expect(fake.agents[0].sent.last == "Also, how is it going?")
    }

    @Test func aQuestionWaitingOnYouIsNotInterrupted() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        bot.send("Clean up the folder")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].emit(.permission(PermissionRequest(id: "r1", tool: "Bash", summary: "rm -rf build", input: "{}")))
        await eventually { bot.waitingForPermission }
        bot.send("Only the build folder")
        #expect(fake.agents[0].interrupts == 0)
    }

    @Test func aWakeUpBringsTheLastLinesOfTheChat() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 0.05)
        bot.send("I want every folder under ~/tool to have a bot")
        await eventually { bot.messages.last?.role == .bot }
        await eventually { bot.phase == .asleep }

        bot.send("Is there a new way now?")
        await eventually { fake.agents.count == 2 }
        let woke = try #require(fake.agents[1].sent.first)
        #expect(woke.contains("(App: The last messages in this chat, oldest first."))
        #expect(woke.contains("User: I want every folder under ~/tool to have a bot"))
        #expect(woke.contains("You: Got it"))
        // The message it woke for is said once, at the end, not also as an old line.
        #expect(woke.hasSuffix("\n\nIs there a new way now?"))
        #expect(!woke.contains("User: Is there a new way now?"))
    }

    @Test func everyMessageIsArchivedByMonthForTheBotToSearch() throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.post(ChatMessage(role: .user, text: "Every folder under ~/tool\nshould have a bot"))
        bot.post(ChatMessage(role: .bot, text: "Which first?", choices: [Choice(label: "Forms"), Choice(label: "Jumps")]))
        let month = Date().formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)", timeZone: .current, calendar: .current))
        let file = bot.profile.archiveURL.appending(path: "\(month).md")
        let text = try String(contentsOf: file, encoding: .utf8)
        let entries = text.components(separatedBy: "\n\n").filter { !$0.isEmpty }
        #expect(entries.count == 2)
        #expect(entries[0].hasSuffix("] User: Every folder under ~/tool\nshould have a bot"))
        #expect(entries[1].hasSuffix("] You: Which first? [options: Forms / Jumps]"))
        #expect(bot.recentChat().contains("Grep your chat archive in \(bot.profile.archiveURL.path)"))
    }

    @Test func aChatFromBeforeTheArchiveIsArchivedOnce() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-arch-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        store.save(messages: [ChatMessage(role: .user, text: "Old wish"), ChatMessage(role: .bot, text: "Old answer")])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        let files = try FileManager.default.contentsOfDirectory(atPath: bot.profile.archiveURL.path)
        #expect(files.count == 1)
        let text = try String(contentsOf: bot.profile.archiveURL.appending(path: files[0]), encoding: .utf8)
        #expect(text.contains("User: Old wish") && text.contains("You: Old answer"))
        // A second start does not write it again.
        _ = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        let again = try String(contentsOf: bot.profile.archiveURL.appending(path: files[0]), encoding: .utf8)
        #expect(again == text)
    }

    @Test func theAppsOwnCardsCloseOnRestartButBotsQuestionsStay() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-cards-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var card = ChatMessage(role: .notice, text: "Add these 4 folders as projects?", choices: [Choice(label: "Add all 4"), Choice(label: "Don't add")])
        let question = ChatMessage(role: .bot, text: "Which first?", choices: [Choice(label: "Forms"), Choice(label: "Jumps")])
        var copy = ChatMessage(role: .notice, text: "garden: Which first?", choices: [Choice(label: "A")], sourceID: UUID(), sourceMessageID: UUID())
        card.date = Date()
        copy.date = Date()
        store.save(messages: [card, question, copy])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.messages[0].answer == Bot.askAgain)
        #expect(bot.messages[1].isOpenQuestion)
        #expect(bot.messages[2].isOpenQuestion)
    }

    @Test func recentLinesSayWhatWasAskedAndPicked() {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.post(ChatMessage(role: .bot, text: "Which first?", choices: [Choice(label: "Forms"), Choice(label: "Jumps")]))
        let recent = bot.recentChat()
        #expect(recent.contains("You: Which first? [options: Forms / Jumps] (not answered yet)"))
        #expect(makeBot(fake).recentChat().isEmpty)
    }

    @Test func anAnswerSaysWhichQuestionItAnswers() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in text == "Ask me" || text.hasSuffix("Ask me") ? "Which first?\n<choices>\n* Forms | today\n- Jumps | later\n</choices>" : "OK" }
        let bot = makeBot(fake)
        bot.send("Ask me")
        await eventually { bot.openQuestion != nil }
        let asked = try #require(bot.openQuestion)
        #expect(bot.answer("Is there a new way now?", in: asked.id))
        await eventually { bot.messages.last?.text == "OK" }
        #expect(fake.agents[0].sent.last == "(Replying to what you said earlier: \"Which first?\")\n\nIs there a new way now?")
        let mine = try #require(bot.messages.last { $0.role == .user })
        #expect(mine.replyTo == asked.id)
    }
}
