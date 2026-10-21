import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The spec panel once a component is built: what the user types in "Ask for changes…" is a
/// change request that builds the next version right away (no Build press), the panel says
/// Maintainer is on it and which version it makes, then that it landed (or why not); what is
/// typed meanwhile waits and goes with the next request. A draft keeps its Build it flow.
@MainActor
struct SpecChangeFlowTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-spec-flow-\(UUID().uuidString)")

    func makeWorkspace() -> Workspace {
        let fake = FakeLauncher()
        return Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, template: String? = nil, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try (template ?? "<p>\(name)</p>").write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "\(name) card.".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func testReply(in bot: Bot) -> ChatMessage {
        let message = ChatMessage(role: .bot, text: "測試全部跑完了：382 個測試，0 個失敗。")
        bot.post(message, unread: false)
        return message
    }

    func relays(_ workspace: Workspace) -> [ChatMessage] {
        workspace.maintainer.messages.filter { $0.role == .relay }
    }

    /// A component made from a reply and built (its first version, v1).
    func builtSpec(in workspace: Workspace) throws -> (Bot, ComponentSpec) {
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        try addComponent(spec.name, to: workspace)
        let built = try #require(bot.specs.first)
        #expect(built.status == .done)
        return (bot, built)
    }

    /// The library sees the template change (a new version lands).
    func land(_ name: String, _ template: String, in workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try template.write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
        workspace.finishSpecBuilds()
    }

    // MARK: The request text

    @Test func aChangeRequestBuildsTheNewVersionNowAndNeverWaitsForBuild() {
        var spec = ComponentSpec(name: "test-summary", folder: "/p", bots: ["main"])
        spec.built = "test-summary"
        spec.status = .done
        spec.pendingEdits = ["About: Only the failures"]
        let text = ComponentSpecs.changeRequest(spec, said: ["失敗的要列名字", "加上耗時"], version: 3)
        #expect(text.hasPrefix("(Component spec \(spec.id.uuidString)) Change it now"))
        #expect(text.contains("v3"))
        #expect(text.contains("失敗的要列名字"))
        #expect(text.contains("加上耗時"))
        #expect(text.contains("Only the failures"))
        #expect(text.contains("right away"))
        #expect(text.contains("Do not wait for a Build press"))
        #expect(text.contains("exactly one question"))
        #expect(text.contains("<component-spec id=\"\(spec.id.uuidString)\">"))
        // Nothing in it says to wait or press anything first.
        #expect(!text.contains("Build nothing yet"))
        #expect(!text.lowercased().contains("press build first"))
        #expect(!text.contains("until a \"(Component spec"))
    }

    @Test func aDraftsTalkStillBuildsNothingUntilBuildIt() {
        let spec = ComponentSpec(name: "test-summary", folder: "/p", bots: ["main"])
        let text = ComponentSpecs.sayRequest(spec, text: "加上耗時")
        #expect(text.contains("Build nothing yet"))
        #expect(text.contains("Build it"))
    }

    @Test func maintainersInstructionsSayAChangeIsBuiltAtOnce() {
        let rules = makeWorkspace().maintainerInstructions()
        #expect(rules.contains("(Component spec <id>) Change it now"))
        #expect(rules.contains("build that new version right away"))
        #expect(rules.contains("never ask the user to press Build"))
        #expect(rules.contains("exactly one question"))
    }

    // MARK: State transitions

    @Test func typingInABuiltOnesPanelSendsTheChangeAtOnce() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        #expect(spec.version == 1)
        let asked = relays(workspace).count

        workspace.saySpec(spec.id, text: "失敗的要列名字", in: bot)
        let changing = try #require(bot.specs.first)
        #expect(changing.status == .building)
        #expect(changing.change?.state == .working)
        #expect(changing.change?.version == 2)
        #expect(changing.change?.said == ["失敗的要列名字"])
        #expect(changing.conversation.contains { $0.kind == .user && $0.text == "失敗的要列名字" })
        #expect(relays(workspace).count == asked + 1)
        let relay = try #require(relays(workspace).last)
        #expect(relay.text.contains("Change it now"))
        #expect(relay.text.contains("v2"))
        #expect(workspace.components.working[spec.name] != nil)

        // The panel says Maintainer is on it, and which version it makes.
        let payload = try #require(workspace.specPayload(spec.id))
        let json = payload.json()
        #expect(json.contains(#""state":"working""#))
        #expect(json.contains(#""version":2"#))
        #expect(payload.steps?.contains { $0.state == "doing" } == true)

        // The new version lands: updated, v2, done again.
        try land(spec.name, "<p>with names</p>", in: workspace)
        let updated = try #require(bot.specs.first)
        #expect(updated.status == .done)
        #expect(updated.version == 2)
        #expect(updated.change?.state == .updated)
        #expect(updated.conversation.contains { $0.kind == .event && $0.text.contains("v2") })
        let after = try #require(workspace.specPayload(spec.id)).json()
        #expect(after.contains(#""state":"updated""#))
    }

    @Test func whatIsTypedDuringAChangeWaitsAndGoesWithTheNextRequest() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.saySpec(spec.id, text: "失敗的要列名字", in: bot)
        let sent = relays(workspace).count

        workspace.saySpec(spec.id, text: "加上耗時", in: bot)
        workspace.saySpec(spec.id, text: "標題改成中文", in: bot)
        var waiting = try #require(bot.specs.first)
        // Nothing more is sent while v2 is being made.
        #expect(relays(workspace).count == sent)
        #expect(waiting.queued == ["加上耗時", "標題改成中文"])
        #expect(waiting.change?.version == 2)
        #expect(try #require(workspace.specPayload(spec.id)).json().contains(#""queued":["加上耗時","標題改成中文"]"#))

        // v2 lands: the waiting words go together as the request for v3.
        try land(spec.name, "<p>v2</p>", in: workspace)
        waiting = try #require(bot.specs.first)
        #expect(waiting.version == 2)
        #expect(waiting.status == .building)
        #expect(waiting.change?.version == 3)
        #expect(waiting.change?.said == ["加上耗時", "標題改成中文"])
        #expect(waiting.queued == nil)
        let next = try #require(relays(workspace).last)
        #expect(relays(workspace).count == sent + 1)
        #expect(next.text.contains("Change it now"))
        #expect(next.text.contains("加上耗時"))
        #expect(next.text.contains("標題改成中文"))
    }

    @Test func anAmbiguousChangeAsksOneQuestionAndTheAnswerCarriesOn() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.saySpec(spec.id, text: "改小一點", in: bot)
        let json = #"""
        {"questions":[
          {"id":"q1","text":"字變小還是卡片變窄？","options":[{"label":"字變小"},{"label":"卡片變窄"}],"suggested":0},
          {"id":"q2","text":"Another?","options":[{"label":"a"},{"label":"b"}]}]}
        """#
        workspace.applySpecUpdate(id: spec.id.uuidString, json: json, said: "你是指哪一種？")
        var asking = try #require(bot.specs.first)
        // One question, kept for the user (not answered with its suggestion), nothing building.
        #expect(asking.questions.map(\.id) == ["q1"])
        #expect(asking.change?.state == .asking)
        #expect(asking.status == .done)
        #expect(workspace.components.working[spec.name] == nil)
        let sent = relays(workspace).count

        workspace.answerSpec(spec.id, question: "q1", option: 1, in: bot)
        asking = try #require(bot.specs.first)
        #expect(asking.status == .building)
        #expect(asking.change?.state == .working)
        #expect(asking.change?.version == 2)
        #expect(relays(workspace).count == sent + 1)
        let relay = try #require(relays(workspace).last)
        #expect(relay.text.contains("Change it now"))
        #expect(relay.text.contains("改小一點"))
        #expect(relay.text.contains("卡片變窄"))
    }

    @Test func maintainersTurnEndingWithoutANewVersionSaysWhy() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.saySpec(spec.id, text: "加上耗時", in: bot)
        // Maintainer was idle when it was sent (the fake one never ends its first turn).
        bot.editSpecs { $0[0].change?.waitTurn = false }
        workspace.settleSpecChanges(after: ChatMessage(role: .bot, text: "我看不到那個資料夾。"))
        let failed = try #require(bot.specs.first)
        #expect(failed.change?.state == .failed)
        #expect(failed.change?.error?.contains("我看不到那個資料夾") == true)
        #expect(failed.status == .done)
        #expect(workspace.components.working[spec.name] == nil)
        #expect(try #require(workspace.specPayload(spec.id)).json().contains(#""state":"failed""#))

        // A late landing still counts.
        try land(spec.name, "<p>late</p>", in: workspace)
        #expect(bot.specs.first?.change?.state == .updated)
        #expect(bot.specs.first?.version == 2)
    }

    /// An error ends whatever Maintainer was doing, this change too.
    @Test func anErrorFromMaintainerIsTheChangesError() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.saySpec(spec.id, text: "加上耗時", in: bot)
        workspace.settleSpecChanges(after: ChatMessage(role: .error, text: "Rate limited"))
        #expect(bot.specs.first?.change?.state == .failed)
        #expect(bot.specs.first?.change?.error?.contains("Rate limited") == true)
    }

    @Test func aTurnThatWasAlreadyRunningIsNotTheAnswer() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.saySpec(spec.id, text: "加上耗時", in: bot)
        bot.editSpecs { $0[0].change?.waitTurn = true }
        workspace.settleSpecChanges(after: ChatMessage(role: .bot, text: "Done with the other thing."))
        #expect(bot.specs.first?.change?.state == .working)
        workspace.settleSpecChanges(after: ChatMessage(role: .bot, text: "Hmm."))
        #expect(bot.specs.first?.change?.state == .failed)
    }

    @Test func aTurnWithABackgroundBuildStillRunningKeepsWaiting() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.saySpec(spec.id, text: "加上耗時", in: bot)
        var message = ChatMessage(role: .bot, text: "交給組件編輯器了。")
        message.backgroundTasks = [BackgroundTask(id: "t1", kind: .agent, title: "component-editor")]
        workspace.settleSpecChanges(after: message)
        #expect(bot.specs.first?.change?.state == .working)
    }

    @Test func rebuildingABuiltOneIsTrackedAsTheNextVersion() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try builtSpec(in: workspace)
        workspace.editSpec(spec.id, key: "about", value: "Only the failures", in: bot)
        workspace.buildSpec(spec.id, in: bot)
        let building = try #require(bot.specs.first)
        #expect(building.change?.state == .working)
        #expect(building.change?.version == 2)
        #expect(try #require(relays(workspace).last).text.contains("Only the failures"))
    }

    @Test func aDraftsWordsStillOnlyTalk() throws {
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        let reply = testReply(in: bot)
        let spec = ComponentSpecs.draft(from: reply, bot: bot.name, folder: bot.profile.workingDirectory, library: workspace.components)
        bot.editSpecs { $0.append(spec) }
        workspace.saySpec(spec.id, text: "加上耗時", in: bot)
        let talked = try #require(bot.specs.first)
        #expect(talked.status == .draft)
        #expect(talked.change == nil)
        #expect(try #require(relays(workspace).last).text.contains("Build nothing yet"))
    }
}
