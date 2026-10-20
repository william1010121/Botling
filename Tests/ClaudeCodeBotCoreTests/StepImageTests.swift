import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A tool call that gives back a picture (a Read of a .png, a screenshot) shows it in its OUT box,
/// not just "(image)". The picture is kept as a file beside the chat, never as base64 in it.
@MainActor
struct StepImageTests {
    /// A 1×1 PNG.
    static let pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    static let readUse = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_P","name":"Read","input":{"file_path":"/Users/me/app/login.png"}}]}}"#
    static let readResult = #"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"tool_use_id":"toolu_P","type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"\#(pixel)"}}]}]}}"#

    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-step-image-\(UUID().uuidString)")

    @Test func aToolResultWithAPictureCarriesIt() throws {
        let events = StreamEvent.events(in: Self.readResult)
        let data = try #require(Data(base64Encoded: Self.pixel))
        #expect(events == [
            .trace(.toolResult(id: "toolu_P", output: "(image)", failed: false, parent: nil)),
            .trace(.toolImages(id: "toolu_P", images: [ToolImage(mediaType: "image/png", data: data)], parent: nil)),
        ])
        // Text only: no pictures event.
        #expect(StreamEvent.events(in: SubagentRun.readResult).count == 1)
    }

    @Test func theStepKeepsAFileNotTheBase64() throws {
        var book = TraceBook()
        book.imageFolder = root
        for event in StreamEvent.events(in: Self.readUse) + StreamEvent.events(in: Self.readResult) {
            guard case let .trace(step) = event else { continue }
            book.apply(step)
        }
        let step = try #require(book.steps.first)
        let path = try #require(step.images?.first)
        #expect(step.images?.count == 1)
        #expect(path.hasPrefix(root.path))
        #expect(path.hasSuffix(".png"))
        #expect(FileManager.default.contents(atPath: path) == Data(base64Encoded: Self.pixel))
        // What is saved with the chat names the file; the picture itself is not in it.
        let saved = String(decoding: try JSONEncoder().encode(step), as: UTF8.self)
        #expect(!saved.contains(Self.pixel.prefix(40)))

        // The same picture again is the same file.
        var again = TraceBook()
        again.imageFolder = root
        again.apply(.toolUse(id: "2", tool: "Read", title: "Read login.png", detail: "/x/login.png", parent: nil))
        again.apply(.toolImages(id: "2", images: [ToolImage(mediaType: "image/png", data: Data(base64Encoded: Self.pixel)!)], parent: nil))
        #expect(again.steps.first?.images == [path])
    }

    @Test func aSubagentsStepShowsItsPictureToo() throws {
        var book = TraceBook()
        book.imageFolder = root
        book.apply(.toolUse(id: "A", tool: "Agent", title: "Delegate Look", detail: "Look", parent: nil))
        book.apply(.toolUse(id: "R", tool: "Read", title: "Read a.png", detail: "/a.png", parent: "A"))
        book.apply(.toolResult(id: "R", output: "(image)", failed: false, parent: "A"))
        book.apply(.toolImages(id: "R", images: [ToolImage(mediaType: "image/jpeg", data: Data([0xFF, 0xD8, 0xFF]))], parent: "A"))
        let path = try #require(book.subagent("A")?.steps.last?.images?.first)
        #expect(path.hasSuffix(".jpg"))
    }

    @Test func thePageGetsFileURLsAndOldReadsFallBackToTheirFile() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let kept = root.appending(path: "kept.png")
        let read = root.appending(path: "login.png")
        try Data(base64Encoded: Self.pixel)!.write(to: kept)
        try Data(base64Encoded: Self.pixel)!.write(to: read)
        let bot = Bot(profile: .main(home: root.appending(path: "home")), launcher: FakeLauncher().launcher)

        let saved = Step(id: "1", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "(image)", done: true, images: [kept.path])
        #expect(ChatPayload.stepView(saved, in: bot).images == [.init(url: kept.absoluteString, name: "login.png")])

        // Saved before pictures were kept: a Read that gave back a picture shows the file it read.
        let old = Step(id: "2", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "(image)", done: true)
        #expect(ChatPayload.stepView(old, in: bot).images == [.init(url: read.absoluteString, name: "login.png")])

        // A kept picture that is gone falls back the same way; a gone file shows nothing.
        let gone = Step(id: "3", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "(image)", done: true, images: [root.appending(path: "gone.png").path])
        #expect(ChatPayload.stepView(gone, in: bot).images == [.init(url: read.absoluteString, name: "login.png")])
        let nothing = Step(id: "4", kind: .tool, tool: "Read", title: "Read x.png", detail: root.appending(path: "x.png").path, output: "(image)", done: true)
        #expect(ChatPayload.stepView(nothing, in: bot).images == nil)
        // A text Read of a picture file (an .svg's source) is text, not a picture.
        let text = Step(id: "5", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "1\t<svg>", done: true)
        #expect(ChatPayload.stepView(text, in: bot).images == nil)
    }

    @Test func oldStepsWithoutPicturesStillLoad() throws {
        let json = #"{"id":"1","kind":"tool","tool":"Read","title":"Read a","detail":"/a","output":"(image)","failed":false,"done":true}"#
        let step = try JSONDecoder().decode(Step.self, from: Data(json.utf8))
        #expect(step.images == nil)
    }
}
