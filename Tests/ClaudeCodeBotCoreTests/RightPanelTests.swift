import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The right panel folds into a strip of icons (⌃⌘I or the button at the window's top right),
/// stays that way the next time the app opens, and can be folded for a while by other views
/// (a Board) without changing what the user chose.
@MainActor
struct RightPanelTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-right-\(UUID().uuidString)")

    func workspace() -> Workspace {
        Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
    }

    @Test func thePanelStartsOpenAndRemembersBeingFolded() {
        let first = workspace()
        #expect(!first.rightPanelCollapsed)

        first.toggleRightPanel()
        #expect(first.rightPanelCollapsed)
        #expect(AppSettings.load(from: first.settingsURL).rightPanelCollapsed == true)

        // The next launch opens it folded.
        #expect(workspace().rightPanelCollapsed)

        first.setRightPanelCollapsed(false)
        #expect(!first.rightPanelCollapsed)
        #expect(!workspace().rightPanelCollapsed)
    }

    @Test func foldingTheRightPanelLeavesTheLeftColumnAlone() {
        let ws = workspace()
        ws.toggleRightPanel()
        #expect(ws.rightPanelCollapsed)
        #expect(!ws.railCollapsed)
        ws.toggleRail()
        #expect(ws.rightPanelCollapsed && ws.railCollapsed)
    }

    @Test func aSettingsFileFromBeforeKeepsThePanelOpen() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(#"{"developerMode":false,"railCollapsed":true}"#.utf8).write(to: root.appending(path: "settings.json"))
        let ws = workspace()
        #expect(!ws.rightPanelCollapsed)
        #expect(ws.railCollapsed)
    }

    /// A view such as a Board folds the panel while it is shown, without saving it; when it
    /// lets go, the panel goes back to what the user chose.
    @Test func aTemporaryFoldIsNotRemembered() {
        let ws = workspace()
        ws.setRightPanelCollapsed(true, remember: false)
        #expect(ws.rightPanelCollapsed)
        #expect(AppSettings.load(from: ws.settingsURL).rightPanelCollapsed == nil)
        #expect(!workspace().rightPanelCollapsed)

        ws.releaseRightPanel()
        #expect(!ws.rightPanelCollapsed)
    }

    /// The user's own toggle while a view holds the panel folded is a real choice: it is saved
    /// and the hold ends.
    @Test func theTogglePassesThroughATemporaryFold() {
        let ws = workspace()
        ws.setRightPanelCollapsed(true, remember: false)
        ws.toggleRightPanel()
        #expect(!ws.rightPanelCollapsed)
        #expect(AppSettings.load(from: ws.settingsURL).rightPanelCollapsed == false)
        ws.releaseRightPanel()
        #expect(!ws.rightPanelCollapsed)
    }

    @Test func widthsMatchTheDesign() {
        #expect(RightPanelLayout.width(collapsed: false) == 340)
        #expect(RightPanelLayout.width(collapsed: true) == 56)
    }

    @Test func badgesCountUpTo99() {
        #expect(RightPanelLayout.badge(0) == nil)
        #expect(RightPanelLayout.badge(3) == "3")
        #expect(RightPanelLayout.badge(99) == "99")
        #expect(RightPanelLayout.badge(100) == "99+")
    }

    /// The strip shows an icon for each section the open panel would show, in the same order.
    @Test func theStripHasAnIconPerSectionThePanelShows() {
        let all = RightPanelLayout.items(waiting: 2, members: nil, showsCodex: true, results: 3, settled: 6)
        #expect(all == [
            .init(section: .waiting, badge: "2"),
            .init(section: .codex, badge: nil),
            .init(section: .results, badge: "3"),
            .init(section: .settled, badge: "6"),
        ])

        // A fresh bot: nothing to open, so no icons (the face and the settings stay).
        #expect(RightPanelLayout.items(waiting: 0, members: nil, showsCodex: false, results: 0, settled: 0).isEmpty)

        // A group chat: its waiting questions, its members and what was just done.
        #expect(RightPanelLayout.items(waiting: 0, members: 3, showsCodex: false, results: 1, settled: 0) == [
            .init(section: .members, badge: "3"),
            .init(section: .results, badge: "1"),
        ])
    }

    /// Hovering the face in the strip shows what the Now card says.
    @Test func theFaceTipSaysWhatNowSays() {
        #expect(RightPanelLayout.nowDetail(status: "Working", doing: "Ship v1.9.0") == "Working · Ship v1.9.0")
        #expect(RightPanelLayout.nowDetail(status: "Asleep", doing: nil) == "Asleep")
        #expect(RightPanelLayout.nowDetail(status: "Awake", doing: "  ") == "Awake")
    }

    /// The rail, the chat and the right panel always fit the window: a panel wider than the
    /// room left (the spec workspace spread wide in a half-screen window) gets narrower, and
    /// the chat gives up some of its width before anything runs off the window's edges.
    @Test func theColumnsFitAnyWindowWidth() {
        for window in stride(from: 980.0, through: 2400, by: 10) {
            for rail in [RailLayout.expandedWidth, RailLayout.collapsedWidth] {
                for right in [RightPanelLayout.expandedWidth, RightPanelLayout.collapsedWidth, RightPanelLayout.specWidth, RightPanelLayout.specWideWidth] {
                    let columns = RightPanelLayout.columns(window: window, rail: rail, right: right)
                    #expect(rail + columns.chat + columns.right <= window, "window \(window), rail \(rail), panel \(right)")
                    #expect(columns.right <= right)
                    #expect(columns.chat >= 360)
                }
            }
        }
        // Room to spare: everything as asked.
        let roomy = RightPanelLayout.columns(window: 1800, rail: 240, right: RightPanelLayout.specWideWidth)
        #expect(roomy.right == RightPanelLayout.specWideWidth)
        #expect(roomy.chat == RightPanelLayout.chatMinWidth)
        // The reported window (about 1450 pt): the wide spec panel takes what the chat leaves.
        let half = RightPanelLayout.columns(window: 1448, rail: 240, right: RightPanelLayout.specWideWidth)
        #expect(half.right == 1448 - 240 - RightPanelLayout.chatMinWidth)
        // The smallest window: the panel keeps a usable width and the chat narrows.
        let smallest = RightPanelLayout.columns(window: 980, rail: 240, right: RightPanelLayout.specWideWidth)
        #expect(smallest.right == RightPanelLayout.panelFloor)
        #expect(smallest.chat == 980 - 240 - RightPanelLayout.panelFloor)
    }
}
