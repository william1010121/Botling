import CoreGraphics
import CryptoKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A tool call that gives back a picture (a Read of a .png, a screenshot) shows it in its OUT box,
/// not as words. The picture is kept as a file beside the chat, never as base64 in it.
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
            .trace(.toolResult(id: "toolu_P", output: "", failed: false, parent: nil)),
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
        book.apply(.toolResult(id: "R", output: "", failed: false, parent: "A"))
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

        let saved = Step(id: "1", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "", done: true, images: [kept.path])
        #expect(ChatPayload.stepView(saved, in: bot).images == [.init(url: kept.absoluteString, name: "login.png")])

        // Its kept picture pruned: a Read that gave back only a picture shows the file it read.
        let old = Step(id: "2", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "", done: true)
        #expect(ChatPayload.stepView(old, in: bot).images == [.init(url: read.absoluteString, name: "login.png")])

        // A kept picture that is gone falls back the same way; a gone file shows nothing.
        let gone = Step(id: "3", kind: .tool, tool: "Read", title: "Read login.png", detail: read.path, output: "", done: true, images: [root.appending(path: "gone.png").path])
        #expect(ChatPayload.stepView(gone, in: bot).images == [.init(url: read.absoluteString, name: "login.png")])
        let nothing = Step(id: "4", kind: .tool, tool: "Read", title: "Read x.png", detail: root.appending(path: "x.png").path, output: "", done: true)
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

    // MARK: Smaller pictures

    /// A `width`×`height` PNG of noise (big as PNG, like a busy screenshot); `seeThrough` makes
    /// its top rows half transparent.
    static func noisePNG(width: Int = 1000, height: Int = 900, seeThrough: Bool = false) throws -> Data {
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        var seed: UInt32 = 2_463_534_242
        for index in pixels.indices where index % 4 != 3 {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
            pixels[index] = UInt8(truncatingIfNeeded: seed) & 0xF0
        }
        if seeThrough { for index in stride(from: 3, to: width * 4 * 20, by: 4) { pixels[index] = 128 } }
        let info = seeThrough ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
        let image = try #require(pixels.withUnsafeMutableBytes { buffer in
            CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info.rawValue)?.makeImage()
        })
        return try #require(StepImages.encode(image, as: .png))
    }

    @Test func aBigScreenshotIsKeptAsJPEGWithASmallCopyForTheChat() throws {
        let png = try Self.noisePNG()
        let path = try #require(StepImages.save([ToolImage(mediaType: "image/png", data: png)], in: root).first)
        #expect(path.hasSuffix(".jpg"))
        let kept = try #require(FileManager.default.contents(atPath: path))
        #expect(kept.count < png.count * 9 / 10)
        #expect(kept.starts(with: [0xFF, 0xD8, 0xFF]))
        let thumb = try #require(StepImages.thumb(for: URL(filePath: path)))
        #expect(thumb.path.hasPrefix(root.appending(path: "thumbs").path))
        #expect(thumb.pathExtension == "jpg")
        #expect(try Data(contentsOf: thumb).count < kept.count / 2)

        // The same picture again is the same file, not converted twice.
        #expect(StepImages.save([ToolImage(mediaType: "image/png", data: png)], in: root) == [path])

        // The page shows the small copy and opens the full one.
        let bot = Bot(profile: .main(home: root.appending(path: "home")), launcher: FakeLauncher().launcher)
        let step = Step(id: "1", kind: .tool, tool: "Bash", title: "screenshot", output: "", done: true, images: [path])
        #expect(ChatPayload.stepView(step, in: bot).images == [.init(url: URL(filePath: path).absoluteString, name: URL(filePath: path).lastPathComponent, thumb: thumb.absoluteString)])
    }

    @Test func aSeeThroughPictureStaysPNGAndSmallOnesStayAsTheyAre() throws {
        let png = try Self.noisePNG(seeThrough: true)
        let path = try #require(StepImages.save([ToolImage(mediaType: "image/png", data: png)], in: root).first)
        #expect(path.hasSuffix(".png"))
        #expect(FileManager.default.contents(atPath: path) == png)
        #expect(StepImages.thumb(for: URL(filePath: path))?.pathExtension == "png")

        // A small picture: as it came, no small copy.
        let small = try Self.noisePNG(width: 200, height: 150)
        let smallPath = try #require(StepImages.save([ToolImage(mediaType: "image/png", data: small)], in: root).first)
        #expect(FileManager.default.contents(atPath: smallPath) == small)
        #expect(StepImages.thumb(for: URL(filePath: smallPath)) == nil)
    }

    @Test func picturesKeptBeforeAreMadeSmallerOnceAndTheirStepsStillFindThem() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let png = try Self.noisePNG()
        let hash = SHA256.hash(data: png).prefix(16).map { String(format: "%02x", $0) }.joined()
        let old = root.appending(path: "\(hash).png")
        try png.write(to: old)
        let small = root.appending(path: "small.png")
        try Data(base64Encoded: Self.pixel)!.write(to: small)

        let done = try #require(StepImages.compressExisting(in: root))
        #expect(done.converted == 1)
        #expect(done.thumbs == 1)
        #expect(done.before == png.count + Data(base64Encoded: Self.pixel)!.count)
        #expect(done.after < done.before * 9 / 10)
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.contents(atPath: small.path) == Data(base64Encoded: Self.pixel))
        // Once per folder.
        #expect(StepImages.compressExisting(in: root) == nil)

        // A step that names the PNG shows the JPEG that replaced it, with its small copy.
        let jpeg = old.deletingPathExtension().appendingPathExtension("jpg")
        let bot = Bot(profile: .main(home: root.appending(path: "home")), launcher: FakeLauncher().launcher)
        let step = Step(id: "1", kind: .tool, tool: "Bash", title: "screenshot", output: "", done: true, images: [old.path])
        let shown = try #require(ChatPayload.stepView(step, in: bot).images?.first)
        #expect(shown.url == jpeg.absoluteString)
        #expect(shown.thumb == StepImages.thumb(for: jpeg)?.absoluteString)
        #expect(shown.thumb != nil)
        // Saving that picture again finds the JPEG.
        #expect(StepImages.save([ToolImage(mediaType: "image/png", data: png)], in: root) == [jpeg.path])
    }

    @Test func pruningTakesASmallCopyWithItsPicture() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let png = try Self.noisePNG()
        let path = try #require(StepImages.save([ToolImage(mediaType: "image/png", data: png)], in: root).first)
        let thumb = try #require(StepImages.thumb(for: URL(filePath: path)))
        try FileManager.default.setAttributes([.modificationDate: Date.distantPast], ofItemAtPath: path)
        for index in 0..<StepImages.kept { try Data([UInt8(index % 256)]).write(to: root.appending(path: "f\(index).gif")) }
        StepImages.prune(root, keeping: [])
        #expect(!FileManager.default.fileExists(atPath: path))
        #expect(!FileManager.default.fileExists(atPath: thumb.path))
        // The thumbs folder itself does not count as a picture.
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasSuffix(".gif") }.count == StepImages.kept)
    }
}
