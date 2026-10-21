import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// 2026-10-20 (a Tuesday) at hh:mm, local time.
func day(_ hour: Int, _ minute: Int, plusDays: Int = 0) -> Date {
    Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 20 + plusDays, hour: hour, minute: minute))!
}

struct CronTests {
    @Test func dailyLine() throws {
        let routine = try #require(Routine.parse(RoutineFile.dailySummary))
        #expect(routine.title == "Daily summary")
        #expect(routine.instruction.hasPrefix("Read each project's memory file"))
        #expect(routine.enabled)
        #expect(routine.schedule.description == "Every day 08:15")
        #expect(routine.schedule.matches(day(8, 15)))
        #expect(!routine.schedule.matches(day(8, 16)))
    }

    /// Whether a routine runs every day at one time comes from its fields, not its description.
    @Test func everyDayTimeIsReadFromTheFields() throws {
        let daily = try #require(CronSchedule("15 8 * * *")?.everyDayTime)
        #expect(daily.hour == 8 && daily.minute == 15)
        #expect(CronSchedule("0 9 * * 1-5")?.everyDayTime == nil)
        #expect(CronSchedule("0 9 1 * *")?.everyDayTime == nil)
        #expect(CronSchedule("0 9 * 6 *")?.everyDayTime == nil)
        #expect(CronSchedule("0,30 9 * * *")?.everyDayTime == nil)
        // Every weekday listed is every day too.
        #expect(CronSchedule("0 7 * * 0-6")?.everyDayTime?.hour == 7)
    }

    @Test func pausedLinesAndCommentsAndFiles() throws {
        let paused = try #require(Routine.parse("#0 18 * * 5 Friday review: Sum up what got done this week"))
        #expect(!paused.enabled)
        #expect(paused.schedule.description == "Fri 18:00")
        #expect(Routine.parse("# minute hour day month weekday  Name: what to do") == nil)
        let standup = try #require(Routine.parse("0 9 * * 1-5 Standup: @notes/standup.md"))
        #expect(standup.file == "notes/standup.md")
        #expect(standup.schedule.description == "Weekdays 09:00")
        #expect(!standup.schedule.matches(day(9, 0, plusDays: 5)))   // Sunday
        #expect(standup.schedule.matches(day(9, 0)))
    }

    @Test func stepsListsAndBadLines() throws {
        let every15 = try #require(CronSchedule("*/15 9-17 * * *"))
        #expect(every15.matches(day(9, 45)))
        #expect(!every15.matches(day(9, 50)))
        #expect(!every15.matches(day(18, 0)))
        #expect(CronSchedule("61 * * * *") == nil)
        #expect(CronSchedule("* * *") == nil)
        #expect(CronSchedule("0 8 * * 7")?.matches(day(8, 0, plusDays: 5)) == true)   // 7 = Sunday
    }

    @Test func lastTimeLooksBackWithinTheDay() throws {
        let schedule = try #require(CronSchedule("15 8 * * *"))
        let start = Calendar.current.startOfDay(for: day(13, 0))
        #expect(schedule.lastTime(atOrBefore: day(13, 0), notBefore: start) == day(8, 15))
        #expect(schedule.lastTime(atOrBefore: day(8, 0), notBefore: Calendar.current.startOfDay(for: day(8, 0))) == nil)
    }

    @Test func editingTheFileKeepsCommentsAndOtherLines() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "cron-\(UUID().uuidString)/routines.cron")
        let file = RoutineFile(url: url)
        file.create(with: [RoutineFile.dailySummary, "0 9 * * 1-5 Standup: @standup.md"])
        let summary = try #require(file.load().first)

        file.setEnabled(summary.id, false)
        #expect(file.load().first?.enabled == false)
        let paused = try #require(file.load().first)
        file.setTime(paused.id, hour: 7, minute: 30)
        #expect(file.load().first?.schedule.text == "30 7 * * *")
        file.remove(try #require(file.load().first).id)

        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.hasPrefix("# Routines"))
        #expect(file.load().map(\.title) == ["Standup"])
    }
}

@MainActor
struct RoutineTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-routine-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func makeProject(_ workspace: Workspace, _ name: String) throws -> Workspace.Project {
        let folder = root.appending(path: "code/\(name)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return workspace.addProject(folder: folder)
    }

    @Test func mainBotStartsWithADailySummaryFileAndManagersWithAnEmptyOne() throws {
        let workspace = makeWorkspace(FakeLauncher())
        #expect(workspace.mainBot.routines.map(\.title) == ["Daily summary"])
        let mainFile = root.appending(path: "ccb/main/routines.cron")
        #expect(try String(contentsOf: mainFile, encoding: .utf8).contains("15 8 * * * Daily summary:"))

        let project = try makeProject(workspace, "a")
        #expect(workspace.bot(for: project)?.routines.isEmpty == true)
        #expect(FileManager.default.fileExists(atPath: project.notesFolder.appending(path: "routines.cron").path))
    }

    @Test func summaryRunsAtItsTimeOnceAndReadsProjectsWithoutWakingThem() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "Good morning. garden is waiting on you to pick a title." }
        let workspace = makeWorkspace(fake)
        let project = try makeProject(workspace, "garden")
        workspace.select(nil)

        workspace.checkRoutines(now: day(8, 0))   // first sight: counts from here
        #expect(fake.agents.isEmpty)
        workspace.checkRoutines(now: day(8, 15))
        await eventually { workspace.mainBot.messages.last?.role == .bot }
        workspace.checkRoutines(now: day(8, 16))

        #expect(fake.agents.count == 1)
        #expect(fake.agents[0].launch.workingDirectory.lastPathComponent == "main")
        let prompt = try #require(fake.agents[0].sent.first)
        #expect(prompt.contains("Time for the routine \"Daily summary\". Read each project's memory file"))
        #expect(prompt.contains(project.inboxURL.path))
        #expect(workspace.mainBot.messages.map(\.role) == [.divider, .bot])
        #expect(workspace.mainBot.messages[0].text == "Daily summary · 08:15")
    }

    @Test func aJobSeenAfterItsTimeStartsTomorrow() {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        workspace.checkRoutines(now: day(13, 0))
        workspace.checkRoutines(now: day(13, 1))
        #expect(fake.agents.isEmpty)
        workspace.checkRoutines(now: day(8, 15, plusDays: 1))
        #expect(fake.agents.count == 1)
    }

    @Test func aMissedTimeRunsOnceLaterThatDay() {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        workspace.checkRoutines(now: day(7, 0))
        // Asleep or closed from 07:00 to 13:00.
        workspace.checkRoutines(now: day(13, 0))
        #expect(fake.agents.count == 1)
    }

    @Test func theBotEditingItsFileIsPickedUp() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let file = root.appending(path: "ccb/main/routines.cron")
        // The bot removes the daily summary by rewriting its file, as it is told to.
        fake.respond = { text in
            if text.hasSuffix("Remove the daily summary") {
                try? "# Routines\n#0 18 * * 5 Friday review: Sum up what got done this week\n".write(to: file, atomically: true, encoding: .utf8)
                return "Removed the daily summary."
            }
            return nil
        }

        workspace.mainBot.send("Remove the daily summary")
        await eventually { workspace.mainBot.messages.last?.role == .bot }

        #expect(workspace.mainBot.routines.map(\.title) == ["Friday review"])
        #expect(workspace.mainBot.routines.first?.enabled == false)
    }

    @Test func botsAreToldWhereTheirRoutinesLive() {
        let main = BotPrompts(profile: .main(home: URL(filePath: "/tmp/main")))
        #expect(main.system.contains("routines.cron"))
        let manager = BotPrompts(profile: .manager(name: "g", avatar: "square", folder: URL(filePath: "/tmp/g")))
        #expect(manager.system.contains(".bot/routines.cron"))
    }

    @Test func managerRoutineReportsInItsOwnChat() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "All tests pass." }
        let workspace = makeWorkspace(fake)
        let project = try makeProject(workspace, "garden")
        let manager = try #require(workspace.bot(for: project))
        workspace.select(nil)
        workspace.mainBot.setRoutine(workspace.mainBot.routines[0].id, enabled: false)
        manager.addRoutine(title: "Run tests", instruction: "Run the tests once", hour: 9, minute: 0)

        workspace.checkRoutines(now: day(7, 0))
        workspace.checkRoutines(now: day(9, 0))
        await eventually { manager.messages.contains { $0.text == "All tests pass." } }

        #expect(fake.agents.count == 1)
        #expect(fake.agents[0].sent.first?.contains("Time for the routine \"Run tests\": Run the tests once") == true)
        #expect(manager.hasUnread)
        #expect(!workspace.mainBot.messages.contains { $0.role == .notice })
    }

    @Test func oldSettingsMoveIntoTheFile() throws {
        let home = root.appending(path: "legacy")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        // Older builds saved the daily summary's title in Chinese; this is that saved data.
        let old = #"{"model":"sonnet","routines":[{"id":"00000000-0000-0000-0000-000000000001","title":"每日摘要","instruction":"","hour":8,"minute":15,"enabled":false}]}"#
        try old.write(to: home.appending(path: "bot.json"), atomically: true, encoding: .utf8)

        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher, store: BotStore(directory: home))
        #expect(bot.routines.first?.title == "Daily summary")
        #expect(bot.routines.first?.enabled == false)
        #expect(bot.routines.first?.instruction.hasPrefix("Read each project") == true)
    }
}
