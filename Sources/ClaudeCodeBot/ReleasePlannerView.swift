import AppKit
import ClaudeCodeBotCore
import SwiftUI

/// Settings → Release planner: features people shared as PRs (label `community-feature`), most
/// 👍 first. Everyone can vote (a 👍 on the PR, as on GitHub); the repo's owner also picks which
/// go into the next version and hands them to the developer project's manager.
struct ReleasesSection: View {
    @ObservedObject var workspace: Workspace
    @StateObject private var planner: ReleasePlanner
    @State private var sent = false

    init(workspace: Workspace, planner: ReleasePlanner? = nil) {
        self.workspace = workspace
        _planner = StateObject(wrappedValue: planner ?? workspace.makeReleasePlanner())
    }

    var body: some View {
        PanelSection("Shared features, most 👍 first") {
            if planner.prs.isEmpty {
                Text(planner.loading ? "Loading…" : planner.problem == nil ? "No open PRs labelled \(CommunityPR.label) yet." : "")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 14)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
            } else {
                VStack(spacing: 0) {
                    ForEach(planner.prs) { pr in
                        ReleaseRow(planner: planner, pr: pr)
                        if pr.id != planner.prs.last?.id {
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            if let problem = planner.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(Theme.errorText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text(planner.canPick
                     ? "A vote is a 👍 on the PR, seen on GitHub too. Tick the ones for the next version."
                     : "A vote is a 👍 on the PR, seen on GitHub too. The repo's owner picks what goes into the next version.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Reload") { Task { await planner.refresh() } }
                    .disabled(planner.loading)
            }
        }
        if planner.canPick {
            PanelSection("Next version") {
                let picks = planner.pickedPRs
                HStack(spacing: 12) {
                    Text(picks.isEmpty ? "Nothing picked yet." : picks.map { "#\($0.number)" }.joined(separator: ", "))
                        .font(.system(size: 14))
                        .foregroundStyle(picks.isEmpty ? Theme.muted : Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(sent ? "Sent" : "Send to \(workspace.developerProject?.name ?? "manager")") {
                        sent = workspace.handOffRelease(picks)
                    }
                    .disabled(picks.isEmpty || sent)
                }
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
                Text("Its manager merges each picked PR whose tests pass and writes the release notes; one that conflicts or fails comes back to you.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .onChange(of: planner.picked) { sent = false }
        }
        Color.clear.frame(height: 0)
            .task { if planner.prs.isEmpty { await planner.refresh() } }
    }
}

private struct ReleaseRow: View {
    @ObservedObject var planner: ReleasePlanner
    let pr: CommunityPR

    var body: some View {
        HStack(spacing: 12) {
            if planner.canPick {
                Toggle("", isOn: Binding(get: { planner.picked.contains(pr.number) }, set: { _ in planner.togglePick(pr.number) }))
                    .labelsHidden()
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Pick #\(pr.number) for the next version")
            }
            Button {
                if let url = pr.url { NSWorkspace.shared.open(url) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pr.title).font(.system(size: 14)).lineLimit(1)
                    Text("#\(pr.number) · @\(pr.author)\(pr.isDraft ? " · draft" : "")")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open on GitHub")
            Button {
                Task { await planner.vote(pr.number) }
            } label: {
                Text("👍 \(pr.votes)")
                    .font(.system(size: 13, weight: .medium).monospacedDigit())
                    .foregroundStyle(planner.voted.contains(pr.number) ? Theme.blue : Theme.text)
                    .padding(.horizontal, 10)
                    .frame(minWidth: 64, minHeight: 28)
                    .background(Capsule().fill(planner.voted.contains(pr.number) ? Theme.blue.opacity(0.18) : Theme.chip))
            }
            .buttonStyle(.plain)
            .disabled(planner.loading)
            .help(planner.voted.contains(pr.number) ? "You voted for this" : "Vote: a 👍 on the PR")
            .accessibilityLabel("\(pr.votes) votes. Vote for #\(pr.number)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 52)
    }
}
