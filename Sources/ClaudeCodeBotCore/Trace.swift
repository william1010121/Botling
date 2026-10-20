import Foundation

/// What `claude` did on the way to a reply, read from its stream-json: tool calls with what went
/// in and came out, what it said between them, and the subagents it sent off.
public enum TraceEvent: Equatable, Sendable {
    /// A tool call. `parent` is the subagent's id (the tool call that started it) when a
    /// subagent made it, nil when the bot itself did.
    case toolUse(id: String, tool: String, title: String, detail: String, parent: String?)
    /// What a tool call gave back.
    case toolResult(id: String, output: String, failed: Bool, parent: String?)
    /// Something it said between tool calls.
    case text(String, parent: String?)
    /// A subagent started (`task_started`); `id` is the tool call that started it.
    case subagentStarted(id: String, description: String, type: String?, prompt: String, background: Bool)
    /// A subagent finished (`task_notification`): "completed", "failed", "killed", …
    case subagentEnded(id: String, status: String, summary: String?)
}

/// One line of work: a tool call, words between calls, or a subagent sent off.
public struct Step: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case tool, text, subagent
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

    public init(id: String, kind: Kind, tool: String? = nil, title: String, detail: String? = nil, output: String? = nil, failed: Bool = false, done: Bool = false) {
        self.id = id
        self.kind = kind
        self.tool = tool
        self.title = title
        self.detail = detail
        self.output = output
        self.failed = failed
        self.done = done
    }
}

/// A subagent a bot sent off with the Agent (or Task) tool, and everything it did.
public struct Subagent: Codable, Equatable, Identifiable, Sendable {
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
    /// When you took its row out of the left column. It only hides the row: the subagent
    /// itself runs on. Nil while it is listed.
    public var dismissedAt: Date?

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

    /// You took its row out of the left column.
    public var isDismissed: Bool { dismissedAt != nil }

    /// How the left column marks it. Only one still at work gets a live dot; a finished one
    /// gets a check, so it never looks like a bot that is awake (green).
    public enum Mark: Equatable, Sendable {
        case live, done, failed, stopped
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
    public var toolCount: Int { steps.filter { $0.kind != .text }.count }
}

/// A bot's running record: the steps of the turn under way, and its subagents (newest last).
public struct TraceBook: Equatable, Sendable {
    public private(set) var steps: [Step] = []
    public private(set) var subagents: [Subagent]
    /// Subagents kept once ended; running ones are always kept.
    static let keptSubagents = 40
    /// Longest detail or output kept for one step.
    static let longest = 4000

    public init(subagents: [Subagent] = []) {
        self.subagents = subagents
    }

    /// The tools that start a subagent.
    static let subagentTools: Set<String> = ["Agent", "Task"]

    /// Takes in one event. Returns true when a subagent started or ended (worth saving).
    @discardableResult
    public mutating func apply(_ event: TraceEvent, at date: Date = Date()) -> Bool {
        switch event {
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
            subagents.append(Subagent(id: id, description: Self.subagentName(title), prompt: detail, startedAt: date, parentID: parent))
            trim()
            return true
        case let .toolResult(id, output, failed, parent):
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
                  !subagents[index].background, !Self.launchedInBackground(output) else { return false }
            end(index, status: failed ? .failed : .completed, result: output, at: date)
            trim()
            return true
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
            if let index = subagentIndex(id) {
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
            guard let index = subagentIndex(id), subagents[index].isRunning else { return false }
            let ended: Subagent.Status = switch status {
            case "completed": .completed
            case "failed", "error": .failed
            default: .stopped
            }
            end(index, status: ended, result: summary.map(Self.shorten) ?? subagents[index].result, at: date)
            trim()
            return true
        }
    }

    /// The finished turn's steps, for its reply. Words after the last tool call are the reply
    /// itself, so they are left out. Nil when it used no tools.
    public mutating func takeSteps() -> [Step]? {
        var taken = steps
        steps = []
        while taken.last?.kind == .text { taken.removeLast() }
        return taken.isEmpty ? nil : taken
    }

    /// Forgets the turn's steps (a turn nobody sees: tidying, a group turn).
    public mutating func dropSteps() {
        steps = []
    }

    /// The process went away: what still runs is stopped. True if any was.
    @discardableResult
    public mutating func stopRunning(at date: Date = Date()) -> Bool {
        steps = []
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
    /// sent off that still run, or ended a short while ago, and whose row you did not take
    /// away. Running ones come first, then the rest, newest first within each; the cap keeps
    /// the first `limit` rows of that order (nil lists them all, for "Show more").
    public func listed(at date: Date = Date(), limit: Int? = Self.listedAtMost) -> [Subagent] {
        let shown = subagents.enumerated().filter { _, subagent in
            guard subagent.parentID == nil, !subagent.isDismissed else { return false }
            if subagent.isRunning { return true }
            guard let ended = subagent.endedAt else { return false }
            return date.timeIntervalSince(ended) < Self.listedAfterEnding
        }
        // Later in the book counts as newer when two started at the same moment.
        let ordered = shown.sorted { a, b in
            if a.element.isRunning != b.element.isRunning { return a.element.isRunning }
            if a.element.startedAt != b.element.startedAt { return a.element.startedAt > b.element.startedAt }
            return a.offset > b.offset
        }
        guard let limit else { return ordered.map(\.element) }
        return ordered.prefix(limit).map(\.element)
    }

    /// How many rows the capped list leaves out at `date`.
    public func beyondCap(at date: Date = Date()) -> Int {
        max(0, listed(at: date, limit: nil).count - Self.listedAtMost)
    }

    /// Takes its row out of the left column. It does not stop it: a running one works on and
    /// still reports back. True if it was listed until now (worth saving).
    @discardableResult
    public mutating func dismiss(_ id: String, at date: Date = Date()) -> Bool {
        guard let index = subagentIndex(id), subagents[index].dismissedAt == nil else { return false }
        subagents[index].dismissedAt = date
        return true
    }

    public func subagent(_ id: String) -> Subagent? {
        subagents.first { $0.id == id }
    }

    private func subagentIndex(_ id: String) -> Int? {
        subagents.lastIndex { $0.id == id }
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

    /// "Delegate Read a.txt" → "Read a.txt".
    static func subagentName(_ title: String) -> String {
        title.hasPrefix("Delegate ") ? String(title.dropFirst("Delegate ".count)) : title
    }

    /// The tool result of an Agent call that went to the background.
    static func launchedInBackground(_ output: String) -> Bool {
        output.hasPrefix("Async agent launched")
    }

    static func shorten(_ text: String) -> String {
        text.count > longest ? String(text.prefix(longest)) + "\n… (\(text.count) characters in all)" : text
    }
}
