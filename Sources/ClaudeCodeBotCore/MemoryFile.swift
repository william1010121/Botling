import Foundation

/// Reads the four-section memory.md the bots keep. The app only needs a couple of sections, and
/// reading them never wakes anyone.
public enum MemoryFile {
    /// The non-empty lines under `## <title>` (heading may carry a note after the title),
    /// without list markers. Placeholders such as "(none)" count as empty.
    public static func items(in text: String, section title: String) -> [String] {
        let titles = [title] + (legacyHeadings[title] ?? [])
        var inSection = false
        var items: [String] = []
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("## ") {
                let heading = line.dropFirst(3)
                inSection = titles.contains { heading.hasPrefix($0) }
                continue
            }
            guard inSection, !line.isEmpty else { continue }
            let item = line.replacingOccurrences(of: #"^([-*•]|\d+\.)\s*"#, with: "", options: .regularExpression)
            if !isPlaceholder(item) { items.append(item) }
        }
        return items
    }

    public static func items(at url: URL, section title: String) -> [String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return items(in: text, section: title)
    }

    /// Headings memory files had before the app was in English; old files are still read.
    static let legacyHeadings: [String: [String]] = [
        "Current status": ["現在狀態"],
        "In progress": ["進行中"],
        "Waiting on you": ["等你決定的事"],
        "Decided": ["決定過的事"]
    ]

    private static func isPlaceholder(_ item: String) -> Bool {
        let bare = item.trimmingCharacters(in: CharacterSet(charactersIn: "（）() 。.").union(.whitespaces))
        // Bots write memory.md in the user's language, so placeholders in Chinese still count.
        return bare.isEmpty || ["無", "没有", "沒有", "none", "None", "n/a", "N/A", "nothing", "Nothing", "-"].contains(bare)
    }
}
