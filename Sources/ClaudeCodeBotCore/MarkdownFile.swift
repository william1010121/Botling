import Foundation

/// A .md file opened in its own window: drawn by the app's `viewer.html` with the chat's Markdown
/// and LaTeX instead of shown as raw text. The file's text goes to the page as
/// `window.ccbDocument` (a script the app adds before the page's own runs).
public enum MarkdownFile {
    static let extensions: Set<String> = ["md", "markdown"]

    /// A local Markdown file (`.md`, `.markdown`).
    public static func isMarkdown(_ url: URL) -> Bool {
        url.isFileURL && extensions.contains(url.pathExtension.lowercased())
    }

    private static func encoding(_ cf: CFStringEncodings) -> String.Encoding {
        String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(cf.rawValue)))
    }

    /// The file's text: UTF-8 (a BOM dropped), else Big5, else GB18030, else Latin-1.
    public static func decode(_ data: Data) -> String? {
        if var text = String(data: data, encoding: .utf8) {
            if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
            return text
        }
        for candidate in [encoding(.big5_HKSCS_1999), encoding(.big5), encoding(.GB_18030_2000)] {
            if let text = String(data: data, encoding: candidate) { return text }
        }
        return String(data: data, encoding: .isoLatin1)
    }

    /// `window.ccbDocument = {text, base, name};` for `file`, or nil when it cannot be read.
    public static func documentScript(for file: URL) -> String? {
        guard let data = try? Data(contentsOf: file), let text = decode(data) else { return nil }
        let object = ["text": text, "base": file.standardizedFileURL.absoluteString, "name": file.lastPathComponent, "lang": L10n.language.rawValue]
        guard let json = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return nil }
        return "window.ccbDocument = \(String(decoding: json, as: UTF8.self));"
    }
}
