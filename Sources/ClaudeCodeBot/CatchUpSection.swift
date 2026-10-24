import ClaudeCodeBotCore
import SwiftUI

/// Two independent summary triggers, with optional individual thresholds.
struct CatchUpSection: View {
    @ObservedObject var workspace: Workspace
    @State private var models: [CodexModel] = []
    private var available: [CodexModel] { models.filter(\.supportsCompletionVerification) }
    private var settings: AppSettings { workspace.settings }

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { settings.catchUpEnabled }, set: { workspace.setCatchUpEnabled($0) })) {
                Text(L("Summarize unread messages"))
                Text(L("When you return, summarize more than {0} unread bot replies", settings.catchUpThreshold))
            }
            Toggle(isOn: Binding(get: { settings.intervalSummaryEnabled }, set: { workspace.setIntervalSummaryEnabled($0) })) {
                Text(L("Summarize between your messages"))
                Text(L("Your next message summarizes the previous interval if it has more than {0} bot replies", settings.intervalSummaryThreshold))
            }
            if settings.summaryThresholdsCustomized {
                Stepper(value: Binding(get: { settings.catchUpThreshold }, set: { workspace.setCatchUpThreshold($0) }), in: CatchUp.thresholdRange) {
                    thresholdLabel(L("Unread threshold"), value: settings.catchUpThreshold)
                }
                Stepper(value: Binding(get: { settings.intervalSummaryThreshold }, set: { workspace.setIntervalSummaryThreshold($0) }), in: CatchUp.thresholdRange) {
                    thresholdLabel(L("Interval threshold"), value: settings.intervalSummaryThreshold)
                }
                Button(L("Use default thresholds")) { workspace.setSummaryThresholdsCustomized(false) }
            } else {
                HStack {
                    Text(L("Both thresholds: more than {0} bot replies", CatchUp.defaultThreshold))
                    Spacer()
                    Button(L("Adjust individually")) { workspace.setSummaryThresholdsCustomized(true) }
                }
            }
            // Manual summaries also use this model, even with both automatic switches off.
            Picker(L("Summary model"), selection: Binding(
                get: { settings.catchUpModel },
                set: { id in
                    if let model = available.first(where: { $0.id == id }) { workspace.setCatchUpModel(model) }
                }
            )) {
                if !available.contains(where: { $0.id == settings.catchUpModel }) {
                    Text(L("{0} (not currently listed)", settings.catchUpModel)).tag(settings.catchUpModel).disabled(true)
                }
                ForEach(available, id: \.id) { model in Text(model.name).tag(model.id) }
            }
            .pickerStyle(.menu)
            .disabled(available.isEmpty)
            Text(L("Current summary model: {0}", settings.catchUpModel))
                .font(.system(size: 12)).foregroundStyle(.secondary)
        } header: {
            Text(L("Chat summaries"))
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Footnote(L("Summarize beside Send uses the messages between your last two messages. With only one message from you, it uses the replies since then."))
                Footnote(L("Only bot replies count toward thresholds. Summaries keep every source message, link and artifact; expand the group to read the originals. Your messages and conversation history stay unchanged."))
            }
        }
        .task { models = await CodexModels.load() }
    }

    private func thresholdLabel(_ title: String, value: Int) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(L("More than {0} bot replies", value)).monospacedDigit()
        }
    }
}
