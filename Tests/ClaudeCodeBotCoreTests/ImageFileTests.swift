import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ImageFileTests {
    @Test func opensOnlyPictureFilesThatExist() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let picture = folder.appendingPathComponent("shot.PNG")
        let script = folder.appendingPathComponent("run.command")
        try Data([0]).write(to: picture)
        try Data([0]).write(to: script)
        #expect(ImageFile.isOpenable(picture))
        #expect(!ImageFile.isOpenable(script))
        #expect(!ImageFile.isOpenable(folder.appendingPathComponent("missing.png")))
        #expect(!ImageFile.isOpenable(URL(string: "https://example.com/a.png")!))
    }
}
