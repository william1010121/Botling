import AppKit
import Foundation

/// A pinned component's chip icon, from its about.md `Icon:` line: an SF Symbol name
/// (`chart.pie.fill`) or an emoji (`📊`). The web view cannot draw SF Symbols, so a symbol goes to
/// the page as a PNG (black on transparent) that the chip uses as a mask, tinted with its colour.
public enum ComponentIcon {
    /// Lower-case words and digits joined by dots, as SF Symbol names are.
    public static func isSymbolName(_ text: String) -> Bool {
        guard !text.isEmpty, text.count <= 64 else { return false }
        return text.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { part in
            !part.isEmpty && part.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        }
    }

    /// One or two glyphs with nothing from ASCII in them: an emoji, or a single character.
    public static func isEmoji(_ text: String) -> Bool {
        !text.isEmpty && text.count <= 2 && !text.unicodeScalars.contains { $0.isASCII }
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var drawn: [String: String?] = [:]

    /// The SF Symbol `name` as a `data:image/png;base64,…` URL, drawn once; nil if macOS has no
    /// such symbol.
    public static func symbolImage(_ name: String) -> String? {
        guard isSymbolName(name) else { return nil }
        lock.lock()
        if let done = drawn[name] {
            lock.unlock()
            return done
        }
        lock.unlock()
        let url = draw(name)
        lock.lock()
        drawn[name] = url
        lock.unlock()
        return url
    }

    /// At 32 px: crisp at the chip's 16 pt on a Retina screen.
    private static func draw(_ name: String) -> String? {
        let configuration = NSImage.SymbolConfiguration(pointSize: 24, weight: .medium)
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration) else { return nil }
        let side = 32
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        // Fitted in the square, keeping its shape.
        let size = symbol.size
        let scale = min(CGFloat(side) / max(size.width, 1), CGFloat(side) / max(size.height, 1))
        let fitted = NSSize(width: size.width * scale, height: size.height * scale)
        let rect = NSRect(x: (CGFloat(side) - fitted.width) / 2, y: (CGFloat(side) - fitted.height) / 2, width: fitted.width, height: fitted.height)
        symbol.draw(in: rect)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}
