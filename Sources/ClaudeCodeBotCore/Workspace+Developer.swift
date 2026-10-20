import Foundation

/// Developer mode, for working on ClaudeCodeBot itself (off for everyone else): one project is
/// ClaudeCodeBot's own source, and its manager may install new builds of the app (you confirm,
/// and a build that does not come up is rolled back), look at the app's window, and gets what
/// you flag as "not right" in any chat.
extension Workspace {
    /// The project that is ClaudeCodeBot's own source, while developer mode is on.
    public var developerProject: Project? {
        guard settings.developerMode, let id = settings.developerProjectID else { return nil }
        return projects.first { $0.id == id && !$0.isBot }
    }

    func isDeveloperProject(_ project: Project?) -> Bool {
        guard let project, let developer = developerProject else { return false }
        return project.id == developer.id
    }

    /// Turns developer mode on or off, with the project that is ClaudeCodeBot's source. Its
    /// manager hears about it at once if awake, else at its next wake.
    public func setDeveloperMode(_ on: Bool, project: UUID?) {
        let before = developerProject
        settings.developerMode = on
        settings.developerProjectID = project ?? settings.developerProjectID
        settings.save(to: settingsURL)
        // Turning it on again gives builds a fresh start after failures.
        if on { SelfUpdate.setFailures(0, in: root) }
        if let now = developerProject, now.id != before?.id {
            managers[now.id]?.queueNote(developerBriefing(for: now))
        }
        if let before, before.id != developerProject?.id {
            managers[before.id]?.queueNote("(App: Developer mode is off for this project now: you can no longer install builds of ClaudeCodeBot or take screenshots of it.)")
        }
    }

    /// What the developer project's manager is told on top of a manager's usual instructions.
    func developerBriefing(for project: Project) -> String {
        guard isDeveloperProject(project) else { return "" }
        let worktrees = project.notesFolder.appending(path: "worktrees").path
        return """
        (App: Developer mode. This folder is ClaudeCodeBot's own source, the app you are running in, and you develop it.
        - One writer at a time. Do each task in a git worktree of its own: git worktree add \(worktrees)/<short-task> -b bot/<short-task>. Edit, build and test there; when the tests pass, merge it into the main branch and remove the worktree. If git status in the main folder shows changes you did not make, someone else is working: stop and ask the user.
        - Feedback from the user ("not right" on a reply) comes to you with the chat around it. First write a test that shows the problem (a live test in LiveClaudeTests when it needs the real claude), then fix it, then say in one sentence what was wrong.
        - To try your work: from the main folder, after merging, build with SINGLE_ARCH=1 scripts/make-app.sh <version>-dev. See how a chat looks in that build without installing it: dist/ClaudeCodeBot.app/Contents/MacOS/ClaudeCodeBot --snapshot "<chat name>" <png path>, then read the PNG.
        - To install it: write where you are into your memory file first (you are restarted too), then end your reply with <install-build path="full path of dist/ClaudeCodeBot.app">what changed, in a sentence or two</install-build>. The user confirms; the app restarts on the new build and tells you whether it came up. A build that does not come up is rolled back by itself.
        - To see the running app: end your reply with <app-screenshot/>; a picture of its window comes back to you.
        - Never change what bots may do (tools, permissions, the prompts' rules) unless the user asked for it; the install card shows such changes to the user.)
        """
    }

    // MARK: Installing a build

    /// A manager asked to install a build: only the developer project, from a real app bundle,
    /// while builds have not failed too often; a card shows what changes, with a warning when it
    /// changes what bots are told or allowed to do.
    func proposeBuild(_ path: String, note: String, from project: Project) {
        let manager = managers[project.id]
        guard isDeveloperProject(project) else {
            manager?.queueNote("(App: Installing builds of ClaudeCodeBot needs developer mode with this project as ClaudeCodeBot's source; it is off. Nothing was installed.)")
            return
        }
        func refuse(_ why: String) {
            tell(mainBot, "\(project.name) asked to install a ClaudeCodeBot build, but \(why)", sourceID: project.id)
            manager?.queueNote("(App: The build was not installed: \(why))")
        }
        guard let running = runningBuild else {
            return refuse("this ClaudeCodeBot is not running from an app bundle (swift run), so it cannot replace itself.")
        }
        guard SelfUpdate.failures(in: root) < SelfUpdate.failureLimit else {
            return refuse("the last \(SelfUpdate.failureLimit) builds did not come up, so installing is paused. Turn developer mode off and on in Settings to allow it again.")
        }
        guard let folder = Self.folderURL(path), let build = BuildInfo.read(folder) else {
            return refuse("there is no app bundle at \(path).")
        }
        guard build.bundleID == running.bundleID else {
            return refuse("\(path) is not ClaudeCodeBot (\(build.bundleID)).")
        }
        guard build.path != running.path else {
            return refuse("that is the build running now; build into dist/ and point at that.")
        }
        var lines = ["**\(project.name)** wants to install a new ClaudeCodeBot build and restart.", "",
                     "- New: \(build.label)", "- Running: \(running.label)"]
        let what = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !what.isEmpty { lines += ["", what] }
        if build.dirty { lines += ["", "It was built from uncommitted changes."] }
        var sensitive = false
        if let old = running.commit, let new = build.commit {
            if let changes = SelfUpdate.sensitiveChanges(in: project.folder, from: old, to: new), !changes.isEmpty {
                sensitive = true
                lines += ["", "⚠️ **It changes what bots are told or allowed to do:**"]
                lines += changes.map { "- `\($0.file)` +\($0.added) −\($0.removed)" }
                lines += ["", "To read it first: `git -C \(project.folder.path) diff \(old.prefix(7)) \(new.prefix(7)) -- \(changes.map(\.file).joined(separator: " "))`"]
            }
        } else {
            lines += ["", "Which commits these are is not known, so changes to what bots may do cannot be shown."]
        }
        lines += ["", "Bots write down where they are before the restart. If the new build does not come up within \(SelfUpdate.healthWait) seconds, the running one comes back by itself."]
        let question = tell(mainBot, lines.joined(separator: "\n"), choices: [
            Choice(label: sensitive ? "Install anyway and restart" : "Install and restart", detail: nil, recommended: !sensitive),
            Choice(label: "Not now", detail: nil, recommended: sensitive)
        ], sourceID: project.id)
        buildQuestions[question] = (build, project.id, what)
        manager?.queueNote("(App: The user sees a card asking to install \(build.label). Nothing happens until they pick.)")
    }

    /// Your pick on a build card.
    func answerBuild(_ build: BuildInfo, requester: UUID, note: String, install: Bool) {
        let manager = managers[requester]
        guard install else {
            manager?.queueNote("(App: The user chose not to install \(build.label) now.)")
            return
        }
        guard let running = runningBuild, let launch = launchInstaller else { return }
        do {
            let command = try SelfUpdate.prepare(from: running, to: build, requester: requester, note: note, pid: ProcessInfo.processInfo.processIdentifier, in: root)
            launch(command)
        } catch {
            tell(mainBot, "Couldn't start installing \(build.label): \(error.localizedDescription)")
        }
    }

    /// At launch: how an install went. The new build counts as up once it has run
    /// `SelfUpdate.healthyAfter` seconds; then the bot that asked is told, and so are you.
    public func checkSelfUpdate(healthyAfter: TimeInterval = SelfUpdate.healthyAfter) {
        switch SelfUpdate.outcome(in: root) {
        case nil:
            return
        case let .installed(state):
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(healthyAfter))
                guard let self else { return }
                SelfUpdate.markHealthy(in: root)
                SelfUpdate.setFailures(0, in: root)
                let name = project(state.requesterID)?.name ?? "A bot"
                tell(mainBot, "ClaudeCodeBot restarted on \(state.to.label) (was \(state.from.label)), installed for \(name).", sourceID: state.requesterID)
                managers[state.requesterID]?.relay("(App) ClaudeCodeBot restarted on \(state.to.label), the build you asked to install\(state.note.isEmpty ? "" : " (\(state.note))"). Read your memory file for where you were, check that your change works (<app-screenshot/> shows the window), then say in one sentence whether it does.")
            }
        case let .rolledBack(state, reason):
            SelfUpdate.finish(in: root)
            let failures = SelfUpdate.failures(in: root) + 1
            SelfUpdate.setFailures(failures, in: root)
            let paused = failures >= SelfUpdate.failureLimit
                ? " That is \(failures) in a row: installing is paused until developer mode is turned off and on again."
                : ""
            tell(mainBot, "The new build \(state.to.label) did not come up (\(reason)); \(state.from.label) is running again.\(paused)", sourceID: state.requesterID)
            managers[state.requesterID]?.relay("(App) The build you asked to install, \(state.to.label), did not come up: \(reason). ClaudeCodeBot put \(state.from.label) back. The install log is \(SelfUpdate.logURL(in: root).path); the failed build was kept beside the app as ClaudeCodeBot.app.failed. Find out why before trying again.\(paused)")
        }
    }

    // MARK: Looking at the app

    /// The developer project's manager asked to see the app: a picture of its window comes back.
    func sendScreenshot(to project: Project) {
        guard isDeveloperProject(project) else {
            managers[project.id]?.queueNote("(App: Screenshots of ClaudeCodeBot need developer mode with this project as its source.)")
            return
        }
        Task { [weak self] in
            guard let self else { return }
            guard let picture = await captureWindow?() else {
                managers[project.id]?.relay("(App) Couldn't take a screenshot of the app's window.")
                return
            }
            managers[project.id]?.relay("(App) The app's window right now.", files: [picture])
        }
    }

    // MARK: Feedback

    /// You flagged a reply as not right: it goes to the developer project with the chat around
    /// it, to become a test and a fix. `screenshot` is the chat as you saw it, centered on that
    /// reply; `files` are pictures you added. Both are kept in the developer project's
    /// attachments folder and listed in the report.
    @discardableResult
    public func reportFeedback(_ text: String, on messageID: UUID, in chat: Bot, screenshot: URL? = nil, files: [URL] = []) -> Bool {
        guard let developer = developerProject, let manager = managers[developer.id],
              let index = chat.messages.firstIndex(where: { $0.id == messageID }) else { return false }
        let message = chat.messages[index]
        let around = chat.messages[max(0, index - 12)...index].compactMap(Bot.archiveEntry).joined(separator: "\n")
        let steps = message.steps.map { "\n\nWhat it did on the way: " + $0.map(\.title).joined(separator: " → ") } ?? ""
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var pictures: [String] = []
        if screenshot != nil {
            pictures.append("The first attachment is a screenshot of the chat as the user saw it, centered on that reply.")
        }
        if !files.isEmpty {
            pictures.append("With it the user added \(files.count) picture\(files.count == 1 ? "" : "s") of their own.")
        }
        let seen = pictures.isEmpty ? "" : "\n\n" + pictures.joined(separator: " ")
        let report = """
        Feedback: the user flagged a reply of \(chat.name) as not right.
        What is wrong, in their words: \(words.isEmpty ? "(they did not say)" : words)

        The chat up to that reply, oldest first:
        \(around)\(steps)\(seen)

        First write a test that shows this, then fix it.
        """
        manager.relay(report, files: [screenshot].compactMap { $0 } + files)
        let kept = manager.messages.last { $0.role == .relay }?.attachments ?? []
        Self.appendFeedback(kept.isEmpty ? report : report + "\n\nAttachments:\n" + kept.map { "- " + $0.url.path }.joined(separator: "\n"), in: root)
        tell(chat, "Sent to \(developer.name) as feedback.", sourceID: developer.id)
        return true
    }

    /// Every feedback report, kept in `<root>/feedback.md`.
    static func appendFeedback(_ report: String, in root: URL) {
        let file = root.appending(path: "feedback.md")
        let stamp = Date().formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits) \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits)", timeZone: .current, calendar: .current))
        let entry = Data("## \(stamp)\n\n\(report)\n\n".utf8)
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: entry)
        } else {
            try? entry.write(to: file)
        }
    }
}
