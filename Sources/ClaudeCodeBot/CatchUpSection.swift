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
                Text(L("Your next message summarizes the previous interval if it has at least {0} bot replies", settings.intervalSummaryThreshold))
            }
            if settings.summaryThresholdsCustomized {
                Stepper(value: Binding(get: { settings.catchUpThreshold }, set: { workspace.setCatchUpThreshold($0) }), in: CatchUp.thresholdRange) {
                    thresholdLabel(L("Unread threshold"), value: settings.catchUpThreshold)
                }
                Stepper(value: Binding(get: { settings.intervalSummaryThreshold }, set: { workspace.setIntervalSummaryThreshold($0) }), in: CatchUp.thresholdRange) {
                    thresholdLabel(L("Interval threshold"), value: settings.intervalSummaryThreshold, inclusive: true)
                }
                Button(L("Use default thresholds")) { workspace.setSummaryThresholdsCustomized(false) }
            } else {
                HStack {
                    Text(L("Default thresholds: unread > {0}, interval ≥ {0} bot replies", CatchUp.defaultThreshold))
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
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(L("Summary prompt"))
                    Spacer()
                    Text(settings.summaryPrompt == CatchUp.defaultWritingPrompt ? L("Default") : L("Custom"))
                        .font(.caption).foregroundStyle(.secondary)
                    Button(L("Restore default prompt")) { workspace.setSummaryPrompt(nil) }
                        .disabled(settings.summaryPromptChoice == nil)
                }
                TextEditor(text: Binding(
                    get: { settings.summaryPromptChoice ?? CatchUp.defaultWritingPrompt },
                    set: { workspace.setSummaryPrompt($0) }
                ))
                .font(.system(size: 12))
                .frame(height: 110)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.3)))
                .accessibilityLabel(L("Summary prompt"))
                Footnote(L("Writing instructions for manual, automatic interval and unread summaries. Saved automatically; blank uses the default. Existing summaries stay as written. New summaries and retries use this prompt, within the 1–5 bullet format and selected app language."))
            }
        } header: {
            Text(L("Chat summaries"))
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Footnote(L("Summarize in a reply footer summarizes that interval between your messages. Open the summary to read every original reply."))
                Footnote(L("Only bot replies count toward thresholds. Summaries keep every source message, link and artifact; expand the group to read the originals. Your messages and conversation history stay unchanged."))
            }
        }
        .task { models = await CodexModels.load() }
    }

    private func thresholdLabel(_ title: String, value: Int, inclusive: Bool = false) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(L(inclusive ? "At least {0} bot replies" : "More than {0} bot replies", value)).monospacedDigit()
        }
    }
}
