import ClaudeCodeBotCore
import SwiftUI

/// The colors of a task's state and of its owner head, as the chat's chips use them.
enum TaskLook {
    static let running = Color(hex: 0x4C8DFF)
    static let waiting = Color(hex: 0xF7C27F)
    static let done = Color(hex: 0x4CC38A)
    static let stale = Color(hex: 0xFF8A80)
    static let pending = Color(hex: 0x8E8E96)
    static let link = Color(hex: 0x8DB5FF)

    static func color(_ state: TaskCard.State, stale: Bool) -> Color {
        if stale { return Self.stale }
        return switch state {
        case .running: running
        case .waiting: waiting
        case .done: done
        case .pending, .stopped: pending
        }
    }

    static func head(_ engine: BotEngine) -> Color {
        engine == .claude ? Color(hex: 0xD97757) : Color(hex: 0x6E9BFF)
    }

    /// "00:24" today, "Yesterday", else the short date.
    static func time(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(date) { return L("Yesterday") }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

/// The right panel's Tasks (the design's 任務, in place of "Now"): the bot's state on one line,
/// then each task under way, the open one (pressed, else the latest running) with what it does
/// now, what comes next and what blocks it.
struct TaskSection: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    @Environment(\.botLook) private var look

    /// The most tasks listed; the rest are older.
    static let shown = 6

    var body: some View {
        // Maybe-stuck turns on by itself after 10 minutes: the list looks again now and then.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = context.date
            let active = Self.active(bot.tasks)
            let open = Self.open(in: bot.tasks, selected: workspace.selectedTask)
            VStack(alignment: .leading, spacing: 8) {
                statusLine
                // A finished task pressed (in Just done, a summary) shows open on top.
                if let open, !active.contains(where: { $0.id == open.id }) {
                    TaskCardView(workspace: workspace, bot: bot, task: open, now: now)
                }
                ForEach(active.prefix(Self.shown)) { task in
                    if task.id == open?.id {
                        TaskCardView(workspace: workspace, bot: bot, task: task, now: now)
                    } else {
                        TaskRowView(workspace: workspace, bot: bot, task: task, now: now)
                    }
                }
                if active.isEmpty {
                    // A manager without tasks yet: the first thing under "In progress" in its memory.md.
                    if bot.profile.role == .manager,
                       let doing = MemoryFile.items(at: bot.profile.memoryURL, section: .inProgress).first {
                        Text(doing).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2)
                    } else {
                        Text(L("Nothing under way")).font(.system(size: 13)).foregroundStyle(Theme.faint)
                    }
                }
            }
        }
    }

    /// The bot's own state (asleep, working…), its heads and the main bot's temporary teams.
    @ViewBuilder private var statusLine: some View {
        HStack(spacing: 8) {
            Circle().fill(bot.statusColor).frame(width: 7, height: 7)
            Text(bot.statusText).font(.system(size: 12)).foregroundStyle(Theme.muted)
            Spacer()
            if let sleepsAt = bot.sleepsAt {
                SleepCountdown(until: sleepsAt)
            }
        }
        .frame(minHeight: 20)
        if look == .cute || bot.heads.hasTwo {
            HeadsNow(bot: bot)
        }
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

    /// Tasks under way: running (and just sent) first, newest first, then those waiting on you.
    static func active(_ tasks: [TaskCard]) -> [TaskCard] {
        tasks.filter(\.state.isActive).sorted { a, b in
            let ra = a.state == .waiting ? 1 : 0, rb = b.state == .waiting ? 1 : 0
            return ra != rb ? ra < rb : a.updatedAt > b.updatedAt
        }
    }

    /// The task shown open: the one pressed, else the latest running one.
    static func open(in tasks: [TaskCard], selected: UUID?) -> TaskCard? {
        if let selected, let task = tasks.first(where: { $0.id == selected }) { return task }
        return tasks.filter { $0.state == .running }.max { $0.updatedAt < $1.updatedAt }
    }
}

/// A task's top line: its state dot, its name and the head that owns it.
private struct TaskHeader: View {
    let task: TaskCard
    let color: Color
    let bold: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(task.name)
                .font(.system(size: 14, weight: bold ? .semibold : .regular))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if task.state == .pending {
                Text(L("Claiming…")).font(.system(size: 11)).foregroundStyle(Theme.faint)
            } else if let owner = task.owner {
                HStack(spacing: 4) {
                    Circle().fill(TaskLook.head(owner)).frame(width: 7, height: 7)
                    Text(owner.displayName).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
            }
        }
    }
}

/// "In the summary": every reply of the task is folded into a summary card.
private struct SummaryTag: View {
    var body: some View {
        Text(L("In the summary"))
            .font(.system(size: 11))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 1)
            .background(Capsule().fill(Theme.chip))
    }
}

/// A task not open: one line on how it stands. Pressed, it opens.
struct TaskRowView: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    let task: TaskCard
    let now: Date

    var body: some View {
        let stale = bot.isStale(task, at: now)
        Button { workspace.selectTask(task.id) } label: {
            VStack(alignment: .leading, spacing: 2) {
                TaskHeader(task: task, color: TaskLook.color(task.state, stale: stale), bold: false)
                Text(Self.line(task, stale: stale, now: now))
                    .font(.system(size: 12))
                    .foregroundStyle(stale ? TaskLook.stale : task.state == .waiting ? TaskLook.waiting : Theme.muted)
                    .lineLimit(2)
                    .padding(.leading, 16)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("Task {0}: {1}", task.name, Self.line(task, stale: stale, now: now)))
    }

    /// How it stands, in a line.
    static func line(_ task: TaskCard, stale: Bool, now: Date) -> String {
        if stale { return L("May be stuck") + " · " + L("No news for {0} min", Int(now.timeIntervalSince(task.updatedAt) / 60)) }
        switch task.state {
        case .pending: return L("New message · waiting for a head")
        case .waiting: return L("Waiting on you: {0}", task.blocked ?? task.now ?? L("your reply"))
        case .running: return task.now.map { L("Now: {0}", $0) } ?? L("Running")
        case .done: return L("Done")
        case .stopped: return L("Stopped")
        }
    }
}

/// The open task: what it does now, what comes next and what blocks it, who helps, when it
/// started and changed, and the way to its latest line in the chat.
struct TaskCardView: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    let task: TaskCard
    let now: Date

    var body: some View {
        let stale = bot.isStale(task, at: now)
        let color = TaskLook.color(task.state, stale: stale)
        VStack(alignment: .leading, spacing: 6) {
            Button { workspace.selectTask(task.id) } label: {
                TaskHeader(task: task, color: color, bold: true).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L("Close"))
            Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                field(L("Now"), task.now ?? (task.state == .pending ? L("New message · waiting for a head") : nil))
                field(L("Next"), task.next)
                field(L("Blocked"), task.blocked, color: task.state == .waiting ? TaskLook.waiting : Theme.text)
            }
            .font(.system(size: 12.5))
            ForEach(task.helps ?? [], id: \.handoffID) { help in
                Text(L("{0} helping: {1}", help.head.displayName, help.text))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
            }
            let folded = workspace.isFoldedIntoSummary(task, in: bot)
            if stale || folded {
                HStack(spacing: 8) {
                    if folded { SummaryTag() }
                    if stale {
                        Text(L("May be stuck")).font(.system(size: 12)).foregroundStyle(TaskLook.stale)
                        Spacer()
                        Button(L("Ask it to report")) { bot.askForReport(on: task.id) }
                            .buttonStyle(.plain)
                            .font(.system(size: 12.5))
                            .padding(.horizontal, 10)
                            .frame(height: 28)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.chip))
                    }
                }
            }
            HStack {
                Text(L("Started {0} · updated {1}", TaskLook.time(task.createdAt, now: now), TaskLook.time(task.updatedAt, now: now)))
                    .monospacedDigit()
                Spacer()
                if let message = task.latestMessage(in: bot.messages) {
                    Button(L("Jump to chat ↗")) {
                        NotificationCenter.default.post(name: .jumpToTask, object: nil, userInfo: ["bot": bot.id, "message": message, "task": task.id])
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(TaskLook.link)
                }
            }
            .font(.system(size: 12))
            .foregroundStyle(Theme.faint)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(task.state.isActive ? color : Theme.line))
    }

    private func field(_ label: String, _ value: String?, color: Color = Theme.text) -> some View {
        GridRow {
            Text(label).foregroundStyle(Theme.faint).frame(width: 48, alignment: .leading)
            Text(value ?? "—").foregroundStyle(value == nil ? Theme.faint : color).lineLimit(3)
        }
    }
}

/// Waiting on you: the tasks that need you, each opening its card.
struct WaitingTaskRows: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot

    var body: some View {
        VStack(spacing: 6) {
            ForEach(bot.tasks.filter { $0.state == .waiting }) { task in
                Button { workspace.selectTask(task.id) } label: {
                    HStack(spacing: 10) {
                        Circle().fill(TaskLook.waiting).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(task.name).lineLimit(1)
                            Text(task.blocked ?? task.now ?? L("your reply")).font(.system(size: 12)).foregroundStyle(TaskLook.waiting).lineLimit(2)
                        }
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

/// Just done: finished tasks, newest first.
struct DoneTaskRows: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    let tasks: [TaskCard]

    var body: some View {
        VStack(spacing: 6) {
            ForEach(tasks) { task in
                Button { workspace.selectTask(task.id) } label: {
                    HStack(spacing: 8) {
                        Text(task.state == .done ? "✓" : "■").foregroundStyle(task.state == .done ? TaskLook.done : Theme.faint)
                        Text(task.name).lineLimit(1)
                        Spacer(minLength: 4)
                        if workspace.isFoldedIntoSummary(task, in: bot) { SummaryTag() }
                        Text(TaskLook.time(task.updatedAt)).font(.system(size: 12)).foregroundStyle(Theme.faint)
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .frame(height: 44)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color(hex: 0x16161A)))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// The latest finished tasks shown.
    static func finished(_ tasks: [TaskCard], limit: Int = 3) -> [TaskCard] {
        Array(tasks.filter { !$0.state.isActive }.sorted { $0.updatedAt > $1.updatedAt }.prefix(limit))
    }
}

/// "3 tasks" beside a bot's name in the left column: its running and waiting tasks.
struct TaskCountBadge: View {
    let count: Int

    var body: some View {
        Text(L("{0} tasks", count))
            .font(.system(size: 11))
            .foregroundStyle(TaskLook.link)
            .padding(.horizontal, 7)
            .frame(height: 18)
            .background(Capsule().fill(Color(hex: 0x1A2233)))
            .accessibilityLabel(L("{0} tasks under way", count))
    }
}
