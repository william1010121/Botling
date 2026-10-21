import Foundation

/// Finds the `claude` CLI (or another command, such as `node`, `git`, `gh`, `codex`). A GUI app's
/// PATH is minimal, so well-known install locations (`searchFolders`, the one list every lookup
/// uses) are checked directly before falling back to the user's login shell. Copied from NotchDo.
public struct ClaudeExecutableLocator: Sendable {
    public var command: String
    public var homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    var isExecutable: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    var loginShellLookup: @Sendable () -> String?

    public init(command: String = "claude") {
        self.command = command
        loginShellLookup = { ClaudeExecutableLocator.askLoginShell(for: command) }
    }

    /// Where command-line tools are installed on a Mac, most personal first: the user's own bin
    /// folders (Claude Code's and other standalone installers, npm's global prefix, bun), Homebrew
    /// on Apple silicon and on Intel, then Nix (per user, then system-wide).
    public static func searchFolders(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [String] {
        [".local/bin", ".npm-global/bin", ".bun/bin"].map { home.appending(path: $0).path }
            + ["/opt/homebrew/bin", "/usr/local/bin", "/etc/profiles/per-user/\(NSUserName())/bin", "/run/current-system/sw/bin"]
    }

    var candidatePaths: [String] {
        Self.searchFolders(home: homeDirectory).map { "\($0)/\(command)" }
    }

    /// Every install of the command in `searchFolders` (several can sit side by side).
    public func installed() -> [URL] {
        candidatePaths.filter(isExecutable).map { URL(filePath: $0) }
    }

    public func locate() -> URL? {
        if let found = installed().first { return found }
        if let path = loginShellLookup(), isExecutable(path) {
            return URL(filePath: path)
        }
        return nil
    }

    /// The user's login shell (what Terminal starts), so the lookup sees the PATH their own shell
    /// sets up; zsh, macOS's default, when it cannot be read.
    static var loginShell: String {
        if let entry = getpwuid(getuid()), let shell = entry.pointee.pw_shell, case let path = String(cString: shell),
           FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        if let shell = ProcessInfo.processInfo.environment["SHELL"], FileManager.default.isExecutableFile(atPath: shell) { return shell }
        return "/bin/zsh"
    }

    static func askLoginShell(for command: String) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: loginShell)
        process.arguments = ["-lc", "command -v \(command)"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try ChildEnvironment.run(process)
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
