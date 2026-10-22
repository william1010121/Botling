import Foundation

/// A bot may not end its turn on a promise ("接下來我會確認…", "I'll check and report back") that
/// nothing will make it keep: nothing wakes a bot between turns but a message, so such a promise
/// would just hang there.
///
/// The app checks this itself when a turn's reply has shown (`Bot.promiseCheck`), for any
/// engine: it hands a small fast model only the reply's words, and nothing at all when work the
/// app saw start (a background command or subagent, a wake-up or cron job) is still pending,
/// since that will wake the bot. A yes sends the bot one follow-up message (`followUp`) in the
/// same chat, never twice in a row. Any error or a slow answer counts as no.
public enum PromiseCheck {
    /// What the check gets when a turn ends: the reply's words, and whether work the app tracks
    /// will still wake the bot. Nothing else (no transcript, no tools).
    public struct TurnEnd: Equatable, Sendable {
        public var reply: String
        public var workPending: Bool

        public init(reply: String, workPending: Bool) {
            self.reply = reply
            self.workPending = workPending
        }
    }

    /// Whether a turn that ended so promises work nothing will trigger.
    public typealias Check = @Sendable (TurnEnd) async -> Bool
    /// Whether these words promise work not done. Throws when it can't tell.
    public typealias Classifier = @Sendable (String) async throws -> Bool

    /// The classifier's own cap.
    public static let classifierTimeout: TimeInterval = 15

    /// What the bot is sent when its reply promised work.
    public static let followUp = """
        (App: Your last message promises work you have not done ("I'll check…", "接下來我會…", "will report back"), \
        but your turn ended and nothing will wake you to do it: the user is left waiting. \
        Do it now. If it has to wait, start it as a background task (Bash with run_in_background, or a \
        background subagent) that will wake you when it is done. If you really meant to hand it back to \
        the user, say so plainly instead of promising.)
        """

    /// The check: no when work is pending or the reply leaves the next move to the user (empty,
    /// or a `<choices>` block); otherwise what `classify` says of the reply's last 4000 characters.
    public static func check(_ end: TurnEnd, classify: Classifier) async -> Bool {
        if end.workPending { return false }
        let text = end.reply.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.contains("<choices") { return false }
        return (try? await classify(String(text.suffix(4000)))) ?? false
    }

    public static func checker(classify: @escaping Classifier) -> Check {
        { end in await check(end, classify: classify) }
    }

    static let classifierPrompt = """
        You check the final message (given inside <message> tags) an AI assistant sent before ending its \
        turn in a chat. After it nothing happens until the user writes again, except that a background \
        task, subagent, team or build the assistant already started wakes it when done.
        Answer YES only if the message says the assistant itself will now do work that is not yet done and \
        not already running ("I'll check…", "Let me look into it and report back", "接下來我會確認…", \
        "我去看一下再回報", "下一步照先前說好的，開始做 X", "Next, I'll start on X"), even right after a \
        report of finished work.
        Answer NO if the work is done or reported; if it asks the user a question or waits for the user's \
        answer, choice or permission; if it only offers next steps the user may ask for ("要我…嗎？", \
        "可以考慮…", "you could…"); or if it says the remaining work was already started or handed off \
        (a background task, subagent, team or build is running it), so that it only promises to pass on \
        that result when it arrives ("已在背景跑測試，跑完會通知你", "subagent 在查了，結果出來再跟你說", \
        "I started the tests in the background; I'll report when they finish").
        Answer with exactly one word, YES or NO, and nothing else.
        """

    /// The classifier's `claude -p` arguments: Haiku, no tools, no hooks, no MCP, no session kept.
    static func classifierArguments(message: String) -> [String] {
        [
            "-p", "<message>\n\(message)\n</message>",
            "--model", BotModel.haiku.rawValue,
            "--system-prompt", classifierPrompt,
            "--tools", "",
            "--settings", #"{"disableAllHooks":true}"#,
            "--strict-mcp-config",
            "--no-session-persistence",
            "--output-format", "text"
        ]
    }

    /// Reads the classifier's answer (the last YES or NO it wrote); throws when it said neither.
    static func parseVerdict(_ output: String) throws -> Bool {
        guard let verdict = output.uppercased().matches(of: #/\b(YES|NO)\b/#.asciiOnlyWordCharacters()).last else { throw CocoaError(.formatting) }
        return verdict.output.1 == "YES"
    }

    /// Haiku through the `claude` `locate` finds, stopped after `timeout` seconds.
    public static func claudeClassifier(locate: @escaping @Sendable () -> URL?, timeout: TimeInterval = classifierTimeout) -> Classifier {
        { message in
            guard let executable = locate() else { throw CocoaError(.executableNotLoadable) }
            let result = await blocking {
                CommandRunner.runBlocking(executable, classifierArguments(message: message), timeout: timeout, environment: ["CLAUDECODE": nil])
            }
            guard let result, !result.timedOut, result.exitCode == 0 else { throw CocoaError(.executableLoad) }
            return try parseVerdict(result.output)
        }
    }

    public static func claudeClassifier(executable: URL, timeout: TimeInterval = classifierTimeout) -> Classifier {
        claudeClassifier(locate: { executable }, timeout: timeout)
    }
}
