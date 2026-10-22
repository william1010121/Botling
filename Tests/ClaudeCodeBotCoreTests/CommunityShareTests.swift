import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Developer mode's /share: the developer project's chat lists the features you built (local
/// branches ahead of upstream), checks the one you pick (up to date, no keys or personal paths),
/// and opens a pull request for it to ClaudeCodeBot with the community-feature label. Pushing and
/// `gh` never run here: a fake records what would have.
@MainActor
struct CommunityShareTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-share-\(UUID().uuidString)")

    /// What /share asked to run, in order, and what each answers.
    final class FakeRunner: @unchecked Sendable {
        private let lock = NSLock()
        private var _ran: [[String]] = []
        var answer: @Sendable ([String]) -> (ok: Bool, output: String) = { arguments in
            arguments.first == "gh" ? (true, "https://github.com/william1010121/ClaudeCodeBot/pull/42\n") : (true, "")
        }
        var ran: [[String]] { lock.withLock { _ran } }
        var runner: Workspace.ShareRunner {
            { [self] arguments, _ in
                lock.withLock { _ran.append(arguments) }
                return answer(arguments)
            }
        }
    }

    @discardableResult
    func git(_ repo: URL, _ arguments: String...) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", repo.path, "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "git \(arguments.joined(separator: " ")) failed")
        return String(decoding: data, as: UTF8.self)
    }

    func commit(_ repo: URL, _ file: String, _ text: String, _ subject: String) throws {
        let url = repo.appending(path: file)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        try git(repo, "add", file)
        try git(repo, "commit", "-q", "-m", subject)
    }

    /// A clone of a fork: main, a feature branch two commits ahead, one already merged, and
    /// origin pointing at the user's fork on GitHub (only configured; nothing is fetched).
    func makeRepo() throws -> URL {
        let repo = root.appending(path: "code/ClaudeCodeBot")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try git(repo, "init", "-q", "-b", "main")
        try commit(repo, "README.md", "ClaudeCodeBot\n", "Start")
        try git(repo, "remote", "add", "origin", "git@github.com:mei-lin/ClaudeCodeBot.git")
        try git(repo, "branch", "bot/merged")
        try git(repo, "checkout", "-q", "-b", "bot/pin-reactions")
        try commit(repo, "Web/src/pins.ts", "export const reactions = [];\n", "Add emoji reactions to pinned messages")
        try commit(repo, "Web/src/pins.css", ".reaction {}\n", "Style the reactions")
        try git(repo, "checkout", "-q", "main")
        return repo
    }

    func developerSetUp(_ fake: FakeLauncher, runner: FakeRunner) throws -> (Workspace, Workspace.Project, Bot) {
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        workspace.shareRunner = runner.runner
        let project = workspace.addProject(folder: try makeRepo(), select: false)
        workspace.setDeveloperMode(true, project: project.id)
        return (workspace, project, try #require(workspace.bot(for: project)))
    }

    // MARK: The pieces

    @Test func theFeaturesAreTheBranchesAheadOfUpstream() throws {
        let repo = try makeRepo()
        // No upstream or origin/main fetched: main is what they are compared with.
        #expect(CommunityShare.base(in: repo) == "main")
        let features = CommunityShare.features(in: repo)
        #expect(features.map(\.branch) == ["bot/pin-reactions"])
        let feature = try #require(features.first)
        #expect(feature.title == "Add emoji reactions to pinned messages")
        #expect(feature.commits == 2)
        #expect(feature.files == ["Web/src/pins.css", "Web/src/pins.ts"])
    }

    @Test func theForkIsReadFromOrigin() {
        #expect(CommunityShare.owner(ofRemote: "git@github.com:mei-lin/ClaudeCodeBot.git") == "mei-lin")
        #expect(CommunityShare.owner(ofRemote: "https://github.com/mei-lin/ClaudeCodeBot") == "mei-lin")
        #expect(CommunityShare.owner(ofRemote: "ssh://git@github.com/mei-lin/ClaudeCodeBot.git") == "mei-lin")
        #expect(CommunityShare.owner(ofRemote: "https://gitlab.com/mei-lin/ClaudeCodeBot.git") == nil)
        #expect(CommunityShare.owner(ofRemote: "") == nil)
    }

    @Test func thePrivacyCheckFindsKeysAndYourHomeInWhatIsAdded() {
        let diff = """
        diff --git a/Sources/Keys.swift b/Sources/Keys.swift
        +++ b/Sources/Keys.swift
        @@ -0,0 +1,4 @@
        +let anthropic = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
        +let github = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        +let folder = "/Users/mei/Documents/notes"
        +let shared = "/Users/Shared/ClaudeCodeBot"
        -let old = "sk-ant-api03-removedremovedremovedremoved"
        diff --git a/keys/id_rsa b/keys/id_rsa
        +++ b/keys/id_rsa
        @@ -0,0 +1 @@
        +-----BEGIN OPENSSH PRIVATE KEY-----
        """
        let findings = CommunityShare.privacyFindings(in: diff, home: "/Users/mei")
        #expect(findings == [
            "Sources/Keys.swift: an Anthropic API key",
            "Sources/Keys.swift: a GitHub token",
            "Sources/Keys.swift: your home folder's path",
            "keys/id_rsa: a private key",
        ])
        #expect(CommunityShare.privacyFindings(in: "+++ b/a.swift\n+let x = 1\n", home: "/Users/mei").isEmpty)
    }

    @Test func thePullRequestGoesToClaudeCodeBotWithTheLabel() {
        let feature = CommunityShare.Feature(branch: "bot/pin-reactions", title: "Add emoji reactions", commits: 2, files: ["a.ts"], subjects: ["Add emoji reactions", "Style"])
        let command = CommunityShare.pullRequest(for: feature, owner: "mei-lin", label: true)
        #expect(command.prefix(3) == ["gh", "pr", "create"])
        func value(_ flag: String) -> String? { command.firstIndex(of: flag).map { command[$0 + 1] } }
        #expect(value("--repo") == "william1010121/ClaudeCodeBot")
        #expect(value("--base") == "main")
        #expect(value("--head") == "mei-lin:bot/pin-reactions")
        #expect(value("--title") == "Add emoji reactions")
        #expect(value("--label") == "community-feature")
        #expect(value("--body")?.contains("- Style") == true)
        #expect(!CommunityShare.pullRequest(for: feature, owner: "mei-lin", label: false).contains("--label"))
    }

    // MARK: In the app

    @Test func shareListsTheFeaturesThenChecksOneThenOpensItsPullRequest() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)

        await workspace.send("/share", to: manager)
        await eventually { manager.messages.contains { $0.isOpenQuestion } }
        // What you typed shows; the bot is not woken for it.
        #expect(manager.messages.first?.role == .user && manager.messages.first?.text == "/share")
        #expect(fake.agents.isEmpty)
        let list = try #require(manager.messages.last { $0.isOpenQuestion })
        #expect(list.text.contains("Which feature do you want to share?"))
        #expect(list.choices?.map(\.label) == ["Add emoji reactions to pinned messages", "Not now"])
        #expect(list.choices?.first?.detail == "bot/pin-reactions · 2 commits · 2 files")

        #expect(workspace.choose(0, in: list.id, of: manager))
        await eventually { manager.messages.last?.isOpenQuestion == true && manager.messages.last?.id != list.id }
        let check = try #require(manager.messages.last)
        #expect(check.text.contains("Share \"Add emoji reactions to pinned messages\""))
        #expect(check.text.contains("✓ Up to date with main"))
        #expect(check.text.contains("✓ Privacy check: no keys, tokens or personal paths in the diff"))
        // Whether the label goes on is only known once the pull request opens: no ✓ for it yet.
        #expect(!check.text.contains("✓ Label"))
        #expect(check.text.contains("! Label: community-feature"))
        #expect(check.text.contains("from mei-lin/ClaudeCodeBot to william1010121/ClaudeCodeBot"))
        #expect(check.choices?.map(\.label) == ["Open pull request", "Not now"])
        // Nothing went out yet.
        #expect(runner.ran.isEmpty)

        #expect(workspace.choose(0, in: check.id, of: manager))
        await eventually { manager.messages.last?.text.contains("pull/42") == true }
        #expect(runner.ran.count == 2)
        #expect(runner.ran.first == ["git", "push", "-u", "origin", "bot/pin-reactions"])
        #expect(runner.ran.last?.prefix(3) == ["gh", "pr", "create"])
        #expect(runner.ran.last?.contains("community-feature") == true)
        #expect(manager.messages.last?.text.contains("Opened a pull request") == true)
        withExtendedLifetime(workspace) {}
    }

    @Test func notNowStopsWithNothingSent() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)
        await workspace.send("/share bot/pin-reactions", to: manager)
        // A branch named after /share goes straight to its checklist.
        await eventually { manager.messages.last?.choices?.first?.label == "Open pull request" }
        let check = try #require(manager.messages.last)
        #expect(workspace.choose(1, in: check.id, of: manager))
        #expect(runner.ran.isEmpty)
        #expect(!manager.messages.contains { $0.isOpenQuestion })
    }

    @Test func aFeatureWithAKeyIsNotSent() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        let (workspace, project, manager) = try developerSetUp(fake, runner: runner)
        let repo = project.folder
        try git(repo, "checkout", "-q", "-b", "bot/leaky")
        try commit(repo, "Config.swift", "let key = \"sk-ant-api03-abcdefghijklmnopqrstuvwxyz\"\n", "Hard-code the key")
        try git(repo, "checkout", "-q", "main")

        await workspace.send("/share bot/leaky", to: manager)
        await eventually { manager.messages.last?.text.contains("Privacy check") == true }
        let check = try #require(manager.messages.last)
        #expect(check.text.contains("✗ Privacy check: Config.swift: an Anthropic API key"))
        #expect(check.text.contains("Not ready to share"))
        #expect(check.choices == nil)
        #expect(runner.ran.isEmpty)
    }

    @Test func aLabelMissingOnClaudeCodeBotIsCreatedAndThePullRequestCarriesIt() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        // ClaudeCodeBot has no community-feature label until `gh label create` makes it.
        final class Labels: @unchecked Sendable { var made = false }
        let labels = Labels()
        runner.answer = { arguments in
            guard arguments.first == "gh" else { return (true, "") }
            if arguments.starts(with: ["gh", "label", "create"]) {
                labels.made = true
                return (true, "")
            }
            return arguments.contains("--label") && !labels.made
                ? (false, "could not add label: 'community-feature' not found")
                : (true, "https://github.com/william1010121/ClaudeCodeBot/pull/44\n")
        }
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)
        await workspace.send("/share bot/pin-reactions", to: manager)
        await eventually { manager.messages.last?.choices?.first?.label == "Open pull request" }
        #expect(workspace.choose(0, in: try #require(manager.messages.last).id, of: manager))
        await eventually { manager.messages.last?.text.contains("pull/44") == true }
        let gh = runner.ran.filter { $0.first == "gh" }
        let create = try #require(gh.first { $0.starts(with: ["gh", "label", "create"]) })
        #expect(create.contains("community-feature"))
        #expect(create.firstIndex(of: "--repo").map { create[$0 + 1] } == "william1010121/ClaudeCodeBot")
        // The pull request that opened is the one with the label.
        #expect(gh.last?.prefix(3) == ["gh", "pr", "create"])
        #expect(gh.last?.contains("--label") == true)
        #expect(manager.messages.last?.text.contains("without") == false)
    }

    @Test func aLabelThatAlreadyExistsIsNotAnError() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        final class Tries: @unchecked Sendable { var labelled = 0 }
        let tries = Tries()
        runner.answer = { arguments in
            guard arguments.first == "gh" else { return (true, "") }
            if arguments.starts(with: ["gh", "label", "create"]) {
                return (false, "label with name \"community-feature\" already exists; use `--force` to update its color and description")
            }
            guard arguments.contains("--label") else { return (true, "https://github.com/william1010121/ClaudeCodeBot/pull/45\n") }
            tries.labelled += 1
            // Someone made the label a moment ago: the second try finds it.
            return tries.labelled == 1 ? (false, "could not add label: 'community-feature' not found") : (true, "https://github.com/william1010121/ClaudeCodeBot/pull/45\n")
        }
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)
        await workspace.send("/share bot/pin-reactions", to: manager)
        await eventually { manager.messages.last?.choices?.first?.label == "Open pull request" }
        #expect(workspace.choose(0, in: try #require(manager.messages.last).id, of: manager))
        await eventually { manager.messages.last?.text.contains("pull/45") == true }
        #expect(runner.ran.last?.contains("--label") == true)
        #expect(manager.messages.last?.text.contains("without") == false)
    }

    @Test func aLabelYouMayNotAddIsLeftToTheOwner() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        runner.answer = { arguments in
            guard arguments.first == "gh" else { return (true, "") }
            if arguments.starts(with: ["gh", "label", "create"]) {
                return (false, "HTTP 403: Must have admin rights to Repository.")
            }
            return arguments.contains("--label")
                ? (false, "could not add label: 'community-feature' not found")
                : (true, "https://github.com/william1010121/ClaudeCodeBot/pull/43\n")
        }
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)
        await workspace.send("/share bot/pin-reactions", to: manager)
        await eventually { manager.messages.last?.choices?.first?.label == "Open pull request" }
        #expect(workspace.choose(0, in: try #require(manager.messages.last).id, of: manager))
        await eventually { manager.messages.last?.text.contains("pull/43") == true }
        let gh = runner.ran.filter { $0.first == "gh" }
        #expect(gh.contains { $0.starts(with: ["gh", "label", "create"]) })
        #expect(gh.last?.contains("--label") == false)
        // Said honestly, with what GitHub answered.
        let said = try #require(manager.messages.last?.text)
        #expect(said.contains("without the community-feature label"))
        #expect(said.contains("Must have admin rights"))
    }

    @Test func aFailedPushSaysWhyAndOpensNothing() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        runner.answer = { arguments in arguments.first == "git" ? (false, "Permission denied (publickey).") : (true, "") }
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)
        await workspace.send("/share bot/pin-reactions", to: manager)
        await eventually { manager.messages.last?.choices?.first?.label == "Open pull request" }
        #expect(workspace.choose(0, in: try #require(manager.messages.last).id, of: manager))
        await eventually { manager.messages.last?.text.contains("Permission denied") == true }
        #expect(runner.ran.count == 1)
        #expect(manager.messages.last?.text.contains("Couldn't push bot/pin-reactions") == true)
    }

    @Test func nothingToShareSaysHowFeaturesAreMade() async throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        let (workspace, project, manager) = try developerSetUp(fake, runner: runner)
        try git(project.folder, "branch", "-D", "bot/pin-reactions")
        await workspace.send("/share", to: manager)
        await eventually { manager.messages.last?.text.contains("No features to share yet") == true }
        #expect(!manager.messages.contains { $0.isOpenQuestion })
    }

    @Test func shareNeedsDeveloperMode() async throws {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let runner = FakeRunner()
        workspace.shareRunner = runner.runner
        await workspace.send("/share", to: workspace.mainBot)
        #expect(workspace.mainBot.messages.last?.text.contains("needs developer mode") == true)
        #expect(fake.agents.isEmpty)
        #expect(runner.ran.isEmpty)
        // Words that only start with it are a message like any other.
        await workspace.send("/shared folders, please", to: workspace.mainBot)
        await eventually { fake.agents.count == 1 }
    }

    @Test func theManagerKnowsWhatShareDoes() throws {
        let (workspace, project, _) = try developerSetUp(FakeLauncher(), runner: FakeRunner())
        let briefing = workspace.developerBriefing(for: project)
        #expect(briefing.contains("/share"))
        #expect(briefing.contains("keep its bot/<short-task> branch"))
    }

    @Test func onlyTheDeveloperChatOffersShare() throws {
        let fake = FakeLauncher()
        let runner = FakeRunner()
        let (workspace, _, manager) = try developerSetUp(fake, runner: runner)
        #expect(workspace.offersShare(in: manager))
        #expect(!workspace.offersShare(in: workspace.mainBot))
        let shown = ChatPayload.make(bot: manager, components: nil, pending: [], replyingTo: nil, share: true) { _ in "" }
        #expect(shown.slashCommands.map(\.name) == ["design", "share"])
        let plain = ChatPayload.make(bot: manager, components: nil, pending: [], replyingTo: nil) { _ in "" }
        #expect(plain.slashCommands.map(\.name) == ["design"])
    }
}
