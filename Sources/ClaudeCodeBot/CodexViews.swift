import AppKit
import ClaudeCodeBotCore
import SwiftUI
import UniformTypeIdentifiers

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
        case .stopped, .empty: Theme.faint
        }
    }
}

/// A review in a list (Results, Codex's panel): its title, what it covered, how it stands,
/// Codex's verdict and what is left.
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
                if let scope = review.scopeLine {
                    Text(scope).font(.system(size: 12)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
                }
                HStack(spacing: 6) {
                    Circle().fill(review.state.color).frame(width: 7, height: 7)
                    Text(review.stateLine).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    if let owner = showsOwner {
                        Text("· \(owner)").font(.system(size: 12)).foregroundStyle(Theme.faint).lineLimit(1)
                    }
                }
                // The verdict of the round shown; a round under way would make it stale.
                if !review.summary.isEmpty, !review.isActive, review.state != .empty {
                    Text(review.summary).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(2).truncationMode(.tail)
                }
                let counts = CodexSeverity.allCases.map { ($0, review.count($0)) }.filter { $0.1 > 0 }
                if !counts.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(counts, id: \.0) { severity, count in
                            SeverityBadge(severity: severity, text: "\(count) \(severity.displayName.lowercased())")
                        }
                        let fixed = review.findings.filter { $0.status == .fixed }.count
                        if fixed > 0 {
                            Text(L("{0} fixed", fixed)).font(.system(size: 11)).foregroundStyle(Theme.green)
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
        .accessibilityLabel("\(review.title), \(review.scopeLine.map { "\($0), " } ?? "")\(review.stateLine)")
    }
}

/// "Review with Codex" in a project's panel: a popover to pick what Codex reads (what is not
/// committed, the last commit, the branch against main, or one recent commit) and, if you want,
/// a spec to check the change against.
struct CodexReviewButton: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var bot: Bot
    let running: Bool
    let opened: (UUID) -> Void
    @State private var picking = false
    @State private var choices: CodexScopeChoices?
    @State private var scope: CodexScope?
    @State private var spec: URL?

    var body: some View {
        Button { picking = true } label: {
            Label(running ? L("Codex is reviewing…") : L("Review with Codex"), systemImage: "magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(running ? Theme.faint : Theme.text)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(RoundedRectangle(cornerRadius: 10).stroke(Theme.blue.opacity(0.7), lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(running)
        .help(L("Pick what Codex reviews (read-only), and a spec to check it against if you like; it lists what it would fix."))
        .popover(isPresented: $picking, arrowEdge: .leading) { picker }
    }

    private var picker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("What should Codex review?")).font(.system(size: 14, weight: .semibold))
            if let choices {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(choices.scopes, id: \.self) { option in
                        row(option.displayName, detail: option == choices.suggested ? L("Suggested") : nil, chosen: scope == option) { scope = option }
                    }
                }
                if !choices.recent.isEmpty {
                    Text(L("A recent commit")).font(.system(size: 12)).foregroundStyle(Theme.faint)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(choices.recent, id: \.self) { commit in
                                row("\(commit.hash)  \(commit.subject)", chosen: scope == .commit(commit.hash), monospaced: true) { scope = .commit(commit.hash) }
                            }
                        }
                    }
                    .frame(maxHeight: 180)
                }
                specRow
                HStack {
                    Spacer()
                    Button(L("Cancel")) { picking = false }
                    Button(L("Review")) {
                        picking = false
                        if let id = workspace.reviewWithCodex(bot, scope: scope ?? choices.suggested, spec: spec?.path) { opened(id) }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(16)
        .frame(width: 340)
        .task {
            guard let found = await workspace.codexScopeChoices(for: bot) else {
                // No repository: the chat says so, as before.
                picking = false
                workspace.reviewWithCodex(bot)
                return
            }
            choices = found
            if scope == nil { scope = found.suggested }
        }
    }

    /// The optional spec: none, one of the bot's latest pages, or any file you choose.
    private var specRow: some View {
        HStack(spacing: 8) {
            Text(L("Spec")).font(.system(size: 13)).foregroundStyle(Theme.muted)
            Menu(spec?.lastPathComponent ?? L("None")) {
                Button(L("None")) { spec = nil }
                let pages = CodexSpec.candidates(in: bot.profile.artifactsURL)
                if !pages.isEmpty {
                    Divider()
                    ForEach(pages, id: \.self) { page in Button(page.lastPathComponent) { spec = page } }
                }
                Divider()
                Button(L("Choose a file…")) { chooseSpec() }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            Spacer()
        }
        .help(L("Codex checks point by point that the change does what the spec says."))
    }

    private func chooseSpec() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        panel.directoryURL = GitDiff.repositoryRoot(bot.profile.workingDirectory) ?? bot.profile.workingDirectory
        panel.allowedContentTypes = CodexSpec.extensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = L("Use as spec")
        if panel.runModal() == .OK, let url = panel.url,
           let checked = CodexSpec.validated(url.path, folder: bot.profile.workingDirectory) {
            spec = checked
        }
    }

    private func row(_ title: String, detail: String? = nil, chosen: Bool, monospaced: Bool = false, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack(spacing: 8) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 12))
                    .foregroundStyle(chosen ? Theme.blue : Theme.faint)
                Text(title)
                    .font(monospaced ? .system(size: 12, design: .monospaced) : .system(size: 13))
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(Theme.faint)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
                            Text(review.findings.isEmpty ? (review.isActive ? L("Codex is reading the change…") : L("Nothing found.")) : L("Nothing here with this filter."))
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
                Text(L("This review is gone.")).foregroundStyle(Theme.faint)
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
        .accessibilityLabel(L("Back"))
    }

    private func header(_ review: CodexReview) -> some View {
        HStack(spacing: 4) {
            if let close { backButton(close) }
            VStack(alignment: .leading, spacing: 1) {
                Text(review.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text("\(URL(filePath: review.folder).lastPathComponent)\(review.base.map { " → \($0)" } ?? " · " + L("uncommitted"))")
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
                .help(L("Open the full report in a window"))
                .accessibilityLabel(L("Open the full report"))
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
            if let scope = review.scopeLine {
                Text(scope).font(.system(size: 12)).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
            if review.kind == .loop, !review.rounds.isEmpty {
                // The rounds so far: found → fixed → found …
                Text(review.rounds.map { $0.found == 0 ? L("R{0}: clean", $0.number) : $0.sent > 0 ? L("R{0}: {1} found, {2} sent back", $0.number, $0.found, $0.sent) : L("R{0}: {1} found", $0.number, $0.found) }.joined(separator: "  ›  "))
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
        let options: [(Filter, String)] = [(.all, L("All"))]
            + CodexSeverity.allCases.compactMap { severity in
                let n = review.findings.filter { $0.severity == severity }.count
                return n == 0 ? nil : (.severity(severity), "\(severity.displayName) · \(n)")
            }
            + [(.open, L("Open") + " · \(review.findings.filter { $0.status == .open || $0.status == .sent }.count)"),
               (.fixed, CodexFinding.Status.fixed.displayName + " · \(review.findings.filter { $0.status == .fixed }.count)")]
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
                Text(file.isEmpty ? L("(no file)") : file)
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
                    .accessibilityLabel(isPicked ? L("Unpick {0}", finding.title) : L("Pick {0}", finding.title))
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
                Text(L("Seen in rounds {0}–{1}", finding.firstRound, finding.lastSeenRound)).font(.system(size: 11)).foregroundStyle(Theme.orange)
            }
            HStack(spacing: 12) {
                if let changes, !changes.hunks.isEmpty {
                    Button(showsDiff.contains(finding.id) ? L("Hide diff") : L("Show diff")) {
                        if showsDiff.contains(finding.id) { showsDiff.remove(finding.id) } else { showsDiff.insert(finding.id) }
                    }
                }
                Menu(L("Mark")) {
                    Button(CodexFinding.Status.fixed.displayName) { workspace.setCodexFindings([finding.id], of: reviewID, to: .fixed) }
                    Button(L("Not an issue (skip)")) { workspace.setCodexFindings([finding.id], of: reviewID, to: .skipped) }
                    Button(L("Open again")) { workspace.setCodexFindings([finding.id], of: reviewID, to: .open) }
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
        return Text(finding.status.displayName)
            .font(.system(size: 11))
            .foregroundStyle(color)
    }

    private func ownerCanFix(_ review: CodexReview) -> Bool {
        review.ownerID != Workspace.codexID
    }

    private func ownerName(_ review: CodexReview) -> String {
        workspace.speakerName(for: review.ownerID) ?? L("the bot")
    }

    @ViewBuilder
    private func actions(_ review: CodexReview) -> some View {
        VStack(spacing: 8) {
            if review.kind == .loop, review.state == .stuck {
                HStack(spacing: 8) {
                    wideButton(L("Fix once more"), primary: true) { workspace.fixCodexOnceMore(reviewID) }
                    wideButton(L("Accept as is")) { workspace.acceptCodexReview(reviewID) }
                }
            }
            HStack(spacing: 8) {
                if ownerCanFix(review), !review.isActive {
                    let chosen = picked.intersection(Set(review.openFindings.map(\.id)))
                    wideButton(chosen.isEmpty ? L("Pick findings to send") : L("Send {0} to {1}", chosen.count, ownerName(review)), primary: !chosen.isEmpty) {
                        workspace.sendCodexFindings(chosen, of: reviewID)
                        picked.removeAll()
                    }
                    .disabled(chosen.isEmpty)
                }
                if review.isActive || review.state == .stuck, review.kind == .loop {
                    wideButton(L("Stop loop")) { workspace.stopCodexReview(reviewID) }
                }
            }
            HStack(spacing: 16) {
                if review.kind == .single {
                    Button(L("Run again")) { workspace.rerunCodexReview(reviewID) }
                        .disabled(review.state == .reviewing)
                }
                Button(copied ? L("Copied") : L("Copy as Markdown")) {
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
