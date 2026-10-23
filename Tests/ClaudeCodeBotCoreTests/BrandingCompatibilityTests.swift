import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct BrandingCompatibilityTests {
    @Test(arguments: ["ClaudeCodeBot", "botling"])
    func buildInfoReadsOldAndRenamedExecutables(executable: String) throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "botling-brand-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appending(path: "\(executable).app")
        let binary = app.appending(path: "Contents/MacOS/\(executable)")
        try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        let info = ["CFBundleIdentifier": "io.github.william1010121.ClaudeCodeBot",
                    "CFBundleExecutable": executable, "CFBundleShortVersionString": "1.0.0",
                    "CCBGitCommit": "abcdef123", "CCBGitDirty": "1"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: app.appending(path: "Contents/Info.plist"))
        let build = try #require(BuildInfo.read(app))
        #expect(build.bundleID == "io.github.william1010121.ClaudeCodeBot")
        #expect(build.version == "1.0.0")
        #expect(build.commit == "abcdef123")
        #expect(build.dirty)
        #expect(build.path == app.standardizedFileURL.path)
        let roundTrip = try JSONDecoder().decode(BuildInfo.self, from: JSONEncoder().encode(build))
        #expect(roundTrip == build)
    }
}
