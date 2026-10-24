import Foundation

/// How bots look (Settings → General → Bot look): plain faces with C/X marks, as always, or the
/// Claude and Codex characters, with either or both engines enabled.
public enum BotLook: String, Codable, CaseIterable, Sendable {
    /// The bot's own face on every reply, "C X" letters under lines, "C + X" in the left column.
    case original
    /// Claude and Codex drawn as characters ("Cute"): each reply under its
    /// character wearing the bot's face as a hat, two tiny heads as seen marks, the characters
    /// behind the bot's face in the left column and beside each head under Now.
    case cute

    public var displayName: String {
        switch self {
        case .original: L("Original")
        case .cute: L("Cute")
        }
    }
}

/// Claude and Codex from the supplied character pack, with the bot's face composited
/// as a hat in an SVG wrapper shared by native views and the web chat.
public enum Chibi {
    /// The expressions the app shows: what the head is doing now.
    public enum Mood: String, CaseIterable, Sendable {
        /// Awake, ready for the next message.
        case normal
        /// Running a turn.
        case work
        /// Waiting on you (an OK to give).
        case think
        /// Session stopped.
        case sleep
    }

    /// A head's mood from what its process is doing; the app's words for it are asleep, working,
    /// waiting for your OK and awake.
    public static func mood(asleep: Bool, working: Bool, waiting: Bool) -> Mood {
        if asleep { return .sleep }
        if waiting { return .think }
        if working { return .work }
        return .normal
    }

    /// The bot's own face worn as a hat: its shape's outline (SVG path data in the 64×64 box),
    /// its color ("#RRGGBB"), and where its two eyes sit.
    public struct Hat: Equatable, Sendable {
        public var path: String
        public var color: String
        public var eyes: [(x: Double, y: Double)]

        public init(path: String, color: String, eyes: [(x: Double, y: Double)]) {
            self.path = path
            self.color = color
            self.eyes = eyes
        }

        /// Where the hat sits in the 64×64 box: the bot's shape is drawn in this square.
        public static let box = (x: 22.5, y: 1.5, size: 19.0)

        public static func == (a: Hat, b: Hat) -> Bool {
            a.path == b.path && a.color == b.color && a.eyes.map(\.x) == b.eyes.map(\.x) && a.eyes.map(\.y) == b.eyes.map(\.y)
        }
    }

    /// The head as an SVG document. `hat` nil: no bot face on top (seen marks, and the left
    /// column, where the bot's own face is in front).
    public static func svg(_ head: BotEngine, mood: Mood = .normal, hat: Hat? = nil) -> String {
        svg(head, hat: hat, art: assetData(head, mood: mood))
    }

    /// Navigation can retain the bot's shape avatar if an optional character asset is
    /// absent or unreadable, without initializing the required full character pack.
    public static func svgIfAvailable(_ head: BotEngine, mood: Mood = .normal, hat: Hat? = nil) -> String? {
        guard let url = findAssetURL(head, mood: mood), let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        return svg(head, hat: hat, art: data)
    }

    private static func svg(_ head: BotEngine, hat: Hat?, art data: Data) -> String {
        var parts: [String] = []
        let art = data.base64EncodedString()
        // Reserve the upper strip for the bot hat without cropping hair or horns.
        let y = hat == nil ? 0 : 18
        let height = hat == nil ? 64 : 46
        parts.append("<image x='0' y='\(y)' width='64' height='\(height)' preserveAspectRatio='xMidYMax meet' href='data:image/png;base64,\(art)'/>")
        if let hat { parts.append(hatSVG(hat)) }
        let label = head.displayName
        return "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64' role='img' aria-label='\(label)'>" + parts.joined() + "</svg>"
    }

    /// `svg` as a data URL for an `<img>` or a CSS background (UTF-8, only what URLs need escaped).
    public static func dataURL(_ svg: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "#%&+?\"<>")
        return "data:image/svg+xml;charset=utf-8," + (svg.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// The archive calls the white-haired character `gpt`; it represents Codex here.
    public static func assetURL(_ head: BotEngine, mood: Mood = .normal) -> URL {
        // These are required app resources: fail clearly if a packaged build omits them.
        findAssetURL(head, mood: mood)!
    }

    private static func findAssetURL(_ head: BotEngine, mood: Mood) -> URL? {
        let character = head == .claude ? "claude" : "gpt"
        let expression: String
        switch mood {
        case .normal: expression = "idle"
        case .work: expression = "working"
        case .think: expression = "thinking"
        case .sleep: expression = "sleepy"
        }
        return CoreResources.bundle.url(forResource: expression, withExtension: "png",
                                 subdirectory: "CharacterArt/avatars-static/\(character)")
    }

    private static let art: [BotEngine: [Mood: Data]] = Dictionary(uniqueKeysWithValues:
        BotEngine.allCases.map { head in
            (head, Dictionary(uniqueKeysWithValues: Mood.allCases.map { mood in
                (mood, try! Data(contentsOf: assetURL(head, mood: mood)))
            }))
        })

    public static func assetData(_ head: BotEngine, mood: Mood = .normal) -> Data {
        art[head]![mood]!
    }

    /// The bot's face on top, with a brim.
    public static func hatSVG(_ hat: Hat) -> String {
        let box = Hat.box
        let brimY = box.y + box.size * 0.91
        var out = "<path d='\(hat.path)' fill='\(hat.color)' stroke='\(hat.color)' stroke-width='\(format(box.size * 0.08))' stroke-linejoin='round'/>"
        out += "<ellipse cx='32' cy='\(format(brimY))' rx='13' ry='2.8' fill='\(hat.color)'/>"
        out += "<ellipse cx='32' cy='\(format(brimY))' rx='13' ry='2.8' fill='#000000' opacity='0.22'/>"
        for eye in hat.eyes {
            out += "<ellipse cx='\(format(eye.x))' cy='\(format(eye.y))' rx='1.5' ry='2.1' fill='#16161A'/>"
            out += "<circle cx='\(format(eye.x - 0.4))' cy='\(format(eye.y - 0.8))' r='0.55' fill='#FFFFFF'/>"
        }
        return out
    }

    /// A number for SVG: at most two decimals, no trailing zeros.
    public static func format(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded() { return String(Int(rounded)) }
        return String(format: "%.2f", rounded).replacingOccurrences(of: #"0$"#, with: "", options: .regularExpression)
    }
}
