import Foundation

/// The four sections of the memory.md every bot keeps, in their order. The bot's prompt and the
/// app read them from here, so a section is named in one place.
public enum MemorySection: CaseIterable, Sendable {
    case currentStatus, inProgress, waitingOnYou, decided

    /// Its heading, as bots are told to write it (`## <heading>`).
    public var heading: String {
        switch self {
        case .currentStatus: "Current status"
        case .inProgress: "In progress"
        case .waitingOnYou: "Waiting on you"
        case .decided: "Decided"
        }
    }

    /// What the prompt adds after the heading.
    var rule: String? {
        switch self {
        case .currentStatus: "3 sentences max"
        case .decided: "date each"
        default: nil
        }
    }

    /// Headings memory files had before the app was in English; old files are still read.
    var legacyHeadings: [String] {
        switch self {
        case .currentStatus: ["現在狀態"]
        case .inProgress: ["進行中"]
        case .waitingOnYou: ["等你決定的事"]
        case .decided: ["決定過的事"]
        }
    }

    var headings: [String] { [heading] + legacyHeadings }
}

/// Reads the four-section memory.md the bots keep. The app only needs a couple of sections, and
/// reading them never wakes anyone.
public enum MemoryFile {
    /// The non-empty lines under the section's heading (which may carry a note after it), without
    /// list markers. A section is found by its heading; in a file whose headings are none the app
    /// knows (the bot wrote them in another language) but are the four, by its place. Lines that
    /// are only punctuation or only a remark in brackets ("(none)") are no items: bots are told to
    /// leave an empty section empty.
    public static func items(in text: String, section: MemorySection) -> [String] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        let headings = lines.filter { $0.hasPrefix("## ") }.map { String($0.dropFirst(3)) }
        let known = { (heading: String) in MemorySection.allCases.contains { $0.headings.contains { heading.hasPrefix($0) } } }
        let byPlace = !headings.contains(where: known) && headings.count == MemorySection.allCases.count
        let place = MemorySection.allCases.firstIndex(of: section) ?? 0
        var seen = -1
        var inSection = false
        var items: [String] = []
        for line in lines {
            if line.hasPrefix("## ") {
                seen += 1
                let heading = line.dropFirst(3)
                inSection = byPlace ? seen == place : section.headings.contains { heading.hasPrefix($0) }
                continue
            }
            guard inSection, !line.isEmpty else { continue }
            let item = line.replacingOccurrences(of: #"^([-*•]|\d+\.)\s*"#, with: "", options: .regularExpression)
            if !isEmptyMark(item) { items.append(item) }
        }
        return items
    }

    public static func items(at url: URL, section: MemorySection) -> [String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return items(in: text, section: section)
    }

    /// Nothing but punctuation, or a whole line in brackets: a remark, not an item.
    private static func isEmptyMark(_ item: String) -> Bool {
        let bare = item.trimmingCharacters(in: .whitespaces.union(.punctuationCharacters).union(.symbols))
        if bare.isEmpty { return true }
        let pairs: [(Character, Character)] = [("(", ")"), ("（", "）"), ("[", "]"), ("【", "】")]
        return pairs.contains { open, close in
            item.first == open && item.last == close && !item.dropFirst().dropLast().contains(open)
        }
    }
}
