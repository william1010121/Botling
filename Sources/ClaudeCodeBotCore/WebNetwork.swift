import Foundation

// A web bot's network traffic, as the page itself sees it: a small script put in the page before
// its own wraps fetch, XHR, EventSource and WebSocket and hands the app each request and each
// piece of every answer (Resources/web-capture/net-tap.js). The app keeps the last minutes of it
// in memory, gives the page reader what it declares it reads, and writes it into a capture
// (`WebCapturePack`) when you press Capture. Nothing here sends a request.

/// One thing the page's traffic did: a request went out, its answer started, a piece of it came,
/// it ended or failed; a WebSocket sent or got a message.
public struct WebNetEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case fetch, xhr, sse, ws
    }

    public enum Phase: String, Codable, Sendable {
        /// A request went out (a WebSocket or EventSource opened).
        case request
        /// Its answer's status and headers.
        case response
        /// A piece of its answer's body (an EventSource's event).
        case chunk
        /// A WebSocket message the page sent.
        case send
        /// A WebSocket message the page got.
        case message
        /// The answer ended (a socket closed).
        case end
        case error
    }

    /// When, in milliseconds since 1970.
    public var t: Double
    /// The request it belongs to (every event of one request has the same id).
    public var id: String
    public var kind: Kind
    public var phase: Phase
    public var url: String?
    public var method: String?
    public var status: Int?
    public var headers: [String: String]?
    public var contentType: String?
    /// The request's body, a piece of the answer, or a message.
    public var body: String?
    /// Why a body was left out ("binary", "too large"), or the error.
    public var note: String?

    public init(t: Double, id: String, kind: Kind, phase: Phase, url: String? = nil, method: String? = nil, status: Int? = nil,
                headers: [String: String]? = nil, contentType: String? = nil, body: String? = nil, note: String? = nil) {
        self.t = t
        self.id = id
        self.kind = kind
        self.phase = phase
        self.url = url
        self.method = method
        self.status = status
        self.headers = headers
        self.contentType = contentType
        self.body = body
        self.note = note
    }

    /// From the tap's message (a dictionary the web view hands over); nil for anything else.
    public init?(message: Any) {
        guard let object = message as? [String: Any],
              let id = object["id"] as? String, !id.isEmpty,
              let kind = (object["kind"] as? String).flatMap(Kind.init(rawValue:)),
              let phase = (object["phase"] as? String).flatMap(Phase.init(rawValue:)) else { return nil }
        self.id = id
        self.kind = kind
        self.phase = phase
        t = (object["t"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
        url = object["url"] as? String
        method = object["method"] as? String
        status = (object["status"] as? NSNumber)?.intValue
        if let raw = object["headers"] as? [String: Any] {
            headers = raw.compactMapValues { $0 as? String }
        }
        contentType = object["contentType"] as? String
        body = object["body"] as? String
        note = object["note"] as? String
    }

    /// About how much memory and disk it takes.
    public var size: Int {
        (body?.utf8.count ?? 0) + (url?.utf8.count ?? 0) + (headers?.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count } ?? 0) + 64
    }

    /// One line of `events.jsonl`.
    public func jsonLine() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    /// `events.jsonl`'s lines back; lines that are not events are skipped.
    public static func parse(jsonl text: String) -> [WebNetEvent] {
        let decoder = JSONDecoder()
        return text.split(whereSeparator: \.isNewline).compactMap { try? decoder.decode(WebNetEvent.self, from: Data($0.utf8)) }
    }
}

/// What a recording holds so far: the capture panel's numbers.
public struct WebNetCounts: Equatable, Sendable {
    public var requests = 0
    /// Answers that came in more than one piece, EventSources and WebSockets.
    public var streams = 0
    public var bytes = 0

    public init(requests: Int = 0, streams: Int = 0, bytes: Int = 0) {
        self.requests = requests
        self.streams = streams
        self.bytes = bytes
    }

    public static func of(_ events: [WebNetEvent]) -> WebNetCounts {
        var counts = WebNetCounts()
        var pieces: [String: Int] = [:]
        var streamed = Set<String>()
        for event in events {
            counts.bytes += event.size
            switch event.phase {
            case .request: counts.requests += 1
            case .chunk:
                pieces[event.id, default: 0] += 1
                if event.kind == .sse || pieces[event.id]! > 1 { streamed.insert(event.id) }
            case .send, .message: streamed.insert(event.id)
            default: break
            }
        }
        counts.streams = streamed.count
        return counts
    }
}

/// A page's traffic of the last minutes, in memory only. While a capture records, nothing from
/// the recording (or the minutes before it) is dropped; it stops at its own limits.
public struct WebNetBuffer: Sendable {
    /// Kept this long when nothing records.
    public static let keepSeconds: Double = 5 * 60
    /// Never more than this while nothing records (the oldest go first).
    public static let keepBytes = 40 * 1_000_000

    public private(set) var events: [WebNetEvent] = []
    public private(set) var bytes = 0
    /// While a capture records: when it started (ms); everything from `keepSeconds` before it stays.
    public private(set) var recordingSince: Double?

    public init() {}

    public mutating func append(_ event: WebNetEvent, now: Double? = nil) {
        events.append(event)
        bytes += event.size
        prune(now: now ?? event.t)
    }

    /// Drops what is older than `keepSeconds` (from the recording's start while one records) and,
    /// while nothing records, the oldest beyond `keepBytes`.
    public mutating func prune(now: Double) {
        let from = (recordingSince ?? now) - Self.keepSeconds * 1000
        var drop = events.prefix { $0.t < from }.count
        if recordingSince == nil {
            var left = bytes - events.prefix(drop).reduce(0) { $0 + $1.size }
            while left > Self.keepBytes, drop < events.count {
                left -= events[drop].size
                drop += 1
            }
        }
        guard drop > 0 else { return }
        bytes -= events.prefix(drop).reduce(0) { $0 + $1.size }
        events.removeFirst(drop)
    }

    public mutating func startRecording(at now: Double) {
        recordingSince = now
    }

    /// Ends the recording: what it holds, from `keepSeconds` before it started.
    public mutating func stopRecording(at now: Double) -> [WebNetEvent] {
        let since = (recordingSince ?? now) - Self.keepSeconds * 1000
        recordingSince = nil
        let held = events.filter { $0.t >= since }
        prune(now: now)
        return held
    }

    /// What came since `ms` (the recording's own part, for its numbers and limits).
    public func events(since ms: Double) -> [WebNetEvent] {
        guard let start = events.firstIndex(where: { $0.t >= ms }) else { return [] }
        return Array(events[start...])
    }
}

/// One request and its whole answer, put together from its events: what a page reader's
/// `extractNetwork` gets.
public struct WebNetExchange: Codable, Equatable, Sendable {
    public struct Message: Codable, Equatable, Sendable {
        /// "out" (the page sent it) or "in".
        public var dir: String
        public var data: String
        public var t: Double
    }

    public var id: String
    public var kind: WebNetEvent.Kind
    public var method: String
    public var url: String
    public var status: Int?
    public var requestHeaders: [String: String]
    public var responseHeaders: [String: String]
    public var contentType: String?
    public var requestBody: String?
    /// Every piece of the answer, in order, as one text (fetch and XHR, an SSE stream read by fetch too).
    public var responseBody: String
    /// An EventSource's events and a WebSocket's messages.
    public var messages: [Message]
    public var startedAt: Double
    public var endedAt: Double?
    public var done: Bool
    public var note: String?

    /// Each request's events, joined, in the order the requests went out.
    public static func assemble(_ events: [WebNetEvent]) -> [WebNetExchange] {
        var order: [String] = []
        var byID: [String: WebNetExchange] = [:]
        for event in events {
            if byID[event.id] == nil {
                order.append(event.id)
                byID[event.id] = WebNetExchange(id: event.id, kind: event.kind, method: event.method ?? (event.kind == .ws ? "GET" : "GET"),
                                                url: event.url ?? "", status: nil, requestHeaders: [:], responseHeaders: [:], contentType: nil,
                                                requestBody: nil, responseBody: "", messages: [], startedAt: event.t, endedAt: nil, done: false, note: nil)
            }
            var exchange = byID[event.id]!
            switch event.phase {
            case .request:
                if let url = event.url { exchange.url = url }
                if let method = event.method { exchange.method = method }
                exchange.requestHeaders = event.headers ?? [:]
                exchange.requestBody = event.body
                exchange.startedAt = event.t
            case .response:
                exchange.status = event.status
                exchange.responseHeaders = event.headers ?? [:]
                exchange.contentType = event.contentType
                if let url = event.url, !url.isEmpty, exchange.url.isEmpty { exchange.url = url }
            case .chunk:
                if exchange.kind == .sse {
                    exchange.messages.append(Message(dir: "in", data: event.body ?? "", t: event.t))
                } else {
                    exchange.responseBody += event.body ?? ""
                }
            case .send:
                exchange.messages.append(Message(dir: "out", data: event.body ?? "", t: event.t))
            case .message:
                exchange.messages.append(Message(dir: "in", data: event.body ?? "", t: event.t))
            case .end:
                exchange.done = true
                exchange.endedAt = event.t
                if let note = event.note { exchange.note = note }
            case .error:
                exchange.done = true
                exchange.endedAt = event.t
                exchange.note = event.note ?? "error"
            }
            if let note = event.note, exchange.note == nil { exchange.note = note }
            byID[event.id] = exchange
        }
        return order.compactMap { byID[$0] }
    }

    /// The exchanges whose URL matches one of `patterns` (regular expressions, as a page reader's
    /// `NETWORK.urls` declares them); all of them when it declares none. A
    /// pattern also matches as plain text (`"log?format"`).
    public static func matching(_ exchanges: [WebNetExchange], patterns: [String]) -> [WebNetExchange] {
        guard !patterns.isEmpty else { return exchanges }
        let expressions = patterns.map { (text: $0, regex: try? NSRegularExpression(pattern: $0)) }
        return exchanges.filter { exchange in
            let range = NSRange(exchange.url.startIndex..., in: exchange.url)
            return expressions.contains { exchange.url.contains($0.text) || $0.regex?.firstMatch(in: exchange.url, range: range) != nil }
        }
    }

    /// As JSON, for the page reader.
    public static func json(_ exchanges: [WebNetExchange]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return (try? encoder.encode(exchanges)).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
    }
}

/// Before anything is written to disk: sign-in cookies, tokens, CSRF values and account ids are
/// replaced by "[redacted]". The conversation's words stay (an e-mail address in them too is
/// masked, since an account's address shows up in the page and its traffic).
public struct WebRedactor: Sendable {
    /// What was masked, by kind (the manifest lists it).
    public private(set) var counts: [String: Int] = [:]
    /// Secret values masked somewhere (an account's id in a path, a token in a field): masked
    /// wherever else they show up too.
    private var learned: Set<String> = []

    public init() {}

    public static let mask = "[redacted]"

    /// Header names whose values are secrets.
    static let secretHeader = try! NSRegularExpression(pattern: "cookie|auth|token|csrf|xsrf|session|sentinel|secret|api-?key|device-id|client-data|signature|x-goog-|x-client-|x-user|x-account|x-org", options: [.caseInsensitive])
    /// Field names (query, form and JSON) whose values are secrets or say who you are.
    static let secretField = try! NSRegularExpression(pattern: "^(at|sid|f\\.sid|authuser|key|psid|bl_?token)$|token|secret|passw|csrf|xsrf|session|cookie|auth(?!or)|api_?key|e-?mail|account|user_?id|userid|org(ani[sz]ation)?_?(id|uuid)|device_?id|phone|^(given_name|family_name|full_name|display_name|picture|avatar|avatar_url)$", options: [.caseInsensitive])
    /// A path segment after one of these is an account's id.
    static let accountParents: Set<String> = ["organizations", "organization", "orgs", "accounts", "account", "users", "user"]
    static let email = try! NSRegularExpression(pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    /// A JWT, a bearer token, or a long opaque key.
    static let token = try! NSRegularExpression(pattern: "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}|(?i:bearer)\\s+[A-Za-z0-9._~+/=-]{16,}|\\b(sk|pk|sess|rt)-[A-Za-z0-9_-]{20,}")
    /// `"accessToken": "…"` and the like in text that is not whole JSON (a stream, a page's script).
    static let quotedSecret = try! NSRegularExpression(pattern: "(\\\\?\"(?:[A-Za-z_]*(?:[Tt]oken|[Ss]ecret|[Cc]srf|[Xx]srf|[Ss]ession[A-Za-z_]*|SNlM0e|FdrFJe|cfb2h|oPEP7c|WZsZ1e|qwAQke|S06Grb|W3Yyqf|email|Email|accountId|account_id|userId|user_id|organization_uuid|organizationUuid))\\\\?\"\\s*:\\s*\\\\?\")((?:[^\"\\\\]|\\\\.)*?)(\\\\?\")")

    mutating func note(_ kind: String, _ count: Int = 1) {
        guard count > 0 else { return }
        counts[kind, default: 0] += count
    }

    public mutating func redact(_ events: [WebNetEvent]) -> [WebNetEvent] {
        let first = events.map { event in
            var event = event
            if let url = event.url { event.url = redact(url: url) }
            if let headers = event.headers { event.headers = redact(headers: headers) }
            if let body = event.body { event.body = redact(body: body, contentType: event.phase == .request ? event.headers?.first { $0.key.lowercased() == "content-type" }?.value : event.contentType) }
            if let note = event.note { event.note = redact(text: note) }
            return event
        }
        guard !learned.isEmpty else { return first }
        return first.map { event in
            var event = event
            event.url = event.url.map { forgetLearned(in: $0) }
            event.body = event.body.map { forgetLearned(in: $0) }
            return event
        }
    }

    /// Learned secrets that show up again (an org's id in another answer's text).
    public mutating func forgetLearned(in text: String) -> String {
        var text = text
        for value in learned.sorted(by: { $0.count > $1.count }) where text.contains(value) {
            note("known values", text.components(separatedBy: value).count - 1)
            text = text.replacingOccurrences(of: value, with: Self.mask)
        }
        return text
    }

    mutating func learn(_ value: String) {
        let value = value.removingPercentEncoding ?? value
        if value.count >= 8, value != Self.mask { learned.insert(value) }
    }

    public mutating func redact(headers: [String: String]) -> [String: String] {
        var out = headers
        for (name, value) in headers where Self.matches(Self.secretHeader, name) && value != Self.mask {
            out[name] = Self.mask
            note("headers")
        }
        return out
    }

    public mutating func redact(url text: String) -> String {
        guard var parts = URLComponents(string: text) else { return redact(text: text) }
        var changed = false
        let segments = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var path = segments
        for index in segments.indices.dropFirst() where Self.accountParents.contains(segments[index - 1].lowercased()) && !segments[index].isEmpty {
            learn(segments[index])
            path[index] = "redacted"
            note("account ids")
            changed = true
        }
        if changed { parts.percentEncodedPath = path.joined(separator: "/") }
        if let items = parts.percentEncodedQueryItems {
            parts.percentEncodedQueryItems = items.map { item in
                guard let value = item.value, Self.matches(Self.secretField, item.name) else { return item }
                learn(value)
                note("query values")
                changed = true
                return URLQueryItem(name: item.name, value: "redacted")
            }
        }
        let url = changed ? (parts.string ?? text) : text
        return redact(text: url)
    }

    /// A request's or answer's body: JSON by its fields, a form by its fields, any other text by
    /// the patterns tokens and addresses have.
    public mutating func redact(body: String, contentType: String?) -> String {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.first == "{" || trimmed.first == "[", let data = trimmed.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
            let cleaned = redact(json: object)
            if let out = try? JSONSerialization.data(withJSONObject: cleaned, options: [.fragmentsAllowed, .withoutEscapingSlashes, .sortedKeys]) {
                return redact(text: String(decoding: out, as: UTF8.self))
            }
        }
        let isForm = contentType?.lowercased().contains("x-www-form-urlencoded") == true
            || (!trimmed.contains(" ") && !trimmed.contains("\n") && trimmed.contains("=") && !trimmed.hasPrefix("data:"))
        if isForm {
            let pairs = trimmed.split(separator: "&", omittingEmptySubsequences: false).map { pair -> String in
                let bits = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard bits.count == 2 else { return String(pair) }
                let name = String(bits[0]).removingPercentEncoding ?? String(bits[0])
                guard Self.matches(Self.secretField, name) else { return String(pair) }
                learn(String(bits[1]))
                note("form values")
                return "\(bits[0])=redacted"
            }
            return redact(text: pairs.joined(separator: "&"))
        }
        return redact(text: body)
    }

    public mutating func redact(json: Any, parent: String = "") -> Any {
        if let object = json as? [String: Any] {
            var out: [String: Any] = [:]
            // Inside a user, an account or an organization, its id and its name say who you are.
            let personal = Self.matches(Self.accountObject, parent)
            for (key, value) in object {
                let secret = Self.matches(Self.secretField, key) || (personal && Self.matches(Self.identityField, key))
                if secret, value is String || value is NSNumber {
                    if let text = value as? String { learn(text) }
                    out[key] = Self.mask
                    note("json fields")
                } else {
                    out[key] = redact(json: value, parent: key)
                }
            }
            return out
        }
        if let array = json as? [Any] { return array.map { redact(json: $0, parent: parent) } }
        return json
    }

    /// An object that is a user, an account or an organization (by its key).
    static let accountObject = try! NSRegularExpression(pattern: "^(user|users|account|accounts|organization|organizations|org|orgs|member|members|memberships|profile|me|viewer|owner)$", options: [.caseInsensitive])
    /// Its fields that say who it is.
    static let identityField = try! NSRegularExpression(pattern: "^(id|uuid|name|full_name|display_name|username|handle)$", options: [.caseInsensitive])

    /// Tokens, quoted secrets and e-mail addresses in any text.
    public mutating func redact(text: String) -> String {
        var text = text
        text = replace(Self.quotedSecret, in: text, kind: "quoted secrets") { match, source in
            let ns = source as NSString
            return ns.substring(with: match.range(at: 1)) + Self.mask + ns.substring(with: match.range(at: 3))
        }
        text = replace(Self.token, in: text, kind: "tokens") { _, _ in Self.mask }
        text = replace(Self.email, in: text, kind: "e-mail addresses") { _, _ in "[email]" }
        return text
    }

    /// A page's HTML: its inline scripts' contents go (they carry the page's tokens and
    /// settings, and a page reader never needs them), then the patterns above.
    public mutating func redact(html: String) -> String {
        let script = try! NSRegularExpression(pattern: "(<script\\b[^>]*>)([\\s\\S]*?)(</script>)", options: [.caseInsensitive])
        let stripped = replace(script, in: html, kind: "inline scripts") { match, source in
            let ns = source as NSString
            guard match.range(at: 2).length > 0 else { return ns.substring(with: match.range) }
            return ns.substring(with: match.range(at: 1)) + "/* removed by ClaudeCodeBot */" + ns.substring(with: match.range(at: 3))
        }
        return redact(text: stripped)
    }

    private mutating func replace(_ expression: NSRegularExpression, in text: String, kind: String, with make: (NSTextCheckingResult, String) -> String) -> String {
        let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard !matches.isEmpty else { return text }
        var out = ""
        var last = text.startIndex
        var count = 0
        for match in matches {
            guard let range = Range(match.range, in: text) else { continue }
            let replacement = make(match, text)
            if replacement != String(text[range]) { count += 1 }
            out += text[last..<range.lowerBound]
            out += replacement
            last = range.upperBound
        }
        out += text[last...]
        note(kind, count)
        return out
    }

    static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool {
        expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}

/// The same traffic as a HAR file (1.2), so other tools (a browser's network panel, Charles)
/// open it. EventSource and WebSocket messages go in `_webSocketMessages`, as Chrome writes them.
public enum WebHAR {
    public static func make(_ exchanges: [WebNetExchange], pageURL: String, pageTitle: String?, startedAt: Double, appVersion: String) -> Data {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let time = { (ms: Double) in formatter.string(from: Date(timeIntervalSince1970: ms / 1000)) }
        let headerList = { (headers: [String: String]) in headers.sorted { $0.key < $1.key }.map { ["name": $0.key, "value": $0.value] } }
        let entries: [[String: Any]] = exchanges.map { exchange in
            let query = URLComponents(string: exchange.url)?.queryItems?.map { ["name": $0.name, "value": $0.value ?? ""] } ?? []
            var request: [String: Any] = [
                "method": exchange.method, "url": exchange.url, "httpVersion": "HTTP/1.1",
                "headers": headerList(exchange.requestHeaders), "queryString": query, "cookies": [],
                "headersSize": -1, "bodySize": exchange.requestBody?.utf8.count ?? 0,
            ]
            if let body = exchange.requestBody {
                request["postData"] = ["mimeType": exchange.requestHeaders.first { $0.key.lowercased() == "content-type" }?.value ?? "", "text": body]
            }
            var content: [String: Any] = ["size": exchange.responseBody.utf8.count, "mimeType": exchange.contentType ?? ""]
            if !exchange.responseBody.isEmpty { content["text"] = exchange.responseBody }
            if let note = exchange.note { content["comment"] = note }
            let ended = exchange.endedAt ?? exchange.startedAt
            var entry: [String: Any] = [
                "pageref": "page_1",
                "startedDateTime": time(exchange.startedAt),
                "time": max(0, ended - exchange.startedAt),
                "request": request,
                "response": [
                    "status": exchange.status ?? 0, "statusText": "", "httpVersion": "HTTP/1.1",
                    "headers": headerList(exchange.responseHeaders), "cookies": [], "content": content,
                    "redirectURL": "", "headersSize": -1, "bodySize": exchange.responseBody.utf8.count,
                ],
                "cache": [:],
                "timings": ["send": 0, "wait": 0, "receive": max(0, ended - exchange.startedAt)],
                "_resourceType": ["fetch": "fetch", "xhr": "xhr", "sse": "eventsource", "ws": "websocket"][exchange.kind.rawValue] ?? "other",
            ]
            if !exchange.messages.isEmpty {
                entry["_webSocketMessages"] = exchange.messages.map {
                    ["type": $0.dir == "out" ? "send" : "receive", "time": $0.t / 1000, "opcode": 1, "data": $0.data] as [String: Any]
                }
            }
            return entry
        }
        let log: [String: Any] = ["log": [
            "version": "1.2",
            "creator": ["name": "ClaudeCodeBot", "version": appVersion],
            "pages": [["id": "page_1", "title": pageTitle ?? pageURL, "startedDateTime": time(startedAt), "pageTimings": [:]]],
            "entries": entries,
        ] as [String: Any]]
        return (try? JSONSerialization.data(withJSONObject: log, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
    }
}
