import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The left column folds into a strip of faces (⌃⌘S or the button by the window's lights),
/// and stays that way the next time the app opens.
@MainActor
struct RailTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-rail-\(UUID().uuidString)")

    func workspace() -> Workspace {
        Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
    }

    @Test func theColumnStartsOpenAndRemembersBeingFolded() {
        let first = workspace()
        #expect(!first.railCollapsed)

        first.toggleRail()
        #expect(first.railCollapsed)
        #expect(AppSettings.load(from: first.settingsURL).railCollapsed == true)

        // The next launch opens it folded.
        #expect(workspace().railCollapsed)

        first.setRailCollapsed(false)
        #expect(!first.railCollapsed)
        #expect(!workspace().railCollapsed)
    }

    @Test func aSettingsFileFromBeforeKeepsTheColumnOpen() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(#"{"developerMode":false}"#.utf8).write(to: root.appending(path: "settings.json"))
        #expect(!workspace().railCollapsed)
    }

    @Test func widthsMatchTheDesign() {
        #expect(RailLayout.width(collapsed: false) == 240)
        #expect(RailLayout.width(collapsed: true) == 56)
    }

    /// Hovering a face in the strip shows its name, and under it the status and what is new.
    @Test func theHoverTipSaysTheStatusAndWhatIsNew() {
        #expect(RailLayout.tipDetail(status: "Done, click to see", unread: 2, waiting: false) == "Done, click to see · 2 unread")
        #expect(RailLayout.tipDetail(status: "Asleep", unread: 0, waiting: false) == "Asleep")
        #expect(RailLayout.tipDetail(status: "Working", unread: 1, waiting: true) == "Working · waiting on you · 1 unread")
        #expect(RailLayout.tipDetail(status: "Awake", unread: 120, waiting: false) == "Awake · 99+ unread")
    }

    /// A row's end (and a folded face's corner) shows only the unread count: no orange
    /// "waiting on you" dot, even with nothing unread.
    @Test func rowsShowOnlyTheUnreadCountNotAWaitingDot() {
        #expect(RailLayout.unreadBadge(unread: 0, waiting: true, selected: false) == nil)
        #expect(RailLayout.unreadBadge(unread: 2, waiting: true, selected: false) == 2)
        #expect(RailLayout.unreadBadge(unread: 2, waiting: false, selected: false) == 2)
        #expect(RailLayout.unreadBadge(unread: 2, waiting: true, selected: true) == nil)
        #expect(RailLayout.unreadBadge(unread: 0, waiting: false, selected: false) == nil)
    }

    /// A running subagent's row has no blue dot (its owner head's face is on the row); an
    /// ended one keeps its check, "!" or stop sign.
    @Test func runningSubagentRowsHaveNoDot() {
        #expect(!Subagent.Mark.live.showsInSidebar)
        #expect(Subagent.Mark.done.showsInSidebar)
        #expect(Subagent.Mark.failed.showsInSidebar)
        #expect(Subagent.Mark.stopped.showsInSidebar)
        #expect(Subagent(id: "a", description: "Work", prompt: "Work").mark.showsInSidebar == false)
    }
}
