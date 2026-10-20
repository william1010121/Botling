import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// What bots spend is added up per day; past the budget only work nobody typed waits.
@MainActor
struct BudgetTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-budget-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func theResultLineCarriesTheSessionsRunningCost() {
        let line = #"{"type":"result","subtype":"success","is_error":false,"result":"OK","total_cost_usd":0.0077}"#
        #expect(StreamEvent.events(in: line) == [.usage(totalCost: 0.0077), .reply("OK", isError: false)])
    }

    @Test func eachTurnCountsWhatItAddedToTheRunningTotal() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        var spent: [Double] = []
        bot.onSpend = { spent.append($0) }
        bot.send("one")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].emit(.usage(totalCost: 0.004))
        fake.agents[0].reply("1")
        await eventually { bot.messages.last?.text == "1" }
        bot.send("two")
        fake.agents[0].emit(.usage(totalCost: 0.010))
        fake.agents[0].reply("2")
        await eventually { bot.messages.last?.text == "2" }
        try #require(spent.count == 2)
        #expect(abs(spent[0] - 0.004) < 1e-9 && abs(spent[1] - 0.006) < 1e-9)
    }

    @Test func aNewDayStartsFromZero() {
        var spending = Spending(day: "2026-10-19", spent: 3, allowance: 1, byBot: ["Main bot": 3], warned: true)
        spending.add(0.5, by: "garden", on: Date())
        #expect(spending.day == Spending.today())
        #expect(spending.spent == 0.5 && spending.allowance == 0 && !spending.warned)
        #expect(spending.byBot == ["garden": 0.5])
    }

    @Test func pastTheBudgetOnlyWorkNobodyTypedWaits() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        workspace.setDailyBudget(1)
        #expect(!workspace.isOverBudget)

        workspace.record(1.2, by: "garden")
        #expect(workspace.isOverBudget)
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })
        #expect(card.text.contains("$1.20 of your $1.00 budget"))
        // Saying it again later today does not repeat the card.
        workspace.record(0.1, by: "garden")
        #expect(workspace.mainBot.messages.filter(\.isOpenQuestion).count == 1)

        // Handed-over work waits in the inbox; a team does not start.
        try "Water the plants\n".write(to: project.inboxURL, atomically: true, encoding: .utf8)
        workspace.deliverInboxes()
        let manager = try #require(workspace.bot(for: project))
        #expect(manager.messages.isEmpty)
        #expect(workspace.startTeam("research", task: "Look it up") == nil)
        // Your own message still goes through.
        manager.send("Hi")
        await eventually { manager.messages.last?.role == .bot }

        // Allowing more today lets the waiting work go on.
        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        #expect(!workspace.isOverBudget)
        await eventually { manager.messages.contains { $0.role == .relay && $0.text == "Water the plants" } }
        // It was saved.
        #expect(AppSettings.load(from: root.appending(path: "ccb/settings.json")).dailyBudget == 1)
        #expect(Spending.load(from: root.appending(path: "ccb/spending.json")).allowance == 1)
    }

    @Test func noBudgetMeansNoLimit() {
        let workspace = makeWorkspace(FakeLauncher())
        workspace.record(500, by: "garden")
        #expect(!workspace.isOverBudget)
        workspace.setDailyBudget(0)
        #expect(workspace.settings.dailyBudget == nil)
    }
}
