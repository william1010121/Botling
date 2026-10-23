import Foundation

/// A Claude subagent's final output counts, read from its transcript.
///
/// The stream-json `assistant` lines of a subagent are sent as each content block ends, before
/// the message does: their `usage.output_tokens` is the count at that moment (claude 2.1.304:
/// 20, 4 and 16 for messages that ended at 76, 310 and 73), and a subagent's last message is not
/// streamed at all. Its transcript (`<projects>/<folder>/<session>/subagents/agent-<id>.jsonl`,
/// which a `task_notification`'s `output_file` links to) keeps each message's final usage. On
/// each `task_progress` and `task_notification` the new lines of that file are read, and every
/// message whose count went up comes out as the same absolute `message:<id>` counter.
final class SubagentTranscriptUsage: @unchecked Sendable {
    private let projects: URL
    private let folderName: String
    private let lock = NSLock()
    /// Per agent id: its transcript, once found.
    private var files: [String: URL] = [:]
    /// Per transcript: how far it was read (whole lines only).
    private var offsets: [URL: UInt64] = [:]
    /// Per transcript: each message's highest output count so far.
    private var counts: [URL: [String: Int]] = [:]

    init(workingDirectory: URL, config: URL = ClaudeCodeFiles.configFolder()) {
        projects = ClaudeCodeFiles.projectsFolder(config: config)
        folderName = ClaudeCodeFiles.projectFolderName(for: workingDirectory)
    }

    func events(in line: String) -> [AgentEvent] {
        guard line.contains(#""task_progress""#) || line.contains(#""task_notification""#),
              let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["type"] as? String == "system",
              let subtype = object["subtype"] as? String,
              subtype == "task_progress" || subtype == "task_notification",
              let agent = object["task_id"] as? String,
              let parent = object["tool_use_id"] as? String,
              let session = object["session_id"] as? String else { return [] }
        lock.lock()
        defer { lock.unlock() }
        guard let file = transcript(agent: agent, session: session, outputFile: object["output_file"] as? String) else { return [] }
        return readNew(file).map { .trace(.subagentOutput(id: parent, counter: "message:" + $0.id, tokens: $0.tokens)) }
    }

    private func transcript(agent: String, session: String, outputFile: String?) -> URL? {
        if let known = files[agent] { return known }
        let name = "agent-" + agent + ".jsonl"
        var candidates: [URL] = []
        // Only a subagent's transcript: a background command's output file is not one.
        if let outputFile {
            let resolved = URL(filePath: outputFile).resolvingSymlinksInPath()
            if resolved.lastPathComponent == name { candidates.append(resolved) }
        }
        let relative = session + "/subagents/" + name
        candidates.append(projects.appending(path: folderName).appending(path: relative))
        guard let found = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) })
                ?? ((try? FileManager.default.contentsOfDirectory(atPath: projects.path)) ?? [])
                    .lazy.map({ self.projects.appending(path: $0).appending(path: relative) })
                    .first(where: { FileManager.default.fileExists(atPath: $0.path) }) else { return nil }
        files[agent] = found
        return found
    }

    private func readNew(_ file: URL) -> [(id: String, tokens: Int)] {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return [] }
        defer { try? handle.close() }
        let start = offsets[file] ?? 0
        guard (try? handle.seek(toOffset: start)) != nil, let data = try? handle.readToEnd(),
              let end = data.lastIndex(of: UInt8(ascii: "\n")) else { return [] }
        offsets[file] = start + UInt64(end - data.startIndex + 1)
        var known = counts[file] ?? [:]
        var changed: [(id: String, tokens: Int)] = []
        for line in data[data.startIndex...end].split(separator: UInt8(ascii: "\n")) {
            guard let object = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any],
                  object["type"] as? String == "assistant",
                  let message = object["message"] as? [String: Any],
                  let id = message["id"] as? String,
                  let usage = message["usage"] as? [String: Any],
                  let tokens = SubagentTokenCounter.read(usage["output_tokens"]),
                  tokens > known[id] ?? -1 else { continue }
            known[id] = tokens
            changed.removeAll { $0.id == id }
            changed.append((id, tokens))
        }
        counts[file] = known
        return changed
    }
}
