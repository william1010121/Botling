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
        // The command it ran is the likely source of the data.
        #expect(spec.command == "swift test --parallel")
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
        // Nothing to draft: Maintainer is not asked.
        #expect(!workspace.maintainer.messages.contains { $0.role == .relay })
        // The chat says so on its button.
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, specs: true) { _ in "" }.json()
        #expect(json.contains(#""component":"git-log""#))
        #expect(json.contains(#""makeComponents":true"#))
    }

    // MARK: The chip

    @Test func makingOneAddsAChipOpensItOnceAndAsksMaintainer() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(bot.specs.map(\.id) == [spec.id])
        #expect(workspace.openSpecID == spec.id)
        #expect(bot.specs[0].opened)
        // Kept beside the chat.
        let saved = BotStore(directory: root.appending(path: "ccb/main")).loadSpecs()
        #expect(saved.map(\.id) == [spec.id])
        // Maintainer gets the draft to fill in, with the spec's id to answer with.
        let relay = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(relay.text.hasPrefix("(Component spec \(spec.id.uuidString))"))
        #expect(relay.text.contains("swift test --parallel"))
        #expect(relay.text.contains("<component-spec id=\"\(spec.id.uuidString)\">"))

        // Collapsed back to the chip; pressing the button again opens the same spec.
        workspace.closeSpec()
        #expect(workspace.openSpecID == nil)
        let again = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(again.id == spec.id)
        #expect(bot.specs.count == 1)
        #expect(workspace.openSpecID == spec.id)
        #expect(workspace.maintainer.messages.filter { $0.role == .relay }.count == 1)

        // The chip is drawn under the reply.
        let json = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, specs: true, openSpec: workspace.openSpecID) { _ in "" }.json()
        #expect(json.contains(#""specs":[{"id":"\#(spec.id.uuidString)","name":"swift-test","open":true,"status":"draft","suggested":false}]"#))
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
        // Nothing opens, nothing runs, Maintainer hears nothing.
        #expect(!spec.opened)
        #expect(workspace.openSpecID == nil)
        #expect(!workspace.maintainer.messages.contains { $0.role == .relay })
        #expect(workspace.componentCommands.runs.isEmpty)

        // A second suggestion for the same reply does not add another chip.
        workspace.handle([.suggestComponent(name: "other", draft: "x")], from: workspace.projects.first { $0.name == "garden" })
        #expect(bot.specs.count == 1)

        // Pressed: it opens, and only now Maintainer is asked to draft it.
        workspace.openSpec(spec.id, in: bot)
        #expect(workspace.openSpecID == spec.id)
        #expect(workspace.maintainer.messages.filter { $0.role == .relay }.count == 1)
        workspace.closeSpec()
        workspace.openSpec(spec.id, in: bot)
        #expect(workspace.maintainer.messages.filter { $0.role == .relay }.count == 1)
    }

    // MARK: Shaping it with Maintainer

    @Test func maintainersUpdateFillsFieldsAndAsksWithSuggestions() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        workspace.editSpec(spec.id, key: "bots", value: "\(bot.name), garden", in: bot)
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
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
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        workspace.applySpecUpdate(id: spec.id.uuidString, json: #"{"about":"Tests"}"#, said: "其他欄位我照這則回覆填好了。")
        let line = try #require(bot.specs.first?.conversation.last)
        #expect(line.kind == .maintainer)
        #expect(line.text == "其他欄位我照這則回覆填好了。")
    }

    @Test func botsAreToldHowToSuggestAndMaintainerHowToShapeSpecs() {
        let profile = BotProfile.main(home: root.appending(path: "home"))
        let rules = BotPrompts(profile: profile).system
        #expect(rules.contains("<suggest-component name="))
        #expect(rules.contains("nothing happens until the user opens it"))
        let workspace = makeWorkspace()
        let maintainer = workspace.maintainerInstructions()
        #expect(maintainer.contains("(Component spec <id>)"))
        #expect(maintainer.contains("<component-spec id="))
    }
}
