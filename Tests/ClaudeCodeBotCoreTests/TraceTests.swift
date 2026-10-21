import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Lines as `claude -p --output-format stream-json --verbose` (2.1.304) wrote them for a bot that
/// sent a subagent off in the background, trimmed to the fields the app reads.
enum SubagentRun {
    static let spawn = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"description":"Read a.txt and report content","subagent_type":"general-purpose","prompt":"Read the file named a.txt and report it."}}]}}"#
    static let started = #"{"type":"system","subtype":"task_started","task_id":"a35","tool_use_id":"toolu_A","description":"Read a.txt and report content","subagent_type":"general-purpose","is_backgrounded":true,"prompt":"Read the file named a.txt and report it."}"#
    static let launched = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_A","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]}}"#
    static let subagentSays = #"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"Looking for it."}]}}"#
    static let subagentReads = #"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"tool_use","id":"toolu_R","name":"Read","input":{"file_path":"/tmp/probe/a.txt"}}]}}"#
    static let readResult = #"{"type":"user","parent_tool_use_id":"toolu_A","message":{"role":"user","content":[{"tool_use_id":"toolu_R","type":"tool_result","content":"1\thello world"}]}}"#
    static let notification = #"{"type":"system","subtype":"task_notification","task_id":"a35","tool_use_id":"toolu_A","status":"completed","summary":"It says hello world."}"#

    static var lines: [String] { [spawn, started, launched, subagentSays, subagentReads, readResult, notification] }

    /// The subagent stopped with a Monitor or background command of its own still running: it
    /// has not reported. claude sends this again each time that work wakes it, and each one
    /// starts a turn of the bot's own.
    static let waiting = #"{"type":"system","subtype":"task_notification","task_id":"a35","tool_use_id":"toolu_A","status":"completed","summary":"Agent \"Read a.txt and report content\" is waiting on its own background work"}"#
}

@MainActor
struct TraceTests {
    @Test func streamLinesBecomeTraceEvents() {
        #expect(StreamEvent.events(in: SubagentRun.spawn) == [
            .trace(.toolUse(id: "toolu_A", tool: "Agent", title: "Delegate Read a.txt and report content", detail: "Read the file named a.txt and report it.", parent: nil)),
            .trace(.subagentDescribed(id: "toolu_A", description: "Read a.txt and report content")),
        ])
        #expect(StreamEvent.events(in: SubagentRun.started) == [.trace(.subagentStarted(id: "toolu_A", description: "Read a.txt and report content", type: "general-purpose", prompt: "Read the file named a.txt and report it.", background: true))])
        #expect(StreamEvent.events(in: SubagentRun.launched) == [.trace(.toolResult(id: "toolu_A", output: "Async agent launched successfully.", failed: false, parent: nil))])
        #expect(StreamEvent.events(in: SubagentRun.subagentSays) == [.trace(.text("Looking for it.", parent: "toolu_A"))])
        #expect(StreamEvent.events(in: SubagentRun.readResult) == [.trace(.toolResult(id: "toolu_R", output: "1\thello world", failed: false, parent: "toolu_A"))])
        #expect(StreamEvent.events(in: SubagentRun.notification) == [.trace(.subagentEnded(id: "toolu_A", status: "completed", summary: "It says hello world."))])
    }

    /// claude's structured result for a call that started work in the background is read, not
    /// its words: a reworded result still sends the subagent to the background with its id.
    @Test func aLaunchIsReadFromTheStructuredResult() throws {
        let line = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_A","type":"tool_result","content":[{"type":"text","text":"Started it."}]}]},"tool_use_result":{"status":"async_launched","agentId":"ab5d","outputFile":"/tmp/x/ab5d.output"}}"#
        let events = StreamEvent.events(in: line)
        #expect(events.first == .trace(.launchResult(id: "toolu_A", result: LaunchResult(agentID: "ab5d", outputFile: "/tmp/x/ab5d.output", background: true), parent: nil)))
        var book = TraceBook()
        book.apply(.toolUse(id: "toolu_A", tool: "Agent", title: "Delegate x", detail: "x", parent: nil))
        for case let .trace(event) in events { book.apply(event) }
        #expect(try #require(book.subagent("toolu_A")).isRunning)
        // Another tool's result is none.
        #expect(LaunchResult(["stdout": "hi", "interrupted": false]) == nil)
        #expect(LaunchResult(["backgroundTaskId": "bh62"])?.background == true)
    }

    @Test func aBackgroundShellCommandIsNoSubagent() {
        let bash = #"{"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_B","description":"cd /Users/me/app; swift build","task_type":"local_bash","is_backgrounded":true}"#
        // It is a chip under the reply (background work), not a subagent.
        #expect(StreamEvent.events(in: bash) == [.trace(.backgroundCommandStarted(id: "toolu_B", description: "cd /Users/me/app; swift build"))])
        let older = #"{"type":"system","subtype":"task_started","tool_use_id":"toolu_C","description":"swift test"}"#
        #expect(StreamEvent.events(in: older).isEmpty)
    }

    @Test func shellCommandsSavedAsSubagentsAreDroppedOnLoad() {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-bash-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var bash = Subagent(id: "B", description: "cd /Users/me/app; swift build", prompt: "")
        bash.status = .completed
        var agent = Subagent(id: "A", description: "Read a.txt", type: "general-purpose", prompt: "Read it")
        agent.status = .completed
        store.save(subagents: [bash, agent])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.subagents.map(\.id) == ["A"])
        #expect(store.loadSubagents().map(\.id) == ["A"])
    }

    @Test func aBackgroundSubagentRunsUntilItsNotification() {
        var book = TraceBook()
        for line in SubagentRun.lines.dropLast() {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event) }
        }
        // The call returned at once, but the subagent is still at work.
        let running = book.subagent("toolu_A")!
        #expect(running.isRunning)
        #expect(running.background)
        #expect(running.description == "Read a.txt and report content")
        #expect(running.steps.map(\.kind) == [.text, .tool])
        #expect(running.steps[1].output == "1\thello world")
        #expect(running.steps[1].done)
        #expect(book.steps.map(\.kind) == [.subagent])
        #expect(!book.steps[0].done)

        for case let .trace(event) in StreamEvent.events(in: SubagentRun.notification) { book.apply(event) }
        let ended = book.subagent("toolu_A")!
        #expect(ended.status == .completed)
        #expect(ended.result == "It says hello world.")
        #expect(book.steps[0].done)
    }

    /// The left column kept a finished subagent with a green dot (the colour of a bot that is
    /// awake) for half an hour, so it looked like it was still at work.
    @Test func aFinishedSubagentStopsLookingActiveAndLeavesTheList() {
        var book = TraceBook()
        let start = Date(timeIntervalSinceReferenceDate: 1_000_000)
        for line in SubagentRun.lines.dropLast() {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: start) }
        }
        #expect(book.listed(at: start).map(\.mark) == [.live])

        let end = start.addingTimeInterval(60)
        for case let .trace(event) in StreamEvent.events(in: SubagentRun.notification) { book.apply(event, at: end) }
        let listed = book.listed(at: end.addingTimeInterval(30))
        #expect(listed.map(\.id) == ["toolu_A"])
        #expect(listed.map(\.mark) == [.done])
        #expect(!listed.contains { $0.mark == .live })
        // A while later it is no longer listed at all.
        #expect(book.listed(at: end.addingTimeInterval(TraceBook.listedAfterEnding + 1)).isEmpty)
    }

    /// Settling a subagent's row takes it out of the left column without stopping it.
    @Test func aSettledSubagentLeavesTheListButKeepsRunning() {
        var book = TraceBook()
        let start = Date(timeIntervalSinceReferenceDate: 1_000_000)
        for line in SubagentRun.lines.dropLast() {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: start) }
        }
        #expect(book.listed(at: start).map(\.id) == ["toolu_A"])
        let first = book.settle("toolu_A", at: start)
        let twice = book.settle("toolu_A", at: start)
        let unknown = book.settle("nobody", at: start)
        #expect(first)
        #expect(!twice)
        #expect(!unknown)
        #expect(book.listed(at: start).isEmpty)
        // Still at work, and its report still comes in.
        #expect(book.subagent("toolu_A")?.isRunning == true)
        for case let .trace(event) in StreamEvent.events(in: SubagentRun.notification) { book.apply(event, at: start) }
        #expect(book.subagent("toolu_A")?.status == .completed)
        #expect(book.subagent("toolu_A")?.result == "It says hello world.")
        #expect(book.listed(at: start).isEmpty)
    }

    /// A settled row frees its place for an older one still within the list's limit.
    @Test func aSettledSubagentMakesRoomInTheList() {
        var book = TraceBook()
        let ids = (0...TraceBook.listedAtMost).map { "S\($0)" }
        for id in ids {
            book.apply(.subagentStarted(id: id, description: id, type: "general-purpose", prompt: "Do \(id)", background: true))
        }
        #expect(book.listed().map(\.id) == Array(ids.reversed().prefix(TraceBook.listedAtMost)))
        book.settle(ids.last!)
        #expect(book.listed().map(\.id) == Array(ids.dropLast().reversed()))
    }

    /// Running rows come first, then the rest; newest first within each. The cap keeps the
    /// first rows of that order.
    @Test func runningSubagentsAreListedFirstThenNewest() {
        var book = TraceBook()
        let start = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let ids = ["A", "B", "C", "D", "E", "F"]
        for (offset, id) in ids.enumerated() {
            book.apply(.subagentStarted(id: id, description: id, type: "general-purpose", prompt: "Do \(id)", background: true), at: start.addingTimeInterval(Double(offset)))
        }
        // A, C, E and F end; B and D keep running.
        for id in ["A", "C", "E", "F"] {
            book.apply(.subagentEnded(id: id, status: "completed", summary: nil), at: start.addingTimeInterval(10))
        }
        #expect(book.listed(at: start.addingTimeInterval(20)).map(\.id) == ["D", "B", "F", "E"])
    }

    /// Past the cap, "Show more" lists every row in the same order; `beyondCap` counts the
    /// rows the capped list leaves out, and settled ones do not count.
    @Test func theFullListGoesPastTheCap() {
        var book = TraceBook()
        let start = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let ids = (0..<(TraceBook.listedAtMost + 2)).map { "S\($0)" }
        for (offset, id) in ids.enumerated() {
            book.apply(.subagentStarted(id: id, description: id, type: "general-purpose", prompt: "Do \(id)", background: true), at: start.addingTimeInterval(Double(offset)))
        }
        let now = start.addingTimeInterval(20)
        let all = Array(ids.reversed())
        #expect(book.listed(at: now).map(\.id) == Array(all.prefix(TraceBook.listedAtMost)))
        #expect(book.listed(at: now, limit: nil).map(\.id) == all)
        #expect(book.beyondCap(at: now) == 2)
        book.settle(ids.last!)
        #expect(book.listed(at: now, limit: nil).map(\.id) == Array(all.dropFirst()))
        #expect(book.beyondCap(at: now) == 1)
        book.settle(ids[ids.count - 2])
        #expect(book.beyondCap(at: now) == 0)
        #expect(book.listed(at: now, limit: nil).count == TraceBook.listedAtMost)
    }

    @Test func aSettlingOutlivesARestart() {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-settle-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var kept = Subagent(id: "A", description: "Keep me", type: "general-purpose", prompt: "Keep")
        kept.status = .completed
        kept.endedAt = Date()
        var hidden = Subagent(id: "B", description: "Hide me", type: "general-purpose", prompt: "Hide")
        hidden.status = .completed
        hidden.endedAt = Date()
        store.save(subagents: [kept, hidden])

        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.trace.listed().map(\.id) == ["B", "A"])
        bot.settleSubagent("B")
        #expect(bot.trace.listed().map(\.id) == ["A"])
        #expect(bot.subagents.map(\.id) == ["A", "B"])
        #expect(store.loadSubagents().first { $0.id == "B" }?.isSettled == true)

        let again = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        #expect(again.trace.listed().map(\.id) == ["A"])
    }

    /// subagents.json written before rows could be settled still loads, every row listed.
    @Test func subagentsSavedBeforeSettlingStillLoad() throws {
        let json = #"[{"id":"A","description":"Old","prompt":"p","status":"completed","background":false,"startedAt":0,"steps":[]}]"#
        let loaded = try JSONDecoder().decode([Subagent].self, from: Data(json.utf8))
        #expect(loaded.map(\.isSettled) == [false])
    }

    /// A settled subagent moves to "Settled": running ones first, then newest first, and
    /// only the bot's own subagents (not ones a subagent sent off).
    @Test func settledSubagentsAreListedForTheRightColumn() {
        var book = TraceBook()
        let start = Date(timeIntervalSinceReferenceDate: 1_000_000)
        for (offset, id) in ["A", "B", "C"].enumerated() {
            book.apply(.subagentStarted(id: id, description: id, type: "general-purpose", prompt: "Do \(id)", background: true), at: start.addingTimeInterval(Double(offset)))
        }
        book.apply(.subagentEnded(id: "C", status: "completed", summary: nil), at: start.addingTimeInterval(5))
        #expect(book.settled.isEmpty)
        book.settle("A", at: start.addingTimeInterval(6))
        book.settle("C", at: start.addingTimeInterval(6))
        #expect(book.settled.map(\.id) == ["A", "C"])
        #expect(book.listed(at: start.addingTimeInterval(7)).map(\.id) == ["B"])
        // Settled long after it ended, it stays under "Settled" (it never times out there).
        #expect(book.settled.map(\.id) == ["A", "C"])
        // A settled one still runs: its end arrives and it stays settled.
        book.apply(.subagentEnded(id: "A", status: "completed", summary: nil), at: start.addingTimeInterval(8))
        #expect(book.subagent("A")?.status == .completed)
        #expect(book.settled.map(\.id) == ["C", "A"])
    }

    /// Bringing one back from "Settled" lists it again, and an ended one stays listed for a
    /// while from then even if it ended long ago.
    @Test func anUnsettledSubagentComesBackToTheLeftColumn() {
        var book = TraceBook()
        let start = Date(timeIntervalSinceReferenceDate: 1_000_000)
        book.apply(.subagentStarted(id: "A", description: "A", type: "general-purpose", prompt: "Do A", background: true), at: start)
        book.apply(.subagentEnded(id: "A", status: "completed", summary: nil), at: start.addingTimeInterval(1))
        book.settle("A", at: start.addingTimeInterval(2))
        let later = start.addingTimeInterval(TraceBook.listedAfterEnding * 3)
        #expect(book.listed(at: later).isEmpty)
        let first = book.unsettle("A", at: later)
        let twice = book.unsettle("A", at: later)
        let unknown = book.unsettle("nobody", at: later)
        #expect(first)
        #expect(!twice)
        #expect(!unknown)
        #expect(book.settled.isEmpty)
        #expect(book.listed(at: later.addingTimeInterval(60)).map(\.id) == ["A"])
        #expect(book.listed(at: later.addingTimeInterval(TraceBook.listedAfterEnding + 1)).isEmpty)
        // It can be settled again.
        let again = book.settle("A", at: later)
        #expect(again)
        #expect(book.settled.map(\.id) == ["A"])
    }

    /// Settling and bringing back are saved, and the 1.6 "dismissedAt" reads as settled.
    @Test func settlingIsSavedAndReadsTheOldName() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-unsettle-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var one = Subagent(id: "A", description: "One", type: "general-purpose", prompt: "One")
        one.status = .completed
        one.endedAt = Date()
        store.save(subagents: [one])
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        bot.settleSubagent("A")
        #expect(bot.trace.settled.map(\.id) == ["A"])
        bot.unsettleSubagent("A")
        #expect(bot.trace.settled.isEmpty)
        #expect(store.loadSubagents().first?.isSettled == false)
        #expect(store.loadSubagents().first?.unsettledAt != nil)

        let json = #"[{"id":"A","description":"Old","prompt":"p","status":"completed","background":false,"startedAt":0,"steps":[],"dismissedAt":10}]"#
        let loaded = try JSONDecoder().decode([Subagent].self, from: Data(json.utf8))
        #expect(loaded.map(\.isSettled) == [true])
        let saved = String(decoding: try JSONEncoder().encode(loaded), as: UTF8.self)
        #expect(saved.contains("\"dismissedAt\""))
    }

    @Test func aSubagentSavedAsRunningIsNotRunningAfterARestart() {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-restart-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let longAgo = Date().addingTimeInterval(-3600)
        let left = Subagent(id: "A", description: "Research developer mode", type: "general-purpose", prompt: "Look into it", background: true, startedAt: longAgo)
        store.save(subagents: [left])

        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.subagents.map(\.status) == [.stopped])
        #expect(bot.subagents.allSatisfy { !$0.isRunning })
        // It went away with the app an hour ago: it does not come back to the left column.
        #expect(bot.trace.listed().isEmpty)
        #expect(store.loadSubagents().map(\.status) == [.stopped])
    }

    @Test func aSubagentInTheForegroundEndsWithItsToolResult() {
        var book = TraceBook()
        book.apply(.toolUse(id: "A", tool: "Task", title: "Delegate Check the tests", detail: "Run the tests", parent: nil))
        book.apply(.subagentDescribed(id: "A", description: "Check the tests"))
        book.apply(.toolUse(id: "B", tool: "Bash", title: "Run swift test", detail: "swift test", parent: "A"))
        book.apply(.toolResult(id: "B", output: "fail", failed: true, parent: "A"))
        book.apply(.toolResult(id: "A", output: "Two tests fail.", failed: false, parent: nil))
        let subagent = book.subagent("A")!
        #expect(subagent.status == .completed)
        #expect(subagent.result == "Two tests fail.")
        #expect(subagent.description == "Check the tests")
        #expect(subagent.steps.first?.failed == true)
        #expect(book.steps.first?.done == true)
    }

    @Test func aReplyKeepsItsStepsButNotTheWordsThatAreTheReply() {
        var book = TraceBook()
        book.apply(.text("Let me look.", parent: nil))
        book.apply(.toolUse(id: "1", tool: "Read", title: "Read a.txt", detail: "/a.txt", parent: nil))
        book.apply(.toolResult(id: "1", output: "hi", failed: false, parent: nil))
        book.apply(.text("It says hi.", parent: nil))
        let steps = book.takeSteps()
        #expect(steps?.map(\.title) == ["Let me look.", "Read a.txt"])
        #expect(book.steps.isEmpty)
        book.apply(.text("Just words.", parent: nil))
        let none = book.takeSteps()
        #expect(none == nil)
    }

    @Test func runningSubagentsStopWithTheProcess() {
        var book = TraceBook()
        book.apply(.toolUse(id: "A", tool: "Agent", title: "Delegate x", detail: "x", parent: nil))
        let stopped = book.stopRunning()
        #expect(stopped)
        #expect(book.subagent("A")?.status == .stopped)
        let again = book.stopRunning()
        #expect(!again)
    }

    @Test func oldEndedSubagentsAreForgottenButRunningOnesStay() {
        var book = TraceBook()
        book.apply(.toolUse(id: "keep", tool: "Agent", title: "Delegate long", detail: "", parent: nil))
        for index in 0..<(TraceBook.keptSubagents + 5) {
            book.apply(.toolUse(id: "s\(index)", tool: "Agent", title: "Delegate \(index)", detail: "", parent: nil))
            book.apply(.toolResult(id: "s\(index)", output: "done", failed: false, parent: nil))
        }
        #expect(book.subagents.filter { !$0.isRunning }.count == TraceBook.keptSubagents)
        #expect(book.subagent("keep")?.isRunning == true)
        #expect(book.subagent("s0") == nil)
    }

    @Test func stoppingManyRunningOnesAtOnceKeepsTheNewest() {
        var book = TraceBook()
        for index in 0..<(TraceBook.keptSubagents + 3) {
            book.apply(.toolUse(id: "s\(index)", tool: "Agent", title: "Delegate \(index)", detail: "", parent: nil))
        }
        let stopped = book.stopRunning()
        #expect(stopped)
        #expect(book.subagents.count == TraceBook.keptSubagents)
        #expect(book.subagents.allSatisfy { $0.status == .stopped })
        #expect(book.subagents.last?.id == "s\(TraceBook.keptSubagents + 2)")
    }

    @Test func theBotShowsStepsLiveThenFoldsThemIntoItsReply() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-trace-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)

        bot.send("What does a.txt say?")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        await eventually { bot.liveSteps.count == 1 }
        #expect(bot.subagents.first?.isRunning == true)

        agent.reply("Sent a subagent to read it.")
        await eventually { bot.messages.last?.role == .bot }
        #expect(bot.messages.last?.steps?.map(\.kind) == [.subagent])
        #expect(bot.liveSteps.isEmpty)

        // It finishes after the reply; the card in the reply follows it, and it is saved.
        for line in SubagentRun.lines.dropFirst(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        await eventually { bot.subagents.first?.status == .completed }
        #expect(store.loadSubagents().first?.status == .completed)
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "" }
        #expect(payload.messages.last?.steps?.first?.status == "completed")
        #expect(payload.messages.last?.steps?.first?.count == 1)

        // A new start of the app finds it, not running any more.
        let again = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(again.subagents.first?.steps.count == 2)
    }

    @Test func aTurnItStartsItselfShowsAsWorkAndItWaitsForSubagentsBeforeSleeping() async {
        let fake = FakeLauncher()
        // Long enough that a busy main actor between two stream events does not count as idle.
        let bot = makeBot(fake, idle: 1)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Send a subagent off")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Sent it off.")
        await eventually { !bot.isWorking }

        // Idle well past its nap: it stays awake while the subagent works.
        try? await Task.sleep(for: .milliseconds(1_500))
        #expect(bot.phase == .awake)

        // The subagent's own steps do not count as the bot working.
        for line in SubagentRun.lines.dropFirst(3).dropLast() {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(!bot.isWorking)

        // It finishes; the bot starts a turn of its own to report.
        for event in StreamEvent.events(in: SubagentRun.notification) { agent.emit(event) }
        agent.emit(.trace(.text("Reporting back.", parent: nil)))
        await eventually { bot.isWorking }
        agent.reply("It says hello world.")
        await eventually { bot.messages.last?.text == "It says hello world." }
        await eventually { bot.phase == .asleep }
    }

    @Test func aSubagentStillWaitingOnItsOwnWorkWakesNoReply() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 5)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Transcribe the recording in a subagent")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Sent it off.")
        await eventually { !bot.isWorking }
        let shown = bot.messages.count

        // Its Monitor wakes it again and again; each time claude tells the bot it is still
        // waiting, and the bot has nothing new to say (it answers <no-reply/>).
        for _ in 0..<3 {
            #expect(StreamEvent.events(in: SubagentRun.waiting) == [.trace(.subagentWaiting(id: "toolu_A"))])
            for event in StreamEvent.events(in: SubagentRun.waiting) { agent.emit(event) }
            agent.emit(.trace(.text("<no-reply/>", parent: nil)))
            await eventually { bot.isWorking }
            agent.reply("<no-reply/>")
            await eventually { !bot.isWorking }
        }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(bot.messages.count == shown)
        #expect(bot.subagents.first?.isRunning == true)
        #expect(bot.phase == .awake)

        // It really finishes: that report shows.
        for event in StreamEvent.events(in: SubagentRun.notification) { agent.emit(event) }
        agent.emit(.trace(.text("Done.", parent: nil)))
        await eventually { bot.isWorking }
        agent.reply("It says hello world.")
        await eventually { bot.messages.last?.text == "It says hello world." }
        #expect(bot.messages.count == shown + 1)
        #expect(bot.subagents.first?.status == .completed)
    }

    @Test func whatYouSayWhileItWaitsQuietlyStillGetsAnAnswer() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 5)
        fake.respond = { text in
            text == Bot.resumeNote ? "<no-reply/>" : (isAppOnly(text) && !text.contains("How far") ? "OK" : nil)
        }
        bot.send("Transcribe the recording in a subagent")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Sent it off.")
        await eventually { !bot.isWorking }
        let shown = bot.messages.count
        for event in StreamEvent.events(in: SubagentRun.waiting) { agent.emit(event) }
        agent.emit(.trace(.text("Checking.", parent: nil)))
        await eventually { bot.isWorking }

        // You ask in the middle of that turn: it is paused for you, and its answer shows; the
        // waiting it carries on with after stays quiet.
        bot.send("How far along is it?")
        await eventually { agent.sent.contains { $0.contains("How far along is it?") } }
        agent.reply("About half done.")
        await eventually { bot.messages.last?.text == "About half done." }
        await eventually { agent.sent.contains(Bot.resumeNote) }
        await eventually { !bot.isWorking }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(bot.messages.last?.text == "About half done.")
        #expect(bot.messages.count == shown + 2)
    }

    // MARK: Turns claude starts itself (background work told it something)

    @Test func aNotificationWhileItWorksStillLetsTheNextTurnSayNothing() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake, idle: 5)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Build in the background and send a subagent off")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.emit(.trace(.toolUse(id: "toolu_B", tool: "Bash", title: "Run swift build", detail: "swift build", parent: nil)))
        agent.emit(.trace(.backgroundCommandStarted(id: "toolu_B", description: "swift build")))
        // claude tells it about its subagent while the turn is still under way.
        for event in StreamEvent.events(in: SubagentRun.waiting) { agent.emit(event) }
        agent.reply("Sent it off.")
        await eventually { bot.messages.last?.text == "Sent it off." }
        await eventually { !bot.isWorking }
        let shown = bot.messages.count
        let sentOff = shown - 1
        #expect(ChatPayload.backgroundRowIndex(in: bot.messages) == sentOff)

        // The turn that notification starts has nothing new: no bubble, not even early.
        agent.emit(.trace(.text("<no-reply/>", parent: nil)))
        await eventually { bot.isWorking }
        agent.emit(.earlyReply("<no-reply/>"))
        agent.reply("<no-reply/>")
        await eventually { !bot.isWorking }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(bot.messages.count == shown)
        #expect(bot.unreadCount == 1)
        // The background row stays on the reply that started the work.
        #expect(ChatPayload.backgroundRowIndex(in: bot.messages) == sentOff)

        // The build finishes: its chip says so without a bubble, and the turn with real news shows.
        let built = #"{"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"toolu_B","status":"completed","summary":"Background command \"swift build\" completed (exit code 0)"}"#
        for event in StreamEvent.events(in: built) { agent.emit(event) }
        await eventually { bot.messages[sentOff].backgroundTasks?.first { $0.id == "toolu_B" }?.isRunning == false }
        #expect(bot.messages.count == shown)
        agent.emit(.trace(.text("The build passes.", parent: nil)))
        await eventually { bot.isWorking }
        agent.reply("The build passes.")
        await eventually { bot.messages.last?.text == "The build passes." }
        #expect(bot.messages.count == shown + 1)
    }

    @Test func aTurnYouStartedAlwaysShowsEvenWithNoReply() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Anything new?")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.trace(.text("Nothing new yet. <no-reply/>", parent: nil)))
        agent.emit(.earlyReply("Nothing new yet. <no-reply/>"))
        await eventually { bot.messages.last?.role == .bot }
        #expect(bot.messages.last?.text == "Nothing new yet.")
        agent.reply("Nothing new yet. <no-reply/>")
        await eventually { !bot.isWorking }
        #expect(bot.messages.map(\.text) == ["Anything new?", "Nothing new yet."])

        // Not early either (no Stop hook): the result line shows, tag taken out.
        bot.send("And now?")
        await eventually { bot.isWorking }
        agent.reply("Still nothing. <no-reply/>")
        await eventually { !bot.isWorking }
        #expect(bot.messages.last?.text == "Still nothing.")
    }

    @Test func aNotificationWithoutItsCallIsStillRead() {
        let line = #"{"type":"system","subtype":"task_notification","task_id":"a35","status":"completed","summary":"It says hello world."}"#
        #expect(StreamEvent.events(in: line) == [.trace(.subagentEnded(id: "a35", status: "completed", summary: "It says hello world."))])
    }

    @Test func noReplyIsATagOutsideCodeOnly() {
        #expect(ReplyParser.saysNoReply("<no-reply/>"))
        #expect(ReplyParser.saysNoReply("  <no-reply />\n"))
        #expect(!ReplyParser.saysNoReply("Write `<no-reply/>` when there is nothing new."))
        #expect(ReplyParser.parseAll("Done. <no-reply/>").body == "Done.")
    }

    @Test func aRunningSubagentLeavesTheChatsTextAloneBetweenItsSteps() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Send a subagent off, then ask me")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Which one?\n<choices>\n* Alpha\n- Beta\n</choices>")
        await eventually { !bot.isWorking }
        for event in StreamEvent.events(in: SubagentRun.subagentSays) { agent.emit(event) }
        try? await Task.sleep(for: .milliseconds(50))

        // While it runs the app redraws often; the same chat must be the same text, so the
        // page is not sent it again (its question's frame would be redrawn for nothing).
        let make = { (now: Date) in ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, now: now) { _ in "" }.json() }
        let before = make(Date())
        #expect(before.contains("\"status\":\"running\""))
        #expect(make(Date().addingTimeInterval(5)) == before)

        // A step of its own changes its card only; the question reads the same.
        for event in StreamEvent.events(in: SubagentRun.subagentReads) { agent.emit(event) }
        try? await Task.sleep(for: .milliseconds(50))
        let after = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "" }
        let earlier = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "" }
        #expect(after == earlier)
        let question = after.messages.last
        #expect(question?.choices?.map(\.label) == ["Alpha", "Beta"])
        #expect(question?.steps?.first { $0.kind == "subagent" }?.count == 1)
    }

    @Test func aSubagentReadsLikeAConversation() {
        var subagent = Subagent(id: "A", description: "Read a.txt", type: "general-purpose", prompt: "Read a.txt")
        subagent.steps = [
            Step(id: "t", kind: .text, title: "Looking for it.", done: true),
            Step(id: "r", kind: .tool, tool: "Read", title: "Read a.txt", detail: "/a.txt", output: "hi", done: true),
        ]
        subagent.status = .completed
        subagent.result = "It says hi."
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        let payload = ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "")
        #expect(payload.messages.map(\.role) == ["user", "bot", "bot"])
        #expect(payload.messages.map(\.text) == ["Read a.txt", "Looking for it.", "It says hi."])
        #expect(payload.messages[2].steps?.map(\.title) == ["Read a.txt"])
        #expect(payload.subagent?.status == "completed")
        #expect(payload.subagent?.owner == bot.name)
        #expect(!payload.working)
    }

    // MARK: Tags in an earlier part of the reply

    /// A turn as claude streams it: words with a question, a tool call (it notes the question in
    /// its memory), and a short last line. The `result` line holds only that last line.
    enum AskThenSave {
        static let asks = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Which one should I do first?\n\n<choices>\n* Fix the login | Today\n- Write the docs | Later\n</choices>\n<plugin>Remember the last tab</plugin>"}]}}"#
        static let saves = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_M","name":"Edit","input":{"file_path":"/tmp/bot/memory.md","old_string":"a","new_string":"b"}}]}}"#
        static let saved = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_M","type":"tool_result","content":"The file has been updated."}]}}"#
        static let last = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Noted it in my memory."}]}}"#
        static let result = #"{"type":"result","subtype":"success","is_error":false,"result":"Noted it in my memory.","total_cost_usd":0.01}"#

        static var lines: [String] { [asks, saves, saved, last, result] }
    }

    @Test func choicesWrittenBeforeAToolCallStillEndTheReply() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-trace-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        let bot = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        var requests: [BotRequest] = []
        bot.onRequests = { requests += $0 }

        bot.send("What next?")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in AskThenSave.lines {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        await eventually { bot.messages.last?.role == .bot }
        let reply = bot.messages.last
        #expect(reply?.text == "Noted it in my memory.")
        #expect(reply?.choices?.map(\.label) == ["Fix the login", "Write the docs"])
        #expect(reply?.choices?.first?.recommended == true)
        #expect(requests == [.plugin(request: "Remember the last tab")])
        // The steps keep the words, not the tags that became the card and the request.
        let words = reply?.steps?.filter { $0.kind == .text }.map(\.title)
        #expect(words == ["Which one should I do first?"])
        #expect(reply?.steps?.contains { $0.title.contains("<choices>") || $0.title.contains("<plugin>") } == false)

        // Saved with it, so it reads the same after a restart.
        let again = Bot(profile: .main(home: home), launcher: fake.launcher, store: store)
        #expect(again.messages.last?.choices?.map(\.label) == ["Fix the login", "Write the docs"])

        // Picking one goes back to the bot as the answer.
        let id = reply!.id
        #expect(bot.choose(1, in: id))
        await eventually { agent.sent.contains { $0.contains("Write the docs") } }
    }

    @Test func aGroupTurnGetsChoicesFromAnEarlierPartToo() async {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let bot = makeBot(fake)
        bot.send("hi")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("Hello")
        await eventually { !bot.isWorking }

        let answer = Task { await bot.groupTurn("What next?") }
        await eventually { agent.sent.contains("What next?") }
        for line in AskThenSave.lines {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        guard case let .reply(text, _) = await answer.value else {
            Issue.record("no reply")
            return
        }
        let parsed = ReplyParser.parseAll(text)
        #expect(parsed.body == "Noted it in my memory.")
        #expect(parsed.choices?.map(\.label) == ["Fix the login", "Write the docs"])
    }

    @Test func theLastChoicesOfATurnWin() {
        let parsed = ReplyParser.parseAll("First?\n<choices>\n- A\n- B\n</choices>\nOr rather:\n<choices>\n- C\n- D\n</choices>")
        #expect(parsed.choices?.map(\.label) == ["C", "D"])
        #expect(!parsed.body.contains("<choices>"))
    }
}
