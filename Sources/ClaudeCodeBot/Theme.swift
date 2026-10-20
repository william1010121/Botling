import ClaudeCodeBotCore
import SwiftUI

enum Theme {
    static let ground = Color(hex: 0x0E0E10)
    static let side = Color(hex: 0x141417)
    static let bubble = Color(hex: 0x1B1B1F)
    static let userBubble = Color(hex: 0x2B2B31)
    static let selected = Color(hex: 0x26262C)
    /// Under the pointer, a step quieter than `selected`.
    static let hover = Color(hex: 0x1F1F24)
    /// The edge of a hover tip.
    static let tipLine = Color(hex: 0x3A3A42)
    static let line = Color(hex: 0x232327)
    static let text = Color(hex: 0xEDEDF0)
    static let muted = Color(hex: 0xA0A0A8)
    static let faint = Color(hex: 0x8E8E96)
    static let chip = Color(hex: 0x2A2A31)
    static let blue = Color(hex: 0x4C8DFF)
    static let green = Color(hex: 0x4CC38A)
    static let orange = Color(hex: 0xF2A64A)
    static let errorText = Color(hex: 0xFF8A80)
}

extension Bot {
    var avatarKind: AvatarKind {
        AvatarKind(rawValue: profile.avatar) ?? .circle
    }

    var eyes: EyeStyle {
        switch phase {
        case .asleep, .tidying: .closed
        case .awake, .switching: .open
        }
    }

    var statusText: String {
        switch phase {
        case .asleep where outage != nil, .awake where outage != nil: NetworkResume.label
        case .asleep: "Asleep"
        case .tidying: "Tidying notes"
        case .switching: "Handing off"
        case .awake: waitingForPermission ? "Waiting for your OK" : retryingConnection ? NetworkResume.label + "，重試中…" : isWorking ? "Working" : "Awake"
        }
    }

    var statusColor: Color {
        if outage != nil || retryingConnection { return Theme.orange }
        return switch phase {
        case .asleep: Theme.faint
        case .tidying, .switching: Theme.blue
        case .awake: isWorking ? Theme.blue : Theme.green
        }
    }
}

extension Workspace {
    func avatar(for projectID: UUID) -> AvatarKind? {
        if projectID == Workspace.mainBotID { return .circle }
        return project(projectID).flatMap { AvatarKind(rawValue: $0.avatar) }
    }
}
