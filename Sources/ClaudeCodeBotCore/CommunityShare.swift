import Foundation

/// Sharing a feature you built in developer mode back to Botling: your features are the
/// local branches ahead of upstream, each is checked (up to date, no keys or personal paths in
/// what it adds), and shared as a pull request with the community-feature label, where others
/// vote on it with 👍 and the owner picks what goes into the next release.
public enum CommunityShare {
    /// Where shared features go.
    public static let upstream = "william1010121/ClaudeCodeBot"
    public static let label = "community-feature"
    /// The branch of `upstream` pull requests go to, and features are compared with.
    public static let upstreamBranch = "main"

    /// One feature: a local branch with commits upstream does not have.
    public struct Feature: Equatable, Sendable {
        public var branch: String
        /// Its first commit's subject: the pull request's title.
        public var title: String
        public var commits: Int
        /// Files it changes, sorted.
        public var files: [String]
        /// Every commit's subject, oldest first.
        public var subjects: [String]

        public init(branch: String, title: String, commits: Int, files: [String], subjects: [String]) {
            self.branch = branch
            self.title = title
            self.commits = commits
            self.files = files
            self.subjects = subjects
        }

        /// For its line on the list: "bot/x · 2 commits · 3 files".
        public var summary: String {
            "\(branch) · \(commits) commit\(commits == 1 ? "" : "s") · \(files.count) file\(files.count == 1 ? "" : "s")"
        }
    }

    /// One line of the checklist; a failed one keeps the feature from being shared.
    public struct Check: Equatable, Sendable {
        public enum State: Sendable { case ok, warning, failed }
        public var state: State
        public var text: String

        public init(state: State, text: String) {
            self.state = state
            self.text = text
        }

        var line: String {
            switch state {
            case .ok: "✓ \(text)"
            case .warning: "! \(text)"
            case .failed: "✗ \(text)"
            }
        }
    }

    // MARK: Reading the repository

    /// What features are compared with: upstream's `upstreamBranch` when that remote is there,
    /// else your fork's, else your own default branch.
    public static func base(in repo: URL) -> String {
        let local = GitDiff.defaultBranch(folder: repo) ?? upstreamBranch
        for ref in ["upstream/\(upstreamBranch)", "origin/\(upstreamBranch)", local]
        where git(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]) != nil {
            return ref
        }
        return local
    }

    /// The local branches ahead of `base` (the default branch and upstream's own aside), by name.
    public static func features(in repo: URL, base: String? = nil) -> [Feature] {
        let base = base ?? self.base(in: repo)
        let branches = (git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "")
            .split(separator: "\n").map(String.init)
        let mainline = Set([upstreamBranch, GitDiff.defaultBranch(folder: repo)].compactMap { $0})
        return branches.filter { !mainline.contains($0) }.sorted().compactMap { feature($0, in: repo, base: base) }
    }

    /// `branch` as a feature; nil when it has nothing `base` lacks (or is not a branch).
    public static func feature(_ branch: String, in repo: URL, base: String) -> Feature? {
        guard !branch.hasPrefix("-"),
              let log = git(repo, ["log", "--reverse", "--format=%s", "\(base)..\(branch)", "--"]) else { return nil }
        let subjects = log.split(separator: "\n").map(String.init)
        guard let title = subjects.first else { return nil }
        let files = (git(repo, ["diff", "--name-only", "\(base)...\(branch)", "--"]) ?? "")
            .split(separator: "\n").map(String.init).sorted()
        return Feature(branch: branch, title: title, commits: subjects.count, files: files, subjects: subjects)
    }

    /// Your fork's owner on GitHub, from origin's URL; nil when origin is not on GitHub.
    public static func owner(in repo: URL) -> String? {
        owner(ofRemote: git(repo, ["remote", "get-url", "origin"]) ?? "")
    }

    /// The owner in a GitHub remote URL (https, ssh or scp-like); nil for anything else.
    public static func owner(ofRemote url: String) -> String? {
        let url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = url.range(of: #"github\.com[:/]([A-Za-z0-9_.-]+)/"#, options: .regularExpression) else { return nil }
        let owner = url[range].dropFirst("github.com/".count).dropLast()
        return owner.isEmpty ? nil : String(owner)
    }

    /// Checks `feature` before it goes out. `home` is your home folder, whose path must not be in it.
    public static func checklist(for feature: Feature, in repo: URL, base: String, home: String = NSHomeDirectory()) -> [Check] {
        var checks: [Check] = []
        let current = git(repo, ["merge-base", "--is-ancestor", base, feature.branch]) != nil
        checks.append(current
            ? Check(state: .ok, text: "Up to date with \(base)")
            : Check(state: .warning, text: "Behind \(base): your Manager can rebase it first, or it goes as it is"))
        let diff = git(repo, ["diff", "-U0", "\(base)...\(feature.branch)", "--"]) ?? ""
        let findings = privacyFindings(in: diff, home: home)
        checks.append(findings.isEmpty
            ? Check(state: .ok, text: "Privacy check: no keys, tokens or personal paths in the diff")
            : Check(state: .failed, text: "Privacy check: " + findings.joined(separator: "; ")))
        checks.append(owner(in: repo).map { Check(state: .ok, text: "Your fork: \($0)/ClaudeCodeBot") }
            ?? Check(state: .failed, text: "No fork on GitHub: origin should be your fork of \(upstream) (your Manager can set it up)"))
        checks.append(Check(state: .ok, text: "Description drafted from its \(feature.commits) commit\(feature.commits == 1 ? "" : "s")"))
        // Only known once the pull request opens (the label may be missing on upstream, or not
        // yours to add): a warning, not a ✓.
        checks.append(Check(state: .warning, text: "Label: \(label), added when the pull request opens (made on \(upstream) if it is missing); if GitHub refuses it, you are told"))
        return checks
    }

    // MARK: The privacy check

    static let secretPatterns: [(pattern: String, what: String)] = [
        (#"sk-ant-[A-Za-z0-9_-]{16,}"#, "an Anthropic API key"),
        (#"\bsk-(proj-)?[A-Za-z0-9]{20,}"#, "an OpenAI API key"),
        (#"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"#, "a GitHub token"),
        (#"\bAKIA[0-9A-Z]{16}\b"#, "an AWS access key"),
        (#"\bxox[abpr]-[A-Za-z0-9-]{10,}"#, "a Slack token"),
        (#"-----BEGIN [A-Z ]*PRIVATE KEY-----"#, "a private key"),
    ]

    /// Keys, tokens and your home folder's path in the lines `diff` adds, one per file and kind:
    /// "file: what".
    public static func privacyFindings(in diff: String, home: String) -> [String] {
        var file = ""
        var found: [String] = []
        let home = home.hasSuffix("/") ? String(home.dropLast()) : home
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+++ ") {
                file = line.dropFirst(4).hasPrefix("b/") ? String(line.dropFirst(6)) : String(line.dropFirst(4))
                continue
            }
            guard line.hasPrefix("+") else { continue }
            let added = String(line.dropFirst())
            var kinds = secretPatterns.filter { added.range(of: $0.pattern, options: .regularExpression) != nil }.map(\.what)
            if !home.isEmpty, home != "/", added.contains(home + "/") || added.hasSuffix(home) {
                kinds.append("your home folder's path")
            }
            for kind in kinds where !found.contains("\(file): \(kind)") {
                found.append("\(file): \(kind)")
            }
        }
        return found
    }

    // MARK: The pull request

    /// `gh pr create` for `feature`, from `owner`'s fork to Botling's main; `label: false`
    /// leaves the label out (someone without triage rights on Botling may not add one).
    public static func pullRequest(for feature: Feature, owner: String, label: Bool) -> [String] {
        var command = ["gh", "pr", "create", "--repo", upstream, "--base", upstreamBranch,
                       "--head", "\(owner):\(feature.branch)", "--title", feature.title, "--body", body(for: feature)]
        if label { command += ["--label", self.label] }
        return command
    }

    /// `gh label create` for the community-feature label on Botling, for when it is
    /// missing there (gh says "already exists" when it is not).
    public static func labelCreation() -> [String] {
        ["gh", "label", "create", label, "--repo", upstream, "--color", "0E8A16",
         "--description", "A feature shared from developer mode with /share"]
    }

    static func body(for feature: Feature) -> String {
        var lines = ["Shared from Botling's developer mode with /share.", "", "Commits:"]
        lines += feature.subjects.map { "- \($0)" }
        lines += ["", "Files:"]
        lines += feature.files.prefix(30).map { "- `\($0)`" }
        if feature.files.count > 30 { lines.append("- …and \(feature.files.count - 30) more") }
        lines += ["", "Vote with 👍 on this pull request; the owner picks which \(label)s go into the next release."]
        return lines.joined(separator: "\n")
    }

    // MARK: The cards

    /// The most features the list card offers (it is a card of buttons, not a list to scroll).
    public static let listedFeatures = 8

    /// The list card's words and choices: one per feature offered (`offered`, the first
    /// `listedFeatures`), then "Not now".
    public static func listCard(_ features: [Feature], base: String) -> (text: String, choices: [Choice], offered: [Feature]) {
        let text = """
        **Which feature do you want to share?**

        These branches have commits \(base) does not. The one you pick is checked first (up to date, no keys or personal paths), then shared as a pull request to \(upstream).
        """
        let offered = Array(features.prefix(listedFeatures))
        let choices = offered.map { Choice(label: $0.title, detail: $0.summary) } + [Choice(label: "Not now")]
        return (text, choices, offered)
    }

    /// The checklist card's words; ready when nothing failed.
    public static func checklistCard(_ feature: Feature, checks: [Check], owner: String?) -> (text: String, ready: Bool) {
        let ready = !checks.contains { $0.state == .failed }
        var lines = ["**Share \"\(feature.title)\"** (`\(feature.summary)`)", ""]
        lines += checks.map(\.line)
        lines.append("")
        if ready {
            lines.append("Opens a pull request from \(owner ?? "your")/ClaudeCodeBot to \(upstream) and pushes \(feature.branch) to your fork first. Others vote on it with 👍; the owner picks which go into the next release.")
        } else {
            lines.append("Not ready to share: fix what is marked ✗ (your Manager can), then /share again.")
        }
        return (lines.joined(separator: "\n"), ready)
    }

    // MARK: git

    static let gitURL: URL? = PluginLibraryGit.locate()

    /// Runs git in `repo` to read it; its output, or nil when it fails.
    static func git(_ repo: URL, _ arguments: [String]) -> String? {
        guard let gitURL else { return nil }
        let process = Process()
        process.executableURL = gitURL
        process.arguments = ["-C", repo.path] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }

    /// Runs `git` or `gh` (the first argument) in `folder` for real: pushing and opening the
    /// pull request. Its output and errors together.
    public static func run(_ arguments: [String], in folder: URL) -> (ok: Bool, output: String) {
        guard let tool = arguments.first else { return (false, "Nothing to run.") }
        let executable: URL? = switch tool {
        case "git": gitURL
        case "gh": GitHubCLI.locate()
        default: nil
        }
        guard let executable else {
            return (false, tool == "gh" ? "The GitHub CLI (gh) is not installed: brew install gh, then gh auth login." : "\(tool) not found.")
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = Array(arguments.dropFirst())
        process.currentDirectoryURL = folder
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["GH_PROMPT_DISABLED"] = "1"
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do { try process.run() } catch { return (false, error.localizedDescription) }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus == 0, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
