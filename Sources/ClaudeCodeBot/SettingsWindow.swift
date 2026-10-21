import AppKit
import ClaudeCodeBotCore
import SwiftUI

/// The gear under the chat list: today's tokens and the subscription limits, the two switches people change most, and the way
/// into the settings window at the section a row is about.
struct SettingsPopover: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var registry: PluginRegistry
    /// Opens the settings window (at a section, or where it was last) and closes the popover.
    let open: (SettingsSection?) -> Void

    var body: some View {
        let spending = workspace.spending
        let isToday = spending.day == Spending.today()
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(L("Today")).font(.system(size: 12)).foregroundStyle(Theme.faint)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(Workspace.tokenCount(isToday ? spending.tokens.total : 0))
                        .font(.system(size: 20, weight: .semibold))
                        .monospacedDigit()
                    Text(L("tokens"))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.muted)
                }
            }
            if !workspace.rateLimits.isEmpty {
                RateLimitCards(limits: workspace.rateLimits)
            }
            divider
            SettingSwitch(L("Auto-approve safe actions"), isOn: Binding(
                get: { workspace.settings.autoApprovesSafeActions },
                set: { workspace.setAutoApprovesSafeActions($0) }
            ))
            SettingSwitch(L("Develop ClaudeCodeBot itself"), isOn: DeveloperSection.binding(workspace))
            divider
            VStack(spacing: 0) {
                if workspace.doctor.needsAttention {
                    link(L("Claude Code needs attention"), detail: L("Doctor ›"), color: DoctorRow.color(.failing)) { open(.doctor) }
                }
                link(L("Plugins"), detail: L("{0} on", registry.plugins.filter(\.enabled).count)) { open(.plugins) }
                link(L("Usage by bot"), detail: "›") { open(.usage) }
                link(L("All settings…"), detail: "⌘ ,", color: Theme.blue) { open(nil) }
            }
        }
        .font(.system(size: 14))
        .padding(14)
        .frame(width: 300)
        .background(Theme.bubble)
        .foregroundStyle(Theme.text)
    }

    private var divider: some View {
        Rectangle().fill(Theme.line).frame(height: 1)
    }

    private func link(_ title: String, detail: String, color: Color = Theme.text, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(color)
                Spacer()
                Text(detail).foregroundStyle(Theme.faint)
            }
            .padding(.horizontal, 6)
            .frame(height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverRowStyle())
    }
}

/// The subscription's two limits, side by side: a ring of how much is used and when it starts
/// over, with an "as of" note when the last reading is old (it comes with bots' turns only).
struct RateLimitCards: View {
    let limits: RateLimits

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let now = context.date
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    card(L("5 hours"), limits.fiveHour, now: now) { RateLimitText.countdown($0, now: now) }
                    card(L("Week"), limits.week, now: now) { RateLimitText.resetDay($0, now: now) }
                }
                if let since = limits.staleSince(now: now) {
                    Text(RateLimitText.asOf(since, now: now))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.faint)
                }
            }
        }
    }

    private func card(_ title: String, _ window: RateLimitWindow?, now: Date, reset: (RateLimitWindow) -> String) -> some View {
        let gone = window.map { $0.hasReset(at: now) } ?? true
        let used = gone ? 0 : window?.used ?? 0
        return HStack(spacing: 8) {
            ZStack {
                Circle().stroke(Theme.chip, lineWidth: 5)
                Circle()
                    .trim(from: 0, to: used)
                    .stroke(used >= 0.8 ? Theme.orange : Theme.blue, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(window.map { RateLimitText.percent($0, now: now) } ?? "–")
                    .font(.system(size: 10.5, weight: .semibold))
                    .monospacedDigit()
            }
            .frame(width: 36, height: 36)
            .padding(2.5)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13))
                Text(window.map(reset) ?? L("no data"))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .monospacedDigit()
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x232328)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("{0} limit, {1} used, {2}", title, window.map { RateLimitText.percent($0, now: now) } ?? L("no data"), window.map(reset) ?? ""))
    }
}

/// A row that lights up under the pointer, as list rows in the popover do.
private struct HoverRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverRow(label: configuration.label, pressed: configuration.isPressed)
    }

    private struct HoverRow<Label: View>: View {
        let label: Label
        let pressed: Bool
        @State private var hovering = false

        var body: some View {
            label
                .background(RoundedRectangle(cornerRadius: 8).fill(hovering || pressed ? Theme.selected : .clear))
                .onHover { hovering = $0 }
        }
    }
}

/// A label and a blue switch on one line.
private struct SettingSwitch: View {
    let title: String
    @Binding var isOn: Bool

    init(_ title: String, isOn: Binding<Bool>) {
        self.title = title
        _isOn = isOn
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .frame(minHeight: 32)
    }
}

/// ClaudeCodeBot's own settings: a sidebar of sections, the chosen one beside it. Opened from
/// the gear's popover or with ⌘,.
struct SettingsWindow: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var navigator: SettingsNavigator
    /// Settings → Release planner's list; the snapshot hands in one with sample PRs.
    var releasePlanner: ReleasePlanner?

    /// Release planner only shows with developer mode on.
    private var sections: [SettingsSection] {
        SettingsSection.allCases.filter { $0 != .releases || workspace.settings.developerMode }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Settings"))
                    .font(.system(size: 15, weight: .semibold))
                    .padding(.horizontal, 10)
                    .padding(.bottom, 14)
                ForEach(sections) { section in
                    Button { navigator.section = section } label: {
                        Text(section.title)
                            .font(.system(size: 14))
                            .foregroundStyle(navigator.section == section ? Theme.text : Theme.muted)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(navigator.section == section ? Theme.selected : .clear))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(navigator.section == section ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 20)
            .frame(width: 200)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Theme.ground)
            Rectangle().fill(Theme.line).frame(width: 1)
            VStack(spacing: 0) {
                HStack {
                    Text(navigator.section.title).font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Button(L("Done")) { navigator.close() }.keyboardShortcut(.defaultAction)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        switch navigator.section {
                        case .general: LanguageSection(workspace: workspace)
                        case .usage: UsageSection(workspace: workspace)
                        case .permissions: PermissionsSection(workspace: workspace, commands: workspace.componentCommands)
                        case .plugins: PluginsSection(registry: workspace.plugins, host: workspace.pluginHost, workspace: workspace)
                        case .developer: DeveloperSection(workspace: workspace)
                        case .releases: ReleasesSection(workspace: workspace, planner: releasePlanner)
                        case .doctor: DoctorSection(model: workspace.doctor)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.never)
            }
            .background(Theme.side)
        }
        .frame(width: 760, height: 600)
        .foregroundStyle(Theme.text)
        .background(Theme.side)
    }
}

/// A card of rows with a line between each, as lists in settings are drawn.
private struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct RowDivider: View {
    var body: some View {
        Rectangle().fill(Theme.line).frame(height: 1)
    }
}

/// Cost and tokens: today in all and by bot, and the days before.
private struct UsageSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        let spending = workspace.spending
        let isToday = spending.day == Spending.today()
        let tokens = isToday ? spending.tokens : TokenUsage()
        PanelSection(L("Usage today")) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    tile(L("Cost"), Workspace.dollars(isToday ? spending.spent : 0))
                    tile(L("Tokens"), Workspace.tokenCount(tokens.total))
                }
                Text(L("In {0} · out {1} · cache write {2} · cache read {3}", Workspace.tokenCount(tokens.input), Workspace.tokenCount(tokens.output), Workspace.tokenCount(tokens.cacheWrite), Workspace.tokenCount(tokens.cacheRead)))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
            }
        }
        let bots = isToday ? Set(spending.byBot.keys).union(spending.tokensByBot.keys).sorted {
            (spending.byBot[$0] ?? 0, spending.tokensByBot[$0]?.total ?? 0) > (spending.byBot[$1] ?? 0, spending.tokensByBot[$1]?.total ?? 0)
        } : []
        PanelSection(L("By bot")) {
            Card {
                if bots.isEmpty {
                    Text(L("No bot has used anything today."))
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.faint)
                        .padding(.horizontal, 14)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                ForEach(bots, id: \.self) { name in
                    row(name, spending.byBot[name] ?? 0, spending.tokensByBot[name]?.total ?? 0)
                    if name != bots.last { RowDivider() }
                }
            }
        }
        if !spending.history.isEmpty {
            let days = Array(spending.history.reversed())
            PanelSection(L("Earlier days")) {
                Card {
                    ForEach(days, id: \.day) { day in
                        row(day.day, day.spent, day.tokens.total)
                        if day.day != days.last?.day { RowDivider() }
                    }
                }
            }
        }
    }

    private func tile(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.faint)
            Text(value).font(.system(size: 20, weight: .semibold)).monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
    }

    private func row(_ name: String, _ cost: Double, _ tokens: Int) -> some View {
        HStack(spacing: 12) {
            Text(name).lineLimit(1)
            Spacer()
            Text(L("{0} tokens", Workspace.tokenCount(tokens))).foregroundStyle(Theme.faint).monospacedDigit()
            Text(Workspace.dollars(cost)).monospacedDigit().frame(width: 72, alignment: .trailing)
        }
        .font(.system(size: 14))
        .padding(.horizontal, 14)
        .frame(height: 44)
    }
}

/// Auto mode, the component commands you allowed (each can be taken back), and items taken off
/// "Waiting on you".
private struct PermissionsSection: View {
    @ObservedObject var workspace: Workspace
    /// Watched so a command allowed or forgotten shows at once.
    @ObservedObject var commands: ComponentCommands

    var body: some View {
        PanelSection(L("Auto mode")) {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: Binding(
                    get: { workspace.settings.autoApprovesSafeActions },
                    set: { workspace.setAutoApprovesSafeActions($0) }
                )) {
                    Text(L("Auto-approve safe actions")).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                }
                .toggleStyle(.switch)
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
                Text(workspace.settings.autoApprovesSafeActions
                     ? L("Bots use Claude Code's auto mode: reading, searching and ordinary commands just run; a safety check blocks risky ones (deleting files that were there before, sending data out, force pushes, downloading and running code). It is not a guarantee. Anything it still wants your OK for comes as a card in the chat.")
                     : L("Bots ask in the chat before each tool they are not always allowed to use."))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        ResultsSection(workspace: workspace)
        let approved = workspace.approvedCommands
        PanelSection(L("Approved component commands")) {
            Card {
                if approved.isEmpty {
                    Text(L("None yet. A component asks before it first runs a command."))
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.faint)
                        .padding(.horizontal, 14)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                ForEach(approved) { item in
                    HStack(spacing: 12) {
                        Text(item.command)
                            .font(.system(size: 12, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(item.owner)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.faint)
                            .lineLimit(1)
                            .help(item.folder)
                        Button(L("Forget")) { workspace.forget(item) }
                            .buttonStyle(.plain)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.muted)
                            .help(L("Ask again before this command runs in {0}", item.owner))
                            .accessibilityLabel(L("Forget {0}", item.command))
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    if item.id != approved.last?.id { RowDivider() }
                }
            }
        }
        if workspace.ignoredWaitingCount > 0 {
            PanelSection(L("Ignored")) {
                HStack {
                    Text(L("{0} item(s) taken off \"Waiting on you\"", workspace.ignoredWaitingCount))
                    Spacer()
                    Button(L("Show again")) { workspace.showIgnoredWaiting() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.blue)
                }
                .font(.system(size: 14))
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            }
        }
    }
}

/// ClaudeCodeBot's plugins: on or off, why one broke, and the settings each declares; and
/// adding one.
private struct PluginsSection: View {
    @ObservedObject var registry: PluginRegistry
    var host: PluginHostClient?
    var workspace: Workspace?
    @State private var open: String?
    @State private var source = ""

    var body: some View {
        PanelSection(L("Installed")) {
            VStack(spacing: 0) {
                ForEach(registry.plugins) { plugin in
                    PluginRow(registry: registry, plugin: plugin, open: open == plugin.name) {
                        open = open == plugin.name ? nil : plugin.name
                    }
                    if plugin.id != registry.plugins.last?.id {
                        Rectangle().fill(Theme.line).frame(height: 1)
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            if let problem = host?.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(Theme.errorText)
            }
            ForEach(registry.problems.keys.sorted(), id: \.self) { folder in
                Text(L("Couldn't read \"{0}\": {1}", folder, registry.problems[folder]?.joined(separator: "; ") ?? ""))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.errorText)
            }
        }
        if let workspace {
            ComponentEditorSection(workspace: workspace)
            PanelSection(L("Add plugin")) {
                AddPluginRow(workspace: workspace, source: $source)
                Text(L("ClaudeCodeBot asks before installing. A folder needs a package.json."))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
            }
        }
    }
}

/// Settings → General: the language of the app's words, which bots also reply in by default.
/// "System default" follows the Mac's preferred languages (English when it has none of them).
struct LanguageSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        PanelSection(L("Language")) {
            HStack(spacing: 12) {
                Text(L("App language")).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                Picker("", selection: Binding(
                    get: { workspace.settings.languageChoice },
                    set: { workspace.setLanguage($0) }
                )) {
                    Text(L("System default ({0})", AppLanguage.preferred().nativeName)).tag(AppLanguage?.none)
                    Divider()
                    ForEach(AppLanguage.allCases, id: \.self) { Text($0.nativeName).tag(Optional($0)) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            Text(L("ClaudeCodeBot's menus, buttons and messages change at once. Bots reply in this language by default; when you write to them in another language, they answer in yours."))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Where bots put reports and other results for you: a claude.ai Artifact or a local HTML page.
struct ResultsSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        PanelSection(L("Reports and results")) {
            HStack(spacing: 12) {
                Text(L("Publish as")).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                Picker("", selection: Binding(
                    get: { workspace.settings.resultPublishing },
                    set: { workspace.setResultPublishing($0) }
                )) {
                    ForEach(ResultPublishing.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            Text(Self.explanation(workspace.settings.resultPublishing))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    static func explanation(_ choice: ResultPublishing) -> String {
        switch choice {
        case .artifactUnlessSensitive:
            L("Bots publish reports as private claude.ai Artifacts you open in your browser. Anything sensitive (keys, personal data, what you said to keep local), or when publishing fails, stays a page in the project's .bot/artifacts folder.")
        case .localOnly:
            L("Bots save every report as a page in the project's .bot/artifacts folder; nothing is published to claude.ai.")
        case .artifactAlways:
            L("Bots publish every report as a private claude.ai Artifact, sensitive or not; a local page only when publishing fails.")
        }
    }
}

/// The model ccb-core's component editor runs on: the app writes its agent file with it.
private struct ComponentEditorSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        PanelSection(L("Component editor")) {
            HStack(spacing: 12) {
                Text(L("Model")).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                Picker("", selection: Binding(
                    get: { workspace.settings.componentEditor },
                    set: { workspace.setComponentEditorModel($0) }
                )) {
                    ForEach(BotModel.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            Text(L("The agent Maintainer hands component changes to. A change here rewrites its file in ccb-core; awake bots pick it up before their next message."))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PluginRow: View {
    @ObservedObject var registry: PluginRegistry
    let plugin: InstalledPlugin
    let open: Bool
    let toggleOpen: () -> Void

    private var settings: [(key: String, value: PluginManifest.Setting)] {
        (plugin.manifest.ccb?.contributes?.settings ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button(action: toggleOpen) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plugin.manifest.title).foregroundStyle(plugin.enabled ? Theme.text : Theme.muted)
                        Text(plugin.builtIn ? L("Built-in · {0}", plugin.manifest.version)
                             : plugin.installedFrom.map { L("External · {0} · {1}", plugin.manifest.version, $0) } ?? plugin.manifest.version)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.faint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(plugin.manifest.description ?? "")
                Toggle("", isOn: Binding(
                    get: { plugin.enabled },
                    set: { registry.setEnabled(plugin.name, $0) }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .accessibilityLabel(L("Enable {0}", plugin.manifest.title))
            }
            if let failure = plugin.failure {
                Text(plugin.usingPrevious ? L("New version failed, using the previous one: {0}", failure) : L("Failed and disabled: {0}", failure))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.errorText)
            }
            if open {
                if let description = plugin.manifest.description {
                    Text(description).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                ForEach(settings, id: \.key) { key, setting in
                    SettingControl(registry: registry, plugin: plugin.name, key: key, setting: setting)
                }
            }
        }
        .font(.system(size: 14))
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .contextMenu {
            if !plugin.builtIn {
                Button(L("Revert to previous version")) { Task { report(await registry.revert(plugin.name)) } }
                    .disabled(!registry.hasPrevious(plugin.name))
                Button(L("Remove"), role: .destructive) { confirmingRemove = true }
            }
        }
        .confirmationDialog(L("Remove \"{0}\"?", plugin.manifest.title), isPresented: $confirmingRemove) {
            Button(L("Remove"), role: .destructive) { Task { report(await registry.remove(plugin.name)) } }
        } message: {
            Text(L("The plugin library's git history is kept, so it can be recovered later."))
        }
        .alert(L("Couldn't finish"), isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button(L("OK")) { problem = nil }
        } message: {
            Text(problem ?? "")
        }
    }

    @State private var confirmingRemove = false
    @State private var problem: String?

    private func report(_ result: String?) {
        problem = result
    }
}

/// "Add plugin": paste a git URL, npm name or archive URL (ClaudeCodeBot asks before installing), or pick
/// a folder of your own (installed right away).
private struct AddPluginRow: View {
    @ObservedObject var workspace: Workspace
    @Binding var source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField(L("Git URL, npm name or .zip URL"), text: $source)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(add)
                Button(L("Add"), action: add).disabled(source.trimmingCharacters(in: .whitespaces).isEmpty)
                Button {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true
                    panel.canChooseFiles = false
                    panel.prompt = L("Add as plugin")
                    panel.message = L("Pick a plugin folder (one with a package.json).")
                    if panel.runModal() == .OK, let folder = panel.url {
                        Task { await workspace.proposeInstall(folder.path, trusted: true) }
                    }
                } label: {
                    Image(systemName: "folder")
                }
                .help(L("Add from folder"))
                .accessibilityLabel(L("Add plugin from folder"))
            }
            .font(.system(size: 13))
            ForEach(workspace.fetching, id: \.self) { item in
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L("Fetching {0}…", item)).font(.system(size: 12)).foregroundStyle(Theme.faint).lineLimit(1)
                }
            }
        }
    }

    private func add() {
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        source = ""
        Task { await workspace.proposeInstall(text) }
    }
}

/// One declared setting, drawn from its type.
private struct SettingControl: View {
    @ObservedObject var registry: PluginRegistry
    let plugin: String
    let key: String
    let setting: PluginManifest.Setting
    @State private var secret = ""

    var body: some View {
        let value = registry.setting(plugin, key)
        HStack {
            Text(setting.title).foregroundStyle(Theme.muted)
            Spacer()
            if setting.secret == true {
                // Kept in the keychain; ClaudeCodeBot never shows it again.
                SecureField(registry.secret(plugin, key) == nil ? L("Not set") : L("Saved in Keychain"), text: $secret)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 140)
                    .onSubmit {
                        registry.setSecret(plugin, key, to: secret)
                        secret = ""
                    }
            } else {
            switch setting.type {
            case "boolean":
                Toggle("", isOn: Binding(get: { value?.bool ?? false }, set: { registry.set(plugin, key, to: .bool($0)) }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.mini)
            case "enum":
                Picker("", selection: Binding(get: { value?.string ?? "" }, set: { registry.set(plugin, key, to: .string($0)) })) {
                    ForEach(setting.options ?? [], id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
            case "number":
                TextField("", value: Binding(get: { value?.number ?? 0 }, set: { registry.set(plugin, key, to: .number($0)) }), format: .number)
                    .textFieldStyle(.roundedBorder).frame(width: 70)
            default:
                TextField("", text: Binding(get: { value?.string ?? "" }, set: { registry.set(plugin, key, to: .string($0)) }))
                    .textFieldStyle(.roundedBorder).frame(width: 140)
            }
            }
        }
        .font(.system(size: 13))
        .accessibilityLabel(setting.title)
    }
}

/// For working on ClaudeCodeBot itself: which project is its source, whose manager may then
/// install new builds, look at the app, and get what you flag as not right.
struct DeveloperSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        let folders = workspace.projects.filter { !$0.isBot }
        PanelSection(L("Developer mode")) {
            VStack(alignment: .leading, spacing: 10) {
                Card {
                    Toggle(isOn: Self.binding(workspace)) {
                        Text(L("Develop ClaudeCodeBot itself")).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .toggleStyle(.switch)
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    if workspace.settings.developerMode {
                        RowDivider()
                        HStack {
                            Text(L("Its source")).font(.system(size: 14))
                            Spacer()
                            Picker(L("Its source"), selection: Binding(
                                get: { workspace.settings.developerProjectID },
                                set: { workspace.setDeveloperMode(true, project: $0) }
                            )) {
                                Text(L("Choose a project")).tag(UUID?.none)
                                ForEach(folders) { project in
                                    Text(project.name).tag(Optional(project.id))
                                }
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .fixedSize()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                    }
                }
                Text(workspace.settings.developerMode
                     ? L("{0}'s manager may install new builds (you confirm; one that does not start is rolled back), take screenshots of this window, and gets what you flag as \"not right\" in any chat.", workspace.developerProject?.name ?? L("That project"))
                     : L("Off for everyone who only uses ClaudeCodeBot. Turn it on to let one project's manager work on the app itself."))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Developer mode on or off; turned on, with the project chosen before or the one that
    /// looks like ClaudeCodeBot's source.
    static func binding(_ workspace: Workspace) -> Binding<Bool> {
        Binding(
            get: { workspace.settings.developerMode },
            set: { on in
                workspace.setDeveloperMode(on, project: workspace.settings.developerProjectID ?? workspace.guessDeveloperSource()?.id)
            }
        )
    }
}

/// Settings → Doctor: Claude Code and Codex, each found the way bots find it, with its version,
/// sign-in, and a command to copy when something is wrong.
struct DoctorSection: View {
    @ObservedObject var model: DoctorModel

    var body: some View {
        PanelSection(L("Command-line tools")) {
            Card {
                if model.checks.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(L("Checking…")).foregroundStyle(Theme.muted)
                    }
                    .font(.system(size: 14))
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(model.checks.enumerated()), id: \.element.id) { index, check in
                    if index > 0 { RowDivider() }
                    DoctorRow(check: check)
                }
            }
            HStack(spacing: 10) {
                Button(L("Run again")) { Task { await model.run(includeLatest: true) } }
                    .disabled(model.isRunning)
                if model.isRunning {
                    ProgressView().controlSize(.small)
                } else if let checkedAt = model.checkedAt {
                    Text(L("Checked {0}", checkedAt.formatted(date: .omitted, time: .shortened)))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                }
            }
            Text(L("Bots run Claude Code; Codex reviews run Codex. Each check has a {0}-second limit and spends no tokens.", Int(Doctor.timeout)))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
        }
        .task {
            if !model.includedLatest || model.checks.isEmpty { await model.run(includeLatest: true) }
        }
    }
}

struct DoctorRow: View {
    let check: DoctorCheck
    @State private var copied = false

    static func color(_ status: DoctorStatus) -> Color {
        switch status {
        case .ok: Theme.green
        case .warning: Theme.orange
        case .failing: Color(hex: 0xFF5F57)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Circle().fill(Self.color(check.status)).frame(width: 9, height: 9)
                    .accessibilityLabel(check.status == .ok ? L("OK") : check.status == .warning ? L("Warning") : L("Failing"))
                Text(check.tool.name).font(.system(size: 14, weight: .medium))
                Text(check.version ?? "—").font(.system(size: 13)).monospacedDigit().foregroundStyle(Theme.muted)
                Spacer()
                Text(L("needs {0}+", check.tool.minimum.description)).font(.system(size: 12)).foregroundStyle(Theme.faint)
            }
            Group {
                Text(check.summary).foregroundStyle(check.status == .ok ? Theme.muted : Self.color(check.status))
                if let path = check.path {
                    Text(path).lineLimit(1).truncationMode(.middle).foregroundStyle(Theme.faint).textSelection(.enabled)
                }
            }
            .font(.system(size: 12))
            .padding(.leading, 19)
            if let fix = check.fix {
                HStack(spacing: 8) {
                    Text(fix)
                        .font(.system(size: 12, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(copied ? L("Copied") : L("Copy")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(fix, forType: .string)
                        copied = true
                    }
                    .controlSize(.small)
                    .help(L("Copy the command, then run it in Terminal"))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.ground))
                .padding(.leading, 19)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The gear's dot when a required check (Claude Code) failed.
struct DoctorDot: View {
    @ObservedObject var model: DoctorModel

    var body: some View {
        if model.needsAttention {
            Circle().fill(Color(hex: 0xFF5F57)).frame(width: 7, height: 7)
                .offset(x: -6, y: 6)
                .allowsHitTesting(false)
                .accessibilityLabel(L("Claude Code needs attention"))
        }
    }
}
