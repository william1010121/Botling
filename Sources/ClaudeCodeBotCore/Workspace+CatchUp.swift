import Foundation

extension Workspace {
    // MARK: Reading

    /// You are looking at `chat`: it is selected (not a web site), and the window is focused.
    func isViewing(_ chat: Bot) -> Bool {
        windowFocused && selection != BrowserShelf.selectionID && selectedBot === chat && WebSite.site(selection: selection) == nil
    }

    /// A line arrived in `chat`: read at once if you are looking at it.
    func readIfViewing(_ chat: Bot) {
        if isViewing(chat) { chat.markRead() }
    }

    /// You came back to `chat` (selected it, or returned to the window): more than k unread
    /// messages fold into a group with a summary, then the chat is read.
    func arrive(at chat: Bot) {
        guard isViewing(chat) else { return }
        let unread = chat.unreadCount
        if settings.catchUpEnabled {
            let source = CatchUp.unreadMessages(in: chat.messages, unread: unread)
            if CatchUp.replyCount(in: source) > settings.catchUpThreshold {
                startCatchUp(for: chat, unread: unread)
            }
        }
        chat.markRead()
    }

    /// The app tells when its window gains or loses focus (key window of the active app, shown).
    public func setWindowFocused(_ focused: Bool) {
        guard focused != windowFocused else { return }
        if focused {
            windowFocused = true
            arrive(at: selectedBot)
        } else {
            // What you were looking at was read up to now.
            readIfViewing(selectedBot)
            windowFocused = false
        }
    }

    // MARK: Summaries

    /// Groups the last `unread` messages of `chat` and summarizes them, once per range: a range
    /// already summarized (this run or an earlier one) is shown at once.
    public func startCatchUp(for chat: Bot, unread: Int) {
        guard catchUpSummarizer != nil else { return }
        let messages = CatchUp.unreadMessages(in: chat.messages, unread: unread)
        guard !messages.isEmpty else { return }
        beginCatchUp(for: chat, messages: messages)
    }

    /// Explicit action: latest closed user interval, or open interval with one user boundary.
    /// No unread/recent-replies fallback; the button is independent of automatic settings.
    public func manuallyCatchUp(in chat: Bot) {
        guard catchUps[chat.id]?.phase != .loading else { return }
        let source = CatchUp.intervalMessages(in: chat.messages)
        guard !source.isEmpty else {
            catchUps[chat.id] = nil
            return
        }
        beginCatchUp(for: chat, messages: source, manual: true)
    }

    /// Called only after a message has actually been persisted in this visible transcript.
    func summarizeClosedInterval(in chat: Bot, after message: ChatMessage) {
        guard message.role == .user, chat.messages.last?.id == message.id,
              settings.intervalSummaryEnabled,
              intervalSummaryClosures[chat.id] != message.id,
              chat.messages.dropLast().contains(where: { $0.role == .user }) else { return }
        intervalSummaryClosures[chat.id] = message.id
        let source = CatchUp.intervalMessages(in: chat.messages)
        guard CatchUp.replyCount(in: source) >= settings.intervalSummaryThreshold else { return }
        beginIntervalSummary(in: chat, messages: source, automatic: true)
    }

    /// The footer supplies a user message UUID, never a latest-only fallback.
    public func summarizeInterval(in chat: Bot, after userID: UUID) {
        let source = CatchUp.intervalMessages(in: chat.messages, after: userID)
        guard CatchUp.replyCount(in: source) > 0 else { return }
        beginIntervalSummary(in: chat, messages: source)
    }

    private func beginIntervalSummary(in chat: Bot, messages: [ChatMessage], automatic: Bool = false) {
        let key = CatchUp.key(messages, language: language)
        if let state = intervalSummaries[chat.id]?[key], state.phase != .failed {
            if automatic { intervalSummaries[chat.id]?[key]?.automatic = true }
            return
        }
        // A growing open interval replaces its own earlier range, never overlaps it.
        for (oldKey, old) in intervalSummaries[chat.id] ?? [:] where oldKey != key && old.messageIDs.first == messages.first?.id {
            intervalSummaryTasks[chat.id]?[oldKey]?.cancel()
            intervalSummaryTasks[chat.id]?[oldKey] = nil
            intervalSummaries[chat.id]?[oldKey] = nil
        }
        var state = CatchUpState(key: key, messageIDs: messages.map(\.id), phase: .loading,
                                 model: settings.catchUpModel, manual: true, automatic: automatic)
        if let cached = catchUpCache[key] {
            state.phase = .ready
            state.bullets = cached.bullets
            state.model = cached.model
        }
        intervalSummaries[chat.id, default: [:]][key] = state
        if state.phase == .loading { runIntervalSummary(in: chat, messages: messages, state: state) }
    }

    public func retryIntervalSummary(in chat: Bot, key: String) {
        guard var state = intervalSummaries[chat.id]?[key], state.phase == .failed else { return }
        let ids = Set(state.messageIDs)
        let source = chat.messages.filter { ids.contains($0.id) }
        guard !source.isEmpty else { return }
        state.phase = .loading
        state.error = nil
        state.model = settings.catchUpModel
        intervalSummaries[chat.id]?[key] = state
        runIntervalSummary(in: chat, messages: source, state: state)
    }

    private func runIntervalSummary(in chat: Bot, messages: [ChatMessage], state: CatchUpState) {
        let chatID = chat.id, key = state.key, model = state.model
        guard let make = catchUpSummarizer else {
            intervalSummaries[chatID]?[key]?.phase = .failed
            intervalSummaries[chatID]?[key]?.error = L("The summary service is unavailable.")
            return
        }
        let prompt = CatchUp.prompt(for: messages, language: language, writingPrompt: settings.summaryPrompt) { [weak self] in
            self?.catchUpName(of: $0, in: chat) ?? chat.name
        }
        let summarize = make(model)
        intervalSummaryTasks[chatID, default: [:]][key] = Task { @MainActor [weak self] in
            let result: Result<[String], Error>
            do { result = .success(try await summarize(prompt)) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled, var current = intervalSummaries[chatID]?[key] else { return }
            switch result {
            case let .success(bullets):
                current.phase = .ready
                current.bullets = bullets
                catchUpCache.store(bullets, model: model, for: key)
            case let .failure(error):
                current.phase = .failed
                current.error = error.localizedDescription
            }
            intervalSummaries[chatID]?[key] = current
            intervalSummaryTasks[chatID]?[key] = nil
        }
    }

    public func intervalSummaryViews(for chat: Bot) -> [ChatPayload.CatchUpView] {
        let positions = Dictionary(chat.messages.enumerated().map { ($1.id.uuidString, $0) }, uniquingKeysWith: { first, _ in first })
        return (intervalSummaries[chat.id] ?? [:]).values.compactMap { state in
            let ids = Set(state.messageIDs)
            let source = chat.messages.filter { ids.contains($0.id) }
            guard !source.isEmpty else { return nil }
            let replies = source.filter { $0.role == .bot }
            let counts = Dictionary(grouping: replies, by: { $0.engine?.rawValue ?? "unknown" }).mapValues(\.count)
            return ChatPayload.CatchUpView(key: state.key, ids: source.map { $0.id.uuidString },
                count: replies.count, state: state.phase.rawValue, bullets: state.bullets, error: state.error,
                model: state.model, manual: true, automatic: state.automatic, speakerCounts: counts)
        }.sorted { lhs, rhs in
            return (positions[lhs.ids.first ?? ""] ?? 0) < (positions[rhs.ids.first ?? ""] ?? 0)
        }
    }

    private func beginCatchUp(for chat: Bot, messages: [ChatMessage], manual: Bool = false) {
        let key = CatchUp.key(messages, language: language)
        if let current = catchUps[chat.id], current.key == key, current.phase != .failed, current.manual == manual { return }
        let model = settings.catchUpModel
        var state = CatchUpState(key: key, messageIDs: messages.map(\.id), phase: .loading, model: model, manual: manual)
        if let cached = catchUpCache[key] {
            state.phase = .ready
            state.bullets = cached.bullets
            state.model = cached.model
            catchUps[chat.id] = state
            return
        }
        catchUps[chat.id] = state
        summarize(chat, messages: messages, key: key, model: model)
    }

    /// The page's Retry on a failed summary.
    public func retryCatchUp(in chat: Bot) {
        guard var state = catchUps[chat.id], state.phase == .failed else { return }
        let ids = Set(state.messageIDs)
        let messages = chat.messages.filter { ids.contains($0.id) }
        guard !messages.isEmpty else { return }
        state.phase = .loading
        state.error = nil
        state.model = settings.catchUpModel
        catchUps[chat.id] = state
        summarize(chat, messages: messages, key: state.key, model: state.model)
    }

    private func summarize(_ chat: Bot, messages: [ChatMessage], key: String, model: String) {
        guard let make = catchUpSummarizer else {
            catchUps[chat.id]?.phase = .failed
            catchUps[chat.id]?.error = L("The summary service is unavailable.")
            return
        }
        let prompt = CatchUp.prompt(for: messages, language: language, writingPrompt: settings.summaryPrompt) { [weak self] message in
            self?.catchUpName(of: message, in: chat) ?? chat.name
        }
        let summarizer = make(model)
        let chatID = chat.id
        catchUpTasks[chatID]?.cancel()
        catchUpTasks[chatID] = Task { @MainActor [weak self] in
            let result: Result<[String], Error>
            do { result = .success(try await summarizer(prompt)) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled, var state = catchUps[chatID], state.key == key else { return }
            switch result {
            case let .success(bullets):
                state.phase = .ready
                state.bullets = bullets
                catchUpCache.store(bullets, model: model, for: key)
            case let .failure(error):
                state.phase = .failed
                state.error = error.localizedDescription
            }
            catchUps[chatID] = state
            catchUpTasks[chatID] = nil
        }
    }

    /// Who said a message, as the summary model is told it.
    func catchUpName(of message: ChatMessage, in chat: Bot) -> String {
        switch message.role {
        case .bot:
            let name = message.sourceID.flatMap { speakerName(for: $0) } ?? chat.name
            return message.engine.map { "\(name) · \($0.displayName)" } ?? name
        case .error: return "Error"
        case .relay: return "Handed over"
        default: return "Botling"
        }
    }

    /// What the page draws for `chat`'s group; nil when there is none (or its messages are gone).
    public func catchUpView(for chat: Bot) -> ChatPayload.CatchUpView? {
        guard let state = catchUps[chat.id] else { return nil }
        let present = Set(chat.messages.map(\.id))
        let ids = state.messageIDs.filter(present.contains)
        guard !ids.isEmpty else { return nil }
        let byID = Dictionary(chat.messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let counted = ids.compactMap { byID[$0] }.filter { $0.role == .bot }
        let heads = Set(counted.compactMap(\.engine)).count
        let latest = counted.last.map { message in
            let who = message.engine?.displayName ?? catchUpName(of: message, in: chat)
            let line = message.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            return "\(who): \(line.prefix(160))"
        }
        return ChatPayload.CatchUpView(
            key: state.key, ids: ids.map(\.uuidString), count: counted.count, heads: heads > 1 ? heads : nil,
            state: state.phase.rawValue, bullets: state.bullets, error: state.error, model: state.model,
            since: counted.first.map { CatchUp.time($0.date) }, until: counted.last.map { CatchUp.time($0.date) },
            latest: latest, manual: state.manual)
    }

    // MARK: Settings

    /// Existing cached/in-flight summaries stay as written, as with a summary model change.
    /// New generations and retries use the latest saved writing preferences.
    public func setSummaryPrompt(_ prompt: String?) {
        settings.summaryPromptChoice = prompt
        settings.save(to: settingsURL)
    }

    public func setCatchUpEnabled(_ enabled: Bool) {
        guard enabled != settings.catchUpEnabled else { return }
        settings.catchUpEnabledChoice = enabled
        settings.save(to: settingsURL)
    }

    public func setCatchUpThreshold(_ threshold: Int) {
        let threshold = CatchUp.clampedThreshold(threshold)
        guard threshold != settings.catchUpThresholdChoice else { return }
        settings.catchUpThresholdChoice = threshold
        settings.summaryThresholdsCustomizedChoice = true
        settings.save(to: settingsURL)
    }

    public func setIntervalSummaryEnabled(_ enabled: Bool) {
        settings.intervalSummaryEnabledChoice = enabled
        settings.save(to: settingsURL)
    }

    public func setIntervalSummaryThreshold(_ threshold: Int) {
        settings.intervalSummaryThresholdChoice = CatchUp.clampedThreshold(threshold)
        settings.summaryThresholdsCustomizedChoice = true
        settings.save(to: settingsURL)
    }

    public func setSummaryThresholdsCustomized(_ customized: Bool) {
        settings.summaryThresholdsCustomizedChoice = customized
        if !customized {
            settings.catchUpThresholdChoice = nil
            settings.intervalSummaryThresholdChoice = nil
        }
        settings.save(to: settingsURL)
    }

    /// Only models that offer medium effort, as for completion verification.
    @discardableResult
    public func setCatchUpModel(_ model: CodexModel) -> Bool {
        guard model.supportsCompletionVerification else { return false }
        settings.catchUpModelChoice = model.id
        settings.save(to: settingsURL)
        return true
    }
}
