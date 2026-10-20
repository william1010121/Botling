import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// One decision, one card: when the main bot brings up a decision a project already asked
/// about, it shows that project's own card, not a new one, and an answer in either chat goes
/// back to the project and shows on both.
@MainActor
struct OneCardTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-onecard-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    /// A project "socrate" whose bot asked "Which database?" with two options.
    func socrateAsking(_ fake: FakeLauncher, in workspace: Workspace) async throws -> (Workspace.Project, Bot, ChatMessage) {
        let folder = root.appending(path: "code/socrate")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder, select: false)
        let bot = try #require(workspace.bot(for: project))
        bot.send("Set up storage")
        await eventually { bot.openQuestion != nil }
        return (project, bot, try #require(bot.openQuestion))
    }

    nonisolated static func respond(_ text: String) -> String? {
        if isAppOnly(text) { return "OK" }
        if text.contains("Set up storage") {
            return "Which database?\n<choices>\n* SQLite | simple\n- Postgres | a server\n</choices>"
        }
        if text.contains("What is waiting") {
            return "socrate needs a decision on the database.\n<open-question from=\"socrate\"/>"
        }
        return "Got it"
    }

    @Test func theMainBotShowsTheProjectsOwnCardAndAPickThereAnswersTheProject() async throws {
        let fake = FakeLauncher()
        fake.respond = { OneCardTests.respond($0) }
        let workspace = makeWorkspace(fake)
        let (project, socrate, question) = try await socrateAsking(fake, in: workspace)

        workspace.mainBot.send("What is waiting for me?")
        await eventually { workspace.mainBot.messages.contains { $0.sourceMessageID == question.id } }

        // No second, separate card: the main bot's line asks nothing, the card is the project's.
        let reply = try #require(workspace.mainBot.messages.last { $0.role == .bot })
        #expect(reply.text == "socrate needs a decision on the database.")
        #expect(reply.choices == nil)
        #expect(workspace.mainBot.messages.filter { $0.choices?.isEmpty == false }.count == 1)
        let card = try #require(workspace.mainBot.messages.first { $0.sourceMessageID == question.id })
        #expect(card.choices == question.choices)
        #expect(card.sourceID == project.id)
        #expect(card.text.contains("Which database?"))
        // Counted once on "Waiting on you".
        #expect(workspace.waiting.filter { $0.messageID == question.id }.count == 1)
        #expect(workspace.waiting.count == 1)

        // Picked in the main chat: socrate gets the answer, both show it.
        #expect(workspace.choose(1, in: card.id, of: workspace.mainBot))
        #expect(socrate.messages.first { $0.id == question.id }?.chosen == 1)
        #expect(workspace.mainBot.messages.first { $0.id == card.id }?.chosen == 1)
        await eventually { fake.agents.contains { $0.sent.contains { $0.contains("Postgres") } && $0.launch.workingDirectory.lastPathComponent == "socrate" } }
        #expect(workspace.waiting.isEmpty)
    }

    @Test func aPickInTheProjectsChatShowsOnTheMainBotsCopy() async throws {
        let fake = FakeLauncher()
        fake.respond = { OneCardTests.respond($0) }
        let workspace = makeWorkspace(fake)
        let (_, socrate, question) = try await socrateAsking(fake, in: workspace)
        workspace.mainBot.send("What is waiting for me?")
        await eventually { workspace.mainBot.messages.contains { $0.sourceMessageID == question.id } }
        let card = try #require(workspace.mainBot.messages.first { $0.sourceMessageID == question.id })

        #expect(workspace.choose(0, in: question.id, of: socrate))
        #expect(workspace.mainBot.messages.first { $0.id == card.id }?.chosen == 0)
        // Answered once: a late pick on the copy does nothing more.
        #expect(!workspace.choose(1, in: card.id, of: workspace.mainBot))
        #expect(socrate.messages.first { $0.id == question.id }?.chosen == 0)
    }

    @Test func wordsOnTheCopyAnswerTheProject() async throws {
        let fake = FakeLauncher()
        fake.respond = { OneCardTests.respond($0) }
        let workspace = makeWorkspace(fake)
        let (_, socrate, question) = try await socrateAsking(fake, in: workspace)
        workspace.handle([.openQuestion(from: "SOCRATE")], from: nil)
        let card = try #require(workspace.mainBot.messages.first { $0.sourceMessageID == question.id })

        #expect(workspace.answer("Use DuckDB", in: card.id, of: workspace.mainBot))
        #expect(socrate.messages.first { $0.id == question.id }?.answer == "Use DuckDB")
        #expect(workspace.mainBot.messages.first { $0.id == card.id }?.answer == "Use DuckDB")
    }

    @Test func theBriefingNamesEachProjectsOpenQuestion() async throws {
        let fake = FakeLauncher()
        fake.respond = { OneCardTests.respond($0) }
        let workspace = makeWorkspace(fake)
        _ = try await socrateAsking(fake, in: workspace)
        let briefing = workspace.projectBriefing()
        #expect(briefing.contains("socrate"))
        #expect(briefing.contains("open question in its chat: Which database?"))
        #expect(briefing.contains("<open-question from="))
        #expect(workspace.mainBot.prompts.system.contains("<open-question from="))
    }

    @Test func withNoOpenQuestionNothingIsAskedAgain() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = root.appending(path: "code/socrate")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        workspace.addProject(folder: folder, select: false)
        let before = workspace.mainBot.messages.count

        workspace.handle([.openQuestion(from: "socrate")], from: nil)
        workspace.handle([.openQuestion(from: "nobody")], from: nil)
        let added = workspace.mainBot.messages.dropFirst(before)
        #expect(added.allSatisfy { $0.choices == nil })
        #expect(added.contains { $0.text.contains("socrate") })
        // Only the main bot shows other bots' cards.
        let project = try #require(workspace.projects.first)
        workspace.handle([.openQuestion(from: "socrate")], from: project)
        #expect(workspace.mainBot.messages.count == before + added.count)
    }

    @Test func theTagIsReadAndStripped() {
        let parsed = ReplyParser.parseAll("socrate needs a decision.\n<open-question from=\" socrate \"/>")
        #expect(parsed.body == "socrate needs a decision.")
        #expect(parsed.requests == [.openQuestion(from: "socrate")])
        #expect(parsed.choices == nil)
        let closed = ReplyParser.parseAll("Two.\n<open-question from='a'></open-question><open-question from=\"b\" />")
        #expect(closed.requests == [.openQuestion(from: "a"), .openQuestion(from: "b")])
        #expect(closed.body == "Two.")
    }
}
