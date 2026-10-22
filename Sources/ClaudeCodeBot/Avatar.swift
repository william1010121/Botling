import ClaudeCodeBotCore
import SwiftUI

/// Colored shapes with big eyes (Core's `AvatarShape`, drawn here). Each bot gets one; its eyes
/// show how it is doing.
typealias AvatarKind = AvatarShape

extension AvatarShape {

    var color: Color {
        switch self {
        case .circle: Color(hex: 0xFF4B42)
        case .star: Color(hex: 0xFFC915)
        case .square: Color(hex: 0x2F86F6)
        case .triangle: Color(hex: 0x2E9E3A)
        case .diamond: Color(hex: 0x9B5CF0)
        case .clover: Color(hex: 0xFF7A0A)
        case .heart: Color(hex: 0xFF7EA0)
        case .hexagon: Color(hex: 0x10C2C2)
        case .drop: Color(hex: 0xFFBE0B)
        case .pentagon: Color(hex: 0x58B4FA)
        case .cloud: Color(hex: 0xB5E43A)
        case .octagon: Color(hex: 0xFF9A72)
        case .moon: Color(hex: 0x1550CC)
        case .pill: Color(hex: 0xFF72A0)
        case .ghost: Color(hex: 0x9B4FEB)
        case .burst: Color(hex: 0xFF5A45)
        }
    }

    /// A stable pick for a project, so the same folder keeps the same face.
    static func forName(_ name: String) -> AvatarKind {
        let sum = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        let choices = allCases.filter { $0 != .main }
        return choices[sum % choices.count]
    }

    /// Where the eyes sit, as a fraction of the height.
    var eyeY: CGFloat {
        switch self {
        case .triangle: 0.66
        case .drop: 0.6
        case .ghost: 0.45
        default: 0.48
        }
    }

    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * w, y: rect.minY + y * h) }
        func polygon(_ points: [CGPoint]) -> Path {
            var path = Path()
            path.addLines(points)
            path.closeSubpath()
            return path
        }
        func regular(_ sides: Int, rotation: Double) -> Path {
            polygon((0..<sides).map { i in
                let angle = rotation + Double(i) * 2 * .pi / Double(sides)
                return point(0.5 + 0.48 * cos(angle), 0.5 + 0.48 * sin(angle))
            })
        }
        func circles(_ list: [(CGFloat, CGFloat, CGFloat)]) -> Path {
            var path = Path()
            for (x, y, r) in list {
                path.addEllipse(in: CGRect(x: rect.minX + (x - r) * w, y: rect.minY + (y - r) * h, width: 2 * r * w, height: 2 * r * h))
            }
            return path
        }

        switch self {
        case .circle:
            return Path(ellipseIn: rect.insetBy(dx: w * 0.04, dy: h * 0.04))
        case .square:
            return Path(roundedRect: rect.insetBy(dx: w * 0.06, dy: h * 0.1), cornerRadius: w * 0.14)
        case .pill:
            return Path(roundedRect: rect.insetBy(dx: 0, dy: h * 0.2), cornerRadius: h * 0.3)
        case .triangle:
            return polygon([point(0.5, 0.06), point(0.96, 0.9), point(0.04, 0.9)])
        case .diamond:
            return polygon([point(0.5, 0.02), point(0.98, 0.5), point(0.5, 0.98), point(0.02, 0.5)])
        case .star:
            return polygon((0..<10).map { i in
                let angle = -Double.pi / 2 + Double(i) * .pi / 5
                let radius: CGFloat = i.isMultiple(of: 2) ? 0.5 : 0.24
                return point(0.5 + radius * cos(angle), 0.54 + radius * sin(angle))
            })
        case .hexagon:
            return regular(6, rotation: 0)
        case .pentagon:
            return regular(5, rotation: -.pi / 2)
        case .octagon:
            return regular(8, rotation: .pi / 8)
        case .burst:
            return polygon((0..<24).map { i in
                let angle = Double(i) * .pi / 12
                let radius: CGFloat = i.isMultiple(of: 2) ? 0.5 : 0.38
                return point(0.5 + radius * cos(angle), 0.5 + radius * sin(angle))
            })
        case .clover:
            return circles([(0.5, 0.27, 0.23), (0.5, 0.73, 0.23), (0.27, 0.5, 0.23), (0.73, 0.5, 0.23), (0.5, 0.5, 0.25)])
        case .cloud:
            return circles([(0.3, 0.58, 0.22), (0.5, 0.42, 0.26), (0.72, 0.58, 0.22), (0.5, 0.66, 0.2)])
        case .heart:
            var path = Path()
            path.move(to: point(0.5, 0.92))
            path.addCurve(to: point(0.04, 0.36), control1: point(0.22, 0.72), control2: point(0.04, 0.58))
            path.addCurve(to: point(0.5, 0.22), control1: point(0.04, 0.08), control2: point(0.4, 0.04))
            path.addCurve(to: point(0.96, 0.36), control1: point(0.6, 0.04), control2: point(0.96, 0.08))
            path.addCurve(to: point(0.5, 0.92), control1: point(0.96, 0.58), control2: point(0.78, 0.72))
            path.closeSubpath()
            return path
        case .drop:
            var path = Path()
            path.move(to: point(0.5, 0.04))
            path.addCurve(to: point(0.9, 0.62), control1: point(0.64, 0.22), control2: point(0.9, 0.4))
            path.addArc(center: point(0.5, 0.62), radius: 0.4 * w, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false)
            path.addCurve(to: point(0.5, 0.04), control1: point(0.1, 0.4), control2: point(0.36, 0.22))
            path.closeSubpath()
            return path
        case .ghost:
            var path = Path()
            path.move(to: point(0.08, 0.92))
            path.addLine(to: point(0.08, 0.46))
            path.addArc(center: point(0.5, 0.46), radius: 0.42 * w, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
            path.addLine(to: point(0.92, 0.92))
            path.addQuadCurve(to: point(0.64, 0.86), control: point(0.78, 0.98))
            path.addQuadCurve(to: point(0.36, 0.86), control: point(0.5, 0.74))
            path.addQuadCurve(to: point(0.08, 0.92), control: point(0.22, 0.98))
            path.closeSubpath()
            return path
        case .moon:
            return circles([(0.48, 0.52, 0.44)]).subtracting(circles([(0.76, 0.32, 0.3)]))
        }
    }

    var usesEvenOdd: Bool { false }
}

enum EyeStyle: Hashable {
    case open, happy, closed
}

struct AvatarView: View {
    var kind: AvatarKind
    var size: CGFloat
    var eyes: EyeStyle = .open

    var body: some View {
        Canvas { context, canvasSize in
            let rect = CGRect(origin: .zero, size: canvasSize)
            let shape = kind.path(in: rect)
            context.fill(shape, with: .color(kind.color), style: FillStyle(eoFill: kind.usesEvenOdd))
            // Same-colored stroke rounds the corners of the polygons.
            if !kind.usesEvenOdd {
                context.stroke(shape, with: .color(kind.color), style: StrokeStyle(lineWidth: canvasSize.width * 0.08, lineJoin: .round))
            }
            drawEyes(in: &context, size: canvasSize)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func drawEyes(in context: inout GraphicsContext, size: CGSize) {
        let w = size.width, h = size.height
        let shift: CGFloat = kind == .moon ? -0.12 : 0
        let eyeY = kind == .moon ? 0.6 : kind.eyeY
        let centers = [CGPoint(x: (0.36 + shift) * w, y: eyeY * h), CGPoint(x: (0.64 + shift) * w, y: eyeY * h)]
        let radius = w * (kind == .moon ? 0.1 : 0.125)
        let line = StrokeStyle(lineWidth: max(1.2, w * 0.045), lineCap: .round)
        for center in centers {
            switch eyes {
            case .open:
                context.fill(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)), with: .color(.white))
                let pupil = radius * 0.58
                let offset = CGPoint(x: center.x + radius * 0.3, y: center.y + radius * 0.05)
                context.fill(Path(ellipseIn: CGRect(x: offset.x - pupil, y: offset.y - pupil, width: pupil * 2, height: pupil * 2)), with: .color(.black))
            case .happy:
                var arc = Path()
                arc.addArc(center: CGPoint(x: center.x, y: center.y + radius * 0.4), radius: radius * 0.8, startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false)
                context.stroke(arc, with: .color(.black), style: line)
            case .closed:
                var arc = Path()
                arc.addArc(center: CGPoint(x: center.x, y: center.y - radius * 0.3), radius: radius * 0.8, startAngle: .degrees(20), endAngle: .degrees(160), clockwise: false)
                context.stroke(arc, with: .color(.black.opacity(0.75)), style: line)
            }
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
