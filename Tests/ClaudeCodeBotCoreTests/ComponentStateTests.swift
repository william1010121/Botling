import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A component that keeps its own state (`ccb.save(data)`): a todo list whose ticks and new items
/// stay, in the chat message and on its pin, without locking the card or waking the bot.
@MainActor
struct ComponentStateTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-state-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, command: String? = nil, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "\(name).\n\(command.map { "Command: `\($0)`" } ?? "")".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func payload(_ workspace: Workspace) throws -> [String: Any] {
        let bot = workspace.mainBot
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot), pins: workspace.pinContext(for: bot)) { _ in "" }.json()
        return try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    /// A bot reply showing the todo list, with a question on it too (it must stay open).
    func todoReply(in bot: Bot) -> ChatMessage {
        var message = ChatMessage(role: .bot, text: "Your list:", choices: [Choice(label: "Done", detail: nil, recommended: false)])
        message.displays = [ComponentInstance(name: "todo", data: #"{"items":[{"text":"Milk","done":false}]}"#)]
        bot.post(message, unread: false)
        return message
    }

    static let ticked = #"{"items":[{"text":"Milk","done":true},{"text":"Eggs","done":false}]}"#

    @Test func aChatComponentSavesItsDataIntoTheMessage() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        try addComponent("todo", to: workspace)
        let bot = workspace.mainBot
        let message = todoReply(in: bot)
        let count = bot.messages.count

        #expect(workspace.saveComponentData(Self.ticked, messageID: message.id, index: 0, in: bot))

        // In the message, in chat.json (so it survives a restart), and drawn with it.
        #expect(bot.messages.first { $0.id == message.id }?.shown[0].data == Self.ticked)
        let reloaded = BotStore(directory: root.appending(path: "ccb/main")).loadMessages()
        #expect(reloaded.first { $0.id == message.id }?.shown[0].data == Self.ticked)
        #expect(reloaded.first { $0.id == message.id }?.shown[0].savedAt != nil)
        let messages = try #require(try payload(workspace)["messages"] as? [[String: Any]])
        let displays = try #require(messages.first { $0["id"] as? String == message.id.uuidString }?["displays"] as? [[String: Any]])
        #expect(displays[0]["data"] as? String == Self.ticked)

        // It does not lock the card or wake the bot: the question stays open, nothing was sent.
        let saved = try #require(bot.messages.first { $0.id == message.id })
        #expect(saved.isOpenQuestion)
        #expect(bot.messages.count == count)
        #expect(fake.agents.isEmpty)
        #expect(bot.phase == .asleep)

        // Saved again: the newest wins.
        #expect(workspace.saveComponentData(#"{"items":[]}"#, messageID: message.id, index: 0, in: bot))
        #expect(bot.messages.first { $0.id == message.id }?.shown[0].data == #"{"items":[]}"#)
    }

    @Test func onlyWellFormedDataIsSaved() throws {
        let workspace = makeWorkspace()
        try addComponent("todo", to: workspace)
        try addComponent("stats", command: "echo {}", to: workspace)
        let bot = workspace.mainBot
        let message = todoReply(in: bot)
        // Not JSON, null (it would mean "no data"), too big, a place that is not there.
        #expect(!workspace.saveComponentData("{items", messageID: message.id, index: 0, in: bot))
        #expect(!workspace.saveComponentData("null", messageID: message.id, index: 0, in: bot))
        let big = "\"" + String(repeating: "x", count: ComponentState.limit) + "\""
        #expect(!workspace.saveComponentData(big, messageID: message.id, index: 0, in: bot))
        #expect(!workspace.saveComponentData("{}", messageID: message.id, index: 3, in: bot))
        #expect(!workspace.saveComponentData("{}", messageID: UUID(), index: 0, in: bot))
        #expect(bot.messages.first { $0.id == message.id }?.shown[0].data == #"{"items":[{"text":"Milk","done":false}]}"#)
        // A plain value is fine.
        #expect(workspace.saveComponentData("3", messageID: message.id, index: 0, in: bot))

        // A card whose data comes from a command keeps showing the command's output: not saved.
        var commandCard = ChatMessage(role: .bot, text: "")
        commandCard.displays = [ComponentInstance(name: "stats", data: "null")]
        bot.post(commandCard, unread: false)
        #expect(!workspace.saveComponentData("{}", messageID: commandCard.id, index: 0, in: bot))
        #expect(bot.messages.first { $0.id == commandCard.id }?.shown[0].data == "null")
    }

    @Test func aPinKeepsItsOwnSavedData() throws {
        let workspace = makeWorkspace()
        try addComponent("todo", to: workspace)
        try addComponent("stats", command: "echo {}", to: workspace)
        let bot = workspace.mainBot
        let message = todoReply(in: bot)
        let pin = try #require(workspace.pin(messageID: message.id, index: 0, in: bot))

        #expect(workspace.savePinData(Self.ticked, pin: pin.id, in: bot))
        #expect(bot.pins[0].data == Self.ticked)
        #expect(bot.pins[0].savedAt != nil)
        // Kept in pins.json for after a restart, and drawn with it.
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins()[0].data == Self.ticked)
        let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect((pins[0]["display"] as? [String: Any])?["data"] as? String == Self.ticked)
        // The pin is a copy: the chat message keeps its own.
        #expect(bot.messages.first { $0.id == message.id }?.shown[0].data == #"{"items":[{"text":"Milk","done":false}]}"#)

        // Bad data is not saved; a pin with a command gets its data from the command.
        #expect(!workspace.savePinData("{oops", pin: pin.id, in: bot))
        let stats = try #require(workspace.pin(named: "stats", in: bot))
        #expect(!workspace.savePinData("{}", pin: stats.id, in: bot))
        #expect(bot.pins.first { $0.id == stats.id }?.data == "null")

        // Older pins.json and chat.json files without savedAt still load.
        let json = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1"}]"#
        #expect(try JSONDecoder().decode([PinnedComponent].self, from: Data(json.utf8))[0].savedAt == nil)
        #expect(try JSONDecoder().decode(ComponentInstance.self, from: Data(#"{"name":"x","data":"1"}"#.utf8)).savedAt == nil)
    }

    @Test func theBotHearsTheLatestStateWithTheNextMessage() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        try addComponent("todo", to: workspace)
        let bot = workspace.mainBot
        let message = todoReply(in: bot)
        #expect(workspace.componentStateNote(in: bot) == nil)

        #expect(workspace.saveComponentData(Self.ticked, messageID: message.id, index: 0, in: bot))
        let pin = try #require(workspace.pin(messageID: message.id, index: 0, in: bot))
        #expect(workspace.savePinData(#"{"items":[]}"#, pin: pin.id, in: bot))
        let note = try #require(workspace.componentStateNote(in: bot))
        #expect(note.hasPrefix("(App: "))
        #expect(note.contains("\"todo\""))
        #expect(note.contains(Self.ticked))
        #expect(note.contains(#"{"items":[]}"#))
        #expect(note.contains("pinned"))
        // Where it is kept, for a bot that wants to read it again later.
        #expect(note.contains("chat.json"))
        #expect(note.contains("pins.json"))

        await workspace.send("What is left?", to: bot)
        await eventually { fake.agents.contains { $0.sent.contains { $0.contains("What is left?") } } }
        let sent = try #require(fake.agents.flatMap(\.sent).first { $0.contains("What is left?") })
        #expect(sent.contains(Self.ticked))
        // Told once: the next message has nothing new to say about it.
        await eventually { bot.phase != .asleep }
        #expect(workspace.componentStateNote(in: bot) == nil)
    }

    @Test func aLongStateIsCutInTheNote() throws {
        let workspace = makeWorkspace()
        try addComponent("todo", to: workspace)
        let bot = workspace.mainBot
        let message = todoReply(in: bot)
        let long = "[" + Array(repeating: #""a fairly long todo item""#, count: 400).joined(separator: ",") + "]"
        #expect(workspace.saveComponentData(long, messageID: message.id, index: 0, in: bot))
        let note = try #require(workspace.componentStateNote(in: bot))
        #expect(note.count < long.count)
        #expect(note.contains("…"))
    }

    @Test func pluginsMdDocumentsSave() {
        let guide = PluginGuide.text(builtIns: "/x")
        #expect(guide.contains("ccb.save("))
        #expect(guide.contains("pins.json"))
    }
}
