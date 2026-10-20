import Foundation

/// One problem Codex found, and where it stands.
public struct CodexFinding: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, CaseIterable, Sendable {
        /// Found, nothing done about it yet.
        case open
        /// Handed to a bot or subagent to fix.
        case sent
        /// The next review no longer found it, or you said so.
        case fixed
        /// You said it is not worth fixing (or not an issue).
        case skipped

        public var displayName: String {
            switch self {
            case .open: "Open"
            case .sent: "Being fixed"
            case .fixed: "Fixed"
            case .skipped: "Skipped"
            }
        }
    }

    public var id: UUID
    public var file: String
    public var line: Int?
    public var severity: CodexSeverity
    public var title: String
    public var scenario: String
    public var status: Status
    /// The review round that first found it, and the last one that did.
    public var firstRound: Int
    public var lastSeenRound: Int
    /// How many times it was sent to be fixed.
    public var timesSent: Int

    public init(id: UUID = UUID(), file: String, line: Int?, severity: CodexSeverity, title: String, scenario: String, status: Status = .open, round: Int = 1) {
        self.id = id
        self.file = file
        self.line = line
        self.severity = severity
        self.title = title
        self.scenario = scenario
        self.status = status
        firstRound = round
        lastSeenRound = round
        timesSent = 0
    }

    init(_ item: CodexOutput.Item, round: Int) {
        self.init(file: item.file, line: item.line, severity: item.severity, title: item.title, scenario: item.scenario, round: round)
    }

    /// "Bot.swift:42".
    public var place: String {
        let name = file.isEmpty ? "" : (file as NSString).lastPathComponent
        return name + (line.map { name.isEmpty ? "line \($0)" : ":\($0)" } ?? "")
    }

    /// Seen in more than one round: sent back and still there.
    public var keepsComingBack: Bool { lastSeenRound > firstRound }

    /// One line for a bot: severity, place, what is wrong and how it fails.
    var briefLine: String {
        "- [\(severity.rawValue)] \(file.isEmpty ? "(no file)" : file)\(line.map { ":\($0)" } ?? ""): \(title)\(scenario.isEmpty ? "" : " — \(scenario)")"
    }
}

/// Which findings go back to the subagent to fix.
public enum CodexSendBack: String, Codable, CaseIterable, Sendable {
    case highAndMedium, all, highOnly

    public var displayName: String {
        switch self {
        case .highAndMedium: "High and medium"
        case .all: "All findings"
        case .highOnly: "High only"
        }
    }

    public func includes(_ severity: CodexSeverity) -> Bool {
        switch self {
        case .all: true
        case .highAndMedium: severity != .low
        case .highOnly: severity == .high
        }
    }
}

/// When a bot has Codex review its subagents' work.
public enum CodexReviewMode: String, Codable, CaseIterable, Sendable {
    case off, ask, always

    public var displayName: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask each time"
        case .always: "Always"
        }
    }
}

/// A bot's Codex review settings (Settings › Codex review for subagents).
public struct CodexSettings: Codable, Equatable, Sendable {
    public var mode: CodexReviewMode
    /// Fix rounds before the loop stops and asks you.
    public var maxRounds: Int
    public var sendBack: CodexSendBack

    public static let roundLimits = 1...8

    public init(mode: CodexReviewMode = .off, maxRounds: Int = 3, sendBack: CodexSendBack = .highAndMedium) {
        self.mode = mode
        self.maxRounds = min(max(maxRounds, Self.roundLimits.lowerBound), Self.roundLimits.upperBound)
        self.sendBack = sendBack
    }
}

/// A Codex review and what came of it: a single review of a folder, or a loop over one
/// subagent's work (review, the same subagent fixes, review again) until clean or out of rounds.
public struct CodexReview: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// You (or @codex) asked for one review.
        case single
        /// A subagent's work, looped until clean.
        case loop
    }

    public enum State: String, Codable, Sendable {
        /// Codex is reading the change.
        case reviewing
        /// Findings went back to the subagent; waiting for it to report.
        case fixing
        /// Nothing (left) to fix at the chosen level.
        case clean
        /// A single review found things; they wait for you.
        case open
        /// The loop reached its round limit with findings left.
        case stuck
        /// Codex could not run.
        case failed
        /// You stopped it, or accepted it as is.
        case stopped
    }

    /// One pass of Codex over the change.
    public struct Round: Codable, Equatable, Sendable {
        public var number: Int
        public var at: Date
        public var found: Int
        /// How many went back to be fixed after it.
        public var sent: Int
        public var summary: String
    }

    public var id: UUID
    public var kind: Kind
    /// The bot it belongs to (`Workspace.mainBotID` or a project's id).
    public var ownerID: UUID
    /// The subagent whose work it is (a loop): the name the bot gave it.
    public var agent: String?
    public var title: String
    /// The git folder Codex reads, and the branch it compares with (nil: uncommitted only).
    public var folder: String
    public var base: String?
    /// What the change is meant to do, as the bot put it.
    public var note: String?
    public var state: State
    public var maxRounds: Int
    public var sendBack: CodexSendBack
    public var rounds: [Round]
    public var findings: [CodexFinding]
    public var summary: String
    public var error: String?
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: UUID = UUID(), kind: Kind, ownerID: UUID, agent: String? = nil, title: String, folder: String, base: String?, note: String? = nil, maxRounds: Int = 3, sendBack: CodexSendBack = .highAndMedium, at date: Date = Date()) {
        self.id = id
        self.kind = kind
        self.ownerID = ownerID
        self.agent = agent
        self.title = title
        self.folder = folder
        self.base = base
        self.note = note
        state = .reviewing
        self.maxRounds = maxRounds
        self.sendBack = sendBack
        rounds = []
        findings = []
        summary = ""
        createdAt = date
        updatedAt = date
    }

    public var round: Int { rounds.count }

    /// Still going: Codex reading, or a subagent fixing.
    public var isActive: Bool { state == .reviewing || state == .fixing }

    public func count(_ severity: CodexSeverity, status: Set<CodexFinding.Status> = [.open, .sent]) -> Int {
        findings.filter { $0.severity == severity && status.contains($0.status) }.count
    }

    public var openFindings: [CodexFinding] { findings.filter { $0.status == .open } }

    /// Takes in a round's findings. Ones sent to be fixed that Codex no longer reports are
    /// fixed; ones it reports again are open again (seen again); new ones are open. Skipped and
    /// fixed ones that come back are open again too.
    public mutating func absorb(_ output: CodexOutput, at date: Date = Date()) {
        let number = rounds.count + 1
        var unmatched = Array(findings.indices)
        var fresh: [CodexFinding] = []
        for item in output.findings {
            let scored = unmatched.enumerated().map { ($0.offset, Self.likeness(findings[$0.element], item)) }
            if let best = scored.filter({ $0.1 > 0 }).max(by: { $0.1 < $1.1 }) {
                let index = unmatched.remove(at: best.0)
                findings[index].lastSeenRound = number
                findings[index].line = item.line ?? findings[index].line
                findings[index].scenario = item.scenario.isEmpty ? findings[index].scenario : item.scenario
                findings[index].severity = item.severity
                // You skipped it: it stays skipped. Anything else Codex still sees is open.
                if findings[index].status != .skipped { findings[index].status = .open }
            } else {
                fresh.append(CodexFinding(item, round: number))
            }
        }
        for index in unmatched where findings[index].status == .sent {
            findings[index].status = .fixed
        }
        // A single review run again: what was open and is gone now counts as fixed too.
        if kind == .single {
            for index in unmatched where findings[index].status == .open { findings[index].status = .fixed }
        }
        findings += fresh
        summary = output.summary
        error = nil
        rounds.append(Round(number: number, at: date, found: output.findings.count, sent: 0, summary: output.summary))
        updatedAt = date
    }

    /// How sure it is that `item` is `finding` reported again: 0 not at all; 3 same title,
    /// 2 much the same words, 1 same severity a few lines away. Always the same file.
    static func likeness(_ finding: CodexFinding, _ item: CodexOutput.Item) -> Int {
        let a = (finding.file as NSString).lastPathComponent, b = (item.file as NSString).lastPathComponent
        guard a == b else { return 0 }
        if normalized(finding.title) == normalized(item.title) { return 3 }
        if similarity(finding.title, item.title) >= 0.6 { return 2 }
        if finding.severity == item.severity, let x = finding.line, let y = item.line, abs(x - y) <= 3 { return 1 }
        return 0
    }

    static func normalized(_ text: String) -> String {
        text.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    /// How many words two titles share, against the shorter one.
    static func similarity(_ a: String, _ b: String) -> Double {
        func words(_ text: String) -> Set<String> {
            Set(text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 })
        }
        let x = words(a), y = words(b)
        guard !x.isEmpty, !y.isEmpty else { return 0 }
        return Double(x.intersection(y).count) / Double(min(x.count, y.count))
    }

    /// What the loop does after a round.
    public enum Next: Equatable, Sendable {
        /// Nothing at the chosen level is open.
        case clean
        /// Send these back to the subagent.
        case fix([CodexFinding])
        /// Findings are left but the round limit is reached.
        case stuck([CodexFinding])
    }

    public func next() -> Next {
        let toFix = openFindings.filter { sendBack.includes($0.severity) }
        if toFix.isEmpty { return .clean }
        return round >= maxRounds ? .stuck(toFix) : .fix(toFix)
    }

    /// Marks these as sent to be fixed, and notes it on the latest round.
    public mutating func markSent(_ ids: Set<UUID>, at date: Date = Date()) {
        for index in findings.indices where ids.contains(findings[index].id) {
            findings[index].status = .sent
            findings[index].timesSent += 1
        }
        if !rounds.isEmpty { rounds[rounds.count - 1].sent = ids.count }
        updatedAt = date
    }

    public mutating func set(_ status: CodexFinding.Status, for ids: Set<UUID>, at date: Date = Date()) {
        for index in findings.indices where ids.contains(findings[index].id) {
            findings[index].status = status
        }
        updatedAt = date
    }

    /// One line on how it stands, for a row or a card.
    public var stateLine: String {
        let left = findings.filter { $0.status == .open || $0.status == .sent }.count
        let fixed = findings.filter { $0.status == .fixed }.count
        switch state {
        case .reviewing: return round == 0 ? "Codex reviewing" : "Round \(round + 1) · Codex reviewing"
        case .fixing:
            let sending = findings.filter { $0.status == .sent }.count
            return "Round \(round) · fixing \(sending) finding\(sending == 1 ? "" : "s")"
        case .clean:
            if kind == .single, fixed == 0 { return "Clean" }
            return round <= 1 && fixed == 0 ? "Codex: clean" : "Clean after \(round) round\(round == 1 ? "" : "s")"
        case .open: return "\(left) to look at"
        case .stuck: return "Max rounds · \(left) finding\(left == 1 ? "" : "s") left"
        case .failed: return "Codex could not run"
        case .stopped: return left == 0 ? "Stopped" : "Stopped · \(left) left"
        }
    }

    /// The report as Markdown, for copying.
    public var markdown: String {
        var lines = ["# \(title)", "", "\(folder)\(base.map { " against \($0)" } ?? "") · \(stateLine)"]
        if !summary.isEmpty { lines += ["", summary] }
        let byFile = Dictionary(grouping: findings, by: \.file)
        for file in byFile.keys.sorted() {
            lines += ["", "## \(file.isEmpty ? "(no file)" : file)"]
            for finding in byFile[file]!.sorted(by: { ($0.severity, $0.line ?? 0) < ($1.severity, $1.line ?? 0) }) {
                lines.append("- [\(finding.status.displayName)] **\(finding.severity.displayName)** \(finding.place): \(finding.title)" + (finding.scenario.isEmpty ? "" : " — \(finding.scenario)"))
            }
        }
        return lines.joined(separator: "\n")
    }
}

/// Every review, kept in `~/.claudecodebot/codex/reviews.json` (newest last, the oldest
/// finished ones dropped past a limit).
public struct CodexReviewStore: Sendable {
    public let url: URL
    static let kept = 60

    public init(url: URL) {
        self.url = url
    }

    public func load() -> [CodexReview] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([CodexReview].self, from: data)) ?? []
    }

    public func save(_ reviews: [CodexReview]) {
        var kept = reviews
        let finished = kept.filter { !$0.isActive }
        if finished.count > Self.kept {
            let drop = Set(finished.prefix(finished.count - Self.kept).map(\.id))
            kept.removeAll { drop.contains($0.id) }
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? encoder.encode(kept) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
