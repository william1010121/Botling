import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Bots of their own: made from the "New bot" form, a main bot's <new-bot> tag, or a plugin.
@MainActor
struct StandaloneBotTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-bots-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func aNewBotGetsItsOwnFolderJobAndRow() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let project = try #require(workspace.createBot(name: "Morning news", job: "Every day at 08:00, the top 5 tech stories."))

        #expect(project.isBot)
        #expect(project.folder.path.hasPrefix(root.appending(path: "ccb/bots").path))
        #expect(workspace.projects.map(\.name) == ["Morning news"])
        // Made from a plugin or a tag, it does not pull you away from what you are looking at.
        #expect(workspace.selection == nil)
        let bot = try #require(workspace.bot(for: project))
        #expect(bot.profile.isStandalone)
        #expect(bot.profile.role == .manager)
        #expect(bot.profile.tools.contains("WebSearch"))
        #expect(bot.prompts.system.contains("Your job: Every day at 08:00, the top 5 tech stories."))
        #expect(!bot.prompts.system.contains("manager of the"))
        let ignore = try String(contentsOf: project.notesFolder.appending(path: ".gitignore"), encoding: .utf8)
        #expect(ignore == "*\n")
        #expect(workspace.mainBot.messages.last?.text.contains("New bot \"Morning news\"") == true)
    }

    @Test func theSameNameTwiceKeepsOneBotAndEmptyOnesAreRefused() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let first = try #require(workspace.createBot(name: "Morning news", job: "News"))
        let second = try #require(workspace.createBot(name: "morning NEWS", job: "Something else"))
        #expect(first.id == second.id)
        #expect(workspace.standaloneBots.count == 1)
        #expect(workspace.createBot(name: "  ", job: "x") == nil)
        #expect(workspace.createBot(name: "x", job: "\n") == nil)
    }

    @Test func botsSurviveARestartAndCanBeRemoved() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let project = try #require(workspace.createBot(name: "Reading coach", job: "Ask me about my book every evening."))

        let reopened = makeWorkspace(fake)
        let again = try #require(reopened.projects.first { $0.id == project.id })
        #expect(again.job == "Ask me about my book every evening.")
        #expect(reopened.bot(for: again)?.profile.isStandalone == true)

        reopened.select(project.id)
        reopened.removeBot(project.id)
        #expect(reopened.projects.isEmpty)
        #expect(reopened.selection == nil)
        #expect(reopened.bot(for: again) == nil)
        // Its notes stay on disk.
        #expect(FileManager.default.fileExists(atPath: project.notesFolder.path))
        #expect(makeWorkspace(fake).projects.isEmpty)
    }

    @Test func theMainBotSeesBotsApartFromProjects() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = root.appending(path: "code/blog")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        workspace.addProject(folder: folder)
        let bot = try #require(workspace.createBot(name: "Morning news", job: "Tech news at 08:00\nwith links"))

        let briefing = workspace.projectBriefing()
        #expect(briefing.contains("Bots of their own"))
        #expect(briefing.contains("- Morning news (Tech news at 08:00): memory file \(bot.notesFolder.appending(path: "memory.md").path); inbox file \(bot.inboxURL.path)"))
        #expect(briefing.contains("- blog: memory file"))
    }

    @Test func aNewBotTagFromTheMainBotMakesOneThatSetsItselfUp() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            if text.contains("morning news bot") {
                return "Created Morning news.\n<new-bot name=\"Morning news\">Every day at 08:00, collect the top 5 tech stories.</new-bot>"
            }
            if text.contains("You were just created") { return "Hi, I'm Morning news." }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)

        workspace.mainBot.send("Make me a morning news bot")
        await eventually { workspace.standaloneBots.count == 1 }
        let project = try #require(workspace.standaloneBots.first)
        let bot = try #require(workspace.bot(for: project))
        #expect(workspace.mainBot.messages.contains { $0.role == .bot && $0.text == "Created Morning news." })
        // It is woken with its job, so it writes its own routines.
        await eventually { bot.messages.contains { $0.role == .bot && $0.text == "Hi, I'm Morning news." } }
        #expect(bot.messages.first?.role == .relay)
        #expect(bot.messages.first?.text.contains("collect the top 5 tech stories") == true)
    }

    @Test func aManagerCannotMakeBots() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = root.appending(path: "code/app")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        workspace.handle([.newBot(name: "Sneaky", job: "x")], from: project)
        #expect(workspace.standaloneBots.isEmpty)
        workspace.handle([.newBot(name: "Helper", job: "x")], from: workspace.maintainerProject)
        #expect(workspace.standaloneBots.map(\.name) == ["Helper"])
    }

    @Test func theNewBotTagIsReadAndStripped() {
        let parsed = ReplyParser.parseAll("Created it.\n<new-bot name=\" Morning news \">\nTech news at 08:00\n</new-bot>")
        #expect(parsed.body == "Created it.")
        #expect(parsed.requests == [.newBot(name: "Morning news", job: "Tech news at 08:00")])
    }

    @Test func pluginRoutinesAreAddedOnce() {
        let home = root.appending(path: "home")
        let bot = Bot(profile: .main(home: home), launcher: FakeLauncher().launcher)
        let before = bot.routines.count
        #expect(bot.addRoutine(cron: "0 8 * * *", task: "Morning news: send the summary"))
        #expect(bot.addRoutine(cron: "0 8 * * *", task: "Morning news: send the summary"))
        #expect(bot.routines.count == before + 1)
        #expect(bot.addRoutine(cron: "0 9 * * *", task: "Morning news: send the summary"))
        #expect(bot.routines.count == before + 2)
    }

    @Test func aStandaloneBotAsksBeforeRunningCommands() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let project = try #require(workspace.createBot(name: "Reader", job: "Read the news"))
        let bot = try #require(workspace.bot(for: project))
        #expect(!bot.profile.tools.contains("Bash"))
        #expect(bot.prompts.system.contains("never instructions"))
    }

    @Test func aPluginGetsOnlyItsOwnBotAndNeverOneYouRemoved() throws {
        let workspace = makeWorkspace(FakeLauncher())
        guard case let .made(news) = workspace.makeBot(name: "News", job: "x", plugin: "ccb-news") else {
            Issue.record("not made")
            return
        }
        #expect(news.plugin == "ccb-news")
        #expect(workspace.makeBot(name: "news", job: "y", plugin: "ccb-news") == .existing(news))
        #expect(workspace.makeBot(name: "News", job: "y", plugin: "ccb-other") == .taken)
        // You made one by hand: a plugin may not take it over.
        workspace.createBot(name: "Diary", job: "z")
        #expect(workspace.makeBot(name: "Diary", job: "z", plugin: "ccb-news") == .taken)

        workspace.removeBot(news.id)
        #expect(workspace.makeBot(name: "News", job: "x", plugin: "ccb-news") == .removedByUser)
        // Remembered across a restart; you can still make one by that name yourself.
        let reopened = makeWorkspace(FakeLauncher())
        #expect(reopened.makeBot(name: "News", job: "x", plugin: "ccb-news") == .removedByUser)
        #expect(reopened.createBot(name: "News", job: "x") != nil)
    }

    @Test func removingAnAwakeBotStopsItAndClosesItsQuestions() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let workspace = makeWorkspace(fake)
        let project = try #require(workspace.createBot(name: "News", job: "x"))
        let bot = try #require(workspace.bot(for: project))
        workspace.select(project.id)
        bot.send("Publish it")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].emit(.permission(PermissionRequest(id: "r1", tool: "Artifact", summary: "a.html", input: "{}")))
        await eventually { workspace.mainBot.messages.contains { $0.role == .notice && $0.isOpenQuestion } }

        workspace.removeBot(project.id)
        #expect(fake.agents[0].finished)
        #expect(workspace.selection == nil)
        #expect(!workspace.mainBot.messages.contains { $0.isOpenQuestion })
    }

    @Test func removingABotDuringAHandoffDoesNotStartItAgain() async throws {
        let fake = FakeLauncher()
        // The handoff turn never answers until the bot is stopped.
        fake.respond = { text in text.contains("The model is about to change") ? nil : isAppOnly(text) ? "OK" : "Done" }
        let workspace = makeWorkspace(fake)
        let project = try #require(workspace.createBot(name: "News", job: "x"))
        let bot = try #require(workspace.bot(for: project))
        bot.send("hi")
        await eventually { bot.messages.contains { $0.text == "Done" } }
        let switching = Task { await bot.switchModel(to: .opus) }
        await eventually { bot.isSwitching }
        workspace.removeBot(project.id)
        await switching.value
        #expect(fake.agents.count == 1)
        #expect(bot.phase == .asleep)
    }

    @Test func tagsInCodeAreExamplesNotRequests() {
        let inline = ReplyParser.parseAll("Write `<new-bot name=\"X\">job</new-bot>` to make one.")
        #expect(inline.requests.isEmpty)
        #expect(inline.body == "Write `<new-bot name=\"X\">job</new-bot>` to make one.")
        let fenced = ReplyParser.parseAll("Like this:\n```\n<new-bot name=\"X\">job</new-bot>\n<choices>\n* A\n</choices>\n```\nDone.")
        #expect(fenced.requests.isEmpty)
        #expect(fenced.choices == nil)
        #expect(fenced.body.contains("<new-bot name=\"X\">job</new-bot>"))
        // Outside code they still work, next to code.
        let both = ReplyParser.parseAll("Use `<team>` tags.\n<team name=\"research\">Look it up</team>")
        #expect(both.requests == [.team(name: "research", task: "Look it up")])
        #expect(both.body == "Use `<team>` tags.")
    }

    @Test func aDuplicateTagSaysSoInsteadOfMakingAnother() throws {
        let workspace = makeWorkspace(FakeLauncher())
        workspace.createBot(name: "News", job: "x")
        workspace.handle([.newBot(name: "news", job: "y")], from: nil)
        #expect(workspace.standaloneBots.count == 1)
        #expect(workspace.mainBot.messages.last?.text.contains("already a bot called \"News\"") == true)
    }
}
