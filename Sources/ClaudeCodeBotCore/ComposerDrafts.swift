import Foundation

/// What you typed in a chat's input box but did not send, by chat (the page's `botID`: a bot,
/// a group, a subagent view), in `drafts.json` so it is still there after a restart. The page
/// keeps the drafts while it runs and tells the app when one changes (a moment after typing
/// stops, on switching chats, on sending); the app hands them all back when the page loads.
@MainActor
public final class ComposerDrafts {
    public struct Draft: Codable, Equatable, Sendable {
        public var text: String
        /// Where the caret was, in UTF-16 units of `text` (as the page counts).
        public var cursor: Int

        public init(text: String, cursor: Int) {
            self.text = text
            self.cursor = cursor
        }
    }

    public let url: URL
    public private(set) var all: [String: Draft]

    public init(url: URL) {
        self.url = url
        let data = try? Data(contentsOf: url)
        all = data.flatMap { try? JSONDecoder().decode([String: Draft].self, from: $0) } ?? [:]
    }

    /// Keeps `draft` for `chat`; nil or empty text forgets it.
    public func set(_ chat: String, _ draft: Draft?) {
        let next = draft.flatMap { $0.text.isEmpty ? nil : $0 }
        guard all[chat] != next else { return }
        all[chat] = next
        save()
    }

    /// `ccb.setDrafts(...)` with every draft, for the page once it is ready.
    public var script: String {
        "ccb.setDrafts(\(ChatPayload.encode(all) ?? "{}"))"
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(all) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
