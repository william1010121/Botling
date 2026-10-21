import Foundation

/// Where tests find the repository and the app they run: the one place that spells these.
enum TestPaths {
    /// The repository's root (this file is in Tests/ClaudeCodeBotCoreTests).
    static let repo = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// The app binary live tests run (`swift build` first): `CCB_TEST_APP` when set (a release
    /// build, a custom scratch path), else the debug build under `.build`.
    static var app: URL {
        if let path = ProcessInfo.processInfo.environment["CCB_TEST_APP"], !path.isEmpty {
            return URL(filePath: (path as NSString).expandingTildeInPath)
        }
        return repo.appending(path: ".build/debug/ClaudeCodeBot")
    }

    /// The built-in plugins the app ships.
    static var builtInPlugins: URL { repo.appending(path: "Sources/ClaudeCodeBot/Resources/plugins") }
}
