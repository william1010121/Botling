import ClaudeCodeBotCore
import SwiftUI

/// Uses the same local Codex catalogue as worker settings; no invented model names.
struct CompletionVerificationSection: View {
    @ObservedObject var workspace: Workspace
    var models: [CodexModel]
    private var available: [CodexModel] { models.filter(\.supportsCompletionVerification) }
    private var selected: String { workspace.settings.completionVerificationModel }

    var body: some View {
        Section {
            Picker(L("Verification model"), selection: Binding(
                get: { selected },
                set: { id in
                    if let model = available.first(where: { $0.id == id }) {
                        workspace.setCompletionVerificationModel(model)
                    }
                }
            )) {
                if !available.contains(where: { $0.id == selected }) {
                    Text(L("{0} (not currently listed)", selected)).tag(selected).disabled(true)
                }
                ForEach(available, id: \.id) { model in
                    Text(model.name).tag(model.id)
                }
            }
            .pickerStyle(.menu)
            .disabled(available.isEmpty)
            Text(L("Current verification model: {0}", selected))
                .font(.system(size: 12)).foregroundStyle(.secondary)
            if available.isEmpty {
                Text(L("No compatible models listed. Check Codex installation and login; restart Botling to refresh its model list."))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        } header: {
            Text(L("Completion verification"))
        } footer: {
            Text(L("Checks both heads using your Codex login with medium effort. Only models that advertise medium effort are offered. Changes apply to the next check; each reply shows its actual model, verdict and reason. Access failures remain visible in chat."))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
