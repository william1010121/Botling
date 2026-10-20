import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// "Make into component": a reply becomes a spec (a quiet chip in the chat; a workspace in the
/// right panel once pressed), shaped with Maintainer, test-run through the usual command allow
/// flow, then built (or reused from the library) and added to the chosen bots.
@MainActor
struct ComponentSpecTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-spec-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, about: String? = nil, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<p>\(name)</p>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try (about ?? "\(name) card.").write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func garden(in workspace: Workspace) throws -> Bot {
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try #require(workspace.bot(for: workspace.addProject(folder: folder)))
    }

    /// A test run's reply: the summary in words, the command it ran folded above.
    func testReply(in bot: Bot) -> ChatMessage {
        var message = ChatMessage(role: .bot, text: "測試全部跑完了：382 個測試，0 個失敗，共 41.2 秒。")
        message.steps = [
            Step(id: "1", kind: .tool, tool: "Read", title: "Read Package.swift", detail: "/p/Package.swift", done: true),
            Step(id: "2", kind: .tool, tool: "Bash", title: "Run swift test", detail: "swift test --parallel", output: "382 passed", done: true),
        ]
        bot.post(message, unread: false)
        return message
    }

    /// A spec still in draft, as the panel shapes it (a bot's suggestion, or one from before the
    /// first version was built right away).
    @discardableResult
    func draftSpec(from reply: ChatMessage, in bot: Bot, in workspace: Workspace) -> ComponentSpec {
        let spec = ComponentSpecs.draft(from: reply, bot: bot.name, folder: bot.profile.workingDirectory, library: workspace.components)
        bot.editSpecs { $0.append(spec) }
        return spec
    }

    func relays(_ workspace: Workspace) -> [ChatMessage] {
        workspace.maintainer.messages.filter { $0.role == .relay }
    }

    // MARK: Drafting from a reply

    @Test func dataFieldsComeFromTheJSONWithTheirTypes() {
        let fields = ComponentSpecs.fields(fromJSON: #"{"total":382,"seconds":41.2,"ok":true,"ranAt":"2026-10-20T22:14:00Z","name":"x","suites":[{"name":"A","passed":3}],"meta":{"a":1}}"#)
        #expect(fields.map(\.name) == ["total", "seconds", "ok", "ranAt", "name", "suites", "meta"])
        #expect(fields.map(\.type) == ["int", "num", "bool", "time", "text", "[name, passed]", "{…}"])
        #expect(ComponentSpecs.fields(fromJSON: #"[{"hash":"a","subject":"b"}]"#).map(\.name) == ["hash", "subject"])
        #expect(ComponentSpecs.fields(fromJSON: "not json").isEmpty)
    }

    @Test func aReplyGivesADraftTheAppCanInfer() throws {
        let workspace = makeWorkspace()
        try addComponent("build-status", about: "Whether the last swift build passed.", to: workspace)
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = ComponentSpecs.draft(from: reply, bot: bot.name, folder: bot.profile.workingDirectory, library: workspace.components)
        #expect(spec.messageID == reply.id)
        // The command it ran names it, but the reply's own words are the data: no command.
        #expect(spec.command == nil)
        #expect(spec.name == "swift-test")
        #expect(spec.folder == bot.profile.workingDirectory.path)
        #expect(spec.bots == [bot.name])
        #expect(spec.samples.first?.label == "This reply")
        #expect(spec.existing == nil)
        #expect(spec.status == .draft)
        // A component in the library about the same thing is offered for reuse.
        #expect(spec.similar == "build-status")
        #expect(!spec.reuse)
    }

    @Test func aReplyShowingDataDraftsItsFieldsAndSample() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        var reply = ChatMessage(role: .bot, text: "Here:")
        reply.displays = [ComponentInstance(name: "test-card", data: #"{"total":3,"failed":0}"#, command: "swift test | summary")]
        bot.post(reply, unread: false)
        let spec = ComponentSpecs.draft(from: reply, bot: bot.name, folder: bot.profile.workingDirectory, library: workspace.components)
        #expect(spec.fields.map(\.name) == ["total", "failed"])
        #expect(spec.samples.first?.data == #"{"total":3,"failed":0}"#)
        #expect(spec.command == "swift test | summary")
        #expect(spec.name == "test-card")
    }

    @Test func aReplyThatAlreadyIsAComponentOnlyNeedsBots() throws {
        let workspace = makeWorkspace()
        try addComponent("git-log", to: workspace)
        let bot = workspace.mainBot
        var reply = ChatMessage(role: .bot, text: "提交紀錄")
        reply.displays = [ComponentInstance(name: "git-log", data: "[]")]
        bot.post(reply, unread: false)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(spec.existing == "git-log")
        #expect(spec.name == "git-log")
        // Nothing to build: the panel opens to pick the bots, and Maintainer is not asked.
        #expect(spec.status == .draft)
        #expect(workspace.openSpecID == spec.id)
        #expect(!workspace.maintainer.messages.contains { $0.role == .relay })
        // The chat says so on its button.
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, specs: true) { _ in "" }.json()
        #expect(json.contains(#""component":"git-log""#))
        #expect(json.contains(#""makeComponents":true"#))
    }

    // MARK: The first version, built right away

    @Test func makingOneBuildsTheFirstVersionRightAway() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(bot.specs.map(\.id) == [spec.id])
        #expect(spec.status == .building)
        // The panel does not open by itself.
        #expect(workspace.openSpecID == nil)
        #expect(!spec.opened)
        // Kept beside the chat.
        let saved = BotStore(directory: root.appending(path: "ccb/main")).loadSpecs()
        #expect(saved.map(\.id) == [spec.id])
        // Maintainer infers the spec and builds it now, asking nothing.
        let relay = try #require(relays(workspace).last)
        #expect(relay.text.hasPrefix("(Component spec \(spec.id.uuidString)) Build the first version"))
        #expect(relay.text.contains("swift test --parallel"))
        #expect(relay.text.contains("ask nothing"))
        #expect(relay.text.contains("best guess"))
        #expect(relay.text.contains("reuse"))
        #expect(relay.text.contains("<component-spec id=\"\(spec.id.uuidString)\">"))
        #expect(relay.text.contains("Never run the command yourself"))
        #expect(workspace.components.working["swift-test"] != nil)
        // Nothing has run.
        #expect(workspace.componentCommands.runs.isEmpty)

        // Pressed again: the same spec, nothing sent again, still not opened.
        let again = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(again.id == spec.id)
        #expect(bot.specs.count == 1)
        #expect(relays(workspace).count == 1)
        #expect(workspace.openSpecID == nil)

        // The chip under the reply says it is being built.
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, specs: true, openSpec: workspace.openSpecID) { _ in "" }.json()
        #expect(json.contains(#""specs":[{"id":"\#(spec.id.uuidString)","name":"swift-test","open":false,"status":"building","suggested":false}]"#))
    }

    @Test func theFirstVersionTakesMaintainersBestGuessesAndLandsUnderTheReply() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        // Maintainer names it, fills it in; a question it should not have asked takes its suggestion.
        let json = #"""
        {"name":"test-summary","about":"Pass and fail counts","fields":[{"name":"total","type":"int"},{"name":"failed","type":"int"}],
         "command":"swift test --parallel","refresh":"manual",
         "samples":[{"label":"This reply","data":"{\"total\":382,\"failed\":0}"}],
         "questions":[{"id":"q1","key":"refresh","text":"How often?","options":[{"label":"Only on ↻","value":"manual"},{"label":"Every show","value":"shown"}],"suggested":1}]}
        """#
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: json)], from: workspace.maintainerProject)
        var built = try #require(bot.specs.first)
        #expect(built.name == "test-summary")
        #expect(built.fields.map(\.name) == ["total", "failed"])
        #expect(built.questions.isEmpty)
        #expect(built.refresh == .shown)
        #expect(built.status == .building)

        // It lands in the library under its new name: on the bot's list, shown under the reply.
        try addComponent("test-summary", to: workspace)
        built = try #require(bot.specs.first)
        #expect(built.status == .done)
        #expect(built.built == "test-summary")
        #expect(workspace.ownComponents(of: bot).contains("test-summary"))
        #expect(bot.messages.last?.text.contains("test-summary added to") == true)
        #expect(workspace.openSpecID == nil)
        let commands = ChatPayload.CommandContext(runs: workspace.componentCommands) { _ in bot.profile.workingDirectory }
        let chat = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: commands, specs: true) { _ in "" }.json()
        #expect(chat.contains(#""component":"test-summary""#))
        // Its command is not allowed yet: the card asks, with the exact command and folder.
        #expect(chat.contains(#""command":"swift test --parallel""#))
        #expect(chat.contains(#""status":"approve""#))
        #expect(workspace.componentCommands.runs.isEmpty)
    }

    /// Maintainer hands the build to a background agent and its turn goes on (reviewing,
    /// committing) after the component lands: the preview under the reply stops spinning as
    /// soon as it is in the library, under the name it was built as and the one it started with.
    @Test func aBuiltComponentStopsSpinningOnceItLands() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"name":"test-summary"}"#)], from: workspace.maintainerProject)
        #expect(workspace.components.working["test-summary"] != nil)
        // Lands while Maintainer's turn is still under way (no reply from it yet).
        try addComponent("test-summary", to: workspace)
        #expect(bot.specs.first?.status == .done)
        #expect(workspace.components.working["test-summary"] == nil)
        #expect(workspace.components.working["swift-test"] == nil)
        let chat = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, specs: true) { _ in "" }.json()
        #expect(!chat.contains(#""working":true"#))
    }

    /// A reply that summed up every release in Chinese (a table, and a result page with each
    /// version's bullets), written after the bot read CHANGELOG.md with a shell command.
    func releaseSummaryReply(in bot: Bot) throws -> (message: ChatMessage, page: URL) {
        let artifacts = root.appending(path: "code/proj/.bot/artifacts")
        try FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
        let page = artifacts.appending(path: "release-history.html")
        try """
        <!doctype html><html><head><style>body { color: red; }</style><script>var secret = 1;</script></head>
        <body><h1>版本紀錄</h1><h2>1.9.0</h2><ul><li>看板變成格子 &amp; 組件可釘選</li><li>過程收成一行</li></ul>
        <h2>1.0.0</h2><ul><li>第一版：和 claude 對話的 Mac app</li></ul></body></html>
        """.write(to: page, atomically: true, encoding: .utf8)
        let rows = (0..<60).map { "| 1.\($0).0 | 第 \($0) 版的重點整理 |" }.joined(separator: "\n")
        var message = ChatMessage(role: .bot, text: "每一版的中文整理：\n\n| 版本 | 重點 |\n|---|---|\n\(rows)\n\n最後一行：完整內容在 [版本紀錄頁](file://\(page.path))。")
        message.steps = [Step(id: "1", kind: .tool, tool: "Bash", title: "Read the changelog", detail: "head -c 200000 CHANGELOG.md", output: "# Changelog", done: true)]
        bot.post(message, unread: false)
        return (message, page)
    }

    @Test func maintainerGetsTheWholeReplyAndItsResultPageAsTheData() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let (reply, page) = try releaseSummaryReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        // The shell command the bot ran to read its sources is not the component's data source.
        #expect(spec.command == nil)
        let relay = try #require(relays(workspace).last).text
        // The whole reply (not only its first 1500 characters) and the page it links, as text.
        #expect(relay.contains("最後一行：完整內容在"))
        #expect(relay.contains(page.path))
        #expect(relay.contains("看板變成格子 & 組件可釘選"))
        #expect(relay.contains("第一版：和 claude 對話的 Mac app"))
        #expect(!relay.contains("var secret"))
        #expect(!relay.contains("<li>"))
        // The reply's own content is the data; a command only when live data is clearly wanted.
        #expect(!relay.contains("\"This reply\" sample"))
        #expect(relay.contains("the reply's own content"))
        #expect(relay.contains("only when"))
        #expect(relay.contains("head -c 200000 CHANGELOG.md"))
    }

    @Test func theComponentUnderTheReplyDrawsTheReplysOwnData() async throws {
        let data = #"{"versions":[{"version":"1.9.0","body":"- 看板變成格子"},{"version":"1.0.0","body":"- 第一版"}]}"#
        let workspace = makeWorkspace(fillingLauncher("版本紀錄", data: data))
        let bot = workspace.mainBot
        let (reply, _) = try releaseSummaryReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        let update: [String: Any] = ["name": "版本紀錄", "fields": [["name": "versions", "type": "[version, body]"]]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: update), as: UTF8.self)
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: json)], from: workspace.maintainerProject)
        // Its about.md also says how to fill it from a command (for other bots' <show>).
        try addComponent("版本紀錄", about: "版本紀錄：每一版做了什麼。\nCommand: head -c 200000 CHANGELOG.md", to: workspace)
        let done = try #require(bot.specs.first)
        #expect(done.status == .done)
        #expect(done.command == nil)
        await eventually { bot.specs.first?.filled != nil }
        let commands = ChatPayload.CommandContext(runs: workspace.componentCommands) { _ in bot.profile.workingDirectory }
        let chip = try #require(ChatPayload.specChips(for: reply, in: bot, open: nil, library: workspace.components, commands: commands)?.first)
        // Under the reply: what the bot drew from its reply, not an Allow and run for the CHANGELOG.
        #expect(chip.display?.data == data)
        #expect(chip.display?.command == nil)
        #expect(chip.display?.status == nil)
        // Even after a test run of a command was kept, the reply's data stays what it shows.
        bot.editSpecs { specs in specs[0].samples.append(.init(label: "Test run", data: "\"# Changelog\"")) }
        let again = try #require(ChatPayload.specChips(for: reply, in: bot, open: nil, library: workspace.components, commands: commands)?.first)
        #expect(again.display?.data == data)
    }

    /// A reply listing 12 features to pick from.
    static let features = [
        "一個主 bot 管所有專案", "只在需要你決定時才打擾你", "bot 會睡覺、不浪費 token", "背景 subagent 團隊",
        "聊天裡的組件、釘選和 Board", "從回覆一鍵做成組件", "Codex code review", "Claude Design 設計稿",
        "Routines 每日排程", "插件系統＋developer mode", "全部在本機", "用量一目了然",
    ]

    func featureListReply(in bot: Bot) -> ChatMessage {
        let items = Self.features.enumerated().map { "\($0.offset + 1). **\($0.element)**：第 \($0.offset + 1) 項的說明。" }
        let message = ChatMessage(role: .bot, text: "我先列出可以宣傳的功能，你直接回數字就好：\n\n\(items.joined(separator: "\n"))\n\n也可以補一句你自己最想講的賣點。")
        bot.post(message, unread: false)
        return message
    }

    /// The multi-select data a bot draws from the feature list: every feature.
    nonisolated static var fullFeatureData: String {
        let data: [String: Any] = ["question": "想宣傳哪些功能？", "options": features.map { ["title": $0] }]
        return String(decoding: try! JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]), as: UTF8.self)
    }

    static let fillMarker = "(App: Draw the component"

    /// A launcher whose bots answer the app's fill request with a whole <show> of the component.
    func fillingLauncher(_ name: String = "multi-select", data: String = Self.fullFeatureData) -> FakeLauncher {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains(Self.fillMarker) { return "<show name=\"\(name)\">\(data)</show>" }
            if text.contains("hold this turn") { return nil }
            return isAppOnly(text) ? "OK" : "Got it"
        }
        return fake
    }

    @Test func theFirstVersionStartsWithWhatTheComponentIsFor() throws {
        let workspace = makeWorkspace()
        let bot = try garden(in: workspace)
        let reply = featureListReply(in: bot)
        let purpose = "let the user tick several of the features this reply lists"
        workspace.handle([.suggestComponent(name: "multi-select", draft: purpose)], from: workspace.projects.first { $0.name == "garden" })
        let spec = try #require(bot.specs.first)
        #expect(spec.messageID == reply.id)
        #expect(spec.purpose == purpose)
        workspace.pressSpec(spec.id, in: bot)
        let ask = try #require(relays(workspace).last).text
        // What it is for comes first, in the bot's own words; then the reply, as context.
        #expect(ask.hasPrefix("(Component spec \(spec.id.uuidString)) Build the first version now. What it is for, in garden's words: \(purpose)"))
        let said = try #require(ask.range(of: purpose)).lowerBound
        let context = try #require(ask.range(of: "The reply:")).lowerBound
        #expect(said < context)
        for feature in Self.features { #expect(ask.contains(feature)) }
        // Maintainer builds only the component: no data sample, no counting of items.
        #expect(!ask.contains("\"This reply\" sample"))
        #expect(!ask.contains("lists 12 items"))
        #expect(ask.contains("send no samples"))
        #expect(ask.contains("about.md"))
        #expect(ask.contains("asks garden"))
    }

    @Test func whatTheUserTypedIsThePurposeAndNothingTypedSaysSo() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = featureListReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, purpose: "勾選要宣傳的功能", in: bot))
        #expect(try #require(relays(workspace).last).text.hasPrefix("(Component spec \(spec.id.uuidString)) Build the first version now. What it is for, in the user's words: 勾選要宣傳的功能"))
        let other = testReply(in: bot)
        let plain = try #require(workspace.makeComponent(from: other.id, in: bot))
        #expect(try #require(relays(workspace).last).text.hasPrefix("(Component spec \(plain.id.uuidString)) Build the first version now. What it is for: \(bot.name)'s reply below"))
    }

    @Test func onceBuiltTheBotThatWroteTheReplyFillsItInFull() async throws {
        let fake = fillingLauncher()
        let workspace = makeWorkspace(fake)
        let bot = try garden(in: workspace)
        let reply = featureListReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, purpose: "勾選要宣傳的功能", in: bot))
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"name":"multi-select","fields":[{"name":"options","type":"[title]"}]}"#)], from: workspace.maintainerProject)
        try addComponent("multi-select", about: "Pick several options.\nData: {\"question\": text, \"options\": [{\"title\": text}]}", to: workspace)
        // Built and added; now garden, which wrote the reply, is asked to draw it.
        let added = try #require(bot.specs.first)
        #expect(added.status == .done)
        #expect(added.filledBy == "garden")
        let filling = try #require(ChatPayload.specChips(for: reply, in: bot, open: nil, library: workspace.components)?.first)
        #expect(filling.filling == "garden")
        #expect(filling.display == nil)
        #expect(workspace.specPayload(spec.id)?.steps?.last == .init(label: "Filled by garden", state: "doing"))
        let botLines = bot.messages.filter { $0.role == .bot }.count

        await eventually { bot.specs.first?.filled != nil }
        let asked = try #require(fake.agents.flatMap(\.sent).first { $0.contains(Self.fillMarker) })
        #expect(asked.contains("<show name=\"multi-select\">"))
        #expect(asked.contains("Pick several options."))
        #expect(asked.contains("Routines 每日排程"))
        #expect(asked.contains("勾選要宣傳的功能"))
        // Its <show> is the reply's component, every item; no new bubble in the chat.
        #expect(bot.specs.first?.filled == Self.fullFeatureData)
        #expect(bot.messages.filter { $0.role == .bot }.count == botLines)
        let chip = try #require(ChatPayload.specChips(for: reply, in: bot, open: nil, library: workspace.components)?.first)
        #expect(chip.filling == nil)
        #expect(chip.component == "multi-select")
        let shown = try #require(chip.display?.data)
        for feature in Self.features { #expect(shown.contains(feature)) }
        #expect(workspace.specPayload(spec.id)?.steps?.map(\.label) == ["Sent to Maintainer", "Built into the library", "Add to garden", "Filled by garden"])
        #expect(workspace.specPayload(spec.id)?.steps?.last?.state == "done")
        #expect(bot.specs.first?.conversation.last?.text == "Filled by garden")
    }

    @Test func theFillWaitsUntilTheBotIsFree() async throws {
        let fake = fillingLauncher()
        let workspace = makeWorkspace(fake)
        let bot = try garden(in: workspace)
        let reply = featureListReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        // The bot is at work on something else when the component lands.
        bot.send("hold this turn")
        await eventually { bot.isWorking }
        let agent = try #require(fake.agents.first { $0.sent.contains { $0.contains("hold this turn") } })
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"name":"multi-select"}"#)], from: workspace.maintainerProject)
        try addComponent("multi-select", to: workspace)
        try await Task.sleep(for: .milliseconds(800))
        #expect(!agent.sent.contains { $0.contains(Self.fillMarker) })
        #expect(agent.interrupts == 0)
        #expect(bot.specs.first?.filled == nil)
        // Its turn ends: then it is asked, and draws it.
        agent.reply("Done.")
        await eventually { bot.specs.first?.filled == Self.fullFeatureData }
        #expect(agent.interrupts == 0)
        #expect(bot.messages.last { $0.role == .bot }?.text == "Done.")
    }

    @Test func aComponentWithLiveDataIsNotFilledByTheBot() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"name":"test-summary","command":"swift test --parallel"}"#)], from: workspace.maintainerProject)
        try addComponent("test-summary", to: workspace)
        #expect(bot.specs.first?.status == .done)
        #expect(bot.specs.first?.filledBy == nil)
        #expect(workspace.specPayload(spec.id)?.steps?.count == 3)
    }

    @Test func specsSavedWithTheOldItemCountStillLoad() throws {
        let spec = ComponentSpec(name: "multi-select", folder: "/tmp", bots: ["garden"])
        var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(spec)) as? [String: Any])
        object["askedForAllItems"] = true
        let loaded = try JSONDecoder().decode(ComponentSpec.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(loaded.id == spec.id)
        #expect(loaded.filled == nil)
    }

    @Test func theFirstVersionReusesALibraryComponentMaintainerPicks() throws {
        let workspace = makeWorkspace()
        try addComponent("build-status", about: "Whether the last swift test passed.", to: workspace)
        let bot = try garden(in: workspace)
        workspace.takeComponent("build-status", from: bot)
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(spec.status == .building)
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"similar":"build-status","reuse":true}"#)], from: workspace.maintainerProject)
        let done = try #require(bot.specs.first)
        #expect(done.status == .done)
        #expect(done.built == "build-status")
        #expect(workspace.ownComponents(of: bot).contains("build-status"))
    }

    @Test func theBuiltComponentRunsOnlyWhatTheUserAllowed() async throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        try FileManager.default.createDirectory(at: bot.profile.workingDirectory, withIntermediateDirectories: true)
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        let command = #"printf '{"total":3,"failed":1}'"#
        let folder = bot.profile.workingDirectory
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"name":"test-summary","command":"printf '{\"total\":3,\"failed\":1}'"}"#)], from: workspace.maintainerProject)
        // Allowed already: landing still runs nothing by itself (no test run).
        workspace.componentCommands.approve(command, in: folder)
        try addComponent("test-summary", to: workspace)
        #expect(bot.specs.first?.status == .done)
        #expect(workspace.componentCommands.runs.isEmpty)
        #expect(bot.specs.first?.testRun == nil)
        workspace.componentCommands.forget(command, inFolderPath: folder.standardizedFileURL.path)

        // The card's Allow and run: only with the exact command and folder it showed.
        await workspace.runSpecComponent(spec.id, in: bot)
        await workspace.runSpecComponent(spec.id, in: bot, command: "rm -rf /", folder: folder.path, approve: true)
        await workspace.runSpecComponent(spec.id, in: bot, command: command, folder: "/tmp", approve: true)
        #expect(workspace.componentCommands.runs.isEmpty)
        #expect(!workspace.componentCommands.isApproved("rm -rf /", in: folder))
        await workspace.runSpecComponent(spec.id, in: bot, command: command, folder: folder.path, approve: true)
        #expect(workspace.componentCommands.runs[spec.card]?.data == #"{"total":3,"failed":1}"#)
        let commands = ChatPayload.CommandContext(runs: workspace.componentCommands) { _ in folder }
        let chip = try #require(ChatPayload.specChips(for: reply, in: bot, open: nil, library: workspace.components, commands: commands)?.first)
        #expect(chip.display?.status == "done")
        #expect(chip.display?.data == #"{"total":3,"failed":1}"#)
        // Kept, so it shows after a restart too.
        #expect(bot.specs.first?.testRun?.output == #"{"total":3,"failed":1}"#)
    }

    @Test func editSpecOpensThePanelAndBuildItMakesANewVersion() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        try addComponent("swift-test", to: workspace)
        #expect(bot.specs.first?.status == .done)
        let asked = relays(workspace).count

        // Edit spec: the panel opens on it; Maintainer is not asked to draft anything.
        workspace.openSpec(spec.id, in: bot)
        #expect(workspace.openSpecID == spec.id)
        #expect(relays(workspace).count == asked)
        // Its values can be changed; the component stays in the chat meanwhile.
        workspace.editSpec(spec.id, key: "about", value: "Only the failures", in: bot)
        #expect(bot.specs.first?.about == "Only the failures")
        #expect(bot.specs.first?.origins["about"] == .user)
        #expect(bot.specs.first?.status == .done)

        // Build it: a new version.
        workspace.buildSpec(spec.id, in: bot)
        #expect(bot.specs.first?.status == .building)
        let build = try #require(relays(workspace).last)
        #expect(build.text.contains("Build it"))
        #expect(build.text.contains("Only the failures"))
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, specs: true) { _ in "" }.json()
        #expect(json.contains(#""component":"swift-test""#))

        // Its template changes (seen when Maintainer's turn ends): done again.
        let folder = workspace.components.folder.appending(path: "swift-test")
        try "<p>failures</p>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
        workspace.finishSpecBuilds()
        #expect(bot.specs.first?.status == .done)
    }

    @Test func aBotsSuggestionIsOnlyAChipUntilPressed() throws {
        let workspace = makeWorkspace()
        let bot = try garden(in: workspace)
        let reply = testReply(in: bot)
        workspace.handle([.suggestComponent(name: "Test Summary", draft: "Pass/fail counts per suite, from swift test.")], from: workspace.projects.first { $0.name == "garden" })
        let spec = try #require(bot.specs.first)
        #expect(spec.messageID == reply.id)
        #expect(spec.suggestedBy == "garden")
        #expect(spec.name == "test-summary")
        #expect(spec.about == "Pass/fail counts per suite, from swift test.")
        #expect(spec.status == .draft)
        // Nothing opens, nothing runs, Maintainer hears nothing.
        #expect(!spec.opened)
        #expect(workspace.openSpecID == nil)
        #expect(relays(workspace).isEmpty)
        #expect(workspace.componentCommands.runs.isEmpty)

        // A second suggestion for the same reply does not add another chip.
        workspace.handle([.suggestComponent(name: "other", draft: "x")], from: workspace.projects.first { $0.name == "garden" })
        #expect(bot.specs.count == 1)

        // Pressed: the first version is built; the panel stays shut.
        workspace.pressSpec(spec.id, in: bot)
        #expect(bot.specs.first?.status == .building)
        #expect(workspace.openSpecID == nil)
        #expect(relays(workspace).count == 1)
        #expect(relays(workspace).last?.text.contains("Build the first version") == true)
        #expect(relays(workspace).last?.text.contains("Pass/fail counts per suite") == true)
        // Pressed again while it builds: its progress opens; nothing is sent again.
        workspace.pressSpec(spec.id, in: bot)
        #expect(workspace.openSpecID == spec.id)
        #expect(relays(workspace).count == 1)
        workspace.pressSpec(spec.id, in: bot)
        #expect(workspace.openSpecID == nil)
    }

    // MARK: Shaping it with Maintainer

    @Test func maintainersUpdateFillsFieldsAndAsksWithSuggestions() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        let json = #"""
        {"name":"test-summary","fields":[{"name":"total","type":"int"},{"name":"failed","type":"int"}],
         "samples":[{"label":"Failing run","data":"{\"total\":382,\"failed\":2}"}],
         "questions":[{"id":"refresh","key":"refresh","text":"Run on every show, or only on ↻?","options":[{"label":"Only on ↻","value":"manual"},{"label":"Every show","value":"shown"}],"suggested":0}]}
        """#
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: json)], from: workspace.maintainerProject)
        let updated = try #require(bot.specs.first)
        #expect(updated.name == "test-summary")
        #expect(updated.origins["name"] == .maintainer)
        #expect(updated.fields.map(\.name) == ["total", "failed"])
        #expect(updated.fields.allSatisfy { $0.by == .maintainer })
        #expect(updated.samples.map(\.label) == ["This reply", "Failing run"])
        #expect(updated.questions.first?.options.map(\.label) == ["Only on ↻", "Every show"])
        #expect(updated.draft == 2)

        // Only Maintainer shapes specs.
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"name":"hijack"}"#)], from: nil)
        #expect(bot.specs.first?.name == "test-summary")
    }

    @Test func theUsersEditsAreBlueAndGoToMaintainerWithTheNextWord() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        workspace.editSpec(spec.id, key: "command", value: "swift test --skip-build", in: bot)
        var edited = try #require(bot.specs.first)
        #expect(edited.command == "swift test --skip-build")
        #expect(edited.origins["command"] == .user)
        #expect(edited.conversation.last?.kind == .event)
        #expect(edited.conversation.last?.text.contains("Command") == true)

        // Maintainer repeating the same value does not take it over.
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: #"{"command":"swift test --skip-build","about":"Test results"}"#)], from: workspace.maintainerProject)
        edited = try #require(bot.specs.first)
        #expect(edited.origins["command"] == .user)
        #expect(edited.origins["about"] == .maintainer)

        workspace.editSpec(spec.id, key: "fields", value: "total: int, failures: [suite, test]", in: bot)
        edited = try #require(bot.specs.first)
        #expect(edited.fields.map(\.name) == ["total", "failures"])
        #expect(edited.fields.map(\.type) == ["int", "[suite, test]"])
        #expect(edited.fields.allSatisfy { $0.by == .user })

        workspace.saySpec(spec.id, text: "失敗的測試要列出名字", in: bot)
        let said = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(said.text.contains("失敗的測試要列出名字"))
        #expect(said.text.contains("swift test --skip-build"))
        #expect(bot.specs.first?.conversation.contains { $0.kind == .user && $0.text == "失敗的測試要列出名字" } == true)
        // Edits already told are not told again.
        #expect(bot.specs.first?.pendingEdits.isEmpty == true)
    }

    @Test func answeringAQuestionSetsItsFieldAndBuildUsesTheSuggestedRest() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        let json = #"""
        {"questions":[
          {"id":"q1","key":"refresh","text":"How often?","options":[{"label":"Only on ↻","value":"manual"},{"label":"Every show","value":"shown"}],"suggested":0},
          {"id":"q2","key":"reuse","text":"Extend build-status or a new one?","options":[{"label":"Extend it","value":"true"},{"label":"A new one","value":"false"}],"suggested":1}]}
        """#
        workspace.handle([.componentSpec(id: spec.id.uuidString, json: json)], from: workspace.maintainerProject)
        workspace.answerSpec(spec.id, question: "q1", option: 1, in: bot)
        var answered = try #require(bot.specs.first)
        #expect(answered.refresh == .shown)
        #expect(answered.origins["refresh"] == .user)
        #expect(answered.questions.map(\.id) == ["q2"])
        #expect(answered.conversation.last?.text == "Every show")

        workspace.buildSpec(spec.id, in: bot)
        answered = try #require(bot.specs.first)
        #expect(answered.questions.isEmpty)
        #expect(!answered.reuse)
        #expect(answered.status == .building)
    }

    // MARK: Test run: only what the user allowed

    @Test func aTestRunGoesThroughTheAllowFlow() async throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        try FileManager.default.createDirectory(at: bot.profile.workingDirectory, withIntermediateDirectories: true)
        var reply = ChatMessage(role: .bot, text: "Counts:")
        reply.displays = [ComponentInstance(name: "x", data: #"{"total":1,"failed":0}"#)]
        bot.post(reply, unread: false)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        workspace.editSpec(spec.id, key: "command", value: #"printf '{"total":3,"failed":1}'"#, in: bot)
        let folder = bot.profile.workingDirectory.path

        // Not allowed: nothing runs, the panel asks.
        await workspace.testRunSpec(spec.id, in: bot)
        #expect(workspace.specPayload(spec.id)?.testRun?.status == "approve")
        #expect(bot.specs.first?.testRun?.output == nil)
        // Allowing needs the exact command and folder the panel showed.
        await workspace.testRunSpec(spec.id, in: bot, command: "rm -rf /", folder: folder, approve: true)
        await workspace.testRunSpec(spec.id, in: bot, command: #"printf '{"total":3,"failed":1}'"#, folder: "/tmp", approve: true)
        #expect(!workspace.componentCommands.isApproved("rm -rf /", in: bot.profile.workingDirectory))
        #expect(bot.specs.first?.testRun?.output == nil)

        await workspace.testRunSpec(spec.id, in: bot, command: #"printf '{"total":3,"failed":1}'"#, folder: folder, approve: true)
        let run = try #require(bot.specs.first?.testRun)
        #expect(run.output == #"{"total":3,"failed":1}"#)
        #expect(run.matches == true)
        #expect(workspace.specPayload(spec.id)?.testRun?.status == "done")
        // The output becomes a sample to preview.
        #expect(bot.specs.first?.samples.contains { $0.label == "Test run" } == true)

        // Output missing a field does not match.
        workspace.editSpec(spec.id, key: "fields", value: "total: int, failures: [suite]", in: bot)
        await workspace.testRunSpec(spec.id, in: bot)
        #expect(bot.specs.first?.testRun?.matches == false)
    }

    @Test func outputMatchesTheFieldsWhenItHasThemAll() {
        let fields = [ComponentSpec.Field(name: "total", type: "int"), ComponentSpec.Field(name: "failed", type: "int")]
        #expect(ComponentSpecs.outputMatches(#"{"total":1,"failed":0,"extra":2}"#, fields: fields))
        #expect(!ComponentSpecs.outputMatches(#"{"total":1}"#, fields: fields))
        #expect(ComponentSpecs.outputMatches(#"[{"total":1,"failed":0}]"#, fields: fields))
        #expect(!ComponentSpecs.outputMatches(#""plain text""#, fields: fields))
        #expect(ComponentSpecs.outputMatches(#""plain text""#, fields: []))
    }

    // MARK: Build it

    @Test func buildingHandsItToMaintainerAndAddsItToTheChosenBots() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let other = try garden(in: workspace)
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        workspace.editSpec(spec.id, key: "bots", value: "\(bot.name), garden", in: bot)
        // The user chose live data: the tests' own command.
        workspace.editSpec(spec.id, key: "command", value: "swift test --parallel", in: bot)
        workspace.buildSpec(spec.id, in: bot)
        let build = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(build.text.contains("Build it"))
        #expect(build.text.contains("swift-test"))
        #expect(build.text.contains("Command: swift test --parallel"))
        #expect(bot.specs.first?.status == .building)
        #expect(workspace.components.working["swift-test"] != nil)

        // It lands in the library: on both bots' lists, the chat says so, the spec is done.
        try addComponent("swift-test", to: workspace)
        #expect(bot.specs.first?.status == .done)
        #expect(workspace.ownComponents(of: bot).contains("swift-test"))
        #expect(workspace.ownComponents(of: other).contains("swift-test"))
        #expect(bot.messages.last?.role == .notice)
        #expect(bot.messages.last?.text.contains("swift-test added to") == true)
        let payload = try #require(workspace.specPayload(spec.id))
        #expect(payload.preview == "swift-test")
    }

    @Test func reusingASimilarOneSkipsBuilding() throws {
        let workspace = makeWorkspace()
        try addComponent("build-status", about: "Whether the last swift test passed.", to: workspace)
        let bot = try garden(in: workspace)
        workspace.takeComponent("build-status", from: bot)
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        #expect(spec.similar == "build-status")
        workspace.editSpec(spec.id, key: "reuse", value: "true", in: bot)
        let asked = workspace.maintainer.messages.filter { $0.role == .relay }.count
        workspace.buildSpec(spec.id, in: bot)
        #expect(bot.specs.first?.status == .done)
        #expect(workspace.ownComponents(of: bot).contains("build-status"))
        #expect(workspace.maintainer.messages.filter { $0.role == .relay }.count == asked)
    }

    @Test func addingAnExistingComponentToAnotherBot() throws {
        let workspace = makeWorkspace()
        try addComponent("git-log", to: workspace)
        let bot = workspace.mainBot
        let other = try garden(in: workspace)
        var reply = ChatMessage(role: .bot, text: "提交紀錄")
        reply.displays = [ComponentInstance(name: "git-log", data: "[]")]
        bot.post(reply, unread: false)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        workspace.editSpec(spec.id, key: "bots", value: "garden", in: bot)
        workspace.buildSpec(spec.id, in: bot)
        #expect(workspace.ownComponents(of: other).contains("git-log"))
        #expect(bot.specs.first?.status == .done)
    }

    @Test func cancellingTakesTheChipAway() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        workspace.cancelSpec(spec.id, in: bot)
        #expect(bot.specs.isEmpty)
        #expect(workspace.openSpecID == nil)
    }

    // MARK: Tags and rules

    @Test func repliesCarryTheNewTags() {
        let parsed = ReplyParser.parseAll("""
        Done. <suggest-component name="test-summary">Counts per suite from swift test.</suggest-component>
        `<suggest-component name="x">in code</suggest-component>`
        """)
        #expect(parsed.requests == [.suggestComponent(name: "test-summary", draft: "Counts per suite from swift test.")])
        #expect(!parsed.body.contains("<suggest-component name=\"test-summary\""))
        let spec = ReplyParser.parseAll(#"OK, filled in. <component-spec id="ABC">{"name":"x"}</component-spec>"#)
        #expect(spec.requests == [.componentSpec(id: "ABC", json: #"{"name":"x"}"#)])
        #expect(spec.body == "OK, filled in.")
    }

    @Test func maintainersWordsGoToTheSpecConversation() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = draftSpec(from: reply, in: bot, in: workspace)
        workspace.applySpecUpdate(id: spec.id.uuidString, json: #"{"about":"Tests"}"#, said: "其他欄位我照這則回覆填好了。")
        let line = try #require(bot.specs.first?.conversation.last)
        #expect(line.kind == .maintainer)
        #expect(line.text == "其他欄位我照這則回覆填好了。")
    }

    @Test func botsAreToldHowToSuggestAndMaintainerHowToShapeSpecs() {
        let profile = BotProfile.main(home: root.appending(path: "home"))
        let rules = BotPrompts(profile: profile).system
        #expect(rules.contains("<suggest-component name="))
        #expect(rules.contains("nothing happens until the user presses it"))
        let workspace = makeWorkspace()
        let maintainer = workspace.maintainerInstructions()
        #expect(maintainer.contains("(Component spec <id>)"))
        #expect(maintainer.contains("<component-spec id="))
        #expect(maintainer.contains("(Component spec <id>) Build the first version"))
        #expect(maintainer.contains("Ask nothing"))
        #expect(maintainer.contains("best guess"))
        // A reply's own content is its data; a command only for live data.
        #expect(maintainer.contains("Its data is the reply's own content"))
        #expect(maintainer.contains("A Command is optional"))
        // It builds only the component; the bot that wrote the reply draws it with its data.
        #expect(maintainer.contains("starts with what the component is for"))
        #expect(maintainer.contains("the app asks the bot that wrote the reply to draw it"))
        #expect(!maintainer.contains("\"This reply\" sample"))
        #expect(ComponentPrompts.system.contains("Data from a command (optional)"))
    }
}
