import Foundation

/// What bots spend is added up per day, for the usage page. It never holds work back.
extension Workspace {
    /// Adds what a bot or team spent.
    func record(_ amount: Double, tokens: TokenUsage = TokenUsage(), by name: String, on date: Date = Date()) {
        spending.add(amount, tokens: tokens, by: name, on: date)
        spending.save(to: spendingURL)
    }

    /// Keeps the latest reading of each subscription limit.
    func note(_ limits: RateLimits) {
        var next = rateLimits
        next.merge(limits)
        guard next != rateLimits else { return }
        rateLimits = next
        rateLimits.save(to: rateLimitsURL)
    }

    public static func dollars(_ amount: Double) -> String {
        "$" + String(format: "%.2f", amount)
    }

    /// "1.2M", "34.5K", "812".
    public static func tokenCount(_ count: Int) -> String {
        switch count {
        case 1_000_000...: String(format: "%.1fM", Double(count) / 1_000_000)
        case 1_000...: String(format: "%.1fK", Double(count) / 1_000)
        default: "\(count)"
        }
    }
}
