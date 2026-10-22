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

    /// The chat column's width when there is room for it.
    public static let chatMinWidth: Double = 480
    /// The narrowest a squeezed panel gets; below it, the chat narrows instead.
    public static let panelFloor: Double = 340

    public struct Columns: Equatable, Sendable {
        /// The chat column's minimum width (it takes whatever is left over).
        public var chat: Double
        /// The right panel's width.
        public var right: Double
    }

    /// How a window `window` wide splits between the rail (`rail` wide), the chat and a right
    /// panel that wants to be `right` wide, so that nothing runs off the window's edges: the
    /// panel gives up width first (down to `panelFloor`), then the chat.
    public static func columns(window: Double, rail: Double, right wanted: Double) -> Columns {
        let room = max(0, window - rail)
        let right = min(room, max(min(wanted, room - chatMinWidth), min(wanted, panelFloor)))
        return Columns(chat: max(0, min(chatMinWidth, room - right)), right: right)
    }

    /// A section of the open panel that the strip has an icon for, in the panel's order.
    public enum Section: String, CaseIterable, Sendable {
        case waiting, members, results, settled
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
    public static func items(waiting: Int, members: Int?, results: Int, settled: Int) -> [Item] {
        var items: [Item] = []
        if waiting > 0 { items.append(Item(section: .waiting, badge: badge(waiting))) }
        if let members { items.append(Item(section: .members, badge: badge(members))) }
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
