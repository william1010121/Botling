import Foundation
import Testing
@testable import DeckCore

struct ParsingTests {
    @Test func resultLineBecomesAReply() {
        let line = #"{"type":"result","subtype":"success","is_error":false,"result":"好。","num_turns":1}"#
        #expect(StreamEvent.reply(in: line) == .reply("好。", isError: false))
    }

    @Test func otherLinesAreIgnored() {
        #expect(StreamEvent.reply(in: #"{"type":"system","subtype":"init"}"#) == nil)
        #expect(StreamEvent.reply(in: "not json") == nil)
    }

    @Test func markdownLinksBecomeChips() {
        let segments = RichText.segments(in: "做好了 [作品集](https://example.com/a) 你看看")
        #expect(segments == [
            .text("做好了 "),
            .chip(Chip(label: "作品集", url: URL(string: "https://example.com/a")!)),
            .text(" 你看看")
        ])
    }

    @Test func textWithoutLinksIsOneSegment() {
        #expect(RichText.segments(in: "早安。") == [.text("早安。")])
    }

    @Test func launchArgumentsKeepStdinOpenForStreaming() {
        let launch = AgentLaunch(
            model: .opus,
            sessionID: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            workingDirectory: URL(filePath: "/tmp"),
            systemPrompt: "sys"
        )
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        #expect(arguments.contains("--input-format"))
        #expect(arguments.contains("00000000-0000-0000-0000-000000000001"))
        #expect(arguments.firstIndex(of: "--model").map { arguments[$0 + 1] } == "opus")
    }

    @Test func okRepliesCountAsSilent() {
        #expect(BotPrompts.isPlainOK("OK"))
        #expect(BotPrompts.isPlainOK(" ok。\n"))
        #expect(!BotPrompts.isPlainOK("接著做錯誤狀態。"))
    }
}
