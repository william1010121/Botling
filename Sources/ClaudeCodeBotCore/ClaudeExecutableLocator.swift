import Foundation

/// Finds the `claude` CLI (or another command, such as `node`). A GUI app's PATH is minimal, so
/// well-known install locations are checked directly before falling back to the user's login
/// shell. Copied from NotchDo.
public struct ClaudeExecutableLocator: Sendable {
    public var command: String
    public var homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    var isExecutable: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    var loginShellLookup: @Sendable () -> String?

    public init(command: String = "claude") {
        self.command = command
        loginShellLookup = { ClaudeExecutableLocator.askLoginShell(for: command) }
    }

    var candidatePaths: [String] {
        [
            homeDirectory.appending(path: ".local/bin/\(command)").path,
            "/opt/homebrew/bin/\(command)",
            "/usr/local/bin/\(command)",
            "/etc/profiles/per-user/\(NSUserName())/bin/\(command)",
            "/run/current-system/sw/bin/\(command)"
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

    static func askLoginShell(for command: String) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/zsh")
        process.arguments = ["-lc", "command -v \(command)"]
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
