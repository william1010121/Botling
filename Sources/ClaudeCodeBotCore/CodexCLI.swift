import Foundation

/// Finding the `codex` CLI on this Mac. Nothing in the app runs Codex now; Settings → Doctor
/// checks it, and these stay for a later Codex bot engine.
public enum CodexCLI {
    /// A GUI app's PATH is short; the usual install places come first.
    static func environment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["\(home)/.local/bin", "\(home)/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let existing = environment["PATH"].map { $0.split(separator: ":").map(String.init) } ?? []
        environment["PATH"] = (extra + existing.filter { !extra.contains($0) }).joined(separator: ":")
        return environment
    }

    /// The newest install, looked for once it is first needed (and again while none is found).
    static let found = Found()

    public static func locateNewest() -> URL? { found.get() }

    final class Found: @unchecked Sendable {
        private let lock = NSLock()
        private var url: URL?

        func get() -> URL? {
            lock.withLock {
                if url == nil { url = CodexCLI.newestExecutable() }
                return url
            }
        }
    }

    /// Several installs can sit side by side (a standalone one, npm's); the newest version is
    /// used, since an old one may not read the user's config.
    public static func newestExecutable() -> URL? {
        let locator = ClaudeExecutableLocator(command: "codex")
        var paths = locator.installed().map(\.path)
        if let shell = ClaudeExecutableLocator.askLoginShell(for: "codex") { paths.append(shell) }
        var seen = Set<String>()
        let found = paths.filter { FileManager.default.isExecutableFile(atPath: $0) && seen.insert(URL(filePath: $0).resolvingSymlinksInPath().path).inserted }
        let versioned = found.map { ($0, version(of: $0)) }
        return versioned.max { newer($1.1, than: $0.1) }.map { URL(filePath: $0.0) }
    }

    /// "codex-cli 0.163.0" → [0, 163, 0].
    static func version(of path: String) -> [Int] {
        let process = Process()
        process.executableURL = URL(filePath: path)
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return [] }
        process.waitUntilExit()
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return parseVersion(text)
    }

    static func parseVersion(_ text: String) -> [Int] {
        guard let range = text.range(of: #"\d+(\.\d+)+"#, options: .regularExpression) else { return [] }
        return text[range].split(separator: ".").compactMap { Int($0) }
    }

    /// True when `a` is a later version than `b`.
    static func newer(_ a: [Int], than b: [Int]) -> Bool {
        for index in 0..<max(a.count, b.count) {
            let x = a[safe: index] ?? 0, y = b[safe: index] ?? 0
            if x != y { return x > y }
        }
        return false
    }
}

/// Lets a timeout or a cancel stop a process from another thread: terminate, then SIGKILL if it
/// is still running 3 seconds later. Kept for the coming Codex engine.
final class ProcessBox: @unchecked Sendable {
    private let process: Process
    init(_ process: Process) { self.process = process }

    func stop() {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [process] in
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}
