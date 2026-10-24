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
    /// The backend actually launched when it differs from the owning coordinator head.
    public var engine: BotEngine?
    public var reasoningEffort: String?
    public var serviceTier: String?

    public init(reasoningEffort: String? = nil, serviceTier: String? = nil, engine: BotEngine? = nil) {
        self.engine = engine
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
        case id, description, type, prompt, status, background, startedAt, endedAt, steps, result, parentID, unsettledAt, name, agentID, calls, model, runtime, outputTokenCounters
        case settledAt = "dismissedAt"
    }
    /// The name the bot gave it, when it gave one.
    public var name: String?
    /// claude's id for it (the Agent call's `agentId`), which SendMessage names it by.
    public var agentID: String?
    /// The SendMessage calls that reached it: a resumed run's `task_started` and
    /// `task_notification` name the call that resumed it, not the one that started it.
    public var calls: [String]?
    /// The model its Agent call asked for ("sonnet"), when it asked for one.
    public var model: String?
    public var runtime: WorkerRuntimeInfo?
    /// Absolute counters keep their highest snapshot, so repeated/streamed usage is not added twice.
    public var outputTokenCounters: [String: Int]?

    public var reportedOutputTokens: Double? {
        guard let counters = outputTokenCounters, !counters.isEmpty, counters.values.allSatisfy({ $0 >= 0 }) else { return nil }
        let total = counters.values.reduce(0.0) { $0 + Double($1) }
        return total.isFinite ? total : nil
    }

    public init(id: String, description: String, type: String? = nil, prompt: String, status: Status = .running, background: Bool = false, startedAt: Date = Date(), steps: [Step] = [], parentID: String? = nil) {
        self.id = id
        self.description = description
        self.type = type
        self.prompt = prompt
        self.status = status
        self.background = background
        self.startedAt = startedAt
        self.steps = steps
        self.parentID = parentID
    }

    public var isRunning: Bool { status == .running }

    /// How the left column marks it. One still at work gets no mark (its row carries the
    /// owner head's face); a finished one gets a check, so it never looks like a bot that is
    /// awake (green).
    public enum Mark: Equatable, Sendable {
        case live, done, failed, stopped

        /// Whether a sidebar row draws this mark: not while it works (no blue dot), once ended.
        public var showsInSidebar: Bool { self != .live }
    }

    public var mark: Mark {
        switch status {
        case .running: .live
        case .completed: .done
        case .failed: .failed
        case .stopped: .stopped
        }
    }

    /// Its tool calls so far.
    public var toolCount: Int { steps.filter { $0.kind == .tool || $0.kind == .subagent }.count }

    /// Its bot reaches it with SendMessage by this (an agentId or a name).
    func answers(to recipient: String) -> Bool {
        agentID == recipient || name == recipient || id == recipient
    }
}

/// A bot's running record: the steps of the turn under way, and its subagents (newest last).
public struct TraceBook: Equatable, Sendable {
    public private(set) var steps: [Step] = []
    public private(set) var subagents: [Subagent]
    /// Background work the turn under way started (its reply's chips).
    public private(set) var tasks: [BackgroundTask] = []
    /// ScheduleWakeup and CronCreate calls of the turn under way, until their results come.
    private var scheduleCalls: [String: ScheduleCall] = [:]
    /// Structured launch results waiting for their call's `toolResult`.
    private var launches: [String: LaunchResult] = [:]
    /// SendMessage calls, until their results come.
    private var sends: [String: SentMessage] = [:]

    struct SentMessage: Equatable, Sendable {
        var to: String
        var summary: String?
        var message: String
    }
    /// Subagents kept once ended; running ones are always kept.
    static let keptSubagents = 40
    /// Longest detail or output kept for one step.
    static let longest = 4000
    /// Where pictures tool calls gave back are kept (the bot's store); nil: a temporary folder.
    public var imageFolder: URL?

    public init(subagents: [Subagent] = []) {
        self.subagents = subagents
    }

    /// The tools that start a subagent.
    static let subagentTools: Set<String> = ["Agent", "Task"]
    /// The tool that sends a subagent (or another session) a message, resuming one that ended.
    static let messageTool = "SendMessage"

    /// Takes in one event. Returns true when a subagent started or ended (worth saving).
    @discardableResult
    public mutating func apply(_ event: TraceEvent, at date: Date = Date()) -> Bool {
        switch event {
        case let .subagentOutput(id, counter, tokens):
            // Counters only grow: a streamed snapshot sent after the transcript's final count
            // (or a repeat) never lowers it.
            guard tokens >= 0, let index = resolvedIndex(id),
                  tokens > subagents[index].outputTokenCounters?[counter] ?? -1 else { return false }
            if subagents[index].outputTokenCounters == nil { subagents[index].outputTokenCounters = [:] }
            subagents[index].outputTokenCounters?[counter] = tokens
            return true
        case let .toolUse(id, tool, title, detail, parent):
            let isSubagent = Self.subagentTools.contains(tool)
            let step = Step(id: id, kind: isSubagent ? .subagent : .tool, tool: tool, title: title, detail: Self.shorten(detail))
            if let parent {
                guard let index = subagentIndex(parent) else { return false }
                subagents[index].steps.append(step)
            } else {
                steps.append(step)
            }
            guard isSubagent, subagentIndex(id) == nil else { return false }
            subagents.append(Subagent(id: id, description: "", prompt: detail, startedAt: date, parentID: parent))
            trim()
            return true
        case let .toolResult(id, output, failed, parent):
            let launch = launches.removeValue(forKey: id)
            sends[id] = nil
            if let index = subagentIndex(id), subagents[index].agentID == nil {
                subagents[index].agentID = launch?.agentID ?? LaunchText.agentID(in: output)
            }
            if parent == nil, let at = tasks.firstIndex(where: { $0.id == id }) {
                tasks[at].outputFile = launch?.outputFile ?? LaunchText.outputFile(in: output) ?? tasks[at].outputFile
            }
            // A call whose structured result did not come (refused, failed) schedules nothing.
            if parent == nil { scheduleCalls[id] = nil }
            let output = Self.shorten(output)
            if let parent {
                guard let index = subagentIndex(parent), let at = subagents[index].steps.lastIndex(where: { $0.id == id }) else { return false }
                subagents[index].steps[at].output = output
                subagents[index].steps[at].failed = failed
                subagents[index].steps[at].done = true
            } else if let at = steps.lastIndex(where: { $0.id == id }) {
                steps[at].output = output
                steps[at].failed = failed
                // A subagent's step is done when the subagent is, not when the call returns.
                if steps[at].kind != .subagent { steps[at].done = true }
            }
            // The call that started a subagent returned: unless it runs on in the background,
            // that is its result.
            guard let index = subagentIndex(id), subagents[index].isRunning,
                  !subagents[index].background, !(launch?.background ?? LaunchText.launchedInBackground(output)) else { return false }
            end(index, status: failed ? .failed : .completed, result: output, at: date)
            trim()
            return true
        case let .toolImages(id, images, parent):
            let paths = StepImages.save(images, in: imageFolder ?? StepImages.temporaryFolder)
            guard !paths.isEmpty else { return false }
            if let parent {
                guard let index = subagentIndex(parent), let at = subagents[index].steps.lastIndex(where: { $0.id == id }) else { return false }
                subagents[index].steps[at].images = paths
            } else if let at = steps.lastIndex(where: { $0.id == id }) {
                steps[at].images = paths
            }
            return false
        case let .text(text, parent):
            let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return false }
            let step = Step(id: UUID().uuidString, kind: .text, title: text, done: true)
            if let parent {
                guard let index = subagentIndex(parent) else { return false }
                subagents[index].steps.append(step)
            } else {
                steps.append(step)
            }
            return false
        case let .subagentStarted(id, description, type, prompt, background):
            // A run of a subagent it already knows, resumed by a SendMessage call (`id`).
            if subagentIndex(id) == nil, sends[id] != nil || resolvedIndex(id) != nil {
                return resume(by: id, agentID: nil, description: description, type: type, at: date)
            }
            if background { addTask(id, kind: .agent, title: description, at: date) }
            if let index = subagentIndex(id) {
                // An explicit new start can reuse an agent's stable call id (Codex names
                // its thread once, then starts further turns on the same thread).
                if !subagents[index].isRunning {
                    subagents[index].status = .running
                    subagents[index].endedAt = nil
                }
                if !description.isEmpty { subagents[index].description = description }
                if !prompt.isEmpty { subagents[index].prompt = prompt }
                subagents[index].type = type ?? subagents[index].type
                subagents[index].background = background
            } else {
                var subagent = Subagent(id: id, description: description, type: type, prompt: prompt, startedAt: date)
                subagent.background = background
                subagents.append(subagent)
                trim()
            }
            return true
        case let .subagentEnded(id, status, summary):
            if let at = tasks.firstIndex(where: { $0.id == id && $0.isRunning }) {
                tasks[at].end(status, summary: summary, at: date)
            }
            guard let index = resolvedIndex(id), subagents[index].isRunning else { return false }
            let ended: Subagent.Status = switch TaskEnd(status) {
            case .completed: .completed
            case .failed: .failed
            case .killed, nil: .stopped
            }
            end(index, status: ended, result: summary.map(Self.shorten) ?? subagents[index].result, at: date)
            trim()
            return true
        case .subagentWaiting:
            return false
        case let .subagentNamed(id, name):
            guard let index = subagentIndex(id), subagents[index].name != name else { return false }
            subagents[index].name = name
            return true
        case let .subagentRuntime(id, runtime):
            guard let index = subagentIndex(id), subagents[index].runtime != runtime else { return false }
            subagents[index].runtime = runtime
            return true
        case let .subagentModel(id, model):
            guard let index = subagentIndex(id), subagents[index].model != model else { return false }
            subagents[index].model = model
            return true
        case let .backgroundCommandStarted(id, description):
            // A Monitor running a command is a background shell task too.
            let isMonitor = steps.last(where: { $0.id == id })?.tool == "Monitor"
            addTask(id, kind: isMonitor ? .monitor : .command, title: description, at: date)
            return false
        case let .monitorStarted(id, description):
            addTask(id, kind: .monitor, title: description, at: date)
            return false
        case let .scheduleCalled(id, call):
            scheduleCalls[id] = call
            return false
        case let .scheduleResult(id, result):
            if let call = scheduleCalls.removeValue(forKey: id) { addSchedule(id, call: call, result: result, at: date) }
            return false
        case let .launchResult(id, result, _):
            launches[id] = result
            var changed = false
            if let index = subagentIndex(id), let agentID = result.agentID, subagents[index].agentID != agentID {
                subagents[index].agentID = agentID
                changed = true
            }
            // A SendMessage call's result: resumed (`resumedAgentId`), or queued for one at work.
            if sends[id] != nil, let recipient = result.resumedAgentID ?? result.recipient {
                changed = (result.resumedAgentID != nil
                    ? resume(by: id, agentID: recipient, description: nil, type: nil, at: date)
                    : queue(by: id, agentID: recipient, at: date)) || changed
            }
            return changed
        case let .messageSent(id, to, summary, message, _):
            sends[id] = SentMessage(to: to, summary: summary, message: message)
            return false
        case let .subagentDescribed(id, description):
            guard let index = subagentIndex(id), subagents[index].description.isEmpty else { return false }
            subagents[index].description = description
            return true
        }
    }

    /// The subagent a SendMessage call is for: by the agentId claude says it reached, or by the
    /// agentId or name the call gave.
    private func recipientIndex(_ sent: SentMessage, agentID: String?) -> Int? {
        if let agentID, let index = subagents.lastIndex(where: { $0.agentID == agentID }) { return index }
        return subagents.lastIndex { $0.answers(to: sent.to) }
    }

    /// The bot's message goes in the subagent's conversation, once per call. An ended one's last
    /// report stays above it (a resumed run ends with a report of its own).
    private mutating func deliver(_ call: String, to index: Int, at date: Date) -> Bool {
        guard let sent = sends[call], subagents[index].calls?.contains(call) != true else { return false }
        subagents[index].calls = (subagents[index].calls ?? []) + [call]
        if !subagents[index].isRunning, let result = subagents[index].result?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty,
           subagents[index].steps.last(where: { $0.kind == .text })?.title.trimmingCharacters(in: .whitespacesAndNewlines) != result {
            subagents[index].steps.append(Step(id: call + ":result", kind: .text, title: result, done: true))
        }
        let summary = sent.summary.flatMap { $0.isEmpty ? nil : $0 }
        subagents[index].steps.append(Step(id: call + ":message", kind: .message, tool: "SendMessage", title: Self.shorten(sent.message), detail: summary, done: true, at: date))
        return true
    }

    /// A SendMessage call (`call`) resumed a subagent: its row is at work again, with the message
    /// in its conversation, and the turn gets a chip for the run. One the app does not know (sent
    /// off before it restarted, or trimmed) gets a row from what is known. True if it changed.
    private mutating func resume(by call: String, agentID: String?, description: String?, type: String?, at date: Date) -> Bool {
        let index: Int
        if let known = resolvedIndex(call) ?? sends[call].flatMap({ recipientIndex($0, agentID: agentID) }) {
            index = known
            _ = deliver(call, to: index, at: date)
            if agentID != nil, subagents[index].agentID == nil { subagents[index].agentID = agentID }
        } else {
            guard let sent = sends[call] else { return false }
            let about = description.flatMap { $0.isEmpty ? nil : $0 } ?? sent.summary.flatMap { $0.isEmpty ? nil : $0 } ?? sent.to
            var subagent = Subagent(id: call, description: about, type: type, prompt: "", background: true, startedAt: date)
            subagent.agentID = agentID ?? sent.to
            if sent.to != subagent.agentID { subagent.name = sent.to }
            subagents.append(subagent)
            index = subagents.count - 1
            _ = deliver(call, to: index, at: date)
        }
        if !subagents[index].isRunning {
            subagents[index].status = .running
            subagents[index].endedAt = nil
        }
        subagents[index].background = true
        if let type, subagents[index].type == nil { subagents[index].type = type }
        let title = description.flatMap { $0.isEmpty ? nil : $0 } ?? subagents[index].description
        addTask(call, kind: .agent, title: title, at: date)
        trim()
        return true
    }

    /// A message queued for a subagent at work (it reads it at its next tool call): it goes in
    /// its conversation. Should it end first, claude resumes it, naming this call.
    private mutating func queue(by call: String, agentID: String, at date: Date) -> Bool {
        guard let sent = sends[call], let index = recipientIndex(sent, agentID: agentID) else { return false }
        return deliver(call, to: index, at: date)
    }

    /// A ScheduleWakeup or CronCreate call that scheduled something: waiting work, until it fires
    /// (or, for a recurring job, until it is deleted or expires).
    private mutating func addSchedule(_ id: String, call: ScheduleCall, result: ScheduleResult, at date: Date) {
        guard !tasks.contains(where: { $0.id == id }) else { return }
        var task = BackgroundTask(id: id, kind: call.kind, title: call.title, startedAt: date)
        switch call.kind {
        case .wakeup:
            guard !result.stopped, let fire = result.fireAt else { return }
            task.fireAt = fire
        case .cron:
            guard let job = result.jobID else { return }
            task.jobID = job
            task.schedule = call.cron
            task.recurring = call.recurring
            // claude's own next run; older versions do not give it, so it is worked out here.
            task.fireAt = result.fireAt ?? call.cron.flatMap(CronSchedule.init)?.nextTime(after: date)
        default:
            return
        }
        if !call.prompt.isEmpty { task.detail = call.prompt.count > 600 ? String(call.prompt.prefix(600)) + "…" : call.prompt }
        tasks.append(task)
    }

    /// Scheduled work of the turn under way taken back (see `Array.cancelScheduled`).
    @discardableResult
    public mutating func cancelScheduled(_ cancellation: BackgroundTask.Cancellation) -> Bool {
        let before = tasks.count
        tasks.removeAll(where: cancellation.matches)
        return tasks.count != before
    }

    /// Scheduled work of the turn under way whose time came (see `Array.settleDueSchedules`).
    public mutating func settleDueSchedules(now: Date) {
        tasks = tasks.map { $0.settled(now: now) }
    }

    /// The soonest scheduled work of the turn under way is due.
    var nextScheduleDue: Date? { tasks.compactMap(\.dueAt).min() }

    /// A chip for background work the bot itself started in this turn (not one of its
    /// subagents: their work is theirs), once.
    private mutating func addTask(_ id: String, kind: BackgroundTask.Kind, title: String, at date: Date) {
        guard let step = steps.last(where: { $0.id == id }), !tasks.contains(where: { $0.id == id }) else { return }
        let title = title.isEmpty ? (subagentIndex(id).map { subagents[$0].description }.flatMap { $0.isEmpty ? nil : $0 } ?? step.title) : title
        var task = BackgroundTask(id: id, kind: kind, title: title, startedAt: date)
        if let detail = step.detail, !detail.isEmpty { task.detail = detail.count > 600 ? String(detail.prefix(600)) + "…" : detail }
        tasks.append(task)
    }

    /// The background work the finished turn started, for its reply. Nil when there was none.
    public mutating func takeTasks() -> [BackgroundTask]? {
        let taken = tasks
        tasks = []
        return taken.isEmpty ? nil : taken
    }

    /// The finished turn's steps, for its reply. Words after the last tool call are the reply
    /// itself, so they are left out. Nil when it used no tools.
    public mutating func takeSteps() -> [Step]? {
        var taken = steps
        steps = []
        while taken.last?.kind == .text { taken.removeLast() }
        return taken.isEmpty ? nil : taken
    }

    /// Takes the app's tags out of the bot's own words before its last tool call (the words
    /// after it are the reply itself, which has its own) and returns them, in order. A part
    /// that was only tags is left out of the steps.
    public mutating func liftReplyTags() -> [String] {
        guard let lastTool = steps.lastIndex(where: { $0.kind != .text }) else { return [] }
        var tags: [String] = []
        var kept: [Step] = []
        for (index, step) in steps.enumerated() {
            guard index < lastTool, step.kind == .text else {
                kept.append(step)
                continue
            }
            let lifted = ReplyParser.liftTags(step.title)
            tags += lifted.tags
            if lifted.tags.isEmpty {
                kept.append(step)
            } else if !lifted.rest.isEmpty {
                var changed = step
                changed.title = lifted.rest
                kept.append(changed)
            }
        }
        steps = kept
        return tags
    }

    /// A turn cut off before it answered gave its steps to a bubble of their own; its result
    /// came after all, so they go back ahead of what it did since, for its reply.
    public mutating func putBack(steps earlier: [Step], tasks earlierTasks: [BackgroundTask]) {
        steps = earlier + steps
        tasks = earlierTasks + tasks.filter { task in !earlierTasks.contains { $0.id == task.id } }
    }

    /// Forgets the turn's steps (a turn nobody sees: tidying, a group turn).
    public mutating func dropSteps() {
        steps = []
        tasks = []
    }

    /// The process went away: what still runs is stopped. True if any was.
    @discardableResult
    public mutating func stopRunning(at date: Date = Date()) -> Bool {
        steps = []
        tasks = []
        var any = false
        for index in subagents.indices where subagents[index].isRunning {
            end(index, status: .stopped, result: subagents[index].result, at: date)
            any = true
        }
        trim()
        return any
    }

    /// Subagents left from an earlier run of the app (loaded from disk) went away with their
    /// process. Stopped as of when they were last known to be at work (they started), so
    /// they do not come back to the left column as if they just ended. True if any was.
    @discardableResult
    public mutating func stopLeftovers() -> Bool {
        steps = []
        var any = false
        for index in subagents.indices where subagents[index].isRunning {
            end(index, status: .stopped, result: subagents[index].result, at: subagents[index].startedAt)
            any = true
        }
        trim()
        return any
    }

    /// How long a finished subagent stays in the left column.
    public static let listedAfterEnding: TimeInterval = 10 * 60
    /// Most rows listed under one bot.
    public static let listedAtMost = 4

    /// The subagents the left column lists under the bot at `date`: the ones the bot itself
    /// sent off that still run, or ended a short while ago (or were brought back from
    /// "Settled" a short while ago), and that you did not settle. Running ones come first,
    /// then the rest, newest first within each; the cap keeps the first `limit` rows of that
    /// order (nil lists them all, for "Show more").
    public func listed(at date: Date = Date(), limit: Int? = Self.listedAtMost) -> [Subagent] {
        let shown = Self.ordered(subagents.enumerated().filter { _, subagent in
            guard subagent.parentID == nil, !subagent.isSettled else { return false }
            if subagent.isRunning { return true }
            guard let ended = subagent.endedAt else { return false }
            let since = max(ended, subagent.unsettledAt ?? ended)
            return date.timeIntervalSince(since) < Self.listedAfterEnding
        })
        guard let limit else { return shown }
        return Array(shown.prefix(limit))
    }

    /// How many rows the capped list leaves out at `date`.
    public func beyondCap(at date: Date = Date()) -> Int {
        max(0, listed(at: date, limit: nil).count - Self.listedAtMost)
    }

    /// The subagents you settled, for the right column's "Settled": running ones first, then
    /// the rest, newest first within each (the same order as the left column).
    public var settled: [Subagent] {
        Self.ordered(subagents.enumerated().filter { _, subagent in
            subagent.parentID == nil && subagent.isSettled
        })
    }

    /// Running first, then newest first; later in the book counts as newer when two started
    /// at the same moment.
    private static func ordered(_ shown: [EnumeratedSequence<[Subagent]>.Element]) -> [Subagent] {
        shown.sorted { a, b in
            if a.element.isRunning != b.element.isRunning { return a.element.isRunning }
            if a.element.startedAt != b.element.startedAt { return a.element.startedAt > b.element.startedAt }
            return a.offset > b.offset
        }.map(\.element)
    }

    /// Settles it: its row leaves the left column for "Settled" in the right one. It does not
    /// stop it: a running one works on and still reports back. True if it was listed until
    /// now (worth saving).
    @discardableResult
    public mutating func settle(_ id: String, at date: Date = Date()) -> Bool {
        guard let index = subagentIndex(id) else { return false }
        return subagents[index].settle(at: date)
    }

    /// Brings a settled one back to the left column; one that has ended stays listed for
    /// `listedAfterEnding` from `date`. True if it was settled until now (worth saving).
    @discardableResult
    public mutating func unsettle(_ id: String, at date: Date = Date()) -> Bool {
        guard let index = subagentIndex(id) else { return false }
        return subagents[index].unsettle(at: date)
    }

    /// The subagent by the call that started it, or by a SendMessage call that reached it.
    public func subagent(_ id: String) -> Subagent? {
        resolvedIndex(id).map { subagents[$0] }
    }

    private func subagentIndex(_ id: String) -> Int? {
        subagents.lastIndex { $0.id == id }
    }

    /// By the call that started it, or by a SendMessage call that reached it.
    private func resolvedIndex(_ id: String) -> Int? {
        subagentIndex(id) ?? subagents.lastIndex { $0.calls?.contains(id) == true }
    }

    private mutating func end(_ index: Int, status: Subagent.Status, result: String?, at date: Date) {
        subagents[index].status = status
        subagents[index].endedAt = date
        subagents[index].result = result
        let id = subagents[index].id
        // The step that started it, in the turn or in the subagent that sent it.
        if let at = steps.lastIndex(where: { $0.id == id }) {
            steps[at].done = true
            steps[at].failed = status == .failed
        }
        if let parent = subagents[index].parentID, let owner = subagentIndex(parent),
           let at = subagents[owner].steps.lastIndex(where: { $0.id == id }) {
            subagents[owner].steps[at].done = true
            subagents[owner].steps[at].failed = status == .failed
        }
    }

    /// Keeps the newest ended ones; running ones always stay.
    private mutating func trim() {
        let ended = subagents.filter { !$0.isRunning }
        guard ended.count > Self.keptSubagents else { return }
        let drop = Set(ended.prefix(ended.count - Self.keptSubagents).map(\.id))
        subagents.removeAll { drop.contains($0.id) }
    }

    static func shorten(_ text: String) -> String {
        text.count > longest ? String(text.prefix(longest)) + "\n… (\(text.count) characters in all)" : text
    }
}
