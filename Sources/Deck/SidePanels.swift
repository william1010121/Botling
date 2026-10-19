import AppKit
import DeckCore
import SwiftUI

/// Left column: who. One row per bot; the face shows its state, a dot shows what is new.
struct RailView: View {
    @ObservedObject var workspace: Workspace

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
                        }
                    }
                }
            }
            .scrollIndicators(.never)

            Button(action: addProject) {
                Label("加專案", systemImage: "plus")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.faint)
                    .padding(.horizontal, 10)
                    .frame(height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.top, 36)
        .padding(.bottom, 12)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
    }

    private func addProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "加為專案"
        panel.message = "選一個專案資料夾，Deck 會為它配一位主管。"
        if panel.runModal() == .OK, let folder = panel.url {
            workspace.addProject(folder: folder)
        }
    }
}

/// Deck 維護 (the plugin library's manager): shown while it is awake or working, and after
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
            .accessibilityLabel("Deck 維護，\(status)")
        }
    }

    private var status: String {
        if let (name, change) = library.working.first { return "組件 \(name)：\(change)" }
        if bot.isWorking { return "工作中" }
        return bot.hasUnread ? "改好了，點開看" : bot.statusText
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
        .accessibilityLabel("\(bot.name)，\(bot.statusText)\(waiting ? "，等你決定" : "")")
    }
}

/// Right column: what is going on now and what was made. Settings live one level in.
struct DetailPanel: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    @State private var showingSettings: Bool

    init(workspace: Workspace, bot: Bot, showingSettings: Bool = false) {
        self.workspace = workspace
        self.bot = bot
        _showingSettings = State(initialValue: showingSettings)
    }

    var body: some View {
        Group {
            if showingSettings {
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

    private var overview: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack(spacing: 10) {
                AvatarView(kind: bot.avatarKind, size: 28, eyes: bot.eyes)
                Text(bot.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer()
                Button { showingSettings = true } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("設定")
            }

            PanelSection("現在") {
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
                    // A manager: the first thing under 「進行中」 in its memory.md.
                    if bot.profile.role == .manager,
                       let doing = MemoryFile.items(at: bot.profile.memoryURL, section: "進行中").first {
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
                                    Text("\(max(1, Int(context.date.timeIntervalSince(run.startedAt) / 60))) 分")
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
                PanelSection("等你") {
                    VStack(spacing: 6) {
                        ForEach(workspace.waiting) { item in
                            if let project = workspace.projects.first(where: { $0.id == item.projectID }) {
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
                PanelSection(bot.profile.role == .main ? "剛做好" : "成果") {
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
            .accessibilityLabel("\(seconds / 60) 分 \(seconds % 60) 秒後睡著")
        }
    }
}

private struct SettingsPage: View {
    @ObservedObject var bot: Bot
    /// Deck's plugins, on the main bot's settings only.
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
                .accessibilityLabel("返回")
                Text("設定").font(.system(size: 15, weight: .semibold))
            }

            PanelSection("模型") {
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
                            Label("加一個", systemImage: "plus")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.faint)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let plugins {
                PluginsSection(registry: plugins, host: workspace?.pluginHost)
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
        case .writing: "寫交接"
        case .stopping: "停下 \(bot.model.displayName)"
        case .starting: "開 \((bot.switchTarget ?? bot.model).displayName)"
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
                if let time = routine.schedule.dailyTime, routine.schedule.description.hasPrefix("每天") {
                    DatePicker("時間", selection: binding(hour: time.hour, minute: time.minute), displayedComponents: .hourAndMinute)
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
            Button("刪除", role: .destructive) { bot.removeRoutine(routine.id) }
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
            TextField("名稱，例如：看進度", text: $title)
            TextField("要做什麼（一句話，或 @檔案）", text: $instruction, axis: .vertical)
                .lineLimit(1...3)
            HStack {
                DatePicker("每天", selection: $time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.field)
                    .fixedSize()
                Spacer()
                Button("取消", action: done).buttonStyle(.plain).foregroundStyle(Theme.muted)
                Button("加入") {
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

/// Deck's plugins: on or off, why one broke, and the settings each declares.
private struct PluginsSection: View {
    @ObservedObject var registry: PluginRegistry
    var host: PluginHostClient?
    @State private var open: String?

    var body: some View {
        PanelSection("插件") {
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
                Text("「\(folder)」讀不了：\(registry.problems[folder]?.joined(separator: "；") ?? "")")
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
        (plugin.manifest.deck?.contributes?.settings ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button(action: toggleOpen) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plugin.manifest.title).foregroundStyle(plugin.enabled ? Theme.text : Theme.muted)
                        Text(plugin.builtIn ? "內建 · \(plugin.manifest.version)" : plugin.manifest.version)
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
                .accessibilityLabel("啟用 \(plugin.manifest.title)")
            }
            if let failure = plugin.failure {
                Text(plugin.usingPrevious ? "新版出錯，先用上一版：\(failure)" : "出錯停用了：\(failure)")
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
                Button("退回上一版") { Task { report(await registry.revert(plugin.name)) } }
                    .disabled(!registry.hasPrevious(plugin.name))
                Button("移除", role: .destructive) { confirmingRemove = true }
            }
        }
        .confirmationDialog("移除「\(plugin.manifest.title)」？", isPresented: $confirmingRemove) {
            Button("移除", role: .destructive) { Task { report(await registry.remove(plugin.name)) } }
        } message: {
            Text("插件庫的 git 紀錄會留著，之後還能找回來。")
        }
        .alert("沒辦法完成", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("好") { problem = nil }
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

/// One declared setting, drawn from its type.
private struct SettingControl: View {
    @ObservedObject var registry: PluginRegistry
    let plugin: String
    let key: String
    let setting: PluginManifest.Setting

    var body: some View {
        let value = registry.setting(plugin, key)
        HStack {
            Text(setting.title).foregroundStyle(Theme.muted)
            Spacer()
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
