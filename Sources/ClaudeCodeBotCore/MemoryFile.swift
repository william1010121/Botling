import Foundation

/// Reads the four-section memory.md the bots keep. The app only needs a couple of sections, and
/// reading them never wakes anyone.
public enum MemoryFile {
    /// The non-empty lines under `## <title>` (heading may carry a note after the title),
    /// without list markers. Placeholders such as 「（無）」 count as empty.
    public static func items(in text: String, section title: String) -> [String] {
        var inSection = false
        var items: [String] = []
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("## ") {
                inSection = line.dropFirst(3).hasPrefix(title)
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

    private static func isPlaceholder(_ item: String) -> Bool {
        let bare = item.trimmingCharacters(in: CharacterSet(charactersIn: "（）() 。.").union(.whitespaces))
        return bare.isEmpty || ["無", "没有", "沒有", "none", "None", "-"].contains(bare)
    }
}
