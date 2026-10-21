import CryptoKit
import Foundation

/// The 「網頁預覽卡片」 component: a one-page HTML result shown in the chat as a small live
/// preview, with its title and a button to open it full-size in its own window.
///
/// A component runs in a sandboxed frame that cannot open `file:` URLs, so the page is served to
/// it through the app's own `ccb-preview:` scheme. Only pages a card shows are served: any file
/// inside a folder called `artifacts` (where bots and teams save results, so pictures beside a
/// page load too), and a page named in a `<show>` card elsewhere (that one file only).
public enum PagePreview {
    /// The desktop size a page is drawn at for its card, then scaled down: its screenshot
    /// (PageShotMaker) and the card's live frame use the same, so both show the same layout.
    public static let viewport = (width: 1280, height: 800)

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
        guard url.scheme == scheme else { return nil }
        if url.host == PageShots.host { return PageShots.file(named: url.lastPathComponent) }
        guard url.host == "page" else { return nil }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? url.path
        guard path.hasPrefix("/") else { return nil }
        let file = URL(filePath: path).standardizedFileURL
        // Through symlinks too: a link inside artifacts must not lead out of it.
        let real = file.resolvingSymlinksInPath()
        return artifactsFolder(of: real) != nil || Shown.contains(real) || ComponentImages.allows(real) ? real : nil
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
    /// app adds: `src` (to load the preview from), `shot` (a picture of the page as it is now,
    /// once one was taken; see `PageShots`), `url` (to open it full-size), `name` (the file
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
        object.removeValue(forKey: "shot")
        if exists && isPage(file) {
            let date = attributes?[.modificationDate] as? Date
            object["src"] = previewURL(for: file, version: date).absoluteString
            if let shot = PageShots.shot(for: file, version: date) { object["shot"] = shot.absoluteString }
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

    /// What a `ccb-preview:` request is answered with.
    public struct Answer {
        /// 200 for the whole file, 206 for the part a `Range` asked for, 416 for a range past the end.
        public var statusCode: Int
        public var data: Data
        public var mimeType: String
        public var encoding: String?
        /// The HTTP headers to answer with (Content-Type, Content-Length, Accept-Ranges, Content-Range).
        public var headers: [String: String]
    }

    /// What a `ccb-preview:` request is answered with: the file and its type. Text pages that are
    /// plain UTF-8 say so, since pages bots write often name no charset (Chinese would turn to
    /// mojibake otherwise). `range` is the request's `Range` header: WebKit plays video and sound
    /// only from a server that answers byte ranges (`bytes=0-1` first, then the parts it needs),
    /// so a range is answered with just that part (206), read from the file without loading all of it.
    public static func response(for url: URL, range: String? = nil) -> Answer? {
        guard let file = file(forPreview: url),
              let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              (attributes[.type] as? FileAttributeType) != .typeDirectory,
              let size = (attributes[.size] as? NSNumber)?.intValue else { return nil }
        let ext = file.pathExtension.lowercased()
        let type = mimeTypes[ext] ?? "application/octet-stream"
        var headers = ["Accept-Ranges": "bytes"]

        if let range, let bounds = byteRange(range, size: size) {
            guard let bounds else {
                headers["Content-Range"] = "bytes */\(size)"
                headers["Content-Length"] = "0"
                headers["Content-Type"] = type
                return Answer(statusCode: 416, data: Data(), mimeType: type, encoding: nil, headers: headers)
            }
            guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
            defer { try? handle.close() }
            guard (try? handle.seek(toOffset: UInt64(bounds.lowerBound))) != nil,
                  let data = try? handle.read(upToCount: bounds.count) else { return nil }
            headers["Content-Range"] = "bytes \(bounds.lowerBound)-\(bounds.lowerBound + data.count - 1)/\(size)"
            headers["Content-Length"] = String(data.count)
            headers["Content-Type"] = type
            return Answer(statusCode: 206, data: data, mimeType: type, encoding: nil, headers: headers)
        }

        guard let data = try? Data(contentsOf: file) else { return nil }
        let text = type.hasPrefix("text/") || type == "application/javascript" || type == "application/json" || type == "image/svg+xml"
        let encoding = text && String(data: data, encoding: .utf8) != nil ? "utf-8" : nil
        headers["Content-Length"] = String(data.count)
        headers["Content-Type"] = encoding.map { "\(type); charset=\($0)" } ?? type
        return Answer(statusCode: 200, data: data, mimeType: type, encoding: encoding, headers: headers)
    }

    /// The bytes a `Range: bytes=…` header asks for in a file of `size` bytes: nil when it is not
    /// one range of bytes (then the whole file is sent), `.some(nil)` when it starts past the end.
    static func byteRange(_ header: String, size: Int) -> Range<Int>?? {
        let header = header.trimmingCharacters(in: .whitespaces)
        guard header.lowercased().hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).trimmingCharacters(in: .whitespaces)
        guard !spec.contains(","), let dash = spec.firstIndex(of: "-") else { return nil }
        let first = spec[..<dash].trimmingCharacters(in: .whitespaces)
        let last = spec[spec.index(after: dash)...].trimmingCharacters(in: .whitespaces)
        if first.isEmpty {
            // The last n bytes.
            guard let count = Int(last), count > 0 else { return nil }
            guard size > 0 else { return .some(nil) }
            return .some(max(0, size - count)..<size)
        }
        guard let start = Int(first), start >= 0 else { return nil }
        guard start < size else { return .some(nil) }
        guard !last.isEmpty else { return .some(start..<size) }
        guard let end = Int(last), end >= start else { return nil }
        return .some(start..<min(end + 1, size))
    }

    /// Where 開啟完整頁面 loads `file` from: a page in an `artifacts` folder through
    /// `ccb-preview:` (WebKit will not play a video beside a page it was handed as data with a
    /// `file:` base, and the scheme answers it in byte ranges); anything else as it is.
    public static func windowURL(for file: URL) -> URL {
        guard isArtifactPage(file) else { return file }
        let real = file.standardizedFileURL.resolvingSymlinksInPath()
        guard artifactsFolder(of: real) != nil else { return file }
        let date = (try? FileManager.default.attributesOfItem(atPath: real.path))?[.modificationDate] as? Date
        return previewURL(for: real, version: date)
    }

    /// What a file window loads a text file as, so WebKit reads it as UTF-8: a page as a page,
    /// plain text as text, and Markdown, JSON and logs as their source (`shownAsSource`) rather
    /// than as a download or a viewer of WebKit's own. Nil: not a text file the window reads.
    public static func windowTextType(forExtension ext: String) -> String? {
        let ext = ext.lowercased()
        if shownAsSource.contains(ext) { return "text/plain" }
        guard let type = mimeTypes[ext], type == "text/html" || type == "text/plain" else { return nil }
        return type
    }

    static let shownAsSource: Set<String> = ["md", "json", "log"]

    static let mimeTypes: [String: String] = [
        "html": "text/html", "htm": "text/html", "css": "text/css", "js": "application/javascript",
        "mjs": "application/javascript", "json": "application/json", "txt": "text/plain", "csv": "text/plain",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "ico": "image/x-icon", "heic": "image/heic", "heif": "image/heif", "avif": "image/avif",
        "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff", "mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime", "webm": "video/webm",
        "ogv": "video/ogg", "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
        "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac", "aiff": "audio/aiff", "aif": "audio/aiff",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf", "wasm": "application/wasm",
    ]
}

/// Pictures a component's data names by file path (`"/Users/me/p/chart.png"`, `~/…`, `file://…`).
/// Its sandboxed frame cannot open `file:` URLs, so each picture that is there on disk is served
/// through `ccb-preview:` like a result page, and the page hands the template a map from the path
/// as written to the URL to load (`ccb.image(path)`). Only those picture files are served.
public enum ComponentImages {
    static var extensions: Set<String> { ImageFile.extensions }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var pictures: Set<String> = []

    public static func isImage(_ url: URL) -> Bool {
        extensions.contains(url.pathExtension.lowercased())
    }

    /// The pictures `data` (a component's JSON) names that exist, each from the text as written
    /// to the `ccb-preview:` URL its frame loads it from. Empty when it names none.
    public static func urls(in data: String) -> [String: String] {
        guard data.contains("/"), let object = try? JSONSerialization.jsonObject(with: Data(data.utf8), options: [.fragmentsAllowed]) else { return [:] }
        var found: [String: String] = [:]
        func visit(_ value: Any) {
            switch value {
            case let text as String:
                guard found[text] == nil, text.count < 4096, let file = PagePreview.fileURL(from: text), isImage(file) else { return }
                let real = file.resolvingSymlinksInPath()
                guard let attributes = try? FileManager.default.attributesOfItem(atPath: real.path),
                      (attributes[.type] as? FileAttributeType) != .typeDirectory else { return }
                allow(real)
                found[text] = PagePreview.previewURL(for: real, version: attributes[.modificationDate] as? Date).absoluteString
            case let list as [Any]:
                list.forEach(visit)
            case let object as [String: Any]:
                object.values.forEach(visit)
            default:
                break
            }
        }
        visit(object)
        return found
    }

    static func allow(_ file: URL) {
        lock.lock()
        defer { lock.unlock() }
        pictures.insert(file.path)
    }

    /// `file` (symlinks resolved) is a picture some component's data named.
    static func allows(_ file: URL) -> Bool {
        guard isImage(file) else { return false }
        lock.lock()
        defer { lock.unlock() }
        return pictures.contains(file.path)
    }
}

/// Pictures of result pages for 「網頁預覽卡片」: a card shows one as an `<img>` instead of
/// loading the page itself in a frame, so a chat with many cards does not run all their pages.
/// A picture is kept per page and change date (a page written again gets a new one), in the
/// app's caches folder; the app takes them (`maker`, an offscreen view) one page at a time.
public enum PageShots {
    static let host = "shot"
    /// At most this many pictures are kept; the oldest go first.
    static let limit = 400

    nonisolated(unsafe) public static var folder: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appending(path: "ClaudeCodeBot/page-shots")
    /// Takes a picture of `page` (a `ccb-preview:` URL) and writes it as JPEG to `destination`.
    /// Unset (tests, snapshot runs), no pictures are taken and cards load their pages.
    nonisolated(unsafe) public static var maker: (@Sendable (_ page: URL, _ destination: URL) -> Void)?

    private static let lock = NSLock()
    nonisolated(unsafe) private static var asked: Set<String> = []

    /// The picture's name for `file` as it was at `version`.
    static func name(for file: URL, version: Date?) -> String {
        let stamp = version.map { String(Int($0.timeIntervalSince1970)) } ?? "-"
        let hash = SHA256.hash(data: Data("\(file.standardizedFileURL.path)\n\(stamp)".utf8))
        return hash.prefix(16).map { String(format: "%02x", $0) }.joined() + ".jpg"
    }

    /// Where the card loads the picture of `file` from, when there is one; otherwise asks the
    /// maker for one (once per page and version) and gives nil.
    public static func shot(for file: URL, version: Date?) -> URL? {
        let name = name(for: file, version: version)
        let picture = folder.appending(path: name)
        if FileManager.default.fileExists(atPath: picture.path) {
            var components = URLComponents()
            components.scheme = PagePreview.scheme
            components.host = host
            components.path = "/" + name
            return components.url
        }
        guard let maker else { return nil }
        lock.lock()
        let first = asked.insert(name).inserted
        lock.unlock()
        if first { maker(PagePreview.previewURL(for: file, version: version), picture) }
        return nil
    }

    /// The picture a `ccb-preview://shot/<name>` request asks for: only a name this made.
    static func file(named name: String) -> URL? {
        guard name.count == 36, name.hasSuffix(".jpg"), name.dropLast(4).allSatisfy(\.isHexDigit) else { return nil }
        let picture = folder.appending(path: name)
        return FileManager.default.fileExists(atPath: picture.path) ? picture : nil
    }

    /// Removes the oldest pictures past `limit`.
    public static func prune() {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(keys)),
              files.count > limit else { return }
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: keys).contentModificationDate) ?? .distantPast) }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(limit) { try? FileManager.default.removeItem(at: file) }
    }

    /// Forgets which pages were asked for (tests).
    static func reset() {
        lock.lock()
        asked = []
        lock.unlock()
    }
}
