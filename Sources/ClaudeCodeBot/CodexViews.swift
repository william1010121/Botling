import AppKit
import ClaudeCodeBotCore
import SwiftUI

extension CodexSeverity {
    var tint: Color {
        switch self {
        case .high: Color(hex: 0xFF8A80)
        case .medium: Color(hex: 0xF7C27F)
        case .low: Theme.muted
        }
    }

    var fill: Color {
        switch self {
        case .high: Color(hex: 0x3A1D1D)
        case .medium: Color(hex: 0x2A2116)
        case .low: Color(hex: 0x2A2A31)
        }
    }
}

/// "High", "2 medium": a small colored label.
struct SeverityBadge: View {
    let severity: CodexSeverity
    var text: String?

    var body: some View {
        Text(text ?? severity.displayName)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(severity.tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 6).fill(severity.fill))
    }
}

extension CodexReview.State {
    var color: Color {
        switch self {
        case .reviewing, .fixing: Theme.blue
        case .clean: Theme.green
        case .open, .stuck: Theme.orange
        case .failed: Theme.errorText
        case .stopped: Theme.faint
        }
    }
}

/// A review in a list (Results, Codex's panel): its title, how it stands, what is left.
struct CodexReviewCard: View {
    let review: CodexReview
    var showsOwner: String?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(review.title).font(.system(size: 14)).lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(Theme.faint)
                }
                HStack(spacing: 6) {
                    Circle().fill(review.state.color).frame(width: 7, height: 7)
                    Text(review.stateLine).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    if let owner = showsOwner {
                        Text("· \(owner)").font(.system(size: 12)).foregroundStyle(Theme.faint).lineLimit(1)
                    }
                }
                let counts = CodexSeverity.allCases.map { ($0, review.count($0)) }.filter { $0.1 > 0 }
                if !counts.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(counts, id: \.0) { severity, count in
                            SeverityBadge(severity: severity, text: "\(count) \(severity.rawValue)")
                        }
                        let fixed = review.findings.filter { $0.status == .fixed }.count
                        if fixed > 0 {
                            Text("\(fixed) fixed").font(.system(size: 11)).foregroundStyle(Theme.green)
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(review.title), \(review.stateLine)")
    }
}

/// The report: every finding grouped by file, with the lines of the change around it, filters,
/// a box to pick findings, and where each stands. In the right column, and full size in a
/// window of its own.
struct CodexReportView: View {
    @ObservedObject var workspace: Workspace
    let reviewID: UUID
    /// The right column's back button; nil in a window.
    var close: (() -> Void)?

    enum Filter: Hashable {
        case all, severity(CodexSeverity), open, fixed
    }

    @State private var filter: Filter = .all
    @State private var picked: Set<UUID> = []
    @State private var diff: GitDiff?
    @State private var showsDiff: Set<UUID> = []
    @State private var copied = false

    private var review: CodexReview? { workspace.codexReview(reviewID) }

    var body: some View {
        if let review {
            VStack(alignment: .leading, spacing: 12) {
                header(review)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        overview(review)
                        filters(review)
                        let shown = visible(review)
                        if shown.isEmpty {
                            Text(review.findings.isEmpty ? (review.isActive ? "Codex is reading the change…" : "Nothing found.") : "Nothing here with this filter.")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.faint)
                                .padding(.vertical, 8)
                        }
                        ForEach(files(shown), id: \.self) { file in
                            fileSection(file, findings: shown.filter { $0.file == file }, review: review)
                        }
                    }
                    .padding(.bottom, 8)
                }
                .scrollIndicators(.never)
                actions(review)
            }
            .task(id: review.round) {
                diff = await workspace.codexDiff(for: reviewID)
            }
        } else {
            VStack(alignment: .leading) {
                if let close { backButton(close) }
                Text("This review is gone.").foregroundStyle(Theme.faint)
            }
        }
    }

    private func backButton(_ close: @escaping () -> Void) -> some View {
        Button(action: close) {
            Image(systemName: "chevron.left")
                .foregroundStyle(Theme.muted)
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back")
    }

    private func header(_ review: CodexReview) -> some View {
        HStack(spacing: 4) {
            if let close { backButton(close) }
            VStack(alignment: .leading, spacing: 1) {
                Text(review.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text("\(URL(filePath: review.folder).lastPathComponent)\(review.base.map { " → \($0)" } ?? " · uncommitted")")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.faint)
                    .lineLimit(1)
                    .help(review.folder)
            }
            Spacer(minLength: 4)
            if close != nil {
                Button { CodexReportWindows.open(review.id, title: review.title, workspace: workspace) } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 32, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open the full report in a window")
                .accessibilityLabel("Open the full report")
            }
        }
    }

    private func overview(_ review: CodexReview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if review.isActive && review.state == .reviewing {
                    ProgressView().controlSize(.small)
                } else {
                    Circle().fill(review.state.color).frame(width: 8, height: 8)
                }
                Text(review.stateLine).font(.system(size: 13))
                Spacer()
                if let last = review.rounds.last {
                    Text(last.at, style: .relative).font(.system(size: 12)).foregroundStyle(Theme.faint)
                }
            }
            if review.kind == .loop, !review.rounds.isEmpty {
                // The rounds so far: found → fixed → found …
                Text(review.rounds.map { $0.found == 0 ? "R\($0.number): clean" : "R\($0.number): \($0.found) found\($0.sent > 0 ? ", \($0.sent) sent back" : "")" }.joined(separator: "  ›  "))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = review.error {
                Text(error).font(.system(size: 12)).foregroundStyle(Theme.errorText).textSelection(.enabled)
            }
            if !review.summary.isEmpty {
                Text(review.summary)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
    }

    private func filters(_ review: CodexReview) -> some View {
        let options: [(Filter, String)] = [(.all, "All")]
            + CodexSeverity.allCases.compactMap { severity in
                let n = review.findings.filter { $0.severity == severity }.count
                return n == 0 ? nil : (.severity(severity), "\(severity.displayName) · \(n)")
            }
            + [(.open, "Open · \(review.findings.filter { $0.status == .open || $0.status == .sent }.count)"),
               (.fixed, "Fixed · \(review.findings.filter { $0.status == .fixed }.count)")]
        return FlowRow(spacing: 6) {
            ForEach(options, id: \.0) { option, label in
                Button { filter = option } label: {
                    Text(label)
                        .font(.system(size: 12))
                        .foregroundStyle(filter == option ? Theme.text : Theme.muted)
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .background(Capsule().fill(filter == option ? Theme.selected : Theme.bubble))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func visible(_ review: CodexReview) -> [CodexFinding] {
        review.findings.filter { finding in
            switch filter {
            case .all: true
            case let .severity(severity): finding.severity == severity
            case .open: finding.status == .open || finding.status == .sent
            case .fixed: finding.status == .fixed
            }
        }
        .sorted { ($0.severity, $0.line ?? 0) < ($1.severity, $1.line ?? 0) }
    }

    /// Files in the order of their worst finding.
    private func files(_ findings: [CodexFinding]) -> [String] {
        var seen = Set<String>()
        return findings.map(\.file).filter { seen.insert($0).inserted }
    }

    private func fileSection(_ file: String, findings: [CodexFinding], review: CodexReview) -> some View {
        let changes = diff?.file(file)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(file.isEmpty ? "(no file)" : file)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 4)
                if let changes {
                    Text("+\(changes.added) −\(changes.removed)").font(.system(size: 12)).foregroundStyle(Theme.faint)
                }
            }
            ForEach(findings) { finding in
                findingCard(finding, changes: changes, review: review)
            }
        }
    }

    private func findingCard(_ finding: CodexFinding, changes: GitDiff.File?, review: CodexReview) -> some View {
        let isPicked = picked.contains(finding.id)
        let canPick = finding.status == .open && ownerCanFix(review)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if canPick {
                    Button {
                        if isPicked { picked.remove(finding.id) } else { picked.insert(finding.id) }
                    } label: {
                        Image(systemName: isPicked ? "checkmark.square.fill" : "square")
                            .foregroundStyle(isPicked ? Theme.blue : Theme.faint)
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isPicked ? "Unpick \(finding.title)" : "Pick \(finding.title)")
                }
                SeverityBadge(severity: finding.severity)
                Text(finding.place).font(.system(size: 12, design: .monospaced)).foregroundStyle(Color(hex: 0x8DB5FF)).lineLimit(1)
                Spacer(minLength: 4)
                statusLabel(finding)
            }
            Text(finding.title)
                .font(.system(size: 13, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
                .strikethrough(finding.status == .fixed || finding.status == .skipped, color: Theme.faint)
            if !finding.scenario.isEmpty {
                Text(finding.scenario)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if finding.keepsComingBack {
                Text("Seen in rounds \(finding.firstRound)–\(finding.lastSeenRound)").font(.system(size: 11)).foregroundStyle(Theme.orange)
            }
            HStack(spacing: 12) {
                if let changes, !changes.hunks.isEmpty {
                    Button(showsDiff.contains(finding.id) ? "Hide diff" : "Show diff") {
                        if showsDiff.contains(finding.id) { showsDiff.remove(finding.id) } else { showsDiff.insert(finding.id) }
                    }
                }
                Menu("Mark") {
                    Button("Fixed") { workspace.setCodexFindings([finding.id], of: reviewID, to: .fixed) }
                    Button("Not an issue (skip)") { workspace.setCodexFindings([finding.id], of: reviewID, to: .skipped) }
                    Button("Open again") { workspace.setCodexFindings([finding.id], of: reviewID, to: .open) }
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            .buttonStyle(.plain)
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
            if showsDiff.contains(finding.id), let changes {
                DiffExcerpt(lines: changes.excerpt(around: finding.line), focus: finding.line)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(isPicked ? Theme.blue : finding.severity == .low ? Color.clear : finding.severity.fill, lineWidth: 1))
        .opacity(finding.status == .fixed || finding.status == .skipped ? 0.7 : 1)
    }

    private func statusLabel(_ finding: CodexFinding) -> some View {
        let color: Color = switch finding.status {
        case .open: Theme.orange
        case .sent: Theme.blue
        case .fixed: Theme.green
        case .skipped: Theme.faint
        }
        return Text(finding.status == .sent ? "Being fixed" : finding.status.displayName)
            .font(.system(size: 11))
            .foregroundStyle(color)
    }

    private func ownerCanFix(_ review: CodexReview) -> Bool {
        review.ownerID != Workspace.codexID
    }

    private func ownerName(_ review: CodexReview) -> String {
        workspace.speakerName(for: review.ownerID) ?? "the bot"
    }

    @ViewBuilder
    private func actions(_ review: CodexReview) -> some View {
        VStack(spacing: 8) {
            if review.kind == .loop, review.state == .stuck {
                HStack(spacing: 8) {
                    wideButton("Fix once more", primary: true) { workspace.fixCodexOnceMore(reviewID) }
                    wideButton("Accept as is") { workspace.acceptCodexReview(reviewID) }
                }
            }
            HStack(spacing: 8) {
                if ownerCanFix(review), !review.isActive {
                    let chosen = picked.intersection(Set(review.openFindings.map(\.id)))
                    wideButton(chosen.isEmpty ? "Pick findings to send" : "Send \(chosen.count) to \(ownerName(review))", primary: !chosen.isEmpty) {
                        workspace.sendCodexFindings(chosen, of: reviewID)
                        picked.removeAll()
                    }
                    .disabled(chosen.isEmpty)
                }
                if review.isActive || review.state == .stuck, review.kind == .loop {
                    wideButton("Stop loop") { workspace.stopCodexReview(reviewID) }
                }
            }
            HStack(spacing: 16) {
                if review.kind == .single {
                    Button("Run again") { workspace.rerunCodexReview(reviewID) }
                        .disabled(review.state == .reviewing)
                }
                Button(copied ? "Copied" : "Copy as Markdown") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(review.markdown, forType: .string)
                    copied = true
                }
                Spacer()
            }
            .buttonStyle(.plain)
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
        }
        .padding(.top, 8)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func wideButton(_ title: String, primary: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: primary ? .semibold : .regular))
                .foregroundStyle(primary ? Color.white : Theme.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background(RoundedRectangle(cornerRadius: 8).fill(primary ? Theme.blue : Color(hex: 0x232328)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The changed lines around a finding, the line itself marked.
struct DiffExcerpt: View {
    let lines: [GitDiff.Line]
    let focus: Int?

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 8) {
                        Text(line.new.map(String.init) ?? line.old.map(String.init) ?? "")
                            .foregroundStyle(Theme.faint)
                            .frame(width: 34, alignment: .trailing)
                        Text(prefix(line) + line.text)
                            .foregroundStyle(color(line))
                            .fixedSize()
                    }
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(line))
                }
            }
            .padding(.vertical, 6)
        }
        .font(.system(size: 11, design: .monospaced))
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x111114)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .textSelection(.enabled)
    }

    private func prefix(_ line: GitDiff.Line) -> String {
        switch line.kind {
        case .added: "+ "
        case .removed: "- "
        case .context: "  "
        }
    }

    private func color(_ line: GitDiff.Line) -> Color {
        switch line.kind {
        case .added: Theme.green
        case .removed: Color(hex: 0xFF8A80)
        case .context: Theme.text
        }
    }

    private func background(_ line: GitDiff.Line) -> Color {
        if let focus, line.new == focus { return Color(hex: 0x2B3B5C) }
        switch line.kind {
        case .added: return Color(hex: 0x132A1E)
        case .removed: return Color(hex: 0x2E1616)
        case .context: return .clear
        }
    }
}

/// Lays out its children left to right, wrapping onto new rows.
struct FlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += row + spacing
                x = 0
                row = 0
            }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += row + spacing
                x = bounds.minX
                row = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

/// The full report in a window of its own, one per review.
@MainActor
enum CodexReportWindows {
    private static var windows: [UUID: NSWindow] = [:]

    static func open(_ id: UUID, title: String, workspace: Workspace) {
        if let window = windows[id] {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = NSHostingView(rootView:
            CodexReportView(workspace: workspace, reviewID: id)
                .padding(.horizontal, 24)
                .padding(.top, 36)
                .padding(.bottom, 16)
                .frame(minWidth: 520, minHeight: 480)
                .foregroundStyle(Theme.text)
                .background(Theme.side)
        )
        window.center()
        windows[id] = window
        window.makeKeyAndOrderFront(nil)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { _ in
            MainActor.assumeIsolated { windows[id] = nil }
        }
    }
}
