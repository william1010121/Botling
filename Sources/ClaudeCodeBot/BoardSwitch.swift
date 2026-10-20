import ClaudeCodeBotCore
import SwiftUI

/// Chat | Board at the top of the chat column (also ⌃⌘B): the Board shows the bot's pinned
/// components as cards in place of the messages, with a slim input box under them. While it
/// shows, the right panel folds to its strip (a hold: your own choice for the panel is kept).
struct BoardMode: ViewModifier {
    @ObservedObject var workspace: Workspace
    @ObservedObject var inputs: ChatInputs
    let bot: Bot

    private var available: Bool { workspace.viewingSubagent == nil && bot !== workspace.codexBot }
    private var on: Bool { available && inputs.boards.contains(bot.id) }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if available {
                    BoardSwitch(board: on) { board in set(board) }
                        .padding(.top, 10)
                }
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
    let board: Bool
    let set: (Bool) -> Void

    var body: some View {
        HStack(spacing: 2) {
            segment("Chat", icon: "bubble.left", on: !board) { set(false) }
            segment("Board", icon: "square.grid.2x2", on: board) { set(true) }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.bubble))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.chip))
        .background(
            // ⌃⌘B flips it from anywhere in the window.
            Button("") { set(!board) }
                .keyboardShortcut("b", modifiers: [.control, .command])
                .opacity(0)
                .accessibilityHidden(true)
        )
        .help("Chat or Board (⌃⌘B)")
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
