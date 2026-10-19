import Foundation

/// The plugin library (`~/.claudecodebot/plugins`) is a git repo, so every change Maintainer makes can be
/// undone. ClaudeCodeBot's own commits (the first one, 退回, 移除) are signed 「ClaudeCodeBot」.
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
        for path in ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/etc/profiles/per-user/\(NSUserName())/bin/git", "/run/current-system/sw/bin/git"]
        where FileManager.default.isExecutableFile(atPath: path) {
            return URL(filePath: path)
        }
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
        guard let git else { return (false, "找不到 git。") }
        let process = Process()
        process.executableURL = git
        process.arguments = ["-c", "user.name=ClaudeCodeBot", "-c", "user.email=ccb@localhost", "-c", "commit.gpgsign=false"] + arguments
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
        run(["commit", "-q", "-m", "ClaudeCodeBot 插件庫"])
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
        guard isAvailable else { return "找不到 git，不能退回。" }
        if isDirty(path) {
            run(["add", "-A", "--", path])
            run(["commit", "-q", "-m", "\(label)：未提交的修改（退回前自動存）", "--", path])
        }
        let history = commits(path)
        guard let last = history.first else { return "「\(label)」還沒有任何版本紀錄。" }
        guard history.count >= 2 || run(["rev-parse", "--verify", "-q", "\(last)^"]).ok else {
            return "「\(label)」沒有上一版。"
        }
        if run(["cat-file", "-e", "\(last)^:\(path)"]).ok {
            run(["rm", "-r", "-q", "--cached", "--", path])
            try? FileManager.default.removeItem(at: folder.appending(path: path))
            guard run(["checkout", "\(last)^", "--", path]).ok else { return "取回上一版失敗。" }
        } else {
            // It did not exist before that change.
            guard run(["rm", "-r", "-q", "--", path]).ok else { return "取回上一版失敗。" }
        }
        run(["add", "-A", "--", path])
        let commit = run(["commit", "-q", "-m", "退回 \(label) 到上一版", "--", path])
        return commit.ok ? nil : commit.output
    }

    /// Takes a plugin out of the library, as a commit (git history keeps it).
    public func remove(_ path: String, label: String) -> String? {
        guard isAvailable else { return "找不到 git，不能移除。" }
        if isDirty(path) {
            run(["add", "-A", "--", path])
            run(["commit", "-q", "-m", "\(label)：未提交的修改（移除前自動存）", "--", path])
        }
        guard run(["rm", "-r", "-q", "--", path]).ok else { return "移除失敗。" }
        try? FileManager.default.removeItem(at: folder.appending(path: path))
        let commit = run(["commit", "-q", "-m", "移除 \(label)"])
        return commit.ok ? nil : commit.output
    }
}
