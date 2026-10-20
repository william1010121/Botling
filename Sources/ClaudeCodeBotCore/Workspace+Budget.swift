import Foundation

/// The daily budget: what bots spend is added up per day; once it is used up, work nobody typed
/// (routines, handed-over work, teams) waits, and a card in the main bot's chat says so. Your own
/// messages always go through.
extension Workspace {
    /// Today's spending has reached the budget (plus anything you allowed on top).
    public var isOverBudget: Bool {
        let today = Spending.today()
        guard spending.day == today else { return false }
        return spending.isOver(settings.dailyBudget)
    }

    /// Adds what a bot or team spent; the first time today's budget is used up, says so.
    func record(_ amount: Double, by name: String, on date: Date = Date()) {
        let wasOver = isOverBudget
        spending.add(amount, by: name, on: date)
        spending.save(to: spendingURL)
        guard !wasOver, isOverBudget, let budget = settings.dailyBudget else { return }
        warnBudget(budget)
    }

    /// No limit with nil or 0.
    public func setDailyBudget(_ dollars: Double?) {
        settings.dailyBudget = dollars.flatMap { $0 > 0 ? $0 : nil }
        settings.save(to: settingsURL)
        // Room again: what waited goes on.
        if !isOverBudget { deliverInboxes() }
    }

    private func warnBudget(_ budget: Double) {
        guard !spending.warned else { return }
        spending.warned = true
        spending.save(to: spendingURL)
        let text = "Today's spending reached \(Self.dollars(spending.spent)) of your \(Self.dollars(budget)) budget. Routines, handed-over work and teams wait until tomorrow; your own messages still go through."
        budgetQuestion = tell(mainBot, text, choices: [
            Choice(label: "Allow \(Self.dollars(budget)) more today", detail: nil, recommended: false),
            Choice(label: "Keep it stopped", detail: nil, recommended: true)
        ])
    }

    /// Your pick on the budget card.
    func answerBudget(_ index: Int) {
        guard index == 0, let budget = settings.dailyBudget else { return }
        spending.allowance += budget
        spending.warned = false
        spending.save(to: spendingURL)
        deliverInboxes()
    }

    public static func dollars(_ amount: Double) -> String {
        "$" + String(format: "%.2f", amount)
    }
}
