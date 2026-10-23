import Foundation

/// The plugin library (`~/.claudecodebot/plugins`) is a git repo, so every change Maintainer makes can be
/// undone. Botling's own commits (the first one, reverts, removals) are signed "Botling".
public struct PluginLibraryGit: Sendable {
    public let folder: URL
    let git: URL?

    public init(folder: URL, git: URL? = PluginLibraryGit.locate()) {
        self.folder = folder
        self.git = git
    }

    /// git from the usual places; /usr/bin/git only when the developer tools are installed
    /// (otherwise it would pop up an installer).
    public static func locate() -> URL? {
        // Not the login shell: it may answer /usr/bin/git, which pops up the installer.
        if let found = ClaudeExecutableLocator(command: "git").installed().first { return found }
        let tools = Process()
        tools.executableURL = URL(filePath: "/usr/bin/xcode-select")
        tools.arguments = ["-p"]
        tools.standardOutput = FileHandle.nullDevice
        tools.standardError = FileHandle.nullDevice
        guard (try? tools.run()) != nil else { return nil }
        tools.waitUntilExit()
        return tools.terminationStatus == 0 ? URL(filePath: "/usr/bin/git") : nil
    }

    public var isAvailable: Bool { git != nil }

    @discardableResult
    func run(_ arguments: [String]) -> (ok: Bool, output: String) {
        guard let git else { return (false, "git not found.") }
        let process = Process()
        process.executableURL = git
        process.arguments = ["-c", "user.name=Botling", "-c", "user.email=ccb@localhost", "-c", "commit.gpgsign=false"] + arguments
        process.currentDirectoryURL = folder
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
        } catch {
            return (false, error.localizedDescription)
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus == 0, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Makes the library a repo with everything in it committed, the first time.
    public func prepare() {
        guard isAvailable, !FileManager.default.fileExists(atPath: folder.appending(path: ".git").path) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ignore = folder.appending(path: ".gitignore")
        if !FileManager.default.fileExists(atPath: ignore.path) {
            try? Data("node_modules/\n.DS_Store\n".utf8).write(to: ignore)
        }
        run(["init", "-q"])
        run(["add", "-A"])
        run(["commit", "-q", "-m", "Botling plugin library"])
    }

    /// Changes under `path` not committed yet.
    public func isDirty(_ path: String) -> Bool {
        !run(["status", "--porcelain", "--", path]).output.isEmpty
    }

    /// Commits touching `path`, newest first.
    public func commits(_ path: String) -> [String] {
        let result = run(["log", "--format=%H", "--", path])
        return result.ok ? result.output.split(whereSeparator: \.isNewline).map(String.init) : []
    }

    /// There is an earlier version of `path` to go back to.
    public func hasPrevious(_ path: String) -> Bool {
        let count = commits(path).count
        return count >= 2 || (count >= 1 && isDirty(path))
    }

    /// Puts `path` back the way it was before its last change, as a new commit. Changes not
    /// committed yet are committed first, so nothing is lost. nil when done, else why not.
    public func revert(_ path: String, label: String) -> String? {
        guard isAvailable else { return "git not found, so it can't be reverted." }
        if isDirty(path) {
            run(["add", "-A", "--", path])
            run(["commit", "-q", "-m", "\(label): uncommitted changes (saved automatically before reverting)", "--", path])
        }
        let history = commits(path)
        guard let last = history.first else { return "\"\(label)\" has no version history yet." }
        guard history.count >= 2 || run(["rev-parse", "--verify", "-q", "\(last)^"]).ok else {
            return "\"\(label)\" has no previous version."
        }
        if run(["cat-file", "-e", "\(last)^:\(path)"]).ok {
            run(["rm", "-r", "-q", "--cached", "--", path])
            try? FileManager.default.removeItem(at: folder.appending(path: path))
            guard run(["checkout", "\(last)^", "--", path]).ok else { return "Couldn't restore the previous version." }
        } else {
            // It did not exist before that change.
            guard run(["rm", "-r", "-q", "--", path]).ok else { return "Couldn't restore the previous version." }
        }
        run(["add", "-A", "--", path])
        let commit = run(["commit", "-q", "-m", "Revert \(label) to the previous version", "--", path])
        return commit.ok ? nil : commit.output
    }

    /// Takes a plugin out of the library, as a commit (git history keeps it).
    public func remove(_ path: String, label: String) -> String? {
        guard isAvailable else { return "git not found, so it can't be removed." }
        if isDirty(path) {
            run(["add", "-A", "--", path])
            run(["commit", "-q", "-m", "\(label): uncommitted changes (saved automatically before removing)", "--", path])
        }
        guard run(["rm", "-r", "-q", "--", path]).ok else { return "Couldn't remove it." }
        try? FileManager.default.removeItem(at: folder.appending(path: path))
        let commit = run(["commit", "-q", "-m", "Remove \(label)"])
        return commit.ok ? nil : commit.output
    }
}
