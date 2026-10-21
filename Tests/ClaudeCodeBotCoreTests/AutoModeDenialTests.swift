import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Auto mode's classifier blocked a tool call: the bot's chat shows the usual permission card for
/// that call, and the user's Allow lets it through, instead of the bot asking them to edit
/// .claude/settings.local.json by hand.
@MainActor
struct AutoModeDenialTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-denial-\(UUID().uuidString)")

    static let classifierText = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction]. If you have other tasks that don't depend on this action, continue working on those. To allow this type of action in the future, the user can add a Bash permission rule to their settings."

    /// The lines claude writes when the classifier blocks `rm -rf build`.
    static let toolUseLine = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"rm -rf build","description":"Remove build"}}]},"parent_tool_use_id":null}"#
    static var deniedFrame: String {
        let frame: [String: Any] = ["type": "system", "subtype": "permission_denied", "tool_name": "Bash", "tool_use_id": "toolu_1",
                                    "decision_reason_type": "classifier", "decision_reason": "[Irreversible Local Destruction] Deletes the build folder",
                                    "message": classifierText, "uuid": "u1", "session_id": "s1"]
        return String(decoding: try! JSONSerialization.data(withJSONObject: frame), as: UTF8.self)
    }
    static var deniedResult: String {
        let line: [String: Any] = ["type": "user", "parent_tool_use_id": NSNull(), "message": ["role": "user", "content": [
            ["type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": classifierText]
        ]]]
        return String(decoding: try! JSONSerialization.data(withJSONObject: line), as: UTF8.self)
    }

    func awakeBot(_ fake: FakeLauncher) async throws -> (Bot, FakeAgent) {
        fake.respond = { text in isAppOnly(text) ? "OK" : nil }
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: BotStore(directory: root.appending(path: "store")))
        bot.send("Clean the build")
        await eventually { fake.agents.count == 1 }
        return (bot, fake.agents[0])
    }

    /// What claude's stream says, as the bot gets it.
    func emitDenial(_ agent: FakeAgent, frame: Bool = true) {
        for line in [Self.toolUseLine] + (frame ? [Self.deniedFrame] : []) + [Self.deniedResult] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
    }

    /// The tool result as claude 2.1.304 sends it on the main thread: `tool_result_meta` says why
    /// the call did not run (`non_execution_kind`), beside the words for the model. (Shape from the
    /// SDK schema in the claude binary and the `toolDenialKind` / `permissionDecision` of real
    /// transcripts; the classifier's text is a real one.)
    static func resultWithMeta(kind: String, text given: String? = nil) -> String {
        let text = given ?? realClassifierText
        let line: [String: Any] = ["type": "user", "parent_tool_use_id": NSNull(), "message": ["role": "user", "content": [
            ["type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": text]
        ]], "tool_use_result": "Error: " + text, "tool_result_meta": [[
            "id": "toolu_1", "non_execution_kind": kind,
            "permission_decision": ["decision": "reject", "source": "config", "reason_type": "classifier"]
        ]]]
        return String(decoding: try! JSONSerialization.data(withJSONObject: line), as: UTF8.self)
    }

    /// Real texts (claude 2.1.296–2.1.304 transcripts): a block, and the "no verdict" failures.
    static let realClassifierText = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Code from External]. If you have other tasks that don't depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed. To allow this type of action in the future, the user can add a permission rule for Bash to their settings."
    static let realNoVerdictTexts = [
        "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action: a later response may get a verdict.",
        "The server-side auto mode classifier gave no verdict (the response ended before its verdict arrived), so auto mode cannot determine the safety of CronCreate. This is a transient failure of the check, not a judgment about the action: a later response may get a verdict. You may try the action again once, as-is.",
        "The server-side auto mode classifier gave no verdict (it skipped this action), so auto mode cannot determine the safety of Edit. This is a hard failure, not a transient one: the check cannot or does not judge this request, so retrying this action will get the same answer. Don't retry it."
    ]

    @Test func theClassifiersDenialIsReadFromTheStream() {
        // The frame names the call and the reason; whether it was a block comes with the result.
        let frame = StreamEvent.events(in: Self.deniedFrame)
        #expect(frame == [.permissionDenied(PermissionDenial(toolUseID: "toolu_1", tool: "Bash", reason: "[Irreversible Local Destruction] Deletes the build folder", confirmed: false))])
        // Older claude without the frame or meta: the tool result's words say so.
        let result = StreamEvent.events(in: Self.deniedResult)
        #expect(result.contains(.permissionDenied(PermissionDenial(toolUseID: "toolu_1", tool: nil, reason: "[Irreversible Local Destruction]"))))
        #expect(StreamEvent.events(in: Self.resultWithMeta(kind: "automode-blocked")).contains(.permissionDenied(PermissionDenial(toolUseID: "toolu_1", tool: nil, reason: "[Code from External]"))))
    }

    /// claude's structured `non_execution_kind` decides, not its words: a block in other words is
    /// still a block, and a "no verdict" stays no card whatever the words say.
    @Test func theResultsStructuredKindDecidesNotItsWords() {
        func denied(_ line: String) -> Bool { StreamEvent.events(in: line).contains { if case let .permissionDenied(denial) = $0 { denial.confirmed } else { false } } }
        #expect(denied(Self.resultWithMeta(kind: "automode-blocked", text: "Auto mode said no to this call. 理由：會刪掉資料。")))
        #expect(!denied(Self.resultWithMeta(kind: "automode-unavailable")))
        #expect(!denied(Self.resultWithMeta(kind: "automode-parsing-error")))
        #expect(!denied(Self.resultWithMeta(kind: "permission-rule")))
        // A call that ran (no kind) is not a denial whatever its output says.
        let ran = Self.resultWithMeta(kind: "automode-blocked").replacingOccurrences(of: #""non_execution_kind":"automode-blocked","#, with: "")
        #expect(!denied(ran))
        // Words alone (an older claude): only a real block's.
        for text in Self.realNoVerdictTexts {
            #expect(!denied(Self.deniedResult.replacingOccurrences(of: Self.classifierText, with: text)))
        }
        #expect(denied(Self.deniedResult.replacingOccurrences(of: Self.classifierText, with: Self.realClassifierText)))
    }

    /// The frame alone shows no card: a "no verdict" sends one too.
    @Test func aFrameWhoseCallWasNotBlockedShowsNoCard() async throws {
        let (bot, agent) = try await awakeBot(FakeLauncher())
        let noVerdict = Self.resultWithMeta(kind: "automode-unavailable", text: Self.realNoVerdictTexts[0])
        for line in [Self.toolUseLine, Self.deniedFrame, noVerdict] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        try await Task.sleep(for: .milliseconds(100))
        #expect(bot.messages.allSatisfy { $0.permissionTool == nil })
        // Blocked: the card, with the frame's tool and reason.
        for line in [Self.toolUseLine.replacingOccurrences(of: "toolu_1", with: "toolu_2"), Self.deniedFrame.replacingOccurrences(of: "toolu_1", with: "toolu_2"),
                     Self.resultWithMeta(kind: "automode-blocked", text: "Blocked.").replacingOccurrences(of: "toolu_1", with: "toolu_2")] {
            for event in StreamEvent.events(in: line) { agent.emit(event) }
        }
        await eventually { bot.openQuestion?.permissionTool == "Bash" }
        #expect(bot.openQuestion?.text.contains("Deletes the build folder") == true)
    }

    @Test func denialsTheUserCannotOverrideAreLeftAlone() {
        // A deny rule, or a classifier with no verdict (a transient failure): no card.
        let rule = Self.deniedFrame.replacingOccurrences(of: #""classifier""#, with: #""rule""#)
        #expect(!StreamEvent.events(in: rule).contains { if case .permissionDenied = $0 { true } else { false } })
        let noVerdict = Self.deniedResult.replacingOccurrences(of: "Permission for this action was denied by the Claude Code auto mode classifier", with: "The server-side auto mode classifier gave no verdict")
        #expect(!StreamEvent.events(in: noVerdict).contains { if case .permissionDenied = $0 { true } else { false } })
    }

    @Test func aBlockedCallShowsAPermissionCard() async throws {
        let (bot, agent) = try await awakeBot(FakeLauncher())
        emitDenial(agent)
        await eventually { bot.openQuestion?.permissionTool == "Bash" }
        let card = try #require(bot.openQuestion)
        #expect(card.text.contains("rm -rf build"))
        #expect(card.text.contains("Irreversible Local Destruction"))
        #expect(card.choices?.map(\.label) == ["Allow once", "Always allow this command", "Don't allow"])
        #expect(card.choices?.map(\.action) == [.allowOnce, .alwaysAllow, .deny])
        // The frame and the tool result are one denial: one card.
        #expect(bot.messages.filter { $0.permissionTool != nil }.count == 1)
    }

    @Test func allowOnceLetsThatCallThroughAndTellsTheBot() async throws {
        let (bot, agent) = try await awakeBot(FakeLauncher())
        emitDenial(agent, frame: false)
        await eventually { bot.openQuestion != nil }
        #expect(bot.choose(0, in: try #require(bot.openQuestion).id))
        #expect(agent.allowedRules.last == ["Bash(rm -rf build)"])
        await eventually { agent.sent.last?.contains("allowed") == true }
        #expect(agent.sent.last?.contains("rm -rf build") == true)
        #expect(bot.alwaysAllowed.isEmpty)
        #expect(bot.openQuestion == nil)
    }

    @Test func alwaysAllowIsRememberedForThatCommand() async throws {
        let fake = FakeLauncher()
        let (bot, agent) = try await awakeBot(fake)
        emitDenial(agent)
        await eventually { bot.openQuestion != nil }
        #expect(bot.choose(1, in: try #require(bot.openQuestion).id))
        #expect(bot.alwaysAllowed == ["Bash(rm -rf build)"])
        #expect(agent.allowedRules.last == ["Bash(rm -rf build)"])

        // A new session starts with it allowed (as a rule, not as a tool name).
        let reopened = Bot(profile: .main(home: root), launcher: fake.launcher, store: BotStore(directory: root.appending(path: "store")))
        reopened.send("again")
        await eventually { fake.agents.count == 2 }
        #expect(fake.agents[1].launch.allowRules == ["Bash(rm -rf build)"])
        #expect(!fake.agents[1].launch.tools.contains("Bash(rm -rf build)"))
        let arguments = ClaudeAgentProcess.arguments(for: fake.agents[1].launch)
        let settings = try #require(arguments.firstIndex(of: "--settings").map { arguments[$0 + 1] })
        #expect(settings.contains(#"Bash(rm -rf build)"#))
    }

    @Test func dontAllowTellsTheBotTheUserDeclined() async throws {
        let (bot, agent) = try await awakeBot(FakeLauncher())
        emitDenial(agent)
        await eventually { bot.openQuestion != nil }
        #expect(bot.choose(2, in: try #require(bot.openQuestion).id))
        #expect(agent.allowedRules.isEmpty)
        await eventually { agent.sent.last?.contains("did not allow") == true }
    }

    @Test func theRuleFitsTheTool() {
        #expect(Bot.allowRule(tool: "Bash", detail: "git push --force") == "Bash(git push --force)")
        #expect(Bot.allowRule(tool: "Write", detail: "/Users/me/.zshrc") == "Edit(//Users/me/.zshrc)")
        #expect(Bot.allowRule(tool: "WebFetch", detail: "https://example.com/a?b") == "WebFetch(domain:example.com)")
        #expect(Bot.allowRule(tool: "mcp__x__send", detail: "{}") == "mcp__x__send")
        #expect(Bot.allowRule(tool: "Bash", detail: "") == nil)
    }

    @Test func theSystemPromptPointsAtTheCardNotTheSettingsFile() {
        let prompt = BotPrompts(profile: .main(home: root)).system
        #expect(prompt.contains("auto mode"))
        #expect(prompt.contains("settings.local.json"))
    }
}
