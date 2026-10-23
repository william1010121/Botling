import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct CoreResourcesTests {
    @Test(arguments: ["botling_ClaudeCodeBotCore.bundle", "ClaudeCodeBot_ClaudeCodeBotCore.bundle"])
    func relocatedAppLoadsAvatarsWithoutEvaluatingBuildFallback(bundleName: String) throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appending(path: "ccb-resource-test-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let original = root.appending(path: "build/ClaudeCodeBot.app")
        let resources = original.appending(path: "Contents/Resources")
        try fm.createDirectory(at: resources, withIntermediateDirectories: true)
        try fm.copyItem(at: CoreResources.bundle.bundleURL,
                        to: resources.appending(path: bundleName))
        let relocated = root.appending(path: "Relocated.app")
        try fm.moveItem(at: original, to: relocated)
        try fm.removeItem(at: root.appending(path: "build"))
        #expect(!fm.fileExists(atPath: original.path))

        let bundle = CoreResources.resolve(resourcesURL: relocated.appending(path: "Contents/Resources")) {
            fatalError("A relocated app must not evaluate the unavailable build fallback")
        }
        #expect(bundle.bundleURL.path.hasPrefix(relocated.path))
        for character in ["claude", "gpt"] {
            for mood in ["idle", "working", "thinking", "sleepy"] {
                let url = try #require(bundle.url(forResource: mood, withExtension: "png",
                    subdirectory: "CharacterArt/avatars-static/\(character)"))
                let data = try Data(contentsOf: url)
                #expect(data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]))
            }
        }
    }

    @Test func developmentRunUsesSwiftPMFallback() {
        let bundle = CoreResources.resolve(resourcesURL: nil) { CoreResources.bundle }
        #expect(bundle === CoreResources.bundle)
    }

    @Test func missingPackagedBundleUsesFallback() {
        let absent = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        var usedFallback = false
        let bundle = CoreResources.resolve(resourcesURL: absent) {
            usedFallback = true
            return CoreResources.bundle
        }
        #expect(usedFallback)
        #expect(bundle === CoreResources.bundle)
    }
}
