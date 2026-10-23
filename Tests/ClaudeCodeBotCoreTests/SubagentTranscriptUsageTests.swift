import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Captured from claude 2.1.304 (haiku, one general-purpose Agent running three Bash calls),
/// trimmed to the fields read. The streamed lines said 20 + 4 + 16 = 40 output tokens; the
/// subagent's transcript (and the turn's modelUsage minus the main session's) says 463.
@MainActor
struct SubagentTranscriptUsageTests {
    let start = Date(timeIntervalSince1970: 1_000)
    let parent = "toolu_01F9gNemBbHXLydUgbbSYJzT"
    let agent = "ae27d7122af43c51d"
    let session = "35beccde-f436-43af-94af-deb331eb0b72"

    func streamed(_ id: String, _ tokens: Int, _ tool: String) -> String {
        #"{"type":"assistant","message":{"id":"\#(id)","type":"message","role":"assistant","content":[{"type":"tool_use","id":"\#(tool)","name":"Bash","input":{"command":"echo alpha","description":"Print alpha"}}],"stop_reason":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":33188,"output_tokens":\#(tokens)}},"parent_tool_use_id":"\#(parent)","agent_id":"\#(agent)","session_id":"\#(session)"}"#
    }
    func saved(_ id: String, _ stop: String?, _ tokens: Int, _ block: String) -> String {
        let stop = stop.map { "\"\($0)\"" } ?? "null"
        return #"{"type":"assistant","agentId":"\#(agent)","message":{"id":"\#(id)","type":"message","role":"assistant","content":[{"type":"\#(block)"}],"stop_reason":\#(stop),"usage":{"input_tokens":2,"cache_read_input_tokens":33188,"output_tokens":\#(tokens)}}}"#
    }
    func progress(_ tools: Int) -> String {
        #"{"type":"system","subtype":"task_progress","task_id":"\#(agent)","tool_use_id":"\#(parent)","usage":{"total_tokens":37280,"tool_uses":\#(tools),"duration_ms":8438},"last_tool_name":"Bash","session_id":"\#(session)"}"#
    }

    @Test func transcriptFinalCountsReplaceStaleStreamedSnapshots() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "transcript-usage-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let work = root.appending(path: "work")
        let config = root.appending(path: "config")
        let dir = config.appending(path: "projects").appending(path: ClaudeCodeFiles.projectFolderName(for: work))
            .appending(path: session).appending(path: "subagents")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appending(path: "agent-\(agent).jsonl")
        // A task's output file links to the transcript.
        let tasks = root.appending(path: "tasks")
        try FileManager.default.createDirectory(at: tasks, withIntermediateDirectories: true)
        let output = tasks.appending(path: "\(agent).output")
        try FileManager.default.createSymbolicLink(at: output, withDestinationURL: file)

        let usage = SubagentTranscriptUsage(workingDirectory: work, config: config)
        var book = TraceBook(subagents: [Subagent(id: parent, description: "Run", prompt: "Go", startedAt: start)])
        func feed(_ line: String) {
            for case let .trace(event) in StreamEvent.events(in: line) + usage.events(in: line) { book.apply(event, at: start) }
        }

        // Before the fix only these counted.
        let first = saved("msg_011CgK1uAkEpvHoJymRzcWUj", "tool_use", 76, "tool_use") + "\n"
        try first.write(to: file, atomically: false, encoding: .utf8)
        feed(streamed("msg_011CgK1uAkEpvHoJymRzcWUj", 20, "toolu_a"))
        feed(progress(1))
        #expect(book.subagent(parent)?.reportedOutputTokens == 76)

        let rest = [
            saved("msg_011CgK1uSo8syhx4KNpfMyXu", nil, 4, "thinking"),
            saved("msg_011CgK1uSo8syhx4KNpfMyXu", "tool_use", 310, "tool_use"),
            saved("msg_011CgK1ufYMajsy8FhmJYN37", "tool_use", 73, "tool_use"),
            saved("msg_011CgK1unwMrPgqwLsNZ8Dih", "end_turn", 4, "text"),
        ].map { $0 + "\n" }.joined()
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(rest.utf8))
        try handle.close()
        // A stale snapshot after the final count does not lower it.
        feed(streamed("msg_011CgK1uSo8syhx4KNpfMyXu", 4, "toolu_b"))
        feed(streamed("msg_011CgK1ufYMajsy8FhmJYN37", 16, "toolu_c"))
        feed(#"{"type":"system","subtype":"task_notification","task_id":"\#(agent)","tool_use_id":"\#(parent)","status":"completed","output_file":"\#(output.path)","summary":"done","usage":{"total_tokens":37402,"tool_uses":3,"duration_ms":9982},"session_id":"\#(session)"}"#)
        #expect(book.subagent(parent)?.reportedOutputTokens == 463)
        #expect(book.subagent(parent)?.outputTokenCounters?.count == 4)
    }

    @Test func aBackgroundCommandsOutputFileIsNotReadAsATranscript() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "transcript-usage-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let output = root.appending(path: "b1.output")
        try (saved("m", "end_turn", 999, "text") + "\n").write(to: output, atomically: false, encoding: .utf8)
        let usage = SubagentTranscriptUsage(workingDirectory: root, config: root.appending(path: "config"))
        let line = #"{"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"toolu_bash","status":"completed","output_file":"\#(output.path)","session_id":"\#(session)"}"#
        #expect(usage.events(in: line).isEmpty)
    }
}
