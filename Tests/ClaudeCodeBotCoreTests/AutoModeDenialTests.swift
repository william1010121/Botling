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

    @Test func theClassifiersDenialIsReadFromTheStream() {
        let frame = StreamEvent.events(in: Self.deniedFrame)
        #expect(frame == [.permissionDenied(PermissionDenial(toolUseID: "toolu_1", tool: "Bash", reason: "[Irreversible Local Destruction] Deletes the build folder"))])
        // Older claude without the frame: the tool result alone says so.
        let result = StreamEvent.events(in: Self.deniedResult)
        #expect(result.contains(.permissionDenied(PermissionDenial(toolUseID: "toolu_1", tool: nil, reason: "[Irreversible Local Destruction]"))))
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
