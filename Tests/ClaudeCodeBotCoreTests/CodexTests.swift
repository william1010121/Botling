import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Stands in for `codex exec`: hands back the outputs it is given, in order, and keeps what it
/// was asked. With nothing left, it reports nothing found.
final class FakeCodex: CodexRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var _outputs: [Result<CodexOutput, CodexError>]
    private var _requests: [CodexRequest] = []

    init(_ outputs: [Result<CodexOutput, CodexError>] = []) {
        _outputs = outputs
    }

    var requests: [CodexRequest] { lock.withLock { _requests } }

    func queue(_ output: CodexOutput) {
        lock.withLock { _outputs.append(.success(output)) }
    }

    func run(_ request: CodexRequest) async throws -> CodexOutput {
        let next: Result<CodexOutput, CodexError> = lock.withLock {
            _requests.append(request)
            return _outputs.isEmpty ? .success(CodexOutput(summary: "Looks fine.")) : _outputs.removeFirst()
        }
        return try next.get()
    }
}

func finding(_ file: String, _ line: Int?, _ severity: CodexSeverity, _ title: String) -> CodexOutput.Item {
    CodexOutput.Item(file: file, line: line, severity: severity, title: title, scenario: "When x, y happens.")
}

struct CodexOutputTests {
    @Test func readsTheSchemaJSONFencedOrNot() {
        let json = #"{"summary":"Two bugs.","findings":[{"file":"Sources/Bot.swift","line":42,"severity":"high","title":"Crash on empty list","scenario":"first([]) traps"},{"file":"a.ts","line":0,"severity":"weird","title":"Odd","scenario":""}]}"#
        let plain = CodexOutput.parse(json)
        #expect(plain.summary == "Two bugs.")
        #expect(plain.findings.count == 2)
        #expect(plain.findings[0] == CodexOutput.Item(file: "Sources/Bot.swift", line: 42, severity: .high, title: "Crash on empty list", scenario: "first([]) traps"))
        // A line of 0 is no line; a severity it does not know counts as low.
        #expect(plain.findings[1].line == nil)
        #expect(plain.findings[1].severity == .low)

        let fenced = CodexOutput.parse("Here you go:\n```json\n\(json)\n```\n")
        #expect(fenced == plain)

        let words = CodexOutput.parse("  The function looks fine to me.  ")
        #expect(words == CodexOutput(summary: "The function looks fine to me."))
    }

    @Test func itsMarkdownPutsTheWorstFirst() {
        let output = CodexOutput(summary: "Verdict.", findings: [
            finding("x/low.swift", 3, .low, "Minor"),
            finding("x/high.swift", 9, .high, "Major")
        ])
        let lines = output.markdown.split(separator: "\n").map(String.init)
        #expect(lines[0] == "Verdict.")
        #expect(lines[1] == "- **High** `high.swift:9` Major — When x, y happens.")
        #expect(lines[2].hasPrefix("- **Low** `low.swift:3` Minor"))
    }

    @Test func codexRunsReadOnlyAndKeepsNothing() {
        let folder = URL(filePath: "/tmp/repo")
        let arguments = CodexCLI.arguments(folder: folder, schema: URL(filePath: "/tmp/s.json"), output: URL(filePath: "/tmp/o.json"), prompt: "Review")
        #expect(arguments.first == "exec")
        let joined = arguments.joined(separator: " ")
        #expect(joined.contains("--sandbox read-only"))
        #expect(joined.contains("--ephemeral"))
        #expect(joined.contains("-C /tmp/repo"))
        #expect(joined.contains("--output-schema /tmp/s.json"))
        #expect(arguments.last == "Review")
        #expect(!joined.contains("danger"))
        // The schema is valid JSON.
        #expect((try? JSONSerialization.jsonObject(with: Data(CodexOutput.schema.utf8))) != nil)
    }

    @Test func theNewestInstallWins() {
        #expect(CodexCLI.parseVersion("codex-cli 0.163.0\n") == [0, 163, 0])
        #expect(CodexCLI.newer([0, 163, 0], than: [0, 141, 0]))
        #expect(!CodexCLI.newer([0, 141], than: [0, 141, 0]))
        #expect(CodexCLI.newer([1], than: []))
    }

    @Test func aReviewPromptNamesTheScopeAndWhatWasSaidFixed() {
        let first = CodexPrompts.review(base: "main", focus: "Fix the login loop")
        #expect(first.contains("git diff main...HEAD"))
        #expect(first.contains("read-only"))
        #expect(first.contains("Fix the login loop"))
        #expect(!first.contains("earlier review round"))
        let sent = CodexFinding(file: "Auth.swift", line: 42, severity: .high, title: "Token never refreshes", scenario: "")
        let again = CodexPrompts.review(base: nil, earlier: [sent])
        #expect(again.contains("uncommitted"))
        #expect(again.contains("[high] Auth.swift:42: Token never refreshes"))
    }
}

struct CodexTagTests {
    @Test func aBotAsksForAReviewWithATag() {
        let reply = """
        fix-login says it is done; Codex will look first.
        <codex-review agent="fix-login" folder="/tmp/wt/fix-login" base="main">Stop the sign-in loop</codex-review>
        """
        let parsed = ReplyParser.parseAll(reply)
        #expect(parsed.body == "fix-login says it is done; Codex will look first.")
        #expect(parsed.requests == [.codexReview(agent: "fix-login", folder: "/tmp/wt/fix-login", base: "main", note: "Stop the sign-in loop")])

        let short = ReplyParser.parseAll(#"Next round. <codex-review agent='a' folder='/x'/>"#)
        #expect(short.requests == [.codexReview(agent: "a", folder: "/x", base: nil, note: "")])
        #expect(short.body == "Next round.")
    }

    @Test func noFolderOrAnExampleInCodeIsNoRequest() {
        #expect(ReplyParser.parseAll(#"<codex-review agent="a"/>"#).requests.isEmpty)
        #expect(ReplyParser.parseAll("Write `<codex-review agent=\"a\" folder=\"/x\"/>` to ask.").requests.isEmpty)
    }

    @Test func theNameABotGivesASubagentIsKept() {
        let line = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"Fix login","name":"fix-login","prompt":"Fix it"}}]}}"#
        let events = StreamEvent.events(in: line)
        #expect(events.contains(.trace(.subagentNamed(id: "toolu_1", name: "fix-login"))))
        var book = TraceBook()
        for case let .trace(event) in events { book.apply(event) }
        #expect(book.subagent("toolu_1")?.name == "fix-login")
    }
}

struct CodexReviewTests {
    func review(maxRounds: Int = 3, sendBack: CodexSendBack = .highAndMedium) -> CodexReview {
        CodexReview(kind: .loop, ownerID: UUID(), agent: "fix-login", title: "t", folder: "/tmp", base: "main", maxRounds: maxRounds, sendBack: sendBack)
    }

    @Test func whatIsNotFoundAgainWasFixedAndWhatIsWasNot() {
        var review = review()
        review.absorb(CodexOutput(summary: "Two.", findings: [
            finding("Auth/Store.swift", 42, .high, "Token is never refreshed"),
            finding("Session.swift", 88, .medium, "Session leaks on logout")
        ]))
        #expect(review.round == 1)
        guard case let .fix(toFix) = review.next() else { Issue.record("expected fixes"); return }
        #expect(toFix.count == 2)
        review.markSent(Set(toFix.map(\.id)))
        #expect(review.findings.allSatisfy { $0.status == .sent && $0.timesSent == 1 })
        #expect(review.rounds[0].sent == 2)

        // Round 2: the token one is still there (moved a line), the session one is gone, one new.
        review.absorb(CodexOutput(summary: "One left.", findings: [
            finding("Auth/Store.swift", 44, .high, "The token is never refreshed"),
            finding("login.ts", 17, .low, "Typo in a log line")
        ]))
        let token = review.findings[0], session = review.findings[1], typo = review.findings[2]
        #expect(token.status == .open && token.keepsComingBack && token.line == 44)
        #expect(session.status == .fixed)
        #expect(typo.status == .open && typo.firstRound == 2)
        // Low is not sent back at the default level.
        guard case let .fix(again) = review.next() else { Issue.record("expected fixes"); return }
        #expect(again.map(\.id) == [token.id])
    }

    @Test func theLoopStopsAtItsLimitAndIsCleanWhenOnlyLowIsLeft() {
        var limited = review(maxRounds: 1)
        limited.absorb(CodexOutput(summary: "", findings: [finding("a.swift", 1, .medium, "Bad")]))
        #expect(limited.next() == .stuck(limited.openFindings))

        var lowOnly = review()
        lowOnly.absorb(CodexOutput(summary: "", findings: [finding("a.swift", 1, .low, "Nit")]))
        #expect(lowOnly.next() == .clean)
        var everything = review(sendBack: .all)
        everything.absorb(CodexOutput(summary: "", findings: [finding("a.swift", 1, .low, "Nit")]))
        #expect(everything.next() != .clean)
        var highOnly = review(sendBack: .highOnly)
        highOnly.absorb(CodexOutput(summary: "", findings: [finding("a.swift", 1, .medium, "Meh")]))
        #expect(highOnly.next() == .clean)
    }

    @Test func aSkippedFindingStaysSkipped() {
        var review = review()
        review.absorb(CodexOutput(summary: "", findings: [finding("a.swift", 10, .high, "Bad thing")]))
        review.set(.skipped, for: [review.findings[0].id])
        review.absorb(CodexOutput(summary: "", findings: [finding("a.swift", 10, .high, "Bad thing")]))
        #expect(review.findings.count == 1)
        #expect(review.findings[0].status == .skipped)
        #expect(review.next() == .clean)
    }

    @Test func reviewsAreSavedAndReadBack() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "ccb-codex-\(UUID().uuidString)/reviews.json")
        var review = review()
        review.absorb(CodexOutput(summary: "S", findings: [finding("a.swift", 1, .high, "X")]))
        CodexReviewStore(url: url).save([review])
        let back = CodexReviewStore(url: url).load()
        #expect(back.count == 1)
        #expect(back[0].findings == review.findings)
        #expect(back[0].markdown.contains("**High** a.swift:1: X"))
    }
}

struct GitDiffTests {
    static let sample = """
    diff --git a/Sources/Bot.swift b/Sources/Bot.swift
    index 1111111..2222222 100644
    --- a/Sources/Bot.swift
    +++ b/Sources/Bot.swift
    @@ -40,4 +40,5 @@ struct Bot {
         let a = 1
    -    let b = 2
    +    let b = 3
    +    let c = 4
         let d = 5
    diff --git a/new.txt b/new.txt
    new file mode 100644
    --- /dev/null
    +++ b/new.txt
    @@ -0,0 +1,2 @@
    +one
    +two
    """

    @Test func readsFilesHunksAndLineNumbers() throws {
        let diff = GitDiff.parse(Self.sample)
        #expect(diff.files.map(\.path) == ["Sources/Bot.swift", "new.txt"])
        let bot = try #require(diff.file("Bot.swift"))
        #expect(bot.added == 2 && bot.removed == 1)
        let lines = bot.hunks[0].lines
        #expect(lines.map(\.kind) == [.context, .removed, .added, .added, .context])
        #expect(lines[1].old == 41 && lines[1].new == nil)
        #expect(lines[2].new == 41 && lines[3].new == 42)
        #expect(lines[4].old == 42 && lines[4].new == 43)
        // The lines around a finding at line 42.
        let excerpt = bot.excerpt(around: 42, context: 1)
        #expect(excerpt.map(\.text) == ["    let b = 3", "    let c = 4", "    let d = 5"])
        #expect(diff.file("new.txt")?.hunks[0].lines.map(\.new) == [1, 2])
    }

    @Test func findsTheBranchToCompareWithInARealRepository() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-git-\(UUID().uuidString)")
        try makeRepository(folder)
        #expect(GitDiff.repositoryRoot(folder)?.standardizedFileURL.resolvingSymlinksInPath().path == folder.standardizedFileURL.resolvingSymlinksInPath().path)
        #expect(GitDiff.defaultBase(folder: folder) == "main")
        #expect(GitDiff.repositoryRoot(FileManager.default.temporaryDirectory.appending(path: "nowhere-\(UUID().uuidString)")) == nil)
    }
}

/// A git repository on branch `feature` with one commit past `main` and an uncommitted edit.
func makeRepository(_ folder: URL) throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    func git(_ arguments: String...) {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", folder.path, "-c", "user.email=t@t", "-c", "user.name=t"] + arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }
    git("init", "-q", "-b", "main")
    try Data("one\n".utf8).write(to: folder.appending(path: "a.txt"))
    git("add", ".")
    git("commit", "-qm", "one")
    git("checkout", "-qb", "feature")
    try Data("one\ntwo\n".utf8).write(to: folder.appending(path: "a.txt"))
    git("commit", "-qam", "two")
    try Data("one\ntwo\nthree\n".utf8).write(to: folder.appending(path: "a.txt"))
}

/// The loop: a bot tags a subagent's report, Codex reviews, findings go back to the same
/// subagent through the bot, Codex looks again, until clean or out of rounds.
@MainActor
struct CodexLoopTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-codexloop-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher, codex: FakeCodex) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), codex: codex) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func project(_ workspace: Workspace) throws -> (Workspace.Project, Bot, URL) {
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        return (project, try #require(workspace.bot(for: project)), folder)
    }

    /// The bot's reply when the subagent reports: the tag that asks for the next round.
    nonisolated static func tag(_ folder: URL) -> String {
        "fix-login is done. <codex-review agent=\"fix-login\" folder=\"\(folder.path)\" base=\"main\">Stop the sign-in loop</codex-review>"
    }

    @Test func findingsGoBackToTheSameSubagentUntilCodexFindsNothing() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex([
            .success(CodexOutput(summary: "One bug.", findings: [finding("Auth.swift", 42, .high, "Token never refreshes")])),
            .success(CodexOutput(summary: "Fixed."))
        ])
        let workspace = makeWorkspace(fake, codex: codex)
        let (project, bot, folder) = try project(workspace)
        bot.setCodexSettings(CodexSettings(mode: .always, maxRounds: 3))
        fake.respond = { text in
            if text.contains("subagent reported") { return Self.tag(folder) }
            if text.contains("(App: Codex review round") { return "Sent to fix-login." }
            if text.contains("(App: Codex review of \"fix-login\"'s change is clean") { return "Told fix-login to merge." }
            return isAppOnly(text) ? "OK" : "Handed to fix-login."
        }

        bot.send("The subagent reported back.")
        await eventually { workspace.codexReviews.first?.state == .fixing }
        let review = try #require(workspace.codexReviews.first)
        #expect(review.kind == .loop && review.ownerID == project.id && review.agent == "fix-login")
        #expect(review.base == "main" && review.note == "Stop the sign-in loop")
        #expect(codex.requests.count == 1)
        #expect(codex.requests[0].folder.standardizedFileURL.path == folder.standardizedFileURL.path)
        #expect(codex.requests[0].prompt.contains("git diff main...HEAD"))
        #expect(review.findings.map(\.status) == [.sent])
        // The bot was told to send them to the same subagent, and how to ask for the next round.
        let sent = fake.agents[0].sent
        let fix = try #require(sent.first { $0.contains("(App: Codex review round 1 of 3") })
        #expect(fix.contains("SendMessage (to: \"fix-login\")"))
        #expect(fix.contains("Do not start a new subagent"))
        #expect(fix.contains("[high] Auth.swift:42: Token never refreshes"))
        #expect(fix.contains("<codex-review agent=\"fix-login\" folder=\"\(review.folder)\" base=\"main\"/>"))
        // The chat shows what Codex found, as Codex.
        #expect(bot.messages.contains { $0.role == .notice && $0.sourceID == Workspace.codexID && $0.text.contains("**Codex · round 1** found 1 to fix") })

        // The subagent fixed it and reported; the bot tags it again: round 2, same review.
        bot.send("The subagent reported back again.")
        await eventually { workspace.codexReviews.first?.state == .clean }
        let done = try #require(workspace.codexReviews.first)
        #expect(workspace.codexReviews.count == 1)
        #expect(done.round == 2)
        #expect(done.findings.map(\.status) == [.fixed])
        #expect(codex.requests[1].prompt.contains("Token never refreshes"))
        await eventually { fake.agents[0].sent.contains { $0.contains("is clean after 2 rounds") } }
        #expect(done.stateLine == "Clean after 2 rounds")
        #expect(bot.messages.contains { $0.text.contains("**Codex · clean**") })
    }

    @Test func atTheLimitTheUserDecides() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex([.success(CodexOutput(summary: "", findings: [finding("Store.swift", 42, .medium, "Race on save")]))])
        let workspace = makeWorkspace(fake, codex: codex)
        let (project, bot, folder) = try project(workspace)
        bot.setCodexSettings(CodexSettings(mode: .always, maxRounds: 1))
        fake.respond = { text in text.contains("reported") ? Self.tag(folder) : (isAppOnly(text) ? "OK" : "Waiting.") }

        bot.send("The subagent reported back.")
        await eventually { workspace.codexReviews.first?.state == .stuck }
        let card = try #require(bot.messages.last { $0.role == .notice && $0.choices != nil })
        #expect(card.choices?.map(\.label) == ["Fix once more", "Accept as is"])
        #expect(card.text.contains("stopped at max rounds"))
        // It waits on you, like any question in its chat.
        #expect(workspace.waiting.contains { $0.projectID == project.id && $0.messageID == card.id })
        await eventually { fake.agents[0].sent.contains { $0.contains("stopped at the limit of 1 round") } }

        #expect(workspace.choose(1, in: card.id, of: bot))
        let review = try #require(workspace.codexReviews.first)
        #expect(review.state == .stopped)
        await eventually { fake.agents[0].sent.contains { $0.contains("accepted \"fix-login\"'s change as it is") } }
    }

    @Test func fixOnceMoreSendsThemBackForOneMoreRound() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex([.success(CodexOutput(summary: "", findings: [finding("Store.swift", 42, .high, "Race on save")]))])
        let workspace = makeWorkspace(fake, codex: codex)
        let (_, bot, folder) = try project(workspace)
        bot.setCodexSettings(CodexSettings(mode: .always, maxRounds: 1))
        fake.respond = { text in text.contains("reported") ? Self.tag(folder) : (isAppOnly(text) ? "OK" : "Waiting.") }
        bot.send("The subagent reported back.")
        await eventually { workspace.codexReviews.first?.state == .stuck }
        let card = try #require(bot.messages.last { $0.role == .notice && $0.choices != nil })

        #expect(workspace.choose(0, in: card.id, of: bot))
        let review = try #require(workspace.codexReviews.first)
        #expect(review.state == .fixing)
        #expect(review.maxRounds == 2)
        #expect(review.findings[0].status == .sent && review.findings[0].timesSent == 1)
        await eventually { fake.agents[0].sent.contains { $0.contains("(App: Codex review round 1 of 2") } }
    }

    @Test func whenCodexCannotRunTheBotIsTold() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex([.failure(CodexError("The codex command was not found."))])
        let workspace = makeWorkspace(fake, codex: codex)
        let (_, bot, folder) = try project(workspace)
        fake.respond = { text in text.contains("reported") ? Self.tag(folder) : (isAppOnly(text) ? "OK" : "Asked.") }
        bot.send("The subagent reported back.")
        await eventually { workspace.codexReviews.first?.state == .failed }
        #expect(workspace.codexReviews.first?.error == "The codex command was not found.")
        await eventually { fake.agents[0].sent.contains { $0.contains("Codex could not review \"fix-login\"'s change") } }
    }

    @Test func aFolderThatIsNotThereIsNotReviewed() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex()
        let workspace = makeWorkspace(fake, codex: codex)
        let (_, bot, _) = try project(workspace)
        fake.respond = { text in
            text.contains("reported") ? "<codex-review agent=\"a\" folder=\"/nowhere/\(UUID().uuidString)\"/>" : (isAppOnly(text) ? "OK" : "Fine.")
        }
        bot.send("The subagent reported back.")
        await eventually { fake.agents.first?.sent.contains { $0.contains("no such folder") } == true }
        #expect(workspace.codexReviews.isEmpty)
        #expect(codex.requests.isEmpty)
    }

    @Test func theRulesReachTheBotOnlyWhileCodexReviewIsOn() throws {
        let workspace = makeWorkspace(FakeLauncher(), codex: FakeCodex())
        let (_, bot, _) = try project(workspace)
        #expect(bot.codexSettings.mode == .off)
        let off = bot.wakeNote?() ?? ""
        #expect(!off.contains("Codex review is on"))
        bot.setCodexSettings(CodexSettings(mode: .always, maxRounds: 4, sendBack: .all))
        let note = bot.wakeNote?() ?? ""
        #expect(note.contains("<codex-review agent=\"its name\""))
        #expect(note.contains("up to 4 fix rounds"))
        #expect(note.contains("do not merge"))
        bot.setCodexSettings(CodexSettings(mode: .ask))
        #expect((bot.wakeNote?() ?? "").contains("ask the user with a choices block whether Codex should review"))
        // Kept with the bot.
        let again = makeWorkspace(FakeLauncher(), codex: FakeCodex())
        let reopened = try #require(again.projects.first.flatMap(again.bot(for:)))
        #expect(reopened.codexSettings == CodexSettings(mode: .ask))
        // The main bot can use it too.
        workspace.mainBot.setCodexSettings(CodexSettings(mode: .always))
        #expect((workspace.mainBot.wakeNote?() ?? "").contains("<codex-review"))
    }

    @Test func aSubagentRowFindsItsLoopByName() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake, codex: FakeCodex([.success(CodexOutput(summary: "", findings: [finding("a.swift", 1, .high, "X")]))]))
        let (_, bot, folder) = try project(workspace)
        fake.respond = { text in text.contains("reported") ? Self.tag(folder) : (isAppOnly(text) ? "OK" : "Ok.") }
        bot.send("The subagent reported back.")
        await eventually { workspace.codexReviews.first?.state == .fixing }
        var subagent = Subagent(id: "toolu_9", description: "Fix the login", prompt: "…")
        #expect(workspace.codexReview(forSubagent: subagent, of: bot) == nil)
        subagent.name = "fix-login"
        #expect(workspace.codexReview(forSubagent: subagent, of: bot)?.stateLine == "Round 1 · fixing 1 finding")
        #expect(workspace.codexReviews(for: bot).count == 1)
        #expect(workspace.codexReviews(for: workspace.mainBot).isEmpty)
        // Codex's own panel lists everyone's.
        #expect(workspace.codexReviews(for: workspace.codexBot).count == 1)
    }

    @Test func stoppingTheLoopTellsTheBot() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake, codex: FakeCodex([.success(CodexOutput(summary: "", findings: [finding("a.swift", 1, .high, "X")]))]))
        let (_, bot, folder) = try project(workspace)
        fake.respond = { text in text.contains("reported") ? Self.tag(folder) : (isAppOnly(text) ? "OK" : "Ok.") }
        bot.send("The subagent reported back.")
        await eventually { workspace.codexReviews.first?.state == .fixing }
        workspace.stopCodexReview(try #require(workspace.codexReviews.first).id)
        #expect(workspace.codexReviews.first?.state == .stopped)
        await eventually { fake.agents[0].sent.contains { $0.contains("stopped the Codex review of \"fix-login\"") } }
    }
}

/// "Review with Codex" on a project, its report, and Codex as a bot you talk to.
@MainActor
struct CodexSingleReviewTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-codexone-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher, codex: FakeCodex) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), codex: codex) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    @Test func aProjectIsReviewedOnceAndItsReportTracksEachFinding() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex([
            .success(CodexOutput(summary: "Two things.", findings: [finding("a.txt", 3, .high, "Three is wrong"), finding("a.txt", 1, .low, "One is odd")])),
            .success(CodexOutput(summary: "One left.", findings: [finding("a.txt", 1, .low, "One is odd")]))
        ])
        let workspace = makeWorkspace(fake, codex: codex)
        let folder = root.appending(path: "code/repo")
        try makeRepository(folder)
        let project = workspace.addProject(folder: folder)
        let bot = try #require(workspace.bot(for: project))

        let id = try #require(workspace.reviewWithCodex(bot))
        await eventually { workspace.codexReview(id)?.state == .open }
        let review = try #require(workspace.codexReview(id))
        #expect(review.kind == .single && review.base == "main" && review.title == "Codex review · feature")
        #expect(codex.requests[0].prompt.contains("git diff main...HEAD"))
        #expect(bot.messages.last?.text.contains("**Codex review** of repo: 1 high · 1 low") == true)
        #expect(review.count(.high) == 1 && review.count(.low) == 1)

        // The diff the panel shows, around the finding.
        let diff = await workspace.codexDiff(for: id)
        let file = try #require(diff.file("a.txt"))
        #expect(file.excerpt(around: 3).contains { $0.kind == .added && $0.text == "three" })
        #expect(file.excerpt(around: 3).contains { $0.kind == .added && $0.text == "two" })

        // Send the high one to the bot: it is being fixed, and the bot got it as your message.
        let high = try #require(review.findings.first { $0.severity == .high })
        workspace.sendCodexFindings([high.id], of: id)
        #expect(workspace.codexReview(id)?.findings.first { $0.id == high.id }?.status == .sent)
        await eventually { bot.messages.contains { $0.role == .user && $0.text.contains("Fix these Codex findings") && $0.text.contains("a.txt:3: Three is wrong") } }

        // Skip the low one; run again: the high one is gone, so fixed; the low one stays skipped.
        let low = try #require(review.findings.first { $0.severity == .low })
        workspace.setCodexFindings([low.id], of: id, to: .skipped)
        workspace.rerunCodexReview(id)
        await eventually { workspace.codexReview(id)?.round == 2 && workspace.codexReview(id)?.state != .reviewing }
        let after = try #require(workspace.codexReview(id))
        #expect(after.findings.first { $0.id == high.id }?.status == .fixed)
        #expect(after.findings.first { $0.id == low.id }?.status == .skipped)
        #expect(after.state == .clean)
    }

    @Test func aFolderThatIsNoRepositoryIsNotReviewed() throws {
        let workspace = makeWorkspace(FakeLauncher(), codex: FakeCodex())
        let folder = root.appending(path: "code/plain")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let bot = try #require(workspace.bot(for: workspace.addProject(folder: folder)))
        #expect(workspace.reviewWithCodex(bot) == nil)
        #expect(bot.messages.last?.text.contains("is not one") == true)
    }

    @Test func codexIsABotWithNoMemoryThatAnswersWhatItFinds() async throws {
        let codex = FakeCodex([.success(CodexOutput(summary: "One problem.", findings: [finding("x.swift", 7, .medium, "Off by one")]))])
        let workspace = makeWorkspace(FakeLauncher(), codex: codex)
        let bot = workspace.codexBot
        #expect(bot.profile.keepsMemory == false)
        #expect(workspace.project(Workspace.codexID)?.name == "Codex")
        workspace.select(Workspace.codexID)
        #expect(workspace.selectedBot === bot)

        bot.send("Look over my uncommitted changes")
        await eventually { bot.messages.last?.role == .bot }
        let reply = try #require(bot.messages.last)
        #expect(reply.text.hasPrefix("One problem."))
        #expect(reply.text.contains("**Medium** `x.swift:7` Off by one"))
        // It works in your home folder, read-only, and never read a memory file.
        #expect(codex.requests[0].folder == FileManager.default.homeDirectoryForCurrentUser)
        #expect(codex.requests[0].prompt.contains("read-only"))
        #expect(!codex.requests[0].prompt.contains("memory.md"))
        #expect(codex.requests[0].prompt.contains("Look over my uncommitted changes"))
        // What it found is kept as a report.
        await eventually { workspace.codexReviews.count == 1 }
        #expect(workspace.codexReviews[0].ownerID == Workspace.codexID)
        #expect(workspace.codexReviews[0].state == .open)
        // Asleep, it has nothing to write down: no tidy turn.
        await bot.goToSleep()
        #expect(bot.phase == .asleep)
        #expect(codex.requests.count == 1)
    }

    @Test func atCodexInAProjectChatReadsThatProjectsFolder() async throws {
        let fake = FakeLauncher()
        let codex = FakeCodex([.success(CodexOutput(summary: "Fine.", findings: [finding("g.swift", 2, .high, "Crash")]))])
        let workspace = makeWorkspace(fake, codex: codex)
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        let chat = try #require(workspace.bot(for: project))
        #expect(workspace.callInView(for: chat)?.names == ["Main bot", "Maintainer", "Codex"])

        await workspace.send("@Codex review my uncommitted changes", to: chat)
        await eventually { chat.messages.contains { $0.sourceID == Workspace.codexID && $0.role == .bot } }
        #expect(codex.requests.first?.folder.standardizedFileURL.path == folder.standardizedFileURL.path)
        let line = try #require(chat.messages.last { $0.sourceID == Workspace.codexID })
        #expect(line.text.contains("**High** `g.swift:2` Crash"))
        // The findings are a report of that project's.
        await eventually { workspace.codexReviews(for: chat).count == 1 }
        // Afterwards Codex is back in its own folder.
        #expect(workspace.codexDesk.folder == FileManager.default.homeDirectoryForCurrentUser)
    }
}

/// The real `codex exec` on a small repository with a planted bug. Costs a Codex run, so it
/// only runs with `CCB_LIVE=1 swift test --filter LiveCodex`.
struct LiveCodexTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func codexFindsAPlantedBugReadOnly() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ccb-livecodex-\(UUID().uuidString)")
        try makeRepository(folder)
        try Data("def first(xs):\n    return xs[1]\n".utf8).write(to: folder.appending(path: "first.py"))
        let before = try String(contentsOf: folder.appending(path: "a.txt"), encoding: .utf8)
        let output = try await CodexCLI().run(CodexRequest(prompt: CodexPrompts.review(base: "main"), folder: folder))
        #expect(output.findings.contains { $0.file.hasSuffix("first.py") })
        // Read-only: nothing it looked at changed.
        #expect(try String(contentsOf: folder.appending(path: "a.txt"), encoding: .utf8) == before)
    }
}
