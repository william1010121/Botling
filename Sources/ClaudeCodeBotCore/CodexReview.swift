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

/// What a single review covers, picked on "Review with Codex".
public enum CodexScope: Codable, Equatable, Hashable, Sendable {
    /// Staged, unstaged and untracked changes.
    case uncommitted
    /// HEAD~1..HEAD.
    case lastCommit
    /// The commits not on `base`, plus what is not committed.
    case branch(base: String)
    /// One commit, by its hash.
    case commit(String)

    /// "Uncommitted changes", "This branch vs main": how the picker names it.
    public var displayName: String {
        switch self {
        case .uncommitted: "Uncommitted changes"
        case .lastCommit: "Last commit"
        case let .branch(base): "This branch vs \(base)"
        case let .commit(hash): "Commit \(hash)"
        }
    }
}

/// What "Review with Codex" offers for a repository, and the one it suggests: the branch
/// against main or master when on another branch, otherwise what is not committed.
public struct CodexScopeChoices: Equatable, Sendable {
    public var scopes: [CodexScope]
    /// The newest commits, to review one of them.
    public var recent: [GitDiff.Commit]
    public var suggested: CodexScope

    /// Asks git (blocking); nil outside a repository.
    public init?(folder: URL) {
        guard GitDiff.repositoryRoot(folder) != nil else { return nil }
        let branch = GitDiff.currentBranch(folder: folder)
        var scopes: [CodexScope] = [.uncommitted, .lastCommit]
        suggested = .uncommitted
        if let branch, !["main", "master"].contains(branch), let base = GitDiff.defaultBase(folder: folder) {
            scopes.append(.branch(base: base))
            suggested = .branch(base: base)
        }
        self.scopes = scopes
        recent = GitDiff.recentCommits(folder: folder)
    }
}

/// A spec Codex checks a change against: a text, Markdown or HTML file in the bot's folder or
/// your home folder.
public enum CodexSpec {
    public static let extensions: Set<String> = ["md", "markdown", "txt", "html", "htm"]

    /// The file at `path` (relative to `folder` unless it starts with / or ~) when Codex may read
    /// it as a spec; nil when it is missing, unreadable, of another kind or outside both folders.
    public static func validated(_ path: String, folder: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL? {
        let path = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        let given = path.hasPrefix("/") || path.hasPrefix("~") ? URL(filePath: (path as NSString).expandingTildeInPath) : folder.appending(path: path)
        let url = given.standardizedFileURL.resolvingSymlinksInPath()
        var isFolder: ObjCBool = false
        guard extensions.contains(url.pathExtension.lowercased()),
              FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder), !isFolder.boolValue,
              FileManager.default.isReadableFile(atPath: url.path) else { return nil }
        let roots = [folder, home].map { $0.standardizedFileURL.resolvingSymlinksInPath().path }
        return roots.contains { url.path.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") } ? url : nil
    }

    /// Specs to offer in the picker: the newest pages and notes in a bot's artifacts folder.
    public static func candidates(in artifacts: URL, limit: Int = 6) -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(at: artifacts, includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles)) ?? []
        func date(_ url: URL) -> Date { (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
        return Array(files.filter { extensions.contains($0.pathExtension.lowercased()) }.sorted { date($0) > date($1) }.prefix(limit))
    }
}

/// A component's `ccb.reviewWithCodex({scope, commit, spec})`, checked against the bot's
/// repository before anything runs.
public struct CodexComponentCall: Equatable, Sendable {
    /// Nil: the scope the picker would suggest.
    public var scope: CodexScope?
    public var spec: String?

    /// Nil for a call not to act on: no repository, an unknown scope, a commit that is not in it
    /// (a commit implies scope "commit"), "branch" while on main, or a spec `CodexSpec` refuses.
    public init?(_ body: [String: Any], folder: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        func text(_ key: String) -> String?? {
            switch body[key] {
            case nil, is NSNull: return .some(nil)
            case let value as String: let value = value.trimmingCharacters(in: .whitespacesAndNewlines); return .some(value.isEmpty ? nil : value)
            default: return nil
            }
        }
        guard let name = text("scope"), let commit = text("commit"), let spec = text("spec"),
              GitDiff.repositoryRoot(folder) != nil else { return nil }
        if let commit {
            guard name == nil || name == "commit", commit.range(of: "^[0-9a-fA-F]{4,40}$", options: .regularExpression) != nil,
                  let short = GitDiff.shortHash(commit + "^{commit}", folder: folder) else { return nil }
            scope = .commit(short)
        } else {
            switch name {
            case nil: scope = nil
            case "uncommitted": scope = .uncommitted
            case "lastCommit": scope = .lastCommit
            case "branch":
                guard let branch = CodexScopeChoices(folder: folder)?.scopes.first(where: { if case .branch = $0 { true } else { false } }) else { return nil }
                scope = branch
            default: return nil
            }
        }
        if let spec {
            guard let url = CodexSpec.validated(spec, folder: folder, home: home) else { return nil }
            self.spec = url.path
        } else {
            self.spec = nil
        }
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
        /// A single review found no changes in its scope; Codex did not run.
        case empty
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
    /// A single review's scope, the branch it was on, the commit "Last commit" meant in the
    /// latest round and how many files that round's change touched. Nil in reviews from before
    /// they were kept (and in loops): the scope then follows `base`.
    public var scope: CodexScope?
    public var branch: String?
    public var commit: String?
    public var changedFiles: Int?
    /// The spec Codex checks the change against, a full path (a single review).
    public var specPath: String?
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

    public init(id: UUID = UUID(), kind: Kind, ownerID: UUID, agent: String? = nil, title: String, folder: String, base: String?, scope: CodexScope? = nil, branch: String? = nil, spec: String? = nil, note: String? = nil, maxRounds: Int = 3, sendBack: CodexSendBack = .highAndMedium, at date: Date = Date()) {
        self.id = id
        self.kind = kind
        self.ownerID = ownerID
        self.agent = agent
        self.title = title
        self.folder = folder
        self.base = base
        self.scope = scope
        self.branch = branch
        specPath = spec
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

    /// What Codex reads and the report's diff shows: "Last commit" pinned to the commit it was.
    public var reviewedScope: CodexScope {
        let scope = scope ?? base.map { .branch(base: $0) } ?? .uncommitted
        if scope == .lastCommit, let commit { return .commit(commit) }
        return scope
    }

    /// "main...feature · 3 files · spec: plan.md": what the latest round covered (once it was
    /// counted) and the spec it was checked against; nil when there is neither.
    public var scopeLine: String? {
        var parts: [String] = []
        if let changedFiles {
            switch scope ?? base.map({ .branch(base: $0) }) ?? .uncommitted {
            case .uncommitted: parts.append("Uncommitted changes")
            case .lastCommit: parts.append("Last commit"); parts += commit.map { [$0] } ?? []
            case let .branch(base): parts.append("\(base)...\(branch ?? "HEAD")")
            case let .commit(hash): parts.append("Commit \(hash)")
            }
            if changedFiles > 0 { parts.append("\(changedFiles) file\(changedFiles == 1 ? "" : "s")") }
        }
        if let specPath { parts.append("spec: \((specPath as NSString).lastPathComponent)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

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
        case .empty: return "No changes to review"
        }
    }

    /// The report as Markdown, for copying.
    public var markdown: String {
        var lines = ["# \(title)", "", "\(folder)\(base.map { " against \($0)" } ?? "") · \(scopeLine.map { "\($0) · " } ?? "")\(stateLine)"]
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
