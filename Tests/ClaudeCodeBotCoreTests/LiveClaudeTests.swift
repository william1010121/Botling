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

    /// The same bot on Codex (`codex app-server`): a reply, a step for the command it ran,
    /// memory.md written before it sleeps, and a fresh session that reads it.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func aBotOnCodexWakesSleepsAndRemembers() async throws {
        let executable = try #require(CodexCLI.newestExecutable())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-codex-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let threads = CodexThreads(folder: home.appending(path: "codex-threads"))
        let store = BotStore(directory: home.appending(path: "store"))
        store.save(engine: .codex)

        let bot = Bot(profile: .main(home: home), idleInterval: 30, exitTimeout: 60, launcher: CodexAgentProcess.launcher(executable: executable, threads: threads), store: store)
        #expect(bot.engine == .codex)

        bot.send("Please remember: my favorite color is teal. Run the shell command `pwd` once, then reply \"OK\".")
        await eventually({ bot.messages.count == 2 && !bot.isWorking }, timeout: 180)
        let first = bot.messages.last
        print("reply 1:", first?.text ?? "", "steps:", first?.steps?.map(\.title) ?? [])
        #expect(first?.role == .bot)
        #expect(first?.steps?.contains { $0.tool == "Bash" && $0.done } == true)

        await eventually({ bot.phase == .asleep }, timeout: 240)
        let memory = try String(contentsOf: home.appending(path: "memory.md"), encoding: .utf8)
        print("memory.md:\n\(memory)")
        #expect(memory.lowercased().contains("teal"))

        bot.send("What is my favorite color?")
        await eventually({ bot.messages.count == 4 && !bot.isWorking }, timeout: 180)
        let answer = bot.messages.last?.text ?? ""
        print("reply 2:", answer)
        #expect(answer.lowercased().contains("teal"))
    }

    /// One bot, both heads, the real CLIs, both processes alive at once: Codex answers a
    /// message named for it, then Claude, woken for its own, knows what Codex said, and the
    /// chat marks Codex's line as seen by both.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func twoHeadsWorkSideBySideAndSeeEachOther() async throws {
        let claude = try #require(ClaudeExecutableLocator().locate())
        let codex = try #require(CodexCLI.newestExecutable())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-heads-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let threads = CodexThreads(folder: home.appending(path: "codex-threads"))
        let launch: AgentLauncher = { launch in
            launch.engine == .codex ? try CodexAgentProcess.launcher(executable: codex, threads: threads)(launch) : try ClaudeAgentProcess.launcher(executable: claude)(launch)
        }
        let bot = Bot(profile: .main(home: home), defaultModel: .haiku, exitTimeout: 60, launcher: launch, store: BotStore(directory: home.appending(path: "store")))
        bot.sessionExists = { session, folder in Bot.claudeSessionExists(session, in: folder) || threads.thread(for: session) != nil }
        await bot.setHeads([.claude, .codex])

        bot.send("Pick one colour name at random from red, green, purple and reply with only that word.", to: .codex)
        await eventually({ bot.messages.contains { $0.role == .bot && $0.engine == .codex } && bot.partner?.isWorking == false }, timeout: 180)
        let picked = try #require(bot.messages.last { $0.role == .bot && $0.engine == .codex })
        print("codex:", picked.text)

        bot.send("Which colour did Codex just pick? Reply with only that word.", to: .claude)
        await eventually({ bot.messages.contains { $0.role == .bot && $0.engine == .claude } && !bot.isWorking }, timeout: 180)
        let answer = try #require(bot.messages.last { $0.role == .bot && $0.engine == .claude })
        print("claude:", answer.text)
        #expect(answer.text.lowercased().contains(picked.text.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))))
        // No lock: both processes are up.
        #expect(bot.phase == .awake && bot.partner?.phase == .awake)
        #expect(bot.messages.first { $0.id == picked.id }?.seenBy == [.claude, .codex])
        await bot.goToSleep()
        #expect(bot.partner?.phase == .asleep)
    }

    /// A message to both: the heads run at once and split the work between them (their own
    /// judgment, from what they tell each other); every line is marked seen by both.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func bothHeadsSplitOneMessage() async throws {
        let claude = try #require(ClaudeExecutableLocator().locate())
        let codex = try #require(CodexCLI.newestExecutable())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-both-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let threads = CodexThreads(folder: home.appending(path: "codex-threads"))
        let launch: AgentLauncher = { launch in
            launch.engine == .codex ? try CodexAgentProcess.launcher(executable: codex, threads: threads)(launch) : try ClaudeAgentProcess.launcher(executable: claude)(launch)
        }
        let profile = BotProfile(name: "Probe", role: .manager, avatar: "square", workingDirectory: home, memoryPath: ".bot/memory.md", tools: ["Read", "Write", "Edit"])
        let bot = Bot(profile: profile, defaultModel: .haiku, exitTimeout: 60, launcher: launch, store: BotStore(directory: home.appending(path: "store")))
        bot.sessionExists = { session, folder in Bot.claudeSessionExists(session, in: folder) || threads.thread(for: session) != nil }
        await bot.setHeads([.claude, .codex])

        bot.send("Two small jobs: create a.txt containing the word one, and b.txt containing the word two, in your working folder. Split them between you: each of you does exactly one file.")
        await eventually({ (bot.isWorking || bot.partner?.isWorking == true) }, timeout: 60)
        await eventually({ !bot.isWorking && bot.partner?.isWorking == false }, timeout: 300)
        try? await Task.sleep(for: .seconds(2))
        for message in bot.messages { print("[\(message.role)] \(message.engine?.displayName ?? "-") seen=\(message.seenBy?.map(\.displayName) ?? []): \(message.text.prefix(160))") }
        let a = try? String(contentsOf: home.appending(path: "a.txt"), encoding: .utf8)
        let b = try? String(contentsOf: home.appending(path: "b.txt"), encoding: .utf8)
        #expect(a?.contains("one") == true)
        #expect(b?.contains("two") == true)
        #expect(bot.messages.first?.seenBy == [.claude, .codex])
        await bot.goToSleep()
    }

    /// The Codex model menu lists what the local Codex offers (`model/list`).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func codexListsItsModels() async throws {
        let models = await CodexModels.load()
        print("codex models:", models.map(\.id))
        #expect(!models.isEmpty)
    }

    /// A bot sends a subagent off: the subagent's own steps are recorded under it, it ends with a
    /// result, and the reply carries the card that opens it.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func aSubagentsWorkIsRecorded() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try "hello from the probe\n".write(to: home.appending(path: "a.txt"), atomically: true, encoding: .utf8)

        let profile = BotProfile(name: "Probe", role: .manager, avatar: "square", workingDirectory: home, memoryPath: ".bot/memory.md", tools: ["Read", "Glob", "Agent", "Task"])
        let bot = Bot(profile: profile, defaultModel: .haiku, launcher: ClaudeAgentProcess.launcher(executable: executable))

        bot.send("Use the Agent tool to send one general-purpose subagent to read a.txt in your working folder and report what it says. Do not read it yourself. Tell me what it says once the subagent is done.")
        await eventually({ bot.subagents.first.map { !$0.isRunning } == true }, timeout: 240)
        await eventually({ bot.messages.last?.role == .bot && !bot.isWorking }, timeout: 120)
        // A subagent in the background reports after the turn that sent it ended.
        await eventually({ bot.messages.filter { $0.role == .bot }.count >= 2 }, timeout: 90)
        for message in bot.messages {
            print("[\(message.role)] \(message.text.prefix(200)) steps=\(message.steps?.map(\.title) ?? [])")
        }
        let subagent = try #require(bot.subagents.first)
        print("subagent:", subagent.description, subagent.status, subagent.background, "steps:", subagent.steps.map(\.title), "result:", subagent.result?.prefix(200) ?? "")
        #expect(subagent.status == .completed)
        #expect(subagent.steps.contains { $0.tool == "Read" })
        #expect(bot.messages.contains { $0.steps?.contains { $0.kind == .subagent && $0.id == subagent.id } == true })
        #expect(bot.messages.contains { $0.role == .bot && $0.text.contains("hello from the probe") })
        await bot.goToSleep()
    }

    /// claude wakes the bot with a background task's notification (sent here straight to the
    /// process, as claude itself injects it): with nothing new for the user it answers
    /// `<no-reply/>` and no bubble shows; real news still shows.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func anInterimNotificationWakesNoBubble() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        final class Box: @unchecked Sendable { var process: AgentProcess? }
        let box = Box()
        let profile = BotProfile(name: "Probe", role: .manager, avatar: "square", workingDirectory: home, memoryPath: ".bot/memory.md", tools: ["Read"])
        let bot = Bot(profile: profile, defaultModel: .haiku, launcher: { launch in
            let process = try real(launch)
            box.process = process
            return process
        })

        bot.send("A subagent called \"Transcribe the recording\" is working in the background for me. Just reply OK.")
        await eventually({ bot.messages.last?.role == .bot && !bot.isWorking }, timeout: 120)
        let shown = bot.messages.count
        let process = try #require(box.process)

        process.send("""
        <task-notification>
        <task-id>a35</task-id>
        <status>completed</status>
        <summary>Agent "Transcribe the recording" is waiting on its own background work</summary>
        <result>(result may be interim) Still transcribing, about half done.</result>
        </task-notification>
        """)
        await eventually({ bot.isWorking }, timeout: 60)
        await eventually({ !bot.isWorking }, timeout: 120)
        for message in bot.messages { print("[\(message.role)] \(message.text.prefix(200))") }
        #expect(bot.messages.count == shown)

        process.send("""
        <task-notification>
        <task-id>a35</task-id>
        <status>completed</status>
        <summary>Agent "Transcribe the recording" completed</summary>
        <result>The recording says: the meeting moves to Friday.</result>
        </task-notification>
        """)
        await eventually({ bot.messages.count == shown + 1 && !bot.isWorking }, timeout: 120)
        print("report:", bot.messages.last?.text ?? "")
        // It answers in the user's language: "Friday" or 星期五 / 週五.
        let report = bot.messages.last?.text ?? ""
        #expect(bot.messages.last?.role == .bot)
        #expect(["Friday", "五"].contains { report.contains($0) })
        await bot.goToSleep()
    }

    /// Asked in words to add a folder, the main bot asks for it with the tag, and the app shows
    /// the card instead of adding it straight away.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func theMainBotAsksToAddAProject() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }

        workspace.mainBot.send("請把 \(folder.path) 加成一個專案，然後請它的負責人列出裡面有哪些檔案。")
        await eventually({ workspace.mainBot.messages.contains { $0.isOpenQuestion } }, timeout: 120)
        for message in workspace.mainBot.messages { print("[\(message.role)] \(message.text)") }
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })
        #expect(workspace.projects.isEmpty)
        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        let project = try #require(workspace.projects.first)
        #expect(project.folder.path == folder.path)
        let manager = try #require(workspace.bot(for: project))
        await eventually({ manager.messages.first?.role == .relay }, timeout: 10)
        print("handed over:", manager.messages.first?.text ?? "")
        await eventually({ manager.messages.contains { $0.role == .bot } }, timeout: 120)
        await workspace.mainBot.goToSleep()
        await manager.goToSleep()
    }

    /// The conversation from 2026-10-20: a wish sent in two parts gets one answer, and the main
    /// bot asks for every folder in ~/tool on one card, without looking at the disk itself.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func aWishInTwoPartsBecomesOneCardForEveryFolder() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let tool = root.appending(path: "tool")
        for name in ["alpha", "beta", "gamma"] {
            try FileManager.default.createDirectory(at: tool.appending(path: name), withIntermediateDirectories: true)
        }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }
        let main = workspace.mainBot

        main.send("你建立 newbot 的時候可以指定他們的位置嗎。\n\n我想要讓 \(tool.path) 底下的")
        try? await Task.sleep(for: .seconds(3))
        main.send("都有一個bot")
        await eventually({ !main.isWorking && main.messages.last?.role != .user }, timeout: 180)
        try? await Task.sleep(for: .seconds(2))
        for message in main.messages {
            print("[\(message.role)] \(message.text) steps=\(message.steps?.map(\.title) ?? [])")
        }
        let replies = main.messages.filter { $0.role == .bot }
        #expect(replies.count == 1)
        #expect(!main.messages.contains { $0.permissionTool != nil })
        let cards = main.messages.filter(\.isOpenQuestion)
        #expect(cards.count == 1)
        #expect(cards.first?.text.contains("alpha") == true && cards.first?.text.contains("gamma") == true)
        await main.goToSleep()
    }

    /// "Every project under ~/tool" finds the projects inside the category folders.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func everyProjectMeansProjectsNotTopFolders() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let tool = root.appending(path: "tool")
        for path in ["MacOSApp/ClaudeCodeBot/.git", "MacOSApp/TODO/NotchDo/.git", "cli/token-speed/.git", "website/diary/.git"] {
            try FileManager.default.createDirectory(at: tool.appending(path: path), withIntermediateDirectories: true)
        }
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }
        let main = workspace.mainBot
        let handle = main.onRequests
        main.onRequests = { requests in
            print("requests:", requests)
            handle?(requests)
        }
        main.send("\(tool.path) 底下每一個專案都要一個 bot")
        await eventually({ main.messages.contains(where: \.isOpenQuestion) }, timeout: 180)
        for message in main.messages { print("[\(message.role)] \(message.text)") }
        let card = try #require(main.messages.last { $0.isOpenQuestion })
        #expect(card.text.contains("Add these 4 folders"))
        #expect(card.text.contains("**NotchDo**") && !card.text.contains("**MacOSApp**"))
        await main.goToSleep()
    }

    /// The developer bot asks for a screenshot and a build install with the tags.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func theDeveloperBotUsesItsTags() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appending(path: "ClaudeCodeBot")
        let app = folder.appending(path: "dist/ClaudeCodeBot.app/Contents")
        try FileManager.default.createDirectory(at: app.appending(path: "MacOS"), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: app.appending(path: "MacOS/ClaudeCodeBot"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: app.appending(path: "MacOS/ClaudeCodeBot").path)
        let info: [String: Any] = ["CFBundleIdentifier": "io.github.william1010121.ClaudeCodeBot", "CFBundleExecutable": "ClaudeCodeBot", "CFBundleShortVersionString": "1.4.0-dev"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: app.appending(path: "Info.plist"))
        let real = ClaudeAgentProcess.launcher(executable: executable)
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, defaultModel: .haiku, launcher: real, store: store)
        }
        let project = workspace.addProject(folder: folder, select: false)
        workspace.setDeveloperMode(true, project: project.id)
        let manager = try #require(workspace.bot(for: project))
        var asked: [BotRequest] = []
        manager.onRequests = { asked += $0 }

        manager.send("看一下 App 現在長什麼樣子")
        await eventually({ !manager.isWorking && manager.messages.last?.role == .bot }, timeout: 120)
        print("reply 1:", manager.messages.last?.text ?? "", asked)
        #expect(asked.contains(.appScreenshot))

        manager.send("我已經 build 好了，在 \(folder.path)/dist/ClaudeCodeBot.app，幫我裝起來。改了左欄的未讀數。")
        await eventually({ asked.contains { if case .installBuild = $0 { true } else { false } } }, timeout: 120)
        print("reply 2:", manager.messages.last?.text ?? "", asked)
        await manager.goToSleep()
        withExtendedLifetime(workspace) {}
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
    /// M3 acceptance: a manager stuck on a decision asks with buttons; the question waits in
    /// its chat; picking there makes the manager carry on.
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
        await eventually({ manager.openQuestion != nil }, timeout: 180)
        let question = try #require(manager.openQuestion)
        print("question:", question.text, question.choices?.map(\.label) ?? [])
        #expect(question.isOpenQuestion)
        #expect(workspace.waiting.count == 1)

        let pick = try #require(question.choices?.firstIndex { $0.label.contains("Plant Diary") })
        #expect(workspace.choose(pick, in: question.id, of: manager))
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
        let ccb = TestPaths.app
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

extension LiveClaudeTests {
    /// You write while it works on handed-over work with a subagent in the background: the turn
    /// stops to answer you, but the subagent keeps going and its report still reaches the bot.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func stoppingATurnLeavesBackgroundSubagentsRunning() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        // Plain sleeps are refused by claude's Bash; scripts that wait are not.
        try "import time; time.sleep(45); open('bg-done.txt', 'w').write('done')\n"
            .write(to: home.appending(path: "bgjob.py"), atomically: true, encoding: .utf8)
        try "import time; time.sleep(60)\n".write(to: home.appending(path: "fgjob.py"), atomically: true, encoding: .utf8)
        let marker = home.appending(path: "bg-done.txt")

        let profile = BotProfile(name: "Probe", role: .manager, avatar: "square", workingDirectory: home, memoryPath: ".bot/memory.md", tools: ["Read", "Glob", "Bash", "Agent", "Task"])
        let bot = Bot(profile: profile, defaultModel: .haiku, launcher: ClaudeAgentProcess.launcher(executable: executable))

        bot.relay("Use the Agent tool with run_in_background: true to start one general-purpose subagent with this prompt: \"Run the Bash command `python3 bgjob.py` in the foreground (not in the background, timeout 120000), then reply BG-DONE.\" Right after starting it, run the Bash command `python3 fgjob.py` yourself in the foreground (timeout 120000) and wait for it. When the subagent reports back, say BG-REPORTED.")
        await eventually({ bot.subagents.first?.isRunning == true && bot.isWorking }, timeout: 120)
        // Give the turn time to be inside its own long command.
        try await Task.sleep(for: .seconds(8))
        #expect(bot.subagents.first?.isRunning == true)

        bot.send("Quick question: reply with only the word PONG.")
        await eventually({ bot.messages.contains { $0.role == .bot && $0.text.contains("PONG") } }, timeout: 120)
        await eventually({ bot.subagents.first.map { !$0.isRunning } == true }, timeout: 180)
        for message in bot.messages {
            print("[\(message.role)] \(message.text.prefix(200))")
        }
        let subagent = try #require(bot.subagents.first)
        print("subagent:", subagent.description, subagent.status, subagent.background, "result:", subagent.result?.prefix(200) ?? "")
        #expect(subagent.status == .completed)
        #expect(FileManager.default.fileExists(atPath: marker.path))
        // Its report comes back to the bot after the turn you stopped.
        await eventually({ bot.messages.contains { $0.role == .bot && $0.text.contains("BG-REPORTED") } }, timeout: 180)
        bot.stop()
    }
}

extension LiveClaudeTests {
    /// The Luna check: what it says about promises and plain replies, and how long it takes.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func theSharedLunaCheckTellsPromisesApartAndHowLongItTakes() async throws {
        let executable = try #require(CodexCLI.locateNewest())
        let classify = PromiseCheck.codexClassifier(executable: executable)
        let cases: [(String, Bool)] = [
            ("好的，接下來我會確認一下測試結果，再回報給你。", true),
            ("Got it. I'll look into the failing build and report back.", true),
            ("測試全部通過，已 commit 在 bot/x。要我 push 嗎？", false),
            ("I started the tests in the background; their result will wake me and I'll report then.", false)
        ]
        var times: [Double] = []
        for (message, promises) in cases {
            let start = Date()
            let input = PromiseCheck.classifierMessage(.init(reply: message, workPending: false,
                task: promises ? "The user authorized the next action stated in the reply. Perform it and report." : "Answer the user within their current permission boundary."))
            let verdict = try await classify(input)
            let seconds = Date().timeIntervalSince(start)
            times.append(seconds)
            print(String(format: "%.2fs", seconds), verdict.rawValue, "-", message)
            #expect(([PromiseCheck.Verdict.continueWork, .continueAnalysis].contains(verdict.verdict)) == promises, "\(message)")
        }
        print(String(format: "Luna check: mean %.2fs, max %.2fs", times.reduce(0, +) / Double(times.count), times.max() ?? 0))
        #expect(times.allSatisfy { $0 < PromiseCheck.classifierTimeout })
    }

    /// The shared Luna check with authorization context: a next step the bot states it is starting is a
    /// promise; finished work, a question, choices, a background task that reports back, or a
    /// suggestion to the user isn't.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func theSharedLunaCheckCatchesAStatedNextStepButNotASuggestion() async throws {
        let executable = try #require(CodexCLI.locateNewest())
        let classify = PromiseCheck.codexClassifier(executable: executable)
        let cases: [(String, Bool)] = [
            ("1.13.0-dev（389d00d）已經換上，截圖看起來正常：網頁預覽卡片改成顯示截圖，背景工作的 subagent 狀態也只出現在最後一則。下一步照先前說好的，開始做 1.14.0 的多國語言。", true),
            ("好，我接著把測試補上。", true),
            ("Next, I'll update the README.", true),
            ("我再去看一下 log。", true),
            ("已修好登入逾時的問題：改了 SessionStore 的過期判斷，補了兩個測試，全部通過，已 commit 在 bot/login（a1b2c3d）。", false),
            ("要我 push 嗎？", false),
            ("接下來要先做哪一個？\n<choices>\n- 多國語言\n- 深色模式\n</choices>", false),
            ("已派 subagent 去查，查完會通知你。", false),
            ("下一步可以考慮加快取，要做的話跟我說。", false)
        ]
        for (message, promises) in cases {
            let input = PromiseCheck.classifierMessage(.init(reply: message, workPending: false,
                task: promises ? "The user authorized the next action stated in the reply. Perform it and report." : "Answer the user within their current permission boundary."))
            let verdict = try await classify(input)
            print(verdict.rawValue, "-", message)
            #expect(([PromiseCheck.Verdict.continueWork, .continueAnalysis].contains(verdict.verdict)) == promises, "\(message)")
        }
    }

    /// The whole check, the app's way: a bot told to only promise shows that reply, then is sent
    /// the follow-up and does the work.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func aBotThatOnlyPromisesIsSentBackToDoIt() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try "The secret word is KUMQUAT.\n".write(to: home.appending(path: "a.txt"), atomically: true, encoding: .utf8)
        let profile = BotProfile(name: "Probe", role: .manager, avatar: "square", workingDirectory: home, memoryPath: ".bot/memory.md", tools: ["Read"])
        let bot = Bot(profile: profile, defaultModel: .haiku, launcher: ClaudeAgentProcess.launcher(executable: executable))
        bot.promiseCheck = PromiseCheck.checker(classify: PromiseCheck.codexClassifier())
        let start = Date()
        bot.send("Your authorized task is to read a.txt and report its contents. For the first reply only, do not use a tool and reply with exactly this sentence: 好的，接下來我會讀 a.txt 確認內容，再回報給你。")
        await eventually({ bot.messages.contains { $0.role == .bot && $0.text.contains("KUMQUAT") } && !bot.isWorking }, timeout: 180)
        print(String(format: "took %.1fs", Date().timeIntervalSince(start)))
        for message in bot.messages { print("[\(message.role)] \(message.text.prefix(300))") }
        let replies = bot.messages.filter { $0.role == .bot }
        #expect(replies.count == 2)
        #expect(replies.first?.text.contains("a.txt") == true)
        #expect(replies.last?.text.contains("KUMQUAT") == true)
        bot.stop()
    }
}


extension LiveClaudeTests {
    /// A bot launched the way the app launches it (`claude -p`, stream-json, its environment)
    /// has Claude Code's Artifact tool. Print-mode sessions leave it out unless the environment
    /// asks for it, and then a bot told to publish reports as Artifacts has no tool to do it with.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func aBotLaunchedByTheAppHasTheArtifactTool() async throws {
        let executable = try #require(ClaudeExecutableLocator().locate())
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let launch = AgentLaunch(model: .haiku, sessionID: UUID(), persistSession: false, workingDirectory: home, systemPrompt: "", tools: BotProfile.toolbox)

        let process = Process()
        process.executableURL = executable
        process.arguments = ClaudeAgentProcess.arguments(for: launch)
        process.currentDirectoryURL = home
        process.environment = ClaudeAgentProcess.childEnvironment(for: launch)
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate() } }
        let message = #"{"type":"user","message":{"role":"user","content":"Reply with only OK."}}"# + "\n"
        input.fileHandleForWriting.write(Data(message.utf8))

        // The session's tool list comes in its `system`/`init` line, before the model answers.
        var tools: [String]?
        for try await line in output.fileHandleForReading.bytes.lines {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if object["type"] as? String == "system", object["subtype"] as? String == "init" {
                tools = object["tools"] as? [String]
                break
            }
        }
        let list = try #require(tools)
        print("Tools:", list)
        #expect(list.contains(ResultPublishing.tool))
    }
}

extension LiveClaudeTests {
    /// Real configured small model; replay evidence only, with no SSH or GPU operations.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func sharedCompletionJudgeUnderstandsAuthorizationDependenciesAndIdleGPU() async throws {
        let executable = try #require(CodexCLI.locateNewest())
        let check = PromiseCheck.checker(classify: PromiseCheck.codexClassifier(executable: executable))
        let cases: [(PromiseCheck.TurnEnd, PromiseCheck.Verdict)] = [
            (.init(reply: CompletionContinuationTests.idleReply, workPending: true,
                   task: CompletionContinuationTests.authorization,
                   dependencies: ["GPU2 Track2 EEGNet actively running, returns via notification", "Monitor: 30 minute fallback"],
                   actions: ["SSH output only: GPU3 idle >1 minute"]), .continueWork),
            (.init(reply: "All four hypotheses failed; GPU3 idle. I want to ask the data next.", workPending: true,
                   task: CompletionContinuationTests.authorization,
                   dependencies: ["Monitor checks idle GPUs and will wake on a change; no analysis worker owns GPU3"]), .continueWork),
            (.init(reply: "GPU3 is idle. Do you want me to analyze subject errors?", workPending: true,
                   task: CompletionContinuationTests.authorization,
                   dependencies: ["GPU2 experiment running"]), .continueWork),
            (.init(reply: "The analysis is running; I will report when it returns.", workPending: true,
                   task: "Analyze the errors in errors.csv and report. No other work.",
                   dependencies: ["Subagent errors: actively analyzing errors.csv, returns full result via task_notification"]), .waitingDependency),
            (.init(reply: "All requested analyses and validation passed. Here is the final report.", workPending: false,
                   task: "Produce one analysis report and validate it; then stop.",
                   actions: ["Report written; validation completed successfully"]), .complete),
            (.init(reply: "I need permission to read the private dataset. All remaining analysis requires it.", workPending: false,
                   task: "Research this dataset using approved access only.",
                   actions: ["Read failed: permission denied; no accessible data or independent research remains"]), .waitingUser),
            (.init(reply: "I will analyze another hypothesis.", workPending: false,
                   task: CompletionContinuationTests.authorization,
                   conversation: "[user latest] Stop research now. No more analysis or experiments."), .cancelled),
            (.init(reply: "The research report is complete. Next I will implement the proposed change.", workPending: false,
                   task: "Research only. Deliver findings and stop. Implementation requires explicit later authorization.",
                   actions: ["Research report delivered and all requested findings verified. No implementation authorized."]), .complete),
            (.init(reply: "I will analyze subject errors next.", workPending: true,
                   task: CompletionContinuationTests.authorization, dependencies: ["GPU2 experiment only"],
                   terminalRequired: true, signals: [.init(kind: .end, evidence: "I will analyze next")]), .continueWork),
            (.init(reply: "GPU2 is running; I cannot do anything.", workPending: true,
                   task: CompletionContinuationTests.authorization, dependencies: ["GPU2 only; GPU3 idle and unowned"],
                   terminalRequired: true, signals: [.init(kind: .block, evidence: "GPU2 is busy")]), .continueWork),
            (.init(reply: "All report checks passed.", workPending: false, task: "Write and validate one report; then stop.",
                   actions: ["Report written and validation passed"], terminalRequired: true,
                   signals: [.init(kind: .end, evidence: "Report produced and all required validations passed")]), .complete),
            (.init(reply: "All report checks passed.", workPending: false, task: "Write and validate one report; then stop.",
                   actions: ["Report written and validation passed"], terminalRequired: true), .needsTerminalSignal),
            (.init(reply: "The private dataset cannot be accessed without your approval.", workPending: false,
                   task: "Analyze the private dataset with approved access only.", actions: ["Access denied; no independent authorized progress possible"],
                   terminalRequired: true, signals: [.init(kind: .block, evidence: "Missing dataset read permission; user approval is required, and all analysis requires that data")]), .waitingUser),
            (.init(reply: "The private dataset cannot be accessed without your approval.", workPending: false,
                   task: "Analyze the private dataset with approved access only.", actions: ["Access denied; no independent authorized progress possible"],
                   terminalRequired: true), .needsTerminalSignal),
            (.init(reply: CompletionContinuationTests.idleReply, workPending: true,
                   task: CompletionContinuationTests.authorization, conversation: "The previous two replies were exactly: " + CompletionContinuationTests.idleReply,
                   dependencies: ["GPU2 only"], actions: ["Same SSH status again, no subject or interval analysis"], terminalRequired: true), .continueWork),
            (.init(reply: "I will continue research next.", workPending: false, task: CompletionContinuationTests.authorization,
                   conversation: "[latest user] Cancel the analysis. Do not resume.", terminalRequired: true), .cancelled)
        ]
        var times: [Double] = []
        for (end, expected) in cases {
            let started = Date()
            let raw = await check(end)
            let verdict = PromiseCheck.review(raw, for: end)
            times.append(Date().timeIntervalSince(started))
            print("completion-case", expected.rawValue, "raw", raw.rawValue, "effective", verdict.rawValue, "reason", verdict.reason)
            // A first report of a new batch can count as fresh interpretation, but both
            // continuation verdicts MUST wake the same unfinished task. A repeated promise
            // below must specifically have no new-analysis credit.
            let firstBatchReport = end.reply == CompletionContinuationTests.idleReply && end.conversation.isEmpty && !end.terminalRequired
            #expect(verdict.verdict == expected || (firstBatchReport && verdict.verdict == .continueAnalysis), "\(end.reply)")
            #expect(!verdict.reason.isEmpty)
        }
        print(String(format: "Luna structured cases: %d; mean %.2fs; max %.2fs", cases.count, times.reduce(0, +) / Double(times.count), times.max() ?? 0))
        #expect(times.allSatisfy { $0 < PromiseCheck.classifierTimeout })
    }

    /// Actual Bot event/delivery pipeline and actual provider judgment; head events are replayed
    /// to keep the regression independent from any live research host or GPU.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func liveCompletionJudgeWakesIdleResearchInTheExistingBotSession() async throws {
        let executable = try #require(CodexCLI.locateNewest())
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = PromiseCheck.checker(classify: PromiseCheck.codexClassifier(executable: executable))
        bot.send(CompletionContinuationTests.authorization)
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.trace(.subagentStarted(id: "gpu2", description: "GPU2 experiment", type: nil, prompt: "Track2 GPU2 only; GPU3 not owned", background: true)))
        agent.emit(.trace(.monitorStarted(id: "fallback", description: "30 minute fallback")))
        agent.emit(.trace(.toolUse(id: "ssh", tool: "Bash", title: "Check SSH", detail: "Read experiment log", parent: nil)))
        agent.emit(.trace(.toolResult(id: "ssh", output: "GPU2 running; GPU3 idle > 1 minute", failed: false, parent: nil)))
        agent.reply(CompletionContinuationTests.idleReply)
        await eventually({ agent.sent.contains(PromiseCheck.followUp) }, timeout: 30)
        #expect(fake.agents.count == 1)
        #expect(bot.isWorking)
        #expect(bot.messages.contains { $0.text == CompletionContinuationTests.idleReply })
    }
}
