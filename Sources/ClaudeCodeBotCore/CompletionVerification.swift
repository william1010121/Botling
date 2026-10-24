import Foundation

/// App-owned evidence attached to the exact reply that was checked. Legacy replies have none.
public struct CompletionVerification: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case checking, judged, interrupted }
    public var model: String
    public var state: State
    public var verdict: PromiseCheck.Verdict?
    public var reason: String?
    public var continuationPaused: Bool?

    public init(model: String, state: State = .checking, verdict: PromiseCheck.Verdict? = nil,
                reason: String? = nil, continuationPaused: Bool? = nil) {
        self.model = model
        self.state = state
        self.verdict = verdict
        self.reason = reason
        self.continuationPaused = continuationPaused
    }
}

extension CodexModel {
    /// Keep the established medium effort. Unknown capability is not an available choice.
    public var supportsCompletionVerification: Bool { supportedReasoningEfforts?.contains("medium") == true }
}

extension Workspace {
    /// Exact saved selection, with no silent fallback if model access later changes.
    @discardableResult
    public func setCompletionVerificationModel(_ model: CodexModel) -> Bool {
        guard model.supportsCompletionVerification else { return false }
        settings.completionVerificationModelChoice = model.id
        settings.save(to: settingsURL)
        for bot in modelSettingsBots { configureCompletionVerification(for: bot) }
        return true
    }

    func configureCompletionVerification(for bot: Bot) {
        guard let completionClassifier else { return }
        let model = settings.completionVerificationModel
        for head in [bot, bot.partner].compactMap({ $0 }) {
            head.completionVerificationModel = model
            head.promiseCheck = PromiseCheck.checker(classify: completionClassifier(model))
        }
    }
}
