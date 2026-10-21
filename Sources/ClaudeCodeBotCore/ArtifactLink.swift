import Foundation

/// A result a bot published as a claude.ai Artifact (`https://claude.ai/artifact/…` or
/// `https://claude.ai/code/artifact/…`). The chat draws a link to one as a card under the reply:
/// its title, the host and an Open button. Artifacts are private and need the user's claude.ai
/// sign-in, which the app's own web views do not have (WebKit keeps its own cookies, not the
/// browser's), so there is no live preview and Open goes to the default browser.
public enum ArtifactLink {
    /// At most this many cards under one message.
    static let perMessage = 3

    /// `url` is a claude.ai Artifact's page.
    public static func isArtifact(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "https",
              let host = url.host?.lowercased(), host == "claude.ai" || host == "www.claude.ai" else { return false }
        let parts = url.path.split(separator: "/").map(String.init)
        let rest: ArraySlice<String> = switch parts.first {
        case "artifact": parts.dropFirst()
        case "code" where parts.dropFirst().first == "artifact": parts.dropFirst(2)
        default: []
        }
        return rest.first.map { !$0.isEmpty } ?? false
    }

    /// One card: what the bot called it, the link, and its host.
    public struct Card: Codable, Equatable, Sendable {
        public var title: String
        public var url: String
        public var host: String
    }

    /// Cards for the Artifacts a message links to, `[name](https://claude.ai/…)`: each once, at
    /// most `perMessage`.
    public static func cards(in text: String) -> [Card] {
        guard text.contains("claude.ai") else { return [] }
        var seen = Set<String>()
        var cards: [Card] = []
        for chip in RichText.chips(in: text) where cards.count < perMessage && isArtifact(chip.url) {
            guard seen.insert(chip.url.absoluteString).inserted else { continue }
            let label = chip.label.trimmingCharacters(in: .whitespaces)
            cards.append(Card(title: label.isEmpty ? "Artifact" : label, url: chip.url.absoluteString, host: chip.url.host ?? "claude.ai"))
        }
        return cards
    }
}
