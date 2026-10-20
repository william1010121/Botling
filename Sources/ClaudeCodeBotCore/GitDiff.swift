import Foundation

/// A unified diff, read so the review panel can show the lines around a finding.
public struct GitDiff: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public enum Kind: String, Sendable {
            case context, added, removed
        }

        public var kind: Kind
        /// Line numbers in the old and new file (nil where the line is not in that side).
        public var old: Int?
        public var new: Int?
        public var text: String
    }

    public struct Hunk: Equatable, Sendable {
        public var lines: [Line]
    }

    public struct File: Equatable, Sendable {
        /// The path in the new version (the old one for a deleted file).
        public var path: String
        public var hunks: [Hunk]

        public var added: Int { hunks.flatMap(\.lines).filter { $0.kind == .added }.count }
        public var removed: Int { hunks.flatMap(\.lines).filter { $0.kind == .removed }.count }

        /// The lines around `line` (new-file numbering), from the hunk holding it or the one
        /// nearest; the first hunk's start when there is no line.
        public func excerpt(around line: Int?, context: Int = 4) -> [Line] {
            let all = hunks.flatMap(\.lines)
            guard !all.isEmpty else { return [] }
            guard let line else { return Array(all.prefix(context * 2 + 1)) }
            let numbered = all.enumerated().compactMap { offset, entry in entry.new.map { (offset, $0) } }
            guard let nearest = numbered.min(by: { abs($0.1 - line) < abs($1.1 - line) }) else { return Array(all.prefix(context * 2 + 1)) }
            let start = max(0, nearest.0 - context), end = min(all.count, nearest.0 + context + 1)
            return Array(all[start..<end])
        }
    }

    public var files: [File]

    public func file(_ path: String) -> File? {
        files.first { $0.path == path } ?? files.first { $0.path.hasSuffix("/" + path) || path.hasSuffix("/" + $0.path) }
    }

    private static let hunkHeader = try! NSRegularExpression(pattern: #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)

    public static func parse(_ text: String) -> GitDiff {
        var files: [File] = []
        var current: File?
        var hunk: Hunk?
        var old = 0, new = 0
        func closeHunk() {
            if let open = hunk { current?.hunks.append(open) }
            hunk = nil
        }
        func closeFile() {
            closeHunk()
            if let open = current { files.append(open) }
            current = nil
        }
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("diff --git ") {
                closeFile()
                // "diff --git a/x b/x": the b/ path, until a +++ line says better.
                let path = line.components(separatedBy: " b/").last ?? ""
                current = File(path: path, hunks: [])
                continue
            }
            guard current != nil else { continue }
            if hunk == nil || line.hasPrefix("@@") {
                if line.hasPrefix("+++ ") {
                    let path = String(line.dropFirst(4))
                    if path != "/dev/null" { current?.path = path.hasPrefix("b/") ? String(path.dropFirst(2)) : path }
                    continue
                }
                if line.hasPrefix("--- ") { continue }
                let ns = line as NSString
                if let match = hunkHeader.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
                    closeHunk()
                    old = Int(ns.substring(with: match.range(at: 1))) ?? 0
                    new = Int(ns.substring(with: match.range(at: 2))) ?? 0
                    hunk = Hunk(lines: [])
                }
                continue
            }
            if line.hasPrefix("+") {
                hunk?.lines.append(Line(kind: .added, old: nil, new: new, text: String(line.dropFirst())))
                new += 1
            } else if line.hasPrefix("-") {
                hunk?.lines.append(Line(kind: .removed, old: old, new: nil, text: String(line.dropFirst())))
                old += 1
            } else if line.hasPrefix(" ") {
                hunk?.lines.append(Line(kind: .context, old: old, new: new, text: String(line.dropFirst())))
                old += 1
                new += 1
            } else if line.hasPrefix("\\") {
                continue
            } else {
                closeHunk()
            }
        }
        closeFile()
        return GitDiff(files: files)
    }

    /// The change Codex reviewed: the work tree against where the branch left `base` (so
    /// commits and uncommitted edits both show), or against HEAD with no base.
    public static func load(folder: URL, base: String?) async -> GitDiff {
        await Task.detached {
            var from = "HEAD"
            if let base, !base.isEmpty, let fork = git(["merge-base", base, "HEAD"], in: folder)?.trimmingCharacters(in: .whitespacesAndNewlines), !fork.isEmpty {
                from = fork
            }
            return parse(git(["diff", "--no-color", "--no-ext-diff", from], in: folder) ?? "")
        }.value
    }

    /// The branch to compare with: main or master when the folder is on another branch; nil
    /// when it is on that branch itself (then only uncommitted changes count) or is no repository.
    public static func defaultBase(folder: URL) -> String? {
        guard let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: folder)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty else { return nil }
        for candidate in ["main", "master"] where candidate != branch {
            if git(["rev-parse", "--verify", "--quiet", candidate], in: folder) != nil { return candidate }
        }
        return nil
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
