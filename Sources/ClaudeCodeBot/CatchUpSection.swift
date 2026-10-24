import ClaudeCodeBotCore
import SwiftUI

/// Settings → General → Catch-up summary: fold unread messages into one summarized group when
/// you come back to a chat. The model list is the local Codex catalogue, as for verification.
struct CatchUpSection: View {
    @ObservedObject var workspace: Workspace
    @State private var models: [CodexModel] = []
    private var available: [CodexModel] { models.filter(\.supportsCompletionVerification) }
    private var settings: AppSettings { workspace.settings }

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { settings.catchUpEnabled }, set: { workspace.setCatchUpEnabled($0) })) {
                Text(L("Summarize unread messages"))
                Text(L("Fold unread messages into one group when you come back"))
            }
            Group {
                Stepper(value: Binding(get: { settings.catchUpThreshold }, set: { workspace.setCatchUpThreshold($0) }),
                        in: CatchUp.thresholdRange) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("Unread threshold"))
                            Text(L("Collapse when more than this many messages are unread"))
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(settings.catchUpThreshold)").monospacedDigit()
                    }
                }
                Picker(L("Summary model"), selection: Binding(
                    get: { settings.catchUpModel },
                    set: { id in
                        if let model = available.first(where: { $0.id == id }) { workspace.setCatchUpModel(model) }
                    }
                )) {
                    if !available.contains(where: { $0.id == settings.catchUpModel }) {
                        Text(L("{0} (not currently listed)", settings.catchUpModel)).tag(settings.catchUpModel).disabled(true)
                    }
                    ForEach(available, id: \.id) { model in
                        Text(model.name).tag(model.id)
                    }
                }
                .pickerStyle(.menu)
                .disabled(available.isEmpty)
                Text(L("Current summary model: {0}", settings.catchUpModel))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .disabled(!settings.catchUpEnabled)
        } header: {
            Text(L("Catch-up summary"))
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Footnote(settings.catchUpEnabled
                    ? L("When you return to a chat with more than {0} unread messages, they fold into one group with a 3–5 bullet summary on top. Changes apply the next time you open a chat.", settings.catchUpThreshold)
                    : L("Catch-up summary is off. Unread messages appear one by one, as before."))
                Footnote(L("The summary model reads only the unread messages in that chat, using your Codex login with medium effort. Collapsed messages are never deleted: click the group to see every message, and search and replies still reach them. If the model fails, the group shows the error and stays expandable."))
            }
        }
        .task { models = await CodexModels.load() }
    }
}
