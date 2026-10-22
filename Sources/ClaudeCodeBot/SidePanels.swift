import AppKit
import Combine
import ClaudeCodeBotCore
import SwiftUI

/// Left column: who. One row per bot; the face shows its state, a dot shows what is new.
/// Folded (`collapsed`), it is a strip of faces only (see `RailStrip`).
struct RailView: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var settings: SettingsNavigator
    var collapsed = false
    /// The folded strip's hover tip, drawn by the window over the chat.
    @Binding var tip: RailTip?
    @State private var makingBot = false
    @State private var showingQuickSettings = false
    @State private var removing: Workspace.Project?
    /// The group being made (a new one) or changed, in the sheet.
    @State private var editingGroup: ChatGroup?
    @State private var deletingGroup: ChatGroup?
    /// Bumped when any chat gets a line, so the list sorts again.
    @State private var activity = 0
    /// What the search field at the top holds (⌘K puts the cursor there).
    @State private var query: String
    @FocusState private var searchFocused: Bool

    init(workspace: Workspace, settings: SettingsNavigator, collapsed: Bool = false, tip: Binding<RailTip?> = .constant(nil), query: String = "") {
        self.workspace = workspace
        self.settings = settings
        self.collapsed = collapsed
        _tip = tip
        _query = State(initialValue: query)
    }

    /// One row of the list: a group or a project's bot.
    struct Entry: Identifiable {
        enum Kind {
            case group(ChatGroup, Bot)
            case project(Workspace.Project, Bot)
        }

        let id: UUID
        let kind: Kind
        let bot: Bot
    }

    /// Groups and projects together, the one with the newest line first, as in Messages.
    private var entries: [Entry] {
        _ = activity
        var all = workspace.groups.compactMap { group in
            workspace.groupChats[group.id].map { Entry(id: group.id, kind: .group(group, $0), bot: $0) }
        }
        all += workspace.projects.filter { !$0.isMaintainer }.compactMap { project in
            workspace.bot(for: project).map { Entry(id: project.id, kind: .project(project, $0), bot: $0) }
        }
        return all.enumerated()
            .sorted { ($0.element.bot.lastActivity, $1.offset) > ($1.element.bot.lastActivity, $0.offset) }
            .map(\.element)
    }

    /// The pinned rows first, in the order they were pinned, then the rest by newest line.
    private var arranged: (pinned: [Entry], rest: [Entry]) {
        RailLayout.pinnedFirst(entries, id: \.id, pinned: workspace.pinnedBots)
    }

    /// One row the search kept, in the order the column shows them.
    private enum Hit: Identifiable {
        case main
        case entry(Entry)

        var id: UUID {
            switch self {
            case .main: Workspace.mainBotID
            case .entry(let entry): entry.id
            }
        }
    }

    private var isSearching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The main bot, then the pinned rows and the rest, kept when the name (or the
    /// project's folder name) has what the search field holds.
    private var hits: [Hit] {
        var hits: [Hit] = []
        if RailLayout.matches(query, name: workspace.mainBot.name, folder: nil) { hits.append(.main) }
        let (pinned, rest) = arranged
        for entry in pinned + rest {
            switch entry.kind {
            case .group(let group, _):
                if RailLayout.matches(query, name: group.name, folder: nil) { hits.append(.entry(entry)) }
            case .project(let project, let bot):
                if RailLayout.matches(query, name: bot.name, folder: project.isBot ? nil : project.folder.lastPathComponent) {
                    hits.append(.entry(entry))
                }
            }
        }
        return hits
    }

    private func open(_ hit: Hit) {
        switch hit {
        case .main: workspace.select(nil)
        case .entry(let entry): workspace.select(entry.id)
        }
        endSearch()
    }

    /// ⌘K: the cursor in the search field, opening a folded column first.
    private func startSearch() {
        if collapsed { workspace.setRailCollapsed(false) }
        // After the open column (and its field) is drawn.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { searchFocused = true }
    }

    /// Esc, or a row opened from the results: the field emptied and the cursor back in the
    /// input box.
    private func endSearch() {
        query = ""
        searchFocused = false
        NotificationCenter.default.post(name: .focusComposer, object: nil)
    }

    var body: some View {
        Group {
            if collapsed {
                RailStrip(
                    workspace: workspace,
                    entries: arranged.pinned + arranged.rest,
                    pinnedCount: arranged.pinned.count,
                    tip: $tip,
                    showingQuickSettings: $showingQuickSettings,
                    addProject: addProject,
                    // The form needs the open column's width.
                    newBot: { workspace.setRailCollapsed(false); makingBot = true },
                    newGroup: { editingGroup = ChatGroup(name: "", members: []) },
                    editGroup: { editingGroup = $0 },
                    deleteGroup: { deletingGroup = $0 },
                    removeBot: { removing = $0 },
                    openSettings: openSettings
                )
            } else {
                list
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
        .background {
            Button(L("Search bots"), action: startSearch)
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        // Only new lines count: @Published sends its current value as soon as it is subscribed
        // to, and this is subscribed to again on every redraw, so taking that first value too
        // would bump `activity`, redraw, subscribe again, and never stop (a frozen app).
        .onReceive(Publishers.MergeMany(entries.map { $0.bot.$messages.dropFirst().map { _ in () } })) { _ in activity &+= 1 }
        .confirmationDialog(
            L("Remove \"{0}\"?", removing?.name ?? ""),
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { project in
            Button(L("Remove bot"), role: .destructive) { workspace.removeBot(project.id) }
        } message: { project in
            Text(L("It stops at once. Its notes stay in {0}.", project.folder.path))
        }
        .confirmationDialog(
            L("Delete the group \"{0}\"?", deletingGroup?.name ?? ""),
            isPresented: Binding(get: { deletingGroup != nil }, set: { if !$0 { deletingGroup = nil } }),
            presenting: deletingGroup
        ) { group in
            Button(L("Delete group"), role: .destructive) { workspace.deleteGroup(group.id) }
        } message: { _ in
            Text(L("Its conversation is deleted. The bots in it keep their own chats and memory."))
        }
        .sheet(item: $editingGroup) { group in
            GroupForm(workspace: workspace, group: group) { name, members in
                if workspace.group(group.id) != nil {
                    workspace.editGroup(group.id, name: name, members: members)
                } else {
                    workspace.createGroup(name: name, members: members)
                }
            }
        }
    }

    /// The gear popover's rows open the settings window, after the popover has gone (so the
    /// sheet is not shown from inside it).
    private func openSettings(_ section: SettingsSection?) {
        showingQuickSettings = false
        DispatchQueue.main.async { settings.open(section) }
    }

    /// The open column: the search field, then a row per bot with its name, status and
    /// subagents, the pinned ones first.
    private var list: some View {
        VStack(alignment: .leading, spacing: 2) {
            searchField.padding(.bottom, 6)

            if isSearching {
                searchResults
            } else {
                BotRow(bot: workspace.mainBot, selected: workspace.selection == nil && workspace.viewingSubagent == nil, waiting: workspace.waiting.contains { $0.projectID == Workspace.mainBotID }) {
                    workspace.select(nil)
                }
                SubagentRows(bot: workspace.mainBot, workspace: workspace)

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
                    let (pinned, rest) = arranged
                    VStack(spacing: 2) {
                        if !pinned.isEmpty {
                            sectionTitle(L("Pinned")).frame(height: 28)
                            ForEach(pinned) { entryRow($0) }
                        }
                        WebRailSection(workspace: workspace)
                        HStack {
                            sectionTitle(L("Chats"))
                            Button { editingGroup = ChatGroup(name: "", members: []) } label: {
                                Image(systemName: "plus")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.faint)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .help(L("New group: pick the bots you want in one conversation"))
                            .accessibilityLabel(L("New group"))
                        }
                        .padding(.top, 6)
                        ForEach(rest) { entryRow($0) }
                    }
                    .animation(.easeInOut(duration: 0.25), value: entries.map(\.id))
                    .animation(.easeInOut(duration: 0.25), value: workspace.pinnedBots)
                }
                .scrollIndicators(.never)
            }

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
                    Label(L("Add project"), systemImage: "plus")
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
                    Label(L("New bot"), systemImage: "sparkles")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.faint)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 8)
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L("A bot of its own, with its own memory and routines (a morning news bot, say)"))
                Button { showingQuickSettings.toggle() } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14))
                        .foregroundStyle(showingQuickSettings ? Theme.text : Theme.faint)
                        .frame(width: 32, height: 32)
                        .background(RoundedRectangle(cornerRadius: 8).fill(showingQuickSettings ? Theme.selected : .clear))
                        .overlay(alignment: .topTrailing) { DoctorDot(model: workspace.doctor) }
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L("Settings: today's cost, auto-approve, plugins"))
                .accessibilityLabel(L("Settings"))
                .popover(isPresented: $showingQuickSettings, arrowEdge: .top) {
                    SettingsPopover(workspace: workspace, registry: workspace.plugins, open: openSettings)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 36)
        .padding(.bottom, 12)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 10)
    }

    /// The search field at the top of the column (⌘K): rows are kept as you type, Enter opens
    /// the first, Esc empties it.
    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
            TextField(L("Search bots"), text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($searchFocused)
                .onSubmit { if let first = hits.first { open(first) } }
                .onExitCommand(perform: endSearch)
                .accessibilityLabel(L("Search bots"))
            if query.isEmpty {
                Text(RailLayout.searchShortcut)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                    .accessibilityHidden(true)
            } else {
                Button(action: endSearch) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L("Clear search (Esc)"))
                .accessibilityLabel(L("Clear search"))
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(searchFocused ? Theme.blue.opacity(0.6) : Theme.line, lineWidth: 1))
        .help(L("Search bots by name or project folder ({0})", RailLayout.searchShortcut))
    }

    /// What the search kept, or "No bots match".
    @ViewBuilder private var searchResults: some View {
        let hits = hits
        if hits.isEmpty {
            Text(RailLayout.noMatches)
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
            Spacer(minLength: 0)
        } else {
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(hits) { hit in
                        switch hit {
                        case .main:
                            BotRow(bot: workspace.mainBot, selected: workspace.selection == nil && workspace.viewingSubagent == nil, waiting: workspace.waiting.contains { $0.projectID == Workspace.mainBotID }) {
                                open(hit)
                            }
                        case .entry(let entry):
                            entryRow(entry, subagents: false) { open(hit) }
                        }
                    }
                }
            }
            .scrollIndicators(.never)
        }
    }

    /// A group's or a project's row, with its menu (Pin / Unpin for a project).
    @ViewBuilder
    private func entryRow(_ entry: Entry, subagents: Bool = true, action: (() -> Void)? = nil) -> some View {
        switch entry.kind {
        case .group(let group, let chat):
            GroupRow(group: group, chat: chat, workspace: workspace, selected: workspace.selection == group.id) {
                if let action { action() } else { workspace.select(group.id) }
            }
            .contextMenu {
                Button(L("Edit group…")) { editingGroup = group }
                Button(L("Delete group…"), role: .destructive) { deletingGroup = group }
            }
        case .project(let project, let bot):
            let pinned = workspace.isPinned(project.id)
            BotRow(
                bot: bot,
                selected: workspace.selection == project.id && workspace.viewingSubagent == nil,
                waiting: workspace.waiting.contains { $0.projectID == project.id },
                pinned: pinned,
                togglePin: { workspace.togglePin(project.id) }
            ) {
                if let action { action() } else { workspace.select(project.id) }
            }
            .contextMenu {
                Button(pinned ? L("Unpin") : L("Pin")) { workspace.togglePin(project.id) }
                if project.isBot {
                    Divider()
                    Button(L("Remove bot…"), role: .destructive) { removing = project }
                }
            }
            if subagents { SubagentRows(bot: bot, workspace: workspace) }
        }
    }

    private func addProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = L("Add as project")
        panel.message = L("Pick a project folder; ClaudeCodeBot will give it a manager.")
        if panel.runModal() == .OK, let folder = panel.url {
            workspace.addProject(folder: folder)
        }
    }
}

/// How many lines you have not read, as in Messages.
private struct UnreadBadge: View {
    let count: Int

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(Theme.blue))
            .accessibilityLabel(L("{0} unread", count))
    }
}

/// A group you made: its name, and who is writing or how many are in it.
private struct GroupRow: View {
    let group: ChatGroup
    @ObservedObject var chat: Bot
    @ObservedObject var workspace: Workspace
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "person.3.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.chip))
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.name).font(.system(size: 15)).lineLimit(1)
                    if let speaker = workspace.groupSpeakers[group.id].flatMap(workspace.speakerName(for:)) {
                        Text(L("{0} is writing…", speaker))
                            .font(.system(size: 12))
                            .foregroundStyle(Color(hex: 0x8DB5FF))
                            .lineLimit(1)
                    } else {
                        Text(workspace.members(of: group).map(\.name).joined(separator: ", "))
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.faint)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if workspace.groupHasQuestion(group.id) {
                    Circle().fill(Theme.orange).frame(width: 9, height: 9)
                } else if chat.hasUnread && !selected {
                    UnreadBadge(count: chat.unreadCount)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 48)
            .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(workspace.groupHasQuestion(group.id) ? L("Group {0}, waiting on you", group.name) : L("Group {0}", group.name))
    }
}

/// Making or changing a group: a name and the bots in it.
private struct GroupForm: View {
    @ObservedObject var workspace: Workspace
    let group: ChatGroup
    let save: (_ name: String, _ members: [UUID]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var picked: Set<UUID>

    init(workspace: Workspace, group: ChatGroup, save: @escaping (String, [UUID]) -> Void) {
        self.workspace = workspace
        self.group = group
        self.save = save
        _name = State(initialValue: group.name)
        _picked = State(initialValue: Set(group.members))
    }

    private var isNew: Bool { workspace.group(group.id) == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(isNew ? L("New group") : L("Edit group")).font(.system(size: 15, weight: .semibold))
            TextField(L("Group name, e.g. Blog team"), text: $name)
                .textFieldStyle(.roundedBorder)
            Text(L("Who is in it")).font(.system(size: 12)).foregroundStyle(Theme.faint)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(workspace.everyMember, id: \.id) { member in
                        Toggle(isOn: Binding(
                            get: { picked.contains(member.id) },
                            set: { if $0 { picked.insert(member.id) } else { picked.remove(member.id) } }
                        )) {
                            HStack(spacing: 8) {
                                AvatarView(kind: workspace.avatar(for: member.id) ?? .circle, size: 20)
                                Text(member.name).lineLimit(1)
                            }
                        }
                        .toggleStyle(.checkbox)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 280)
            HStack {
                Spacer()
                Button(L("Cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(isNew ? L("Create") : L("Save")) {
                    save(name, Array(picked))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || picked.isEmpty)
            }
        }
        .font(.system(size: 13))
        .padding(20)
        .frame(width: 340)
    }
}

/// Right column for a group: who is in it, what waits for you there, what was handed in.
struct GroupPanel: View {
    @ObservedObject var workspace: Workspace
    let group: ChatGroup
    @ObservedObject var chat: Bot
    @State private var editing: ChatGroup?

    var body: some View {
        ScrollView {
            content
        }
        .scrollIndicators(.never)
        .padding(20)
        .padding(.top, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.side)
        .sheet(item: $editing) { group in
            GroupForm(workspace: workspace, group: group) { name, members in
                workspace.editGroup(group.id, name: name, members: members)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                Text(group.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer()
                Button { editing = group } label: {
                    Image(systemName: "person.badge.plus")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L("Rename, add or take out members"))
                .accessibilityLabel(L("Edit group"))
            }
            .frame(height: 40)

            let waiting = workspace.waiting.filter { $0.groupID == group.id }
            if !waiting.isEmpty {
                PanelSection(L("Waiting on you")) {
                    WaitingList(workspace: workspace, items: waiting)
                }
            }

            PanelSection(L("In the group")) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(workspace.members(of: group), id: \.id) { member in
                        GroupMemberRow(
                            bot: member.bot,
                            kind: workspace.avatar(for: member.id) ?? .circle,
                            writing: workspace.groupSpeakers[group.id] == member.id
                        ) {
                            workspace.select(member.id == Workspace.mainBotID ? nil : member.id)
                        }
                    }
                    Text(L("Without @, everyone here reads your message in turn and answers only if it concerns them. @name talks to one of them."))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                        .padding(.top, 4)
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
            }

            let results = Array(chat.results.prefix(3))
            if !results.isEmpty {
                PanelSection(L("Just done")) {
                    VStack(spacing: 6) {
                        ForEach(results, id: \.self) { chip in
                            Button { ResultWindows.open(chip) } label: {
                                HStack {
                                    Text(chip.label).lineLimit(1)
                                    Spacer()
                                    Image(systemName: ArtifactLink.isArtifact(chip.url) ? "safari" : "arrow.up.right").font(.system(size: 12)).foregroundStyle(Theme.faint)
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

/// Questions waiting for you; each opens the chat where it can be answered.
struct WaitingList: View {
    @ObservedObject var workspace: Workspace
    let items: [Workspace.Waiting]

    var body: some View {
        VStack(spacing: 6) {
            ForEach(items) { item in
                HStack(spacing: 0) {
                    Button { workspace.select(item.groupID ?? (item.projectID == Workspace.mainBotID ? nil : item.projectID)) } label: {
                        HStack(spacing: 12) {
                            AvatarView(kind: workspace.avatar(for: item.projectID) ?? .cloud, size: 26)
                            Text(item.text).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Theme.orange)
                        }
                        .padding(.leading, 14)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button { workspace.ignoreWaiting(item) } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.faint)
                            .frame(width: 36, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(L("Ignore: take it off this list without answering"))
                    .accessibilityLabel(L("Ignore"))
                }
                .frame(minHeight: 52)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color(hex: 0x2A2116)))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(hex: 0x6B4A1F)))
                .contextMenu {
                    Button(L("Ignore")) { workspace.ignoreWaiting(item) }
                }
            }
        }
    }
}

/// One member in a group's panel; it follows that bot, so its state stays current.
struct GroupMemberRow: View {
    @ObservedObject var bot: Bot
    let kind: AvatarKind
    let writing: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                AvatarView(kind: kind, size: 22, eyes: bot.eyes)
                Text(bot.name).font(.system(size: 13)).lineLimit(1)
                Spacer()
                Text(bot.waitingForPermission ? L("Waiting for your OK") : writing ? L("Writing…") : bot.statusText)
                    .font(.system(size: 12))
                    .foregroundStyle(bot.waitingForPermission ? Theme.orange : Theme.faint)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            TextField(L("Name, e.g. Morning news"), text: $name)
            TextField(L("Its job, e.g. every day at 08:00, the top 5 tech stories"), text: $job, axis: .vertical)
                .lineLimit(2...4)
            HStack {
                Spacer()
                Button(L("Cancel")) { done(nil, nil) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                Button(L("Create")) { done(name, job) }.disabled(!canCreate)
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
                        UnreadBadge(count: bot.unreadCount)
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
            .accessibilityLabel(L("Maintainer, {0}", status))
        }
    }

    private var status: String { Workspace.maintainerStatus(bot, library: library) }
}

private struct BotRow: View {
    @ObservedObject var bot: Bot
    let selected: Bool
    let waiting: Bool
    /// Nil for a row that cannot be pinned (the main bot).
    var pinned: Bool?
    var togglePin: () -> Void = {}
    let action: () -> Void

    @State private var hovering = false

    /// The pin glyph shows at the row's end while the pointer is on it.
    private var showsPin: Bool { pinned != nil && hovering }

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
                    UnreadBadge(count: bot.unreadCount)
                }
            }
            .padding(.leading, 10)
            // Room for the pin glyph drawn over the row's end.
            .padding(.trailing, showsPin ? 36 : 10)
            .frame(height: 48)
            .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : hovering && pinned != nil ? Theme.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            if showsPin, let pinned {
                Button(action: togglePin) {
                    Image(systemName: pinned ? "pin.slash" : "pin")
                        .font(.system(size: 12))
                        .foregroundStyle(pinned ? Theme.text : Theme.faint)
                        .frame(width: 24, height: 24)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.chip))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, 8)
                .help(pinned ? L("Unpin") : L("Pin to the top"))
                .accessibilityLabel(pinned ? L("Unpin {0}", bot.name) : L("Pin {0}", bot.name))
            }
        }
        .onHover { hovering = $0 }
        .accessibilityLabel([bot.name, bot.statusText, waiting ? L("waiting on you") : nil, pinned == true ? L("pinned") : nil].compactMap { $0 }.joined(separator: ", "))
    }
}

/// Under a bot: the subagents it sent off that are running or ended a few minutes ago, the
/// way Claude Code lists a session's subagents. Click one to watch its conversation; the
/// clock on the right settles it into the right column's "Settled" (it does not stop it).
struct SubagentRows: View {
    @ObservedObject var bot: Bot
    @ObservedObject var workspace: Workspace
    /// "Show more" lists every row; per bot, forgotten on restart.
    @State private var showsAll = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let more = bot.trace.beyondCap(at: context.date)
            ForEach(bot.trace.listed(at: context.date, limit: showsAll && more > 0 ? nil : TraceBook.listedAtMost)) { subagent in
                SubagentRow(subagent: subagent, bot: bot, workspace: workspace)
            }
            if more > 0 {
                Button { showsAll.toggle() } label: {
                    Text(showsAll ? L("Show less") : L("Show {0} more", more))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 45)
                        .frame(height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsAll ? L("Show fewer subagents of {0}", bot.name) : L("Show {0} more subagents of {1}", more, bot.name))
            }
        }
    }

    /// A dot only while it works (blue, like a bot at work); once ended, a quiet sign of how.
    @ViewBuilder
    static func mark(_ mark: Subagent.Mark) -> some View {
        switch mark {
        case .live:
            Circle().fill(Theme.blue).frame(width: 7, height: 7).opacity(0.9)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint)
        case .failed:
            Image(systemName: "exclamationmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.orange)
        case .stopped:
            Image(systemName: "stop.fill").font(.system(size: 7)).foregroundStyle(Theme.faint)
        }
    }
}

/// One subagent's row. It has one icon on the right: a blue dot while the subagent works,
/// and once it has ended (or while the pointer is on a running one) the settle button, a
/// clock badged with how it ended. Settling moves the row to "Settled" in the right column.
struct SubagentRow: View {
    let subagent: Subagent
    @ObservedObject var bot: Bot
    @ObservedObject var workspace: Workspace
    @State private var hovering = false

    private var selected: Bool { workspace.selectedBot === bot && workspace.viewingSubagent == subagent.id }
    private var showsSettle: Bool { hovering || !subagent.isRunning }

    var body: some View {
        HStack(spacing: 0) {
            Button { workspace.view(subagent: subagent.id, of: bot) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.faint)
                    Text(subagent.description.isEmpty ? L("Subagent") : subagent.description)
                        .font(.system(size: 13))
                        .foregroundStyle(subagent.isRunning ? Theme.text : Theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if bot.outage?.subagents.contains(subagent.id) == true {
                        Text(NetworkResume.label).font(.system(size: 11)).foregroundStyle(Theme.orange)
                    }
                }
                .padding(.leading, 26)
                .padding(.trailing, 4)
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(subagent.prompt)
            .accessibilityLabel(L("Subagent of {0}: {1}, {2}", bot.name, subagent.description, subagent.status.rawValue))
            Button(action: settle) {
                Group {
                    if showsSettle {
                        Self.settleIcon(subagent.mark)
                    } else {
                        SubagentRows.mark(subagent.mark)
                    }
                }
                .frame(width: 24, height: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(showsSettle)
            .help(subagent.isRunning ? L("Settle: move to Settled in the right column (it keeps working)") : L("Settle: move to Settled in the right column"))
            .accessibilityLabel(L("Settle subagent {0}", subagent.description))
            .padding(.trailing, 6)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(selected ? Theme.selected : .clear))
        .onHover { hovering = $0 }
        .contextMenu {
            Button(L("Settle")) { settle() }
        }
    }

    /// The settle button: a clock with how it ended (a check once done).
    @ViewBuilder
    static func settleIcon(_ mark: Subagent.Mark) -> some View {
        switch mark {
        case .live, .done:
            Image(systemName: "clock.badge.checkmark").font(.system(size: 12)).foregroundStyle(Theme.muted)
        case .failed:
            Image(systemName: "clock.badge.exclamationmark").font(.system(size: 12)).foregroundStyle(Theme.orange)
        case .stopped:
            Image(systemName: "clock.badge.xmark").font(.system(size: 12)).foregroundStyle(Theme.faint)
        }
    }

    /// Moves the row to "Settled"; you keep watching it if you were (it is opened from there).
    private func settle() {
        bot.settleSubagent(subagent.id)
    }
}

/// Right column, "Settled": the subagents you settled out of the left column. Click one to
/// watch its conversation; the arrow brings it back to the left column.
struct SettledList: View {
    @ObservedObject var bot: Bot
    @ObservedObject var workspace: Workspace
    @State private var showsAll = false
    static let shownAtMost = 5

    var body: some View {
        let settled = bot.trace.settled
        let more = max(0, settled.count - Self.shownAtMost)
        VStack(spacing: 4) {
            ForEach(showsAll ? settled : Array(settled.prefix(Self.shownAtMost))) { subagent in
                row(subagent)
            }
            if more > 0 {
                Button { showsAll.toggle() } label: {
                    Text(showsAll ? L("Show less") : L("Show {0} more", more))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 14)
                        .frame(height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsAll ? L("Show fewer settled subagents") : L("Show {0} more settled subagents", more))
            }
        }
    }

    private func row(_ subagent: Subagent) -> some View {
        let selected = workspace.selectedBot === bot && workspace.viewingSubagent == subagent.id
        return HStack(spacing: 0) {
            Button { workspace.view(subagent: subagent.id, of: bot) } label: {
                HStack(spacing: 10) {
                    SubagentRows.mark(subagent.mark).frame(width: 10)
                    Text(subagent.description.isEmpty ? L("Subagent") : subagent.description)
                        .font(.system(size: 13))
                        .foregroundStyle(subagent.isRunning ? Theme.text : Theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                }
                .padding(.leading, 14)
                .frame(height: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(subagent.prompt)
            .accessibilityLabel(L("Settled subagent: {0}, {1}", subagent.description, subagent.status.rawValue))
            Button { bot.unsettleSubagent(subagent.id) } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                    .frame(width: 32, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L("Back to the left column"))
            .accessibilityLabel(L("Bring {0} back to the left column", subagent.description))
            .padding(.trailing, 4)
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.selected : Theme.bubble))
        .contextMenu {
            Button(L("Back to the Left Column")) { bot.unsettleSubagent(subagent.id) }
        }
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
                    .padding(20)
                    .padding(.top, 16)
            } else if showingSettings {
                SettingsPage(bot: bot) { showingSettings = false }
                    .padding(20)
                    .padding(.top, 16)
            } else {
                // It scrolls: the main bot's "Waiting on you" gathers every bot's questions, and
                // a long list must not make the panel taller than the window.
                ScrollView {
                    overview
                        .padding(20)
                        .padding(.top, 16)
                }
                .scrollIndicators(.never)
            }
        }
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
            .accessibilityLabel(L("More panels"))
        }
    }

    private func panelPage(_ key: String) -> some View {
        let title = plugins.panels().first { "\($0.plugin.name)/\($0.panel.id)" == key }?.panel.title ?? L("Panel")
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 4) {
                Button { openPanel = nil } label: {
                    Image(systemName: "chevron.left")
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Back"))
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
                if bot.profile.capabilities.settings {
                    Button { showingSettings = true } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 40, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Settings"))
                }
            }

            PanelSection(L("Now")) {
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
                       let doing = MemoryFile.items(at: bot.profile.memoryURL, section: .inProgress).first {
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
                                    Text(L("{0} min", max(1, Int(context.date.timeIntervalSince(run.startedAt) / 60))))
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
                PanelSection(L("Waiting on you")) {
                    WaitingList(workspace: workspace, items: workspace.waiting)
                }
            }

            let results = Array(bot.results.prefix(3))
            if !results.isEmpty {
                PanelSection(bot.profile.role == .main ? L("Just done") : L("Results")) {
                    VStack(spacing: 6) {
                        ForEach(results, id: \.self) { chip in
                            Button { ResultWindows.open(chip) } label: {
                                HStack {
                                    Text(chip.label).lineLimit(1)
                                    Spacer()
                                    Image(systemName: ArtifactLink.isArtifact(chip.url) ? "safari" : "arrow.up.right").font(.system(size: 12)).foregroundStyle(Theme.faint)
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

            if !bot.trace.settled.isEmpty {
                PanelSection(L("Settled")) {
                    SettledList(bot: bot, workspace: workspace)
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
            .accessibilityLabel(L("Falls asleep in {0} min {1} s", seconds / 60, seconds % 60))
        }
    }
}

/// One bot's settings: its model, routines and the tools it may use. ClaudeCodeBot's own are
/// in the settings window (`SettingsWindow`).
struct SettingsPage: View {
    @ObservedObject var bot: Bot
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
                .accessibilityLabel(L("Back"))
                Text(L("Settings")).font(.system(size: 15, weight: .semibold))
            }

            PanelSection(L("Model and thinking")) {
                VStack(spacing: 0) {
                    DropdownRow(
                        title: L("Engine"),
                        choices: BotEngine.allCases,
                        chosen: bot.engine,
                        label: { $0.displayName },
                        disabled: bot.isSwitching
                    ) { engine in
                        Task { await bot.switchEngine(to: engine) }
                    }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    DropdownRow(
                        title: L("Model"),
                        choices: BotModel.allCases,
                        chosen: bot.switchTarget ?? bot.model,
                        label: { $0.displayName },
                        disabled: bot.isSwitching || bot.engine == .codex
                    ) { model in
                        Task { await bot.switchModel(to: model) }
                    }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    DropdownRow(
                        title: L("Subagent model"),
                        choices: [nil] + BotModel.allCases.map(Optional.some),
                        chosen: bot.subagentModel,
                        label: { $0?.displayName ?? L("Same as bot") },
                        disabled: bot.isSwitching || bot.engine == .codex
                    ) { model in
                        Task { await bot.setSubagentModel(model) }
                    }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    DropdownRow(
                        title: L("Thinking effort"),
                        choices: [nil] + EffortLevel.allCases.map(Optional.some),
                        chosen: bot.effort,
                        label: { $0?.displayName ?? L("Default") },
                        disabled: bot.isSwitching
                    ) { level in
                        Task { await bot.setEffort(level) }
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

                SettingNote(L("Subagents use their own model and effort when their definition names one. Default effort leaves it to the model. Awake, a change restarts the bot in the same conversation just before its next message; asleep, it applies when it wakes."))
                if bot.engine == .codex {
                    SettingNote(L("On Codex the bot uses Codex's own model, asks before commands outside its folders, and keeps results as local pages. Both engines share its memory.md: switching hands over through it."))
                }
            }

            PanelSection(L("Routines")) {
                VStack(spacing: 6) {
                    ForEach(bot.routines) { routine in
                        RoutineRow(bot: bot, routine: routine)
                    }
                    if adding {
                        AddRoutineForm(bot: bot) { adding = false }
                    } else {
                        Button { adding = true } label: {
                            Label(L("Add one"), systemImage: "plus")
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
                PanelSection(L("Always allowed")) {
                    VStack(spacing: 0) {
                        ForEach(bot.alwaysAllowed, id: \.self) { tool in
                            HStack {
                                Text(tool).font(.system(size: 14))
                                Spacer()
                                Button(L("Ask again")) { bot.forget(alwaysAllowed: tool) }
                                    .buttonStyle(.plain)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.muted)
                            }
                            .padding(.horizontal, 16)
                            .frame(height: 44)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubble))
                    .help(L("Tools you let this bot use without asking. Takes effect the next time it wakes."))
                }
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
        case .writing: L("Writing handoff")
        case .stopping: L("Stopping {0}", bot.model.displayName)
        case .starting: L("Starting {0}", (bot.switchTarget ?? bot.model).displayName)
        }
    }
}

/// One setting in a card: its name on the left, a pop-up menu of the choices on the right.
private struct DropdownRow<Choice: Hashable>: View {
    let title: String
    let choices: [Choice]
    let chosen: Choice
    let label: (Choice) -> String
    var disabled = false
    let pick: (Choice) -> Void

    var body: some View {
        HStack {
            Text(title).foregroundStyle(Theme.text)
            Spacer()
            Picker(title, selection: Binding(get: { chosen }, set: { if $0 != chosen { pick($0) } })) {
                ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                    Text(label(choice)).tag(choice)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .fixedSize()
            .disabled(disabled)
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .frame(height: 44)
    }
}

/// A line under a setting saying what it does and when it takes effect.
private struct SettingNote: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(Theme.faint)
            .fixedSize(horizontal: false, vertical: true)
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
                if let time = routine.schedule.everyDayTime {
                    DatePicker(L("Time"), selection: binding(hour: time.hour, minute: time.minute), displayedComponents: .hourAndMinute)
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
            Button(L("Delete"), role: .destructive) { bot.removeRoutine(routine.id) }
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
            TextField(L("Name, e.g. Check progress"), text: $title)
            TextField(L("What to do (one sentence, or @file)"), text: $instruction, axis: .vertical)
                .lineLimit(1...3)
            HStack {
                DatePicker(L("Every day"), selection: $time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.field)
                    .fixedSize()
                Spacer()
                Button(L("Cancel"), action: done).buttonStyle(.plain).foregroundStyle(Theme.muted)
                Button(L("Add")) {
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

struct PanelSection<Content: View>: View {
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

