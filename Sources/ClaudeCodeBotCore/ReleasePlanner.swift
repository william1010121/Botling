import Foundation

/// The GitHub CLI (`gh`), run in a clone of the repo so it knows which repo is meant. Tests hand
/// in their own `run`, so nothing reaches GitHub.
public struct GitHubCLI: Sendable {
    public typealias Runner = @Sendable (_ arguments: [String], _ folder: URL) async -> (ok: Bool, output: String)
    let run: Runner?

    public init(_ run: @escaping Runner) {
        self.run = run
    }

    /// The real `gh` at `executable`; nil when it is not installed.
    public init(executable: URL? = GitHubCLI.locate()) {
        guard let executable else {
            run = nil
            return
        }
        run = { arguments, folder in
            await Task.detached {
                let process = Process()
                process.executableURL = executable
                process.arguments = arguments
                process.currentDirectoryURL = folder
                // No pager or prompts: gh is read like a file.
                var environment = ProcessInfo.processInfo.environment
                environment["GH_PROMPT_DISABLED"] = "1"
                environment["GH_PAGER"] = ""
                environment["NO_COLOR"] = "1"
                process.environment = environment
                let output = Pipe()
                let errors = Pipe()
                process.standardOutput = output
                process.standardError = errors
                do {
                    try process.run()
                } catch {
                    return (false, error.localizedDescription)
                }
                let data = output.fileHandleForReading.readDataToEndOfFile()
                let problem = errors.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let ok = process.terminationStatus == 0
                return (ok, String(decoding: ok ? data : problem, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
            }.value
        }
    }

    /// gh from the usual places.
    public static func locate() -> URL? {
        ClaudeExecutableLocator(command: "gh").installed().first
    }

    public static let notInstalled = "The GitHub CLI (gh) isn't installed. Install it (brew install gh), then sign in with gh auth login."

    /// What `gh` printed, or why it failed.
    func output(_ arguments: [String], in folder: URL) async throws -> String {
        guard let run else { throw GitHubError(message: Self.notInstalled) }
        let result = await run(arguments, folder)
        guard result.ok else { throw GitHubError(message: result.output.isEmpty ? "gh \(arguments.prefix(2).joined(separator: " ")) failed." : result.output) }
        return result.output
    }

    /// Open PRs labelled `community-feature`, most 👍 first.
    public func communityPRs(in folder: URL) async throws -> [CommunityPR] {
        try await CommunityPR.parse(output(["pr", "list", "--label", CommunityPR.label, "--state", "open", "--limit", "100",
                                      "--json", "number,title,author,url,isDraft,reactionGroups"], in: folder))
    }

    /// The repo's owner (admin or maintainer) may pick what goes into the next version.
    public func mayPick(in folder: URL) async -> Bool {
        guard let text = try? await output(["repo", "view", "--json", "viewerPermission"], in: folder),
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let permission = object["viewerPermission"] as? String else { return false }
        return ["ADMIN", "MAINTAIN"].contains(permission)
    }

    /// A 👍 on PR `number`, as you, on GitHub. Voting twice keeps one.
    public func vote(_ number: Int, in folder: URL) async throws {
        _ = try await output(["api", "-X", "POST", "repos/{owner}/{repo}/issues/\(number)/reactions", "-f", "content=+1"], in: folder)
    }
}

public struct GitHubError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
}

/// A feature someone shared as a PR, and how many 👍 it has.
public struct CommunityPR: Identifiable, Equatable, Sendable {
    public static let label = "community-feature"

    public var number: Int
    public var title: String
    public var author: String
    public var url: URL?
    public var votes: Int
    public var isDraft: Bool

    public var id: Int { number }

    public init(number: Int, title: String, author: String, url: URL? = nil, votes: Int, isDraft: Bool = false) {
        self.number = number
        self.title = title
        self.author = author
        self.url = url
        self.votes = votes
        self.isDraft = isDraft
    }

    private struct Raw: Decodable {
        struct Author: Decodable { var login: String }
        struct Group: Decodable {
            struct Users: Decodable { var totalCount: Int }
            var content: String
            var users: Users
        }
        var number: Int
        var title: String
        var author: Author?
        var url: String?
        var isDraft: Bool?
        var reactionGroups: [Group]?
    }

    /// `gh pr list --json` output, most 👍 first (on a tie, the older PR). Other reactions are
    /// not votes.
    public static func parse(_ json: String) throws -> [CommunityPR] {
        try JSONDecoder().decode([Raw].self, from: Data(json.utf8)).map { raw in
            CommunityPR(number: raw.number, title: raw.title, author: raw.author?.login ?? "",
                        url: raw.url.flatMap(URL.init(string:)),
                        votes: raw.reactionGroups?.first { $0.content == "THUMBS_UP" }?.users.totalCount ?? 0,
                        isDraft: raw.isDraft ?? false)
        }
        .sorted { ($1.votes, $0.number) < ($0.votes, $1.number) }
    }
}

/// What the owner picked for the next version, kept in `<root>/release-plan.json`.
public struct ReleasePlan: Codable, Equatable, Sendable {
    public var picked: Set<Int> = []

    public init(picked: Set<Int> = []) {
        self.picked = picked
    }

    public static func load(from file: URL) -> ReleasePlan {
        (try? JSONDecoder().decode(ReleasePlan.self, from: Data(contentsOf: file))) ?? ReleasePlan()
    }

    public func save(to file: URL) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(self).write(to: file, options: .atomic)
    }
}

/// Settings → Release planner: everyone sees the shared features ranked by 👍 and can vote; the
/// repo's owner also picks which go into the next version.
@MainActor
public final class ReleasePlanner: ObservableObject {
    @Published public private(set) var prs: [CommunityPR] = []
    @Published public private(set) var canPick = false
    @Published public private(set) var picked: Set<Int>
    /// PRs you voted on from here this session.
    @Published public private(set) var voted: Set<Int> = []
    @Published public private(set) var loading = false
    @Published public private(set) var problem: String?

    /// A clone of the repo (the developer project), where gh runs; nil without developer mode.
    public let folder: URL?
    let planFile: URL
    let gitHub: GitHubCLI

    public init(folder: URL?, planFile: URL, gitHub: GitHubCLI = GitHubCLI()) {
        self.folder = folder
        self.planFile = planFile
        self.gitHub = gitHub
        picked = ReleasePlan.load(from: planFile).picked
    }

    /// Picked PRs, most 👍 first.
    public var pickedPRs: [CommunityPR] {
        prs.filter { picked.contains($0.number) }
    }

    /// Reads the PRs and whether you may pick. Picks of PRs no longer open are dropped.
    public func refresh() async {
        guard let folder else {
            problem = "Turn on Developer mode with Botling's source as its project to see shared features."
            return
        }
        loading = true
        defer { loading = false }
        do {
            prs = try await gitHub.communityPRs(in: folder)
            canPick = await gitHub.mayPick(in: folder)
            problem = nil
            let open = Set(prs.map(\.number))
            if !picked.isSubset(of: open) {
                picked.formIntersection(open)
                ReleasePlan(picked: picked).save(to: planFile)
            }
        } catch {
            prs = []
            canPick = false
            problem = error.localizedDescription
        }
    }

    /// A 👍 from you on GitHub, then the list again.
    public func vote(_ number: Int) async {
        guard let folder else { return }
        do {
            try await gitHub.vote(number, in: folder)
            voted.insert(number)
            await refresh()
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Picks PR `number` for the next version, or takes it back. Only the owner may.
    public func togglePick(_ number: Int) {
        guard canPick else { return }
        if picked.contains(number) { picked.remove(number) } else { picked.insert(number) }
        ReleasePlan(picked: picked).save(to: planFile)
    }
}

extension Workspace {
    /// Where the release planner keeps your picks.
    public var releasePlanFile: URL { root.appending(path: "release-plan.json") }

    /// A planner for the developer project's repo.
    public func makeReleasePlanner(gitHub: GitHubCLI = GitHubCLI()) -> ReleasePlanner {
        ReleasePlanner(folder: developerProject?.folder, planFile: releasePlanFile, gitHub: gitHub)
    }

    /// The owner's picks go to the developer project's manager, to merge and write release
    /// notes for. False when there is no developer project or nothing was picked.
    @discardableResult
    public func handOffRelease(_ picks: [CommunityPR]) -> Bool {
        guard !picks.isEmpty, let developer = developerProject, let manager = managers[developer.id] else { return false }
        let list = picks.map { pr in
            "- #\(pr.number) \(pr.title) (@\(pr.author), 👍 \(pr.votes))\(pr.url.map { " \($0.absoluteString)" } ?? "")"
        }.joined(separator: "\n")
        manager.relay("""
        (App) The user picked these community PRs (label \(CommunityPR.label)) for the next version, most 👍 first:
        \(list)

        For each, in a worktree of its own: check it out (gh pr checkout <number>), read the change, and run the tests. Merge the ones that pass into main; if one conflicts, fails its tests, or changes what bots are told or allowed to do, stop and tell the user instead of merging it. Then write the release notes for them under "## Unreleased" in CHANGELOG.md, crediting each author, and say in a sentence or two what went in. Do not push, tag or close PRs unless the user asks.
        """)
        return true
    }
}
