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

    /// The one sign at the end of a bot or group row (or at a folded face's corner): how many
    /// lines you have not read, nil for none or while the chat is open. Waiting on you draws
    /// nothing here (no orange dot); it stays in the hover tip and the accessibility label.
    public static func unreadBadge(unread: Int, waiting: Bool, selected: Bool) -> Int? {
        unread > 0 && !selected ? unread : nil
    }

    /// What the search field says when nothing in the column matches.
    public static let noMatches = "No bots match"
    /// Puts the cursor in the column's search field (and opens a folded column).
    public static let searchShortcut = "⌘K"

    /// Rows split into the pinned ones, in the order they were pinned, and the rest, in the
    /// order they came in. Pinned ids with no row are skipped.
    public static func pinnedFirst<Row>(_ rows: [Row], id: (Row) -> UUID, pinned: [UUID]) -> (pinned: [Row], rest: [Row]) {
        let order = Dictionary(pinned.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        var top: [(Int, Row)] = []
        var rest: [Row] = []
        for row in rows {
            if let place = order[id(row)] { top.append((place, row)) } else { rest.append(row) }
        }
        return (top.sorted { $0.0 < $1.0 }.map(\.1), rest)
    }

    /// Whether a row is kept while searching: its name or its project folder's name contains
    /// the query, ignoring case and accents. An empty query keeps every row.
    public static func matches(_ query: String, name: String, folder: String?) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        return name.range(of: query, options: options) != nil
            || (folder?.range(of: query, options: options) != nil)
    }
}
