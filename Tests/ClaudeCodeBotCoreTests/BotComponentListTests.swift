import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Every component is on Maintainer's shelf (the shared library); each bot has its own list of at
/// most 20. A bot's briefing has the whole usage of its own components and one line for the rest.
@MainActor
struct BotComponentListTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-list-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, about: String? = nil, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<p>\(name)</p>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try (about ?? "\(name) card.\nData: {\"\(name)\":true}").write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func garden(in workspace: Workspace) throws -> (Workspace.Project, Bot) {
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        return (project, try #require(workspace.bot(for: project)))
    }

    // MARK: Where the list lives

    @Test func theListIsKeptInBotJSONBesideTheBotsOtherSettings() throws {
        let store = BotStore(directory: root.appending(path: "store"))
        #expect(store.loadComponentList() == nil)
        store.save(model: .opus)
        store.save(componentList: ["choices", "weather"])
        #expect(store.loadComponentList() == ["choices", "weather"])
        #expect(store.loadModel() == .opus)
        let json = try String(contentsOf: root.appending(path: "store/bot.json"), encoding: .utf8)
        #expect(json.contains("\"components\""))

        let bot = Bot(profile: .main(home: root.appending(path: "home")), launcher: FakeLauncher().launcher, store: store)
        #expect(bot.componentList == ["choices", "weather"])
        bot.setComponentList(["choices"])
        #expect(store.loadComponentList() == ["choices"])
    }

    @Test func aNewBotStartsWithTheBuiltIns() throws {
        let workspace = makeWorkspace()
        try addComponent("weather", to: workspace)
        let (_, bot) = try garden(in: workspace)
        #expect(Set(bot.componentList ?? []) == ["choices", PagePreview.component])
        #expect(Set(workspace.mainBot.componentList ?? []) == ["choices", PagePreview.component])
        #expect(workspace.components.names.contains("weather"))
    }

    /// Bots from before 1.9 had no list: on the first start each gets what it actually used
    /// (component-usage.json by bot, and the components drawn in its chat) plus the built-ins.
    @Test func existingBotsKeepWhatTheyUsedPlusTheBuiltIns() async throws {
        let first = makeWorkspace()
        for name in ["weather", "pie", "commits"] { try addComponent(name, to: first) }
        let (project, _) = try garden(in: first)
        await first.putEveryoneToSleep()

        // As 1.8 left things: no lists, uses counted by bot name, a chat that drew a card.
        let ccb = root.appending(path: "ccb")
        for folder in [ccb.appending(path: "main"), ccb.appending(path: "projects/\(project.id.uuidString)")] {
            let url = folder.appending(path: "bot.json")
            var settings = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            settings["components"] = nil
            try JSONSerialization.data(withJSONObject: settings).write(to: url)
        }
        try #"{"since":"2026-10-20T00:00:00Z","components":{"pie":{"count":2,"lastUsed":"2026-10-20T01:00:00Z","byBot":{"Main bot":2}},"gone":{"count":1,"lastUsed":"2026-10-20T01:00:00Z","byBot":{"Main bot":1}}}}"#
            .write(to: ccb.appending(path: "component-usage.json"), atomically: true, encoding: .utf8)
        BotStore(directory: ccb.appending(path: "projects/\(project.id.uuidString)"))
            .save(messages: [ChatMessage(role: .bot, text: "Today: <show name=\"weather\">{\"city\":\"Taipei\"}</show>")])

        let second = makeWorkspace()
        #expect(Set(second.mainBot.componentList ?? []) == ["choices", PagePreview.component, "pie"])
        let gardenBot = try #require(second.bot(for: project))
        #expect(Set(gardenBot.componentList ?? []) == ["choices", PagePreview.component, "weather"])
        // Nobody had commits: it stays on the shelf, one line in their briefing.
        #expect(second.componentBriefing(for: gardenBot).contains("- commits: commits card."))
        #expect(!second.componentBriefing(for: gardenBot).contains(#"{"commits":true}"#))

        // Done once: a list set later is kept on the next start.
        gardenBot.setComponentList(["choices"])
        await second.putEveryoneToSleep()
        let third = makeWorkspace()
        #expect(third.bot(for: project)?.componentList == ["choices"])
    }

    // MARK: The briefing

    @Test func theBriefingHasWholeUsageOnlyForTheBotsOwnComponents() throws {
        let workspace = makeWorkspace()
        try addComponent("weather", about: "Weather card: today's forecast.\nData: {\"city\":\"Taipei\"}", to: workspace)
        let main = workspace.mainBot
        let briefing = workspace.componentBriefing(for: main)
        #expect(briefing.contains("2 / 20 yours"))
        #expect(briefing.contains("- choices: Choices"))
        #expect(briefing.contains(#"  Data: {"options""#))
        #expect(briefing.contains("- weather: Weather card: today's forecast."))
        #expect(!briefing.contains(#"{"city":"Taipei"}"#))
        #expect(briefing.contains("shared library"))
        #expect(briefing.contains("ask Maintainer"))
        // The default is the main bot's.
        #expect(workspace.componentBriefing() == briefing)

        #expect(workspace.giveComponent("weather", to: main))
        let after = workspace.componentBriefing(for: main)
        #expect(after.contains("3 / 20 yours"))
        #expect(after.contains(#"  Data: {"city":"Taipei"}"#))
    }

    // MARK: Asking Maintainer

    @Test func aBotsRequestSaysWhichBotAskedAndAnExistingOneIsJustAdded() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            // A note queued before a message (its components changed) comes ahead of it.
            if text.hasSuffix("Show the weather") { return "I need a card.\n<component name=\"weather\">a weather card</component>" }
            if text.hasSuffix("Show a toast") { return "Needs a new one.\n<component name=\"toast\">an error toast</component>" }
            if isAppOnly(text) { return "OK" }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        try addComponent("weather", to: workspace)
        let (_, bot) = try garden(in: workspace)

        // In the library already: on the bot's list at once, nothing rebuilt.
        bot.send("Show the weather")
        await eventually { bot.componentList?.contains("weather") == true }
        let relay = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(relay.text.hasPrefix("garden's request for the component \"weather\": a weather card"))
        #expect(relay.text.contains("already in the library"))
        #expect(relay.text.contains("added it to garden's list"))

        // Not there: Maintainer checks the shelf first, else builds it; the app adds it once it lands.
        bot.send("Show a toast")
        await eventually { workspace.maintainer.messages.last { $0.role == .relay }?.text.contains("toast") == true }
        let ask = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(ask.text.hasPrefix("garden wants a new component \"toast\": an error toast"))
        #expect(ask.text.contains("garden has 3 / 20"))
        #expect(ask.text.contains("Check the library first"))
        #expect(ask.text.contains(#"<give-component bot="garden">"#))
        #expect(bot.componentList?.contains("toast") == false)
        try addComponent("toast", to: workspace)
        #expect(bot.componentList?.contains("toast") == true)
        #expect(!workspace.mainBot.componentList!.contains("toast"))
        await workspace.putEveryoneToSleep()
    }

    @Test func maintainerGivesAndTakesWithTags() throws {
        let parsed = ReplyParser.parseAll("Found one.\n<give-component bot=\"garden\">weather</give-component>\n<take-component bot=\"garden\">pie</take-component>")
        #expect(parsed.body == "Found one.")
        #expect(parsed.requests == [.giveComponent(bot: "garden", name: "weather"), .takeComponent(bot: "garden", name: "pie")])

        let workspace = makeWorkspace()
        try addComponent("weather", to: workspace)
        try addComponent("pie", to: workspace)
        let (project, bot) = try garden(in: workspace)

        // Only Maintainer gives or takes.
        workspace.handle([.giveComponent(bot: "garden", name: "weather")], from: project)
        #expect(bot.componentList?.contains("weather") == false)

        workspace.handle([.giveComponent(bot: "Garden", name: "weather"), .giveComponent(bot: "garden", name: "pie")], from: workspace.maintainerProject)
        #expect(bot.componentList?.contains("weather") == true)
        #expect(bot.componentList?.contains("pie") == true)
        workspace.handle([.takeComponent(bot: "garden", name: "pie")], from: workspace.maintainerProject)
        #expect(bot.componentList?.contains("pie") == false)
        // The library copy stays.
        #expect(workspace.components.names.contains("pie"))
        // The main bot can be named as such.
        workspace.handle([.giveComponent(bot: "Main bot", name: "pie")], from: workspace.maintainerProject)
        #expect(workspace.mainBot.componentList?.contains("pie") == true)
    }

    /// The 20 is per bot: a full bot gets nothing new until the user picks one to drop from its
    /// list; the library itself has no cap.
    @Test func twentyIsPerBotAndTheLibraryHasNoCap() async throws {
        let workspace = makeWorkspace()
        await workspace.pluginLibraryReady.value
        for index in 0..<25 { try addComponent("extra-\(index)", to: workspace) }
        #expect(workspace.components.names.count == 27)
        let (_, bot) = try garden(in: workspace)
        bot.setComponentList(["choices", PagePreview.component] + (0..<18).map { "extra-\($0)" })
        #expect(workspace.componentBriefing(for: bot).contains("20 / 20 yours"))
        #expect(!workspace.giveComponent("extra-20", to: bot))
        #expect(bot.componentList?.count == 20)

        workspace.requestComponentChange("toast", request: "an error toast", from: "garden", for: bot)
        let full = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(full.text.contains("garden already has 20 / 20"))
        #expect(full.text.contains("which one to remove from garden's list"))
        // The library still takes the new one; it just is not added to the full bot.
        try addComponent("toast", to: workspace)
        #expect(workspace.components.names.contains("toast"))
        #expect(bot.componentList?.contains("toast") == false)

        // Maintainer's give is refused, and Maintainer hears why.
        workspace.handle([.giveComponent(bot: "garden", name: "extra-21")], from: workspace.maintainerProject)
        #expect(bot.componentList?.contains("extra-21") == false)

        let rules = workspace.maintainerInstructions()
        #expect(rules.contains("at most 20 per bot"))
        #expect(rules.contains("Check the library first"))
        #expect(rules.contains("<give-component bot="))
        #expect(rules.contains("<take-component bot="))
        #expect(rules.contains("remove from that bot's list"))
        #expect(rules.contains("the library copy stays"))
        #expect(rules.contains("組件使用統計"))
        await workspace.putEveryoneToSleep()
    }

    // MARK: Drawing and removing

    /// A `<show>` of a library component that is not on the bot's list still draws, and the bot
    /// gets it (while it has room).
    @Test func showingALibraryComponentDrawsItAndAddsItToTheList() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("Weather?") ? "Here: <show name=\"weather\">{\"city\":\"Taipei\"}</show>" : "Got it"
        }
        let workspace = makeWorkspace(fake)
        try addComponent("weather", to: workspace)
        let (_, bot) = try garden(in: workspace)
        #expect(bot.componentList?.contains("weather") == false)
        bot.send("Weather?")
        await eventually { bot.messages.last?.shown.first?.name == "weather" }
        #expect(bot.componentList?.contains("weather") == true)
        let payload = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }
        #expect(payload.components["weather"] != nil)
        await workspace.putEveryoneToSleep()
    }

    /// The usage card's delete button ("刪除組件：name") takes it off that bot's list only.
    @Test func theUsageCardsDeleteTakesItOffThatBotsListOnly() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if isAppOnly(text) { return "OK" }
            return text.hasSuffix("Usage?") ? "<show name=\"組件使用統計\"></show>" : "Got it"
        }
        let workspace = makeWorkspace(fake)
        try addComponent("組件使用統計", to: workspace)
        try addComponent("weather", to: workspace)
        let (_, bot) = try garden(in: workspace)
        #expect(workspace.giveComponent("weather", to: bot))
        #expect(workspace.giveComponent("weather", to: workspace.mainBot))
        bot.send("Usage?")
        await eventually { bot.messages.last?.shown.first?.name == "組件使用統計" }
        let card = try #require(bot.messages.last)
        let lines = bot.messages.count

        #expect(workspace.answer("刪除組件：weather", in: card.id, of: bot))
        #expect(bot.componentList?.contains("weather") == false)
        #expect(workspace.mainBot.componentList?.contains("weather") == true)
        #expect(workspace.components.names.contains("weather"))
        // Said in the chat, not sent to the bot as a message to act on.
        #expect(bot.messages.count == lines + 1)
        #expect(bot.messages.last?.role == .notice)
        #expect(bot.messages.last?.text.contains("weather") == true)
        #expect(!bot.messages.contains { $0.role == .user && $0.text.contains("刪除組件") })
        await workspace.putEveryoneToSleep()
    }

    // MARK: Hearing back

    /// The user's case: the main bot asked for a component the library already had. The app put
    /// it on its list, but the bot was never told, so it never showed the chart. Now it hears at
    /// once, with the user's original request, answers it with <show>, and the chat says so.
    @Test func aBotHearsBackWhenTheComponentItAskedForIsAddedAndShowsIt() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("Maintainer added the component \"daily-chats-pie\"") {
                return "今天的統計：<show name=\"daily-chats-pie\">[]</show>"
            }
            if isAppOnly(text) { return "OK" }
            if text.hasSuffix("今天對話次數統計") {
                return "圖還不在我的清單裡，已請 Maintainer 加入。\n<component name=\"daily-chats-pie\">add it to my list</component>"
            }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        try addComponent("daily-chats-pie", about: "今日對話次數（圓餅圖）：各 bot 今天的訊息數。\nData: []", to: workspace)
        let main = workspace.mainBot

        main.send("今天對話次數統計")
        await eventually { main.messages.last?.shown.first?.name == "daily-chats-pie" }
        #expect(main.componentList?.contains("daily-chats-pie") == true)
        // What it was told names the component, the user's request, and its usage.
        let told = try #require(fake.agents.flatMap(\.sent).first { $0.contains("Maintainer added the component") })
        #expect(told.contains("今天對話次數統計"))
        #expect(told.contains("<show name=\"daily-chats-pie\">"))
        #expect(told.contains("各 bot 今天的訊息數"))
        // The user sees a short line about it.
        let notice = try #require(main.messages.last { $0.role == .notice })
        #expect(notice.text.contains("Maintainer added"))
        #expect(notice.text.contains("今日對話次數"))
        #expect(notice.text.contains("your components"))
        await workspace.putEveryoneToSleep()
    }

    /// A new component Maintainer built, or one it handed over in its place with <give-component>:
    /// either way the bot that asked hears it, with what the user wanted, and shows it.
    @Test func aBotHearsBackWhenMaintainerBuildsOrGivesOne() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("Maintainer added the component \"toast\"") { return "<show name=\"toast\">{}</show>" }
            if text.contains("Maintainer added the component \"weather\"") { return "<show name=\"weather\">{}</show>" }
            // A note queued before a message (its components changed) comes ahead of it.
            if text.hasSuffix("Warn me on errors") { return "<component name=\"toast\">an error toast</component>" }
            if text.hasSuffix("Forecast please") { return "<component name=\"forecast\">a forecast card</component>" }
            if isAppOnly(text) { return "OK" }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        try addComponent("weather", to: workspace)
        let (_, bot) = try garden(in: workspace)

        bot.send("Warn me on errors")
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text.contains("toast") } }
        try addComponent("toast", to: workspace)
        await eventually { bot.messages.last?.shown.first?.name == "toast" }
        let built = try #require(fake.agents.flatMap(\.sent).first { $0.contains("Maintainer added the component \"toast\"") })
        #expect(built.contains("Warn me on errors"))
        #expect(bot.messages.contains { $0.role == .notice && $0.text.contains("Maintainer added toast") })

        bot.send("Forecast please")
        await eventually { workspace.maintainer.messages.contains { $0.role == .relay && $0.text.contains("forecast") } }
        workspace.handle([.giveComponent(bot: "garden", name: "weather")], from: workspace.maintainerProject)
        await eventually { bot.messages.last?.shown.first?.name == "weather" }
        let given = try #require(fake.agents.flatMap(\.sent).first { $0.contains("Maintainer added the component \"weather\"") })
        #expect(given.contains("Forecast please"))
        #expect(given.contains("\"forecast\""))
        await workspace.putEveryoneToSleep()
    }

    /// Maintainer will not (or could not) do it: the bot hears Maintainer's answer and tells the
    /// user, instead of waiting for a component that never comes.
    @Test func aBotHearsWhenMaintainerDeclines() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("Maintainer did not add") { return "抱歉，Maintainer 不做 toast。" }
            if text.hasSuffix("Warn me on errors") { return "<component name=\"toast\">an error toast</component>" }
            if isAppOnly(text) { return "OK" }
            if text.contains("wants a new component \"toast\"") { return "I won't build toast: the app's own notices already do this." }
            return "Got it"
        }
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        let (_, bot) = try garden(in: workspace)

        bot.send("Warn me on errors")
        await eventually { bot.messages.last?.text == "抱歉，Maintainer 不做 toast。" }
        let told = try #require(fake.agents.flatMap(\.sent).first { $0.contains("Maintainer did not add") })
        #expect(told.contains("Warn me on errors"))
        #expect(told.contains("the app's own notices already do this"))
        #expect(told.contains("Tell the user"))
        #expect(bot.messages.contains { $0.role == .notice && $0.text.contains("toast") && $0.text.contains("Maintainer") })
        #expect(bot.componentList?.contains("toast") == false)
        await workspace.putEveryoneToSleep()
    }

    // MARK: The / menu

    @Test func theSlashMenuOffersTheBotsOwnComponentsFirst() throws {
        let workspace = makeWorkspace()
        try addComponent("weather", to: workspace)
        try addComponent("alpha", to: workspace)
        let (_, bot) = try garden(in: workspace)
        #expect(workspace.giveComponent("weather", to: bot))
        let payload = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }
        #expect(payload.slashComponents == ["choices", "weather", PagePreview.component])
        #expect(payload.slashLibrary == ["alpha"])
        let json = try #require(String(data: JSONEncoder().encode(payload), encoding: .utf8))
        #expect(json.contains("\"slashLibrary\""))
    }
}
