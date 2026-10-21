import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The reply shows when its message ends, before the Stop hook runs and the result line comes.
struct FinalMessageWatchTests {
    /// Lines as claude 2.1.304 writes them with `--include-partial-messages` (shortened).
    static func assistant(_ id: String, _ blocks: String, parent: String? = nil) -> String {
        #"{"type":"assistant","message":{"id":"\#(id)","type":"message","role":"assistant","content":[\#(blocks)],"stop_reason":null},"parent_tool_use_id":\#(parent.map { "\"\($0)\"" } ?? "null"),"session_id":"s"}"#
    }

    static func delta(_ id: String, _ reason: String, parent: String? = nil) -> String {
        #"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"\#(reason)","stop_sequence":null},"usage":{"output_tokens":3}},"session_id":"s","parent_tool_use_id":\#(parent.map { "\"\($0)\"" } ?? "null"),"uuid":"u","api_message_id":"\#(id)"}"#
    }

    static let textDelta = #"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}},"session_id":"s","parent_tool_use_id":null,"uuid":"u","api_message_id":"m2"}"#

    @Test func theLastMessageEndsTheTurnWithItsWords() {
        var watch = FinalMessageWatch()
        let lines = [
            Self.assistant("m1", #"{"type":"thinking","thinking":"","signature":"x"}"#),
            Self.assistant("m1", #"{"type":"text","text":"Let me look."}"#),
            Self.assistant("m1", #"{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}"#),
            Self.delta("m1", "tool_use"),
            #"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"a.txt"}]},"parent_tool_use_id":null}"#,
            Self.textDelta,
            Self.assistant("m2", #"{"type":"text","text":"Hello there."}"#)
        ]
        for line in lines { #expect(watch.read(line) == nil) }
        #expect(watch.read(Self.delta("m2", "end_turn")) == "Hello there.")
        // Said once.
        #expect(watch.read(Self.delta("m2", "end_turn")) == nil)
    }

    @Test func aSubagentsMessagesAreNotTheReply() {
        var watch = FinalMessageWatch()
        #expect(watch.read(Self.assistant("main", #"{"type":"text","text":"Asking a helper."}"#)) == nil)
        #expect(watch.read(Self.assistant("sub", #"{"type":"text","text":"Helper done."}"#, parent: "toolu_1")) == nil)
        #expect(watch.read(Self.delta("sub", "end_turn", parent: "toolu_1")) == nil)
        // Its own message still ends when it does.
        #expect(watch.read(Self.delta("main", "end_turn")) == "Asking a helper.")
    }

    @Test func aMessageInPartsIsOneReplyAndOtherEndsAreNot() {
        var watch = FinalMessageWatch()
        _ = watch.read(Self.assistant("m", #"{"type":"text","text":"One."}"#))
        _ = watch.read(Self.assistant("m", #"{"type":"text","text":"Two."}"#))
        #expect(watch.read(Self.delta("m", "max_tokens")) == nil)
        #expect(watch.read(Self.delta("m", "end_turn")) == "One.\n\nTwo.")
        // No words (thinking only): nothing early; the result line says it.
        _ = watch.read(Self.assistant("n", #"{"type":"thinking","thinking":""}"#))
        #expect(watch.read(Self.delta("n", "end_turn")) == nil)
        // Another message's end does not carry these words.
        _ = watch.read(Self.assistant("p", #"{"type":"text","text":"Mine."}"#))
        #expect(watch.read(Self.delta("q", "end_turn")) == nil)
        // A result line forgets what was said.
        _ = watch.read(Self.assistant("r", #"{"type":"text","text":"Gone."}"#))
        _ = watch.read(#"{"type":"result","subtype":"success","result":"Gone.","is_error":false}"#)
        #expect(watch.read(Self.delta("r", "end_turn")) == nil)
    }

    @Test func partialChunksAreNotEvents() {
        #expect(StreamEvent.events(in: Self.textDelta).isEmpty)
        #expect(StreamEvent.events(in: Self.delta("m", "end_turn")).isEmpty)
        // The whole message still makes its trace step.
        #expect(StreamEvent.events(in: Self.assistant("m", #"{"type":"text","text":"Hi"}"#)) == [.trace(.text("Hi", parent: nil))])
    }

    @Test func onlyABotWithTheStopHookAsksForChunks() {
        var launch = AgentLaunch(model: .sonnet, sessionID: UUID(), workingDirectory: URL(filePath: "/tmp"), systemPrompt: "")
        #expect(!ClaudeAgentProcess.arguments(for: launch).contains("--include-partial-messages"))
        launch.stopHookCommand = "true"
        #expect(ClaudeAgentProcess.arguments(for: launch).contains("--include-partial-messages"))
    }

    @Test func aResultMatchesTheReplyShownWhenItIsItsEnd() {
        var early = EarlyReplies()
        #expect(early.matching("Hi") == nil)
        let message = ChatMessage(role: .bot, text: "Hi")
        early.shown("One.\n\nHi ", message: message, requests: [])
        #expect(early.matching("Hi") == message)
        #expect(early.matching("  One.\n\nHi\n") == message)
        #expect(early.matching("Something else") == nil)
        #expect(early.matching("") == nil)
    }
}

@MainActor
struct EarlyReplyBotTests {
    /// A bot whose fake claude answers nothing by itself, and what it told the workspace.
    final class Heard {
        var replies: [ChatMessage] = []
        var requests: [BotRequest] = []
    }

    func quietBot(_ fake: FakeLauncher) -> (Bot, Heard) {
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        let heard = Heard()
        bot.onReply = { message, _ in heard.replies.append(message) }
        bot.onRequests = { heard.requests += $0 }
        return (bot, heard)
    }

    @Test func theReplyShowsBeforeTheTurnEndsAndOnlyOnce() async throws {
        let fake = FakeLauncher()
        let (bot, heard) = quietBot(fake)
        bot.send("Make a team")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.trace(.text("Done. <team name=\"research\">look it up</team>", parent: nil)))
        agent.emit(.earlyReply("Done. <team name=\"research\">look it up</team>"))
        await eventually { bot.messages.last?.role == .bot }
        // Shown, still working (the Stop hook runs), nothing told yet.
        #expect(bot.messages.last?.text == "Done.")
        #expect(bot.isWorking)
        #expect(bot.unreadCount == 1)
        #expect(heard.replies.isEmpty && heard.requests.isEmpty)

        agent.emit(.usage(totalCost: 0.01))
        agent.reply("Done. <team name=\"research\">look it up</team>")
        await eventually { !bot.isWorking }
        #expect(bot.messages.map(\.role) == [.user, .bot])
        #expect(bot.unreadCount == 1)
        #expect(heard.replies.map(\.text) == ["Done."])
        #expect(heard.requests == [.team(name: "research", task: "look it up")])
    }

    @Test func aTurnTheStopHookSentBackShowsBothReplies() async throws {
        let fake = FakeLauncher()
        let (bot, heard) = quietBot(fake)
        bot.send("Check the build")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.earlyReply("I'll check the build. <plugin>first</plugin>"))
        await eventually { bot.messages.last?.role == .bot }
        // The hook sent it back: it works on, and says what it found.
        agent.emit(.trace(.toolUse(id: "t1", tool: "Bash", title: "Run swift build", detail: "swift build", parent: nil)))
        agent.emit(.trace(.toolResult(id: "t1", output: "ok", failed: false, parent: nil)))
        agent.emit(.trace(.text("The build passes.", parent: nil)))
        agent.emit(.earlyReply("The build passes."))
        await eventually { bot.messages.count == 3 }
        #expect(bot.isWorking)
        agent.reply("The build passes.")
        await eventually { !bot.isWorking }

        #expect(bot.messages.map(\.text) == ["Check the build", "I'll check the build.", "The build passes."])
        #expect(bot.messages[2].steps?.map(\.title) == ["Run swift build"])
        #expect(heard.replies.map(\.text) == ["The build passes."])
        #expect(heard.requests == [.plugin(request: "first")])
        #expect(bot.unreadCount == 2)
    }

    @Test func aResultThatDiffersStillShows() async throws {
        let fake = FakeLauncher()
        let (bot, heard) = quietBot(fake)
        bot.send("hi")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.earlyReply("Working on it"))
        await eventually { bot.messages.count == 2 }
        // Gone on without its message's end being seen: the result is the reply.
        agent.reply("All done")
        await eventually { !bot.isWorking }
        #expect(bot.messages.map(\.text) == ["hi", "Working on it", "All done"])
        #expect(heard.replies.map(\.text) == ["All done"])
    }

    @Test func whatYouWriteWhileTheTurnEndsWaitsForIt() async throws {
        let fake = FakeLauncher()
        let (bot, _) = quietBot(fake)
        bot.send("first")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.emit(.earlyReply("Answer one"))
        await eventually { bot.messages.count == 2 }

        // Not merged with "first", no interrupt: it waits for the turn to end.
        bot.send("second")
        try await Task.sleep(for: .milliseconds(100))
        #expect(agent.sent.count == 1)
        #expect(agent.interrupts == 0)

        agent.reply("Answer one")
        await eventually { agent.sent.count == 2 }
        #expect(agent.sent.last == "second")
        #expect(agent.interrupts == 0)
        #expect(bot.isWorking)
        agent.reply("Answer two")
        await eventually { !bot.isWorking }
        #expect(bot.messages.map(\.text) == ["first", "Answer one", "second", "Answer two"])
    }

    @Test func aTurnNobodySeesShowsNothingEarly() async throws {
        let fake = FakeLauncher()
        let (bot, _) = quietBot(fake)
        bot.send("hi")
        await eventually { fake.agents.count == 1 }
        let agent = fake.agents[0]
        agent.reply("hello")
        await eventually { !bot.isWorking }
        // A plugin that changes replies: the reply waits for the result to go through it.
        bot.replyFilter = { { text in text.uppercased() } }
        bot.send("again")
        await eventually { bot.isWorking }
        agent.emit(.earlyReply("hello again"))
        try await Task.sleep(for: .milliseconds(100))
        #expect(bot.messages.count == 3)
        agent.reply("hello again")
        await eventually { bot.messages.count == 4 }
        #expect(bot.messages.last?.text == "HELLO AGAIN")
    }
}
