import Foundation

/// Finds the `claude` CLI. A GUI app's PATH is minimal, so well-known install locations are
/// checked directly before falling back to the user's login shell. Copied from NotchDo.
public struct ClaudeExecutableLocator: Sendable {
    public var homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    var isExecutable: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    var loginShellLookup: @Sendable () -> String? = ClaudeExecutableLocator.askLoginShell

    public init() {}

    var candidatePaths: [String] {
        [
            homeDirectory.appending(path: ".local/bin/claude").path,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
        ]
    }

    public func locate() -> URL? {
        for path in candidatePaths where isExecutable(path) {
            return URL(filePath: path)
        }
        if let path = loginShellLookup(), isExecutable(path) {
            return URL(filePath: path)
        }
        return nil
    }

    @Sendable
    static func askLoginShell() -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/zsh")
        process.arguments = ["-lc", "command -v claude"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let path = text.split(whereSeparator: \.isNewline).last.map(String.init)?
            .trimmingCharacters(in: .whitespaces)
        return process.terminationStatus == 0 ? path : nil
    }
}
