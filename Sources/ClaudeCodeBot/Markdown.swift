import AVKit
import ClaudeCodeBotCore
import SwiftUI

/// A bot's reply drawn as markdown.
struct MarkdownView: View {
    let text: String
    var onOpenMedia: ((URL, String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .textSelection(.enabled)
        .tint(Color(hex: 0x8DB5FF))
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            Text(Self.inline(text))
                .font(.system(size: level == 1 ? 19 : level == 2 ? 17 : 15, weight: .semibold))
                .padding(.top, 2)
        case let .paragraph(text):
            Text(Self.inline(text))
                .fixedSize(horizontal: false, vertical: true)
        case let .bullets(items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(Theme.muted)
                        Text(Self.inline(item)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case let .numbered(items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { position, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(position + 1).").foregroundStyle(Theme.muted).monospacedDigit()
                        Text(Self.inline(item)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case let .quote(text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color(hex: 0x3A3A40)).frame(width: 3)
                Text(Self.inline(text)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            .fixedSize(horizontal: false, vertical: true)
        case let .code(code):
            // Long lines wrap rather than scroll sideways inside the chat.
            Text(code)
                .font(.system(size: 13, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0x111114)))
        case let .table(header, rows):
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        Text(Self.inline(cell)).fontWeight(.semibold)
                    }
                }
                Rectangle().fill(Theme.line).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(Self.inline(cell)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .font(.system(size: 14))
            .padding(.vertical, 4)
        case .rule:
            Rectangle().fill(Theme.line).frame(height: 1)
        case let .media(alt, url):
            MediaView(url: url, label: alt, onOpen: onOpenMedia)
        }
    }

    /// Bold, italic, inline code and links; links are tinted like chips.
    static func inline(_ text: String) -> AttributedString {
        var result = (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
        for run in result.runs where run.link != nil {
            result[run.range].backgroundColor = Theme.chip
            result[run.range].foregroundColor = Color(hex: 0x8DB5FF)
        }
        for run in result.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                result[run.range].font = .system(size: 13, design: .monospaced)
                result[run.range].backgroundColor = Color(hex: 0x111114)
            }
        }
        return result
    }
}

/// An image or a video, shown in the chat. Click an image to see it large in the right column.
struct MediaView: View {
    let url: URL
    var label: String = ""
    var onOpen: ((URL, String) -> Void)?

    var body: some View {
        switch Attachment.kind(of: url) {
        case .video:
            VideoPlayer(player: AVPlayer(url: url))
                .frame(maxWidth: 480)
                .frame(height: 270)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel(label.isEmpty ? "影片" : label)
        default:
            Button { onOpen?(url, label.isEmpty ? url.lastPathComponent : label) } label: {
                image
                    .frame(maxWidth: 480, maxHeight: 320, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label.isEmpty ? "圖片" : label)
        }
    }

    @ViewBuilder
    private var image: some View {
        if url.isFileURL {
            if let picture = NSImage(contentsOf: url) {
                Image(nsImage: picture).resizable().aspectRatio(contentMode: .fit)
            } else {
                missing
            }
        } else {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().aspectRatio(contentMode: .fit)
                } else if phase.error != nil {
                    missing
                } else {
                    ProgressView().frame(width: 120, height: 80)
                }
            }
        }
    }

    private var missing: some View {
        Label("找不到圖片：\(url.lastPathComponent)", systemImage: "photo")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0x111114)))
    }
}

/// Files the user sent, above their message: images as thumbnails, anything else as a chip.
struct AttachmentStrip: View {
    let attachments: [Attachment]
    var onOpen: ((URL, String) -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            ForEach(attachments, id: \.self) { attachment in
                Button { onOpen?(attachment.url, attachment.name) } label: {
                    switch attachment.kind {
                    case .image:
                        if let picture = NSImage(contentsOf: attachment.url) {
                            Image(nsImage: picture)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 120, height: 90)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    case .video, .file:
                        Label(attachment.name, systemImage: attachment.kind == .video ? "play.rectangle" : "doc")
                            .font(.system(size: 13))
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .frame(height: 36)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.chip))
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(attachment.name)
            }
        }
    }
}
