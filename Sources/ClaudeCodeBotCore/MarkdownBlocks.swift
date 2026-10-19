import Foundation

/// The blocks of a bot's markdown reply. Inline styling (bold, italic, code, links) is left to
/// `AttributedString(markdown:)`; images and videos (`![caption](url)`) become media blocks.
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullets([String])
    case numbered([String])
    case quote(String)
    case code(String)
    case table(header: [String], rows: [[String]])
    case rule
    case media(alt: String, url: URL)

    private static let imagePattern = try! NSRegularExpression(pattern: #"!\[([^\]\n]*)\]\(([^)\s]+)\)"#)

    public static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        let lines = text.components(separatedBy: "\n")
        var index = 0

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            appendText(paragraph.joined(separator: "\n"))
            paragraph.removeAll()
        }
        /// A paragraph, with any images in it pulled out after it.
        func appendText(_ text: String) {
            let (rest, media) = extractMedia(text)
            if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.paragraph(rest.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            blocks.append(contentsOf: media)
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flushParagraph()
                var code: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[index])
                    index += 1
                }
                blocks.append(.code(code.joined(separator: "\n")))
                index += 1
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }
            if let level = headingLevel(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: level, text: String(trimmed.dropFirst(level + 1))))
                index += 1
                continue
            }
            if ["---", "***", "___"].contains(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }
            if trimmed.hasPrefix("|"), index + 1 < lines.count, isTableSeparator(lines[index + 1]) {
                flushParagraph()
                let header = cells(trimmed)
                var rows: [[String]] = []
                index += 2
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[index].trimmingCharacters(in: .whitespaces)))
                    index += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoted: [String] = []
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quoted.append(lines[index].trimmingCharacters(in: .whitespaces).dropFirst().trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }
            if bulletText(trimmed) != nil {
                flushParagraph()
                var items: [String] = []
                while index < lines.count, let item = bulletText(lines[index].trimmingCharacters(in: .whitespaces)) {
                    items.append(item)
                    index += 1
                }
                blocks.append(.bullets(items))
                continue
            }
            if numberedText(trimmed) != nil {
                flushParagraph()
                var items: [String] = []
                while index < lines.count, let item = numberedText(lines[index].trimmingCharacters(in: .whitespaces)) {
                    items.append(item)
                    index += 1
                }
                blocks.append(.numbered(items))
                continue
            }
            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    static func extractMedia(_ text: String) -> (String, [MarkdownBlock]) {
        let ns = text as NSString
        var media: [MarkdownBlock] = []
        for match in imagePattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if let url = URL(string: ns.substring(with: match.range(at: 2))) {
                media.append(.media(alt: ns.substring(with: match.range(at: 1)), url: url))
            }
        }
        let rest = imagePattern.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        return (rest, media)
    }

    private static func headingLevel(_ line: String) -> Int? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }

    private static func bulletText(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ ", "• "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count))
        }
        return nil
    }

    private static func numberedText(_ line: String) -> String? {
        guard let dot = line.firstIndex(where: { $0 == "." || $0 == ")" }),
              !line[..<dot].isEmpty, line[..<dot].allSatisfy(\.isNumber),
              line[line.index(after: dot)...].first == " " else { return nil }
        return String(line[line.index(dot, offsetBy: 2)...])
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.allSatisfy { "|-: ".contains($0) } && trimmed.contains("-")
    }

    private static func cells(_ line: String) -> [String] {
        var parts = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.first == "" { parts.removeFirst() }
        if parts.last == "" { parts.removeLast() }
        return parts
    }
}

