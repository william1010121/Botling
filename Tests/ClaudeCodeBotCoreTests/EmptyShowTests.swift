import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A bot wrote `<show name="x"></show>` for a component that takes its data from the bot (no
/// `Command:` line, perhaps only a `Board command:`): there is nothing to draw. The user's chat
/// shows nothing there instead of a red "Nothing to show" card, and the bot hears why with the
/// user's next message so it learns to put the JSON in the tag.
@MainActor
struct EmptyShowTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-empty-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, about: String, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try about.write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func displays(_ workspace: Workspace, of message: ChatMessage) throws -> [[String: Any]] {
        let bot = workspace.mainBot
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot), pins: workspace.pinContext(for: bot)) { _ in "" }.json()
        let payload = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let messages = try #require(payload["messages"] as? [[String: Any]])
        return try #require(messages.first { $0["id"] as? String == message.id.uuidString }?["displays"] as? [[String: Any]])
    }

    func reply(_ bot: Bot, showing instances: [ComponentInstance]) -> ChatMessage {
        var message = ChatMessage(role: .bot, text: "Fixed it.\n\n\n\nPush it?")
        message.displays = instances
        bot.post(message, unread: false)
        return message
    }

    @Test func anEmptyShowOfABotFilledComponentDrawsNothingAndTheBotIsTold() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        try addComponent("diff-view", about: "Diff viewer. Call it up with `<show name=\"diff-view\">JSON</show>`.\nBoard command: git show --numstat HEAD", to: workspace)
        try addComponent("stats", about: "Stats.\nCommand: `echo {}`", to: workspace)
        let bot = workspace.mainBot
        let message = reply(bot, showing: [
            ComponentInstance(name: "diff-view", data: "null", at: 11),
            ComponentInstance(name: "stats", data: "null"),
            ComponentInstance(name: "diff-view", data: #"{"files":[]}"#),
        ])

        let shown = try displays(workspace, of: message)
        // No error for the user: the page draws nothing for it.
        #expect(shown[0]["status"] as? String == "empty")
        #expect(shown[0]["error"] == nil)
        // One with a Command: line still runs it; one with data is drawn as always.
        #expect(shown[1]["command"] as? String == "echo {}")
        #expect(shown[2]["status"] == nil)

        let note = try #require(workspace.emptyShowNote(in: bot))
        #expect(note.hasPrefix("(App: "))
        #expect(note.contains("<show name=\"diff-view\"></show>"))
        #expect(!note.contains("\"stats\""))
        #expect(note.contains("JSON"))

        await workspace.send("Why?", to: bot)
        await eventually { fake.agents.contains { $0.sent.contains { $0.contains("Why?") } } }
        let sent = try #require(fake.agents.flatMap(\.sent).first { $0.contains("Why?") })
        #expect(sent.contains("<show name=\"diff-view\"></show>"))
        // Told once.
        await eventually { bot.phase != .asleep }
        #expect(workspace.emptyShowNote(in: bot) == nil)
    }

    @Test func theBriefingSaysABotFilledComponentNeedsItsJSON() throws {
        let brief = makeWorkspace().componentBriefing()
        #expect(brief.contains("Board command:"))
        #expect(brief.contains("draws nothing"))
    }
}
