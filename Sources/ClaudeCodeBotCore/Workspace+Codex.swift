import Foundation

/// Codex review: a read-only second opinion from OpenAI's Codex CLI.
///
/// - A bot that sends a subagent off to change code can have Codex review that change. The bot
///   ends its reply with `<codex-review agent=… folder=… base=…>`; the app runs Codex there. What
///   it finds goes back to the bot, which sends it to the *same* subagent (it keeps its context)
///   to fix; the bot tags the next report again and Codex looks again, until nothing is left at
///   the chosen severity or the round limit stops it and the user decides.
/// - "Review with Codex" reviews a project's folder once; the findings wait in a report.
/// - @codex in a chat asks Codex itself; findings it reports are kept as a report too.
extension Workspace {
    /// Codex's own chat works in your home folder.
    static var codexHomeFolder: URL { FileManager.default.homeDirectoryForCurrentUser }

    func setUpCodex() {
        var loaded = codexStore.load()
        // A review that was running when the app quit went with it.
        for index in loaded.indices where loaded[index].state == .reviewing {
            loaded[index].state = .failed
            loaded[index].error = "ClaudeCodeBot quit while Codex was reviewing."
        }
        codexReviews = loaded
        codexDesk.onFindings = { [weak self] output, folder in
            Task { @MainActor in self?.recordCodexAnswer(output, folder: folder) }
        }
        codexBot.onReply = { [weak self] _, _ in
            guard let self else { return }
            if selection == Self.codexID { codexBot.markRead() }
        }
    }

    // MARK: What bots are told

    /// The rules for a bot whose subagents Codex reviews; empty while it is off.
    func codexBriefing(for bot: Bot) -> String {
        let settings = bot.codexSettings
        guard settings.mode != .off else { return "" }
        let ask = settings.mode == .ask
            ? "Before you hand such work off, ask the user with a choices block whether Codex should review it (\"Review with Codex\" recommended, \"Skip review\"), and add the Codex lines below only when they pick the review."
            : "Do this for every subagent whose work changes code in a git repository."
        return """
        (App: Codex review is on for your subagents' code changes, up to \(settings.maxRounds) fix round\(settings.maxRounds == 1 ? "" : "s"). \(ask)
        - Give that subagent a short name (the Agent tool's name), and add to its task: "Codex review: when the work is done and the tests pass, do not merge and do not remove your worktree yet. Stop and report the full path of the folder with your changes and its branch. Codex reviews the change; anything to fix comes back to you by message; you will be told when to finish."
        - When it reports, end your reply with <codex-review agent="its name" folder="full path of the folder with its changes" base="the branch it compares with, usually main">one line on what the change is for</codex-review>. The app runs Codex (never run Codex yourself) and tells you what to send back to the subagent or when it is clean.)
        """
    }

    /// The bot hears the new rules with its next message (an asleep one reads them at wake-up).
    func retellCodexRules(to ownerID: UUID) {
        guard let bot = member(ownerID) else { return }
        let rules = codexBriefing(for: bot)
        bot.queueNote(rules.isEmpty ? "(App: Codex review for your subagents is off now: do not add the Codex lines to their tasks or use the <codex-review> tag.)" : rules)
    }

    // MARK: Looking up

    /// A bot's member id (`mainBotID`, a project's id, `codexID`).
    func ownerID(of bot: Bot) -> UUID? {
        if bot === codexBot { return Self.codexID }
        return everyMember.first { $0.bot === bot }?.id
    }

    /// The reviews shown with `bot` (Codex shows everyone's), newest first.
    public func codexReviews(for bot: Bot) -> [CodexReview] {
        let all = codexReviews.reversed()
        guard bot !== codexBot else { return Array(all) }
        guard let id = ownerID(of: bot) else { return [] }
        return all.filter { $0.ownerID == id }
    }

    public func codexReview(_ id: UUID) -> CodexReview? {
        codexReviews.first { $0.id == id }
    }

    /// The loop over a subagent's work, matched by the name the bot gave it (or its title).
    public func codexReview(forSubagent subagent: Subagent, of bot: Bot) -> CodexReview? {
        guard let owner = ownerID(of: bot) else { return nil }
        let names = Set([subagent.name, subagent.description].compactMap { $0?.lowercased() }.filter { !$0.isEmpty })
        guard !names.isEmpty else { return nil }
        return codexReviews.last { $0.kind == .loop && $0.ownerID == owner && $0.agent.map { names.contains($0.lowercased()) } == true }
    }

    /// Any Codex run under way (the left column's row says so).
    public var codexIsReviewing: Bool { codexReviews.contains { $0.state == .reviewing } }

    private func update(_ id: UUID, _ change: (inout CodexReview) -> Void) {
        guard let index = codexReviews.firstIndex(where: { $0.id == id }) else { return }
        change(&codexReviews[index])
        codexReviews[index].updatedAt = Date()
        codexStore.save(codexReviews)
    }

    // MARK: The loop over a subagent's work

    /// A bot's `<codex-review>` tag: the first round of a new loop, or the next round of the one
    /// whose findings that subagent was fixing.
    func requestCodexReview(agent: String, folder path: String, base: String?, note: String, from ownerID: UUID) {
        guard let bot = member(ownerID) else { return }
        let agent = agent.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let folder = Self.folderURL(path), FileManager.default.fileExists(atPath: folder.path) else {
            bot.appMessage("(App: Codex cannot review \(path): no such folder. Use the full path of the folder with the subagent's changes in <codex-review folder=\"…\">.)")
            return
        }
        let who = agent.isEmpty ? folder.lastPathComponent : agent
        let named: String? = agent.isEmpty ? nil : agent
        if let current = codexReviews.last(where: { $0.kind == .loop && $0.ownerID == ownerID && $0.agent == named && ($0.isActive || $0.state == .stuck) }) {
            if current.state == .reviewing {
                bot.appMessage("(App: Codex is already reviewing \(who)'s change; wait for its result.)")
                return
            }
            // The subagent reported back: the next round, on the same review.
            update(current.id) { review in
                review.folder = folder.path
                if let base { review.base = base }
                if !note.isEmpty { review.note = note }
                // Asked again past the limit (it was stuck): one more round is allowed.
                if review.state == .stuck { review.maxRounds = max(review.maxRounds, review.round + 1) }
            }
            runCodexRound(current.id)
            return
        }
        let settings = bot.codexSettings
        let review = CodexReview(
            kind: .loop,
            ownerID: ownerID,
            agent: agent.isEmpty ? nil : agent,
            title: "Codex review · \(who)",
            folder: folder.path,
            base: base,
            note: note.isEmpty ? nil : note,
            maxRounds: settings.maxRounds,
            sendBack: settings.sendBack
        )
        codexReviews.append(review)
        codexStore.save(codexReviews)
        tell(bot, review.maxRounds == 1
            ? L("Codex is reviewing **{0}**'s change (up to 1 fix round).", who)
            : L("Codex is reviewing **{0}**'s change (up to {1} fix rounds).", who, review.maxRounds), sourceID: Self.codexID)
        runCodexRound(review.id)
    }

    /// Runs Codex over the review's folder once, then acts on what it found. A single review
    /// first counts the files in its scope and skips Codex when there are none.
    func runCodexRound(_ id: UUID) {
        guard let review = codexReview(id) else { return }
        codexRuns[id]?.cancel()
        update(id) { $0.state = .reviewing; $0.error = nil }
        let earlier = review.kind == .loop ? review.findings.filter { $0.status == .sent } : []
        let folder = URL(filePath: review.folder, directoryHint: .isDirectory)
        let runner = codexRunner
        codexRuns[id] = Task { [weak self] in
            var scope = review.reviewedScope
            if review.kind == .single {
                if review.scope == .lastCommit {
                    let commit = await Task.detached { GitDiff.shortHash("HEAD", folder: folder) }.value
                    self?.update(id) { $0.commit = commit }
                    scope = commit.map { .commit($0) } ?? .lastCommit
                }
                let files = await GitDiff.load(folder: folder, scope: scope).files.count
                guard !Task.isCancelled else { return }
                self?.update(id) { $0.changedFiles = files }
                if files == 0 {
                    self?.finishEmptyCodexRound(id)
                    return
                }
            }
            do {
                let output = try await runner.run(CodexRequest(prompt: CodexPrompts.review(scope: scope, focus: review.note, spec: review.specPath, earlier: earlier), folder: folder))
                guard !Task.isCancelled else { return }
                self?.finishCodexRound(id, output)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self?.failCodexRound(id, error.localizedDescription)
            }
        }
    }

    /// Nothing in the scope: no Codex run, and no "Clean" for a change that is not there.
    func finishEmptyCodexRound(_ id: UUID) {
        codexRuns[id] = nil
        guard codexReview(id)?.state == .reviewing else { return }
        update(id) { $0.state = .empty }
        guard let review = codexReview(id), let bot = member(review.ownerID) else { return }
        tell(bot, L("**Codex review** of {0}: no changes to review ({1}).", URL(filePath: review.folder).lastPathComponent, review.reviewedScope.displayName.lowercased()), sourceID: Self.codexID)
    }

    func finishCodexRound(_ id: UUID, _ output: CodexOutput) {
        codexRuns[id] = nil
        guard codexReview(id)?.state == .reviewing else { return }
        update(id) { $0.absorb(output) }
        guard let review = codexReview(id), let bot = member(review.ownerID) else { return }
        if review.kind == .single {
            update(id) { $0.state = $0.openFindings.isEmpty ? .clean : .open }
            let done = codexReview(id) ?? review
            tell(bot, Self.singleNotice(done), sourceID: Self.codexID)
            return
        }
        let who = review.agent ?? URL(filePath: review.folder).lastPathComponent
        switch review.next() {
        case .clean:
            update(id) { $0.state = .clean }
            let left = review.openFindings.count
            let clean = review.round == 1 ? L("**Codex · clean** — {0}'s change has nothing to fix", who) : L("**Codex · clean** — {0}'s change is clean after {1} rounds", who, review.round)
            let open = left == 0 ? "" : left == 1 ? L(" (1 lower finding left open)") : L(" ({0} lower findings left open)", left)
            tell(bot, clean + open + L("."), sourceID: Self.codexID)
            bot.appMessage("(App: Codex review of \(Self.quote(who))'s change is clean after \(review.round) round\(review.round == 1 ? "" : "s")\(left > 0 ? "; \(left) finding\(left == 1 ? "" : "s") below the level your settings send back stay open in the report" : ""). If \(Self.quote(who)) is waiting for the review, tell it with SendMessage to finish its task now (merge, clean up as its task says), then report the result to the user in one sentence.)")
        case let .fix(findings):
            update(id) { $0.markSent(Set(findings.map(\.id))); $0.state = .fixing }
            tell(bot, L("**Codex · round {0}** found {1} to fix in {2}'s change; sent back to {2}:", review.round, findings.count, who) + "\n" + Self.list(findings), sourceID: Self.codexID)
            bot.appMessage(Self.fixMessage(codexReview(id) ?? review, findings))
        case let .stuck(findings):
            update(id) { $0.state = .stuck }
            let stopped = findings.count == 1
                ? L("**Codex · stopped at max rounds** — 1 finding left in {0}'s change after {1} rounds:", who, review.round)
                : L("**Codex · stopped at max rounds** — {0} findings left in {1}'s change after {2} rounds:", findings.count, who, review.round)
            let card = tell(bot, stopped + "\n" + Self.list(findings), choices: [
                Choice(label: L("Fix once more"), detail: L("Send them back to {0} for one more round", who), recommended: true),
                Choice(label: L("Accept as is"), detail: L("{0} finishes; they stay open in the report", who))
            ], sourceID: Self.codexID)
            codexQuestions[card] = id
            refreshWaiting()
            bot.appMessage("(App: Codex review of \(Self.quote(who))'s change stopped at the limit of \(review.maxRounds) round\(review.maxRounds == 1 ? "" : "s"); \(findings.count) finding\(findings.count == 1 ? " is" : "s are") left:\n\(findings.map(\.briefLine).joined(separator: "\n"))\nThe user decides on the card in this chat whether to fix once more or accept it as is. Do not send more fixes and do not let \(Self.quote(who)) finish until you hear which.)")
        }
    }

    func failCodexRound(_ id: UUID, _ message: String) {
        codexRuns[id] = nil
        update(id) { $0.state = .failed; $0.error = message }
        guard let review = codexReview(id), let bot = member(review.ownerID) else { return }
        let who = review.agent ?? URL(filePath: review.folder).lastPathComponent
        tell(bot, L("**Codex could not review** {0}'s change: {1}", who, message), sourceID: Self.codexID)
        if review.kind == .loop {
            bot.appMessage("(App: Codex could not review \(Self.quote(who))'s change: \(Self.firstLine(of: message)). Tell the user in one sentence and ask whether \(Self.quote(who)) should finish without the review.)")
        }
    }

    /// The card's (or report's) "Fix once more": one more round past the limit.
    public func fixCodexOnceMore(_ id: UUID) {
        guard let review = codexReview(id), review.kind == .loop, review.state == .stuck || review.state == .stopped,
              let bot = member(review.ownerID) else { return }
        let toFix = review.openFindings.filter { review.sendBack.includes($0.severity) }
        guard !toFix.isEmpty else { return }
        closeCodexCards(for: id)
        update(id) { review in
            review.maxRounds = max(review.maxRounds, review.round + 1)
            review.markSent(Set(toFix.map(\.id)))
            review.state = .fixing
        }
        bot.appMessage(Self.fixMessage(codexReview(id) ?? review, toFix))
    }

    /// "Accept as is": the subagent finishes; what is left stays open in the report.
    public func acceptCodexReview(_ id: UUID) {
        guard let review = codexReview(id), review.kind == .loop, let bot = member(review.ownerID) else { return }
        closeCodexCards(for: id)
        update(id) { $0.state = .stopped }
        let who = review.agent ?? "the subagent"
        bot.appMessage("(App: The user accepted \(Self.quote(who))'s change as it is; the open Codex findings stay in the report. Tell \(Self.quote(who)) with SendMessage to finish its task now (merge, clean up), then report the result in one sentence.)")
    }

    /// "Stop loop": no more rounds; a run under way is dropped.
    public func stopCodexReview(_ id: UUID) {
        guard let review = codexReview(id), review.isActive || review.state == .stuck else { return }
        codexRuns.removeValue(forKey: id)?.cancel()
        closeCodexCards(for: id)
        update(id) { $0.state = .stopped }
        if review.kind == .loop, let bot = member(review.ownerID) {
            let who = review.agent ?? "the subagent"
            bot.appMessage("(App: The user stopped the Codex review of \(Self.quote(who))'s change. Do not wait for more Codex rounds: tell \(Self.quote(who)) with SendMessage to finish as its task says, and report in one sentence.)")
        }
    }

    /// Answers the loop's open "Fix once more / Accept" card, once the choice is made elsewhere.
    private func closeCodexCards(for id: UUID) {
        guard let review = codexReview(id), let bot = member(review.ownerID) else { return }
        for (card, about) in codexQuestions where about == id {
            codexQuestions[card] = nil
            if bot.messages.first(where: { $0.id == card })?.isOpenQuestion == true {
                bot.markAnswered("Answered in the report", in: card)
            }
        }
        refreshWaiting()
    }

    // MARK: A single review

    /// What "Review with Codex" can review in the bot's folder; nil when it is no repository.
    public func codexScopeChoices(for bot: Bot) async -> CodexScopeChoices? {
        let folder = bot.profile.workingDirectory
        return await Task.detached { CodexScopeChoices(folder: folder) }.value
    }

    /// "Review with Codex" (or a component's `ccb.reviewWithCodex`): reviews the bot's folder
    /// once, in `scope` (by default its branch against main or master, or what is not committed
    /// on those), checked against `spec` when one is given. Nil, with the reason in the chat,
    /// when it cannot.
    @discardableResult
    public func reviewWithCodex(_ bot: Bot, scope: CodexScope? = nil, spec: String? = nil) -> UUID? {
        guard let ownerID = ownerID(of: bot), bot !== codexBot else { return nil }
        guard let repository = GitDiff.repositoryRoot(bot.profile.workingDirectory) else {
            tell(bot, L("Codex reviews changes in a git repository; {0} is not one.", bot.profile.workingDirectory.lastPathComponent), sourceID: Self.codexID)
            return nil
        }
        if let running = codexReviews.last(where: { $0.kind == .single && $0.ownerID == ownerID && $0.state == .reviewing }) {
            return running.id
        }
        let branch = GitDiff.currentBranch(folder: repository)
        let scope = scope ?? CodexScopeChoices(folder: repository)?.suggested ?? .uncommitted
        var base: String?
        if case let .branch(name) = scope { base = name }
        let review = CodexReview(
            kind: .single,
            ownerID: ownerID,
            title: "Codex review · \(branch ?? repository.lastPathComponent)",
            folder: repository.path,
            base: base,
            scope: scope,
            branch: branch,
            spec: spec
        )
        codexReviews.append(review)
        codexStore.save(codexReviews)
        runCodexRound(review.id)
        return review.id
    }

    /// "Run again" on a single review: what was sent and is gone now is marked fixed.
    public func rerunCodexReview(_ id: UUID) {
        guard let review = codexReview(id), review.kind == .single, review.state != .reviewing else { return }
        runCodexRound(id)
    }

    /// "Send selected to <bot>": the findings go to the bot as your message and are marked as
    /// being fixed.
    public func sendCodexFindings(_ ids: Set<UUID>, of id: UUID) {
        guard let review = codexReview(id), let bot = member(review.ownerID), bot !== codexBot else { return }
        let chosen = review.findings.filter { ids.contains($0.id) }
        guard !chosen.isEmpty else { return }
        update(id) { $0.markSent(Set(chosen.map(\.id))) }
        if review.kind == .loop, let agent = review.agent {
            bot.send("Please have \(agent) fix these Codex findings in \(review.folder) (send them to it with SendMessage):\n" + chosen.map(\.briefLine).joined(separator: "\n"))
        } else {
            bot.send("Fix these Codex findings in \(review.folder)\(review.base.map { " (the change against \($0))" } ?? ""):\n" + chosen.map(\.briefLine).joined(separator: "\n"))
        }
    }

    /// Marks findings fixed, skipped or open again by hand.
    public func setCodexFindings(_ ids: Set<UUID>, of id: UUID, to status: CodexFinding.Status) {
        update(id) { review in
            review.set(status, for: ids)
            if review.kind == .single, review.state == .open || review.state == .clean {
                review.state = review.openFindings.isEmpty && !review.findings.contains { $0.status == .sent } ? .clean : .open
            }
        }
    }

    /// What @codex found in a chat, kept as a report of the chat's bot (Codex's own otherwise).
    func recordCodexAnswer(_ output: CodexOutput, folder: URL) {
        let path = folder.standardizedFileURL.path
        let owner = everyMember.first { $0.bot.profile.workingDirectory.standardizedFileURL.path == path && $0.id != Self.mainBotID }?.id ?? Self.codexID
        var review = CodexReview(kind: .single, ownerID: owner, title: "Codex · \(folder.lastPathComponent)", folder: path, base: nil)
        review.absorb(output)
        review.state = review.openFindings.isEmpty ? .clean : .open
        codexReviews.append(review)
        codexStore.save(codexReviews)
    }

    /// The change Codex reviewed, for the review panel's diff.
    public func codexDiff(for id: UUID) async -> GitDiff {
        guard let review = codexReview(id) else { return GitDiff(files: []) }
        return await GitDiff.load(folder: URL(filePath: review.folder, directoryHint: .isDirectory), scope: review.reviewedScope)
    }

    // MARK: Words

    static func quote(_ name: String) -> String { "\"\(name)\"" }

    /// One line per finding, worst first, for a notice.
    static func list(_ findings: [CodexFinding]) -> String {
        findings.sorted { $0.severity < $1.severity }.map { finding in
            "- **\(finding.severity.displayName)** \(finding.place.isEmpty ? "" : "`\(finding.place)` ")\(finding.title)"
        }.joined(separator: "\n")
    }

    static func singleNotice(_ review: CodexReview) -> String {
        let counts = CodexSeverity.allCases.compactMap { severity -> String? in
            let n = review.count(severity, status: [.open])
            return n == 0 ? nil : "\(n) \(severity.displayName.lowercased())"
        }
        let folder = URL(filePath: review.folder).lastPathComponent
        if counts.isEmpty { return L("**Codex review** of {0}: nothing to fix.", folder) + " \(review.summary)" }
        return L("**Codex review** of {0}: {1}. The report is under Results.", folder, counts.joined(separator: " · ")) + "\n\n\(review.summary)"
    }

    /// What the bot is told to send back to its subagent.
    static func fixMessage(_ review: CodexReview, _ findings: [CodexFinding]) -> String {
        let who = review.agent ?? "the subagent"
        let base = review.base.map { " base=\"\($0)\"" } ?? ""
        return """
        (App: Codex review round \(review.round) of \(review.maxRounds) of \(quote(who))'s change in \(review.folder) found \(findings.count) thing\(findings.count == 1 ? "" : "s") to fix:
        \(findings.map(\.briefLine).joined(separator: "\n"))
        Send these to that same subagent with SendMessage (to: \(quote(who))) so it fixes them with the context it already has. Do not start a new subagent and do not fix them yourself. Ask it to stop again before merging and report back. When it reports, end your reply with <codex-review agent="\(who)" folder="\(review.folder)"\(base)/> for the next round. Do not report each round to the user; the app shows them.)
        """
    }
}

extension Workspace {
    /// Whether "Review with Codex" is offered for `bot`: a project's manager with a folder of its
    /// own (not Codex itself, a standalone bot or the main bot).
    public func canRequestReview(of bot: Bot) -> Bool {
        bot !== codexBot && bot.profile.role == .manager && !bot.profile.isStandalone
    }
}
