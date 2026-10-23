import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A subagent's view (read only): what its bot sent it, from the bot with the time it was sent,
/// and a header naming its engine and model.
@MainActor
struct SubagentViewTests {
    func replay(_ lines: [String], into book: inout TraceBook, at date: Date) {
        for line in lines {
            for case let .trace(event) in StreamEvent.events(in: line) { book.apply(event, at: date) }
        }
    }

    func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }

    /// Its task and each message sent it later are from its bot, each with when it was sent.
    @Test func theTaskAndEachMessageAreFromTheBotWithTheirTime() {
        var book = TraceBook()
        let start = Date(timeIntervalSince1970: 1_000)
        let later = start.addingTimeInterval(3 * 3600)
        replay(ResumeRun.firstRun, into: &book, at: start)
        replay([ResumeRun.send(to: "echoer"), ResumeRun.resumedStarted, ResumeRun.resumed, ResumeRun.echoTwo, ResumeRun.echoTwoDone, ResumeRun.saysBye, ResumeRun.secondDone], into: &book, at: later)
        let subagent = try! #require(book.subagent("toolu_A"))
        #expect(subagent.steps.first { $0.kind == .message }?.at == later)
        let bot = makeBot(FakeLauncher())
        let payload = ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "")
        let sent = payload.messages.filter { $0.role == "user" }
        #expect(sent.map(\.text) == ["Run echo one, then reply HI", "Now run echo two, then reply BYE"])
        #expect(sent.map(\.speaker) == [bot.name, bot.name])
        #expect(sent.map(\.time) == [time(start), time(later)])
        // The subagent's own lines carry no time.
        #expect(payload.messages.filter { $0.role == "bot" }.allSatisfy { $0.time == nil })
    }

    /// The header says it is a Claude subagent, on the model its Agent call asked for.
    @Test func theHeaderNamesTheEngineAndTheModelTheCallAskedFor() {
        var book = TraceBook()
        let agent = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_M","name":"Agent","input":{"description":"Quick look","prompt":"Look","model":"haiku"}}]}}"#
        replay([agent], into: &book, at: Date())
        let subagent = try! #require(book.subagent("toolu_M"))
        #expect(subagent.model == "haiku")
        let payload = ChatPayload.make(subagent: subagent, of: makeBot(FakeLauncher()), components: nil, avatar: "")
        #expect(payload.subagent?.engine == "claude")
        #expect(payload.subagent?.model == "Haiku")
    }

    /// Without a model in its call, the bot's subagent model is its model; with neither
    /// ("same model"), the model the bot itself runs on.
    @Test func withoutOneTheHeaderNamesTheBotsSubagentModelOrItsOwn() async {
        var book = TraceBook()
        replay([ResumeRun.agent], into: &book, at: Date())
        let subagent = try! #require(book.subagent("toolu_A"))
        let bot = makeBot(FakeLauncher())
        #expect(ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "").subagent?.model == bot.model.displayName)
        await bot.setSubagentModel(.haiku)
        #expect(ChatPayload.make(subagent: subagent, of: bot, components: nil, avatar: "").subagent?.model == "Haiku")
    }

    /// Once it ended, a call whose result never came no longer shows as under way.
    @Test func anEndedSubagentsUnfinishedCallIsNotUnderWay() {
        var subagent = Subagent(id: "toolu_X", description: "Test", prompt: "Go", status: .stopped)
        subagent.steps = [Step(id: "s", kind: .tool, tool: "Bash", title: "Run swift test")]
        let payload = ChatPayload.make(subagent: subagent, of: makeBot(FakeLauncher()), components: nil, avatar: "")
        #expect(payload.messages.flatMap { $0.steps ?? [] }.map(\.done) == [true])
        subagent.status = .running
        #expect(ChatPayload.make(subagent: subagent, of: makeBot(FakeLauncher()), components: nil, avatar: "").live.map(\.done) == [false])
    }

    /// Subagents saved before steps had a time, and before they had a model, still load.
    @Test func olderSavedSubagentsStillLoad() throws {
        let json = #"{"id":"toolu_A","description":"Echo","prompt":"Go","status":"completed","background":false,"startedAt":0,"steps":[{"id":"s","kind":"message","title":"Hi","failed":false,"done":true}]}"#
        let subagent = try JSONDecoder().decode(Subagent.self, from: Data(json.utf8))
        #expect(subagent.model == nil)
        #expect(subagent.steps.first?.at == nil)
    }
}
