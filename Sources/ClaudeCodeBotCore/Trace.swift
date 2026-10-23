import Foundation

/// What `claude` did on the way to a reply, read from its stream-json: tool calls with what went
/// in and came out, what it said between them, and the subagents it sent off.
public enum TraceEvent: Equatable, Sendable {
    /// A tool call. `parent` is the subagent's id (the tool call that started it) when a
    /// subagent made it, nil when the bot itself did.
    case toolUse(id: String, tool: String, title: String, detail: String, parent: String?)
    /// What a tool call gave back.
    case toolResult(id: String, output: String, failed: Bool, parent: String?)
    /// The pictures a tool call gave back (a Read of a .png, a screenshot), after its result.
    case toolImages(id: String, images: [ToolImage], parent: String?)
    /// Something it said between tool calls.
    case text(String, parent: String?)
    /// An absolute output counter: per Claude message, or per Codex child thread. Never a delta.
    case subagentOutput(id: String, counter: String, tokens: Int)
    /// A subagent started (`task_started`); `id` is the tool call that started it.
    case subagentStarted(id: String, description: String, type: String?, prompt: String, background: Bool)
    /// A subagent finished (`task_notification`): "completed", "failed", "killed", …
    case subagentEnded(id: String, status: String, summary: String?)
    /// A subagent stopped with background work of its own still running (a Monitor, a
    /// background command) and has not reported: claude says so (a `completed`
    /// `task_notification` without a report) each time that work wakes it, and it keeps going.
    case subagentWaiting(id: String)
    /// The name the bot gave a subagent (the Agent call's `name`), to reach it again with
    /// SendMessage.
    case subagentNamed(id: String, name: String)
    /// The model a subagent call asked for (the Agent call's `model`).
    case subagentModel(id: String, model: String)
    /// Session-scoped runtime values, never inferred from the model or current global config.
    case subagentRuntime(id: String, runtime: WorkerRuntimeInfo)
    /// A shell command went on in the background (`task_started`, `local_bash`); `id` is the
    /// Bash call. It ends with a `task_notification`, read as `subagentEnded` with that id.
    case backgroundCommandStarted(id: String, description: String)
    /// A Monitor on a socket or an MCP server went on watching (`task_started`, `monitor_ws` or
    /// `monitor_mcp`); `id` is the call. (A Monitor running a command is a `local_bash` task:
    /// `backgroundCommandStarted`, told apart by its tool.) It ends with a `task_notification`.
    case monitorStarted(id: String, description: String)
    /// A ScheduleWakeup or CronCreate call the bot made, with what it asked for. Once its result
    /// says it was scheduled, it is waiting work.
    case scheduleCalled(id: String, call: ScheduleCall)
    /// The structured result of a call the bot itself made (its `tool_use_result`), when it is
    /// a scheduling one's: what was scheduled or taken back. Comes just before its `toolResult`.
    case scheduleResult(id: String, result: ScheduleResult)
    /// The structured result of a call that started background work or a subagent (its
    /// `tool_use_result`): its agentId, output file, whether it went on in the background. Comes
    /// just before its `toolResult`.
    case launchResult(id: String, result: LaunchResult, parent: String?)
    /// What a subagent call said it is for (the Agent call's `description`).
    case subagentDescribed(id: String, description: String)
    /// A SendMessage call (`id`): `message` for `to` (a subagent's agentId or name, or another
    /// session). Whether it reached a subagent, and resumed it, the stream says after: a
    /// `task_started` naming this call, or its result's `resumedAgentId` or recipient.
    case messageSent(id: String, to: String, summary: String?, message: String, parent: String?)
}

/// What a ScheduleWakeup or CronCreate call asked for.
public struct ScheduleCall: Equatable, Sendable {
    public var kind: BackgroundTask.Kind
    /// Its line: the wake-up's reason, or the start of the job's prompt.
    public var title: String
    /// The prompt it wakes the bot with.
    public var prompt: String
    /// CronCreate: the five fields, and whether it fires on every match (claude's default).
    public var cron: String?
    public var recurring: Bool

    public init(kind: BackgroundTask.Kind, title: String, prompt: String, cron: String? = nil, recurring: Bool = true) {
        self.kind = kind
        self.title = title
        self.prompt = prompt
        self.cron = cron
        self.recurring = recurring
    }

    /// From a tool call's input: nil for any other tool, or a ScheduleWakeup that stops the loop.
    static func from(tool: String, input: [String: Any]) -> ScheduleCall? {
        let prompt = (input["prompt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let firstLine = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? prompt
        let short = firstLine.count > 60 ? String(firstLine.prefix(60)) + "…" : firstLine
        switch tool {
        case "ScheduleWakeup":
            guard input["stop"] as? Bool != true else { return nil }
            let reason = (input["reason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return ScheduleCall(kind: .wakeup, title: reason.isEmpty ? short : reason, prompt: prompt)
        case "CronCreate":
            guard let cron = input["cron"] as? String else { return nil }
            return ScheduleCall(kind: .cron, title: short, prompt: prompt, cron: cron, recurring: input["recurring"] as? Bool ?? true)
        default:
            return nil
        }
    }
}

/// A picture in a tool result, as it came (decoded from its base64). Only passed along: the step
/// keeps a file of it (`StepImages`), not the bytes.
public struct ToolImage: Equatable, Sendable {
    public var mediaType: String
    public var data: Data

    public init(mediaType: String, data: Data) {
        self.mediaType = mediaType
        self.data = data
    }
}

/// One line of work: a tool call, words between calls, or a subagent sent off; in a subagent's
/// steps, also a message the bot sent it (SendMessage).
public struct Step: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case tool, text, subagent
        /// A message its bot sent it (SendMessage): `title` the message, `detail` its summary.
        case message
    }

    public var id: String
    public var kind: Kind
    /// The tool's name, for a tool call or a subagent ("Agent").
    public var tool: String?
    /// One line: "Run swift build", "Edit template.html", or the words.
    public var title: String
    /// What went in, in full (the command, the path, the subagent's task), shortened if huge.
    public var detail: String?
    /// What came out, shortened if huge.
    public var output: String?
    public var failed: Bool
    /// Its result is in (a tool call), or it ended (a subagent).
    public var done: Bool
    /// Files of the pictures it gave back (see `StepImages`), shown in its OUT box.
    public var images: [String]?
    /// When it came, for a message its bot sent it (the subagent's view says when); nil otherwise.
    public var at: Date?

    public init(id: String, kind: Kind, tool: String? = nil, title: String, detail: String? = nil, output: String? = nil, failed: Bool = false, done: Bool = false, images: [String]? = nil, at: Date? = nil) {
        self.id = id
        self.kind = kind
        self.tool = tool
        self.title = title
        self.detail = detail
        self.output = output
        self.failed = failed
        self.done = done
        self.images = images
        self.at = at
    }
}

/// A row under a bot in the left column that you can settle out of it (a subagent, a web AI's
/// question): settled, it leaves the left column for a list in the right one, from which it can
/// be brought back. Settling only moves the row; whatever it stands for goes on.
public protocol Settleable {
    var settledAt: Date? { get set }
    var unsettledAt: Date? { get set }
}

extension Settleable {
    /// You settled it: its row is in the right column's list, not in the left one.
    public var isSettled: Bool { settledAt != nil }

    /// True if it was listed until now (worth saving).
    @discardableResult
    public mutating func settle(at date: Date = Date()) -> Bool {
        guard settledAt == nil else { return false }
        settledAt = date
        return true
    }

    /// Back in the left column from `date`. True if it was settled until now (worth saving).
    @discardableResult
    public mutating func unsettle(at date: Date = Date()) -> Bool {
        guard settledAt != nil else { return false }
        settledAt = nil
        unsettledAt = date
        return true
    }
}

/// A subagent a bot sent off with the Agent (or Task) tool, and everything it did.
/// Last settings reported by this worker's runtime. Nil fields mean unknown, including
/// a null service tier: absence is not evidence that Fast mode is off. This describes
/// session settings, not guaranteed per-request processing/billing tier.
public struct WorkerRuntimeInfo: Codable, Equatable, Sendable {
    public var reasoningEffort: String?
    public var serviceTier: String?

    public init(reasoningEffort: String? = nil, serviceTier: String? = nil) {
        self.reasoningEffort = reasoningEffort
        self.serviceTier = serviceTier
    }

    static func codex(_ settings: [String: Any], effortKey: String) -> Self {
        Self(reasoningEffort: value(settings[effortKey]), serviceTier: value(settings["serviceTier"]))
    }

    private static func value(_ raw: Any?) -> String? {
        guard let text = raw as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public struct Subagent: Codable, Equatable, Identifiable, Sendable, Settleable {
    public enum Status: String, Codable, Sendable {
        case running, completed, failed, stopped
    }

    /// The id of the tool call that started it.
    public var id: String
    public var description: String
    /// The kind of agent ("general-purpose", a plugin's agent).
    public var type: String?
    /// The task it was given.
    public var prompt: String
    public var status: Status
    /// It runs on after the tool call returned; only its notification ends it.
    public var background: Bool
    public var startedAt: Date
    public var endedAt: Date?
    public var steps: [Step]
    /// What it handed back.
    public var result: String?
    /// The subagent that sent this one off, for one started by a subagent.
    public var parentID: String?
    /// When you settled it: its row left the left column for the "Settled" list in the right
    /// column. It does not stop it: the subagent itself runs on. Nil while it is listed.
    /// (Saved as "dismissedAt", its name in 1.6.)
    public var settledAt: Date?
    /// When you brought it back from "Settled": an ended one is listed again for a while from
    /// then, as if it had just ended.
    public var unsettledAt: Date?

    private enum CodingKeys: String, CodingKey {
    /// Absolute counters replace earlier snapshots, so repeated/streamed usage is not added twice.
    public var outputTokenCounters: [String: Int]?

    public var reportedOutputTokens: Double? {
        guard let counters = outputTokenCounters, !counters.isEmpty, counters.values.allSatisfy({ $0 >= 0 }) else { return nil }
        let total = counters.values.reduce(0.0) { $0 + Double($1) }
        return total.isFinite ? total : nil
    }
