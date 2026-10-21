import Foundation

/// What a fork of a bot's session is asked to write about one of its replies.
public struct BriefJob: Equatable, Sendable {
    /// The session that wrote the reply; the fork goes on in a copy of it.
    public var session: UUID
    /// The bot's own model and effort.
    public var model: BotModel
    public var effort: EffortLevel?
    /// The bot's folder: where its session lives, and where commands it names run.
    public var folder: URL
    public var prompt: String
    /// How long to wait for the brief before going on without it.
    public var timeout: TimeInterval

    public init(session: UUID, model: BotModel, effort: EffortLevel? = nil, folder: URL, prompt: String, timeout: TimeInterval = ComponentBrief.timeout) {
        self.session = session
        self.model = model
        self.effort = effort
        self.folder = folder
        self.prompt = prompt
        self.timeout = timeout
    }
}

/// Writes a brief for a job: the brief, or nil when there is none (it failed, or took too long).
public typealias BriefWriter = @Sendable (BriefJob) async -> String?

/// "Make into component": before Maintainer builds the component, a fork of the bot that wrote
/// the reply (`claude -p --resume <session> --fork-session`, with the bot's model, read-only, its
/// transcript not kept) writes Maintainer a brief from what it knows of that conversation: what
/// the component is for, the user's own message, each data field, and whether a CLI command can
/// get it (the exact command) or only a bot can (explanations, advice). The fork is not the bot:
/// nothing shows in its chat, it is not woken and its own session goes on untouched.
public enum ComponentBrief {
    /// How long Maintainer's request waits for the brief.
    public static let timeout: TimeInterval = 120
    /// It only reads: its answer comes from the conversation it is a copy of.
    static let tools = ["Read", "Grep", "Glob"]
    static let deniedTools = ["Bash", "Write", "Edit", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch", "AskUserQuestion"]
    /// How much of the brief Maintainer gets.
    static let limit = 8_000

    static func launch(for job: BriefJob) -> AgentLaunch {
        AgentLaunch(
            model: job.model,
            sessionID: job.session,
            resume: true,
            forkSession: true,
            persistSession: false,
            workingDirectory: job.folder,
            // On --resume the session keeps its own system prompt; this only says what this copy is for.
            systemPrompt: "This is a read-only copy of your session, asked by the ClaudeCodeBot app for a component brief. Change nothing.",
            tools: tools,
            asksPermission: false,
            disallowedTools: deniedTools,
            autoMode: false,
            effort: job.effort
        )
    }

    /// What the fork is asked: a brief in `<component-brief>`, from what it already knows.
    @MainActor
    static func request(reply: ChatMessage, asked: String?, folder: String) -> String {
        let when = reply.date.formatted(date: .omitted, time: .shortened)
        var text = "(App: The user pressed \"Make into component\" on your reply from \(when) (\"\(Bot.preview(of: reply))\"). Maintainer, who builds the app's chat components, will make it into a component that shows that reply's kind of content. Write Maintainer a brief. Do not do the work again: change nothing and run nothing; answer from what you already know in this conversation (you may Read a file to check a name or path)."
        if let asked, !asked.isEmpty {
            text += "\nThe user's message that led to it, as the app has it:\n" + clip(asked, 4_000)
        }
        text += """

        Answer with only <component-brief>…</component-brief>, in English (keep the user's own words as they are), holding:
        1. Purpose: what the component is for, in one or two sentences.
        2. The user's message: the user's own message that led to that reply, verbatim.
        3. Fields: each data field it should show (name, type, an example value), each marked as one of:
           - From command: a CLI command gets it. Give the exact command(s) you ran for it (or would run), run in \(folder), and how the output maps to the field.
           - Optional (bot only): only a bot can write it (explanations, advice, a "next step"); shown only when a bot fills it.
        4. Board command: when some fields are From command, one command (or a short script outline) that prints JSON with just those fields; else "none".
        No words outside the tag.)
        """
        return text
    }

    /// The brief in an answer: what its `<component-brief>` holds, else the whole answer; nil
    /// when that is empty.
    static func brief(from answer: String) -> String? {
        var text = answer
        if let open = answer.range(of: "<component-brief>") {
            let rest = answer[open.upperBound...]
            text = String(rest.range(of: "</component-brief>").map { rest[..<$0.lowerBound] } ?? rest)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : clip(trimmed, limit)
    }

    static func clip(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }

    /// Starts the fork with `launcher`, sends the job's prompt, and returns its brief: nil when
    /// it could not start, failed, or gave none within the job's timeout. The fork is ended
    /// either way.
    public static func writer(launcher: @escaping AgentLauncher) -> BriefWriter {
        { job in
            guard let process = try? launcher(launch(for: job)) else { return nil }
            process.send(job.prompt)
            let answer: String? = await withTaskGroup(of: String?.self) { group in
                group.addTask {
                    for await event in process.events {
                        switch event {
                        case let .reply(text, isError): return isError ? nil : text
                        case .exited: return nil
                        default: continue
                        }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(for: .seconds(job.timeout))
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                process.stop()
                return first
            }
            return answer.flatMap(brief(from:))
        }
    }
}
