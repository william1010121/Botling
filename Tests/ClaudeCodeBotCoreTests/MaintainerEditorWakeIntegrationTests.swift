import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Integration at the Bot event boundary: editor routing must retain the accepted
/// per-handoff wake semantics when reports overlap or an earlier handoff is cancelled.
@MainActor
struct MaintainerEditorWakeIntegrationTests {
    private func make(_ fake: FakeLauncher) -> Bot {
        fake.respond = { _ in nil }
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-editor-wake-\(UUID())")
        let store = BotStore(directory: root.appending(path: "store"))
        store.save(engine: .codex)
        let bot = Bot(profile: .maintainer(folder: root, instructions: "Use the existing component editor"),
                      launcher: fake.launcher, store: store)
        return bot
    }

    @Test(arguments: [false, true])
    func editorHandoffWakesWhileEarlierEditorRuns(_ cancelEarlier: Bool) async throws {
        let fake = FakeLauncher()
        let bot = make(fake)
        defer { bot.stop() }
        await bot.setHeads([.claude, .codex])
        bot.send("First assignment", to: .claude)
        let claude = try #require(fake.agents.first { $0.launch.engine == .claude })
        claude.reply("First. <handoff to=\"codex\">First worker task</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        #expect(codex.launch.componentEditorEnabled)
        codex.emit(.managedWorkPending(true))
        codex.emit(.trace(.subagentStarted(id: "task-1", description: "Authorized edit", type: "ccb-core:component-editor", prompt: "Edit and check", background: true)))
        codex.reply("First worker started.")
        await eventually { !bot.isWorking }
        let first = try #require(bot.handoffs.first { $0.task == "First worker task" })

        bot.send("Second assignment", to: .claude)
        claude.reply("Second. <handoff to=\"codex\">Second independent task</handoff>")
        await eventually({ codex.sent.contains { $0.contains("hands you this") && $0.contains("Second independent task") } }, timeout: 2)
        try #require(codex.sent.contains { $0.contains("hands you this") && $0.contains("Second independent task") })
        #expect(bot.trace.subagent("task-1")?.isRunning == true)
        #expect(codex.interrupts == 0)
        if cancelEarlier { #expect(bot.stopHandoff(first.id)) }
        codex.reply("Second result.")
        await eventually { claude.sent.contains { $0.contains("finished what you handed over") && $0.contains("Second result.") } }
        claude.reply("Second acknowledged.")
        await eventually { bot.handoffs.contains { $0.task == "Second independent task" && $0.state == .done } }
        #expect(!claude.sent.contains { $0.contains("finished what you handed over") && $0.contains("First worker started.") })

        codex.emit(.trace(.subagentEnded(id: "task-1", status: "completed", summary: "First finished.")))
        codex.emit(.managedWorkerReportStarted(taskID: "task-1"))
        codex.emit(.backgroundTurnStarted)
        codex.emit(.managedWorkPending(false))
        codex.reply("First result.")
        await eventually { !bot.isWorking }
        if cancelEarlier {
            #expect(!claude.sent.contains { $0.contains("finished what you handed over") && $0.contains("First result.") })
        } else {
            await eventually { claude.sent.contains { $0.contains("finished what you handed over") && $0.contains("First result.") } }
            claude.reply("First acknowledged.")
            await eventually { bot.handoffs.contains { $0.id == first.id && $0.state == .done } }
        }
        #expect(claude.sent.filter { $0.contains("finished what you handed over") && $0.contains("Second result.") }.count == 1)
    }

    @Test(arguments: [false, true])
    func editorAndGenericWorkersKeepIndependentReturnRoutes(_ reverseReports: Bool) async throws {
        let fake = FakeLauncher()
        let bot = make(fake)
        defer { bot.stop() }
        await bot.setHeads([.claude, .codex])
        var claude: FakeAgent?
        var codex: FakeAgent?
        for task in ["Alpha", "Beta"] {
            bot.send("Plan \(task)", to: .claude)
            claude = try #require(fake.agents.first { $0.launch.engine == .claude })
            claude?.reply("Delegated. <handoff to=\"codex\">\(task)</handoff>")
            await eventually { fake.agents.contains { $0.launch.engine == .codex } }
            codex = try #require(fake.agents.first { $0.launch.engine == .codex })
            await eventually({ codex?.sent.contains { $0.contains("hands you this") && $0.contains(task) } == true }, timeout: 2)
            try #require(codex?.sent.contains { $0.contains("hands you this") && $0.contains(task) } == true)
            codex?.emit(.trace(.subagentStarted(id: task, description: task, type: task == "Alpha" ? "ccb-core:component-editor" : "codex-worker", prompt: task, background: true)))
            codex?.reply("\(task) worker started.")
            await eventually { !bot.isWorking }
        }
        let sender = try #require(claude)
        let receiver = try #require(codex)
        #expect(receiver.launch.componentEditorEnabled)
        for task in reverseReports ? ["Beta", "Alpha"] : ["Alpha", "Beta"] {
            receiver.emit(.trace(.subagentEnded(id: task, status: "completed", summary: "\(task) done.")))
            receiver.emit(.managedWorkerReportStarted(taskID: task))
            receiver.emit(.backgroundTurnStarted)
            receiver.reply("\(task) result.")
            await eventually({ sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("\(task) result.") } }, timeout: 2)
            try #require(sender.sent.contains { $0.contains("finished what you handed over") && $0.contains("\(task) result.") })
            sender.reply("\(task) acknowledged.")
            await eventually { bot.handoffs.contains { $0.task == task && $0.state == .done } }
            #expect(sender.sent.filter { $0.contains("finished what you handed over") && $0.contains("\(task) result.") }.count == 1)
        }
    }

    @Test func oneAssignmentWaitsForEditorAndGenericWorkerReports() async throws {
        let fake = FakeLauncher()
        let bot = make(fake)
        defer { bot.stop() }
        await bot.setHeads([.claude, .codex])
        bot.send("Check both modules", to: .claude)
        let claude = try #require(fake.agents.first { $0.launch.engine == .claude })
        claude.reply("Delegated. <handoff to=\"codex\">Check both modules</handoff>")
        await eventually { fake.agents.contains { $0.launch.engine == .codex } }
        let codex = try #require(fake.agents.first { $0.launch.engine == .codex })
        for task in ["one", "two"] {
            codex.emit(.trace(.subagentStarted(id: task, description: task, type: task == "one" ? "ccb-core:component-editor" : "codex-worker", prompt: task, background: true)))
        }
        codex.reply("Both workers started.")
        await eventually { !bot.isWorking }
        for task in ["one", "two"] {
            codex.emit(.trace(.subagentEnded(id: task, status: "completed", summary: task)))
            codex.emit(.managedWorkerReportStarted(taskID: task))
            codex.emit(.backgroundTurnStarted)
            codex.reply("\(task) result.")
            await eventually { !bot.isWorking }
            if task == "one" { #expect(!claude.sent.contains { $0.contains("finished what you handed over") }) }
        }
        await eventually { claude.sent.contains { $0.contains("finished what you handed over") && $0.contains("two result.") } }
        #expect(claude.sent.filter { $0.contains("finished what you handed over") }.count == 1)
    }

}
