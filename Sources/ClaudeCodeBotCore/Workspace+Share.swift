import Foundation

/// A /share card waiting for a pick: the list of features, or one feature's checklist.
enum ShareCard {
    case pick([CommunityShare.Feature], project: UUID, base: String)
    case send(CommunityShare.Feature, project: UUID, owner: String)

    /// What the card asked, for when you write instead of picking.
    var about: String {
        switch self {
        case .pick: "asking which feature to share"
        case let .send(feature, _, _): "asking to open a pull request for \(feature.branch)"
        }
    }
}

/// /share, in developer mode: the developer project's chat lists the features you built, checks
/// the one you pick, and opens a pull request for it to ClaudeCodeBot (`CommunityShare`).
extension Workspace {
    /// /share is offered in the input box of the developer project's chat.
    public func offersShare(in bot: Bot) -> Bool {
        guard let developer = developerProject else { return false }
        return managers[developer.id] === bot
    }

    /// `text` is /share (alone, or with a branch): the app answers it instead of the bot. False
    /// for anything else, which goes to the bot as usual.
    func share(_ text: String, in bot: Bot) -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace)
        guard words.first == "/share", words.count <= 2 else { return false }
        bot.post(ChatMessage(role: .user, text: text), unread: false)
        guard offersShare(in: bot), let project = developerProject else {
            tell(bot, "/share needs developer mode, in the chat of the project that is ClaudeCodeBot's source: it shares a feature you built there as a pull request. Turn it on in Settings › Developer mode.")
            return true
        }
        let asked = words.count == 2 ? String(words[1]) : nil
        let repo = project.folder
        Task { [weak self] in
            let (base, features) = await Task.detached {
                let base = CommunityShare.base(in: repo)
                return (base, CommunityShare.features(in: repo, base: base))
            }.value
            guard let self else { return }
            if let asked {
                guard let feature = features.first(where: { $0.branch == asked }) else {
                    tell(bot, "No feature called \(asked) to share: it is not a branch with commits \(base) does not have.\(features.isEmpty ? "" : " Yours: " + features.map(\.branch).joined(separator: ", ") + ".")")
                    return
                }
                await check(feature, project: project.id, base: base, in: bot)
                return
            }
            guard !features.isEmpty else {
                tell(bot, "No features to share yet. A feature is a branch with commits \(base) does not have: ask your Manager to build one on a branch of its own (bot/<name>), then /share again.")
                return
            }
            let card = CommunityShare.listCard(features, base: base)
            let question = tell(bot, card.text, choices: card.choices, sourceID: project.id)
            shareQuestions[question] = .pick(card.offered, project: project.id, base: base)
        }
        return true
    }

    /// Your pick on a /share card.
    func answerShare(_ card: ShareCard, index: Int, in bot: Bot) {
        switch card {
        case let .pick(features, project, base):
            guard features.indices.contains(index) else { return }
            Task { await check(features[index], project: project, base: base, in: bot) }
        case let .send(feature, project, owner):
            guard index == 0, let folder = self.project(project)?.folder else { return }
            Task { await open(feature, owner: owner, from: folder, in: bot, project: project) }
        }
    }

    /// The checklist for `feature`; a card to open its pull request when nothing failed.
    private func check(_ feature: CommunityShare.Feature, project: UUID, base: String, in bot: Bot) async {
        guard let repo = self.project(project)?.folder else { return }
        let (checks, owner) = await Task.detached {
            (CommunityShare.checklist(for: feature, in: repo, base: base), CommunityShare.owner(in: repo))
        }.value
        let card = CommunityShare.checklistCard(feature, checks: checks, owner: owner)
        guard card.ready, let owner else {
            tell(bot, card.text, sourceID: project)
            return
        }
        let question = tell(bot, card.text, choices: [Choice(label: "Open pull request", recommended: true), Choice(label: "Not now")], sourceID: project)
        shareQuestions[question] = .send(feature, project: project, owner: owner)
    }

    /// Pushes `feature` to your fork and opens its pull request with the label, making the label
    /// on ClaudeCodeBot first when it is missing there; one you may not add is left for the owner
    /// to add, and the result says why.
    private func open(_ feature: CommunityShare.Feature, owner: String, from folder: URL, in bot: Bot, project: UUID) async {
        let run = shareRunner
        let push = await Task.detached { run(["git", "push", "-u", "origin", feature.branch], folder) }.value
        guard push.ok else {
            tell(bot, "Couldn't push \(feature.branch) to your fork, so no pull request was opened:\n\n```\n\(push.output)\n```", sourceID: project)
            return
        }
        let (made, refused) = await Task.detached { () -> ((ok: Bool, output: String), String?) in
            let labelled = CommunityShare.pullRequest(for: feature, owner: owner, label: true)
            var made = run(labelled, folder)
            guard !made.ok, made.output.localizedCaseInsensitiveContains("label") else { return (made, nil) }
            // gh refused the label: most often it is missing on ClaudeCodeBot. Make it, then try again.
            let creation = run(CommunityShare.labelCreation(), folder)
            let there = creation.ok || creation.output.localizedCaseInsensitiveContains("already exists")
            if there {
                made = run(labelled, folder)
                guard !made.ok, made.output.localizedCaseInsensitiveContains("label") else { return (made, nil) }
            }
            let why = there ? made.output : creation.output
            return (run(CommunityShare.pullRequest(for: feature, owner: owner, label: false), folder), why)
        }.value
        guard made.ok else {
            tell(bot, "Couldn't open the pull request for \(feature.branch):\n\n```\n\(made.output)\n```", sourceID: project)
            return
        }
        let link = made.output.split(whereSeparator: \.isNewline).last { $0.hasPrefix("https://") }.map(String.init) ?? made.output
        let label = refused.map { " It went without the \(CommunityShare.label) label, so the Release planner does not list it until the owner adds it: GitHub refused it (`\($0.split(whereSeparator: \.isNewline).last.map(String.init) ?? $0)`)." } ?? ""
        tell(bot, "Opened a pull request for \"\(feature.title)\": \(link)\(label) Others vote on it with 👍.", sourceID: project)
        bot.queueNote("(App: The user shared \(feature.branch) with /share: \(link). Commits pushed to that branch later update the pull request.)")
    }
}
