import ClaudeCodeBotCore
import SwiftUI

/// Chat | Board at the top of the chat column (also ⌃⌘B): the Board shows the bot's pinned
/// components as cards in place of the messages, with a slim input box under them. While it
/// shows, the right panel folds to its strip (a hold: your own choice for the panel is kept).
struct BoardMode: ViewModifier {
    @ObservedObject var workspace: Workspace
    @ObservedObject var inputs: ChatInputs
    let bot: Bot

    /// Not for a subagent's view or a web site's page (no switch, no ⌃⌘B).
    private var available: Bool { workspace.showsBoardSwitch }
    private var on: Bool { available && inputs.boards.contains(bot.id) }

    func body(content: Content) -> some View {
        // The switch sits in a bar of its own above the chat, so messages never scroll under it.
        VStack(spacing: 0) {
            if available {
                BoardSwitch(board: on) { board in set(board) }
                    .padding(.top, BoardSwitch.barTop)
                    .padding(.bottom, BoardSwitch.barBottom)
                    .frame(maxWidth: .infinity)
            }
            content
        }
            .onChange(of: bot.id) { _, _ in holdPanel() }
            .onChange(of: available) { _, _ in holdPanel() }
            .onAppear { holdPanel() }
    }

    private func set(_ board: Bool) {
        if board { inputs.boards.insert(bot.id) } else { inputs.boards.remove(bot.id) }
        withAnimation(.easeInOut(duration: 0.2)) { holdPanel() }
    }

    /// The Board wants the room: the right panel folds while it shows, and comes back after.
    private func holdPanel() {
        if on { workspace.setRightPanelCollapsed(true, remember: false) } else { workspace.releaseRightPanel() }
    }
}

struct BoardSwitch: View {
    /// The bar the switch sits in: 10 pt above it, 6 pt below.
    static let barTop: CGFloat = 10
    static let barBottom: CGFloat = 6

    let board: Bool
    /// False where there is no Board (a web site): the switch keeps its place, Board greyed out.
    var boardAvailable = true
    let set: (Bool) -> Void

    var body: some View {
        HStack(spacing: 2) {
            segment(L("Chat"), icon: "bubble.left", on: !board) { set(false) }
            segment(L("Board"), icon: "square.grid.2x2", on: board) { set(true) }
                .disabled(!boardAvailable)
                .opacity(boardAvailable ? 1 : 0.45)
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.chip))
        .background(
            // ⌃⌘B flips it from anywhere in the window.
            Button("") { if boardAvailable { set(!board) } }
                .keyboardShortcut("b", modifiers: [.control, .command])
                .opacity(0)
                .accessibilityHidden(true)
        )
        .help(L("Chat or Board (⌃⌘B)"))
    }

    private func segment(_ title: String, icon: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.system(size: 12))
                .labelStyle(.titleAndIcon)
                .foregroundStyle(on ? Theme.text : Theme.muted)
                .padding(.horizontal, 12)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 7).fill(on ? Theme.userBubble : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
