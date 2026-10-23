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
        Section {
            if planner.prs.isEmpty {
                Text(planner.loading ? L("Loading…") : planner.problem == nil ? L("No open PRs labelled {0} yet.", CommunityPR.label) : "")
                    .foregroundStyle(.secondary)
            }
            ForEach(planner.prs) { pr in
                ReleaseRow(planner: planner, pr: pr)
            }
            if let problem = planner.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text(planner.canPick
                     ? L("A vote is a 👍 on the PR, seen on GitHub too. Tick the ones for the next version.")
                     : L("A vote is a 👍 on the PR, seen on GitHub too. The repo's owner picks what goes into the next version."))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(L("Reload")) { Task { await planner.refresh() } }
                    .disabled(planner.loading)
            }
        } header: {
            Text(L("Shared features, most 👍 first"))
        }
        .task { if planner.prs.isEmpty { await planner.refresh() } }
        if planner.canPick {
            Section {
                let picks = planner.pickedPRs
                HStack(spacing: 12) {
                    Text(picks.isEmpty ? L("Nothing picked yet.") : picks.map { "#\($0.number)" }.joined(separator: ", "))
                        .foregroundStyle(picks.isEmpty ? .secondary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(sent ? L("Sent") : L("Send to {0}", workspace.developerProject?.name ?? L("manager"))) {
                        sent = workspace.handOffRelease(picks)
                    }
                    .disabled(picks.isEmpty || sent)
                }
            } header: {
                Text(L("Next version"))
            } footer: {
                Text(L("Its manager merges each picked PR whose tests pass and writes the release notes; one that conflicts or fails comes back to you."))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .onChange(of: planner.picked) { sent = false }
        }
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
                    .accessibilityLabel(L("Pick #{0} for the next version", pr.number))
            }
            Button {
                if let url = pr.url { NSWorkspace.shared.open(url) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pr.title).lineLimit(1)
                    Text("#\(pr.number) · @\(pr.author)\(pr.isDraft ? " · " + L("draft") : "")")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L("Open on GitHub"))
            Button {
                Task { await planner.vote(pr.number) }
            } label: {
                Text("👍 \(pr.votes)")
                    .font(.system(size: 13, weight: .medium).monospacedDigit())
                    .foregroundStyle(planner.voted.contains(pr.number) ? Color.accentColor : Color.primary)
                    .padding(.horizontal, 10)
                    .frame(minWidth: 64, minHeight: 28)
                    .background(Capsule().fill(planner.voted.contains(pr.number) ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .disabled(planner.loading)
            .help(planner.voted.contains(pr.number) ? L("You voted for this") : L("Vote: a 👍 on the PR"))
            .accessibilityLabel(L("{0} votes. Vote for #{1}", pr.votes, pr.number))
        }
        .padding(.vertical, 2)
    }
}
