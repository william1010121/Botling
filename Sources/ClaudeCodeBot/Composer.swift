import AppKit
import SwiftUI

/// The chat input. A native text view, so Return while an input method is still composing
/// (choosing 注音 or 拼音 candidates) commits the text instead of sending it. Return sends;
/// Shift-Return adds a line. Grows up to six lines.
struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var onSubmit: () -> Void
    /// Images or files pasted or dropped into the box.
    var onFiles: ([URL]) -> Void = { _ in }

    private static let font = NSFont.systemFont(ofSize: 15)
    private static let maxLines: CGFloat = 6

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = PlaceholderTextView()
        textView.delegate = context.coordinator
        textView.font = Self.font
        textView.textColor = NSColor(Theme.text)
        textView.insertionPointColor = NSColor(Theme.text)
        textView.drawsBackground = false
        textView.isRichText = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.textContainerInset = NSSize(width: 0, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.placeholder = placeholder
        textView.setAccessibilityLabel(placeholder)
        textView.onFiles = { context.coordinator.parent.onFiles($0) }

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.borderType = .noBorder
        DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? PlaceholderTextView else { return }
        // Leave the text alone while an input method is composing.
        if textView.string != text, !textView.hasMarkedText() {
            textView.string = text
        }
        textView.placeholder = placeholder
        textView.needsDisplay = true
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scrollView: NSScrollView, context: Context) -> CGSize? {
        guard let textView = scrollView.documentView as? NSTextView,
              let layout = textView.layoutManager,
              let container = textView.textContainer else { return nil }
        let width = proposal.width ?? 400
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let lineHeight = layout.defaultLineHeight(for: Self.font)
        let used = max(layout.usedRect(for: container).height, lineHeight)
        let height = min(used, lineHeight * Self.maxLines) + textView.textContainerInset.height * 2
        return CGSize(width: width, height: ceil(height))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField

        init(_ parent: ComposerField) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            textView.invalidateIntrinsicContentSize()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
            // An input method is still choosing: let Return commit the text.
            if textView.hasMarkedText() { return false }
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            }
            parent.onSubmit()
            return true
        }
    }
}

/// Draws the placeholder while empty, and takes pasted or dropped images and files as attachments.
private final class PlaceholderTextView: NSTextView {
    var placeholder = ""
    var onFiles: ([URL]) -> Void = { _ in }

    override func paste(_ sender: Any?) {
        if let files = Self.files(from: .general) {
            onFiles(files)
        } else {
            super.paste(sender)
        }
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let files = Self.files(from: sender.draggingPasteboard) {
            onFiles(files)
            return true
        }
        return super.performDragOperation(sender)
    }

    /// File URLs on the pasteboard, or a copied image (a screenshot) saved to a temporary PNG.
    /// Plain text gives nil, so it pastes as text.
    private static func files(from pasteboard: NSPasteboard) -> [URL]? {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !urls.isEmpty {
            return urls
        }
        guard pasteboard.string(forType: .string) == nil,
              let image = NSImage(pasteboard: pasteboard),
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
        let url = FileManager.default.temporaryDirectory.appending(path: "貼上的圖片-\(UUID().uuidString.prefix(6)).png")
        guard (try? png.write(to: url)) != nil else { return nil }
        return [url]
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !hasMarkedText() else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 15),
            .foregroundColor: NSColor(Theme.faint)
        ]
        placeholder.draw(at: NSPoint(x: textContainerInset.width, y: textContainerInset.height), withAttributes: attributes)
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }
}
