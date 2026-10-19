import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ParsingTests {
    @Test func resultLineBecomesAReply() {
        let line = #"{"type":"result","subtype":"success","is_error":false,"result":"Fine.","num_turns":1}"#
        #expect(StreamEvent.reply(in: line) == .reply("Fine.", isError: false))
    }

    @Test func otherLinesAreIgnored() {
        #expect(StreamEvent.reply(in: #"{"type":"system","subtype":"init"}"#) == nil)
        #expect(StreamEvent.reply(in: "not json") == nil)
    }

    @Test func markdownLinksBecomeChips() {
        let segments = RichText.segments(in: "Done: [Portfolio](https://example.com/a) take a look")
        #expect(segments == [
            .text("Done: "),
            .chip(Chip(label: "Portfolio", url: URL(string: "https://example.com/a")!)),
            .text(" take a look")
        ])
    }

    @Test func textWithoutLinksIsOneSegment() {
        #expect(RichText.segments(in: "Good morning.") == [.text("Good morning.")])
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
        #expect(!BotPrompts.isPlainOK("Moving on to the error states."))
    }
}

struct LegacyMemoryTests {
    @Test func memoryFilesWithTheOldHeadingsAreStillRead() {
        let text = "## 進行中\n- 右側面板\n## 等你決定的事\n- 封面圖\n"
        #expect(MemoryFile.items(in: text, section: "In progress") == ["右側面板"])
        #expect(MemoryFile.items(in: text, section: "Waiting on you") == ["封面圖"])
    }
}
