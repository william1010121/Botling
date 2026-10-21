import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Live components: a command card that runs again every few seconds while it is on screen
/// (about.md's `Refresh: every 2s`), pins refreshed every few seconds, and a bot updating a card
/// it already showed (`<show name="x" id="build">`).
@MainActor
struct ComponentLiveTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-live-\(UUID().uuidString)")

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

    func payload(_ workspace: Workspace) throws -> [String: Any] {
        let bot = workspace.mainBot
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot), pins: workspace.pinContext(for: bot)) { _ in "" }.json()
        return try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    // MARK: Refresh: every 2s

    @Test func aboutMdSaysHowOftenALiveCardRuns() {
        let every = { (line: String) in ComponentLibrary.refreshInterval(inAbout: "x.\n\(line)") }
        #expect(every("Refresh: every 2s") == 2)
        #expect(every("- Refresh: `every 5 seconds`") == 5)
        #expect(every("Refresh: 1.5s") == 1.5)
        #expect(every("Refresh: every 3 min") == 180)
        // At least a second, at most an hour; anything else is no live refresh.
        #expect(every("Refresh: every 200ms") == ComponentLibrary.liveRange.lowerBound)
        #expect(every("Refresh: every 9 hours") == nil)
        #expect(every("Refresh: when you like") == nil)
        #expect(every("Command: echo 1") == nil)
    }

    @Test func aLiveCardSaysHowOftenAndRunsNoMoreOftenThanThat() async throws {
        let workspace = makeWorkspace()
        try addComponent("cpu", about: "CPU.\nCommand: `echo {\"n\":1}`\nRefresh: every 2s", to: workspace)
        try addComponent("log", about: "Log.\nCommand: `echo {}`", to: workspace)
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "")
        message.displays = [ComponentInstance(name: "cpu", data: "null"), ComponentInstance(name: "log", data: "null")]
        bot.post(message, unread: false)
        let folder = workspace.commandFolder(for: message, in: bot)
        workspace.componentCommands.approve(#"echo {"n":1}"#, in: folder)
        workspace.componentCommands.approve("echo {}", in: folder)

        let messages = try #require(try payload(workspace)["messages"] as? [[String: Any]])
        let displays = try #require(messages.first?["displays"] as? [[String: Any]])
        #expect(displays[0]["every"] as? Double == 2)
        #expect(displays[1]["every"] == nil)

        // The first run, then a live run asked for too soon: not run again.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot)
        let first = try #require(workspace.componentCommands.runs["\(message.id.uuidString)/0"]?.ranAt)
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, force: true, live: true)
        #expect(workspace.componentCommands.runs["\(message.id.uuidString)/0"]?.ranAt == first)
        // A card with no Refresh line is never run live.
        await workspace.runComponentCommand(messageID: message.id, index: 1, in: bot)
        let log = try #require(workspace.componentCommands.runs["\(message.id.uuidString)/1"]?.ranAt)
        try await Task.sleep(for: .milliseconds(1100))
        await workspace.runComponentCommand(messageID: message.id, index: 1, in: bot, force: true, live: true)
        #expect(workspace.componentCommands.runs["\(message.id.uuidString)/1"]?.ranAt == log)
        // Once its time has come it runs.
        try await Task.sleep(for: .milliseconds(1000))
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, force: true, live: true)
        #expect(try #require(workspace.componentCommands.runs["\(message.id.uuidString)/0"]?.ranAt) > first)
    }

    @Test func aPinnedLiveCardSaysHowOftenToo() throws {
        let workspace = makeWorkspace()
        try addComponent("cpu", about: "CPU.\nCommand: `echo {}`\nRefresh: every 2s", to: workspace)
        _ = try #require(workspace.pin(named: "cpu", in: workspace.mainBot))
        let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect((pins[0]["display"] as? [String: Any])?["every"] as? Double == 2)
    }

    // MARK: Pins every few seconds

    @Test func aPinCanRefreshEveryFewSeconds() throws {
        let pin = PinnedComponent(name: "cpu", command: "uptime", data: "{}", refresh: .interval, minutes: 15, seconds: 5)
        let now = Date()
        #expect(pin.interval == 5)
        #expect(!pin.isDue(at: now, lastRan: now.addingTimeInterval(-4)))
        #expect(pin.isDue(at: now, lastRan: now.addingTimeInterval(-5)))
        // Kept in pins.json; a file without seconds is in minutes, as before.
        let saved = try JSONDecoder().decode(PinnedComponent.self, from: JSONEncoder().encode(pin))
        #expect(saved.seconds == 5)
        let old = try JSONDecoder().decode(PinnedComponent.self, from: Data(#"{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","command":"ls","data":"1","refresh":"interval","minutes":2}"#.utf8))
        #expect(old.seconds == nil && old.interval == 120)
        #expect(PinnedComponent(name: "x", command: "ls", data: "1", seconds: 0).seconds == PinnedComponent.minimumSeconds)

        let workspace = makeWorkspace()
        let folder = workspace.components.folder.appending(path: "cpu")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "CPU.\nCommand: `uptime`".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
        let bot = workspace.mainBot
        let pinned = try #require(workspace.pin(named: "cpu", in: bot, refresh: .interval, minutes: 15, seconds: 3))
        #expect(bot.pins[0].seconds == 3)
        workspace.setPinRefresh(pinned.id, to: .interval, minutes: 10, seconds: nil, in: bot)
        #expect(bot.pins[0].seconds == nil && bot.pins[0].minutes == 10)
        workspace.setPinRefresh(pinned.id, to: .interval, seconds: 2, in: bot)
        #expect(bot.pins[0].seconds == 2)
        let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect(pins[0]["seconds"] as? Int == 2)
    }

    // MARK: <show id="…">

    @Test func aShowTagCanNameItsCard() {
        let parsed = ReplyParser.parseAll(#"Tests: <show name="build" id="run-1">{"pct":10}</show>"#)
        #expect(parsed.displays.first?.id == "run-1")
        #expect(ReplyParser.parseAll(#"<show name="build">{}</show>"#).displays.first?.id == nil)
    }

    @Test func aLaterShowWithTheSameIdUpdatesTheCardInPlace() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            if text.contains("start") { return #"Running the tests. <show name="build" id="run-1">{"pct":10}</show>"# }
            if text.contains("quietly") { return #"<show name="build" id="run-1">{"pct":60}</show>"# }
            if text.contains("other") { return #"Another: <show name="build" id="run-2">{"pct":1}</show>"# }
            return #"Done. <show name="build" id="run-1">{"pct":100}</show>"#
        }
        let bot = makeBot(fake)
        func settled() async { await eventually { !bot.isWorking } }

        bot.send("start")
        await eventually { bot.messages.contains { $0.role == .bot } }
        await settled()
        let card = try #require(bot.messages.last { $0.role == .bot })
        #expect(card.shown.map(\.data) == [#"{"pct":10}"#])

        // Only the update: the card above changes, and no empty bubble is added.
        let count = bot.messages.count
        bot.send("quietly")
        await eventually { bot.messages.first { $0.id == card.id }?.shown[0].data == #"{"pct":60}"# }
        await settled()
        #expect(bot.messages.count == count + 1) // your message only
        #expect(bot.messages.filter { $0.role == .bot }.count == 1)

        // The user's own change (ccb.save), then the bot's: the latest write wins.
        #expect(bot.saveComponentData(#"{"pct":70}"#, at: 0, in: card.id))
        bot.send("finish")
        await eventually { bot.messages.first { $0.id == card.id }?.shown[0].data == #"{"pct":100}"# }
        await settled()
        #expect(bot.messages.first { $0.id == card.id }?.shown[0].savedAt == nil)
        // Words with the update still show, without the card drawn again.
        let words = try #require(bot.messages.last { $0.role == .bot })
        #expect(words.id != card.id && words.text.contains("Done.") && words.shown.isEmpty)
        #expect(bot.saveComponentData(#"{"pct":99}"#, at: 0, in: card.id))
        #expect(bot.messages.first { $0.id == card.id }?.shown[0].data == #"{"pct":99}"#)

        // Another id is a card of its own.
        bot.send("other")
        await eventually { bot.messages.last { $0.role == .bot }?.shown.first?.id == "run-2" }
    }

    @Test func botsAreToldTheUsage() throws {
        let workspace = makeWorkspace()
        let note = workspace.componentBriefing(for: workspace.mainBot)
        #expect(note.contains(#"id="#))
        #expect(note.contains("Refresh: every"))
        let guide = PluginGuide.text(builtIns: "/x")
        #expect(guide.contains("Refresh: every 2s"))
        #expect(guide.contains(#"id="build""#))
    }
    // MARK: Ways of writing the interval, and <show refresh="…">

    @Test func refreshIntervalsAreReadFlexibly() {
        #expect(ComponentRefresh.seconds(from: "2s") == 2)
        #expect(ComponentRefresh.seconds(from: " 5 seconds ") == 5)
        #expect(ComponentRefresh.seconds(from: "every 10s") == 10)
        #expect(ComponentRefresh.seconds(from: "3") == 3)
        #expect(ComponentRefresh.seconds(from: "1m") == 60)
        #expect(ComponentRefresh.seconds(from: "2 min") == 120)
        #expect(ComponentRefresh.seconds(from: "60m") == 3600)
        // At least a second; over an hour, off, or not a time: no live refresh.
        #expect(ComponentRefresh.seconds(from: "500ms") == 1)
        #expect(ComponentRefresh.seconds(from: "0.2s") == 1)
        #expect(ComponentRefresh.seconds(from: "90m") == nil)
        #expect(ComponentRefresh.seconds(from: "5h") == nil)
        #expect(ComponentRefresh.seconds(from: "0") == nil)
        #expect(ComponentRefresh.seconds(from: "off") == nil)
        #expect(ComponentRefresh.seconds(from: "") == nil)
    }

    @Test func theShowTagCanAskForARefreshAndAnId() throws {
        let parsed = ReplyParser.parseAll(#"<show name="cpu" refresh="2s"></show><show name="todo" id="list-1">{"a":1}</show><show name="x" refresh="never">[1]</show>"#)
        #expect(parsed.displays.map(\.refresh) == [2, nil, nil])
        #expect(parsed.displays.map(\.id) == [nil, "list-1", nil])
        // Kept in chat.json; older files without them still load.
        let saved = try JSONDecoder().decode(ComponentInstance.self, from: JSONEncoder().encode(parsed.displays[1]))
        #expect(saved.id == "list-1")
        #expect(try JSONDecoder().decode(ComponentInstance.self, from: Data(#"{"name":"x","data":"1"}"#.utf8)).refresh == nil)
    }

    @Test func theShowTagsIntervalWinsOverAboutMd() throws {
        let workspace = makeWorkspace()
        try addComponent("cpu", about: "CPU.\nCommand: `printf 1`\nRefresh: every 2s", to: workspace)
        try addComponent("plain", about: "Plain.", to: workspace)
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "")
        message.displays = [
            ComponentInstance(name: "cpu", data: "null"),
            ComponentInstance(name: "cpu", data: "null", refresh: 5),
            ComponentInstance(name: "plain", data: "null", command: "printf 2", refresh: 1),
            // No command: nothing to refresh.
            ComponentInstance(name: "plain", data: "[1]", refresh: 3),
        ]
        bot.post(message, unread: false)
        let messages = try #require(try payload(workspace)["messages"] as? [[String: Any]])
        let shown = try #require(messages.first { $0["id"] as? String == message.id.uuidString }?["displays"] as? [[String: Any]])
        #expect(shown.map { $0["every"] as? Double } == [2, 5, 1, nil])
    }

    @Test func theComponentEditorIsToldToo() {
        #expect(ComponentPrompts.system.contains("Refresh: every 2s"))
        #expect(ComponentPrompts.system.contains("ccb.onData("))
        #expect(ComponentPrompts.system.contains("ccb.save("))
        let guide = PluginGuide.text(builtIns: "/x")
        #expect(guide.contains("ccb.onData("))
        #expect(guide.contains("ccb.load("))
        #expect(workspace().componentBriefing().contains(#"refresh=""#))
    }

    func workspace() -> Workspace { makeWorkspace() }

    // MARK: Updates from any line in the chat

    @Test func anUpdateOnlyMatchesBotCardsAndAddsNothingEmpty() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "")
        message.displays = [ComponentInstance(name: "todo", data: "[1]", id: "list")]
        bot.post(message, unread: false)

        // A group chat's line (posted) that only updates: no new line, nothing unread.
        var update = ChatMessage(role: .bot, text: "  ")
        update.displays = [ComponentInstance(name: "todo", data: "[9]", id: "list")]
        bot.post(update)
        #expect(bot.messages.count == 1)
        #expect(bot.unreadCount == 0)
        #expect(bot.messages[0].shown[0].data == "[9]")
        // Kept for after a restart.
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadMessages()[0].shown[0].data == "[9]")

        // An id nobody has yet is a new card; a user's line never updates one.
        var fresh = ChatMessage(role: .bot, text: "")
        fresh.displays = [ComponentInstance(name: "todo", data: "[0]", id: "other")]
        bot.post(fresh, unread: false)
        var user = ChatMessage(role: .user, text: "hi")
        user.displays = [ComponentInstance(name: "todo", data: "[5]", id: "list")]
        bot.post(user, unread: false)
        #expect(bot.messages.count == 3)
        #expect(bot.messages[0].shown[0].data == "[9]")
    }
}
