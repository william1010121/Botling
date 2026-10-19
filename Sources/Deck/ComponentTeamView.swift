import DeckCore
import SwiftUI

/// The component team's page: each request, what it is doing right now, and what it said when
/// done. You can ask for another change from here.
struct ComponentTeamView: View {
    @ObservedObject var library: ComponentLibrary
    @State private var draft = ""
    @State private var target = "choices"

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 14) {
                            Spacer(minLength: 24)
                            if library.jobs.isEmpty {
                                Text("還沒有人找組件團隊。")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.faint)
                            }
                            ForEach(library.jobs) { job in
                                JobRows(job: job, library: library)
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .frame(maxWidth: 640)
                        .padding(.horizontal, 24)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: viewport.size.height, alignment: .bottom)
                    }
                    .scrollIndicators(.never)
                    .defaultScrollAnchor(.bottom)
                    .onChange(of: library.jobs.count) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            composer
                .frame(maxWidth: 640)
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 24)
        }
        .background(Theme.ground)
        .onAppear {
            if let last = library.jobs.last?.name { target = last }
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Picker("組件", selection: $target) {
                ForEach(library.names, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            .padding(.leading, 12)
            ComposerField(text: $draft, placeholder: "要組件團隊怎麼改 \(target)？", onSubmit: send)
                .padding(.vertical, 10)
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.ground)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(canSend ? Theme.text : Theme.muted))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("送出")
            .padding(6)
        }
        .background(RoundedRectangle(cornerRadius: 26).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(Color(hex: 0x2A2A2F)))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && library.working[target] == nil
    }

    private func send() {
        guard canSend else { return }
        library.request(target, change: draft, from: "使用者")
        draft = ""
    }
}

/// One request: what was asked (on the right, like your own message), then the team's progress
/// or result (on the left, like a reply).
private struct JobRows: View {
    let job: ComponentJob
    @ObservedObject var library: ComponentLibrary

    var body: some View {
        VStack(spacing: 10) {
            VStack(alignment: .trailing, spacing: 4) {
                Text("\(job.asker) · \(job.name)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                Text(job.request)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.userBubble))
            }
            .frame(maxWidth: 460, alignment: .trailing)
            .frame(maxWidth: .infinity, alignment: .trailing)

            HStack(alignment: .top, spacing: 10) {
                AvatarView(kind: .diamond, size: 28, eyes: job.isWorking ? .open : .happy)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 10) {
                    if job.isWorking {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(job.activity ?? "開始處理…").foregroundStyle(Theme.muted)
                        }
                    } else {
                        MarkdownView(text: job.summary ?? "改好了。")
                        if library.hasPrevious(job.name), job.id == library.jobs.last(where: { $0.name == job.name })?.id {
                            Button("退回上一版") { library.revert(job.name) }
                                .buttonStyle(.plain)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.muted)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bubble))
                .frame(maxWidth: 520, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Right column on the component team's page: every component, and whether it is being changed.
struct ComponentsPanel: View {
    @ObservedObject var library: ComponentLibrary

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                AvatarView(kind: .diamond, size: 28, eyes: library.working.isEmpty ? .happy : .open)
                Text("組件團隊").font(.system(size: 15, weight: .semibold))
            }
            .frame(height: 40)
            Text("組件").font(.system(size: 12)).foregroundStyle(Theme.faint)
            VStack(spacing: 6) {
                ForEach(library.names, id: \.self) { name in
                    HStack {
                        Text(name)
                        Spacer()
                        if library.working[name] != nil {
                            ProgressView().controlSize(.small)
                        } else if library.updated.contains(name) {
                            Text("已更新").font(.system(size: 12)).foregroundStyle(Theme.green)
                        }
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubble))
                    .contextMenu {
                        if library.hasPrevious(name) {
                            Button("退回上一版") { library.revert(name) }
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(20)
        .padding(.top, 16)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.side)
    }
}
