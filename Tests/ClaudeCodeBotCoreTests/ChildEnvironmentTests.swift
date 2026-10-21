import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ChildEnvironmentTests {
    @Test func stripsReservedCredentialAfterAllOverrides() {
        let input = ["PATH": "/usr/bin", "CCB_TELEGRAM_TOKEN": "sentinel-not-a-token", "PLUGIN_SETTING": "kept"]
        #expect(ChildEnvironment.sanitized(input) == ["PATH": "/usr/bin", "PLUGIN_SETTING": "kept"])
        #expect(input["CCB_TELEGRAM_TOKEN"] == "sentinel-not-a-token")
    }

    @Test func actualChildDoesNotReceiveCredentialEvenWhenBridgeDisabled() throws {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/env")
        process.environment = ["CCB_TELEGRAM_TOKEN": "sentinel-not-a-token", "CCB_TELEGRAM_ENABLED": "0", "SAFE_VALUE": "retained"]
        let output = Pipe()
        process.standardOutput = output
        try ChildEnvironment.run(process)
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        #expect(!text.contains("CCB_TELEGRAM_TOKEN"))
        #expect(!text.contains("sentinel-not-a-token"))
        #expect(text.contains("SAFE_VALUE=retained"))
    }

    @Test func implicitEnvironmentIsMadeExplicit() throws {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/true")
        #expect(process.environment == nil)
        try ChildEnvironment.run(process)
        process.waitUntilExit()
        #expect(process.environment != nil)
        #expect(process.environment?["CCB_TELEGRAM_TOKEN"] == nil)
    }

    @Test func appProcessLaunchSitesUseLastMileSanitizer() throws {
        // A guard against adding another implicit Process.run site without reviewing secrets.
        let root = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let sources = root.appending(path: "Sources")
        let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        for case let file as URL in files where file.pathExtension == "swift" && file.lastPathComponent != "ChildEnvironment.swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            #expect(text.range(of: #"\b(process|tools)\.run\(\)"#, options: .regularExpression) == nil,
                    "Use ChildEnvironment.run at \(file.lastPathComponent)")
        }
    }
}
