import AppKit
import ClaudeCodeBotCore
import SwiftUI

extension AvatarShape {
    /// The bot's face worn as a hat on a character (Bot look Cute): its outline in the hat's
    /// square of the 64×64 box, its color, and its eyes where `AvatarView` puts them.
    var hat: Chibi.Hat {
        let box = Chibi.Hat.box
        let rect = CGRect(x: box.x, y: box.y, width: box.size, height: box.size)
        let shift: CGFloat = self == .moon ? -0.12 : 0
        let eyeY = rect.minY + (self == .moon ? 0.6 : self.eyeY) * rect.height
        return Chibi.Hat(
            path: Self.svgPath(path(in: rect)),
            color: hexString,
            eyes: [(Double(rect.minX + (0.36 + shift) * rect.width), Double(eyeY)), (Double(rect.minX + (0.64 + shift) * rect.width), Double(eyeY))]
        )
    }

    /// The color as "#RRGGBB".
    var hexString: String {
        let color = NSColor(self.color).usingColorSpace(.sRGB) ?? .black
        return String(format: "#%02X%02X%02X", Int((color.redComponent * 255).rounded()), Int((color.greenComponent * 255).rounded()), Int((color.blueComponent * 255).rounded()))
    }

    /// A SwiftUI path as SVG path data.
    static func svgPath(_ path: Path) -> String {
        var parts: [String] = []
        func p(_ point: CGPoint) -> String { "\(Chibi.format(Double(point.x))) \(Chibi.format(Double(point.y)))" }
        path.forEach { element in
            switch element {
            case .move(let to): parts.append("M\(p(to))")
            case .line(let to): parts.append("L\(p(to))")
            case .quadCurve(let to, let control): parts.append("Q\(p(control)) \(p(to))")
            case .curve(let to, let c1, let c2): parts.append("C\(p(c1)) \(p(c2)) \(p(to))")
            case .closeSubpath: parts.append("Z")
            }
        }
        return parts.joined(separator: " ")
    }
}

/// The Claude and Codex characters, cached: as data URLs for the web chat and as images for
/// the app's own views. The SVG wrapper retains each bot's hat over the supplied PNG art.
@MainActor
enum ChibiImages {
    private static var svgs: [String: String] = [:]
    private static var urls: [String: String] = [:]
    private static var images: [String: NSImage] = [:]

    private static func key(_ head: BotEngine, _ mood: Chibi.Mood, _ hat: AvatarKind?) -> String {
        "\(head.rawValue)-\(mood.rawValue)-\(hat?.rawValue ?? "none")"
    }

    static func svg(_ head: BotEngine, mood: Chibi.Mood = .normal, hat: AvatarKind? = nil) -> String {
        let key = key(head, mood, hat)
        if let cached = svgs[key] { return cached }
        let svg = Chibi.svg(head, mood: mood, hat: hat?.hat)
        svgs[key] = svg
        return svg
    }

    static func dataURL(_ head: BotEngine, mood: Chibi.Mood = .normal, hat: AvatarKind? = nil) -> String {
        let key = key(head, mood, hat)
        if let cached = urls[key] { return cached }
        let url = Chibi.dataURL(svg(head, mood: mood, hat: hat))
        urls[key] = url
        return url
    }

    static func image(_ head: BotEngine, mood: Chibi.Mood = .normal, hat: AvatarKind? = nil) -> NSImage {
        let key = key(head, mood, hat)
        if let cached = images[key] { return cached }
        let image = NSImage(data: Data(svg(head, mood: mood, hat: hat).utf8)) ?? NSImage()
        images[key] = image
        return image
    }

    /// What the chat page needs for Bot look Cute, with either or both engines enabled.
    static func look(for kind: AvatarKind) -> ChatPayload.HeadLook {
        ChatPayload.HeadLook(
            avatar: { dataURL($0, hat: kind) },
            mark: { dataURL($0) }
        )
    }
}

/// One character's head, `size` points square.
struct ChibiHeadView: View {
    var head: BotEngine
    var mood: Chibi.Mood = .normal
    /// The bot's face worn as a hat; nil for none.
    var hat: AvatarKind?
    var size: CGFloat

    var body: some View {
        Image(nsImage: ChibiImages.image(head, mood: mood, hat: hat))
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityLabel(head.displayName)
    }
}

/// A head's mood from the bot running it; nil (not woken yet) is asleep.
@MainActor
func chibiMood(of bot: Bot?) -> Chibi.Mood {
    guard let bot else { return .sleep }
    return Chibi.mood(asleep: bot.phase == .asleep, working: bot.isWorking, waiting: bot.waitingForPermission)
}

extension Bot {
    /// The bot running `head`: this one or its partner; nil before the partner first woke.
    func runner(of head: BotEngine) -> Bot? {
        if head == engine { return self }
        if let partner, partner.engine == head { return partner }
        return nil
    }
}

/// The left column's face in Bot look Cute: the bot's own face in front,
/// full size, with only its enabled characters peeking out, each in its mood.
struct BotWithHeadsAvatar: View {
    @ObservedObject var bot: Bot
    var size: CGFloat = 32

    /// How wide it is: the face and the two characters peeking out on each side.
    static func width(_ size: CGFloat) -> CGFloat { size * 2 }

    var body: some View {
        let peek = size * 0.8
        ZStack {
            ForEach(bot.heads.engines, id: \.self) { head in
                HeadPeek(head: head, bot: bot, size: peek)
                    .frame(maxWidth: .infinity, maxHeight: .infinity,
                           alignment: head == .claude || !bot.heads.hasTwo ? .topLeading : .topTrailing)
            }
            AvatarView(kind: bot.avatarKind, size: size, eyes: bot.eyes)
                .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .frame(width: Self.width(size), height: size * 1.15)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bot.heads.engineNames)
        .help(bot.heads.engineNames)
    }
}

/// One character behind the bot's face, following the head's process.
private struct HeadPeek: View {
    let head: BotEngine
    @ObservedObject var bot: Bot
    let size: CGFloat

    var body: some View {
        if let runner = bot.runner(of: head), runner !== bot {
            HeadPeekOf(head: head, runner: runner, size: size)
        } else {
            ChibiHeadView(head: head, mood: bot.runner(of: head) == nil ? .sleep : chibiMood(of: bot), size: size)
        }
    }
}

private struct HeadPeekOf: View {
    let head: BotEngine
    @ObservedObject var runner: Bot
    let size: CGFloat

    var body: some View {
        ChibiHeadView(head: head, mood: chibiMood(of: runner), size: size)
    }
}

private struct BotLookKey: EnvironmentKey {
    static let defaultValue = BotLook.cute
}

extension EnvironmentValues {
    /// Settings → General → Bot look, set at the window's root so every view follows it at once.
    var botLook: BotLook {
        get { self[BotLookKey.self] }
        set { self[BotLookKey.self] = newValue }
    }
}
