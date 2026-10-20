import Foundation

/// "Make into component": a bot's reply (or the result page it links to) becomes a component.
/// Pressed, the reply goes to Maintainer, which infers the spec and builds the first version right
/// away (or reuses a library component), asking nothing; the chip under the reply says Building…,
/// then the component itself shows there, on the bot's list. The panel does not open by itself:
/// the component's "Edit spec" opens the spec in the right panel, where the user and Maintainer
/// change it (a side conversation; edits by either show in the fields) and Build it makes a new
/// version. Test run and the component's Command go through the component command allow flow
/// (`ComponentCommands`): the exact command and folder are shown and nothing runs until the user
/// allows it; nothing runs by itself when it lands.
///
/// A bot may suggest one with `<suggest-component>`: that only adds the chip. Nothing runs or is
/// built until the user presses it (then the first version is built, as above).
extension Workspace {
    /// The spec `id`, and the chat whose reply it is made from.
    func specLocation(_ id: UUID) -> (chat: Bot, spec: ComponentSpec)? {
        for chat in chatsWithPins {
            if let spec = chat.specs.first(where: { $0.id == id }) { return (chat, spec) }
        }
        return nil
    }

    /// The open spec, when it belongs to `chat` (the right panel shows it).
    public func openSpec(in chat: Bot) -> ComponentSpec? {
        guard let id = openSpecID else { return nil }
        return chat.specs.first { $0.id == id }
    }

    // MARK: Making one

    /// The reply's "Make into component" (or "Add to another bot…"), or an HTML result card's
    /// (`preview`: which card): adds the chip and has Maintainer build the first version now. A
    /// reply that already is a library component has nothing to build: its spec opens to pick the
    /// bots. Pressed again, nothing more is sent. `purpose`: what the user typed it is for.
    @discardableResult
    public func makeComponent(from messageID: UUID, preview: Int? = nil, purpose: String? = nil, in chat: Bot) -> ComponentSpec? {
        guard let message = chat.messages.first(where: { $0.id == messageID }), message.role == .bot || message.role == .notice else { return nil }
        var page: String?
        if let preview {
            guard let cards = ChatPayload.previews(for: message, in: components), cards.indices.contains(preview),
                  let url = PagePreview.page(inCard: cards[preview].data) else { return nil }
            page = url.path
        }
        if let found = chat.specs.first(where: { $0.messageID == messageID && $0.page == page }) {
            if found.existing != nil { openSpec(found.id, in: chat) } else if isUnstarted(found) { startSpec(found.id, in: chat) }
            return chat.specs.first { $0.id == found.id }
        }
        let writer = message.sourceID.flatMap(member) ?? chat
        var spec = ComponentSpecs.draft(from: message, bot: writer.name, folder: commandFolder(for: message, in: chat), library: components, page: page)
        if let purpose = purpose?.trimmingCharacters(in: .whitespacesAndNewlines), !purpose.isEmpty { spec.purpose = purpose }
        chat.editSpecs { $0.append(spec) }
        if spec.existing != nil { openSpec(spec.id, in: chat) } else { startSpec(spec.id, in: chat) }
        return chat.specs.first { $0.id == spec.id }
    }

    /// A spec nothing has been asked or built for yet (a bot's suggestion not pressed).
    private func isUnstarted(_ spec: ComponentSpec) -> Bool {
        spec.status == .draft && !spec.asked && spec.existing == nil && spec.built == nil
    }

    /// The first version: Maintainer infers the spec from the reply and builds it now (or reuses a
    /// library component), asking nothing. The panel stays shut; the chip says Building….
    func startSpec(_ id: UUID, in chat: Bot) {
        guard var spec = chat.specs.first(where: { $0.id == id }), isUnstarted(spec) else { return }
        let message = chat.messages.first { $0.id == spec.messageID }
        let writer = spec.bots.first ?? chat.name
        spec.status = .building
        spec.asked = true
        spec.conversation.append(.init(kind: .event, text: "Sent to Maintainer to build the first version"))
        store(spec, in: chat)
        let had = components.names.contains(spec.name)
        specBuilds[spec.name] = (chat.id, id, had ? components.versions[spec.name, default: 0] : nil)
        components.markWorking(spec.name, change: "built from a reply")
        handToMaintainer(ComponentSpecs.firstBuildRequest(spec, reply: message?.text ?? "", pages: message.map { ComponentSpecs.pages(of: $0, page: spec.page) } ?? [],
                                                          ran: message.flatMap(ComponentSpecs.lastCommand(in:)), from: writer))
    }

    /// A spec's chip pressed: a bot's suggestion not started yet is built (its first version);
    /// otherwise the spec opens in the right panel, or folds back if it shows there.
    public func pressSpec(_ id: UUID, in chat: Bot) {
        guard let spec = chat.specs.first(where: { $0.id == id }) else { return }
        if isUnstarted(spec) {
            startSpec(id, in: chat)
        } else if openSpecID == id {
            closeSpec()
        } else {
            openSpec(id, in: chat)
        }
    }

    /// A bot's `<suggest-component>`: a chip under its reply, nothing more. One per reply.
    func suggestComponent(name: String, draft: String, from bot: Bot) {
        guard let message = bot.messages.last(where: { $0.role == .bot }),
              !bot.specs.contains(where: { $0.messageID == message.id }) else { return }
        var spec = ComponentSpecs.draft(from: message, bot: bot.name, folder: bot.profile.workingDirectory, library: components)
        let named = ComponentLibrary.safeName(name)
        if spec.existing == nil, !named.isEmpty {
            spec.name = named
            if spec.similar == named { spec.similar = nil }
        }
        spec.about = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // Its words are what the component is for.
        spec.purpose = spec.about.isEmpty ? nil : spec.about
        spec.suggestedBy = bot.name
        bot.editSpecs { $0.append(spec) }
    }

    // MARK: The panel

    /// The chip pressed: the spec opens in the right panel. The first time, Maintainer is asked to
    /// draft it (a spec of a component that already exists only needs bots: nobody is asked).
    public func openSpec(_ id: UUID, in chat: Bot) {
        guard let spec = chat.specs.first(where: { $0.id == id }) else { return }
        openSpecID = id
        let ask = !spec.asked && spec.existing == nil && spec.status == .draft
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }) else { return }
            specs[at].opened = true
            if ask { specs[at].asked = true }
        }
        guard ask else { return }
        let message = chat.messages.first { $0.id == spec.messageID }
        let writer = spec.bots.first ?? chat.name
        handToMaintainer(ComponentSpecs.draftRequest(spec, reply: message?.text ?? "", pages: message.map { ComponentSpecs.pages(of: $0, page: spec.page) } ?? [],
                                                     ran: message.flatMap(ComponentSpecs.lastCommand(in:)), from: writer))
    }

    /// Collapses the panel back to the chip; the spec stays as it is.
    public func closeSpec() {
        openSpecID = nil
        specPanelWide = false
    }

    public func setSpecPanelWide(_ wide: Bool) {
        specPanelWide = wide
    }

    /// The user changed a value in the panel (marked theirs, told to Maintainer with the next word).
    /// A built one can be changed too (Build it then makes a new version); not while it builds.
    public func editSpec(_ id: UUID, key: String, value: String, in chat: Bot) {
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }), specs[at].status != .building else { return }
            ComponentSpecs.edit(key, to: value, in: &specs[at])
        }
    }

    /// The user picked an answer to one of Maintainer's questions.
    public func answerSpec(_ id: UUID, question: String, option: Int, in chat: Bot) {
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }), specs[at].status != .building else { return }
            ComponentSpecs.answer(question, option: option, in: &specs[at])
        }
    }

    /// "Anything to add?": the user's words (with their edits since) go to Maintainer.
    public func saySpec(_ id: UUID, text: String, in chat: Bot) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var spec = chat.specs.first(where: { $0.id == id }), !text.isEmpty || !spec.pendingEdits.isEmpty else { return }
        if !text.isEmpty { spec.conversation.append(.init(kind: .user, text: text)) }
        let request = ComponentSpecs.sayRequest(spec, text: text)
        spec.pendingEdits = []
        spec.asked = true
        chat.editSpecs { specs in
            if let at = specs.firstIndex(where: { $0.id == id }) { specs[at] = spec }
        }
        handToMaintainer(request)
    }

    /// Maintainer's `<component-spec id>`: its values go into the spec, its words into the side
    /// conversation. While it is being built these say what Maintainer built: a question it asked
    /// anyway takes its suggested answer, a new name is the one the build waits for, and a library
    /// component it chose to reuse is added at once. An id no spec has is said back to it.
    func applySpecUpdate(id: String, json: String, said: String) {
        guard let uuid = UUID(uuidString: id.trimmingCharacters(in: .whitespaces)), let (chat, before) = specLocation(uuid) else {
            maintainer.queueNote("(App: No component spec has the id \(id); nothing changed.)")
            return
        }
        let words = said.trimmingCharacters(in: .whitespacesAndNewlines)
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == uuid }) else { return }
            ComponentSpecs.update(&specs[at], with: json)
            if specs[at].status == .building { ComponentSpecs.answerOpenQuestions(in: &specs[at]) }
            if !words.isEmpty, specs[at].conversation.last?.text != words {
                specs[at].conversation.append(.init(kind: .maintainer, text: words))
            }
        }
        guard before.status == .building, let spec = chat.specs.first(where: { $0.id == uuid }) else { return }
        if spec.reuse, let similar = spec.similar, components.names.contains(similar) {
            for (name, build) in specBuilds where build.spec == uuid { specBuilds[name] = nil }
            finish(uuid, component: similar, in: chat)
        } else if spec.name != before.name, let build = specBuilds.removeValue(forKey: before.name) {
            // Built under another name: that one is waited for (a new one, or a change to it).
            specBuilds[spec.name] = (build.chat, build.spec, components.names.contains(spec.name) ? components.versions[spec.name, default: 0] : nil)
            components.doneWorking(before.name)
            components.markWorking(spec.name, change: "built from a reply")
        }
    }

    // MARK: Test run

    /// Runs the spec's command once to see what it prints. As for any component card it runs
    /// only once the user has allowed that command in that folder: `approve` is the user pressing
    /// Allow, with the command and folder the panel showed; nothing runs when they differ from
    /// the spec's. What it printed is checked against the data fields and kept as a sample.
    public func testRunSpec(_ id: UUID, in chat: Bot, command shown: String? = nil, folder shownFolder: String? = nil, approve: Bool = false) async {
        guard let spec = chat.specs.first(where: { $0.id == id }), let command = spec.command else { return }
        let folder = URL(filePath: spec.folder)
        if approve, shown == nil || shownFolder == nil { return }
        if let shown, shown != command { return }
        if let shownFolder, URL(filePath: shownFolder).standardizedFileURL.path != folder.standardizedFileURL.path { return }
        if approve { componentCommands.approve(command, in: folder) }
        // Asked for: the panel shows the run (or the question whether to allow it).
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }), specs[at].testRun?.command != command else { return }
            specs[at].testRun = ComponentSpec.TestRun(command: command, folder: folder.path)
        }
        guard componentCommands.isApproved(command, in: folder) else { return }
        await componentCommands.run(card: spec.card, command: command, in: folder, force: true)
        keepTestRun(of: id, command: command, in: chat)
    }

    /// The built component's card under the reply: Allow and run (with the command and folder it
    /// showed), ↻, or its first draw once allowed, as for any component card. Nothing runs that
    /// the user has not allowed in that folder; its output is kept on the spec.
    public func runSpecComponent(_ id: UUID, in chat: Bot, command shown: String? = nil, folder shownFolder: String? = nil, detail shownDetail: String? = nil, approve: Bool = false, force: Bool = false) async {
        guard let spec = chat.specs.first(where: { $0.id == id }), let name = spec.built,
              let command = ChatPayload.specCommand(spec, component: name, library: components) else { return }
        let folder = URL(filePath: spec.folder)
        if approve, shown == nil || shownFolder == nil { return }
        if let shown, shown != command { return }
        if let shownFolder, URL(filePath: shownFolder).standardizedFileURL.path != folder.standardizedFileURL.path { return }
        if approve {
            guard approveCard(command, detail: components.detailCommand(of: name), shownDetail: shownDetail, in: folder) else { return }
        }
        guard componentCommands.isApproved(command, in: folder) else { return }
        await componentCommands.run(card: spec.card, command: command, in: folder, force: force)
        keepTestRun(of: id, command: command, in: chat)
    }

    /// A finished test run, kept on the spec: its output, whether it fits the fields, a sample.
    private func keepTestRun(of id: UUID, command: String, in chat: Bot) {
        guard let card = chat.specs.first(where: { $0.id == id })?.card, let state = componentCommands.runs[card],
              state.status == .done || state.status == .failed else { return }
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }),
                  specs[at].command == command || specs[at].built.flatMap({ ChatPayload.specCommand(specs[at], component: $0, library: components) }) == command else { return }
            var run = ComponentSpec.TestRun(command: command, folder: specs[at].folder)
            run.output = state.data
            run.error = state.error
            run.ranAt = state.ranAt
            run.matches = state.data.map { ComponentSpecs.outputMatches($0, fields: specs[at].fields) }
            specs[at].testRun = run
            if let data = state.data {
                if let sample = specs[at].samples.firstIndex(where: { $0.label == "Test run" }) {
                    specs[at].samples[sample].data = data
                } else {
                    specs[at].samples.append(.init(label: "Test run", data: data))
                }
            }
        }
    }

    // MARK: Build it

    /// Build it (a draft, or a built one changed in the panel: its new version): open questions
    /// take their suggested answers; a component that already exists (the reply's own, or a
    /// similar one the user chose to reuse) goes straight onto the chosen bots' lists; otherwise
    /// Maintainer builds it and the app adds it once it is in the library.
    public func buildSpec(_ id: UUID, in chat: Bot) {
        guard var spec = chat.specs.first(where: { $0.id == id }), spec.status != .building else { return }
        ComponentSpecs.answerOpenQuestions(in: &spec)
        if let existing = spec.existing ?? (spec.reuse ? spec.similar.flatMap { components.names.contains($0) ? $0 : nil } : nil) {
            store(spec, in: chat)
            finish(id, component: existing, in: chat)
            return
        }
        spec.status = .building
        spec.asked = true
        spec.conversation.append(.init(kind: .event, text: spec.built == nil ? "Sent to Maintainer to build" : "Sent to Maintainer to build a new version"))
        let request = ComponentSpecs.buildRequest(spec)
        spec.pendingEdits = []
        store(spec, in: chat)
        let had = components.names.contains(spec.name)
        specBuilds[spec.name] = (chat.id, id, had ? components.versions[spec.name, default: 0] : nil)
        components.markWorking(spec.name, change: "built from a component spec")
        handToMaintainer(request)
    }

    private func store(_ spec: ComponentSpec, in chat: Bot) {
        chat.editSpecs { specs in
            if let at = specs.firstIndex(where: { $0.id == spec.id }) { specs[at] = spec }
        }
    }

    /// Specs being built whose component is now in the library (new, or its template changed
    /// since Build): added to their bots.
    func finishSpecBuilds() {
        for (name, build) in specBuilds where components.names.contains(name) {
            if let version = build.version, components.versions[name, default: 0] == version { continue }
            specBuilds[name] = nil
            guard let chat = chatsWithPins.first(where: { $0.id == build.chat }) else { continue }
            finish(build.spec, component: name, in: chat)
        }
    }

    /// The component is in the library: on each chosen bot's list (a full list is said, not
    /// forced), the spec done (drawn under its reply from now on), and the chat told where it
    /// went. Nothing runs: its command, if any, waits for the user on the card.
    private func finish(_ id: UUID, component name: String, in chat: Bot) {
        guard let spec = chat.specs.first(where: { $0.id == id }) else { return }
        // Built: its preview under the reply stops spinning now, not when Maintainer's turn ends
        // (a build handed to a background agent lands while that turn still goes on).
        components.doneWorking(name)
        components.doneWorking(spec.name)
        var added: [String] = []
        var full: [String] = []
        for botName in spec.bots {
            guard let holder = componentHolder(named: botName) else { continue }
            if giveComponent(name, to: holder) {
                added.append(holder.name)
                holder.queueNote("(App: The user added the component \"\(name)\" to your list; here are your components now.)\n" + componentBriefing(for: holder))
            } else if holder.componentList != nil {
                full.append(holder.name)
            }
        }
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }) else { return }
            specs[at].status = .done
            specs[at].name = name
            specs[at].built = name
            specs[at].bots = added
            specs[at].conversation.append(.init(kind: .event, text: added.isEmpty ? "\(name) is in the library" : "\(name) added to \(added.joined(separator: ", "))"))
        }
        var text = added.isEmpty ? "\(name) is in the library, but on no bot's list yet." : "\(name) added to \(added.joined(separator: ", "))."
        if !full.isEmpty { text += " Not added to \(full.joined(separator: ", ")): \(full.count == 1 ? "its list is" : "their lists are") full (\(ComponentLibrary.limit) components); take one off first." }
        tell(chat, text)
        askToFill(id, component: name, in: chat)
    }

    // MARK: Filled by the bot that wrote the reply

    /// Built (or reused) without a command: the bot that wrote the reply is asked, in a quiet app
    /// turn, to draw it for that reply with `<show>`, the data from its own reply in full. That
    /// turn waits until the bot is free (nothing it is doing is interrupted, and what the user says
    /// meanwhile waits for it), and its answer is not a message: the `<show>` is the reply's
    /// component. A reply that already is the component, or live data, needs nobody to fill it.
    private func askToFill(_ id: UUID, component name: String, in chat: Bot) {
        guard let spec = chat.specs.first(where: { $0.id == id }), spec.existing == nil,
              ChatPayload.specCommand(spec, component: name, library: components) == nil,
              let reply = chat.messages.first(where: { $0.id == spec.messageID }) else { return }
        let writer = reply.sourceID.flatMap(member) ?? chat
        // A group's own line has no one bot behind it.
        guard group(of: writer) == nil else { return }
        let pages = ComponentSpecs.pages(of: reply, page: spec.page).map(\.path)
        let request = ComponentSpecs.fillRequest(spec, component: name, reply: reply, pages: pages, usage: components.catalog(of: [name]))
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }) else { return }
            specs[at].filledBy = writer.name
            specs[at].fillError = nil
            specs[at].conversation.append(.init(kind: .event, text: "Asked \(writer.name) to fill it from its reply"))
        }
        Task { [weak self, weak writer] in
            guard let writer else { return }
            let answer = await writer.groupTurn(request, waitFor: Self.fillWait, answerWithin: Self.fillAnswerTime)
            self?.takeFill(answer, of: id, component: name, in: chat, by: writer.name)
        }
    }

    /// How long a fill waits for the bot to be free, and then for its answer.
    static let fillWait: TimeInterval = 3 * 60 * 60
    static let fillAnswerTime: TimeInterval = 10 * 60

    /// The bot's answer to the fill request: its `<show>` data goes under the reply.
    private func takeFill(_ answer: Bot.GroupAnswer, of id: UUID, component name: String, in chat: Bot, by writer: String) {
        let result: Result<String, ComponentSpecs.FillProblem> = switch answer {
        case let .reply(text, _): ComponentSpecs.filledData(from: text, component: name)
        case .busy: .failure(.init(text: "it stayed busy"))
        case let .failed(why): .failure(.init(text: why))
        }
        chat.editSpecs { specs in
            guard let at = specs.firstIndex(where: { $0.id == id }), specs[at].filledBy == writer, specs[at].built == name else { return }
            switch result {
            case let .success(data):
                specs[at].filled = data
                specs[at].fillError = nil
                specs[at].conversation.append(.init(kind: .event, text: "Filled by \(writer)"))
            case let .failure(problem):
                specs[at].fillError = problem.text
                specs[at].conversation.append(.init(kind: .event, text: "\(writer) did not fill it: \(problem.text)"))
            }
        }
    }

    /// Cancel: the chip goes away (a build already handed over is Maintainer's to finish).
    public func cancelSpec(_ id: UUID, in chat: Bot) {
        chat.editSpecs { $0.removeAll { $0.id == id } }
        for (name, build) in specBuilds where build.spec == id { specBuilds[name] = nil }
        if openSpecID == id { closeSpec() }
    }

    // MARK: What the panel draws

    /// The open spec as the right panel's page draws it.
    public func specPayload(_ id: UUID) -> SpecPayload? {
        guard let (chat, spec) = specLocation(id) else { return nil }
        let preview: String? = if let built = spec.built, components.names.contains(built) { built }
            else if spec.status == .done, components.names.contains(spec.name) { spec.name }
            else if let existing = spec.existing, components.names.contains(existing) { existing }
            else if spec.reuse, let similar = spec.similar, components.names.contains(similar) { similar }
            else if let shown = spec.shownAs, components.names.contains(shown) { shown }
            else { nil }
        var templates: [String: ChatPayload.Component] = [:]
        if let preview, let template = components.template(preview) {
            templates[preview] = ChatPayload.Component(
                template: template,
                version: components.versions[preview, default: 0],
                working: components.working[preview] != nil,
                updated: components.updated.contains(preview),
                hasPrevious: false
            )
        }
        let chosen = Set(spec.bots.map { $0.lowercased() })
        let everyBot = botsWithComponents.filter { $0 !== maintainer }.map(\.name)
        let bots = (everyBot + spec.bots.filter { name in !everyBot.contains { $0.lowercased() == name.lowercased() } })
            .map { SpecPayload.BotChoice(name: $0, on: chosen.contains($0.lowercased())) }
        var testRun: SpecPayload.TestRunView?
        if let command = spec.command, spec.testRun?.command == command || componentCommands.runs[spec.card] != nil {
            let folder = URL(filePath: spec.folder)
            let state = componentCommands.state(for: spec.card, command: command, in: folder)
            var status = state.status
            // Kept from before (a restart): shown as done until run again.
            if status == .idle, spec.testRun?.output != nil || spec.testRun?.error != nil { status = spec.testRun?.output != nil ? .done : .failed }
            let output = state.data ?? spec.testRun?.output
            testRun = SpecPayload.TestRunView(
                status: status.rawValue,
                command: command,
                folder: folder.path,
                output: output,
                error: state.error ?? spec.testRun?.error,
                ranAt: (state.ranAt ?? spec.testRun?.ranAt).map { $0.formatted(date: .omitted, time: .shortened) },
                matches: output.map { ComponentSpecs.outputMatches($0, fields: spec.fields) }
            )
        }
        var steps: [SpecPayload.Step]?
        if spec.status != .draft, spec.existing == nil, !spec.reuse {
            let built = spec.status == .done
            steps = [
                .init(label: "Sent to Maintainer", state: "done"),
                .init(label: "Built into the library", state: built ? "done" : "doing"),
                .init(label: "Add to " + (spec.bots.isEmpty ? "its bots" : spec.bots.joined(separator: ", ")), state: built ? "done" : "todo"),
            ]
            if built, let writer = spec.filledBy {
                steps?.append(spec.fillError != nil ? .init(label: "\(writer) did not fill it", state: "todo")
                    : .init(label: "Filled by \(writer)", state: spec.filling ? "doing" : "done"))
            }
        }
        let reply = chat.messages.first { $0.id == spec.messageID }
        let writer = reply?.sourceID.flatMap(member)?.name ?? chat.name
        let at = reply.map { " at " + $0.date.formatted(date: .omitted, time: .shortened) } ?? ""
        let from = spec.suggestedBy.map { "suggested by \($0)" } ?? (spec.page != nil ? "from \(writer)'s result page\(at)" : "from \(writer)'s reply\(at)")
        return SpecPayload(
            id: spec.id.uuidString,
            name: spec.name,
            about: spec.about,
            status: spec.status.rawValue,
            draft: spec.draft,
            chat: chat.name,
            from: from,
            suggestedBy: spec.suggestedBy,
            existing: spec.existing,
            fields: spec.fields.map { .init(name: $0.name, type: $0.type, by: $0.by.rawValue) },
            command: spec.command,
            folder: spec.folder,
            refresh: spec.refresh.rawValue,
            minutes: spec.minutes,
            bots: bots,
            similar: spec.similar,
            similarAbout: spec.similar.flatMap { name in components.names.contains(name) ? components.summaries(of: [name]).split(separator: ":", maxSplits: 1).last.map { $0.trimmingCharacters(in: .whitespaces) } : nil },
            reuse: spec.reuse,
            // What the bot drew under the reply is "This reply" in the preview.
            samples: (spec.filled.map { filled in [ComponentSpec.Sample(label: "This reply", data: filled)] + spec.samples.filter { $0.label != "This reply" } } ?? spec.samples)
                .map { .init(label: $0.label, data: $0.data) },
            questions: spec.questions.map { question in
                .init(id: question.id, text: question.text, options: question.options.map { .init(label: $0.label) }, suggested: question.suggested)
            },
            conversation: spec.conversation.map { .init(kind: $0.kind.rawValue, text: $0.text) },
            origins: spec.origins.mapValues(\.rawValue),
            preview: preview,
            components: templates,
            testRun: testRun,
            steps: steps,
            wide: specPanelWide
        )
    }
}

/// The spec workspace as the right panel's page draws it. Field names match `SpecState` in
/// `Web/src/types.ts`.
public struct SpecPayload: Encodable, Equatable {
    public struct FieldView: Encodable, Equatable {
        var name: String
        var type: String
        var by: String
    }

    public struct BotChoice: Encodable, Equatable {
        var name: String
        var on: Bool
    }

    public struct SampleView: Encodable, Equatable {
        var label: String
        var data: String
    }

    public struct QuestionView: Encodable, Equatable {
        public struct Option: Encodable, Equatable {
            var label: String
        }

        var id: String
        var text: String
        var options: [Option]
        var suggested: Int?
    }

    public struct LineView: Encodable, Equatable {
        var kind: String
        var text: String
    }

    /// Its command's test run, as a command card shows one (see `ComponentCommands.Status`).
    public struct TestRunView: Encodable, Equatable {
        public var status: String
        var command: String
        var folder: String
        var output: String?
        var error: String?
        var ranAt: String?
        var matches: Bool?
    }

    public struct Step: Encodable, Equatable {
        var label: String
        /// done, doing or todo.
        var state: String
    }

    var id: String
    var name: String
    var about: String
    var status: String
    var draft: Int
    /// The chat it is in.
    var chat: String
    /// "from ClaudeCodeBot's reply at 22:14", "suggested by garden".
    var from: String
    var suggestedBy: String?
    var existing: String?
    var fields: [FieldView]
    var command: String?
    var folder: String
    var refresh: String
    var minutes: Int
    var bots: [BotChoice]
    var similar: String?
    var similarAbout: String?
    var reuse: Bool
    var samples: [SampleView]
    var questions: [QuestionView]
    var conversation: [LineView]
    var origins: [String: String]
    /// The library component whose template draws the preview; nil: the plain drawing.
    public var preview: String?
    var components: [String: ChatPayload.Component]
    public var testRun: TestRunView?
    var steps: [Step]?
    var wide: Bool

    public func json() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        guard let data = try? encoder.encode(self) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
