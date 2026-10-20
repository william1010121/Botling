import Foundation

/// The 「網頁預覽卡片」 component: a one-page HTML result shown in the chat as a small live
/// preview, with its title and a button to open it full-size in its own window.
///
/// A component runs in a sandboxed frame that cannot open `file:` URLs, so the page is served to
/// it through the app's own `ccb-preview:` scheme. Only pages a card shows are served: any file
/// inside a folder called `artifacts` (where bots and teams save results, so pictures beside a
/// page load too), and a page named in a `<show>` card elsewhere (that one file only).
public enum PagePreview {
    public static let component = "網頁預覽卡片"
    public static let scheme = "ccb-preview"
    /// At most this many pages are previewed under one message.
    static let perMessage = 3

    // MARK: Paths

    /// A file path from what a bot wrote: `/abs/path`, `~/path` or a `file://` URL.
    public static func fileURL(from text: String) -> URL? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.lowercased().hasPrefix("file:") {
            guard let url = URL(string: text) ?? URL(string: text.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""),
                  url.isFileURL, !url.path.isEmpty else { return nil }
            return url.standardizedFileURL
        }
        if text.hasPrefix("~/") {
            return FileManager.default.homeDirectoryForCurrentUser.appending(path: String(text.dropFirst(2))).standardizedFileURL
        }
        guard text.hasPrefix("/") else { return nil }
        return URL(filePath: text).standardizedFileURL
    }

    static func isPage(_ url: URL) -> Bool {
        ["html", "htm"].contains(url.pathExtension.lowercased())
    }

    /// The `artifacts` folder `url` is inside, if any.
    static func artifactsFolder(of url: URL) -> URL? {
        var folder = url.standardizedFileURL.deletingLastPathComponent()
        while folder.path != "/" && !folder.path.isEmpty {
            if folder.lastPathComponent == "artifacts" { return folder }
            folder = folder.deletingLastPathComponent()
        }
        return nil
    }

    /// A result page: an .html file in an `artifacts` folder (`.bot/artifacts`, a team's
    /// `artifacts`, the main bot's `artifacts`).
    public static func isArtifactPage(_ url: URL) -> Bool {
        url.isFileURL && isPage(url) && artifactsFolder(of: url) != nil
    }

    // MARK: The scheme

    /// Where the card's frame loads `file` from. `version` (the file's change date) makes a page
    /// that was written again load fresh.
    public static func previewURL(for file: URL, version: Date? = nil) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "page"
        components.path = file.standardizedFileURL.path
        if let version { components.queryItems = [URLQueryItem(name: "v", value: String(Int(version.timeIntervalSince1970)))] }
        return components.url!
    }

    /// The file a `ccb-preview:` request asks for, if it may be served.
    public static func file(forPreview url: URL) -> URL? {
        guard url.scheme == scheme, url.host == "page" else { return nil }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? url.path
        guard path.hasPrefix("/") else { return nil }
        let file = URL(filePath: path).standardizedFileURL
        // Through symlinks too: a link inside artifacts must not lead out of it.
        let real = file.resolvingSymlinksInPath()
        return artifactsFolder(of: real) != nil || Shown.contains(real) ? real : nil
    }

    /// Pages named in `<show>` cards outside an `artifacts` folder: just those files are served.
    enum Shown {
        private static let lock = NSLock()
        nonisolated(unsafe) private static var pages: Set<String> = []

        static func add(_ file: URL) {
            lock.lock()
            defer { lock.unlock() }
            pages.insert(file.resolvingSymlinksInPath().path)
        }

        static func contains(_ file: URL) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return pages.contains(file.path)
        }
    }

    // MARK: Cards

    /// The data the card's template reads: what the bot gave (`path`, `title`), with what the
    /// app adds: `src` (to load the preview from), `url` (to open it full-size), `name` (the file
    /// name) and `missing` (no such page).
    public static func cardData(_ data: String) -> String {
        guard var object = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] else { return data }
        let given = (object["path"] as? String) ?? (object["url"] as? String) ?? ""
        guard let file = fileURL(from: given) else {
            object["missing"] = true
            return encode(object) ?? data
        }
        let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
        let exists = attributes != nil && (attributes?[.type] as? FileAttributeType) != .typeDirectory
        if exists, isPage(file), !isArtifactPage(file) { Shown.add(file) }
        object["path"] = file.path
        object["url"] = file.absoluteString
        object["name"] = file.lastPathComponent
        if exists && isPage(file) {
            object["src"] = previewURL(for: file, version: attributes?[.modificationDate] as? Date).absoluteString
        } else {
            object.removeValue(forKey: "src")
        }
        object["missing"] = !exists
        if (object["title"] as? String)?.trimmingCharacters(in: .whitespaces).isEmpty != false {
            object["title"] = file.deletingPathExtension().lastPathComponent
        }
        return encode(object) ?? data
    }

    /// Cards for the result pages a message links to, `[name](file://…/artifacts/x.html)`, that
    /// are there on disk; at most `perMessage`, each page once, none for `skipping` (the pages
    /// `<show>` cards in the same message show already).
    public static func linkedCards(in text: String, skipping: [URL] = []) -> [String] {
        var seen = Set(skipping.map(\.standardizedFileURL.path))
        var cards: [String] = []
        for chip in RichText.chips(in: text) where cards.count < perMessage {
            guard chip.url.isFileURL else { continue }
            let file = chip.url.standardizedFileURL
            guard isArtifactPage(file), !seen.contains(file.path), FileManager.default.fileExists(atPath: file.path) else { continue }
            seen.insert(file.path)
            let title = chip.label.trimmingCharacters(in: .whitespaces)
            cards.append(cardData(encode(["path": file.path, "title": title]) ?? "{}"))
        }
        return cards
    }

    /// The page a `<show name="網頁預覽卡片">` card names, for not showing it twice.
    static func page(inCard data: String) -> URL? {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] else { return nil }
        return ((object["path"] as? String) ?? (object["url"] as? String)).flatMap(fileURL(from:))
    }

    private static func encode(_ object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: Serving

    /// What a `ccb-preview:` request is answered with: the file and its type. Text pages that are
    /// plain UTF-8 say so, since pages bots write often name no charset (Chinese would turn to
    /// mojibake otherwise).
    public static func response(for url: URL) -> (data: Data, mimeType: String, encoding: String?)? {
        guard let file = file(forPreview: url), let data = try? Data(contentsOf: file) else { return nil }
        let ext = file.pathExtension.lowercased()
        let type = mimeTypes[ext] ?? "application/octet-stream"
        let text = type.hasPrefix("text/") || type == "application/javascript" || type == "application/json" || type == "image/svg+xml"
        return (data, type, text && String(data: data, encoding: .utf8) != nil ? "utf-8" : nil)
    }

    static let mimeTypes: [String: String] = [
        "html": "text/html", "htm": "text/html", "css": "text/css", "js": "application/javascript",
        "mjs": "application/javascript", "json": "application/json", "txt": "text/plain", "csv": "text/plain",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "ico": "image/x-icon", "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf", "wasm": "application/wasm",
    ]
}
