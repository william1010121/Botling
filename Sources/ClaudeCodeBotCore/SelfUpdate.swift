import Foundation

/// A build of ClaudeCodeBot: what `scripts/make-app.sh` wrote into its Info.plist.
public struct BuildInfo: Codable, Equatable, Sendable {
    public var path: String
    public var bundleID: String
    public var version: String
    /// The git commit it was built from, and whether there were uncommitted changes.
    public var commit: String?
    public var dirty: Bool

    public init(path: String, bundleID: String, version: String, commit: String? = nil, dirty: Bool = false) {
        self.path = path
        self.bundleID = bundleID
        self.version = version
        self.commit = commit
        self.dirty = dirty
    }

    /// Reads a `.app` bundle; nil if it is no app (no Info.plist or no executable).
    public static func read(_ bundle: URL) -> BuildInfo? {
        let plist = bundle.appending(path: "Contents/Info.plist")
        guard bundle.pathExtension == "app",
              let data = try? Data(contentsOf: plist),
              let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let id = info["CFBundleIdentifier"] as? String,
              let executable = info["CFBundleExecutable"] as? String,
              FileManager.default.isExecutableFile(atPath: bundle.appending(path: "Contents/MacOS/\(executable)").path) else { return nil }
        let commit = (info["CCBGitCommit"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let dirty = (info["CCBGitDirty"] as? String) == "1" || (info["CCBGitDirty"] as? Bool) == true
        return BuildInfo(path: bundle.standardizedFileURL.path, bundleID: id, version: info["CFBundleShortVersionString"] as? String ?? "?", commit: commit, dirty: dirty)
    }

    /// "1.4.0 (abc1234)", "1.4.0 (abc1234, uncommitted changes)".
    public var label: String {
        let short = commit.map { String($0.prefix(7)) }
        let parts = [short, dirty ? "uncommitted changes" : nil].compactMap { $0 }
        return parts.isEmpty ? version : "\(version) (\(parts.joined(separator: ", ")))"
    }
}

/// Installing a new build of ClaudeCodeBot while it runs. The app cannot replace itself, so a
/// small script outside it does: it waits for the app to quit (bots write their memory first),
/// moves the running build aside, puts the new one in its place and opens it. The new app says
/// it came up by writing `healthy`; if it does not within `healthWait` seconds, the script puts
/// the old build back, opens it, and writes `rolled-back`. Either way the next launch tells the
/// bot that asked how it went.
public enum SelfUpdate {
    /// Seconds the new build has to come up.
    public static let healthWait = 90
    /// Seconds a new build must have run before it counts as up.
    public static let healthyAfter: TimeInterval = 8
    /// Builds in a row that failed to come up before installing pauses.
    public static let failureLimit = 2

    /// What is under way, in `<root>/update/state.json`.
    public struct State: Codable, Equatable, Sendable {
        public var from: BuildInfo
        public var to: BuildInfo
        /// The project whose bot asked for it, told how it went.
        public var requesterID: UUID
        public var note: String
        public var startedAt: Date
        /// Where the running build was moved.
        public var backup: String
    }

    public static func folder(in root: URL) -> URL { root.appending(path: "update") }
    static func stateURL(in root: URL) -> URL { folder(in: root).appending(path: "state.json") }
    static func healthyURL(in root: URL) -> URL { folder(in: root).appending(path: "healthy") }
    static func rolledBackURL(in root: URL) -> URL { folder(in: root).appending(path: "rolled-back") }
    static func failuresURL(in root: URL) -> URL { folder(in: root).appending(path: "failures") }
    public static func logURL(in root: URL) -> URL { folder(in: root).appending(path: "install.log") }
    static func scriptURL(in root: URL) -> URL { folder(in: root).appending(path: "install.sh") }

    /// Builds in a row that did not come up.
    static func failures(in root: URL) -> Int {
        (try? String(contentsOf: failuresURL(in: root), encoding: .utf8)).flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 0
    }

    static func setFailures(_ count: Int, in root: URL) {
        try? FileManager.default.createDirectory(at: folder(in: root), withIntermediateDirectories: true)
        try? Data("\(count)\n".utf8).write(to: failuresURL(in: root))
    }

    /// Writes the state and the script; returns the command that runs the script (detached from
    /// the app, which quits right after starting it).
    public static func prepare(from running: BuildInfo, to new: BuildInfo, requester: UUID, note: String, pid: Int32, in root: URL, now: Date = Date()) throws -> [String] {
        let folder = folder(in: root)
        try FileManager.default.createDirectory(at: folder.appending(path: "backups"), withIntermediateDirectories: true)
        for marker in [healthyURL(in: root), rolledBackURL(in: root)] { try? FileManager.default.removeItem(at: marker) }
        let stamp = Spending.today(now) + "-" + String(Int(now.timeIntervalSince1970))
        let backup = folder.appending(path: "backups/ClaudeCodeBot-\(running.version)-\(stamp).app").path
        let state = State(from: running, to: new, requesterID: requester, note: note, startedAt: now, backup: backup)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(state).write(to: stateURL(in: root), options: .atomic)
        try script.write(to: scriptURL(in: root), atomically: true, encoding: .utf8)
        return ["/usr/bin/nohup", "/bin/bash", scriptURL(in: root).path,
                String(pid), running.path, new.path, backup, healthyURL(in: root).path, rolledBackURL(in: root).path, String(healthWait)]
    }

    /// The script, run as: install.sh pid target new backup healthy rolled-back seconds.
    static let script = """
    #!/bin/bash
    # Installs a new ClaudeCodeBot build while the old one quits; puts the old one back if the
    # new one does not come up. Written by ClaudeCodeBot (SelfUpdate.swift).
    PID="$1"; TARGET="$2"; NEW="$3"; BACKUP="$4"; HEALTHY="$5"; ROLLED="$6"; WAIT="$7"
    say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
    say "waiting for ClaudeCodeBot ($PID) to quit"
    for i in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$PID" 2>/dev/null; then say "it did not quit; nothing changed"; echo "did not quit" > "$ROLLED"; exit 1; fi
    say "moving $TARGET to $BACKUP"
    mv "$TARGET" "$BACKUP" || { say "could not move the old build"; echo "could not move the old build" > "$ROLLED"; open "$TARGET"; exit 1; }
    if ! ditto "$NEW" "$TARGET"; then
      say "could not copy the new build; putting the old one back"
      rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"; echo "could not copy the new build" > "$ROLLED"; open "$TARGET"; exit 1
    fi
    say "opening the new build"
    open "$TARGET"
    for i in $(seq 1 "$WAIT"); do
      if [ -f "$HEALTHY" ]; then say "the new build is up"; exit 0; fi
      sleep 1
    done
    say "the new build did not come up in $WAIT seconds; putting the old one back"
    pkill -f "$TARGET/Contents/MacOS/" ; sleep 2
    rm -rf "$TARGET.failed"; mv "$TARGET" "$TARGET.failed" 2>/dev/null
    mv "$BACKUP" "$TARGET"
    echo "the new build did not come up in $WAIT seconds" > "$ROLLED"
    open "$TARGET"
    exit 1
    """

    /// How the last install went, read at launch: nil when none was under way.
    public enum Outcome: Equatable, Sendable {
        /// This is the new build (it still has to stay up `healthyAfter` seconds).
        case installed(State)
        /// The new build did not come up; this is the old one again.
        case rolledBack(State, reason: String)
    }

    /// Reads (and clears, for a roll-back) what the last install left behind.
    public static func outcome(in root: URL) -> Outcome? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = try? Data(contentsOf: stateURL(in: root)),
              let state = try? decoder.decode(State.self, from: data) else { return nil }
        if let reason = try? String(contentsOf: rolledBackURL(in: root), encoding: .utf8) {
            return .rolledBack(state, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return .installed(state)
    }

    /// The new build is up: the script stops waiting, and the state is done with.
    public static func markHealthy(in root: URL) {
        try? Data("ok\n".utf8).write(to: healthyURL(in: root))
        finish(in: root)
    }

    static func finish(in root: URL) {
        try? FileManager.default.removeItem(at: stateURL(in: root))
        try? FileManager.default.removeItem(at: rolledBackURL(in: root))
    }

    /// Files whose changes alter what bots are told or allowed to do; a build that changes them
    /// says so on its card.
    public static let sensitivePaths = [
        "Sources/ClaudeCodeBotCore/Prompts.swift",
        "Sources/ClaudeCodeBotCore/Models.swift",
        "Sources/ClaudeCodeBotCore/AgentProcess.swift",
        "Sources/ClaudeCodeBotCore/AppSettings.swift",
        "Sources/ClaudeCodeBotCore/SelfUpdate.swift",
        "Sources/ClaudeCodeBotCore/Workspace+Developer.swift",
    ]
    /// Changed lines with these anywhere count too.
    static let sensitivePattern = "allowedTools|disallowedTools|neverAlways|alwaysAllowed|permission-mode|asksPermission|toolbox|developerMode"

    /// The sensitive files changed between two commits in `repo`, with lines added and removed.
    public static func sensitiveChanges(in repo: URL, from old: String, to new: String) -> [(file: String, added: Int, removed: Int)]? {
        guard let stats = git(repo, ["diff", "--numstat", old, new]) else { return nil }
        let matching = Set((git(repo, ["diff", "--name-only", "-G", sensitivePattern, old, new]) ?? "").split(separator: "\n").map(String.init))
        return stats.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\t").map(String.init)
            guard parts.count == 3, sensitivePaths.contains(parts[2]) || matching.contains(parts[2]) else { return nil }
            return (parts[2], Int(parts[0]) ?? 0, Int(parts[1]) ?? 0)
        }
    }

    static func git(_ repo: URL, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", repo.path] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}
