import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A pin floated in a corner of the chat window: kept in pins.json, shown in its own bot's chat
/// only unless shown in all bots (a reference in settings.json), at most two cards per chat, its
/// menu saying Float or Stop floating.
@MainActor
struct FloatingPinTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-float-\(UUID().uuidString)")

    func makeWorkspace() -> Workspace {
        let fake = FakeLauncher()
        return Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
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

    func payload(_ workspace: Workspace, bot: Bot) throws -> [String: Any] {
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot), pins: workspace.pinContext(for: bot), floating: workspace.floatingPinViews(in: bot)) { _ in "" }.json()
        return try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    // MARK: pins.json

    @Test func aFloatingPinIsKeptInPinsJson() throws {
        let folder = root.appending(path: "bot")
        let store = BotStore(directory: folder)
        var pin = PinnedComponent(name: "build", command: "make status", data: "{}", refresh: .interval, seconds: 5)
        pin.float = PinnedComponent.Floating(corner: .bottomLeft, width: 320, height: 200, collapsed: true)
        store.save(pins: [pin, PinnedComponent(name: "天氣卡片", data: "{}")])
        let loaded = store.loadPins()
        #expect(loaded[0] == pin)
        #expect(loaded[0].float?.corner == .bottomLeft)
        #expect(loaded[0].float?.collapsed == true)
        #expect(loaded[1].float == nil)
        let saved = String(decoding: try JSONEncoder().encode(loaded[1]), as: UTF8.self)
        // One that does not float writes nothing about it.
        #expect(!saved.contains("float"))
    }

    @Test func oldPinsJsonStillLoadsAndOddFloatValuesFallBack() throws {
        let old = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","command":"ls","data":"1","refresh":"shown","size":"2x2","minutes":15}]"#
        let pins = try JSONDecoder().decode([PinnedComponent].self, from: Data(old.utf8))
        #expect(pins[0].float == nil)
        // A corner this build does not know, sizes past the limits: the rest still loads.
        let odd = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","float":{"corner":"middle","width":5000,"height":3,"collapsed":"yes"}}]"#
        let float = try #require(try JSONDecoder().decode([PinnedComponent].self, from: Data(odd.utf8))[0].float)
        #expect(float.corner == .topRight)
        #expect(float.width == PinnedComponent.Floating.widths.upperBound)
        #expect(float.height == PinnedComponent.Floating.heights.lowerBound)
        #expect(float.collapsed == false)
        // An empty one floats at the defaults.
        let empty = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","float":{}}]"#
        let fresh = try #require(try JSONDecoder().decode([PinnedComponent].self, from: Data(empty.utf8))[0].float)
        #expect(fresh == PinnedComponent.Floating())
        // No size of its own: the page fits it to its content.
        #expect(fresh.width == nil && fresh.height == nil && fresh.corner == .topRight && !fresh.resized)
    }

    @Test func aFloatAtTheOldDefaultSizeFitsItsContentNow() throws {
        // Every card used to float at 280×160 until resized: kept at exactly that, it was never resized.
        let old = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","float":{"corner":"bottomLeft","width":280,"height":160,"collapsed":true}}]"#
        let float = try #require(try JSONDecoder().decode([PinnedComponent].self, from: Data(old.utf8))[0].float)
        #expect(float == PinnedComponent.Floating(corner: .bottomLeft, collapsed: true))
        // One the user resized keeps its size, and an encoded one without a size writes none.
        let resized = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","float":{"width":420,"height":160}}]"#
        let kept = try #require(try JSONDecoder().decode([PinnedComponent].self, from: Data(resized.utf8))[0].float)
        #expect(kept.width == 420 && kept.height == 160 && kept.resized)
        let written = String(decoding: try JSONEncoder().encode(PinnedComponent.Floating()), as: UTF8.self)
        #expect(!written.contains("width") && !written.contains("height"))
    }

    // MARK: At most two

    func garden(_ workspace: Workspace, _ name: String = "garden") throws -> Bot {
        let folder = root.appending(path: "code/\(name)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try #require(workspace.bot(for: workspace.addProject(folder: folder, select: false)))
    }

    @Test func atMostTwoFloatInOneChat() throws {
        let workspace = makeWorkspace()
        for name in ["a", "b", "c", "d"] { try addComponent(name, command: "printf \(name)", to: workspace) }
        let main = workspace.mainBot
        let garden = try garden(workspace)
        let a = try #require(workspace.pin(named: "a", in: main))
        let b = try #require(workspace.pin(named: "b", in: garden))
        let c = try #require(workspace.pin(named: "c", in: main))
        let d = try #require(workspace.pin(named: "d", in: main))

        #expect(workspace.floatPin(a.id, true, in: main))
        #expect(workspace.floatPin(b.id, true, in: garden))
        // Another bot's float is not in this chat: a second one here still may.
        #expect(workspace.floatPin(c.id, true, in: main))
        // A third here does not.
        #expect(!workspace.floatPin(d.id, true, in: main))
        #expect(main.pins.first { $0.id == d.id }?.float == nil)
        #expect(workspace.floatingPins(in: main).map(\.pin.id) == [a.id, c.id])
        #expect(workspace.floatingPins(in: garden).map(\.pin.id) == [b.id])

        // Its menu says so: Float, Stop floating, or full.
        #expect(Pins.floatMenu(for: main.pins[0], floating: 2) == .stop)
        #expect(Pins.floatMenu(for: main.pins[2], floating: 2) == .full)
        #expect(Pins.floatMenu(for: main.pins[2], floating: 1) == .float)
        #expect(Pins.FloatMenu.full.label == "Float in corner (2 floating already)")
        #expect(Pins.FloatMenu.float.label == "Float in corner")
        #expect(Pins.FloatMenu.stop.label == "Stop floating")
        #expect(workspace.pinContext(for: main).floating == 2)
        #expect(workspace.pinContext(for: garden).floating == 1)

        #expect(workspace.floatPin(a.id, false, in: main))
        #expect(workspace.floatPin(d.id, true, in: main))
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins().first { $0.id == d.id }?.float == PinnedComponent.Floating())
    }

    @Test func whereItFloatsIsKept() throws {
        let workspace = makeWorkspace()
        try addComponent("a", command: "printf 1", to: workspace)
        let bot = workspace.mainBot
        let pin = try #require(workspace.pin(named: "a", in: bot))
        workspace.setPinFloat(pin.id, corner: .bottomRight, in: bot)
        // Not floating: nothing to keep.
        #expect(bot.pins[0].float == nil)
        workspace.floatPin(pin.id, true, in: bot)
        workspace.setPinFloat(pin.id, corner: .bottomLeft, width: 9999, height: 210, in: bot)
        workspace.setPinFloat(pin.id, collapsed: true, in: bot)
        let float = try #require(bot.pins[0].float)
        #expect(float.corner == .bottomLeft)
        #expect(float.width == PinnedComponent.Floating.widths.upperBound)
        #expect(float.height == 210)
        #expect(float.collapsed)
        // Unpinned, it stops floating too.
        workspace.unpin(pin.id, in: bot)
        #expect(workspace.floatingPins().isEmpty)
    }

    // MARK: The page

    @Test func aFloatingPinShowsOnlyInItsOwnBotsChat() throws {
        // As 1.12.0 had it, a pin floated in a project's chat showed over the main bot's too.
        let workspace = makeWorkspace()
        try addComponent("build", command: "printf '{\"title\":\"Building 40%\"}'", to: workspace)
        let main = workspace.mainBot
        let project = workspace.addProject(folder: try { let f = root.appending(path: "code/ClaudeCodeBot"); try FileManager.default.createDirectory(at: f, withIntermediateDirectories: true); return f }())
        let bot = try #require(workspace.bot(for: project))
        let pin = try #require(workspace.pin(named: "build", in: bot, refresh: .interval, seconds: 5))
        #expect(workspace.floatPin(pin.id, true, in: bot))
        // In its own chat: the card, whose bot it is, and where it floats.
        #expect(workspace.selectedBot === bot)
        let seen = try payload(workspace, bot: workspace.selectedBot)
        let floating = try #require(seen["floating"] as? [[String: Any]])
        #expect(floating.count == 1)
        #expect(floating[0]["botName"] as? String == bot.name)
        #expect(floating[0]["global"] == nil)
        let view = try #require(floating[0]["pin"] as? [String: Any])
        #expect(view["id"] as? String == pin.id.uuidString)
        #expect(view["seconds"] as? Int == 5)
        let float = try #require(view["float"] as? [String: Any])
        #expect(float["corner"] as? String == "topRight")
        #expect(float["width"] == nil && float["height"] == nil)
        #expect(float["collapsed"] as? Bool == false)
        let own = try #require(seen["pins"] as? [[String: Any]])
        #expect(own[0]["floatMenu"] as? String == "stop")

        // Switching to the main bot's chat: it is gone; and to Maintainer's, Codex's.
        workspace.select(nil)
        #expect(workspace.selectedBot === main)
        #expect((try payload(workspace, bot: workspace.selectedBot)["floating"] as? [[String: Any]])?.isEmpty == true)
        #expect(workspace.floatingPinViews(in: workspace.maintainer).isEmpty)
        #expect(workspace.floatingPinViews(in: workspace.codexBot).isEmpty)
        // Back in its own chat it shows again.
        workspace.select(project.id)
        #expect((try payload(workspace, bot: workspace.selectedBot)["floating"] as? [[String: Any]])?.count == 1)
        // Which bot holds a pin, so the card's ↻ and menu reach it.
        #expect(workspace.bot(holdingPin: pin.id) === bot)
        #expect(workspace.bot(holdingPin: UUID()) == nil)
    }

    // MARK: Shown in all bots

    @Test func aFloatingPinShownInAllBotsFloatsInEveryChatAndRunsInItsOwnFolder() throws {
        let workspace = makeWorkspace()
        try addComponent("release", command: "python3 .bot/artifacts/release-progress.py", to: workspace)
        let main = workspace.mainBot
        let code = try garden(workspace, "ClaudeCodeBot")
        let other = try garden(workspace, "garden")
        let pin = try #require(workspace.pin(named: "release", in: code, refresh: .interval, minutes: 5))
        // Only a floating pin can be.
        #expect(!workspace.setPinGlobal(pin.id, true, in: code))
        #expect(workspace.floatPin(pin.id, true, in: code))
        #expect(workspace.setPinGlobal(pin.id, true, in: code))
        #expect(workspace.isGlobalFloat(pin.id))

        for chat in [main, other, workspace.maintainer, workspace.codexBot, code] {
            let views = try #require(try payload(workspace, bot: chat)["floating"] as? [[String: Any]])
            #expect(views.count == 1)
            #expect(views[0]["global"] as? Bool == true)
            // Its owner's name for the header's mark, and its command in the owner's folder.
            #expect(views[0]["botName"] as? String == code.name)
            let display = try #require((views[0]["pin"] as? [String: Any])?["display"] as? [String: Any])
            #expect(display["command"] as? String == "python3 .bot/artifacts/release-progress.py")
            #expect(display["folder"] as? String == workspace.pinFolder(for: code).path)
        }
        // Where it sits is the pin's own, set from any chat.
        workspace.setPinFloat(pin.id, corner: .bottomLeft, width: 420, in: code)
        #expect(workspace.floatingPins(in: main)[0].pin.float?.corner == .bottomLeft)
        #expect(workspace.floatingPins(in: main)[0].pin.float?.width == 420)

        // "Only in ClaudeCodeBot": back to its own chat.
        #expect(workspace.setPinGlobal(pin.id, false, in: code))
        #expect(workspace.floatingPins(in: main).isEmpty)
        #expect(workspace.floatingPins(in: code).count == 1)
        #expect(workspace.settings.globalFloats == nil)
    }

    @Test func aGlobalFloatRefreshesOnceNotOncePerChat() async throws {
        let workspace = makeWorkspace()
        try addComponent("slow", command: "printf 1", to: workspace)
        try addComponent("live", command: "printf 2", to: workspace)
        let code = try garden(workspace, "ClaudeCodeBot")
        _ = try garden(workspace, "garden")
        let folder = workspace.pinFolder(for: code)
        workspace.componentCommands.approve("printf 1", in: folder)
        workspace.componentCommands.approve("printf 2", in: folder)
        let slow = try #require(workspace.pin(named: "slow", in: code, refresh: .interval, minutes: 5))
        let live = try #require(workspace.pin(named: "live", in: code, refresh: .interval, seconds: 5))
        for pin in [slow, live] {
            workspace.floatPin(pin.id, true, in: code)
            workspace.setPinGlobal(pin.id, true, in: code)
        }
        // Every minutes: the app's one timer, in its owner's folder, under its one card key.
        await workspace.refreshDuePins()
        #expect(workspace.componentCommands.runs[slow.card]?.data == "1")
        #expect(workspace.componentCommands.runs.keys.filter { $0.hasPrefix("pin/") }.sorted() == [slow.card])
        // Every few seconds: left to the one page, whichever chat is shown.
        #expect(workspace.selectedBot === workspace.mainBot)
        #expect(workspace.componentCommands.runs[live.card] == nil)
    }

    @Test func aPinFloatingOnlyInAnotherChatIsRefreshedByTheApp() async throws {
        // Not on the page (another chat is shown), its seconds refresh is the app's, as any pin's.
        let workspace = makeWorkspace()
        try addComponent("live", command: "printf 2", to: workspace)
        let code = try garden(workspace, "ClaudeCodeBot")
        workspace.componentCommands.approve("printf 2", in: workspace.pinFolder(for: code))
        let live = try #require(workspace.pin(named: "live", in: code, refresh: .interval, seconds: 5))
        workspace.floatPin(live.id, true, in: code)
        await workspace.refreshDuePins()
        #expect(workspace.componentCommands.runs[live.card]?.data == "2")
    }

    @Test func globalFloatsCountTowardEachChatsTwo() throws {
        let workspace = makeWorkspace()
        for name in ["a", "b", "c", "d"] { try addComponent(name, command: "printf \(name)", to: workspace) }
        let main = workspace.mainBot
        let code = try garden(workspace, "ClaudeCodeBot")
        let other = try garden(workspace, "garden")
        let g = try #require(workspace.pin(named: "a", in: code))
        let m1 = try #require(workspace.pin(named: "b", in: main))
        let m2 = try #require(workspace.pin(named: "c", in: main))
        let o1 = try #require(workspace.pin(named: "d", in: other))
        workspace.floatPin(g.id, true, in: code)
        workspace.floatPin(m1.id, true, in: main)
        workspace.floatPin(m2.id, true, in: main)
        // Main shows two already: no room there for one more.
        #expect(workspace.globalFloatBlocked(g.id, in: code) == main.name)
        #expect(!workspace.setPinGlobal(g.id, true, in: code))
        let blocked = try #require(try payload(workspace, bot: code)["floating"] as? [[String: Any]])
        #expect(blocked[0]["blocked"] as? String == main.name)
        workspace.floatPin(m2.id, false, in: main)
        #expect(workspace.globalFloatBlocked(g.id, in: code) == nil)
        #expect(workspace.setPinGlobal(g.id, true, in: code))
        // In every chat the one shown in all bots stacks first, then the chat's own.
        #expect(workspace.floatingPins(in: main).map(\.pin.id) == [g.id, m1.id])
        #expect(workspace.floatingPins(in: main).map(\.global) == [true, false])
        // It takes one of each chat's two: main is full now, garden has room for one of its own.
        #expect(!workspace.floatPin(m2.id, true, in: main))
        #expect(workspace.floatPin(o1.id, true, in: other))
        #expect(workspace.floatingPins(in: other).map(\.pin.id) == [g.id, o1.id])
        #expect(try payload(workspace, bot: main)["pins"].flatMap { $0 as? [[String: Any]] }?.first { $0["id"] as? String == m2.id.uuidString }?["floatMenu"] as? String == "full")
    }

    @Test func globalFloatsAreReferencesKeptInSettings() throws {
        let workspace = makeWorkspace()
        try addComponent("a", command: "printf 1", to: workspace)
        let code = try garden(workspace, "ClaudeCodeBot")
        let project = try #require(workspace.projects.first { workspace.bot(for: $0) === code })
        let pin = try #require(workspace.pin(named: "a", in: code))
        workspace.floatPin(pin.id, true, in: code)
        workspace.setPinGlobal(pin.id, true, in: code)
        // The chat's stable id (not the bot object's) and the pin's: no copy of the pin.
        #expect(workspace.settings.globalFloats == [GlobalFloat(botID: project.id, pinID: pin.id)])
        let text = try String(contentsOf: root.appending(path: "ccb/settings.json"), encoding: .utf8)
        #expect(text.contains(pin.id.uuidString) && !text.contains("printf 1"))

        // A restart: shown in all bots still, with the owner's latest pin.
        let reopened = makeWorkspace()
        #expect(reopened.isGlobalFloat(pin.id))
        let shown = reopened.floatingPins(in: reopened.mainBot)
        #expect(shown.map(\.pin.id) == [pin.id])
        #expect(shown[0].bot.name == code.name)
        // The owner's change shows everywhere: it is the same pin.
        let owner = try #require(reopened.bot(holdingPin: pin.id))
        reopened.setPinStatus(pin.id, text: "Shipping", tone: "good", in: owner)
        #expect(reopened.floatingPins(in: reopened.mainBot)[0].pin.status?.text == "Shipping")
        // The main bot's own pins keep the main bot's id.
        try addComponent("b", command: "printf 2", to: reopened)
        let mine = try #require(reopened.pin(named: "b", in: reopened.mainBot))
        reopened.floatPin(mine.id, true, in: reopened.mainBot)
        reopened.setPinGlobal(mine.id, true, in: reopened.mainBot)
        #expect(reopened.settings.globalFloats?.last == GlobalFloat(botID: Workspace.mainBotID, pinID: mine.id))
    }

    @Test func aGlobalFloatWhoseBotOrPinIsGoneIsDropped() throws {
        let workspace = makeWorkspace()
        try addComponent("a", command: "printf 1", to: workspace)
        try addComponent("b", command: "printf 2", to: workspace)
        let code = try garden(workspace, "ClaudeCodeBot")
        let a = try #require(workspace.pin(named: "a", in: code))
        let b = try #require(workspace.pin(named: "b", in: code))
        for pin in [a, b] {
            workspace.floatPin(pin.id, true, in: code)
            #expect(workspace.setPinGlobal(pin.id, true, in: code))
        }
        // Stopped floating: no longer in all bots, and not again when floated anew.
        workspace.floatPin(a.id, false, in: code)
        #expect(workspace.settings.globalFloats?.map(\.pinID) == [b.id])
        workspace.floatPin(a.id, true, in: code)
        #expect(!workspace.isGlobalFloat(a.id))
        #expect(workspace.floatingPins(in: workspace.mainBot).map(\.pin.id) == [b.id])
        // Unpinned in its bot: gone from every chat and from settings.
        workspace.unpin(b.id, in: code)
        #expect(workspace.floatingPins(in: workspace.mainBot).isEmpty)
        #expect(workspace.settings.globalFloats == nil)

        // Its bot removed.
        guard let diary = workspace.createBot(name: "Diary", job: "z"), let bot = workspace.bot(for: diary) else {
            Issue.record("not made")
            return
        }
        let c = try #require(workspace.pin(named: "a", in: bot))
        workspace.floatPin(c.id, true, in: bot)
        workspace.setPinGlobal(c.id, true, in: bot)
        #expect(workspace.floatingPins(in: workspace.mainBot).map(\.pin.id) == [c.id])
        workspace.removeBot(diary.id)
        #expect(workspace.floatingPins(in: workspace.mainBot).isEmpty)
        #expect(workspace.settings.globalFloats == nil)

        // A settings file naming a chat or pin that is not there: dropped when the app opens.
        var settings = workspace.settings
        settings.globalFloats = [GlobalFloat(botID: UUID(), pinID: UUID()), GlobalFloat(botID: Workspace.mainBotID, pinID: UUID())]
        try JSONEncoder().encode(settings).write(to: root.appending(path: "ccb/settings.json"))
        let reopened = makeWorkspace()
        #expect(reopened.globalFloats.isEmpty)
        #expect(reopened.settings.globalFloats == nil)
        let saved = try JSONDecoder().decode(AppSettings.self, from: Data(contentsOf: root.appending(path: "ccb/settings.json")))
        #expect(saved.globalFloats == nil)
    }

    @Test func oldSettingsWithoutGlobalFloatsStillLoad() throws {
        let old = #"{"developerMode":false,"pinnedBots":[]}"#
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data(old.utf8))
        #expect(settings.globalFloats == nil)
    }

    @Test func aFloatingPinRefreshedInSecondsIsLeftToThePage() async throws {
        // Its page reruns it only while the window is shown; the app's timer leaves it alone.
        let workspace = makeWorkspace()
        try addComponent("live", command: "printf 1", to: workspace)
        try addComponent("slow", command: "printf 2", to: workspace)
        let bot = workspace.mainBot
        let folder = workspace.pinFolder(for: bot)
        workspace.componentCommands.approve("printf 1", in: folder)
        workspace.componentCommands.approve("printf 2", in: folder)
        let live = try #require(workspace.pin(named: "live", in: bot, refresh: .interval, seconds: 5))
        let slow = try #require(workspace.pin(named: "slow", in: bot, refresh: .interval, minutes: 5))
        workspace.floatPin(live.id, true, in: bot)
        workspace.floatPin(slow.id, true, in: bot)
        await workspace.refreshDuePins()
        #expect(workspace.componentCommands.runs[live.card] == nil)
        #expect(workspace.componentCommands.runs[slow.card]?.data == "2")
        // Not floating, the timer runs it as before.
        workspace.floatPin(live.id, false, in: bot)
        await workspace.refreshDuePins()
        #expect(workspace.componentCommands.runs[live.card]?.data == "1")
    }
}
