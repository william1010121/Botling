import Foundation

/// Small git questions about a folder (/share, the developer tools).
public enum GitDiff {
    /// The short hash of `revision`; nil when there is none (no commits yet).
    public static func shortHash(_ revision: String, folder: URL) -> String? {
        git(["rev-parse", "--short", "--verify", "--quiet", revision], in: folder)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The branch HEAD is on; nil when detached or no repository.
    public static func currentBranch(folder: URL) -> String? {
        git(["rev-parse", "--abbrev-ref", "HEAD"], in: folder)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty || $0 == "HEAD" ? nil : $0 }
    }

    /// The repository's default branch: what `origin/HEAD` points at, else `init.defaultBranch`,
    /// else the first of `main` and `master` that exists. Nil outside a repository or when none
    /// of these is there.
    public static func defaultBranch(folder: URL) -> String? {
        if let head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], in: folder)?.trimmingCharacters(in: .whitespacesAndNewlines),
           let slash = head.firstIndex(of: "/") {
            let name = String(head[head.index(after: slash)...])
            if !name.isEmpty, exists(name, in: folder) { return name }
        }
        let configured = git(["config", "--get", "init.defaultBranch"], in: folder)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return ([configured].compactMap { $0 } + conventionalDefaults).first { !$0.isEmpty && exists($0, in: folder) }
    }

    /// The names a default branch usually has, for a repository that says nothing of its own.
    static let conventionalDefaults = ["main", "master"]

    private static func exists(_ branch: String, in folder: URL) -> Bool {
        git(["rev-parse", "--verify", "--quiet", "refs/heads/\(branch)"], in: folder) != nil
    }

    /// The top of the git repository holding `folder`; nil outside one.
    public static func repositoryRoot(_ folder: URL) -> URL? {
        git(["rev-parse", "--show-toplevel"], in: folder)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : URL(filePath: $0, directoryHint: .isDirectory) }
    }

    /// Runs git in `folder`; its output, or nil when it failed.
    static func git(_ arguments: [String], in folder: URL) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", folder.path] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}
