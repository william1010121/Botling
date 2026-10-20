import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Runs git in `folder` as a test author.
func runGit(_ folder: URL, _ arguments: String...) {
    let process = Process()
    process.executableURL = URL(filePath: "/usr/bin/git")
    process.arguments = ["-C", folder.path, "-c", "user.email=t@t", "-c", "user.name=t"] + arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try? process.run()
    process.waitUntilExit()
}

/// What a single review covers: the prompt, the diff, the card's line, and old reports.
struct CodexScopeTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-codexscope-\(UUID().uuidString)")

    @Test func eachScopeTellsCodexWhatToRead() {
        #expect(CodexPrompts.review(scope: .uncommitted).contains("staged, unstaged and untracked (git status, git diff HEAD)"))
        #expect(CodexPrompts.review(scope: .lastCommit).contains("the last commit only (git diff HEAD~1 HEAD"))
        #expect(CodexPrompts.review(scope: .branch(base: "main")).contains("git diff main...HEAD"))
        #expect(CodexPrompts.review(scope: .commit("ee988b9")).contains("the commit ee988b9 only (git show ee988b9)"))
        // The base form still means what it did.
        #expect(CodexPrompts.review(base: "main") == CodexPrompts.review(scope: .branch(base: "main")))
        #expect(CodexPrompts.review(base: nil) == CodexPrompts.review(scope: .uncommitted))
        #expect(!CodexPrompts.review(scope: .uncommitted).contains("spec"))
        let spec = CodexPrompts.review(scope: .uncommitted, spec: "/p/plan.md")
        #expect(spec.contains("Read the spec at /p/plan.md and check, point by point"))
    }

    @Test func eachScopeLoadsItsOwnDiff() async throws {
        let folder = root.appending(path: "repo")
        try makeRepository(folder)
        try Data("new\n".utf8).write(to: folder.appending(path: "b.txt"))
        // Uncommitted: the edit to a.txt and the untracked b.txt, as all-added lines.
        let uncommitted = await GitDiff.load(folder: folder, scope: .uncommitted)
        #expect(uncommitted.files.map(\.path).sorted() == ["a.txt", "b.txt"])
        #expect(uncommitted.file("a.txt")?.hunks.flatMap(\.lines).filter { $0.kind == .added }.map(\.text) == ["three"])
        #expect(uncommitted.file("b.txt")?.hunks.flatMap(\.lines).map(\.text) == ["new"])
        // The branch: both commits' worth on a.txt, plus b.txt.
        let branch = await GitDiff.load(folder: folder, scope: .branch(base: "main"))
        #expect(branch.file("a.txt")?.hunks.flatMap(\.lines).filter { $0.kind == .added }.map(\.text) == ["two", "three"])
        #expect(branch.files.count == 2)
        // The last commit: only "two", nothing uncommitted.
        let last = await GitDiff.load(folder: folder, scope: .lastCommit)
        #expect(last.files.map(\.path) == ["a.txt"])
        #expect(last.file("a.txt")?.hunks.flatMap(\.lines).filter { $0.kind == .added }.map(\.text) == ["two"])
        // One commit from the list: the first, which added "one" (a root commit, too).
        let recent = GitDiff.recentCommits(folder: folder)
        #expect(recent.map(\.subject) == ["two", "one"])
        let first = await GitDiff.load(folder: folder, scope: .commit(recent[1].hash))
        #expect(first.file("a.txt")?.hunks.flatMap(\.lines).map(\.text) == ["one"])
        #expect(GitDiff.shortHash("HEAD", folder: folder) == recent[0].hash)
        #expect(GitDiff.currentBranch(folder: folder) == "feature")
    }

    @Test func thePickerSuggestsTheBranchOffMainAndUncommittedOnIt() throws {
        let folder = root.appending(path: "repo")
        try makeRepository(folder)
        let off = try #require(CodexScopeChoices(folder: folder))
        #expect(off.scopes == [.uncommitted, .lastCommit, .branch(base: "main")])
        #expect(off.suggested == .branch(base: "main"))
        #expect(off.recent.count == 2)
        runGit(folder, "stash", "-q")
        runGit(folder, "checkout", "-q", "main")
        let on = try #require(CodexScopeChoices(folder: folder))
        #expect(on.scopes == [.uncommitted, .lastCommit])
        #expect(on.suggested == .uncommitted)
        #expect(CodexScopeChoices(folder: root.appending(path: "nowhere")) == nil)
    }

    @Test func theCardSaysWhatWasReviewed() {
        var review = CodexReview(kind: .single, ownerID: UUID(), title: "Codex review · feature", folder: "/p", base: nil, scope: .uncommitted, branch: "feature")
        #expect(review.scopeLine == nil)
        review.changedFiles = 3
        #expect(review.scopeLine == "Uncommitted changes · 3 files")
        review.scope = .branch(base: "main")
        review.changedFiles = 1
        #expect(review.scopeLine == "main...feature · 1 file")
        review.scope = .lastCommit
        review.commit = "ee988b9"
        #expect(review.scopeLine == "Last commit · ee988b9 · 1 file")
        #expect(review.reviewedScope == .commit("ee988b9"))
        review.scope = .commit("abc1234")
        review.specPath = "/p/.bot/artifacts/plan.md"
        #expect(review.scopeLine == "Commit abc1234 · 1 file · spec: plan.md")
        review.state = .empty
        review.changedFiles = 0
        #expect(review.stateLine == "No changes to review")
        #expect(!review.isActive)
    }

    @Test func reviewsSavedBeforeScopesStillLoad() throws {
        let review = CodexReview(kind: .single, ownerID: UUID(), title: "Codex review · main", folder: "/p", base: "main", scope: .lastCommit, branch: "x", spec: "/p/s.md")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var object = try #require(JSONSerialization.jsonObject(with: encoder.encode([review])) as? [[String: Any]])
        for key in ["scope", "branch", "commit", "changedFiles", "specPath"] { object[0][key] = nil }
        let url = root.appending(path: "reviews.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        let loaded = try #require(CodexReviewStore(url: url).load().first)
        #expect(loaded.scope == nil && loaded.specPath == nil && loaded.changedFiles == nil)
        // Its scope follows the base, as it did, and the card has no scope line.
        #expect(loaded.reviewedScope == .branch(base: "main"))
        #expect(loaded.scopeLine == nil)
        // And the new fields come back as saved.
        CodexReviewStore(url: url).save([review])
        #expect(CodexReviewStore(url: url).load().first?.scope == .lastCommit)
    }

    @Test func aSpecMustBeAReadableTextFileInTheFolderOrHome() throws {
        let folder = root.appending(path: "repo"), home = root.appending(path: "home"), elsewhere = root.appending(path: "elsewhere")
        for dir in [folder.appending(path: ".bot/artifacts"), home, elsewhere] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        try Data("# Plan".utf8).write(to: folder.appending(path: ".bot/artifacts/plan.md"))
        try Data("x".utf8).write(to: folder.appending(path: "tool.sh"))
        try Data("notes".utf8).write(to: home.appending(path: "notes.txt"))
        try Data("far".utf8).write(to: elsewhere.appending(path: "far.md"))
        #expect(CodexSpec.validated(".bot/artifacts/plan.md", folder: folder, home: home)?.lastPathComponent == "plan.md")
        #expect(CodexSpec.validated(home.appending(path: "notes.txt").path, folder: folder, home: home) != nil)
        #expect(CodexSpec.validated("tool.sh", folder: folder, home: home) == nil)
        #expect(CodexSpec.validated(elsewhere.appending(path: "far.md").path, folder: folder, home: home) == nil)
        #expect(CodexSpec.validated("../elsewhere/far.md", folder: folder, home: home) == nil)
        #expect(CodexSpec.validated("missing.md", folder: folder, home: home) == nil)
        #expect(CodexSpec.validated(".bot/artifacts", folder: folder, home: home) == nil)
        #expect(CodexSpec.candidates(in: folder.appending(path: ".bot/artifacts")).map(\.lastPathComponent) == ["plan.md"])
    }

    @Test func aComponentCallIsCheckedBeforeItRuns() throws {
        let folder = root.appending(path: "repo"), home = root.appending(path: "home")
        try makeRepository(folder)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try Data("# Spec".utf8).write(to: folder.appending(path: "spec.md"))
        let hashes = GitDiff.recentCommits(folder: folder).map(\.hash)
        func call(_ body: [String: Any]) -> CodexComponentCall? { CodexComponentCall(body, folder: folder, home: home) }

        #expect(call([:])?.scope == nil)
        #expect(call(["scope": NSNull(), "commit": NSNull(), "spec": NSNull()]) == CodexComponentCall([:], folder: folder, home: home))
        #expect(call(["scope": "uncommitted"])?.scope == .uncommitted)
        #expect(call(["scope": "lastCommit"])?.scope == .lastCommit)
        #expect(call(["scope": "branch"])?.scope == .branch(base: "main"))
        // A commit implies scope "commit", and is kept by its short hash.
        #expect(call(["commit": hashes[1]])?.scope == .commit(hashes[1]))
        #expect(call(["scope": "commit", "commit": hashes[0]])?.scope == .commit(hashes[0]))
        #expect(call(["scope": "commit", "commit": hashes[0], "spec": "spec.md"])?.spec?.hasSuffix("/repo/spec.md") == true)
        // Bad calls: ignored.
        #expect(call(["scope": "everything"]) == nil)
        #expect(call(["scope": "commit"]) == nil)
        #expect(call(["scope": "uncommitted", "commit": hashes[0]]) == nil)
        #expect(call(["commit": "deadbeef"]) == nil)
        #expect(call(["commit": "HEAD; rm -rf ~"]) == nil)
        #expect(call(["commit": 42]) == nil)
        #expect(call(["spec": "/etc/hosts"]) == nil)
        #expect(call(["spec": "missing.md"]) == nil)
        #expect(CodexComponentCall([:], folder: root.appending(path: "nowhere"), home: home) == nil)
        runGit(folder, "stash", "-q")
        runGit(folder, "checkout", "-q", "main")
        #expect(call(["scope": "branch"]) == nil)
    }
}

/// "Review with Codex" with a scope picked, a spec, and nothing to review.
@MainActor
struct CodexScopedReviewTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-codexscoped-\(UUID().uuidString)")

    func makeWorkspace(codex: FakeCodex) -> Workspace {
        let fake = FakeLauncher()
        return Workspace(root: root.appending(path: "ccb"), codex: codex) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func nothingToReviewDoesNotRunCodexOrSayClean() async throws {
        let codex = FakeCodex()
        let workspace = makeWorkspace(codex: codex)
        let folder = root.appending(path: "code/tidy")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        runGit(folder, "init", "-q", "-b", "main")
        try Data("one\n".utf8).write(to: folder.appending(path: "a.txt"))
        runGit(folder, "add", ".")
        runGit(folder, "commit", "-qm", "one")
        let bot = try #require(workspace.bot(for: workspace.addProject(folder: folder)))

        let id = try #require(workspace.reviewWithCodex(bot))
        await eventually { workspace.codexReview(id)?.state == .empty }
        let review = try #require(workspace.codexReview(id))
        #expect(codex.requests.isEmpty)
        #expect(review.scope == .uncommitted && review.changedFiles == 0)
        #expect(review.stateLine == "No changes to review")
        #expect(review.scopeLine == "Uncommitted changes")
        #expect(bot.messages.last?.text.contains("no changes to review") == true)
    }

    @Test func aPickedScopeAndSpecAreRecordedAndRunAgainKeepsThem() async throws {
        let codex = FakeCodex([.success(CodexOutput(summary: "The commit is fine.")), .success(CodexOutput(summary: "Still fine."))])
        let workspace = makeWorkspace(codex: codex)
        let folder = root.appending(path: "code/repo")
        try makeRepository(folder)
        try Data("# Plan\n- two\n".utf8).write(to: folder.appending(path: "plan.md"))
        let bot = try #require(workspace.bot(for: workspace.addProject(folder: folder)))
        let head = try #require(GitDiff.shortHash("HEAD", folder: folder))

        let id = try #require(workspace.reviewWithCodex(bot, scope: .lastCommit, spec: folder.appending(path: "plan.md").path))
        await eventually { workspace.codexReview(id)?.state == .clean }
        let review = try #require(workspace.codexReview(id))
        #expect(review.commit == head && review.changedFiles == 1 && review.base == nil)
        #expect(review.scopeLine == "Last commit · \(head) · 1 file · spec: plan.md")
        #expect(review.summary == "The commit is fine.")
        #expect(codex.requests[0].prompt.contains("the commit \(head) only"))
        #expect(codex.requests[0].prompt.contains("Read the spec at \(folder.appending(path: "plan.md").path)"))
        // The report's diff is that commit, not the uncommitted edit.
        let diff = await workspace.codexDiff(for: id)
        #expect(diff.file("a.txt")?.hunks.flatMap(\.lines).filter { $0.kind == .added }.map(\.text) == ["two"])

        // A new commit, then Run again: still "Last commit" (the new one), still the spec.
        runGit(folder, "commit", "-qam", "three")
        let newer = try #require(GitDiff.shortHash("HEAD", folder: folder))
        workspace.rerunCodexReview(id)
        await eventually { workspace.codexReview(id)?.round == 2 && workspace.codexReview(id)?.state != .reviewing }
        #expect(workspace.codexReview(id)?.commit == newer)
        #expect(codex.requests[1].prompt.contains("the commit \(newer) only"))
        #expect(codex.requests[1].prompt.contains("Read the spec at"))
    }
}
