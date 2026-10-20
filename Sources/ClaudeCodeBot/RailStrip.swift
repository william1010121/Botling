import ClaudeCodeBotCore
import SwiftUI

/// The face the pointer rests on in the folded column: its name and status, drawn beside it
/// over the chat (so it is not clipped by the 56-point column).
struct RailTip: Equatable {
    var title: String
    var detail: String
    /// The face's middle, in `RailTip.space`.
    var midY: CGFloat

    /// The coordinate space the window's root view names, where the tip is drawn.
    static let space = "rail-root"
}

struct RailTipView: View {
    let tip: RailTip

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(tip.title).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.text)
            Text(tip.detail).font(.system(size: 11)).foregroundStyle(Theme.muted)
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.userBubble))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.tipLine, lineWidth: 1))
        .shadow(color: .black.opacity(0.5), radius: 11, y: 8)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// What the window draws over everything at its top left: the fold button beside the lights,
/// and the folded strip's hover tip just right of the strip.
struct RailChrome: View {
    let collapsed: Bool
    let tip: RailTip?
    let toggle: () -> Void

    var body: some View {
        RailToggle(collapsed: collapsed, action: toggle)
            .padding(.leading, 78)
            .padding(.top, 5)
            // Its own overlay, so centering the tip on the face does not move the button.
            .overlay(alignment: .topLeading) {
                if collapsed, let tip {
                    RailTipView(tip: tip)
                        .alignmentGuide(.top) { $0.height / 2 }
                        .alignmentGuide(.leading) { _ in 0 }
                        .offset(x: RailLayout.collapsedWidth + 4, y: tip.midY)
                        .transition(.opacity)
                }
            }
    }
}

/// The button by the window's lights that folds the left column into a strip of faces and
/// opens it again (also ⌃⌘S). It stays in the same place either way.
struct RailToggle: View {
    let collapsed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 13))
                .foregroundStyle(collapsed ? Theme.muted : Theme.text)
                .frame(width: 28, height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(collapsed ? .clear : Theme.selected))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut("s", modifiers: [.control, .command])
        .help(collapsed ? "Expand sidebar (⌃⌘S)" : "Collapse sidebar (⌃⌘S)")
        .accessibilityLabel(collapsed ? "Expand sidebar" : "Collapse sidebar")
    }
}

/// The left column folded: only faces. A dashed blue ring while one works, an orange ring
/// and "!" when its connection is stuck, an orange dot when it waits on you, a blue dot when
/// it has lines you have not read, a dimmed face while it sleeps. Hover for name and status.
struct RailStrip: View {
    @ObservedObject var workspace: Workspace
    /// The pinned ones first (`pinnedCount` of them), then the rest.
    let entries: [RailView.Entry]
    var pinnedCount = 0
    @Binding var tip: RailTip?
    @Binding var showingQuickSettings: Bool
    let addProject: () -> Void
    let newBot: () -> Void
    let newGroup: () -> Void
    let editGroup: (ChatGroup) -> Void
    let deleteGroup: (ChatGroup) -> Void
    let removeBot: (Workspace.Project) -> Void
    let openSettings: (SettingsSection?) -> Void

    private func waiting(_ id: UUID) -> Bool { workspace.waiting.contains { $0.projectID == id } }

    var body: some View {
        VStack(spacing: 4) {
            BotIcon(bot: workspace.mainBot, selected: workspace.selection == nil, waiting: waiting(Workspace.mainBotID), tip: $tip) {
                workspace.select(nil)
            }
            if showsMaintainer {
                BotIcon(
                    bot: workspace.maintainer,
                    kind: .diamond,
                    selected: workspace.selection == Workspace.maintainerID,
                    waiting: waiting(Workspace.maintainerID),
                    busy: !workspace.components.working.isEmpty,
                    status: maintainerStatus,
                    tip: $tip
                ) {
                    workspace.select(Workspace.maintainerID)
                }
            }
            BotIcon(
                bot: workspace.codexBot,
                kind: .codex,
                selected: workspace.selection == Workspace.codexID,
                waiting: false,
                busy: workspace.codexIsReviewing,
                status: workspace.codexIsReviewing ? "Reviewing" : "Read-only reviewer",
                tip: $tip
            ) {
                workspace.select(Workspace.codexID)
            }

            Rectangle().fill(Theme.chip).frame(width: 28, height: 1).padding(.vertical, 4)

            ScrollView {
                VStack(spacing: 4) {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        // A short line between the pinned faces and the rest.
                        if index == pinnedCount, pinnedCount > 0 {
                            Rectangle().fill(Theme.chip).frame(width: 16, height: 1).padding(.vertical, 3)
                        }
                        switch entry.kind {
                        case .group(let group, let chat):
                            GroupIcon(group: group, chat: chat, workspace: workspace, selected: workspace.selection == group.id, tip: $tip) {
                                workspace.select(group.id)
                            }
                            .contextMenu {
                                Button("Edit group…") { editGroup(group) }
                                Button("Delete group…", role: .destructive) { deleteGroup(group) }
                            }
                        case .project(let project, let bot):
                            BotIcon(bot: bot, selected: workspace.selection == project.id, waiting: waiting(project.id), tip: $tip) {
                                workspace.select(project.id)
                            }
                            .contextMenu {
                                Button(workspace.isPinned(project.id) ? "Unpin" : "Pin") { workspace.togglePin(project.id) }
                                if project.isBot {
                                    Divider()
                                    Button("Remove bot…", role: .destructive) { removeBot(project) }
                                }
                            }
                        }
                    }
                }
                // Room for the blue bar beside the chosen face.
                .frame(width: RailLayout.collapsedWidth)
                .animation(.easeInOut(duration: 0.25), value: entries.map(\.id))
            }
            .scrollIndicators(.never)

            Menu {
                Button("Add project…", action: addProject)
                Button("New bot…", action: newBot)
                Button("New group…", action: newGroup)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.faint)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Add a project, a bot or a group")
            .accessibilityLabel("Add project, bot or group")

            Button { showingQuickSettings.toggle() } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 14))
                    .foregroundStyle(showingQuickSettings ? Theme.text : Theme.faint)
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 8).fill(showingQuickSettings ? Theme.selected : .clear))
                    .overlay(alignment: .topTrailing) { DoctorDot(model: workspace.doctor) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Settings: today's cost, auto-approve, plugins")
            .accessibilityLabel("Settings")
            .popover(isPresented: $showingQuickSettings, arrowEdge: .trailing) {
                SettingsPopover(workspace: workspace, registry: workspace.plugins, open: openSettings)
            }
        }
        .frame(width: RailLayout.collapsedWidth)
        .padding(.top, 36)
        .padding(.bottom, 12)
    }

    /// As in the open column: Maintainer is listed while it is up to something or has news.
    private var showsMaintainer: Bool {
        let bot = workspace.maintainer
        return workspace.selection == Workspace.maintainerID || bot.isWorking || !workspace.components.working.isEmpty
            || bot.phase != .asleep || bot.hasUnread || waiting(Workspace.maintainerID)
    }

    private var maintainerStatus: String {
        if let (name, change) = workspace.components.working.first { return "Component \(name): \(change)" }
        let bot = workspace.maintainer
        if bot.isWorking { return "Working" }
        return bot.hasUnread ? "Done, click to see" : bot.statusText
    }
}

/// One bot's face in the strip.
private struct BotIcon: View {
    @ObservedObject var bot: Bot
    var kind: AvatarKind?
    let selected: Bool
    let waiting: Bool
    /// Working on something the bot's own turn does not show (a component, a review).
    var busy = false
    /// Said instead of the bot's own status.
    var status: String?
    @Binding var tip: RailTip?
    let action: () -> Void

    var body: some View {
        let working = busy || bot.isWorking
        RailIcon(
            title: bot.name,
            detail: RailLayout.tipDetail(status: status ?? bot.statusText, unread: selected ? 0 : bot.unreadCount, waiting: waiting),
            selected: selected,
            asleep: bot.phase == .asleep && !working,
            running: working,
            stuck: bot.outage != nil || bot.retryingConnection,
            waiting: waiting,
            unread: bot.hasUnread && !selected,
            tip: $tip,
            action: action
        ) {
            AvatarView(kind: kind ?? bot.avatarKind, size: 28, eyes: working ? .open : bot.eyes)
        }
    }
}

/// A group's face in the strip.
private struct GroupIcon: View {
    let group: ChatGroup
    @ObservedObject var chat: Bot
    @ObservedObject var workspace: Workspace
    let selected: Bool
    @Binding var tip: RailTip?
    let action: () -> Void

    var body: some View {
        let speaker = workspace.groupSpeakers[group.id].flatMap(workspace.speakerName(for:))
        let question = workspace.groupHasQuestion(group.id)
        RailIcon(
            title: group.name,
            detail: RailLayout.tipDetail(
                status: speaker.map { "\($0) is writing…" } ?? workspace.members(of: group).map(\.name).joined(separator: ", "),
                unread: selected ? 0 : chat.unreadCount,
                waiting: question
            ),
            selected: selected,
            asleep: false,
            running: speaker != nil,
            stuck: false,
            waiting: question,
            unread: chat.hasUnread && !selected,
            tip: $tip,
            action: action
        ) {
            Image(systemName: "person.3.fill")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Theme.chip))
        }
    }
}

/// A 40-point cell: the face, its ring and its dot, a blue bar at the column's edge when it is
/// the open chat.
private struct RailIcon<Face: View>: View {
    let title: String
    let detail: String
    let selected: Bool
    let asleep: Bool
    let running: Bool
    let stuck: Bool
    let waiting: Bool
    let unread: Bool
    @Binding var tip: RailTip?
    let action: () -> Void
    @ViewBuilder let face: () -> Face

    @State private var hovering = false
    @State private var midY: CGFloat = 0

    var body: some View {
        Button(action: action) {
            ZStack {
                face().opacity(asleep ? 0.5 : 1)
                if stuck {
                    RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.orange, lineWidth: 1.5).padding(3)
                } else if running {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(Theme.blue, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        .padding(3)
                }
            }
            .frame(width: 40, height: 40)
            .background(RoundedRectangle(cornerRadius: 10).fill(selected ? Theme.selected : hovering ? Theme.hover : .clear))
            .overlay(alignment: .topTrailing) {
                if waiting || unread {
                    Circle()
                        .fill(waiting ? Theme.orange : Theme.blue)
                        .frame(width: 9, height: 9)
                        .padding(2)
                        .background(Circle().fill(Theme.side))
                        .padding(1)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if stuck {
                    Text("!")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(Theme.side)
                        .frame(width: 14, height: 14)
                        .background(Circle().fill(Theme.orange))
                        .padding(2)
                        .background(Circle().fill(Theme.side))
                        .offset(x: 1, y: 1)
                }
            }
            .overlay(alignment: .leading) {
                if selected {
                    Capsule().fill(Theme.blue).frame(width: 3, height: 20).offset(x: -8)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(RailTip.space)).midY } action: { midY = $0 }
        .onHover { inside in
            hovering = inside
            if inside {
                tip = RailTip(title: title, detail: detail, midY: midY)
            } else if tip?.title == title {
                tip = nil
            }
        }
        .onChange(of: detail) { _, detail in
            if hovering { tip = RailTip(title: title, detail: detail, midY: midY) }
        }
        .accessibilityLabel("\(title), \(detail)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
