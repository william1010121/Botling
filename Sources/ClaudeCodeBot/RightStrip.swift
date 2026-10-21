import ClaudeCodeBotCore
import SwiftUI

/// The face the pointer rests on in the folded right panel: the bot's name and what its Now
/// card says, drawn left of the strip over the chat.
struct RightTip: Equatable {
    var title: String
    var detail: String
    var color: Color
    /// The face's middle, in `RailTip.space`.
    var midY: CGFloat
}

struct RightTipView: View {
    let tip: RightTip

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(tip.color).frame(width: 7, height: 7)
                Text(tip.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
            }
            Text(tip.detail)
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: 260, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.userBubble))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.tipLine, lineWidth: 1))
        .shadow(color: .black.opacity(0.5), radius: 11, y: 8)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// What the window draws over everything at its top right: the button that folds the right
/// panel, and the folded strip's hover tip just left of the strip.
struct RightChrome: View {
    let collapsed: Bool
    let tip: RightTip?
    let toggle: () -> Void

    var body: some View {
        RightToggle(collapsed: collapsed, action: toggle)
            .padding(.trailing, 14)
            .padding(.top, 5)
            .overlay(alignment: .topTrailing) {
                if collapsed, let tip {
                    RightTipView(tip: tip)
                        .alignmentGuide(.top) { $0.height / 2 }
                        .alignmentGuide(.trailing) { $0.width }
                        .offset(x: -(RightPanelLayout.collapsedWidth + 4), y: tip.midY)
                        .transition(.opacity)
                }
            }
    }
}

/// The button at the window's top right that folds the right panel into a strip of icons and
/// opens it again (also ⌃⌘I); the mirror of the one by the lights.
struct RightToggle: View {
    let collapsed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "sidebar.right")
                .font(.system(size: 13))
                .foregroundStyle(collapsed ? Theme.muted : Theme.text)
                .frame(width: 28, height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(collapsed ? .clear : Theme.selected))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut("i", modifiers: [.control, .command])
        .help(collapsed ? "Show right panel (⌃⌘I)" : "Hide right panel (⌃⌘I)")
        .accessibilityLabel(collapsed ? "Show right panel" : "Hide right panel")
    }
}

/// The right panel folded: the bot's face with its status dot (hover for the Now card), an
/// icon per section the open panel would show (with a count), and the bot's settings at the
/// bottom. An icon opens its section in a popover beside the strip; the chat does not move.
struct RightStrip: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    /// The group whose chat `bot` is, if it is one.
    let group: ChatGroup?
    @Binding var tip: RightTip?
    /// Opens the panel (the face).
    let expand: () -> Void
    /// Opens the panel on the bot's settings (the bottom button).
    let openSettings: () -> Void

    @State private var open: RightPanelLayout.Section?

    private var isCodex: Bool { bot === workspace.codexBot }
    private var canReview: Bool { !isCodex && bot.profile.role == .manager && !bot.profile.isStandalone }

    private var waiting: [Workspace.Waiting] {
        if let group { return workspace.waiting.filter { $0.groupID == group.id } }
        return bot.profile.role == .main ? workspace.waiting : []
    }

    private var items: [RightPanelLayout.Item] {
        RightPanelLayout.items(
            waiting: waiting.count,
            members: group.map { workspace.members(of: $0).count },
            showsCodex: group == nil && (isCodex || canReview || !workspace.codexReviews(for: bot).isEmpty),
            results: bot.results.count,
            settled: group == nil ? bot.trace.settled.count : 0
        )
    }

    var body: some View {
        VStack(spacing: 6) {
            face
            Rectangle().fill(Theme.chip).frame(width: 28, height: 1).padding(.vertical, 4)
            ForEach(items, id: \.section) { item in
                icon(item)
            }
            Spacer(minLength: 0)
            if group == nil, !isCodex {
                Button(action: openSettings) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("\(bot.name)'s settings")
                .accessibilityLabel("Bot settings")
            }
        }
        .frame(width: RightPanelLayout.collapsedWidth)
        .padding(.top, 36)
        .padding(.bottom, 12)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
        .onDisappear { tip = nil }
    }

    // MARK: The face

    private var face: some View {
        StripFace(title: group?.name ?? bot.name, detail: faceDetail, color: group == nil ? bot.statusColor : faceColor, tip: $tip, action: expand) {
            if group != nil {
                Image(systemName: "person.3.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Theme.chip))
            } else {
                AvatarView(kind: isCodex ? .codex : bot.avatarKind, size: 26, eyes: bot.isWorking ? .open : bot.eyes)
            }
        }
    }

    private var faceColor: Color {
        guard let group else { return bot.statusColor }
        return workspace.groupSpeakers[group.id] != nil ? Theme.blue : Theme.green
    }

    /// What the open panel's Now card (or a group's member list) says.
    private var faceDetail: String {
        if let group {
            let speaker = workspace.groupSpeakers[group.id].flatMap(workspace.speakerName(for:))
            return speaker.map { "\($0) is writing…" } ?? workspace.members(of: group).map(\.name).joined(separator: ", ")
        }
        let doing = bot.profile.role == .manager
            ? MemoryFile.items(at: bot.profile.memoryURL, section: "In progress").first
            : bot.profile.role == .main ? workspace.runningTeams.map(\.spec.title).first : nil
        return RightPanelLayout.nowDetail(status: bot.statusText, doing: doing)
    }

    // MARK: Section icons

    private func icon(_ item: RightPanelLayout.Item) -> some View {
        let shown = Binding(get: { open == item.section }, set: { if !$0, open == item.section { open = nil } })
        return Button { open = open == item.section ? nil : item.section } label: {
            Image(systemName: Self.symbol(item.section))
                .font(.system(size: 15))
                .foregroundStyle(open == item.section ? Theme.text : item.section == .waiting ? Theme.orange : Theme.muted)
                .frame(width: 40, height: 40)
                .background(RoundedRectangle(cornerRadius: 10).fill(open == item.section ? Theme.selected : .clear))
                .overlay(alignment: .topTrailing) {
                    if let badge = item.badge {
                        Text(badge)
                            .font(.system(size: 10, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(item.section == .waiting ? Theme.side : Theme.text)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 16, minHeight: 15)
                            .background(Capsule().fill(item.section == .waiting ? Theme.orange : Theme.chip))
                            .overlay(Capsule().stroke(Theme.side, lineWidth: 1))
                            .offset(x: 2, y: -1)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(title(item.section))
        .accessibilityLabel(item.badge.map { "\(title(item.section)), \($0)" } ?? title(item.section))
        .popover(isPresented: shown, arrowEdge: .leading) {
            StripFlyout(title: title(item.section)) {
                section(item.section)
            }
        }
    }

    static func symbol(_ section: RightPanelLayout.Section) -> String {
        switch section {
        case .waiting: "exclamationmark.bubble"
        case .members: "person.2"
        case .codex: "magnifyingglass"
        case .results: "arrow.up.right"
        case .settled: "checkmark.circle"
        }
    }

    /// The open panel's heading for the section.
    private func title(_ section: RightPanelLayout.Section) -> String {
        switch section {
        case .waiting: "Waiting on you"
        case .members: "In the group"
        case .codex: isCodex ? "Reviews" : "Codex review"
        case .results: bot.profile.role == .main || group != nil ? "Just done" : "Results"
        case .settled: "Settled"
        }
    }

    @ViewBuilder private func section(_ section: RightPanelLayout.Section) -> some View {
        switch section {
        case .waiting:
            WaitingList(workspace: workspace, items: waiting)
        case .members:
            if let group {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(workspace.members(of: group), id: \.id) { member in
                        GroupMemberRow(
                            bot: member.bot,
                            kind: workspace.avatar(for: member.id) ?? .circle,
                            writing: workspace.groupSpeakers[group.id] == member.id
                        ) {
                            open = nil
                            workspace.select(member.id == Workspace.mainBotID ? nil : member.id)
                        }
                    }
                }
            }
        case .codex:
            VStack(spacing: 6) {
                let reviews = workspace.codexReviews(for: bot)
                ForEach(reviews.prefix(isCodex ? 12 : 3)) { review in
                    CodexReviewCard(review: review, showsOwner: isCodex ? workspace.speakerName(for: review.ownerID) : nil) {
                        open = nil
                        CodexReportWindows.open(review.id, title: review.title, workspace: workspace)
                    }
                }
                if canReview {
                    let running = reviews.contains { $0.kind == .single && $0.state == .reviewing }
                    CodexReviewButton(workspace: workspace, bot: bot, running: running) { id in
                        open = nil
                        CodexReportWindows.open(id, title: "Codex review", workspace: workspace)
                    }
                }
                if reviews.isEmpty, !canReview {
                    Text("Nothing reviewed yet.").font(.system(size: 13)).foregroundStyle(Theme.faint)
                }
            }
        case .results:
            VStack(spacing: 6) {
                ForEach(bot.results.prefix(12), id: \.self) { chip in
                    Button {
                        open = nil
                        ResultWindows.open(chip)
                    } label: {
                        HStack {
                            Text(chip.label).fontWeight(.semibold).lineLimit(1)
                            Spacer()
                            Image(systemName: ArtifactLink.isArtifact(chip.url) ? "safari" : "arrow.up.right").font(.system(size: 12)).foregroundStyle(Theme.faint)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.selected))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        case .settled:
            SettledList(bot: bot, workspace: workspace)
        }
    }
}

/// A section popped out beside the strip: its heading, then the section, scrolling when long.
private struct StripFlyout<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.system(size: 12)).foregroundStyle(Theme.faint)
                Spacer()
                Text("Esc to close").font(.system(size: 11)).foregroundStyle(Theme.faint)
            }
            ViewThatFits(in: .vertical) {
                content()
                ScrollView { content() }.scrollIndicators(.never)
            }
        }
        .padding(12)
        .frame(width: 300)
        .frame(maxHeight: 520)
        .foregroundStyle(Theme.text)
        .background(Theme.bubble)
        .preferredColorScheme(.dark)
    }
}

/// The face at the top of the strip, with its status dot; hovering shows the Now card as a tip.
private struct StripFace<Face: View>: View {
    let title: String
    let detail: String
    let color: Color
    @Binding var tip: RightTip?
    let action: () -> Void
    @ViewBuilder let face: () -> Face

    @State private var hovering = false
    @State private var midY: CGFloat = 0

    var body: some View {
        Button(action: action) {
            face()
                .frame(width: 40, height: 40)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.selected))
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(color)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Theme.selected, lineWidth: 2))
                        .offset(x: -3, y: -3)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(RailTip.space)).midY } action: { midY = $0 }
        .onHover { inside in
            hovering = inside
            if inside {
                tip = RightTip(title: title, detail: detail, color: color, midY: midY)
            } else if tip?.title == title {
                tip = nil
            }
        }
        .onChange(of: detail) { _, detail in
            if hovering { tip = RightTip(title: title, detail: detail, color: color, midY: midY) }
        }
        .accessibilityLabel("\(title), \(detail). Show the panel")
    }
}
