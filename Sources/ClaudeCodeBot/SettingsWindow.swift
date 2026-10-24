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
                // Codex's limits are its own: each set under its name once both are there.
                if !workspace.codexRateLimits.isEmpty {
                    Text("Claude").font(.system(size: 12)).foregroundStyle(Theme.faint)
                }
                RateLimitCards(limits: workspace.rateLimits)
            }
            if !workspace.codexRateLimits.isEmpty {
                Text("Codex").font(.system(size: 12)).foregroundStyle(Theme.faint)
                RateLimitCards(limits: workspace.codexRateLimits, hidesMissing: true)
            }
            divider
            SettingSwitch(L("Auto-approve safe actions"), isOn: Binding(
                get: { workspace.settings.autoApprovesSafeActions },
                set: { workspace.setAutoApprovesSafeActions($0) }
            ))
            SettingSwitch(L("Develop Botling itself"), isOn: DeveloperSection.binding(workspace))
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
    /// Leave out a window never reported (Codex may report only its week).
    var hidesMissing = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let now = context.date
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    if !hidesMissing || limits.fiveHour != nil {
                        card(L("5 hours"), limits.fiveHour, now: now) { RateLimitText.countdown($0, now: now) }
                    }
                    if !hidesMissing || limits.week != nil {
                        card(L("Week"), limits.week, now: now) { RateLimitText.resetDay($0, now: now) }
                    }
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

// MARK: - The settings window

/// The colours of the settings window, as macOS System Settings draws them, in light and dark.
struct SettingsPalette {
    let pane: Color
    let side: Color
    let line: Color
    let search: Color
    let selected: Color
    let text: Color
    let sub: Color

    static func of(_ scheme: ColorScheme) -> SettingsPalette {
        scheme == .dark
            ? SettingsPalette(pane: Color(hex: 0x1E1E20), side: Color(hex: 0x262628), line: Color(hex: 0x38383B), search: Color(hex: 0x323235),
                              selected: Color(hex: 0x0A5FC4), text: Color(hex: 0xF2F2F4), sub: Color(hex: 0xA3A3A8))
            : SettingsPalette(pane: Color(hex: 0xF6F6F8), side: Color(hex: 0xEBEBEE), line: Color(hex: 0xE1E1E5), search: Color(hex: 0xDCDCE0),
                              selected: Color(hex: 0x0B6FD8), text: Color(hex: 0x1D1D1F), sub: Color(hex: 0x626267))
    }
}

extension SettingsSection {
    /// The sidebar's icon: a symbol on a coloured rounded square.
    var symbol: String {
        switch self {
        case .general: "gearshape.fill"
        case .engines: "cpu"
        case .permissions: "checkmark.shield.fill"
        case .usage: "chart.bar.fill"
        case .plugins: "puzzlepiece.extension.fill"
        case .doctor: "waveform.path.ecg"
        case .developer: "chevron.left.forwardslash.chevron.right"
        case .releases: "list.bullet"
        }
    }

    var tint: Color {
        switch self {
        case .general: Color(hex: 0x8E8E93)
        case .engines: Color(hex: 0x8A5CF6)
        case .permissions: Color(hex: 0x1F7AE0)
        case .usage: Color(hex: 0x2FA84F)
        case .plugins: Color(hex: 0xF08A24)
        case .doctor: Color(hex: 0xE5484D)
        case .developer: Color(hex: 0x4A4A50)
        case .releases: Color(hex: 0x12A1A8)
        }
    }
}

/// Botling's own settings, drawn like macOS System Settings: a sidebar of sections (with a
/// search field) and the chosen one as grouped forms beside it. Opened from the gear's popover
/// or with ⌘,.
struct SettingsWindow: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var navigator: SettingsNavigator
    /// Settings → Release planner's list; the snapshot hands in one with sample PRs.
    var releasePlanner: ReleasePlanner?
    /// The snapshot draws it taller to show a whole page.
    var height = SettingsWindow.size.height
    @Environment(\.colorScheme) private var scheme
    @State private var query = ""

    static let size = CGSize(width: 900, height: 640)

    /// Release planner only shows with developer mode on.
    private var sections: [SettingsSection] {
        SettingsSection.allCases.filter { $0 != .releases || workspace.settings.developerMode }
    }

    var body: some View {
        let palette = SettingsPalette.of(scheme)
        HStack(spacing: 0) {
            sidebar(palette)
            Rectangle().fill(palette.line).frame(width: 1)
            VStack(spacing: 0) {
                HStack {
                    Text(navigator.section.title).font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Button(L("Done")) { navigator.close() }.keyboardShortcut(.defaultAction)
                }
                .padding(.horizontal, 20)
                .frame(height: 52)
                Rectangle().fill(palette.line).frame(height: 1)
                Form { page }
                    .formStyle(.grouped)
                    .scrollContentBackground(.hidden)
                    .background(palette.pane)
                    .id(navigator.section)
            }
            .background(palette.pane)
        }
        .frame(width: Self.size.width, height: height)
        .foregroundStyle(palette.text)
        .background(palette.pane)
        .tint(Color(nsColor: .systemBlue))
    }

    @ViewBuilder private var page: some View {
        switch navigator.section {
        case .general: GeneralPage(workspace: workspace)
        case .engines: EnginesPage(workspace: workspace)
        case .usage: UsagePage(workspace: workspace)
        case .permissions: PermissionsPage(workspace: workspace, commands: workspace.componentCommands)
        case .plugins: PluginsPage(registry: workspace.plugins, host: workspace.pluginHost, workspace: workspace)
        case .developer: DeveloperSection(workspace: workspace)
        case .releases: ReleasesSection(workspace: workspace, planner: releasePlanner)
        case .doctor: DoctorSection(model: workspace.doctor)
        }
    }

    private func sidebar(_ palette: SettingsPalette) -> some View {
        let found = SettingsSection.matching(query, in: sections)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(palette.sub)
                TextField(L("Search settings"), text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .onSubmit { if let first = found.first { navigator.section = first } }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(palette.sub) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("Clear"))
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7).fill(palette.search))
            .padding(.horizontal, 2)
            .padding(.bottom, 10)
            if found.isEmpty {
                Text(L("No results"))
                    .font(.system(size: 13))
                    .foregroundStyle(palette.sub)
                    .padding(.horizontal, 10)
                    .padding(.top, 4)
            }
            ForEach(found) { section in
                if section == .developer {
                    Text(L("Advanced"))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(palette.sub)
                        .padding(.horizontal, 10)
                        .padding(.top, 14)
                        .padding(.bottom, 4)
                }
                sidebarRow(section, palette)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 14)
        .frame(width: 236)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(palette.side)
    }

    private func sidebarRow(_ section: SettingsSection, _ palette: SettingsPalette) -> some View {
        let on = navigator.section == section
        return Button { navigator.section = section } label: {
            HStack(spacing: 8) {
                Image(systemName: section.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 20, height: 20)
                    .background(RoundedRectangle(cornerRadius: 5).fill(section.tint))
                Text(section.title)
                    .font(.system(size: 13))
                    .foregroundStyle(on ? .white : palette.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if section == .engines {
                    Text(L("New"))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(height: 16)
                        .background(Capsule().fill(on ? Color.white.opacity(0.25) : Color(nsColor: .systemBlue)))
                }
            }
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 7).fill(on ? palette.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The explanation under a group, as System Settings words it.
struct Footnote: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A row's title with a quieter line under it.
private struct TitleAndNote: View {
    let title: String
    let note: String
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(note)
                .font(.system(size: 11, design: monospaced ? .monospaced : .default))
                .foregroundStyle(.secondary)
        }
    }
}

/// The C or X mark beside Claude's and Codex's groups.
private struct EngineMark: View {
    let engine: BotEngine

    var body: some View {
        Text(engine == .claude ? "C" : "X")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(engine == .claude ? Color.white : Color(nsColor: .windowBackgroundColor))
            .frame(width: 16, height: 16)
            .background(RoundedRectangle(cornerRadius: 4).fill(engine == .claude ? Color(hex: 0xD97757) : Color.primary))
            .accessibilityHidden(true)
    }
}

// MARK: General

/// Language, how two-headed bots look, and the reminder for quiet runs.
private struct GeneralPage: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        LanguageSection(workspace: workspace)
        BotLookSection(workspace: workspace)
        ChatAvatarSizeSection(workspace: workspace)
        CatchUpSection(workspace: workspace)
        Section {
            Picker(L("Remind after no new step for"), selection: Binding(
                get: { workspace.settings.stallReminder },
                set: { workspace.setStallReminderMinutes($0) }
            )) {
                ForEach(Self.choices(keeping: workspace.settings.stallReminder), id: \.self) { minutes in
                    Text(minutes == 0 ? L("Never") : L("{0} min", minutes)).tag(minutes)
                }
            }
            .pickerStyle(.menu)
        } header: {
            Text(L("Reminders"))
        } footer: {
            Footnote(L("When a running bot or subagent shows no new step for this long, you get a reminder in its chat. Never turns it off."))
        }
    }

    /// The offered minutes, with one set by hand in settings.json kept in order.
    static func choices(keeping current: Int) -> [Int] {
        var minutes = AppSettings.stallReminderChoices.filter { $0 > 0 }
        if current > 0, !minutes.contains(current) { minutes = (minutes + [current]).sorted() }
        return minutes + [0]
    }
}

/// Settings → General: the language of the app's words, which bots also reply in by default.
/// "System default" follows the Mac's preferred languages (English when it has none of them).
struct LanguageSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        Section {
            Picker(L("App language"), selection: Binding(
                get: { workspace.settings.languageChoice },
                set: { workspace.setLanguage($0) }
            )) {
                Text(L("System default ({0})", AppLanguage.preferred().nativeName)).tag(AppLanguage?.none)
                Divider()
                ForEach(AppLanguage.allCases, id: \.self) { Text($0.nativeName).tag(Optional($0)) }
            }
            .pickerStyle(.menu)
        } header: {
            Text(L("Language"))
        } footer: {
            Footnote(L("Botling's menus, buttons and messages change at once. Bots reply in this language by default; when you write to them in another language, they answer in yours."))
        }
    }
}

/// How bots with Claude and Codex look: plain faces with C/X marks, or the two characters.
struct BotLookSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        Section {
            Picker(L("Bot look"), selection: Binding(
                get: { workspace.settings.botLook },
                set: { workspace.setBotLook($0) }
            )) {
                ForEach(BotLook.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            HStack(spacing: 6) {
                if workspace.settings.botLook == .cute {
                    ChibiHeadView(head: .claude, hat: .square, size: 28)
                    ChibiHeadView(head: .codex, hat: .square, size: 28)
                } else {
                    EngineMark(engine: .claude)
                    EngineMark(engine: .codex)
                }
                Text(workspace.settings.botLook == .cute
                    ? L("A bot with Claude and Codex shows them as two characters wearing the bot's face: on each reply, as small heads under the lines they have seen, behind the bot's face in the left column and under Now.")
                    : L("Plain bot faces, with C and X marks for Claude and Codex."))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text(L("Bot look"))
        }
    }
}

/// Message faces only: the preview uses the actual selected size, with the bot's hat intact.
struct ChatAvatarSizeSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        Section {
            HStack {
                Text(L("Chat avatar size"))
                Spacer()
                Text("\(workspace.settings.chatAvatarSize) px").monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: Binding(
                get: { Double(workspace.settings.chatAvatarSize) },
                set: { workspace.setChatAvatarSize(Int($0)) }
            ), in: Double(AppSettings.chatAvatarSizeRange.lowerBound)...Double(AppSettings.chatAvatarSizeRange.upperBound), step: 1) {
                Text(L("Chat avatar size"))
            }
            .labelsHidden()
            HStack(spacing: 12) {
                if workspace.settings.botLook == .cute {
                    ChibiHeadView(head: .claude, hat: .square, size: CGFloat(workspace.settings.chatAvatarSize))
                } else {
                    AvatarView(kind: .square, size: CGFloat(workspace.settings.chatAvatarSize), eyes: .open)
                }
                Text(L("Preview")).font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                Button(L("Use default size")) { workspace.setChatAvatarSize(nil) }
                    .disabled(workspace.settings.chatAvatarSizeChoice == nil)
            }
            .frame(minHeight: 96)
        } header: {
            Text(L("Chat avatars"))
        } footer: {
            Footnote(L("Applies immediately to message avatars in every chat. Sidebar icons and small engine heads keep their size. Default: 48 px, or 40 px in narrow chats."))
        }
    }
}

// MARK: Engines and subagents

/// What bots' Claude subagents and Codex workers start on, for every bot; the component editor's
/// model; and the one-off "engine and model for all bots".
private struct EnginesPage: View {
    @ObservedObject var workspace: Workspace
    @State private var config = CodexConfig()
    @State private var codexModels: [CodexModel] = []

    private var follow: Bool { workspace.settings.codexWorkersFollowConfig }
    /// Botling's own choice, or (to start one) what the config says now.
    private var choice: CodexWorkerDefaults { workspace.settings.codexWorkerChoice ?? .seeded(from: config) }

    var body: some View {
        let effective = workspace.settings.effectiveCodexWorker(config: config)
        Section {
            Picker(L("Model"), selection: Binding(
                get: { workspace.settings.subagentModelDefault },
                set: { model in Task { await workspace.setSubagentModelDefault(model) } }
            )) {
                Text(L("Same as bot")).tag(BotModel?.none)
                ForEach(BotModel.allCases, id: \.self) { Text($0.displayName).tag(Optional($0)) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
        } header: {
            VStack(alignment: .leading, spacing: 18) {
                Text(L("Which model the subagents (Claude) and workers (Codex) bots send out use by default. Each bot's own engine, model and thinking effort stay on that bot's settings page, right of the chat."))
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    EngineMark(engine: .claude)
                    Text(L("Claude subagents"))
                }
                .font(.system(size: 13, weight: .semibold))
            }
            .textCase(nil)
        } footer: {
            Footnote(L("A subagent whose definition names a model keeps it; the Subagent model on each bot's settings page can override this default."))
        }
        Section {
            Toggle(isOn: Binding(
                get: { follow },
                set: { on in
                    let kept = choice
                    Task { await workspace.setCodexWorkerDefaults(follow: on, choice: kept) }
                }
            )) {
                TitleAndNote(title: L("Follow Codex config file"), note: "~/.codex/config.toml", monospaced: true)
            }
            .toggleStyle(.switch)
            Group {
                if follow {
                    Picker(L("Model"), selection: .constant(0)) {
                        Text(config.model ?? L("Codex's default model")).tag(0)
                    }
                } else {
                    Picker(L("Model"), selection: Binding(
                        get: { choice.model },
                        set: { model in update { $0.model = model } }
                    )) {
                        Text(L("Same as bot")).tag(String?.none)
                        ForEach(modelChoices, id: \.self) { id in
                            Text(codexModels.first { $0.id == id }?.name ?? id).tag(Optional(id))
                        }
                    }
                }
            }
            .pickerStyle(.menu)
            .disabled(follow)
            Picker(L("Reasoning effort"), selection: Binding(
                get: { follow ? config.effort : choice.effort },
                set: { level in update { $0.effort = level } }
            )) {
                ForEach(EffortLevel.allCases, id: \.self) { Text($0.displayName).tag(Optional($0)) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .disabled(follow)
            Toggle(isOn: Binding(
                get: { follow ? config.fast ?? false : choice.fast ?? false },
                set: { on in update { $0.fast = on } }
            )) {
                TitleAndNote(title: L("Fast mode"), note: L("{0}: faster replies, uses more of your limits", "service_tier = priority"))
            }
            .toggleStyle(.switch)
            .disabled(follow)
        } header: {
            HStack(spacing: 6) {
                EngineMark(engine: .codex)
                Text(L("Codex workers")).font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(L("In effect: {0} · {1} · {2}", effective.model ?? L("Codex's default model"), effortName(effective), effective.fast ? "Fast" : L("Standard")))
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(.secondary)
                    .textCase(nil)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Footnote(follow
                    ? L("Now following config.toml: {0}, {1} effort, {2}. A change to the file applies to the next worker. Turn this switch off to choose for Botling's workers.", effective.model ?? L("Codex's default model"), effortName(effective), effective.fast ? "Fast" : L("Standard"))
                    : L("Applies only to the Codex workers Botling sends out; codex you run yourself in Terminal still reads config.toml."))
                Footnote(L("Applied to every bot now; a bot's own settings page (right of its chat) can still choose differently for that bot."))
            }
        }
        CompletionVerificationSection(workspace: workspace, models: codexModels)
            .task {
                config = CodexConfig.load()
                codexModels = await CodexModels.load()
            }
        ComponentEditorSection(workspace: workspace)
        AllBotsModelSection(workspace: workspace, codexModels: codexModels)
    }

    /// The model and effort controls are only for Botling's own choice.
    private func update(_ change: (inout CodexWorkerDefaults) -> Void) {
        guard !follow else { return }
        var next = choice
        change(&next)
        Task { await workspace.setCodexWorkerDefaults(follow: false, choice: next) }
    }

    private func effortName(_ effective: EffectiveCodexWorker) -> String {
        effective.effort?.displayName ?? effective.effortName ?? L("Default")
    }

    private var modelChoices: [String] {
        var ids = codexModels.map(\.id)
        for kept in [choice.model, config.model].compactMap({ $0 }) where !ids.contains(kept) { ids.append(kept) }
        return ids
    }
}

/// The model ccb-core's component editor runs on: the app writes its agent file with it.
private struct ComponentEditorSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        Section {
            Picker(L("Model"), selection: Binding(
                get: { workspace.settings.componentEditor },
                set: { workspace.setComponentEditorModel($0) }
            )) {
                ForEach(BotModel.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            .pickerStyle(.menu)
        } header: {
            Text(L("Component editor"))
        } footer: {
            Footnote(L("The agent Maintainer hands component changes to. A change here rewrites its file in ccb-core; awake bots pick it up before their next message."))
        }
    }
}

/// Stage a choice, then apply it explicitly; merely opening Settings never changes a bot.
struct AllBotsModelSection: View {
    @ObservedObject var workspace: Workspace
    var codexModels: [CodexModel]
    @State private var engine: BotEngine = .claude
    @State private var claudeModel: BotModel = .sonnet
    @State private var codexModel: String?
    @State private var applied: Int?

    var body: some View {
        Section {
            Picker(L("Engine"), selection: $engine) {
                ForEach(BotEngine.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            .pickerStyle(.menu)
            if engine == .claude {
                Picker(L("Model"), selection: $claudeModel) {
                    ForEach(BotModel.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .pickerStyle(.menu)
            } else {
                Picker(L("Model"), selection: $codexModel) {
                    Text(L("Codex's default model")).tag(String?.none)
                    ForEach(codexChoices, id: \.self) { id in
                        Text(codexModels.first { $0.id == id }?.name ?? id).tag(Optional(id))
                    }
                }
                .pickerStyle(.menu)
            }
            HStack {
                if workspace.isApplyingBotModel { ProgressView().controlSize(.small) }
                else if let applied { Text(L("Applied to {0} bots", applied)).font(.system(size: 12)).foregroundStyle(.secondary) }
                Spacer()
                Button(L("Apply to all bots")) {
                    let choice = (engine, claudeModel, codexModel)
                    Task {
                        applied = await workspace.applyModelToAllBots(engine: choice.0, claudeModel: choice.1, codexModel: choice.2)
                    }
                }
            }
        } header: {
            Text(L("Engine and model for all bots"))
        } footer: {
            Footnote(L("Applies to all existing bots, including the main bot and Maintainer. Keeps chats and other settings. You can change each bot or reenable its other engine in that bot's settings; new bots keep their own defaults."))
        }
        .disabled(workspace.isApplyingBotModel)
        .task {
            engine = workspace.mainBot.engine
            claudeModel = workspace.mainBot.model
            codexModel = workspace.mainBot.heads.codexModel
        }
        .onChange(of: engine) { _, _ in applied = nil }
        .onChange(of: claudeModel) { _, _ in applied = nil }
        .onChange(of: codexModel) { _, _ in applied = nil }
    }

    private var codexChoices: [String] {
        var ids = codexModels.map(\.id)
        if let codexModel, !ids.contains(codexModel) { ids.append(codexModel) }
        return ids
    }
}

// MARK: Permissions

/// Auto mode, where results go, the component commands you allowed (each can be taken back),
/// and items taken off "Waiting on you".
private struct PermissionsPage: View {
    @ObservedObject var workspace: Workspace
    /// Watched so a command allowed or forgotten shows at once.
    @ObservedObject var commands: ComponentCommands

    var body: some View {
        Section {
            Toggle(L("Auto-approve safe actions"), isOn: Binding(
                get: { workspace.settings.autoApprovesSafeActions },
                set: { workspace.setAutoApprovesSafeActions($0) }
            ))
            .toggleStyle(.switch)
        } header: {
            Text(L("Auto mode"))
        } footer: {
            Footnote(workspace.settings.autoApprovesSafeActions
                ? L("Bots use Claude Code's auto mode: reading, searching and ordinary commands just run; a safety check blocks risky ones (deleting files that were there before, sending data out, force pushes, downloading and running code). It is not a guarantee. Anything it still wants your OK for comes as a card in the chat.")
                : L("Bots ask in the chat before each tool they are not always allowed to use."))
        }
        ResultsSection(workspace: workspace)
        let approved = workspace.approvedCommands
        Section {
            if approved.isEmpty {
                Text(L("None yet. A component asks before it first runs a command."))
                    .foregroundStyle(.secondary)
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
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .help(item.folder)
                    Button(L("Forget")) { workspace.forget(item) }
                        .help(L("Ask again before this command runs in {0}", item.owner))
                        .accessibilityLabel(L("Forget {0}", item.command))
                }
            }
        } header: {
            Text(L("Approved component commands"))
        } footer: {
            Footnote(L("Each row is a command, the bot it belongs to, and Forget: once forgotten, you are asked again before it runs."))
        }
        if workspace.ignoredWaitingCount > 0 {
            Section {
                HStack {
                    Text(L("{0} item(s) taken off \"Waiting on you\"", workspace.ignoredWaitingCount))
                    Spacer()
                    Button(L("Show again")) { workspace.showIgnoredWaiting() }
                }
            } header: {
                Text(L("Ignored"))
            }
        }
    }
}

/// Where bots put reports and other results for you: a claude.ai Artifact or a local HTML page.
struct ResultsSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        Section {
            Picker(L("Publish as"), selection: Binding(
                get: { workspace.settings.resultPublishing },
                set: { workspace.setResultPublishing($0) }
            )) {
                ForEach(ResultPublishing.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            .pickerStyle(.menu)
        } header: {
            Text(L("Reports and results"))
        } footer: {
            Footnote(Self.explanation(workspace.settings.resultPublishing))
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

// MARK: Usage

/// The App's context strategy, shared by the two engines; no CLI cache policy changes.
struct PromptSavingsSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        Section {
            Toggle(L("Send only reaction changes"), isOn: Binding(
                get: { workspace.settings.reactionChangesOnly },
                set: { workspace.setReactionChangesOnly($0) }
            ))
            Toggle(L("Send only component changes"), isOn: Binding(
                get: { workspace.settings.componentChangesOnly },
                set: { workspace.setComponentChangesOnly($0) }
            ))
        } header: {
            Text(L("App context savings"))
        } footer: {
            Footnote(L("Applies to all bots, both Claude and Codex, from the next normal turn. On: send a full snapshot first, then only changes. Off: send a full snapshot every turn. Turning it back on sends a fresh full snapshot first."))
        }
        .toggleStyle(.switch)
    }
}

/// Cost and tokens today, the subscriptions' limits, by bot, and the days before.
private struct UsagePage: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        PromptSavingsSection(workspace: workspace)
        let spending = workspace.spending
        let isToday = spending.day == Spending.today()
        let tokens = isToday ? spending.tokens : TokenUsage()
        Section {
            LabeledContent(L("Cost")) {
                Text(Workspace.dollars(isToday ? spending.spent : 0)).monospacedDigit()
            }
            LabeledContent(L("Tokens")) {
                Text(Workspace.tokenCount(tokens.total)).monospacedDigit()
            }
        } header: {
            Text(L("Usage today"))
        } footer: {
            Footnote(L("In {0} · out {1} · cache write {2} · cache read {3}", Workspace.tokenCount(tokens.input), Workspace.tokenCount(tokens.output), Workspace.tokenCount(tokens.cacheWrite), Workspace.tokenCount(tokens.cacheRead)))
        }
        Section {
            LimitRow(name: "Claude", limits: workspace.rateLimits)
            if !workspace.codexRateLimits.isEmpty { LimitRow(name: "Codex", limits: workspace.codexRateLimits) }
        } header: {
            Text(L("Subscription limits"))
        }
        let bots = isToday ? Set(spending.byBot.keys).union(spending.tokensByBot.keys).sorted {
            (spending.byBot[$0] ?? 0, spending.tokensByBot[$0]?.total ?? 0) > (spending.byBot[$1] ?? 0, spending.tokensByBot[$1]?.total ?? 0)
        } : []
        Section {
            if bots.isEmpty {
                Text(L("No bot has used anything today.")).foregroundStyle(.secondary)
            }
            ForEach(bots, id: \.self) { name in
                row(name, spending.byBot[name] ?? 0, spending.tokensByBot[name]?.total ?? 0)
            }
        } header: {
            Text(L("By bot"))
        }
        if !spending.history.isEmpty {
            Section {
                ForEach(Array(spending.history.reversed()), id: \.day) { day in
                    row(day.day, day.spent, day.tokens.total)
                }
            } header: {
                Text(L("Earlier days"))
            }
        }
    }

    private func row(_ name: String, _ cost: Double, _ tokens: Int) -> some View {
        HStack(spacing: 12) {
            Text(name).lineLimit(1)
            Spacer()
            Text(L("{0} tokens", Workspace.tokenCount(tokens))).foregroundStyle(.secondary).monospacedDigit()
            Text(Workspace.dollars(cost)).monospacedDigit().frame(width: 72, alignment: .trailing)
        }
    }
}

/// One subscription's 5-hour and weekly use, with when each starts over.
private struct LimitRow: View {
    let name: String
    let limits: RateLimits

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let now = context.date
            HStack(alignment: .firstTextBaseline) {
                Text(name)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    if limits.isEmpty {
                        Text(L("no data")).foregroundStyle(.secondary)
                    }
                    if let five = limits.fiveHour {
                        Text("\(L("5 hours")) \(RateLimitText.percent(five, now: now)) · \(RateLimitText.countdown(five, now: now))")
                    }
                    if let week = limits.week {
                        Text("\(L("Week")) \(RateLimitText.percent(week, now: now)) · \(RateLimitText.resetDay(week, now: now))")
                            .foregroundStyle(.secondary)
                    }
                    if let since = limits.staleSince(now: now) {
                        Text(RateLimitText.asOf(since, now: now)).font(.system(size: 11)).foregroundStyle(.tertiary)
                    }
                }
                .monospacedDigit()
            }
        }
    }
}

// MARK: Plugins

/// Botling's plugins: on or off, why one broke, and the settings each declares; and adding one.
private struct PluginsPage: View {
    @ObservedObject var registry: PluginRegistry
    var host: PluginHostClient?
    var workspace: Workspace
    @State private var open: String?
    @State private var source = ""

    var body: some View {
        Section {
            ForEach(registry.plugins) { plugin in
                PluginRow(registry: registry, plugin: plugin, open: open == plugin.name) {
                    open = open == plugin.name ? nil : plugin.name
                }
            }
            if let problem = host?.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(.red)
            }
            ForEach(registry.problems.keys.sorted(), id: \.self) { folder in
                Text(L("Couldn't read \"{0}\": {1}", folder, registry.problems[folder]?.joined(separator: "; ") ?? ""))
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
            }
        } header: {
            Text(L("Installed"))
        } footer: {
            Footnote(L("Click a plugin to see its description and the settings it declares; right-click to revert to the previous version or remove (external plugins)."))
        }
        Section {
            AddPluginRow(workspace: workspace, source: $source)
        } header: {
            Text(L("Add plugin"))
        } footer: {
            Footnote(L("Botling asks before installing. A folder needs a package.json."))
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button(action: toggleOpen) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plugin.manifest.title).foregroundStyle(plugin.enabled ? .primary : .secondary)
                        Text(plugin.builtIn ? L("Built-in · {0}", plugin.manifest.version)
                             : plugin.installedFrom.map { L("External · {0} · {1}", plugin.manifest.version, $0) } ?? plugin.manifest.version)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
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
                .accessibilityLabel(L("Enable {0}", plugin.manifest.title))
            }
            if let failure = plugin.failure {
                Text(plugin.usingPrevious ? L("New version failed, using the previous one: {0}", failure) : L("Failed and disabled: {0}", failure))
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
            }
            if open {
                if let description = plugin.manifest.description {
                    Text(description).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                ForEach(settings, id: \.key) { key, setting in
                    SettingControl(registry: registry, plugin: plugin.name, key: key, setting: setting)
                }
            }
        }
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

/// "Add plugin": paste a git URL, npm name or archive URL (Botling asks before installing), or pick
/// a folder of your own (installed right away).
private struct AddPluginRow: View {
    @ObservedObject var workspace: Workspace
    @Binding var source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField("", text: $source, prompt: Text(L("Git URL, npm name or .zip URL")))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
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
            ForEach(workspace.fetching, id: \.self) { item in
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L("Fetching {0}…", item)).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
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
            Text(setting.title).foregroundStyle(.secondary)
            Spacer()
            if setting.secret == true {
                // Kept in the keychain; Botling never shows it again.
                SecureField(registry.secret(plugin, key) == nil ? L("Not set") : L("Saved in Keychain"), text: $secret)
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .frame(width: 160)
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
                    .textFieldStyle(.roundedBorder).labelsHidden().frame(width: 70)
            default:
                TextField("", text: Binding(get: { value?.string ?? "" }, set: { registry.set(plugin, key, to: .string($0)) }))
                    .textFieldStyle(.roundedBorder).labelsHidden().frame(width: 160)
            }
            }
        }
        .font(.system(size: 12))
        .accessibilityLabel(setting.title)
    }
}

// MARK: Developer mode

/// For working on Botling itself: which project is its source, whose manager may then
/// install new builds, look at the app, and get what you flag as not right.
struct DeveloperSection: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        let folders = workspace.projects.filter { !$0.isBot }
        Section {
            Toggle(L("Develop Botling itself"), isOn: Self.binding(workspace))
                .toggleStyle(.switch)
            if workspace.settings.developerMode {
                Picker(L("Its source"), selection: Binding(
                    get: { workspace.settings.developerProjectID },
                    set: { workspace.setDeveloperMode(true, project: $0) }
                )) {
                    Text(L("Choose a project")).tag(UUID?.none)
                    ForEach(folders) { project in
                        Text(project.name).tag(Optional(project.id))
                    }
                }
                .pickerStyle(.menu)
            }
        } header: {
            Text(L("Developer mode"))
        } footer: {
            Footnote(workspace.settings.developerMode
                ? L("{0}'s manager may install new builds (you confirm; one that does not start is rolled back), take screenshots of this window, and gets what you flag as \"not right\" in any chat.", workspace.developerProject?.name ?? L("That project"))
                : L("Off for everyone who only uses Botling. Turn it on to let one project's manager work on the app itself."))
        }
    }

    /// Developer mode on or off; turned on, with the project chosen before or the one that
    /// looks like Botling's source.
    static func binding(_ workspace: Workspace) -> Binding<Bool> {
        Binding(
            get: { workspace.settings.developerMode },
            set: { on in
                workspace.setDeveloperMode(on, project: workspace.settings.developerProjectID ?? workspace.guessDeveloperSource()?.id)
            }
        )
    }
}

// MARK: Doctor

/// Settings → Doctor: Claude Code and (optional) Codex, each found the way bots find it, with its version,
/// sign-in, and a command to copy when something is wrong.
struct DoctorSection: View {
    @ObservedObject var model: DoctorModel

    var body: some View {
        Section {
            if model.checks.isEmpty {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(L("Checking…")).foregroundStyle(.secondary)
                }
            }
            ForEach(model.checks) { check in
                DoctorRow(check: check)
            }
            HStack(spacing: 10) {
                Button(L("Run again")) { Task { await model.run(includeLatest: true) } }
                    .disabled(model.isRunning)
                if model.isRunning {
                    ProgressView().controlSize(.small)
                } else if let checkedAt = model.checkedAt {
                    Text(L("Checked {0}", checkedAt.formatted(date: .omitted, time: .shortened)))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text(L("Command-line tools"))
        } footer: {
            Footnote(L("Bots run Claude Code; Codex is optional. Each check has a {0}-second limit and spends no tokens.", Int(Doctor.timeout)))
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
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Circle().fill(Self.color(check.status)).frame(width: 9, height: 9)
                    .accessibilityLabel(check.status == .ok ? L("OK") : check.status == .warning ? L("Warning") : L("Failing"))
                Text(check.tool.name).fontWeight(.medium)
                Text(check.version ?? "—").monospacedDigit().foregroundStyle(.secondary)
                Spacer()
                Text(L("needs {0}+", check.tool.minimum.description)).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Group {
                Text(check.summary).foregroundStyle(check.status == .ok ? Color.secondary : Self.color(check.status))
                if let path = check.path {
                    Text((path as NSString).abbreviatingWithTildeInPath).help(path).lineLimit(1).truncationMode(.middle).foregroundStyle(.tertiary).textSelection(.enabled)
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
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
                .padding(.leading, 19)
            }
        }
        .padding(.vertical, 2)
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
