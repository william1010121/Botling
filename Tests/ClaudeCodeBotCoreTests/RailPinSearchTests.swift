import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Bots pinned to the top of the left column (in the order they were pinned, kept across
/// launches), and the column's search field (⌘K).
@MainActor
struct RailPinSearchTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-rail-pins-\(UUID().uuidString)")

    func workspace() -> Workspace {
        Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
    }

    @Test func pinsKeepTheOrderTheyWerePinnedInAndSurviveARestart() throws {
        let first = workspace()
        let news = try #require(first.createBot(name: "Morning news", job: "News"))
        let papers = try #require(first.createBot(name: "Papers", job: "Read papers"))
        let home = try #require(first.createBot(name: "Home server", job: "Watch the NAS"))
        #expect(first.pinnedBots.isEmpty)

        first.setPinned(home.id, true)
        first.setPinned(news.id, true)
        first.setPinned(news.id, true) // pinning twice changes nothing
        #expect(first.pinnedBots == [home.id, news.id])
        #expect(first.isPinned(home.id))
        #expect(!first.isPinned(papers.id))
        #expect(AppSettings.load(from: first.settingsURL).pinnedBots == [home.id, news.id])

        // The next launch has them pinned, in the same order.
        #expect(workspace().pinnedBots == [home.id, news.id])

        first.togglePin(home.id)
        #expect(first.pinnedBots == [news.id])
        first.togglePin(papers.id)
        #expect(first.pinnedBots == [news.id, papers.id])
        #expect(workspace().pinnedBots == [news.id, papers.id])
    }

    @Test func aRemovedBotIsNoLongerPinned() throws {
        let first = workspace()
        let news = try #require(first.createBot(name: "Morning news", job: "News"))
        let papers = try #require(first.createBot(name: "Papers", job: "Read papers"))
        first.setPinned(news.id, true)
        first.setPinned(papers.id, true)

        first.removeBot(news.id)
        #expect(first.pinnedBots == [papers.id])
        #expect(AppSettings.load(from: first.settingsURL).pinnedBots == [papers.id])
    }

    @Test func idsOfBotsThatAreGoneAreDroppedWhenTheAppOpens() throws {
        let first = workspace()
        let news = try #require(first.createBot(name: "Morning news", job: "News"))
        var settings = AppSettings.load(from: first.settingsURL)
        settings.pinnedBots = [UUID(), news.id]
        settings.save(to: first.settingsURL)

        let next = workspace()
        #expect(next.pinnedBots == [news.id])
        #expect(AppSettings.load(from: next.settingsURL).pinnedBots == [news.id])
        // Pinning something that is not a project does nothing.
        next.setPinned(UUID(), true)
        #expect(next.pinnedBots == [news.id])
    }

    @Test func aSettingsFileFromBeforeHasNoPins() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(#"{"developerMode":false}"#.utf8).write(to: root.appending(path: "settings.json"))
        #expect(workspace().pinnedBots.isEmpty)
    }

    /// Pinned rows go first, in pin order; the rest keep the order they came in.
    @Test func pinnedRowsGoFirstInPinOrder() {
        let ids = (0..<5).map { _ in UUID() }
        let split = RailLayout.pinnedFirst(ids, id: { $0 }, pinned: [ids[3], UUID(), ids[1]])
        #expect(split.pinned == [ids[3], ids[1]])
        #expect(split.rest == [ids[0], ids[2], ids[4]])

        let none = RailLayout.pinnedFirst(ids, id: { $0 }, pinned: [])
        #expect(none.pinned.isEmpty)
        #expect(none.rest == ids)
    }

    @Test func searchMatchesTheNameOrTheProjectFolderIgnoringCase() {
        #expect(RailLayout.matches("", name: "Arbor", folder: nil))
        #expect(RailLayout.matches("   ", name: "Arbor", folder: nil))
        #expect(RailLayout.matches("arb", name: "Arbor", folder: nil))
        #expect(RailLayout.matches("NEWS", name: "Morning news", folder: nil))
        #expect(RailLayout.matches(" news ", name: "Morning news", folder: nil))
        #expect(!RailLayout.matches("papers", name: "Morning news", folder: nil))
        // A project's folder name counts too: "ccb" finds the bot named "Manager" in ~/code/ccb-app.
        #expect(RailLayout.matches("ccb", name: "Manager", folder: "ccb-app"))
        #expect(RailLayout.matches("café", name: "Cafe orders", folder: nil))
        #expect(!RailLayout.matches("zzz", name: "Manager", folder: "ccb-app"))
    }

    @Test func theEmptyResultSaysSo() {
        #expect(RailLayout.noMatches == "No bots match")
        #expect(RailLayout.searchShortcut == "⌘K")
    }
}
