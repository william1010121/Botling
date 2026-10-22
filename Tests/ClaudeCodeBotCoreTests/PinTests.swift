import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Components pinned to a bot: its chips and Board, refreshed by their command.
@MainActor
struct PinTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-pins-\(UUID().uuidString)")

    func makeWorkspace() -> Workspace {
        let fake = FakeLauncher()
        return Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    /// A component in the library, with a Command in its about.md when given.
    func addComponent(_ name: String, command: String? = nil, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "\(name).\n\(command.map { "Command: `\($0)`" } ?? "")".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func payload(_ workspace: Workspace, board: Bool = false) throws -> [String: Any] {
        let bot = workspace.mainBot
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot), pins: workspace.pinContext(for: bot, board: board)) { _ in "" }.json()
        return try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    // MARK: The list

    @Test func pinsAreKeptPerBotBesideItsChat() throws {
        let folder = root.appending(path: "bot")
        let store = BotStore(directory: folder)
        let pin = PinnedComponent(name: "提交紀錄", command: "git log -5", data: "[]", refresh: .interval, minutes: 10, size: .extraLarge)
        store.save(pins: [pin, PinnedComponent(name: "天氣卡片", data: #"{"city":"台北"}"#)])
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "pins.json").path))
        let loaded = store.loadPins()
        #expect(loaded.count == 2)
        #expect(loaded[0] == pin)
        // Without a command it can only keep its data.
        #expect(loaded[1].refresh == .manual)
        let bot = Bot(profile: .main(home: folder), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.pins.map(\.name) == ["提交紀錄", "天氣卡片"])
    }

    @Test func aFileFromANewerBuildStillLoads() throws {
        let json = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","command":"ls","data":"1","refresh":"hourly","size":"xl","minutes":0}]"#
        let pins = try JSONDecoder().decode([PinnedComponent].self, from: Data(json.utf8))
        #expect(pins[0].refresh == .shown)
        #expect(pins[0].size == .large)
        #expect(pins[0].minutes == PinnedComponent.minimumMinutes)
    }

    @Test func oldSizesBecomeWidgetCells() throws {
        let line = { (size: String) in #"{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","size":"\#(size)"}"# }
        let pins = try JSONDecoder().decode([PinnedComponent].self, from: Data("[\(["s", "m", "l", "2x1", "1x2"].map(line).joined(separator: ","))]".utf8))
        #expect(pins.map(\.size) == [.small, .large, .extraLarge, .wide, .tall])
        // Saved as the new spelling.
        let saved = String(decoding: try JSONEncoder().encode(pins[0]), as: UTF8.self)
        #expect(saved.contains(#""size":"1x1""#))
        #expect(pins.map { [$0.size.columns, $0.size.rows] } == [[1, 1], [2, 2], [4, 2], [2, 1], [1, 2]])
        #expect(pins.map(\.size.name) == ["small", "large", "xlarge", "wide", "tall"])
    }

    @Test func aCardTakesAnySizeUpToFourByFour() throws {
        // Any columns × rows from 1×1 to 4×4, as dragged; the five old ones are among them.
        #expect(PinnedComponent.Size.all.count == 16)
        #expect(PinnedComponent.Size.all.first == .small && PinnedComponent.Size.all.last?.rawValue == "4x4")
        #expect(PinnedComponent.Size(spelled: "3x4") == PinnedComponent.Size(columns: 3, rows: 4))
        #expect(PinnedComponent.Size(spelled: "4 × 3")?.rawValue == "4x3")
        #expect(PinnedComponent.Size(spelled: "5x1") == nil && PinnedComponent.Size(spelled: "0x2") == nil && PinnedComponent.Size(spelled: "x2") == nil)
        #expect(PinnedComponent.Size(columns: 9, rows: 0).rawValue == "4x1")
        // Its name is the nearest of the five, for templates written for them.
        let names = ["1x1", "2x1", "1x2", "2x2", "4x2", "3x1", "4x1", "1x4", "2x4", "3x3", "4x4", "4x3"].compactMap(PinnedComponent.Size.init(spelled:)).map(\.name)
        #expect(names == ["small", "wide", "tall", "large", "xlarge", "wide", "xlarge", "tall", "large", "large", "xlarge", "xlarge"])
    }

    @Test func aBoardCardsPlaceIsKeptInPinsJsonAndShown() throws {
        // A pins.json from before free placement has no places: they load as nil (the page lays
        // them out as the packed Board did and sends that back), and nothing else changes.
        let old = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","size":"2x2"},{"id":"9E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"y","data":"1","size":"1x1","place":{"col":"bad"}}]"#
        let decoded = try JSONDecoder().decode([PinnedComponent].self, from: Data(old.utf8))
        #expect(decoded.map(\.place) == [nil, nil])
        #expect(decoded[0].size == .large)

        let workspace = makeWorkspace()
        try addComponent("log", command: "echo {}", to: workspace)
        try addComponent("weather", command: "echo []", to: workspace)
        let bot = workspace.mainBot
        let log = try #require(workspace.pin(named: "log", in: bot))
        let weather = try #require(workspace.pin(named: "weather", in: bot))
        #expect(bot.pins.map(\.place) == [nil, nil])
        var shown = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect(shown.first?["place"] == nil)

        // Dropped at column 3, row 2 (gaps kept), the other pushed down and resized; ids not
        // pinned are ignored, the chips' order is unchanged.
        workspace.arrangePins([(log.id, .init(col: 3, row: 2), nil), (weather.id, .init(col: 0, row: 4), .wide), (UUID(), .init(col: 1, row: 1), nil)], in: bot)
        #expect(bot.pins.map(\.name) == ["log", "weather"])
        #expect(bot.pins.map(\.place) == [.init(col: 3, row: 2), .init(col: 0, row: 4)])
        #expect(bot.pins[1].size == .wide && bot.pins[0].size == .large)
        // Never before the first cell.
        #expect(PinnedComponent.Place(col: -2, row: -1) == .init(col: 0, row: 0))

        // Saved and loaded again; the page is told.
        let saved = try String(contentsOf: root.appending(path: "ccb/main/pins.json"), encoding: .utf8)
        #expect(saved.contains(#""place":{"col":3,"row":2}"#) || saved.contains(#""place":{"row":2,"col":3}"#))
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins().map(\.place) == bot.pins.map(\.place))
        shown = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect((shown.first?["place"] as? [String: Int]) == ["col": 3, "row": 2])
    }

    @Test func aResizedPinIsKeptInPinsJson() throws {
        let folder = root.appending(path: "bot")
        let store = BotStore(directory: folder)
        let pin = PinnedComponent(name: "gpu-status", command: "nvidia-smi", data: "{}", size: PinnedComponent.Size(columns: 4, rows: 3), panelHeight: 420)
        store.save(pins: [pin])
        let saved = try String(contentsOf: folder.appending(path: "pins.json"), encoding: .utf8)
        #expect(saved.contains(#""size":"4x3""#))
        #expect(saved.contains(#""panelHeight":420"#))
        #expect(store.loadPins() == [pin])
        // A height past the panel's limits is kept within them; a file without one has none.
        #expect(PinnedComponent(name: "x", data: "1", panelHeight: 10).panelHeight == PinnedComponent.panelHeights.lowerBound)
        let old = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1","size":"3x4","panelHeight":99999}]"#
        let decoded = try JSONDecoder().decode([PinnedComponent].self, from: Data(old.utf8))
        #expect(decoded[0].size.rawValue == "3x4")
        #expect(decoded[0].panelHeight == PinnedComponent.panelHeights.upperBound)

        // Resized and its panel dragged: the page hears both.
        let workspace = makeWorkspace()
        try addComponent("gpu-status", command: "echo {}", to: workspace)
        let pinned = try #require(workspace.pin(named: "gpu-status", in: workspace.mainBot))
        workspace.resizePin(pinned.id, to: PinnedComponent.Size(columns: 4, rows: 4), in: workspace.mainBot)
        workspace.setPinPanelHeight(pinned.id, to: 380, in: workspace.mainBot)
        var shown = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect(shown.first?["size"] as? String == "4x4")
        #expect(shown.first?["panelHeight"] as? Int == 380)
        workspace.setPinPanelHeight(pinned.id, to: nil, in: workspace.mainBot)
        shown = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect(shown.first?["panelHeight"] == nil)
    }

    @Test func aboutMdSaysWhichSizesAComponentHas() throws {
        #expect(ComponentLibrary.sizes(inAbout: "Commits.\nSizes: 1x1, 2x1, 2x2") == [.small, .wide, .large])
        #expect(ComponentLibrary.sizes(inAbout: "- Sizes: `1×2`, wide, 4x2, 9x9, 2x1") == [.tall, .wide, .extraLarge])
        // Any WxH up to 4x4 is a hint too.
        #expect(ComponentLibrary.sizes(inAbout: "Sizes: 3x2, 4x4").map(\.rawValue) == ["3x2", "4x4"])
        // None given, or none it knows: 2×2 alone. The old S/M/L are not about.md's.
        #expect(ComponentLibrary.sizes(inAbout: "Commits.\nCommand: git log") == [.large])
        #expect(ComponentLibrary.sizes(inAbout: "Sizes: s, m") == [.large])
        #expect(PinnedComponent.Size.preferred(among: [.small, .wide]) == .small)
        #expect(PinnedComponent.Size.preferred(among: [.small, .large]) == .large)

        // A pin starts at the size the component prefers, and the page hears its sizes.
        let workspace = makeWorkspace()
        try addComponent("weather", to: workspace)
        let about = workspace.components.folder.appending(path: "weather/about.md")
        try "Weather.\nCommand: echo 1\nSizes: 1x1, 2x1".write(to: about, atomically: true, encoding: .utf8)
        let pin = try #require(workspace.pin(named: "weather", in: workspace.mainBot))
        #expect(pin.size == .small)
        let components = try #require(try payload(workspace)["components"] as? [String: [String: Any]])
        #expect(components["weather"]?["sizes"] as? [String] == ["1x1", "2x1"])
        let shown = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect(shown.first?["size"] as? String == "1x1")
    }

    @Test func addingTheSamePinTwiceKeepsOne() {
        var pins: [PinnedComponent] = []
        #expect(Pins.add(PinnedComponent(name: "a", command: "ls", data: "1"), to: &pins))
        #expect(!Pins.add(PinnedComponent(name: "a", command: "ls", data: "2"), to: &pins))
        #expect(Pins.add(PinnedComponent(name: "a", command: "pwd", data: "2"), to: &pins))
        #expect(pins.count == 2)
    }

    @Test func pinsMove() {
        let a = PinnedComponent(name: "a", data: "1"), b = PinnedComponent(name: "b", data: "1"), c = PinnedComponent(name: "c", data: "1")
        var pins = [a, b, c]
        Pins.move(c.id, to: 0, in: &pins)
        #expect(pins.map(\.name) == ["c", "a", "b"])
        Pins.move(c.id, to: 99, in: &pins)
        #expect(pins.map(\.name) == ["a", "b", "c"])
        // The Board's drop between a and b: its index once out of the list and put back.
        Pins.move(c.id, to: 1, in: &pins)
        #expect(pins.map(\.name) == ["a", "c", "b"])
    }

    @Test func onlyIntervalPinsWithACommandFallDue() {
        let now = Date()
        let every = PinnedComponent(name: "a", command: "ls", data: "1", refresh: .interval, minutes: 15)
        #expect(every.isDue(at: now, lastRan: nil))
        #expect(!every.isDue(at: now, lastRan: now.addingTimeInterval(-14 * 60)))
        #expect(every.isDue(at: now, lastRan: now.addingTimeInterval(-15 * 60)))
        #expect(!PinnedComponent(name: "a", command: "ls", data: "1", refresh: .manual).isDue(at: now, lastRan: nil))
        #expect(!PinnedComponent(name: "a", command: "ls", data: "1", refresh: .shown).isDue(at: now, lastRan: nil))
        #expect(!PinnedComponent(name: "a", data: "1", refresh: .interval).isDue(at: now, lastRan: nil))
    }

    // MARK: Headlines

    @Test func chipsSayOneLine() {
        // The commit timeline: the newest commit, and how many.
        #expect(Pins.headline(#"[{"hash":"f472a1c","subject":"Merge bot/sidebar-a","date":"2026-10-20"},{"hash":"fd0ac9b"}]"#) == "f472a1c · Merge bot/sidebar-a · 2")
        #expect(Pins.headline(#"{"commits":[{"hash":"abc","subject":"Fix"}]}"#) == "abc · Fix")
        #expect(Pins.headline(#"{"city":"台北","condition":"多雲","tempHigh":26}"#) == "台北 · 多雲")
        #expect(Pins.headline(#"{"title":"Usage","rows":[1,2]}"#) == "Usage")
        #expect(Pins.headline(#""  \n 2 files changed\nmore""#) == "2 files changed")
        #expect(Pins.headline("[]") == "Nothing yet")
        #expect(Pins.headline("42") == "42")
        #expect(Pins.headline("null") == "")
        #expect(Pins.headline(String(repeating: "x", count: 100), limit: 10) == "xxxxxxxxx…")
    }

    // MARK: Chip icon and status

    @Test func aboutMdGivesAChipIcon() throws {
        #expect(ComponentLibrary.icon(inAbout: "Commits.\nIcon: chart.pie.fill") == "chart.pie.fill")
        #expect(ComponentLibrary.icon(inAbout: "- Icon: `📊`") == "📊")
        #expect(ComponentLibrary.icon(inAbout: "Icon: 👩‍💻") == "👩‍💻")
        // Not a symbol name nor one or two glyphs: none, and the chip uses its generic icon.
        #expect(ComponentLibrary.icon(inAbout: "Icon: a pie chart please") == nil)
        #expect(ComponentLibrary.icon(inAbout: "Icon: <svg>") == nil)
        #expect(ComponentLibrary.icon(inAbout: "Commits.\nCommand: git log") == nil)
        #expect(ComponentIcon.isSymbolName("chart.pie.fill"))
        #expect(!ComponentIcon.isSymbolName("📊"))

        // The page hears it, and an SF Symbol drawn as a picture the web view can show.
        let workspace = makeWorkspace()
        try addComponent("pie", to: workspace)
        try "圓餅圖：Pie.\nIcon: chart.pie.fill".write(to: workspace.components.folder.appending(path: "pie/about.md"), atomically: true, encoding: .utf8)
        try addComponent("weather", to: workspace)
        try "Weather.\nIcon: ⛅️".write(to: workspace.components.folder.appending(path: "weather/about.md"), atomically: true, encoding: .utf8)
        try addComponent("plain", to: workspace)
        let components = try #require(try payload(workspace)["components"] as? [String: [String: Any]])
        #expect(components["pie"]?["icon"] as? String == "chart.pie.fill")
        #expect((components["pie"]?["iconImage"] as? String)?.hasPrefix("data:image/png;base64,") == true)
        #expect(components["weather"]?["icon"] as? String == "⛅️")
        #expect(components["weather"]?["iconImage"] == nil)
        #expect(components["plain"]?["icon"] == nil)
        // Its short name from about.md's first line, for an opened or floating pin's header.
        #expect(components["pie"]?["title"] as? String == "圓餅圖")
        #expect(components["weather"]?["title"] == nil)
        // A name that is no SF Symbol draws nothing.
        #expect(ComponentIcon.symbolImage("no.such.symbol.anywhere") == nil)
    }

    @Test func aComponentSetsItsChipsStatus() throws {
        let workspace = makeWorkspace()
        try addComponent("weather", to: workspace)
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "")
        message.displays = [ComponentInstance(name: "weather", data: #"{"city":"台北","condition":"多雲 with a long tail"}"#)]
        bot.post(message, unread: false)
        let pin = try #require(workspace.pin(messageID: message.id, index: 0, in: bot))
        func chip() throws -> [String: Any] {
            let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
            return try #require(pins.first?["chip"] as? [String: Any])
        }
        // Not set: the summary line, cut short, in a neutral tone; the whole line stays for the tooltip.
        #expect(try chip()["text"] as? String == "台北 · 多雲 with…")
        #expect(try chip()["tone"] as? String == "neutral")
        let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
        #expect(pins.first?["headline"] as? String == "台北 · 多雲 with a long tail")

        // ccb.setStatus({text, tone}) from the pinned component.
        workspace.setPinStatus(pin.id, text: "26°", tone: "ok", in: bot)
        #expect(bot.pins[0].status == PinStatus(text: "26°", tone: .good))
        #expect(try chip()["text"] as? String == "26°")
        #expect(try chip()["tone"] as? String == "good")
        // Kept with the pin, for after a restart.
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins()[0].status == PinStatus(text: "26°", tone: .good))

        // Long text is cut, an unknown tone is neutral, a dot alone (no text) is fine.
        workspace.setPinStatus(pin.id, text: "  far too long a status line\nsecond", tone: "purple", in: bot)
        #expect(bot.pins[0].status == PinStatus(text: "far too long…", tone: .neutral))
        workspace.setPinStatus(pin.id, text: "", tone: "error", in: bot)
        #expect(try chip()["text"] as? String == "")
        #expect(try chip()["tone"] as? String == "bad")
        #expect(PinStatus.Tone(spelled: "warn") == .warning)
        #expect(PinStatus.Tone(spelled: "Success") == .good)

        // Cleared (ccb.setStatus(null)): back to the summary.
        workspace.setPinStatus(pin.id, text: nil, tone: nil, in: bot)
        #expect(bot.pins[0].status == nil)
        #expect(try chip()["text"] as? String == "台北 · 多雲 with…")

        // Older pins.json files without a status still load.
        let json = #"[{"id":"8E1B5D2C-3C55-4C6E-9C0B-6D7B0B8E4A11","name":"x","data":"1"}]"#
        #expect(try JSONDecoder().decode([PinnedComponent].self, from: Data(json.utf8))[0].status == nil)
    }

    @Test(.wallClock) func aPinnedCommandsStateShowsOnItsChip() async throws {
        let workspace = makeWorkspace()
        try addComponent("stats", command: "exit 3", to: workspace)
        let bot = workspace.mainBot
        let pin = try #require(workspace.pin(named: "stats", in: bot))
        func chip() throws -> [String: Any] {
            let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
            return try #require(pins.first?["chip"] as? [String: Any])
        }
        #expect(try chip()["text"] as? String == "Allow?")
        #expect(try chip()["tone"] as? String == "warning")
        workspace.setPinStatus(pin.id, text: "3", tone: "good", in: bot)
        await workspace.runPin(pin.id, in: bot, command: "exit 3", folder: workspace.pinFolder(for: bot).path, approve: true)
        // A failed run shows over what the component last said.
        #expect(try chip()["text"] as? String == "Failed")
        #expect(try chip()["tone"] as? String == "bad")
    }

    // MARK: Pinning

    @Test(.integration) func pinningFromAChatCardKeepsWhatItShows() async throws {
        let workspace = makeWorkspace()
        try addComponent("log", command: #"printf '[{"hash":"a1"}]'"#, to: workspace)
        try addComponent("weather", to: workspace)
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "Here:")
        message.displays = [ComponentInstance(name: "log", data: "null"), ComponentInstance(name: "weather", data: #"{"city":"台北"}"#), ComponentInstance(name: "gone", data: "1")]
        bot.post(message, unread: false)
        let folder = workspace.commandFolder(for: message, in: bot)
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: #"printf '[{"hash":"a1"}]'"#, folder: folder.path, approve: true)

        let id = UUID()
        let pinned = try #require(workspace.pin(messageID: message.id, index: 0, in: bot, id: id, refresh: .interval, minutes: 5))
        #expect(pinned.id == id)
        #expect(pinned.command == #"printf '[{"hash":"a1"}]'"#)
        #expect(pinned.data == #"[{"hash":"a1"}]"#)
        #expect(pinned.ranAt != nil)
        #expect(pinned.refresh == .interval && pinned.minutes == 5)
        // Again: already pinned.
        #expect(workspace.pin(messageID: message.id, index: 0, in: bot) == nil)
        // No command: kept as drawn.
        let snapshot = try #require(workspace.pin(messageID: message.id, index: 1, in: bot, refresh: .interval))
        #expect(snapshot.command == nil && snapshot.data == #"{"city":"台北"}"# && snapshot.refresh == .manual)
        // Not in the library.
        #expect(workspace.pin(messageID: message.id, index: 2, in: bot) == nil)
        #expect(bot.pins.map(\.name) == ["log", "weather"])
        // Saved beside the chat.
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins().map(\.id) == bot.pins.map(\.id))

        workspace.movePin(snapshot.id, to: 0, in: bot)
        workspace.resizePin(snapshot.id, to: .wide, in: bot)
        #expect(bot.pins.map(\.name) == ["weather", "log"])
        #expect(bot.pins[0].size == .wide)
        // A pin without a command has nothing to refresh.
        workspace.setPinRefresh(snapshot.id, to: .interval, in: bot)
        #expect(bot.pins[0].refresh == .manual)
        workspace.setPinRefresh(id, to: .shown, minutes: 30, in: bot)
        #expect(bot.pins[1].refresh == .shown && bot.pins[1].minutes == 30)
        // Undo.
        workspace.unpin(id, in: bot)
        #expect(bot.pins.map(\.name) == ["weather"])
    }

    @Test func thePickerOffersWhatThisBotDrewAndComponentsWithACommand() throws {
        let workspace = makeWorkspace()
        try addComponent("log", command: "git log", to: workspace)
        try addComponent("weather", to: workspace)
        try addComponent("stats", command: "printf 1", to: workspace)
        try addComponent("unused", to: workspace)
        let bot = workspace.mainBot
        var first = ChatMessage(role: .bot, text: "")
        first.displays = [ComponentInstance(name: "weather", data: "{}"), ComponentInstance(name: "log", data: "null")]
        var second = ChatMessage(role: .bot, text: "")
        second.displays = [ComponentInstance(name: "weather", data: #"{"city":"台北"}"#)]
        bot.post(first, unread: false)
        bot.post(second, unread: false)
        // Offered when not drawn yet: its own components that have a Command.
        bot.setComponentList(["weather", "log", "stats", "unused"])
        let choices = try #require(try payload(workspace)["pinChoices"] as? [[String: Any]])
        #expect(choices.map { $0["name"] as? String } == ["weather", "log", "stats"])
        #expect(choices.map { $0["uses"] as? Int } == [2, 1, 0])
        #expect(choices[0]["command"] == nil)
        #expect(choices[1]["command"] as? String == "git log")

        // The newest drawing is what is pinned.
        let weather = try #require(workspace.pin(named: "weather", in: bot))
        #expect(weather.data == #"{"city":"台北"}"#)
        // Never drawn here, but it has a Command: no data until it runs.
        let stats = try #require(workspace.pin(named: "stats", in: bot))
        #expect(stats.command == "printf 1" && stats.data == "null")
        #expect(workspace.pin(named: "unused", in: bot) == nil)
        let after = try #require(try payload(workspace)["pinChoices"] as? [[String: Any]])
        #expect(after.filter { $0["pinned"] as? Bool == true }.map { $0["name"] as? String } == ["weather", "stats"])

        // A bot with its own list is offered its own components only.
        try addComponent("mine", command: "printf 4", to: workspace)
        bot.setComponentList(["weather", "log", "mine"])
        let own = try #require(try payload(workspace)["pinChoices"] as? [[String: Any]])
        #expect(own.map { $0["name"] as? String } == ["weather", "log", "mine"])
    }

    @Test func chatCardsSayWhetherTheyArePinned() throws {
        let workspace = makeWorkspace()
        try addComponent("weather", to: workspace)
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "")
        message.displays = [ComponentInstance(name: "weather", data: "{}"), ComponentInstance(name: "elsewhere", data: "{}")]
        bot.post(message, unread: false)
        func displays() throws -> [[String: Any]] {
            let messages = try #require(try payload(workspace)["messages"] as? [[String: Any]])
            return try #require(messages.last?["displays"] as? [[String: Any]])
        }
        #expect(try displays()[0]["pinned"] as? Bool == false)
        #expect(try displays()[1]["pinned"] == nil)
        workspace.pin(messageID: message.id, index: 0, in: bot)
        #expect(try displays()[0]["pinned"] as? Bool == true)
        // Without a pin context (a subagent, a snapshot) nothing is pinnable.
        let plain = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }.json()
        #expect(!plain.contains("\"pinned\""))
        #expect(!plain.contains("\"pins\""))
    }

    // MARK: Running

    @Test(.integration) func aPinnedCommandRunsOnlyOnceAllowed() async throws {
        let workspace = makeWorkspace()
        let command = #"printf '{"title":"Fresh"}'"#
        try addComponent("stats", command: command, to: workspace)
        let bot = workspace.mainBot
        let pin = try #require(workspace.pin(named: "stats", in: bot, refresh: .interval, minutes: 1))
        func shown() throws -> [String: Any] {
            let pins = try #require(try payload(workspace)["pins"] as? [[String: Any]])
            return try #require(pins.first)
        }
        var view = try shown()
        #expect(view["headline"] as? String == "Needs your OK")
        #expect((view["display"] as? [String: Any])?["status"] as? String == "approve")

        // Not allowed: neither the timer, nor showing it, nor ↻ runs it.
        await workspace.refreshDuePins()
        await workspace.pinsShown(in: bot)
        await workspace.runPin(pin.id, in: bot, force: true)
        // Allowing needs the command and folder the card showed.
        await workspace.runPin(pin.id, in: bot, approve: true)
        await workspace.runPin(pin.id, in: bot, command: "printf 2", folder: workspace.pinFolder(for: bot).path, approve: true)
        await workspace.runPin(pin.id, in: bot, command: command, folder: "/elsewhere", approve: true)
        #expect(workspace.componentCommands.runs[pin.card] == nil)
        #expect(!workspace.componentCommands.isApproved(command, in: workspace.pinFolder(for: bot)))

        await workspace.runPin(pin.id, in: bot, command: command, folder: workspace.pinFolder(for: bot).path, approve: true)
        view = try shown()
        #expect(view["headline"] as? String == "Fresh")
        #expect((view["display"] as? [String: Any])?["status"] as? String == "done")
        // The output is kept on the pin, for after a restart.
        #expect(bot.pins[0].data == #"{"title":"Fresh"}"#)
        #expect(bot.pins[0].ranAt != nil)
        #expect(BotStore(directory: root.appending(path: "ccb/main")).loadPins()[0].data == #"{"title":"Fresh"}"#)
    }

    @Test(.integration) func theTimerRunsDuePinsThatAreAllowed() async throws {
        let workspace = makeWorkspace()
        try addComponent("a", command: "printf 1", to: workspace)
        try addComponent("b", command: "printf 2", to: workspace)
        try addComponent("c", command: "printf 3", to: workspace)
        let bot = workspace.mainBot
        let folder = workspace.pinFolder(for: bot)
        let due = try #require(workspace.pin(named: "a", in: bot, refresh: .interval, minutes: 5))
        let manual = try #require(workspace.pin(named: "b", in: bot, refresh: .manual))
        let unallowed = try #require(workspace.pin(named: "c", in: bot, refresh: .interval, minutes: 5))
        workspace.componentCommands.approve("printf 1", in: folder)
        workspace.componentCommands.approve("printf 2", in: folder)

        // Their chips are on screen (RefreshVisibilityTests: only pins seen refresh).
        await workspace.pinsVisible([due.id, manual.id, unallowed.id], in: bot)
        #expect(workspace.componentCommands.runs[due.card]?.data == "1")
        #expect(workspace.componentCommands.runs[manual.card] == nil)
        #expect(workspace.componentCommands.runs[unallowed.card] == nil)
        let ran = try #require(workspace.componentCommands.runs[due.card]?.ranAt)
        // Not again until its minutes are up.
        await workspace.refreshDuePins(now: ran.addingTimeInterval(4 * 60))
        #expect(workspace.componentCommands.runs[due.card]?.ranAt == ran)
        await workspace.refreshDuePins(now: ran.addingTimeInterval(5 * 60))
        #expect(try #require(workspace.componentCommands.runs[due.card]?.ranAt) > ran)
    }

    @Test(.integration) func pinsRefreshedWhenShownRunWhenShown() async throws {
        let workspace = makeWorkspace()
        try addComponent("a", command: "printf 1", to: workspace)
        try addComponent("b", command: "printf 2", to: workspace)
        let bot = workspace.mainBot
        let folder = workspace.pinFolder(for: bot)
        let shown = try #require(workspace.pin(named: "a", in: bot, refresh: .shown))
        let manual = try #require(workspace.pin(named: "b", in: bot, refresh: .manual))
        workspace.componentCommands.approve("printf 1", in: folder)
        workspace.componentCommands.approve("printf 2", in: folder)
        await workspace.pinsShown([shown.id, manual.id], in: bot)
        #expect(workspace.componentCommands.runs[shown.card]?.data == "1")
        #expect(workspace.componentCommands.runs[manual.card] == nil)
        let ran = try #require(workspace.componentCommands.runs[shown.card]?.ranAt)
        // Shown again right away: it just ran.
        await workspace.pinsShown(in: bot, now: ran.addingTimeInterval(5))
        #expect(workspace.componentCommands.runs[shown.card]?.ranAt == ran)

        // Its output kept: a manual pin shows it after a restart instead of running again.
        await workspace.runPin(manual.id, in: bot, force: true)
        let later = makeWorkspace()
        let pins = try #require(try payload(later)["pins"] as? [[String: Any]])
        #expect((pins[1]["display"] as? [String: Any])?["status"] as? String == "done")
        #expect((pins[1]["display"] as? [String: Any])?["data"] as? String == "2")
        // One refreshed when shown asks for a run when drawn.
        #expect((pins[0]["display"] as? [String: Any])?["status"] as? String == "idle")
    }

    @Test func theBoardIsSaidInThePayload() throws {
        let workspace = makeWorkspace()
        #expect(try payload(workspace, board: true)["board"] as? Bool == true)
        #expect(try payload(workspace)["board"] as? Bool == false)
    }
}
