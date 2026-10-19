import Foundation

public struct Chip: Hashable, Sendable {
    public var label: String
    public var url: URL

    public init(label: String, url: URL) {
        self.label = label
        self.url = url
    }
}

public enum RichSegment: Equatable, Sendable {
    case text(String)
    case chip(Chip)
}

/// Bots write links as markdown `[label](url)`; the chat draws each one as a chip.
public enum RichText {
    private static let link = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\(([^)\s]+)\)"#)

    public static func segments(in text: String) -> [RichSegment] {
        let ns = text as NSString
        var segments: [RichSegment] = []
        var cursor = 0
        for match in link.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let url = URL(string: ns.substring(with: match.range(at: 2))) else { continue }
            if match.range.location > cursor {
                segments.append(.text(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))))
            }
            segments.append(.chip(Chip(label: ns.substring(with: match.range(at: 1)), url: url)))
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            segments.append(.text(ns.substring(from: cursor)))
        }
        return segments
    }

    public static func chips(in text: String) -> [Chip] {
        segments(in: text).compactMap {
            if case let .chip(chip) = $0 { return chip }
            return nil
        }
    }
}
