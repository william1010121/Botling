import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct WorkspaceSleepTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-sleep-\(UUID().uuidString)")

    func project(_ name: String, in workspace: Workspace) throws -> Bot {
        let folder = root.appending(path: "code/\(name)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try #require(workspace.bot(for: workspace.addProject(folder: folder)))
    }

    @Test func independentBotsTidyBeforeAnyReplyAndWaitForEveryResult() async throws {
        let fake = FakeLauncher()
        fake.respond = { $0.hasPrefix(BotPrompts.tidyLead) ? nil : "Got it" }
        let workspace = Workspace(root: root.appending(path: "app")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let manager = try project("one", in: workspace)
        let news = try #require(workspace.createBot(name: "News", job: "Read news"))
        let standalone = try #require(workspace.bot(for: news))
        let maintainer = try #require(workspace.bot(for: workspace.maintainerProject))
        let bots = [workspace.mainBot, manager, standalone, maintainer]
        defer {
            bots.forEach { $0.stop() }
            try? FileManager.default.removeItem(at: root)
        }
        await manager.setHeads([.claude, .codex])
        for bot in bots { bot.send("Remember this") }
        await eventually { fake.agents.count == 5 && bots.allSatisfy { !$0.isWorking } && manager.partner?.isWorking == false }

        var completed = false
        let sleeping = Task { await workspace.putEveryoneToSleep(); completed = true }
        // Every independent writer must start while all tidy replies remain held.
        await eventually({ bots.allSatisfy { $0.phase == .tidying } }, timeout: 3)
        let writers = fake.agents.filter { $0.sent.contains { $0.hasPrefix(BotPrompts.tidyLead) } }
        try #require(writers.count == bots.count)
        #expect(!completed)
        #expect(manager.partner?.phase == .asleep)
        #expect(fake.agents.filter { $0.launch.engine == .codex }.allSatisfy { agent in
            !agent.sent.contains { $0.hasPrefix(BotPrompts.tidyLead) }
        })

        for writer in writers.dropLast() { writer.reply("OK") }
        await eventually { writers.dropLast().allSatisfy { $0.finished } }
        #expect(!completed)
        writers.last?.emit(.reply("Cannot save memory", isError: true))
        await sleeping.value
        #expect(completed)
        #expect(bots.allSatisfy { $0.phase == .asleep })
        #expect(fake.agents.allSatisfy { $0.finished })
    }

    @Test(arguments: [false, true])
    func botsWithAliasedMemoryFilesKeepOneWriterAtATime(viaSymlink: Bool) async throws {
        let fake = FakeLauncher()
        fake.respond = { $0.hasPrefix(BotPrompts.tidyLead) ? nil : "Got it" }
        let shared = root.appending(path: "code/shared-memory.md")
        try FileManager.default.createDirectory(at: shared.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "".write(to: shared, atomically: true, encoding: .utf8)
        if viaSymlink {
            try FileManager.default.createSymbolicLink(at: root.appending(path: "code/memory-alias.md"), withDestinationURL: shared)
        }
        let workspace = Workspace(root: root.appending(path: "app")) { profile, store in
            var profile = profile
            if profile.name == "one" || profile.name == "two" {
                // Distinct lexical paths resolve to the same memory file.
                profile.memoryPath = profile.name == "one" ? "../shared-memory.md"
                    : viaSymlink ? "../memory-alias.md" : ".././shared-memory.md"
            }
            return Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let bots = [try project("one", in: workspace), try project("two", in: workspace)]
        defer {
            bots.forEach { $0.stop() }
            try? FileManager.default.removeItem(at: root)
        }
        for bot in bots { bot.send("Remember this") }
        await eventually { fake.agents.count == 2 && bots.allSatisfy { !$0.isWorking } }
        let sleeping = Task { await workspace.putEveryoneToSleep() }
        await eventually({ bots.contains { $0.phase == .tidying } }, timeout: 3)
        #expect(bots.filter { $0.phase == .tidying }.count == 1)
        #expect(bots.filter { $0.phase == .awake }.count == 1)
        let first = try #require(fake.agents.first { $0.sent.contains { $0.hasPrefix(BotPrompts.tidyLead) } })
        first.reply("OK")
        await eventually { fake.agents.allSatisfy { $0.sent.contains { $0.hasPrefix(BotPrompts.tidyLead) } } }
        #expect(first.finished)
        #expect(bots.filter { $0.phase == .tidying }.count == 1)
        fake.agents.first { $0 !== first }?.reply("OK")
        await sleeping.value
        #expect(bots.allSatisfy { $0.phase == .asleep })
    }

    @Test func busyAndSleepingBotsAreNotForcedToTidy() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let workspace = Workspace(root: root.appending(path: "app")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let busy = try project("busy", in: workspace)
        defer {
            busy.stop()
            try? FileManager.default.removeItem(at: root)
        }
        busy.send("Still working")
        await eventually { busy.isWorking && fake.agents.count == 1 }
        await workspace.putEveryoneToSleep()
        #expect(busy.isWorking)
        #expect(workspace.mainBot.phase == .asleep)
        #expect(fake.agents.count == 1)
        #expect(!fake.agents[0].finished)
        #expect(!fake.agents[0].sent.contains { $0.hasPrefix(BotPrompts.tidyLead) })
    }
}
