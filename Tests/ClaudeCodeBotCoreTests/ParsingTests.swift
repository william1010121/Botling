import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ParsingTests {
    @Test func resultLineBecomesAReply() {
        let line = #"{"type":"result","subtype":"success","is_error":false,"result":"Fine.","num_turns":1}"#
        #expect(StreamEvent.reply(in: line) == .reply("Fine.", isError: false))
    }

    @Test func aMessageSentWithAnIdReportsWhenItIsQueuedAndStarted() {
        let id = UUID()
        func line(_ state: String) -> String {
            #"{"type":"command_lifecycle","command_uuid":"\#(id.uuidString.lowercased())","state":"\#(state)","uuid":"c2e90e32-69da-4094-8555-5065a9f23e73"}"#
        }
        #expect(StreamEvent.events(in: line("queued")) == [.commandQueued(id)])
        #expect(StreamEvent.events(in: line("started")) == [.commandStarted(id)])
        #expect(StreamEvent.events(in: line("completed")).isEmpty)
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
        #expect(MemoryFile.items(in: text, section: .inProgress) == ["右側面板"])
        #expect(MemoryFile.items(in: text, section: .waitingOnYou) == ["封面圖"])
    }

    /// A bot that wrote the four headings in its own words: the sections are found by place.
    @Test func translatedHeadingsAreReadByPlace() {
        let text = "## 現況\n做錯誤狀態\n## 処理中\n- 錯誤狀態\n## 待確認\n- 封面圖\n## 決定\n- 2026-10-18 Astro\n"
        #expect(MemoryFile.items(in: text, section: .inProgress) == ["錯誤狀態"])
        #expect(MemoryFile.items(in: text, section: .waitingOnYou) == ["封面圖"])
    }

    /// The prompt names every section the app reads, in order.
    @Test func thePromptTeachesTheSectionsTheAppReads() {
        let system = BotPrompts(profile: .manager(name: "x", avatar: "square", folder: URL(filePath: "/p/x"))).system
        let places = MemorySection.allCases.compactMap { system.range(of: "## " + $0.heading)?.lowerBound }
        #expect(places.count == MemorySection.allCases.count)
        #expect(places == places.sorted())
    }
}
