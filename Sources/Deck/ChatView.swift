import AppKit
import DeckCore
import SwiftUI
import UniformTypeIdentifiers

/// The middle column: the conversation and the input box. Nothing else.
struct ChatView: View {
    @ObservedObject var bot: Bot
    @ObservedObject var workspace: Workspace
    @State private var draft = ""
    /// Files waiting to go with the next message.
    @State private var files: [URL] = []
    /// The line the next message replies to.
    @State private var replyingTo: ChatMessage?
    @State private var dropTargeted = false

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 14) {
                        Spacer(minLength: 24)
                        ForEach(Array(bot.messages.enumerated()), id: \.element.id) { index, message in
                            if let stamp = timeStamp(before: index) {
                                Text(stamp)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.faint)
                                    .frame(maxWidth: .infinity)
                            }
                            MessageRow(
                                message: message,
                                avatar: bot.avatarKind,
                                sourceAvatar: message.sourceID.flatMap(workspace.avatar(for:)),
                                onChoose: { workspace.choose($0, in: message.id, of: bot) },
                                onOpenSource: message.sourceID.map { id in { workspace.select(id) } },
                                components: workspace.components,
                                onAnswer: { workspace.answer($0, in: message.id, of: bot) },
                                onReply: { replyingTo = message },
                                onOpenMedia: { url, label in workspace.openResult = Chip(label: label, url: url) },
                                onOpenQuote: { id in withAnimation { proxy.scrollTo(id, anchor: .center) } }
                            )
                            .id(message.id)
                        }
                        if bot.isWorking {
                            HStack(alignment: .top, spacing: 10) {
                                AvatarView(kind: bot.avatarKind, size: 28)
                                TypingBubble()
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .frame(maxWidth: 640)
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity)
                    // Messages sit at the bottom even when few, so nothing jumps once they
                    // overflow.
                    .frame(minHeight: viewport.size.height, alignment: .bottom)
                }
                // A visible scroller takes width the moment it appears and shifts the column.
                .scrollIndicators(.never)
                .defaultScrollAnchor(.bottom)
                .onChange(of: bot.messages.count) {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: bot.isWorking) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            }

            composer
                .frame(maxWidth: 640)
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 24)
        }
        .background(Theme.ground)
        // Drop files anywhere on the chat to attach them.
        .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url { DispatchQueue.main.async { files.append(url) } }
                }
            }
            return true
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Theme.blue, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .padding(12)
                    .allowsHitTesting(false)
            }
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let replyingTo {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Theme.blue).frame(width: 3, height: 30)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(replyingTo.role == .user ? "回覆你自己" : "回覆 \(bot.name)")
                            .font(.system(size: 12))
                            .foregroundStyle(Color(hex: 0x8DB5FF))
                        Text(Bot.preview(of: replyingTo))
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button { self.replyingTo = nil } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                            .frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("取消回覆")
                }
                .padding(.horizontal, 18)
                .padding(.top, 10)
            }
            if !files.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(Array(files.enumerated()), id: \.offset) { index, file in
                            PendingFile(url: file) { files.remove(at: index) }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                }
                .scrollIndicators(.never)
            }
            HStack(spacing: 4) {
                Button(action: pickFiles) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("加入圖片或檔案")
                .padding(.leading, 6)
                ComposerField(text: $draft, placeholder: placeholder, onSubmit: send, onFiles: { files.append(contentsOf: $0) })
                    .padding(.vertical, 10)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.ground)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(canSend ? Theme.text : Theme.muted))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("送出")
                .disabled(!canSend)
                .padding(6)
            }
        }
        .background(RoundedRectangle(cornerRadius: 26).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(Color(hex: 0x2A2A2F)))
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "加入"
        if panel.runModal() == .OK {
            files.append(contentsOf: panel.urls)
        }
    }

    private var placeholder: String {
        bot.profile.role == .main ? "許個願，或問進度…" : "對 \(bot.name) 說…"
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        let attached = files
        let reply = replyingTo?.id
        draft = ""
        files = []
        replyingTo = nil
        bot.send(text, files: attached, replyingTo: reply)
    }

    /// A time line above a message that comes 30+ minutes after the previous one.
    private func timeStamp(before index: Int) -> String? {
        let date = bot.messages[index].date
        if index > 0, date.timeIntervalSince(bot.messages[index - 1].date) < 30 * 60 { return nil }
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "今天 \(time)" }
        if calendar.isDateInYesterday(date) { return "昨天 \(time)" }
        return date.formatted(.dateTime.month().day().hour().minute())
    }
}

struct MessageRow: View {
    let message: ChatMessage
    /// The face shown beside the bot's lines.
    var avatar: AvatarKind
    /// For a notice: the reporting project's face.
    var sourceAvatar: AvatarKind? = nil
    var onChoose: ((Int) -> Void)? = nil
    var onOpenSource: (() -> Void)? = nil
    /// Draws choices and `<show>` data from their templates; without it, built-in views are used.
    var components: ComponentLibrary? = nil
    /// A component's answer in words.
    var onAnswer: ((String) -> Void)? = nil
    /// Start a reply to this line.
    var onReply: (() -> Void)? = nil
    /// Show an image or a video large.
    var onOpenMedia: ((URL, String) -> Void)? = nil
    /// Jump to the line a reply quotes.
    var onOpenQuote: ((UUID) -> Void)? = nil

    var body: some View {
        switch message.role {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                if let preview = message.replyPreview, let target = message.replyTo {
                    Button { onOpenQuote?(target) } label: {
                        Label(preview, systemImage: "arrowshape.turn.up.left")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.faint)
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("回覆：\(preview)")
                }
                if let attachments = message.attachments {
                    AttachmentStrip(attachments: attachments, onOpen: onOpenMedia)
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.userBubble))
                }
            }
            .frame(maxWidth: 460, alignment: .trailing)
            .modifier(ReplyOnHover(action: onReply, buttonFirst: true))
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .bot:
            HStack(alignment: .top, spacing: 10) {
                AvatarView(kind: avatar, size: 28)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 12) {
                    if !message.text.isEmpty {
                        MarkdownView(text: message.text, onOpenMedia: onOpenMedia)
                    }
                    if let choices = message.choices {
                        choicesView(choices)
                    }
                    if let display = message.display, let components, components.names.contains(display.name) {
                        ReportableComponent(library: components, name: display.name) {
                            ComponentView(library: components, name: display.name, data: display.data, onChoose: onChoose, onAnswer: onAnswer)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bubble))
                .frame(maxWidth: 520, alignment: .leading)
            }
            .modifier(ReplyOnHover(action: onReply, buttonFirst: false))
            .frame(maxWidth: .infinity, alignment: .leading)
        case .notice:
            HStack(alignment: .top, spacing: 10) {
                AvatarView(kind: sourceAvatar ?? .square, size: 28)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 12) {
                    MarkdownView(text: message.text, onOpenMedia: onOpenMedia)
                    if let choices = message.choices {
                        choicesView(choices)
                    }
                    if let onOpenSource {
                        Button(action: onOpenSource) {
                            HStack(spacing: 4) {
                                Text("打開")
                                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                            }
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.muted)
                            .frame(minHeight: 28)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 18).fill(Color(hex: 0x16161A)))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(message.isOpenQuestion ? Color(hex: 0x6B4A1F) : Theme.line))
                .frame(maxWidth: 520, alignment: .leading)
            }
            .modifier(ReplyOnHover(action: onReply, buttonFirst: false))
            .frame(maxWidth: .infinity, alignment: .leading)
        case .error:
            Text(message.text)
                .font(.system(size: 13))
                .foregroundStyle(Theme.errorText)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .relay:
            HStack(alignment: .top, spacing: 8) {
                AvatarView(kind: .circle, size: 18)
                Text(message.text)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.muted)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("主 bot 交辦：\(message.text)")
        case .divider:
            HStack(spacing: 12) {
                Rectangle().fill(Theme.line).frame(height: 1)
                Text(message.text).font(.system(size: 12)).foregroundStyle(Theme.faint).fixedSize()
                Rectangle().fill(Theme.line).frame(height: 1)
            }
        }
    }

    /// The choice buttons, from the 「choices」 template when there is one.
    @ViewBuilder
    private func choicesView(_ choices: [Choice]) -> some View {
        if let components, components.names.contains("choices") {
            ReportableComponent(library: components, name: "choices") {
                ComponentView(
                    library: components,
                    name: "choices",
                    data: Self.choicesData(choices, chosen: message.chosen, answer: message.answer),
                    onChoose: message.isOpenQuestion ? onChoose : nil,
                    onAnswer: message.isOpenQuestion ? onAnswer : nil
                )
                .frame(minWidth: 280)
            }
        } else {
            ChoiceList(choices: choices, chosen: message.chosen, answered: message.answer != nil, onChoose: onChoose)
        }
    }

    static func choicesData(_ choices: [Choice], chosen: Int?, answer: String? = nil) -> String {
        let object: [String: Any] = [
            "options": choices.map { choice -> [String: Any] in
                ["label": choice.label, "detail": choice.detail.map { $0 as Any } ?? NSNull(), "recommended": choice.recommended]
            },
            "chosen": chosen.map { $0 as Any } ?? NSNull(),
            "answer": answer.map { $0 as Any } ?? NSNull()
        ]
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Markdown links become chips: a tinted run that opens the link.
    static func rich(_ text: String) -> AttributedString {
        var result = AttributedString()
        for segment in RichText.segments(in: text) {
            switch segment {
            case let .text(plain):
                result += AttributedString(plain)
            case let .chip(chip):
                var run = AttributedString("\u{2009}\(chip.label)\u{2009}")
                run.link = chip.url
                run.backgroundColor = Theme.chip
                run.foregroundColor = Color(hex: 0x8DB5FF)
                result += run
            }
        }
        return result
    }
}

/// A reply arrow beside a line, shown on hover; also 「回覆」 in its right-click menu.
private struct ReplyOnHover: ViewModifier {
    let action: (() -> Void)?
    /// The button sits before the line (your own, on the right) or after it (the bot's).
    let buttonFirst: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        HStack(alignment: .center, spacing: 4) {
            if buttonFirst { button }
            content
            if !buttonFirst { button }
        }
        .onHover { hovering = $0 }
        .contextMenu {
            if let action { Button("回覆", action: action) }
        }
    }

    private var button: some View {
        Button { action?() } label: {
            Image(systemName: "arrowshape.turn.up.left")
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(hovering && action != nil ? 1 : 0)
        .accessibilityLabel("回覆")
    }
}

/// A file waiting in the composer, with a button to take it out.
private struct PendingFile: View {
    let url: URL
    let remove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if Attachment.kind(of: url) == .image, let picture = NSImage(contentsOf: url) {
                    Image(nsImage: picture).resizable().aspectRatio(contentMode: .fill)
                } else {
                    VStack(spacing: 4) {
                        Image(systemName: Attachment.kind(of: url) == .video ? "play.rectangle" : "doc")
                        Text(url.lastPathComponent).font(.system(size: 10)).lineLimit(1)
                    }
                    .foregroundStyle(Theme.muted)
                    .padding(6)
                }
            }
            .frame(width: 64, height: 64)
            .background(Theme.chip)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.text, Color.black.opacity(0.6))
            }
            .buttonStyle(.plain)
            .offset(x: 6, y: -6)
            .accessibilityLabel("移除 \(url.lastPathComponent)")
        }
    }
}

/// The buttons for a decision. Once one is picked, it stays highlighted and the rest fade.
private struct ChoiceList: View {
    let choices: [Choice]
    let chosen: Int?
    /// Answered in words instead: every option fades.
    var answered = false
    let onChoose: ((Int) -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(choices.enumerated()), id: \.offset) { index, choice in
                let picked = chosen == index
                Button {
                    onChoose?(index)
                } label: {
                    HStack(spacing: 12) {
                        Text(choice.label)
                            .foregroundStyle(Theme.text)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        if picked {
                            Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.blue)
                        } else if let detail = detail(for: choice) {
                            Text(detail)
                                .font(.system(size: 12))
                                .foregroundStyle(choice.recommended ? Color(hex: 0xF7C27F) : Theme.muted)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: 12).fill(picked ? Color(hex: 0x1E2A44) : Color(hex: 0x232328)))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(border(picked: picked, recommended: choice.recommended)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(chosen != nil || answered || onChoose == nil)
                .opacity((chosen != nil || answered) && !picked ? 0.4 : 1)
                .accessibilityLabel(choice.label + (choice.recommended ? "，建議" : ""))
            }
        }
        .frame(minWidth: 280)
    }

    private func detail(for choice: Choice) -> String? {
        switch (choice.recommended, choice.detail) {
        case let (true, detail?): "建議 · \(detail)"
        case (true, nil): "建議"
        case let (false, detail): detail
        }
    }

    private func border(picked: Bool, recommended: Bool) -> Color {
        if picked { return Theme.blue }
        if recommended && chosen == nil { return Color(hex: 0x6B4A1F) }
        return Color(hex: 0x303037)
    }
}

private struct TypingBubble: View {
    @State private var phase = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(Theme.muted)
                    .frame(width: 6, height: 6)
                    .opacity(phase ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.2), value: phase)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bubble))
        .onAppear { phase = true }
        .accessibilityLabel("工作中")
    }
}
