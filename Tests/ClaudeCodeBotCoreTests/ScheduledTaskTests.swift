import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A Monitor as claude 2.1.304 reports it: a Monitor call, a `local_bash` task started for its
/// command (`is_backgrounded`, the Monitor's description), "Monitor started" as the call's result,
/// then — after any number of events, which come as prompts and not as system lines — one
/// `task_notification` when the watch ends. Results and summaries copied from real transcripts,
/// trimmed to the fields the app reads.
enum MonitorRun {
    static let call = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_M","name":"Monitor","input":{"description":"gpu_ft_001 training progress","timeout_ms":1800000,"command":"tail -n +1 -F logs/gpu_ft_001.log | grep -E --line-buffered \"EVAL|Error\""}}]}}"#
    static let started = #"{"type":"system","subtype":"task_started","task_id":"ba9vh8415","tool_use_id":"toolu_M","description":"gpu_ft_001 training progress","is_backgrounded":true,"task_type":"local_bash"}"#
    static let launched = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_M","type":"tool_result","content":"Monitor started (task ba9vh8415, expires in 30m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply."}]}}"#
    static let streamEnded = #"{"type":"system","subtype":"task_notification","task_id":"ba9vh8415","tool_use_id":"toolu_M","status":"completed","output_file":"/tmp/x/tasks/ba9vh8415.output","summary":"Monitor \"gpu_ft_001 training progress\" stream ended"}"#
    static let scriptFailed = #"{"type":"system","subtype":"task_notification","task_id":"ba9vh8415","tool_use_id":"toolu_M","status":"failed","output_file":"","summary":"Monitor \"gpu_ft_001 training progress\" script failed (exit 255)"}"#
    /// Its deadline passed (or TaskStop): claude kills it and says "stopped".
    static let stopped = #"{"type":"system","subtype":"task_notification","task_id":"ba9vh8415","tool_use_id":"toolu_M","status":"stopped","output_file":"","summary":"Monitor \"gpu_ft_001 training progress\" stopped"}"#
    /// A Monitor on a WebSocket is a task of its own type.
    static let socketStarted = #"{"type":"system","subtype":"task_started","task_id":"w1","tool_use_id":"toolu_W","description":"deploy events","task_type":"monitor_ws"}"#
    /// claude's own sockets (live artifacts) are ambient: not the bot's work.
    static let ambientSocket = #"{"type":"system","subtype":"task_started","task_id":"w2","tool_use_id":"toolu_W","description":"live updates","task_type":"monitor_ws","ambient":true}"#

    static var turn: [String] { [call, started, launched] }
}

/// ScheduleWakeup and CronCreate / CronDelete calls with the results claude 2.1.304 gives them:
/// the words for the model (`content`) and the structured `tool_use_result` the app reads (copied
/// from a real `claude -p --output-format stream-json` run; ids and times changed to fit).
enum ScheduleRun {
    static let wakeup = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_S","name":"ScheduleWakeup","input":{"delaySeconds":1200,"reason":"check the deploy","prompt":"/loop check the deploy","noop":false}}]}}"#
    static let wakeupSet = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_S","type":"tool_result","content":"Next wakeup scheduled for 14:03:00 (in 1200s). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives."}]},"tool_use_result":{"scheduledFor":1800001200000,"clampedDelaySeconds":1200,"wasClamped":false}}"#
    static let stop = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_T","name":"ScheduleWakeup","input":{"stop":true}}]}}"#
    static let stopped = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_T","type":"tool_result","content":"Loop stopped — cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled. Then write it now as ordinary response text — and end the turn."}]},"tool_use_result":{"scheduledFor":0,"clampedDelaySeconds":0,"wasClamped":false,"stopped":true,"cancelledWakeups":1}}"#
    static let cron = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_C","name":"CronCreate","input":{"cron":"*/30 * * * *","prompt":"核對遠端 style_014 訓練進度：讀最新的 EVAL 行，用繁體中文簡短回報。"}}]}}"#
    static let cronSet = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_C","type":"tool_result","content":"Scheduled recurring job 5381432a (Every 30 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."}]},"tool_use_result":{"id":"5381432a","humanSchedule":"Every 30 minutes","recurring":true,"durable":false}}"#
    static let oneShot = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_O","name":"CronCreate","input":{"cron":"0 9 22 10 *","prompt":"Remind me to send the report","recurring":false}}]}}"#
    static let oneShotSet = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_O","type":"tool_result","content":"Scheduled one-shot task 1a2b3c4d (At 09:00 AM, on day 22 of the month, only in October). Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete."}]},"tool_use_result":{"id":"1a2b3c4d","humanSchedule":"At 09:00 AM, on day 22 of the month, only in October","recurring":false,"durable":false}}"#
    static let cronDelete = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_D","name":"CronDelete","input":{"id":"5381432a"}}]}}"#
    static let cronDeleted = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_D","type":"tool_result","content":"Cancelled job 5381432a."}]},"tool_use_result":{"id":"5381432a"}}"#
    /// A CronDelete that found no such job: an error, its `tool_use_result` a string.
    static let cronNotDeleted = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","content":"<tool_use_error>No scheduled job with id 'deadbeef'</tool_use_error>","is_error":true,"tool_use_id":"toolu_D"}]},"tool_use_result":"Error: No scheduled job with id 'deadbeef'"}"#
}

private func apply(_ lines: [String], to book: inout TraceBook, at date: Date) {
    for line in lines {
        for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: date) }
    }
}

@MainActor
struct ScheduledTaskTests {
    let start = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func aMonitorIsWaitingWorkWithItsDescription() throws {
        var book = TraceBook()
        apply(MonitorRun.turn, to: &book, at: start)
        let r1 = book.takeTasks()
        let task = try #require(r1?.first)
        #expect(task.id == "toolu_M")
        #expect(task.kind == .monitor)
        #expect(task.title == "gpu_ft_001 training progress")
        #expect(task.status == .running)
        #expect(task.detail?.hasPrefix("tail -n +1 -F logs/gpu_ft_001.log") == true)
    }

    @Test func aMonitorEndsDoneWhenItsSourceEndsOrItsTimeRunsOutAndFailedWhenItsScriptFails() throws {
        for (line, status) in [(MonitorRun.streamEnded, BackgroundTask.Status.completed), (MonitorRun.stopped, .completed), (MonitorRun.scriptFailed, .failed)] {
            var book = TraceBook()
            apply(MonitorRun.turn, to: &book, at: start)
            var messages = [ChatMessage(role: .bot, text: "Watching.")]
            messages[0].backgroundTasks = book.takeTasks()
            for case let .trace(.subagentEnded(id, ended, summary)) in StreamEvent.events(in: line) {
                messages.endBackgroundTask(id, status: ended, summary: summary, at: start.addingTimeInterval(600))
            }
            let task = try #require(messages[0].backgroundTasks?.first)
            #expect(task.status == status)
            #expect(task.summary?.hasPrefix("Monitor \"gpu_ft_001 training progress\"") == true)
        }
        // A background command stopped the same way is still cut short.
        var command = BackgroundTask(id: "B", kind: .command, title: "x")
        command.end("stopped", summary: nil, at: start)
        #expect(command.status == .killed)
    }

    @Test func aMonitorOnASocketIsReadFromItsOwnTaskType() {
        #expect(StreamEvent.events(in: MonitorRun.socketStarted) == [.trace(.monitorStarted(id: "toolu_W", description: "deploy events"))])
        #expect(StreamEvent.events(in: MonitorRun.ambientSocket).isEmpty)
        var book = TraceBook()
        book.apply(.toolUse(id: "toolu_W", tool: "Monitor", title: "Monitor", detail: "wss://x", parent: nil))
        for case let .trace(event) in StreamEvent.events(in: MonitorRun.socketStarted) { book.apply(event, at: start) }
        let r2 = book.takeTasks()
        #expect(r2?.map(\.kind) == [.monitor])
    }

    @Test func aScheduledWakeUpWaitsUntilItFires() throws {
        var book = TraceBook()
        apply([ScheduleRun.wakeup, ScheduleRun.wakeupSet], to: &book, at: start)
        let r3 = book.takeTasks()
        let task = try #require(r3?.first)
        #expect(task.kind == .wakeup)
        #expect(task.title == "check the deploy")
        #expect(task.fireAt == start.addingTimeInterval(1200))
        #expect(task.detail == "/loop check the deploy")
        #expect(task.holdsBotAwake(now: start.addingTimeInterval(1199)))

        var messages = [ChatMessage(role: .bot, text: "Next check in 20 minutes.")]
        messages[0].backgroundTasks = [task]
        #expect(messages.nextScheduleDue == start.addingTimeInterval(1200))
        let r4 = messages.settleDueSchedules(now: start.addingTimeInterval(1199))
        #expect(!r4)
        let r5 = messages.settleDueSchedules(now: start.addingTimeInterval(1260))
        #expect(r5)
        #expect(messages[0].backgroundTasks?.first?.status == .completed)
        #expect(messages[0].backgroundTasks?.first?.endedAt == start.addingTimeInterval(1200))
        #expect(messages.nextScheduleDue == nil)
        #expect(!messages.hasBackgroundWorkRunning(now: start.addingTimeInterval(1260)))
    }

    @Test func aWakeUpThatWasNotScheduledOrAStoppedLoopIsNoChip() {
        // The loop hit its limit: nothing scheduled.
        var book = TraceBook()
        let notScheduled = ScheduleRun.wakeupSet
            .replacingOccurrences(of: "Next wakeup scheduled for 14:03:00 (in 1200s).", with: "Wakeup not scheduled. The loop reached its maximum duration.")
            .replacingOccurrences(of: #""scheduledFor":1800001200000"#, with: #""scheduledFor":0"#)
        apply([ScheduleRun.wakeup, notScheduled], to: &book, at: start)
        let r6 = book.takeTasks()
        #expect(r6 == nil)
        // A stop call schedules nothing, and takes back what was pending.
        apply([ScheduleRun.stop, ScheduleRun.stopped], to: &book, at: start)
        let r7 = book.takeTasks()
        #expect(r7 == nil)
        #expect(BackgroundTask.Cancellation(tool: "ScheduleWakeup", result: Self.scheduleResult(in: ScheduleRun.stopped)) == .wakeups)
        #expect(BackgroundTask.Cancellation(tool: "ScheduleWakeup", result: Self.scheduleResult(in: ScheduleRun.wakeupSet)) == nil)
        // A refused call (an error) is no chip either.
        let refused = ScheduleRun.wakeupSet.replacingOccurrences(of: #""type":"tool_result","#, with: #""type":"tool_result","is_error":true,"#)
        apply([ScheduleRun.wakeup, refused], to: &book, at: start)
        let r8 = book.takeTasks()
        #expect(r8 == nil)
    }

    @Test func aCronJobWaitsWithItsScheduleUntilDeleted() throws {
        var book = TraceBook()
        apply([ScheduleRun.cron, ScheduleRun.cronSet, ScheduleRun.oneShot, ScheduleRun.oneShotSet], to: &book, at: start)
        let r9 = book.takeTasks()
        let tasks = try #require(r9)
        #expect(tasks.map(\.kind) == [.cron, .cron])
        #expect(tasks.map(\.jobID) == ["5381432a", "1a2b3c4d"])
        #expect(tasks.map(\.schedule) == ["*/30 * * * *", "0 9 22 10 *"])
        #expect(tasks.map(\.recurring) == [true, false])
        #expect(tasks[0].title == "核對遠端 style_014 訓練進度：讀最新的 EVAL 行，用繁體中文簡短回報。")
        // When each runs next (local time, as claude's scheduler does).
        let next = try #require(tasks[0].fireAt)
        #expect(next > start && next <= start.addingTimeInterval(30 * 60))
        #expect(Calendar.current.component(.minute, from: next) % 30 == 0)
        let once = try #require(tasks[1].fireAt)
        let parts = Calendar.current.dateComponents([.month, .day, .hour, .minute], from: once)
        #expect([parts.month, parts.day, parts.hour, parts.minute] == [10, 22, 9, 0])
        // A recurring job keeps its bot up (it lives in the session) and is due only when it expires.
        #expect(tasks[0].holdsBotAwake(now: start.addingTimeInterval(3 * 24 * 3600)))
        #expect(tasks[0].dueAt == start.addingTimeInterval(BackgroundTask.cronLasts))
        #expect(tasks[1].dueAt == once)

        // Deleted in a later turn: it leaves the list; the other one stays.
        var messages = [ChatMessage(role: .bot, text: "Checking every 30 minutes.")]
        messages[0].backgroundTasks = tasks
        let cancel = try #require(BackgroundTask.Cancellation(tool: "CronDelete", result: Self.scheduleResult(in: ScheduleRun.cronDeleted)))
        #expect(cancel == .cron("5381432a"))
        let r10 = messages.cancelScheduled(cancel)
        #expect(r10)
        #expect(messages[0].backgroundTasks?.map(\.jobID) == ["1a2b3c4d"])
        let r11 = messages.cancelScheduled(.cron("5381432a"))
        #expect(!r11)
        let r12 = messages.cancelScheduled(.cron("1a2b3c4d"))
        #expect(r12)
        #expect(messages[0].backgroundTasks == nil)
        #expect(Self.scheduleResult(in: ScheduleRun.cronNotDeleted) == nil)
        #expect(BackgroundTask.Cancellation(tool: "CronDelete", result: nil) == nil)
    }

    /// The structured result of a call, as the stream gives it to the bot.
    static func scheduleResult(in line: String) -> ScheduleResult? {
        StreamEvent.events(in: line).lazy.compactMap { event -> ScheduleResult? in
            if case let .trace(.scheduleResult(_, result)) = event { return result }
            return nil
        }.first
    }

    /// claude's words for the model change from version to version; what was scheduled is read
    /// from the call's `tool_use_result`, so other words (or another language) change nothing.
    @Test func scheduledWorkIsReadFromTheStructuredResultNotItsWords() throws {
        func reworded(_ line: String) -> String {
            line.replacingOccurrences(of: #"("content":")[^"]*(")"#, with: "$1Done: 好了$2", options: .regularExpression)
        }
        var book = TraceBook()
        apply([ScheduleRun.wakeup, reworded(ScheduleRun.wakeupSet), ScheduleRun.cron, reworded(ScheduleRun.cronSet)], to: &book, at: start)
        let taken = book.takeTasks()
        let tasks = try #require(taken)
        #expect(tasks.map(\.kind) == [.wakeup, .cron])
        #expect(tasks[0].fireAt == Date(timeIntervalSince1970: 1_800_001_200))
        #expect(tasks[1].jobID == "5381432a")
        #expect(BackgroundTask.Cancellation(tool: "CronDelete", result: Self.scheduleResult(in: reworded(ScheduleRun.cronDeleted))) == .cron("5381432a"))
        #expect(BackgroundTask.Cancellation(tool: "ScheduleWakeup", result: Self.scheduleResult(in: reworded(ScheduleRun.stopped))) == .wakeups)
        // CronCreate's own next run, when claude gives it (2.1.304 does).
        let withNext = ScheduleRun.cronSet.replacingOccurrences(of: #""durable":false"#, with: #""durable":false,"nextFireAt":1800000900000"#)
        var other = TraceBook()
        apply([ScheduleRun.cron, withNext], to: &other, at: start)
        let next = other.takeTasks()
        #expect(next?.first?.fireAt == Date(timeIntervalSince1970: 1_800_000_900))
    }

    @Test func nextTimeOfACronLine() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Taipei")!
        let date = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 12, minute: 10, second: 30)))
        func next(_ line: String) -> DateComponents? {
            CronSchedule(line)?.nextTime(after: date, calendar: calendar).map { calendar.dateComponents([.month, .day, .hour, .minute], from: $0) }
        }
        #expect(next("*/30 * * * *") == DateComponents(month: 10, day: 21, hour: 12, minute: 30))
        #expect(next("0 9 * * *") == DateComponents(month: 10, day: 22, hour: 9, minute: 0))
        #expect(next("0 9 * * 1") == DateComponents(month: 10, day: 26, hour: 9, minute: 0))
        #expect(next("0 0 1 1 *") == DateComponents(month: 1, day: 1, hour: 0, minute: 0))
        #expect(next("0 0 31 2 *") == nil)
    }

    @Test func thePayloadSaysWhenScheduledWorkFires() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-sched-\(UUID().uuidString)")
        let store = BotStore(directory: home.appending(path: "store"))
        var message = ChatMessage(role: .bot, text: "Set.")
        var wakeup = BackgroundTask(id: "S", kind: .wakeup, title: "check the deploy", startedAt: Date(timeIntervalSince1970: 100))
        wakeup.fireAt = Date(timeIntervalSince1970: 1300)
        var cron = BackgroundTask(id: "C", kind: .cron, title: "核對", startedAt: Date(timeIntervalSince1970: 100))
        cron.schedule = "0 9 * * *"
        cron.recurring = true
        cron.jobID = "5381432a"
        message.backgroundTasks = [wakeup, cron]
        store.save(messages: [message])
        // Kept as they were saved (their bot's process is not running, so they went with it).
        let saved = store.loadMessages()[0].backgroundTasks
        #expect(saved?.map(\.kind) == [.wakeup, .cron])
        #expect(saved?[1].jobID == "5381432a")
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.messages[0].backgroundTasks?.map(\.status) == [.interrupted, .interrupted])
        let payload = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "data:bot" }
        let object = try #require(try JSONSerialization.jsonObject(with: Data(payload.json().utf8)) as? [String: Any])
        let tasks = try #require((object["messages"] as? [[String: Any]])?[0]["tasks"] as? [[String: Any]])
        #expect(tasks.map { $0["kind"] as? String } == ["wakeup", "cron"])
        #expect(tasks[0]["fires"] as? Double == 1_300_000)
        #expect(tasks[1]["schedule"] as? String == "0 9 * * *")
        #expect(tasks[1]["recurring"] as? Bool == true)
        // Cut off with its session: the bot hears of it as what it was.
        let note = try #require(Bot.interruptedNote(bot.messages))
        #expect(note.contains("scheduled wake-up (ScheduleWakeup) \"check the deploy\""))
        #expect(note.contains("cron job (CronCreate 0 9 * * *) \"核對\""))
    }

    @Test func aBotSettlesAFiredWakeUpAndDropsADeletedCronJob() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        var clock = start
        bot.now = { clock }
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        bot.send("Check the deploy every 20 minutes, and the training every 30")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in [ScheduleRun.wakeup, ScheduleRun.wakeupSet, ScheduleRun.cron, ScheduleRun.cronSet] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Set both.")
        await eventually { bot.messages.last?.text == "Set both." && !bot.isWorking }
        #expect(bot.messages.last?.backgroundTasks?.map(\.kind) == [.wakeup, .cron])
        #expect(bot.messages.last?.backgroundTasks?.map(\.status) == [.running, .running])
        // Sleeping would end the session they fire in.
        await bot.goToSleep()
        #expect(bot.phase == .awake)

        // 20 minutes on, the wake-up fires: claude is at work again.
        clock = start.addingTimeInterval(1205)
        for line in [ScheduleRun.cronDelete, ScheduleRun.cronDeleted] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Deploy is fine; stopped the training check.")
        await eventually { bot.messages.last?.text == "Deploy is fine; stopped the training check." }
        let tasks = try #require(bot.messages.last { $0.backgroundTasks != nil }?.backgroundTasks)
        #expect(tasks.map(\.kind) == [.wakeup])
        #expect(tasks[0].status == .completed)
        #expect(!bot.messages.hasBackgroundWorkRunning(now: clock))
    }
}
