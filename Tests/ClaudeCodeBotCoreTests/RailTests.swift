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
}
