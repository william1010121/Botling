import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A pretend `gh`: answers from what the test set, and keeps every call. Nothing reaches GitHub.
final class FakeGitHub: @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [(arguments: [String], folder: URL)] = []
    private var _prs: String = "[]"
    private var _permission = "ADMIN"
    private var _failure: String?

    var calls: [(arguments: [String], folder: URL)] { lock.withLock { _calls } }
    var prs: String {
        get { lock.withLock { _prs } }
        set { lock.withLock { _prs = newValue } }
    }
    var permission: String {
        get { lock.withLock { _permission } }
        set { lock.withLock { _permission = newValue } }
    }
    var failure: String? {
        get { lock.withLock { _failure } }
        set { lock.withLock { _failure = newValue } }
    }

    var cli: GitHubCLI {
        GitHubCLI { [self] arguments, folder in
            lock.withLock { _calls.append((arguments, folder)) }
            if let failure { return (false, failure) }
            switch arguments.first {
            case "pr": return (true, prs)
            case "repo": return (true, #"{"viewerPermission":"\#(permission)"}"#)
            default: return (true, "{}")
            }
        }
    }

    /// One PR as `gh pr list --json` prints it.
    static func pr(_ number: Int, _ title: String, votes: Int, by login: String = "someone", draft: Bool = false, hearts: Int = 0) -> String {
        var groups: [String] = []
        if votes > 0 { groups.append(#"{"content":"THUMBS_UP","users":{"totalCount":\#(votes)}}"#) }
        if hearts > 0 { groups.append(#"{"content":"HEART","users":{"totalCount":\#(hearts)}}"#) }
        return #"{"number":\#(number),"title":"\#(title)","author":{"login":"\#(login)"},"url":"https://github.com/o/r/pull/\#(number)","isDraft":\#(draft),"updatedAt":"2026-10-20T10:00:00Z","reactionGroups":[\#(groups.joined(separator: ","))]}"#
    }

    static func list(_ prs: String...) -> String { "[" + prs.joined(separator: ",") + "]" }
}

/// The release planner: community PRs (label `community-feature`) ranked by 👍, voted on from the
/// app, and, for the repo's owner, picked for the next version and handed to the manager.
@MainActor
struct ReleasePlannerTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-release-\(UUID().uuidString)")
    var folder: URL { root.appending(path: "code/ClaudeCodeBot") }
    var planFile: URL { root.appending(path: "ccb/release-plan.json") }

    @Test func prsAreRankedByThumbsUpOnly() throws {
        let json = FakeGitHub.list(
            FakeGitHub.pr(7, "Dark mode", votes: 2, hearts: 9),
            FakeGitHub.pr(3, "Voice input", votes: 5, by: "amy"),
            FakeGitHub.pr(9, "Emoji picker", votes: 0, draft: true),
            FakeGitHub.pr(4, "Tabs", votes: 2)
        )
        let prs = try CommunityPR.parse(json)
        #expect(prs.map(\.number) == [3, 4, 7, 9]) // ties: the older PR first
        #expect(prs[0].votes == 5)
        #expect(prs[0].author == "amy")
        #expect(prs[0].url?.absoluteString == "https://github.com/o/r/pull/3")
        #expect(prs[2].votes == 2) // hearts are not votes
        #expect(prs[3].isDraft)
        #expect(throws: (any Error).self) { try CommunityPR.parse("not json") }
    }

    @Test func loadingAsksGhForCommunityPRsInTheSourceFolder() async {
        let gh = FakeGitHub()
        gh.prs = FakeGitHub.list(FakeGitHub.pr(1, "A", votes: 1), FakeGitHub.pr(2, "B", votes: 3))
        let planner = ReleasePlanner(folder: folder, planFile: planFile, gitHub: gh.cli)
        await planner.refresh()
        #expect(planner.prs.map(\.number) == [2, 1])
        #expect(planner.problem == nil)
        let list = gh.calls.first { $0.arguments.first == "pr" }
        #expect(list?.folder == folder)
        #expect(list?.arguments.starts(with: ["pr", "list", "--label", "community-feature", "--state", "open"]) == true)
        #expect(list?.arguments.contains { $0.contains("reactionGroups") } == true)
        // Only reads: nothing that changes GitHub.
        #expect(!gh.calls.contains { $0.arguments.contains("POST") || $0.arguments.contains("merge") })
    }

    @Test func onlyTheOwnerMayPick() async {
        let gh = FakeGitHub()
        gh.prs = FakeGitHub.list(FakeGitHub.pr(1, "A", votes: 1))
        for (permission, owner) in [("ADMIN", true), ("MAINTAIN", true), ("WRITE", false), ("READ", false)] {
            gh.permission = permission
            let planner = ReleasePlanner(folder: folder, planFile: planFile, gitHub: gh.cli)
            await planner.refresh()
            #expect(planner.canPick == owner, "\(permission)")
            planner.togglePick(1)
            #expect(planner.picked.contains(1) == owner, "\(permission)")
            if owner { planner.togglePick(1) }
        }
    }

    @Test func aVoteIsAThumbsUpOnThePRThenTheListIsReloaded() async {
        let gh = FakeGitHub()
        gh.prs = FakeGitHub.list(FakeGitHub.pr(1, "A", votes: 2), FakeGitHub.pr(2, "B", votes: 1))
        let planner = ReleasePlanner(folder: folder, planFile: planFile, gitHub: gh.cli)
        await planner.refresh()
        gh.prs = FakeGitHub.list(FakeGitHub.pr(1, "A", votes: 2), FakeGitHub.pr(2, "B", votes: 3))
        await planner.vote(2)
        let post = gh.calls.first { $0.arguments.contains("POST") }
        #expect(post?.arguments == ["api", "-X", "POST", "repos/{owner}/{repo}/issues/2/reactions", "-f", "content=+1"])
        #expect(post?.folder == folder)
        #expect(planner.prs.map(\.number) == [2, 1])
        #expect(planner.voted.contains(2))
    }

    @Test func picksAreKeptAndClosedPRsDropOut() async {
        let gh = FakeGitHub()
        gh.prs = FakeGitHub.list(FakeGitHub.pr(1, "A", votes: 1), FakeGitHub.pr(2, "B", votes: 4))
        let first = ReleasePlanner(folder: folder, planFile: planFile, gitHub: gh.cli)
        await first.refresh()
        first.togglePick(1)
        first.togglePick(2)
        #expect(first.pickedPRs.map(\.number) == [2, 1]) // by votes

        let again = ReleasePlanner(folder: folder, planFile: planFile, gitHub: gh.cli)
        #expect(again.picked == [1, 2])
        gh.prs = FakeGitHub.list(FakeGitHub.pr(2, "B", votes: 4))
        await again.refresh()
        #expect(again.picked == [2])
        #expect(ReleasePlan.load(from: planFile).picked == [2])
    }

    @Test func withoutGhOrSignInItSaysWhy() async {
        let gh = FakeGitHub()
        gh.failure = "To get started with GitHub CLI, please run:  gh auth login"
        let planner = ReleasePlanner(folder: folder, planFile: planFile, gitHub: gh.cli)
        await planner.refresh()
        #expect(planner.prs.isEmpty)
        #expect(planner.problem?.contains("gh auth login") == true)
        #expect(!planner.canPick)

        let missing = ReleasePlanner(folder: folder, planFile: planFile, gitHub: GitHubCLI(executable: nil))
        await missing.refresh()
        #expect(missing.problem?.contains("GitHub CLI") == true)

        let noSource = ReleasePlanner(folder: nil, planFile: planFile, gitHub: gh.cli)
        let before = gh.calls.count
        await noSource.refresh()
        #expect(gh.calls.count == before)
        #expect(noSource.problem?.contains("Developer mode") == true)
    }

    @Test func picksGoToTheDeveloperManagerToMergeAndWriteReleaseNotes() throws {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let picks = try CommunityPR.parse(FakeGitHub.list(FakeGitHub.pr(12, "Voice input", votes: 5, by: "amy"), FakeGitHub.pr(8, "Tabs", votes: 2)))
        #expect(!workspace.handOffRelease(picks)) // no developer mode yet

        let project = workspace.addProject(folder: folder, select: false)
        workspace.setDeveloperMode(true, project: project.id)
        #expect(!workspace.handOffRelease([]))
        #expect(workspace.handOffRelease(picks))
        let manager = try #require(workspace.bot(for: project))
        let note = try #require(manager.messages.last { $0.role == .relay }?.text)
        #expect(note.contains("#12 Voice input"))
        #expect(note.contains("@amy"))
        #expect(note.contains("👍 5"))
        #expect(note.contains("#8 Tabs"))
        #expect(note.contains("CHANGELOG.md"))
        #expect(note.contains("Unreleased"))
        #expect(workspace.releasePlanFile == root.appending(path: "ccb/release-plan.json"))
    }
}
