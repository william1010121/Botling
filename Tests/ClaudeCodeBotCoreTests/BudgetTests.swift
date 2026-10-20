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

    @Test func theResultLineCarriesTheTurnsTokens() {
        let line = #"{"type":"result","is_error":false,"result":"OK","total_cost_usd":0.01,"usage":{"input_tokens":2,"output_tokens":77,"cache_creation_input_tokens":100,"cache_read_input_tokens":400}}"#
        #expect(StreamEvent.events(in: line).first == .usage(totalCost: 0.01, tokens: TokenUsage(input: 2, output: 77, cacheWrite: 100, cacheRead: 400)))
    }

    @Test func tokensAddUpByBotAndPastDaysAreKept() {
        var spending = Spending(day: "2026-10-19", spent: 1)
        spending.tokens = TokenUsage(input: 10)
        spending.add(0, tokens: TokenUsage(output: 5), by: "garden")
        spending.add(0, tokens: TokenUsage(output: 5), by: "garden")
        #expect(spending.day == Spending.today())
        #expect(spending.tokens == TokenUsage(output: 10) && spending.tokensByBot["garden"] == TokenUsage(output: 10))
        #expect(spending.history == [DayTotal(day: "2026-10-19", spent: 1, tokens: TokenUsage(input: 10))])
    }

    @Test func anIgnoredWaitingItemLeavesTheListAndStaysGone() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        let memory = project.notesFolder.appending(path: "memory.md")
        try FileManager.default.createDirectory(at: project.notesFolder, withIntermediateDirectories: true)
        try "## Waiting on you\n- Pick a cover\n- Approve the logo\n".write(to: memory, atomically: true, encoding: .utf8)
        workspace.refreshWaiting()
        #expect(workspace.waiting.map(\.text) == ["Pick a cover", "Approve the logo"])

        workspace.ignoreWaiting(workspace.waiting[0])
        #expect(workspace.waiting.map(\.text) == ["Approve the logo"])
        #expect(AppSettings.load(from: workspace.settingsURL).ignoredWaiting?.count == 1)

        workspace.showIgnoredWaiting()
        #expect(workspace.waiting.count == 2)
    }

    @Test func aSpendingFileFromBeforeTokensStillLoads() throws {
        let url = root.appending(path: "spending.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(#"{"day":"\#(Spending.today())","spent":2,"allowance":0,"byBot":{"x":2},"warned":false}"#.utf8).write(to: url)
        let loaded = Spending.load(from: url)
        #expect(loaded.spent == 2 && loaded.tokens == TokenUsage())
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
