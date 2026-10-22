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

/// The Claude and Codex characters as vector art (the Claude Design "Two-Head Mascots",
/// component "Head"): Claude is the orange-haired girl with the orange flower and black ribbon,
/// Codex the white and lavender dragon girl with horns, a knot ornament and elf ears. One SVG,
/// drawn in a 64×64 box, for both the web chat and the app's own views.
public enum Chibi {
    /// The expressions the app shows: what the head is doing now.
    public enum Mood: String, CaseIterable, Sendable {
        /// Awake, ready for the next message.
        case normal
        /// Running a turn: eyes down at a laptop.
        case work
        /// Waiting on you (an OK to give): a "?".
        case think
        /// Session stopped: eyes closed, "zz".
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
        var parts: [String] = []
        parts.append(head == .claude ? claude : codex)
        parts.append(face(head, mood: mood))
        if let hat { parts.append(hatSVG(hat)) }
        parts.append(props(head, mood: mood))
        let label = head.displayName
        return "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64' role='img' aria-label='\(label)'>" + parts.joined() + "</svg>"
    }

    /// `svg` as a data URL for an `<img>` or a CSS background (UTF-8, only what URLs need escaped).
    public static func dataURL(_ svg: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "#%&+?\"<>")
        return "data:image/svg+xml;charset=utf-8," + (svg.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    // MARK: - The art

    /// Shown under the face: the hair, the face, the bangs and the character's own ornament.
    private static let claude = """
    <path d='M12 36 C10 22 20 14 32 14 C44 14 54 22 52 36 L54 58 C50 61 46 59 44 55 L20 55 C18 59 14 61 10 58 Z' fill='#E2762A'/>\
    <ellipse cx='32' cy='39' rx='15' ry='14' fill='#FFE6D5'/>\
    <path d='M16 37 C15 24 23 17 32 17 C41 17 49 24 48 37 C45 31 42 28 38 27 C37 31 34 32 32 30 C30 32 27 31 26 27 C22 28 19 31 16 37 Z' fill='#EA8434'/>\
    <path d='M24 21 C27 19 30 18.5 33 18.6' stroke='#F7B072' stroke-width='1.4' fill='none' stroke-linecap='round'/>\
    <path d='M31 16 C29.5 10.5 34 8.5 36.5 10.5' stroke='#E2762A' stroke-width='2' fill='none' stroke-linecap='round'/>\
    <path d='M45 29.5 L40.5 33.5 L45 33.5 Z M47 29.5 L51.5 33.5 L47 33.5 Z' fill='#2A2220'/>\
    <path d='M45.5 33 L44 40 M46.5 33 L48 40' stroke='#2A2220' stroke-width='1.2'/>\
    <g transform='translate(46 25)'>\
    <circle cx='0' cy='-3.8' r='2.3' fill='#F6A04A'/><circle cx='0' cy='3.8' r='2.3' fill='#F6A04A'/>\
    <circle cx='-3.8' cy='0' r='2.3' fill='#F6A04A'/><circle cx='3.8' cy='0' r='2.3' fill='#F6A04A'/>\
    <circle cx='-2.7' cy='-2.7' r='2.1' fill='#F08A2E'/><circle cx='2.7' cy='-2.7' r='2.1' fill='#F08A2E'/>\
    <circle cx='-2.7' cy='2.7' r='2.1' fill='#F08A2E'/><circle cx='2.7' cy='2.7' r='2.1' fill='#F08A2E'/>\
    <circle cx='0' cy='0' r='2.2' fill='#B04A12'/></g>
    """

    private static let codex = """
    <path d='M21 22 C14 15 13.5 7 17.5 2.5 C18.5 8.5 22 13 27 16.5 Z' fill='#ECE8F7' stroke='#9F96CF' stroke-width='1'/>\
    <path d='M43 22 C50 15 50.5 7 46.5 2.5 C45.5 8.5 42 13 37 16.5 Z' fill='#ECE8F7' stroke='#9F96CF' stroke-width='1'/>\
    <path d='M17 9 L20 10 M17.5 13 L21.5 13.5 M47 9 L44 10 M46.5 13 L42.5 13.5' stroke='#B5ADDC' stroke-width='0.9'/>\
    <path d='M12 36 C10 22 20 14 32 14 C44 14 54 22 52 36 L54 58 C50 61 46 59 44 55 L20 55 C18 59 14 61 10 58 Z' fill='#F2F0FA' stroke='#C9C1E6' stroke-width='0.9'/>\
    <path d='M17.5 37 L7 31 L17.5 45 Z' fill='#FFE9E3' stroke='#E3B9B0' stroke-width='0.7'/>\
    <path d='M46.5 37 L57 31 L46.5 45 Z' fill='#FFE9E3' stroke='#E3B9B0' stroke-width='0.7'/>\
    <ellipse cx='32' cy='39' rx='15' ry='14' fill='#FFF1EC'/>\
    <path d='M16 37 C15 24 23 17 32 17 C41 17 49 24 48 37 C45 31 42 28 38 27 C37 31 34 32 32 30 C30 32 27 31 26 27 C22 28 19 31 16 37 Z' fill='#F8F6FD' stroke='#C9C1E6' stroke-width='0.9'/>\
    <path d='M31 16 C29.5 10.5 34 8.5 36.5 10.5' stroke='#C9C1E6' stroke-width='1.8' fill='none' stroke-linecap='round'/>\
    <circle cx='46.5' cy='26' r='3.6' fill='#FFFFFF' stroke='#5B53A6' stroke-width='1.6'/>\
    <circle cx='46.5' cy='26' r='1.3' fill='#5B53A6'/>\
    <path d='M46.5 29.8 L46.5 36' stroke='#8B83C6' stroke-width='1.3'/>\
    <rect x='45.2' y='35.5' width='2.6' height='4' rx='1' fill='#B9B2E0'/>
    """

    /// The eyes, blush and mouth for a mood.
    private static func face(_ head: BotEngine, mood: Mood) -> String {
        let eye = head == .claude ? "#A44E16" : "#5F55B8"
        var out = ""
        switch mood {
        case .normal, .think:
            out += "<ellipse cx='26' cy='41' rx='2.6' ry='3.3' fill='\(eye)'/><ellipse cx='38' cy='41' rx='2.6' ry='3.3' fill='\(eye)'/>"
            out += "<circle cx='25.1' cy='39.6' r='1' fill='#FFFFFF'/><circle cx='37.1' cy='39.6' r='1' fill='#FFFFFF'/>"
        case .work, .sleep:
            out += "<path d='M23.2 41.5 Q26 43.6 28.8 41.5' stroke='\(eye)' stroke-width='2' fill='none' stroke-linecap='round'/>"
            out += "<path d='M35.2 41.5 Q38 43.6 40.8 41.5' stroke='\(eye)' stroke-width='2' fill='none' stroke-linecap='round'/>"
        }
        out += "<ellipse cx='21.5' cy='45.5' rx='2.4' ry='1.2' fill='#F6A28A' opacity='0.55'/><ellipse cx='42.5' cy='45.5' rx='2.4' ry='1.2' fill='#F6A28A' opacity='0.55'/>"
        switch mood {
        case .normal, .work:
            out += "<path d='M30.3 47.2 Q32 48.8 33.7 47.2' stroke='#8A4A3A' stroke-width='1.1' fill='none' stroke-linecap='round'/>"
        case .sleep, .think:
            out += "<circle cx='32' cy='48' r='1.1' fill='#8A4A3A'/>"
        }
        return out
    }

    /// The bot's face on top, with a brim.
    private static func hatSVG(_ hat: Hat) -> String {
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

    /// What a mood holds: a laptop at work, "zz" asleep, "?" waiting.
    private static func props(_ head: BotEngine, mood: Mood) -> String {
        let accent = head == .claude ? "#E2762A" : "#7E74CC"
        switch mood {
        case .normal:
            return ""
        case .work:
            return "<path d='M14 64 L18 51 L46 51 L50 64 Z' fill='#B9BCC4' stroke='#6E717A' stroke-width='0.8'/><circle cx='32' cy='57.5' r='1.6' fill='#8E9199'/>"
        case .sleep:
            return "<g fill='\(accent)' font-family='system-ui, -apple-system, sans-serif' font-weight='800'><text x='49' y='16' font-size='9'>z</text><text x='55' y='9' font-size='7'>z</text></g>"
        case .think:
            return "<text x='51' y='15' font-size='13' font-weight='800' fill='\(accent)' font-family='system-ui, -apple-system, sans-serif'>?</text>"
        }
    }

    /// A number for SVG: at most two decimals, no trailing zeros.
    public static func format(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded() { return String(Int(rounded)) }
        return String(format: "%.2f", rounded).replacingOccurrences(of: #"0$"#, with: "", options: .regularExpression)
    }
}
