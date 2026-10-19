import AppKit
import ClaudeCodeBotCore
import SwiftUI

/// Left column: who. One row per bot; the face shows its state, a dot shows what is new.
struct RailView: View {
    @ObservedObject var workspace: Workspace
    @State private var makingBot = false
    @State private var removing: Workspace.Project?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            BotRow(bot: workspace.mainBot, selected: workspace.selection == nil, waiting: false) {
                workspace.select(nil)
            }

            Rectangle().fill(Theme.line).frame(height: 1).padding(10)

            MaintainerRow(
                bot: workspace.maintainer,
                library: workspace.components,
                selected: workspace.selection == Workspace.maintainerID,
                waiting: workspace.waiting.contains { $0.projectID == Workspace.maintainerID }
            ) {
                workspace.select(Workspace.maintainerID)
            }

            ScrollView {
                VStack(spacing: 2) {
                    ForEach(workspace.projects.filter { !$0.isMaintainer }) { project in
                        if let bot = workspace.bot(for: project) {
                            BotRow(
                                bot: bot,
                                selected: workspace.selection == project.id,
                                waiting: workspace.waiting.contains { $0.projectID == project.id }
                            ) {
                                workspace.select(project.id)
                            }
                            .contextMenu {
                                if project.isBot {
                                    Button("Remove bot…", role: .destructive) { removing = project }
                                }
                            }
                        }
                    }
                }
            }
            .scrollIndicators(.never)

            if makingBot {
                NewBotForm { name, job in
                    if let name, let job {
                        guard let bot = workspace.createBot(name: name, job: job, setUp: true) else { return }
                        workspace.select(bot.id)
                    }
                    makingBot = false
                }
            }

            HStack(spacing: 0) {
                Button(action: addProject) {
                    Label("Add project", systemImage: "plus")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.faint)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 8)
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Button { makingBot.toggle() } label: {
                    Label("New bot", systemImage: "sparkles")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.faint)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 8)
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("A bot of its own, with its own memory and routines (a morning news bot, say)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 36)
        .padding(.bottom, 12)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
        .confirmationDialog(
            "Remove \"\(removing?.name ?? "")\"?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { project in
            Button("Remove bot", role: .destructive) { workspace.removeBot(project.id) }
        } message: { project in
            Text("It stops at once. Its notes stay in \(project.folder.path).")
        }
    }

    private func addProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add as project"
        panel.message = "Pick a project folder; ClaudeCodeBot will give it a manager."
        if panel.runModal() == .OK, let folder = panel.url {
            workspace.addProject(folder: folder)
        }
    }
}

/// A bot of its own: a name and what it is for. It then sets up its own routines.
private struct NewBotForm: View {
    /// Nil, nil when cancelled.
    var done: (_ name: String?, _ job: String?) -> Void
    @State private var name = ""
    @State private var job = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Name, e.g. Morning news", text: $name)
            TextField("Its job, e.g. every day at 08:00, the top 5 tech stories", text: $job, axis: .vertical)
                .lineLimit(2...4)
            HStack {
                Spacer()
                Button("Cancel") { done(nil, nil) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                Button("Create") { done(name, job) }.disabled(!canCreate)
            }
        }
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 13))
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
    }

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Maintainer (the plugin library's manager): shown while it is awake or working, and after
/// until you have read what it said. Click to open its chat and work log.
private struct MaintainerRow: View {
    @ObservedObject var bot: Bot
    @ObservedObject var library: ComponentLibrary
    let selected: Bool
    let waiting: Bool
    let open: () -> Void

    private var busy: Bool { bot.isWorking || !library.working.isEmpty }

    var body: some View {
        if selected || busy || bot.phase != .asleep || bot.hasUnread || waiting {
            Button(action: open) {
                HStack(spacing: 12) {
                    AvatarView(kind: .diamond, size: 32, eyes: bot.eyes)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(bot.name).font(.system(size: 15))
                        Text(status)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(hex: 0x8DB5FF))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if waiting {
                        Circle().fill(Theme.orange).frame(width: 9, height: 9)
                    } else if bot.hasUnread && !selected {
                        Circle().fill(Theme.blue).frame(width: 9, height: 9)
                    }
                }
                .padding(.horizontal, 10)
                .frame(height: 52)
                .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : .clear))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.blue, style: StrokeStyle(lineWidth: 1, dash: [4, 3])).opacity(busy ? 1 : 0))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.bottom, 4)
            .accessibilityLabel("Maintainer, \(status)")
        }
    }

    private var status: String {
        if let (name, change) = library.working.first { return "Component \(name): \(change)" }
        if bot.isWorking { return "Working" }
        return bot.hasUnread ? "Done, click to see" : bot.statusText
    }
}

private struct BotRow: View {
    @ObservedObject var bot: Bot
    let selected: Bool
    let waiting: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                AvatarView(kind: bot.avatarKind, size: 32, eyes: bot.eyes)
                Text(bot.name)
                    .font(.system(size: 15, weight: bot.profile.role == .main ? .semibold : .regular))
                    .foregroundStyle(bot.phase == .asleep ? Theme.muted : Theme.text)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if waiting {
                    Circle().fill(Theme.orange).frame(width: 9, height: 9)
                } else if bot.hasUnread && !selected {
                    Circle().fill(Theme.blue).frame(width: 9, height: 9)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 48)
            .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(bot.name), \(bot.statusText)\(waiting ? ", waiting on you" : "")")
    }
}

/// Right column: what is going on now and what was made. Settings live one level in.
struct DetailPanel: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    @ObservedObject var plugins: PluginRegistry
    @State private var showingSettings: Bool
    /// A plugin's panel ("plugin/id") shown instead of the overview.
    @State private var openPanel: String?

    init(workspace: Workspace, bot: Bot, showingSettings: Bool = false) {
        self.workspace = workspace
        self.bot = bot
        self.plugins = workspace.plugins
        _showingSettings = State(initialValue: showingSettings)
    }

    var body: some View {
        Group {
            if let key = openPanel {
                panelPage(key)
            } else if showingSettings {
                SettingsPage(bot: bot, plugins: bot.profile.role == .main ? workspace.plugins : nil, workspace: workspace) { showingSettings = false }
            } else {
                overview
            }
        }
        .padding(20)
        .padding(.top, 16)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
    }

    /// Plugins' panels: up to 3 buttons, the rest under "More".
    @ViewBuilder private var panelButtons: some View {
        let panels = plugins.panels()
        ForEach(Array(panels.prefix(3)), id: \.panel.id) { entry in
            Button { openPanel = "\(entry.plugin.name)/\(entry.panel.id)" } label: {
                Image(systemName: entry.panel.icon ?? "square.grid.2x2")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(entry.panel.title)
            .accessibilityLabel(entry.panel.title)
        }
        if panels.count > 3 {
            Menu {
                ForEach(Array(panels.dropFirst(3)), id: \.panel.id) { entry in
                    Button(entry.panel.title) { openPanel = "\(entry.plugin.name)/\(entry.panel.id)" }
                }
            } label: {
                Image(systemName: "ellipsis").foregroundStyle(Theme.muted)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 32, height: 40)
            .accessibilityLabel("More panels")
        }
    }

    private func panelPage(_ key: String) -> some View {
        let title = plugins.panels().first { "\($0.plugin.name)/\($0.panel.id)" == key }?.panel.title ?? "Panel"
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 4) {
                Button { openPanel = nil } label: {
                    Image(systemName: "chevron.left")
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back")
                Text(title).font(.system(size: 15, weight: .semibold))
            }
            PanelView(key: key, workspace: workspace, plugins: plugins)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack(spacing: 10) {
                AvatarView(kind: bot.avatarKind, size: 28, eyes: bot.eyes)
                Text(bot.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer()
                panelButtons
                Button { showingSettings = true } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
            }

            PanelSection("Now") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        Circle().fill(bot.statusColor).frame(width: 8, height: 8)
                        Text(bot.statusText)
                        Spacer()
                        if let sleepsAt = bot.sleepsAt {
                            SleepCountdown(until: sleepsAt)
                        }
                    }
                    .frame(minHeight: 24)
                    // A manager: the first thing under "In progress" in its memory.md.
                    if bot.profile.role == .manager,
                       let doing = MemoryFile.items(at: bot.profile.memoryURL, section: "In progress").first {
                        Text(doing)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                    }
                    // The main bot: temporary teams at work.
                    if bot.profile.role == .main {
                        ForEach(workspace.runningTeams) { run in
                            HStack(spacing: 10) {
                                AvatarView(kind: .cloud, size: 22)
                                Text(run.spec.title).font(.system(size: 13))
                                Spacer()
                                TimelineView(.periodic(from: .now, by: 30)) { context in
                                    Text("\(max(1, Int(context.date.timeIntervalSince(run.startedAt) / 60))) min")
                                        .font(.system(size: 12))
                                        .monospacedDigit()
                                        .foregroundStyle(Theme.faint)
                                }
                            }
                            .help(run.task)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
            }

            if bot.profile.role == .main, !workspace.waiting.isEmpty {
                PanelSection("Waiting on you") {
                    VStack(spacing: 6) {
                        ForEach(workspace.waiting) { item in
                            if let project = workspace.project(item.projectID) {
                                Button { workspace.select(project.id) } label: {
                                    HStack(spacing: 12) {
                                        AvatarView(kind: AvatarKind(rawValue: project.avatar) ?? .square, size: 26)
                                        Text(item.text).lineLimit(2).multilineTextAlignment(.leading)
                                        Spacer(minLength: 4)
                                        Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Theme.orange)
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 10)
                                    .frame(minHeight: 52)
                                    .background(RoundedRectangle(cornerRadius: 14).fill(Color(hex: 0x2A2116)))
                                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(hex: 0x6B4A1F)))
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }

            let results = Array(bot.results.prefix(3))
            if !results.isEmpty {
                PanelSection(bot.profile.role == .main ? "Just done" : "Results") {
                    VStack(spacing: 6) {
                        ForEach(results, id: \.self) { chip in
                            Button { workspace.openResult = chip } label: {
                                HStack {
                                    Text(chip.label).lineLimit(1)
                                    Spacer()
                                    Image(systemName: "arrow.up.right").font(.system(size: 12)).foregroundStyle(Theme.faint)
                                }
                                .padding(.horizontal, 14)
                                .frame(height: 44)
                                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

/// "☾ 48:12": how long until the bot tidies up and falls asleep.
private struct SleepCountdown: View {
    let until: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(until.timeIntervalSince(context.date).rounded(.up)))
            HStack(spacing: 4) {
                Image(systemName: "moon.fill").font(.system(size: 10))
                Text(String(format: "%d:%02d", seconds / 60, seconds % 60)).monospacedDigit()
            }
            .font(.system(size: 13))
            .foregroundStyle(Theme.faint)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Falls asleep in \(seconds / 60) min \(seconds % 60) s")
        }
    }
}

private struct SettingsPage: View {
    @ObservedObject var bot: Bot
    /// ClaudeCodeBot's plugins, on the main bot's settings only.
    var plugins: PluginRegistry?
    var workspace: Workspace?
    var close: () -> Void
    @State private var adding = false

    var body: some View {
        ScrollView {
            content
        }
        .scrollIndicators(.never)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack(spacing: 4) {
                Button(action: close) {
                    Image(systemName: "chevron.left")
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back")
                Text("Settings").font(.system(size: 15, weight: .semibold))
            }

            PanelSection("Model") {
                VStack(spacing: 0) {
                    ForEach(BotModel.allCases, id: \.self) { model in
                        let chosen = (bot.switchTarget ?? bot.model) == model
                        Button {
                            Task { await bot.switchModel(to: model) }
                        } label: {
                            HStack {
                                Text(model.displayName).foregroundStyle(chosen ? Theme.text : Theme.muted)
                                Spacer()
                                if chosen {
                                    Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.blue)
                                }
                            }
                            .padding(.horizontal, 16)
                            .frame(height: 48)
                            .background(chosen ? Color(hex: 0x22222A) : .clear)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(bot.isSwitching)
                        if model != BotModel.allCases.last {
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
                .clipShape(RoundedRectangle(cornerRadius: 14))

                if case let .switching(current) = bot.phase {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(HandoffStep.allCases, id: \.self) { step in
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(step.rawValue < current.rawValue ? Theme.green : step == current ? Theme.blue : Color(hex: 0x3A3A40))
                                    .frame(width: 8, height: 8)
                                Text(label(for: step))
                                    .foregroundStyle(step.rawValue > current.rawValue ? Theme.faint : Theme.text)
                            }
                        }
                    }
                    .font(.system(size: 14))
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
                }
            }

            PanelSection("Routines") {
                VStack(spacing: 6) {
                    ForEach(bot.routines) { routine in
                        RoutineRow(bot: bot, routine: routine)
                    }
                    if adding {
                        AddRoutineForm(bot: bot) { adding = false }
                    } else {
                        Button { adding = true } label: {
                            Label("Add one", systemImage: "plus")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.faint)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if !bot.alwaysAllowed.isEmpty {
                PanelSection("Always allowed") {
                    VStack(spacing: 0) {
                        ForEach(bot.alwaysAllowed, id: \.self) { tool in
                            HStack {
                                Text(tool).font(.system(size: 14))
                                Spacer()
                                Button("Ask again") { bot.forget(alwaysAllowed: tool) }
                                    .buttonStyle(.plain)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.muted)
                            }
                            .padding(.horizontal, 16)
                            .frame(height: 44)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
                    .help("Tools you let this bot use without asking. Takes effect the next time it wakes.")
                }
            }

            if let plugins {
                PluginsSection(registry: plugins, host: workspace?.pluginHost, workspace: workspace)
            }

            Spacer()
            Text(bot.profile.workingDirectory.path(percentEncoded: false))
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .textSelection(.enabled)
        }
    }

    private func label(for step: HandoffStep) -> String {
        switch step {
        case .writing: "Writing handoff"
        case .stopping: "Stopping \(bot.model.displayName)"
        case .starting: "Starting \((bot.switchTarget ?? bot.model).displayName)"
        }
    }
}

/// One job from routines.cron: its name and when, and a switch. Right-click to delete. A
/// once-a-day job can be re-timed here; anything fancier shows its cron fields.
private struct RoutineRow: View {
    @ObservedObject var bot: Bot
    let routine: Routine

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(routine.title).foregroundStyle(routine.enabled ? Theme.text : Theme.muted)
                if let time = routine.schedule.dailyTime, routine.schedule.description.hasPrefix("Every day") {
                    DatePicker("Time", selection: binding(hour: time.hour, minute: time.minute), displayedComponents: .hourAndMinute)
                        .labelsHidden()
                        .datePickerStyle(.field)
                        .font(.system(size: 13))
                        .fixedSize()
                } else {
                    Text(routine.schedule.description)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            Toggle(routine.title, isOn: Binding(
                get: { routine.enabled },
                set: { bot.setRoutine(routine.id, enabled: $0) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .tint(Theme.blue)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
        .help(routine.instruction)
        .contextMenu {
            Button("Delete", role: .destructive) { bot.removeRoutine(routine.id) }
        }
    }

    private func binding(hour: Int, minute: Int) -> Binding<Date> {
        Binding(
            get: { Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date() },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                bot.setRoutine(routine.id, hour: parts.hour ?? hour, minute: parts.minute ?? minute)
            }
        )
    }
}

private struct AddRoutineForm: View {
    @ObservedObject var bot: Bot
    var done: () -> Void
    @State private var title = ""
    @State private var instruction = ""
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Name, e.g. Check progress", text: $title)
            TextField("What to do (one sentence, or @file)", text: $instruction, axis: .vertical)
                .lineLimit(1...3)
            HStack {
                DatePicker("Every day", selection: $time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.field)
                    .fixedSize()
                Spacer()
                Button("Cancel", action: done).buttonStyle(.plain).foregroundStyle(Theme.muted)
                Button("Add") {
                    let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
                    bot.addRoutine(
                        title: title.trimmingCharacters(in: .whitespaces),
                        instruction: instruction,
                        hour: parts.hour ?? 9,
                        minute: parts.minute ?? 0
                    )
                    done()
                }
                .disabled(!canAdd)
            }
        }
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 14))
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
    }

    private var canAdd: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty && !instruction.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

/// ClaudeCodeBot's plugins: on or off, why one broke, and the settings each declares.
private struct PluginsSection: View {
    @ObservedObject var registry: PluginRegistry
    var host: PluginHostClient?
    var workspace: Workspace?
    @State private var open: String?
    @State private var source = ""

    var body: some View {
        PanelSection("Plugins") {
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
            if let workspace {
                AddPluginRow(workspace: workspace, source: $source)
            }
            ForEach(registry.problems.keys.sorted(), id: \.self) { folder in
                Text("Couldn't read \"\(folder)\": \(registry.problems[folder]?.joined(separator: "; ") ?? "")")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.errorText)
            }
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
                        Text(plugin.builtIn ? "Built-in · \(plugin.manifest.version)"
                             : plugin.installedFrom.map { "External · \(plugin.manifest.version) · \($0)" } ?? plugin.manifest.version)
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
                .accessibilityLabel("Enable \(plugin.manifest.title)")
            }
            if let failure = plugin.failure {
                Text(plugin.usingPrevious ? "New version failed, using the previous one: \(failure)" : "Failed and disabled: \(failure)")
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
                Button("Revert to previous version") { Task { report(await registry.revert(plugin.name)) } }
                    .disabled(!registry.hasPrevious(plugin.name))
                Button("Remove", role: .destructive) { confirmingRemove = true }
            }
        }
        .confirmationDialog("Remove \"\(plugin.manifest.title)\"?", isPresented: $confirmingRemove) {
            Button("Remove", role: .destructive) { Task { report(await registry.remove(plugin.name)) } }
        } message: {
            Text("The plugin library's git history is kept, so it can be recovered later.")
        }
        .alert("Couldn't finish", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK") { problem = nil }
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
                TextField("Add plugin: git URL, npm name or .zip URL", text: $source)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(add)
                Button("Add", action: add).disabled(source.trimmingCharacters(in: .whitespaces).isEmpty)
                Button {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true
                    panel.canChooseFiles = false
                    panel.prompt = "Add as plugin"
                    panel.message = "Pick a plugin folder (one with a package.json)."
                    if panel.runModal() == .OK, let folder = panel.url {
                        Task { await workspace.proposeInstall(folder.path, trusted: true) }
                    }
                } label: {
                    Image(systemName: "folder")
                }
                .help("Add from folder")
                .accessibilityLabel("Add plugin from folder")
            }
            .font(.system(size: 13))
            ForEach(workspace.fetching, id: \.self) { item in
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Fetching \(item)…").font(.system(size: 12)).foregroundStyle(Theme.faint).lineLimit(1)
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
                SecureField(registry.secret(plugin, key) == nil ? "Not set" : "Saved in Keychain", text: $secret)
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

private struct PanelSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
            content
        }
    }
}
