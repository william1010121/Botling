import Foundation

/// The right panel's two widths, and what its folded strip of icons shows: one icon per section
/// the open panel would show, with a count badge, each opening that section beside the strip.
public enum RightPanelLayout {
    public static let expandedWidth: Double = 340
    public static let collapsedWidth: Double = 56

    public static func width(collapsed: Bool) -> Double {
        collapsed ? collapsedWidth : expandedWidth
    }

    /// While a component spec is open (its chip pressed): the workspace, or spread wide.
    public static let specWidth: Double = 480
    public static let specWideWidth: Double = 860

    public static func specWidth(wide: Bool) -> Double {
        wide ? specWideWidth : specWidth
    }

    /// A section of the open panel that the strip has an icon for, in the panel's order.
    public enum Section: String, CaseIterable, Sendable {
        case waiting, members, codex, results, settled
    }

    public struct Item: Equatable, Sendable {
        public var section: Section
        public var badge: String?

        public init(section: Section, badge: String?) {
            self.section = section
            self.badge = badge
        }
    }

    /// "3", "99+", or nil for none.
    public static func badge(_ count: Int) -> String? {
        count <= 0 ? nil : count > 99 ? "99+" : "\(count)"
    }

    /// The strip's icons between the face and the settings button. `members` is a group
    /// chat's member count (nil for a bot); a section with nothing in it has no icon, as the
    /// open panel leaves it out.
    public static func items(waiting: Int, members: Int?, showsCodex: Bool, results: Int, settled: Int) -> [Item] {
        var items: [Item] = []
        if waiting > 0 { items.append(Item(section: .waiting, badge: badge(waiting))) }
        if let members { items.append(Item(section: .members, badge: badge(members))) }
        if showsCodex { items.append(Item(section: .codex, badge: nil)) }
        if results > 0 { items.append(Item(section: .results, badge: badge(results))) }
        if settled > 0 { items.append(Item(section: .settled, badge: badge(settled))) }
        return items
    }

    /// The face's hover tip: the Now card's status, then what the bot is doing, if it says.
    public static func nowDetail(status: String, doing: String?) -> String {
        guard let doing = doing?.trimmingCharacters(in: .whitespacesAndNewlines), !doing.isEmpty else { return status }
        return "\(status) · \(doing)"
    }
}
