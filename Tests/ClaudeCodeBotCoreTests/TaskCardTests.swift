import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Task cards: the `<task …/>` line heads write, and how a card goes from your message
/// (provisional) to the head that claims it, its updates and its end.
struct TaskTagTests {
    @Test func theLineIsReadAndTakenOutOfTheReply() {
        let parsed = ReplyParser.parseAll("""
            Fixed: the card counts main now.
            <task name="Contribution card" now="Checking the screenshot" next="Apply to the library" blocked="" state="done"/>
            """)
        #expect(parsed.body == "Fixed: the card counts main now.")
        #expect(parsed.tasks == [TaskTag(name: "Contribution card", now: "Checking the screenshot", next: "Apply to the library", blocked: "", state: .done)])
    }

    @Test func everyAttributeIsOptionalAndUnknownStatesAreLeftOut() {
        let parsed = ReplyParser.parseAll("On it. <task continues='Board' state='thinking'/>")
        #expect(parsed.body == "On it.")
        #expect(parsed.tasks == [TaskTag(continues: "Board")])
        // Not written: nil (keeps its value); written empty: "" (clears it).
        #expect(parsed.tasks[0].now == nil && parsed.tasks[0].state == nil)
    }

    @Test func twoLinesAreTwoTasksInTheOrderWritten() {
        let parsed = ReplyParser.parseAll("Both started.\n<task name=\"Cards\"/>\n<task name=\"Disk\" now=\"Listing caches\"/>")
        #expect(parsed.tasks.map(\.name) == ["Cards", "Disk"])
        #expect(parsed.body == "Both started.")
    }

    @Test func aLineInCodeIsAnExampleNotATask() {
        let parsed = ReplyParser.parseAll("Write it like this:\n```\n<task name=\"Example\"/>\n```")
        #expect(parsed.tasks.isEmpty)
        #expect(parsed.body.contains("<task name=\"Example\"/>"))
        // `<tasks>` and a bare `<task>` are not the tag.
        #expect(ReplyParser.parseAll("Use <tasks> and <task> here.").tasks.isEmpty)
    }

    @Test func aLineBeforeAToolCallIsLiftedIntoTheReply() {
        let lifted = ReplyParser.liftTags("Starting. <task name=\"Board\" now=\"Reading\"/>")
        #expect(lifted.rest == "Starting.")
        #expect(lifted.tags == ["<task name=\"Board\" now=\"Reading\"/>"])
        #expect(ReplyParser.parseAll(ReplyParser.lifting(lifted.tags, into: "Done.")).tasks.map(\.name) == ["Board"])
    }

    @Test @MainActor func aCutOffTurnShowsNoLine() {
        #expect(Bot.cutOffText("Halfway <task name=\"Board\"/>") == "Halfway")
    }
}

struct TaskBookTests {
    let start = Date(timeIntervalSince1970: 1_000_000)
    let user = UUID()

    @Test func aMessageOpensAProvisionalCardNamedAfterItsStart() {
        var book = TaskBook()
        let id = book.begin(message: user, text: "Fix the contribution board, it never got fixed\nmore detail", owner: nil, at: start)
        let card = book.task(id)!
        #expect(card.state == .pending && card.owner == nil)
        #expect(card.name == "Fix the contribution board, it never got…")
        #expect(card.messageIDs == [user] && card.startedByMessageID == user)
    }

    @Test func provisionalThenClaimedThenUpdatedThenDone() {
        var book = TaskBook()
        let id = book.begin(message: user, text: "agent-activity too", owner: nil, at: start)
        let claimed = book.claim(message: user, by: .claude, at: start.addingTimeInterval(2))
        #expect(claimed)
        #expect(book.task(id)?.state == .running && book.task(id)?.owner == .claude)

        let first = UUID()
        let turn = TaskBook.Turn(head: .claude, userMessage: user, started: start, usedTools: true)
        book.replied(first, turn: turn, tags: [TaskTag(name: "agent-activity card", now: "Looking at the card", next: "Fix folding")], at: start.addingTimeInterval(30))
        var card = book.task(id)!
        #expect(card.name == "agent-activity card" && card.now == "Looking at the card" && card.next == "Fix folding")
        #expect(card.state == .running && card.messageIDs == [user, first])

        // Missing attributes keep their values; an empty one clears.
        let second = UUID()
        book.replied(second, turn: turn, tags: [TaskTag(next: "", state: .done)], at: start.addingTimeInterval(60))
        card = book.task(id)!
        #expect(card.state == .done && card.now == "Looking at the card" && card.next == nil)
        #expect(card.updatedAt == start.addingTimeInterval(60))
    }

    @Test func theOtherHeadCannotChangeTheOwnersCard() {
        var book = TaskBook()
        let id = book.begin(message: user, text: "Fix it", owner: nil, at: start)
        book.claim(message: user, by: .claude, at: start)
        let reply = UUID()
        book.replied(reply, turn: .init(head: .codex, userMessage: user, started: start, usedTools: true), tags: [TaskTag(name: "Mine now", state: .done)], at: start.addingTimeInterval(40))
        let card = book.task(id)!
        #expect(card.owner == .claude && card.state == .running && card.name == "Fix it")
        // Its reply still belongs to the task.
        #expect(card.messageIDs.contains(reply))
    }

    @Test func continuesMergesTheMessageIntoTheEarlierTask() {
        var book = TaskBook()
        let earlierMessage = UUID()
        let earlier = book.begin(message: earlierMessage, text: "Fix the card", owner: .claude, at: start)
        book.replied(UUID(), turn: .init(head: .claude, userMessage: earlierMessage, started: start, usedTools: true), tags: [TaskTag(name: "Contribution card", state: .done)], at: start)
        book.begin(message: user, text: "And the 1x1 size?", owner: .claude, at: start.addingTimeInterval(100))
        #expect(book.tasks.count == 2)

        let reply = UUID()
        let touched = book.replied(reply, turn: .init(head: .claude, userMessage: user, started: start.addingTimeInterval(100)),
                                   tags: [TaskTag(continues: "contribution card", now: "Checking 1x1")], at: start.addingTimeInterval(110))
        #expect(touched == [earlier])
        #expect(book.tasks.count == 1)
        let card = book.task(earlier)!
        #expect(card.messageIDs.suffix(2) == [user, reply])
        #expect(card.state == .running && card.now == "Checking 1x1")
    }

    @Test func twoLinesSplitOneMessageIntoTwoTasks() {
        var book = TaskBook()
        let first = book.begin(message: user, text: "Fix the cards and clean the disk", owner: .claude, at: start)
        let reply = UUID()
        let touched = book.replied(reply, turn: .init(head: .claude, userMessage: user, started: start),
                                   tags: [TaskTag(name: "Cards"), TaskTag(name: "Disk", now: "Listing caches")], at: start.addingTimeInterval(5))
        #expect(touched.count == 2 && touched[0] == first)
        #expect(book.tasks.map(\.name) == ["Cards", "Disk"])
        let disk = book.task(touched[1])!
        #expect(disk.owner == .claude && disk.state == .running && disk.now == "Listing caches")
        #expect(disk.startedByMessageID == user)
        #expect(book.tasks(containing: reply).count == 2)
    }

    @Test func aQuickAnswerLeavesNoCard() {
        var book = TaskBook()
        book.begin(message: user, text: "What does this mean?", owner: .claude, at: start)
        book.claim(message: user, by: .claude, at: start)
        let touched = book.replied(UUID(), turn: .init(head: .claude, userMessage: user, started: start), tags: [], at: start.addingTimeInterval(5))
        #expect(touched.isEmpty && book.tasks.isEmpty)
    }

    @Test func aSlowAnswerOrToolsKeepTheCard() {
        var slow = TaskBook()
        slow.begin(message: user, text: "Look into it", owner: .claude, at: start)
        let result1 = slow.replied(UUID(), turn: .init(head: .claude, userMessage: user, started: start), tags: [], at: start.addingTimeInterval(TaskBook.quickAnswer + 1))
        #expect(result1.count == 1)

        var tools = TaskBook()
        tools.begin(message: user, text: "Look into it", owner: .claude, at: start)
        let result2 = tools.replied(UUID(), turn: .init(head: .claude, userMessage: user, started: start, usedTools: true), tags: [], at: start.addingTimeInterval(3))
        #expect(result2.count == 1)
        #expect(tools.tasks.first?.kept == true && tools.tasks.first?.state == .running)
    }

    @Test func theSecondHeadsLongerAnswerBringsTheCardBack() {
        var book = TaskBook()
        book.begin(message: user, text: "Clean the disk", owner: nil, at: start)
        book.replied(UUID(), turn: .init(head: .claude, userMessage: user, started: start), tags: [], at: start.addingTimeInterval(2))
        #expect(book.tasks.isEmpty)
        let reply = UUID()
        book.replied(reply, turn: .init(head: .codex, userMessage: user, userText: "Clean the disk", started: start, usedTools: true), tags: [], at: start.addingTimeInterval(90))
        #expect(book.tasks.count == 1)
        #expect(book.tasks[0].owner == .codex && book.tasks[0].name == "Clean the disk" && book.tasks[0].messageIDs == [user, reply])
    }

    @Test func aQuestionWaitsOnYouAndYourAnswerCarriesItOn() {
        var book = TaskBook()
        let id = book.begin(message: user, text: "Go cross-platform?", owner: .claude, at: start)
        let question = UUID()
        book.replied(question, turn: .init(head: .claude, userMessage: user, started: start, usedTools: true, asks: true), tags: [], at: start.addingTimeInterval(30))
        #expect(book.task(id)?.state == .waiting)
        // Your answer is a reply to its question: the same card, running again, no new one.
        let answer = UUID()
        let result3 = book.begin(message: answer, text: "Two weeks", owner: .claude, replyingTo: question, at: start.addingTimeInterval(60))
        #expect(result3 == id)
        #expect(book.tasks.count == 1 && book.task(id)?.state == .running && book.task(id)?.messageIDs.last == answer)
    }

    @Test func handedWorkAndWorkerReportsFindTheirTask() {
        var book = TaskBook()
        let id = book.begin(message: user, text: "Verify the screenshots", owner: .claude, at: start)
        let handoff = UUID()
        book.help(TaskCard.Help(handoffID: handoff, head: .codex, text: "Check the screenshots"), on: id)
        book.link(subagent: "worker-1", to: id)
        let codex = UUID()
        let result4 = book.replied(codex, turn: .init(head: .codex, handoffID: handoff), tags: [], at: start.addingTimeInterval(50))
        #expect(result4 == [id])
        let report = UUID()
        let result5 = book.replied(report, turn: .init(head: .claude, reporting: ["worker-1"]), tags: [TaskTag(state: .done)], at: start.addingTimeInterval(90))
        #expect(result5 == [id])
        #expect(book.task(id)?.state == .done && book.task(id)?.messageIDs.suffix(2) == [codex, report])
    }

    @Test func partsSentBeforeTheAnswerAreOneTask() {
        var book = TaskBook()
        let first = book.begin(message: user, text: "Fix the card", owner: .claude, at: start)
        let later = UUID()
        book.begin(message: later, text: "and its title", owner: .claude, at: start.addingTimeInterval(3))
        book.join(message: user, into: later)
        #expect(book.tasks.count == 1 && book.task(first)?.messageIDs == [user, later])
    }

    @Test func aQuietRunningTaskMayBeStuckUnlessSomethingOfItWorks() {
        var card = TaskCard(name: "Board", owner: .claude, state: .running, createdAt: start)
        let later = start.addingTimeInterval(TaskBook.staleAfter + 1)
        #expect(card.isStale(at: later, working: false))
        #expect(!card.isStale(at: later, working: true))
        #expect(!card.isStale(at: start.addingTimeInterval(60), working: false))
        card.state = .waiting
        #expect(!card.isStale(at: later, working: false))
    }

    @Test func cardsGoWhenTheirLinesLeaveTheChat() {
        var book = TaskBook()
        let gone = UUID()
        book.begin(message: gone, text: "Old", owner: nil, at: start)
        book.begin(message: user, text: "New", owner: nil, at: start)
        let changed = book.keep(only: [user])
        #expect(changed)
        #expect(book.tasks.map(\.name) == ["New"])
    }

    @Test func cardsAreSavedAndReadBack() throws {
        let store = BotStore(directory: FileManager.default.temporaryDirectory.appending(path: "ccb-tasks-\(UUID().uuidString)"))
        var card = TaskCard(name: "Board", owner: .codex, state: .waiting, now: "Asking", next: "Ship", blocked: "Your OK",
                            createdAt: start, updatedAt: start.addingTimeInterval(5), messageIDs: [user], startedByMessageID: user)
        card.kept = true
        card.helps = [TaskCard.Help(handoffID: UUID(), head: .claude, text: "Review")]
        card.subagentIDs = ["agent-1"]
        store.save(tasks: [card])
        #expect(store.loadTasks() == [card])
        #expect(FileManager.default.fileExists(atPath: store.directory.appending(path: "tasks.json").path))
        // A file from a build that knows more states still reads.
        try Data(#"[{"id":"\#(UUID().uuidString)","name":"X","state":"paused","createdAt":0}]"#.utf8).write(to: store.directory.appending(path: "tasks.json"))
        #expect(store.loadTasks().first?.state == .running)
    }
}

/// The book as a bot keeps it: your message, the reply's line, the chips.
@MainActor
struct BotTaskCardTests {
    final class Clock: @unchecked Sendable { var date = Date(timeIntervalSince1970: 2_000_000) }

    func bot(_ fake: FakeLauncher, clock: Clock, store: BotStore? = nil) -> Bot {
        let bot = Bot(profile: .main(home: FileManager.default.temporaryDirectory.appending(path: "ccb-bot-\(UUID().uuidString)")),
                      idleInterval: 60, launcher: fake.launcher, store: store)
        bot.now = { clock.date }
        return bot
    }

    @Test func aReplyWithALineNamesTheTaskAndHidesIt() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : "Fixed: it counts main now.\n<task name=\"Contribution card\" now=\"Done\" state=\"done\"/>" }
        let clock = Clock()
        let bot = bot(fake, clock: clock)
        bot.send("Fix the contribution board")
        #expect(bot.tasks.count == 1 && bot.tasks[0].state == .pending)
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        let reply = bot.messages.last!
        #expect(reply.text == "Fixed: it counts main now.")
        #expect(bot.tasks.count == 1)
        let card = bot.tasks[0]
        #expect(card.name == "Contribution card" && card.state == .done && card.owner == .claude)
        #expect(card.messageIDs.last == reply.id)
        #expect(bot.openTaskCount == 0)
    }

    @Test func aQuickAnswerLeavesNoCardButASlowOneStays() async {
        let fake = FakeLauncher()
        let clock = Clock()
        let bot = bot(fake, clock: clock)
        bot.send("What does this mean?")
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        #expect(bot.tasks.isEmpty)

        bot.send("Look into the logs")
        // The reply comes 30 seconds later.
        clock.date = clock.date.addingTimeInterval(30)
        await eventually { bot.messages.filter { $0.role == .bot }.count == 2 && !bot.isWorking }
        #expect(bot.tasks.count == 1 && bot.tasks[0].state == .running && bot.tasks[0].name == "Look into the logs")
        #expect(bot.openTaskCount == 1)
        // Ten quiet minutes later, with nothing at work, it may be stuck.
        #expect(!bot.isStale(bot.tasks[0], at: clock.date))
        #expect(bot.isStale(bot.tasks[0], at: clock.date.addingTimeInterval(TaskBook.staleAfter)))
    }

    @Test func askingForAReportStaysOnTheSameCard() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : "Working on it. <task name=\"Logs\" now=\"Reading\"/>" }
        let clock = Clock()
        let bot = bot(fake, clock: clock)
        bot.send("Look into the logs")
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        let id = bot.tasks[0].id
        bot.askForReport(on: id)
        let asked = bot.messages.last { $0.role == .user }!
        #expect(asked.text.contains("Logs"))
        await eventually { bot.messages.filter { $0.role == .bot }.count == 2 && !bot.isWorking }
        #expect(bot.tasks.count == 1 && bot.tasks[0].messageIDs.contains(asked.id))
    }

    @Test func theCardsComeBackAfterARestart() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : "Started. <task name=\"Disk\" next=\"Delete caches\"/>" }
        let clock = Clock()
        let store = BotStore(directory: FileManager.default.temporaryDirectory.appending(path: "ccb-store-\(UUID().uuidString)"))
        let first = bot(fake, clock: clock, store: store)
        first.send("Clean the disk")
        await eventually { first.messages.last?.role == .bot && !first.isWorking }
        let saved = first.tasks
        #expect(saved.count == 1 && saved[0].next == "Delete caches")
        let again = bot(FakeLauncher(), clock: clock, store: store)
        #expect(again.tasks == saved)
    }

    @Test func aHandOffHelpsWithTheTaskOfTheHeadThatMadeIt() async throws {
        let fake = FakeLauncher()
        fake.respondFor = { _, _ in nil }
        let clock = Clock()
        let bot = bot(fake, clock: clock)
        await bot.setHeads([.claude, .codex])
        defer { bot.stop() }
        bot.send("Fix the screenshots", to: .claude)
        let claude = try #require(fake.agents.first { $0.launch.engine == .claude })
        clock.date = clock.date.addingTimeInterval(30)
        claude.reply("Fixed; Codex checks them. <task name=\"Screenshots\" now=\"Codex verifies\"/> <handoff to=\"codex\">Verify the screenshots</handoff>")
        await eventually({ fake.agents.contains { $0.launch.engine == .codex } }, timeout: 2)
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        #expect(bot.tasks.count == 1)
        let card = bot.tasks[0]
        #expect(card.name == "Screenshots" && card.owner == .claude)
        #expect(card.helps?.map(\.head) == [.codex] && card.helps?.first?.text == "Verify the screenshots")
        codex.reply("All 4 screenshots match.")
        await eventually({ bot.messages.contains { $0.text == "All 4 screenshots match." } }, timeout: 2)
        let verified = try #require(bot.messages.first { $0.text == "All 4 screenshots match." })
        // Its reply shows the card's chip; only the owner changes the card.
        #expect(bot.tasks.count == 1 && bot.tasks[0].messageIDs.contains(verified.id))
        #expect(bot.tasks[0].owner == .claude && bot.tasks[0].now == "Codex verifies")
    }

    @Test func eachReplyOfATaskCarriesItsChipAndTheLatestSaysHowItStands() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : "On it. <task name=\"Board\" now=\"Drawing card 2\"/>" }
        let clock = Clock()
        let bot = bot(fake, clock: clock)
        bot.send("Draw the board")
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, now: clock.date, selectedTask: bot.tasks[0].id, avatar: { _ in "" })
        let reply = payload.messages.last!
        #expect(reply.taskCards?.count == 1)
        #expect(reply.taskCards?.first?.name == "Board" && reply.taskCards?.first?.state == "running")
        #expect(reply.taskCards?.first?.detail == L("Now: {0}", "Drawing card 2"))
        #expect(reply.taskCards?.first?.selected == true)
        // Your own line has no chip.
        #expect(payload.messages.first?.taskCards == nil)
    }
}

struct TaskSummaryPromptTests {
    @Test func theSummaryIsToldTheRangesTasks() {
        let message = ChatMessage(role: .bot, text: "Board fixed")
        let card = TaskCard(name: "Contribution card", state: .done, createdAt: Date(), messageIDs: [UUID(), message.id])
        let prompt = CatchUp.prompt(for: [message], language: .english, tasks: [card]) { _ in "Claude" }
        #expect(prompt.contains("[task:\(card.id.uuidString)] Contribution card (done) — messages: \(message.id.uuidString)"))
        #expect(CatchUp.instructions(language: .english).contains("[[task:TASK_UUID]]"))
        // No tasks, no list.
        #expect(!CatchUp.prompt(for: [message], language: .english) { _ in "Claude" }.contains("Tasks in this range"))
    }

    @Test func headsAreToldTheLineBriefly() {
        let prompts = BotPrompts(profile: .main(home: FileManager.default.temporaryDirectory))
        #expect(prompts.system.contains("<task name=\"short name\""))
        #expect(prompts.system.contains("continues=\"its name\""))
    }
}
