import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A pin floated in a corner of the chat window: kept in pins.json, at most two at once (over
/// any bot's chat), its menu saying Float or Stop floating.
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
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot), pins: workspace.pinContext(for: bot), floating: workspace.floatingPinViews()) { _ in "" }.json()
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

    @Test func atMostTwoFloatAcrossBots() throws {
        let workspace = makeWorkspace()
        try addComponent("a", command: "printf 1", to: workspace)
        try addComponent("b", command: "printf 2", to: workspace)
        try addComponent("c", command: "printf 3", to: workspace)
        let main = workspace.mainBot
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let garden = try #require(workspace.bot(for: workspace.addProject(folder: folder)))
        let a = try #require(workspace.pin(named: "a", in: main))
        let b = try #require(workspace.pin(named: "b", in: garden))
        let c = try #require(workspace.pin(named: "c", in: main))

        #expect(workspace.floatPin(a.id, true, in: main))
        #expect(workspace.floatPin(b.id, true, in: garden))
        // A third does not: two already float (one in another bot's chat).
        #expect(!workspace.floatPin(c.id, true, in: main))
        #expect(main.pins.first { $0.id == c.id }?.float == nil)
        #expect(workspace.floatingPins().map(\.pin.id) == [a.id, b.id])

        // Its menu says so: Float, Stop floating, or full.
        #expect(Pins.floatMenu(for: main.pins[0], floating: 2) == .stop)
        #expect(Pins.floatMenu(for: main.pins[1], floating: 2) == .full)
        #expect(Pins.floatMenu(for: main.pins[1], floating: 1) == .float)
        #expect(Pins.FloatMenu.full.label == "Float in corner (2 floating already)")
        #expect(Pins.FloatMenu.float.label == "Float in corner")
        #expect(Pins.FloatMenu.stop.label == "Stop floating")

        #expect(workspace.floatPin(a.id, false, in: main))
        #expect(workspace.floatPin(c.id, true, in: main))
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins().first { $0.id == c.id }?.float == PinnedComponent.Floating())
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

    @Test func theFloatingPinsShowOverEveryBotsChat() throws {
        let workspace = makeWorkspace()
        try addComponent("build", command: "printf '{\"title\":\"Building 40%\"}'", to: workspace)
        let main = workspace.mainBot
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let garden = try #require(workspace.bot(for: workspace.addProject(folder: folder)))
        let pin = try #require(workspace.pin(named: "build", in: main, refresh: .interval, seconds: 5))
        workspace.floatPin(pin.id, true, in: main)
        // Seen from another bot's chat: the card, whose bot it is, and where it floats.
        let seen = try payload(workspace, bot: garden)
        let floating = try #require(seen["floating"] as? [[String: Any]])
        #expect(floating.count == 1)
        #expect(floating[0]["botID"] as? String == main.id.uuidString)
        #expect(floating[0]["botName"] as? String == main.name)
        let view = try #require(floating[0]["pin"] as? [String: Any])
        #expect(view["id"] as? String == pin.id.uuidString)
        #expect(view["seconds"] as? Int == 5)
        #expect((view["display"] as? [String: Any])?["command"] as? String == "printf '{\"title\":\"Building 40%\"}'")
        let float = try #require(view["float"] as? [String: Any])
        #expect(float["corner"] as? String == "topRight")
        // Not resized: no size, so the page fits it to its content.
        #expect(float["width"] == nil && float["height"] == nil)
        #expect(float["collapsed"] as? Bool == false)
        // The pin's own menu entry, in its bot's chat.
        let own = try #require(try payload(workspace, bot: main)["pins"] as? [[String: Any]])
        #expect(own[0]["floatMenu"] as? String == "stop")
        // Which bot holds a pin, so the card's ↻ and menu reach it from any chat.
        #expect(workspace.bot(holdingPin: pin.id) === main)
        #expect(workspace.bot(holdingPin: UUID()) == nil)
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
