import Foundation

/// Where Claude Code keeps its own files, as this app reads them: the one place that knows the
/// layout (claude 2.1.x), so a change in a new CLI version is fixed here and nowhere else.
public enum ClaudeCodeFiles {
    /// Claude Code's own folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    public static func configFolder(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        environment["CLAUDE_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : URL(filePath: ($0 as NSString).expandingTildeInPath) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude")
    }

    /// Where it keeps sessions' transcripts: one folder per working folder.
    static func projectsFolder(config: URL) -> URL { config.appending(path: "projects") }

    /// The folder name it gives a working folder: every character but ASCII letters and digits
    /// as `-` ("/Users/me/p" → "-Users-me-p"). Long or symlinked paths may be named otherwise.
    static func projectFolderName(for folder: URL) -> String {
        String(folder.standardizedFileURL.path.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
    }

    /// A session's transcript file name.
    static func transcriptName(_ session: UUID) -> String { session.uuidString.lowercased() + ".jsonl" }

    /// The environment its settings.json gives every session (`"env": {…}`), such as a gateway's
    /// `ANTHROPIC_BASE_URL`.
    static func settingsEnvironment(config: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: config.appending(path: "settings.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let env = object["env"] as? [String: Any] else { return [:] }
        return env.compactMapValues { $0 as? String }
    }
}
