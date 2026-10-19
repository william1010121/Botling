import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// M1 acceptance against the real `claude`, with the 50-minute nap shortened to 15 seconds.
/// Costs a few Haiku turns, so it only runs with `CCB_LIVE=1 swift test --filter Live`.
@MainActor
struct LiveClaudeTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func wakesSleepsAndRemembersThroughMemoryFile() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }

        let bot = Bot(
            profile: .main(home: home),
            defaultModel: .haiku,
            idleInterval: 15,
            exitTimeout: 60,
            launcher: ClaudeAgentProcess.launcher(executable: executable)
        )

        bot.send("Please remember: my favorite color is teal. Just reply \"OK\".")
        await eventually({ bot.messages.count == 2 }, timeout: 120)
        print("reply 1:", bot.messages.last?.text ?? "")
        #expect(bot.messages.last?.role == .bot)

        await eventually({ bot.phase == .asleep }, timeout: 180)
        let memory = try String(contentsOf: home.appending(path: "memory.md"), encoding: .utf8)
        print("memory.md:\n\(memory)")
        #expect(memory.lowercased().contains("teal"))

        bot.send("What is my favorite color?")
        await eventually({ bot.messages.count == 4 }, timeout: 120)
        let answer = bot.messages.last?.text ?? ""
        print("reply 2:", answer)
        #expect(answer.lowercased().contains("teal"))
    }

    /// M2 acceptance: the main bot answers from a sleeping manager's memory.md without waking it,
    /// and hands work over through inbox.md.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func mainBotReadsManagerMemoryAndHandsOverWork() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        let launches = LaunchLog()
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: { launch in
                launches.record(launch.workingDirectory)
                return try real(launch)
            }, store: store)
        }
        let project = workspace.addProject(folder: folder)
        try """
        ## Current status
        The watering schedule is half done, stuck on whether to support succulents.
        ## In progress
        - Watering schedule
        ## Waiting on you
        - Should we support succulents?
        ## Decided
        - 2026-10-18 Store data in SQLite
        """.write(to: project.notesFolder.appending(path: "memory.md"), atomically: true, encoding: .utf8)
        workspace.select(nil)

        workspace.mainBot.send("How is garden doing?")
        await eventually({ workspace.mainBot.messages.count == 2 }, timeout: 120)
        let status = workspace.mainBot.messages.last?.text ?? ""
        print("status:", status)
        #expect(status.lowercased().contains("watering") || status.lowercased().contains("succulent"))
        #expect(!launches.directories.contains { $0.lastPathComponent == "garden" })

        workspace.mainBot.send("Have garden write one line, \"Hello garden\", in README.md. Just hand it over.")
        let manager = try #require(workspace.bot(for: project))
        await eventually({ manager.messages.contains { $0.role == .bot } }, timeout: 180)
        print("relay:", manager.messages.first?.text ?? "")
        print("manager:", manager.messages.last?.text ?? "")
        #expect(manager.messages.first?.role == .relay)
        #expect(launches.directories.contains { $0.lastPathComponent == "garden" })
        let readme = (try? String(contentsOf: folder.appending(path: "README.md"), encoding: .utf8)) ?? ""
        print("README:", readme)
        #expect(readme.contains("Hello garden"))
        await workspace.putEveryoneToSleep()
    }
}

extension LiveClaudeTests {
    /// M3 acceptance: a manager stuck on a decision asks with buttons; the question shows up in
    /// the main bot's chat; picking there makes the manager carry on.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func managerAsksWithButtonsAndContinuesAfterAPick() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }
        let project = workspace.addProject(folder: folder)
        let manager = try #require(workspace.bot(for: project))
        workspace.select(nil)

        manager.relay("Write one line introducing this project in README.md. Whether the title is \"Garden\" or \"Plant Diary\" is the user's call: ask first, and write it once they pick.")
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice } }, timeout: 180)
        let notice = try #require(workspace.mainBot.messages.last { $0.role == .notice })
        print("notice:", notice.text, notice.choices?.map(\.label) ?? [])
        #expect(notice.isOpenQuestion)
        #expect(workspace.waiting.count == 1)

        let pick = try #require(notice.choices?.firstIndex { $0.label.contains("Plant Diary") })
        #expect(workspace.choose(pick, in: notice.id, of: workspace.mainBot))
        await eventually({ manager.messages.last?.role == .bot && manager.openQuestion == nil && !manager.isWorking }, timeout: 180)
        print("manager:", manager.messages.last?.text ?? "")
        let readme = (try? String(contentsOf: folder.appending(path: "README.md"), encoding: .utf8)) ?? ""
        print("README:", readme)
        #expect(readme.contains("Plant Diary"))
        #expect(workspace.waiting.isEmpty)
        await workspace.putEveryoneToSleep()
    }
}

extension LiveClaudeTests {
    /// M4 acceptance: the daily summary runs at its time and is written from managers' memory.md.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func dailySummaryReadsManagersWithoutWakingThem() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        let launches = LaunchLog()
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: { launch in
                launches.record(launch.workingDirectory)
                return try real(launch)
            }, store: store)
        }
        let project = workspace.addProject(folder: folder)
        try """
        ## Current status
        The watering schedule is done; now writing reminder notifications.
        ## Waiting on you
        - Should reminders be macOS notifications or emails?
        """.write(to: project.notesFolder.appending(path: "memory.md"), atomically: true, encoding: .utf8)
        workspace.select(nil)

        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
        workspace.checkRoutines(now: Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow)!)
        workspace.checkRoutines(now: Calendar.current.date(bySettingHour: 8, minute: 15, second: 0, of: tomorrow)!)
        await eventually({ workspace.mainBot.messages.last?.role == .bot }, timeout: 120)
        let summary = workspace.mainBot.messages.last?.text ?? ""
        print("summary:", summary)
        #expect(workspace.mainBot.messages.first?.text == "Daily summary · 08:15")
        #expect(summary.lowercased().contains("notification") || summary.lowercased().contains("email"))
        #expect(!launches.directories.contains { $0.lastPathComponent == "garden" })
        await workspace.putEveryoneToSleep()
    }
}

extension LiveClaudeTests {
    /// M5 acceptance: a wish that belongs to no project pulls up a temporary team on its own, and
    /// a result page comes back to the main bot's chat without the user stepping in.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func wishOutsideProjectsComesBackAsAResultPage() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: real) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }

        workspace.mainBot.send("Make me a short one-page comparison: who the Pomodoro technique and the 52/17 method each suit. This belongs to no project; no need to go online, just write what you already know.")
        await eventually({ !workspace.runningTeams.isEmpty || workspace.mainBot.messages.contains { $0.role == .notice } }, timeout: 120)
        print("main:", workspace.mainBot.messages.first { $0.role == .bot }?.text ?? "")
        await eventually({ workspace.mainBot.messages.contains { $0.role == .notice } }, timeout: 600)
        let notice = workspace.mainBot.messages.last { $0.role == .notice }?.text ?? ""
        print("notice:", notice)
        let result = try #require(workspace.mainBot.results.first)
        print("result:", result.url.path)
        #expect(result.url.isFileURL)
        #expect(FileManager.default.fileExists(atPath: result.url.path))
        let page = (try? String(contentsOf: result.url, encoding: .utf8)) ?? ""
        #expect(page.contains("Pomodoro"))
        #expect(result.url.path.contains("/runs/"))
        await workspace.putEveryoneToSleep()
    }

    /// M6 acceptance (P5: through Maintainer): a report beside a component reaches Maintainer,
    /// which edits the template; ClaudeCodeBot sees the new version without a restart.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func componentTeamEditsTheTemplateOnRequest() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: real) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }
        let library = workspace.components
        let version = library.versions["choices", default: 0]

        workspace.requestComponentChange("choices", request: "Make the minimum height of each option button 56px.", from: "The user")
        await eventually({ library.working.isEmpty }, timeout: 300)
        let template = library.template("choices") ?? ""
        print("notice:", workspace.mainBot.messages.last?.text ?? "")
        #expect(template.contains("56px"))
        await eventually { library.hasPrevious("choices") }
        #expect(library.updated.contains("choices"))
        #expect(library.versions["choices", default: 0] > version)
    }
}

extension LiveClaudeTests {
    /// Asked in chat to remove a routine, the bot edits its routines.cron and ClaudeCodeBot picks it up.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func botRemovesARoutineWhenAsked() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: real) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }
        #expect(workspace.mainBot.routines.map(\.title) == ["Daily summary"])

        workspace.mainBot.send("Remove the daily summary one. Also add a \"Friday review\" every Friday at 18:00: sum up what each project got done this week.")
        await eventually({ workspace.mainBot.messages.last?.role == .bot }, timeout: 120)
        print("reply:", workspace.mainBot.messages.last?.text ?? "")
        print("file:\n" + ((try? String(contentsOf: root.appending(path: "ccb/main/routines.cron"), encoding: .utf8)) ?? ""))
        #expect(!workspace.mainBot.routines.contains { $0.title == "Daily summary" && $0.enabled })
        let review = try #require(workspace.mainBot.routines.first { $0.title.contains("Friday review") })
        #expect(review.schedule.matches(Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 23, hour: 18, minute: 0))!))
        await workspace.putEveryoneToSleep()
    }
}

extension LiveClaudeTests {
    /// The user's own report: "Shouldn't there at least be an Other?" Maintainer alone adds an "Other" answer
    /// through ccb.answer, updates the usage every bot reads, and commits it (P5 acceptance).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func componentTeamAddsOtherOnItsOwn() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let ccb = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../.build/debug/ClaudeCodeBot").standardizedFileURL
        let workspace = Workspace(
            root: root.appending(path: "ccb"),
            builtInPlugins: URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/ClaudeCodeBot/Resources/plugins").standardizedFileURL,
            checkCommand: "env -u CLAUDECODE '\(ccb.path)' --check-plugin",
            launcher: real
        ) { profile, store in
            Bot(profile: profile, defaultModel: profile.name == "Maintainer" ? .sonnet : .haiku, launcher: real, store: store)
        }
        await workspace.pluginLibraryReady.value
        let library = workspace.components

        let version = library.versions["choices", default: 0]
        workspace.requestComponentChange("choices", request: "Shouldn't there at least be an Other option?", from: "The user")
        await eventually({ library.working.isEmpty }, timeout: 600)
        print("maintainer:", workspace.maintainer.messages.map { "\($0.role): \($0.text)" }.joined(separator: "\n"))
        #expect(library.versions["choices", default: 0] > version)
        library.rescan()
        let template = library.template("choices") ?? ""
        let about = (try? String(contentsOf: library.aboutURL("choices"), encoding: .utf8)) ?? ""
        print("notice:", workspace.mainBot.messages.last?.text ?? "")
        print("about:\n" + about)
        #expect(template.contains("Other"))
        #expect(template.contains("ccb.answer("))
        #expect(template.contains("input") || template.contains("textarea"))
        #expect(about.contains("Other"))
        #expect(workspace.componentBriefing().contains("Other"))
        let log = workspace.plugins.git.commits("ccb-components")
        print("commits:", log.count, workspace.plugins.git.run(["log", "--oneline", "-3"]).output)
        #expect(log.count >= 2)
        #expect(!workspace.plugins.git.isDirty("ccb-components"))
        if let path = ProcessInfo.processInfo.environment["CCB_LIVE_KEEP_TEMPLATE"] {
            try? template.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }
}

extension LiveClaudeTests {
    /// You send a picture; the bot sees it, and the file is kept where it can open it again.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func botSeesAnImageYouSend() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let picture = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../docs/flowcharts/flow-4-lifecycle.png").standardizedFileURL
        let bot = Bot(profile: .main(home: root), defaultModel: .haiku, launcher: ClaudeAgentProcess.launcher(executable: executable))

        bot.send("What does the first box in the top-left corner of this picture say? Reply with only the first line of that box.", files: [picture], replyingTo: nil)
        await eventually({ bot.messages.last?.role == .bot }, timeout: 120)
        let answer = bot.messages.last?.text ?? ""
        print("answer:", answer)
        #expect(answer.contains("Asleep"))
        #expect(FileManager.default.fileExists(atPath: root.appending(path: "attachments").path))
        await bot.goToSleep()
    }
}

final class LaunchLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _directories: [URL] = []

    func record(_ directory: URL) {
        lock.withLock { _directories.append(directory) }
    }

    var directories: [URL] { lock.withLock { _directories } }
}
