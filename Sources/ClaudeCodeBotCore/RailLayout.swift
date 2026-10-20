import Foundation

/// The left column's two widths, and the line under a face's name when the column is folded
/// into a strip of faces and the pointer rests on one.
public enum RailLayout {
    public static let expandedWidth: Double = 240
    public static let collapsedWidth: Double = 56

    public static func width(collapsed: Bool) -> Double {
        collapsed ? collapsedWidth : expandedWidth
    }

    /// "Done, click to see · 2 unread": the status, then whether it waits on you, then how
    /// many lines you have not read (as the badge counts them).
    public static func tipDetail(status: String, unread: Int, waiting: Bool) -> String {
        var parts = [status]
        if waiting { parts.append("waiting on you") }
        if unread > 0 { parts.append("\(unread > 99 ? "99+" : "\(unread)") unread") }
        return parts.joined(separator: " · ")
    }
}
