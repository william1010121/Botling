import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A restart (new plugins, a model, effort) goes on in the same session with `--resume`, just
/// before the bot's next message: no handoff turn, no memory read back, idle bots cost nothing.
@MainActor
struct HandoffResumeTests {
    private func awakeBot(_ fake: FakeLauncher) async -> Bot {
        let bot = makeBot(fake)
        bot.sessionExists = { _, _ in true }
        bot.wakeNote = { "(App: Your components: cards.)" }
        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        return bot
    }

    @Test(.wallClock) func newPluginsResumeTheSameSessionBeforeTheNextMessage() async throws {
        let fake = FakeLauncher()
        let bot = await awakeBot(fake)
        await bot.reloadPlugins()
        try? await Task.sleep(for: .milliseconds(100))
        // Idle: nothing restarts, nothing is asked.
        #expect(fake.agents.count == 1)
        #expect(!fake.agents[0].finished)

        bot.send("next")
        await eventually { fake.agents.count == 2 && bot.messages.last?.role == .bot && !bot.isWorking }
        let old = fake.agents[0], resumed = fake.agents[1]
        #expect(old.finished)
        #expect(!old.sent.contains(bot.prompts.handoff))
        #expect(resumed.launch.resume)
        #expect(resumed.launch.sessionID == old.launch.sessionID)
        // One message: the note (with the briefing as it is now, since --resume keeps the first
        // system prompt) and yours. No resume prompt, no memory read.
        #expect(resumed.sent.count == 1)
        let first = try #require(resumed.sent.first)
        #expect(first.hasPrefix("(App: Botling restarted you in this same conversation (loading new plugins)"))
        #expect(first.contains("(App: Your components: cards.)"))
        #expect(first.hasSuffix("next"))
        #expect(!first.contains(bot.prompts.resume))
        #expect(!first.contains(bot.prompts.wake))
        #expect(bot.messages.filter { $0.role == .divider }.map(\.text) == ["Restarted → loading new plugins"])
        #expect(bot.phase == .awake)

        // The next message goes on in that process.
        bot.send("more")
        await eventually { resumed.sent.count == 2 }
        #expect(fake.agents.count == 2)
    }

    @Test func aModelSwitchResumesOnTheNewModel() async {
        let fake = FakeLauncher()
        let bot = await awakeBot(fake)
        await bot.switchModel(to: .opus)
        #expect(bot.model == .opus)
        #expect(fake.agents.count == 1)

        bot.send("next")
        await eventually { fake.agents.count == 2 && !bot.isWorking && bot.phase == .awake }
        #expect(fake.agents[1].launch.model == .opus)
        #expect(fake.agents[1].launch.resume)
        #expect(fake.agents[1].launch.sessionID == fake.agents[0].launch.sessionID)
        #expect(!fake.agents[0].sent.contains(bot.prompts.handoff))
        #expect(bot.messages.filter { $0.role == .divider }.map(\.text) == ["Restarted → Opus"])
    }

    @Test func severalChangesMakeOneRestart() async {
        let fake = FakeLauncher()
        let bot = await awakeBot(fake)
        await bot.reloadPlugins()
        await bot.switchModel(to: .haiku)
        await bot.setEffort(.high)
        await bot.reloadPlugins()

        bot.send("next")
        await eventually { fake.agents.count == 2 && !bot.isWorking && bot.phase == .awake }
        #expect(fake.agents[1].launch.model == .haiku)
        #expect(fake.agents[1].launch.effort == .high)
        bot.send("more")
        await eventually { fake.agents[1].sent.count == 2 }
        #expect(fake.agents.count == 2)
        #expect(bot.messages.filter { $0.role == .divider }.count == 1)
    }

    /// Plugins that changed back to what its session has need no restart.
    @Test func pluginsChangedBackNeedNoRestart() async {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.sessionExists = { _, _ in true }
        var stamp = ["a#1"]
        bot.pluginStamp = { stamp }
        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot && !bot.isWorking }
        stamp = ["a#2"]
        await bot.reloadPlugins()
        stamp = ["a#1"]
        await bot.reloadPlugins()
        bot.send("next")
        await eventually { fake.agents[0].sent.count == 2 }
        #expect(fake.agents.count == 1)
        #expect(!bot.messages.contains { $0.role == .divider })
    }

    /// A subagent at work in the background would be ended by the restart: the message goes to
    /// the running process, and the restart waits for a message once the subagent is done.
    @Test func aBackgroundSubagentIsNeverCutOff() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let bot = makeBot(fake)
        bot.sessionExists = { _, _ in true }
        bot.send("Read a.txt in a subagent")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        for line in SubagentRun.lines.prefix(3) {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        agent.reply("Sent it off.")
        await eventually { !bot.isWorking && bot.phase == .awake }
        #expect(bot.subagents.first?.isRunning == true)

        await bot.reloadPlugins()
        bot.send("How is it going?")
        await eventually { agent.sent.count == 2 }
        #expect(fake.agents.count == 1)
        #expect(!agent.finished)
        agent.reply("Still reading.")
        await eventually { !bot.isWorking }

        for event in StreamEvent.events(in: SubagentRun.notification) { agent.emit(event) }
        agent.emit(.trace(.text("Done.", parent: nil)))
        await eventually { bot.isWorking }
        agent.reply("It says hello world.")
        await eventually { !bot.isWorking && bot.subagents.first?.isRunning == false }

        bot.send("Thanks")
        await eventually { fake.agents.count == 2 }
        #expect(agent.finished)
        #expect(fake.agents[1].launch.resume)
        await eventually { fake.agents[1].sent.count == 1 }
        #expect(fake.agents[1].sent.first?.hasSuffix("Thanks") == true)
    }

    /// claude could not go on with the session (it lost it): the old process is gone, so the
    /// message goes to a fresh session that reads memory and the recent chat.
    @Test func aFailedResumeStartsAFreshSessionWithTheMessage() async throws {
        let fake = FakeLauncher()
        let bot = await awakeBot(fake)
        fake.respond = { _ in nil }
        await bot.reloadPlugins()
        bot.send("next")
        await eventually { fake.agents.count == 2 }
        fake.agents[1].emit(.exited(status: 1, stderr: "No conversation found with session ID"))
        await eventually { fake.agents.count == 3 }
        let fresh = fake.agents[2]
        #expect(!fresh.launch.resume)
        #expect(fresh.launch.sessionID != fake.agents[0].launch.sessionID)
        await eventually { fresh.sent.count == 1 }
        #expect(fresh.sent.first?.hasPrefix(bot.prompts.wake) == true)
        #expect(fresh.sent.first?.hasSuffix("next") == true)
        #expect(fresh.sent.first?.contains("restarted you in this same conversation") == false)
        #expect(bot.messages.contains { $0.role == .divider && $0.text.hasPrefix("Couldn't go on in the same session") })
        #expect(!bot.messages.contains { $0.role == .error })
        #expect(bot.phase == .awake)
    }

    /// No transcript to resume: the old way, a handoff into memory.md and a new session.
    @Test func withoutATranscriptItHandsOver() async {
        let fake = FakeLauncher()
        let bot = await awakeBot(fake)
        var asked: [UUID] = []
        bot.sessionExists = { id, _ in asked.append(id); return false }
        await bot.reloadPlugins()
        bot.send("next")
        await eventually { fake.agents.count == 2 && !bot.isWorking && bot.phase == .awake }
        #expect(asked == [fake.agents[0].launch.sessionID])
        #expect(fake.agents[0].sent.last == bot.prompts.handoff)
        #expect(!fake.agents[1].launch.resume)
        #expect(fake.agents[1].sent.first == bot.prompts.resume + "\n\n(App: Your components: cards.)")
        #expect(bot.messages.filter { $0.role == .divider }.map(\.text) == ["Handoff → loading new plugins"])
    }

    @Test func aTranscriptIsFoundWhereClaudeKeepsIt() throws {
        let config = FileManager.default.temporaryDirectory.appending(path: "ccb-claude-config-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: config) }
        let session = UUID()
        let folder = URL(filePath: "/Users/someone/my project.v2")
        #expect(!Bot.claudeSessionExists(session, in: folder, config: config))
        let named = config.appending(path: "projects/-Users-someone-my-project-v2")
        try FileManager.default.createDirectory(at: named, withIntermediateDirectories: true)
        try Data().write(to: named.appending(path: session.uuidString.lowercased() + ".jsonl"))
        #expect(Bot.claudeSessionExists(session, in: folder, config: config))
        // Under another folder name (a symlink, a long path) it is found too.
        #expect(Bot.claudeSessionExists(session, in: URL(filePath: "/elsewhere"), config: config))
        #expect(!Bot.claudeSessionExists(UUID(), in: folder, config: config))
    }

    @Test func resumeArgumentsKeepTheSessionAndTakeTheNewModel() {
        var launch = AgentLaunch(model: .opus, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp"), systemPrompt: "x")
        launch.resume = true
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        let at = try? #require(arguments.firstIndex(of: "--resume"))
        #expect(at.map { arguments[$0 + 1] } == launch.sessionID.uuidString.lowercased())
        #expect(!arguments.contains("--session-id"))
        #expect(arguments.firstIndex(of: "--model").map { arguments[$0 + 1] } == "opus")
    }
}
