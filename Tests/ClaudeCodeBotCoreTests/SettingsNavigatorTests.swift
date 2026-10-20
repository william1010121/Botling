import Testing
@testable import ClaudeCodeBotCore

/// The settings window: which section the gear's popover rows and ⌘, open it at.
@MainActor
struct SettingsNavigatorTests {
    @Test func sectionsAreListedInSidebarOrder() {
        #expect(SettingsSection.allCases.map(\.title) == ["Usage", "Permissions", "Plugins", "Developer mode", "Release planner", "Doctor"])
    }

    @Test func rowsOpenTheirSectionAndAllSettingsKeepsTheLastOne() {
        let navigator = SettingsNavigator()
        #expect(!navigator.isOpen)
        #expect(navigator.section == .usage)

        navigator.open(.plugins)
        #expect(navigator.isOpen)
        #expect(navigator.section == .plugins)
        navigator.close()
        #expect(!navigator.isOpen)

        // "All settings…" and ⌘, open it where it was last.
        navigator.open()
        #expect(navigator.isOpen)
        #expect(navigator.section == .plugins)
        navigator.section = .developer
        navigator.close()
        navigator.open()
        #expect(navigator.section == .developer)

        navigator.open(.usage)
        #expect(navigator.section == .usage)
    }
}
