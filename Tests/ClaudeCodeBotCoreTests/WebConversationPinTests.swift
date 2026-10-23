import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct WebConversationPinTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-web-pins-\(UUID().uuidString)")
    let now = Date(timeIntervalSince1970: 1_792_655_000)
    var web: URL { root.appending(path: "web") }
    func shelf() -> WebShelf { WebShelf(folder: web, library: root.appending(path: "plugins")) }

    @discardableResult
    func record(_ shelf: WebShelf, _ id: String, on site: WebSite = .gemini, page: UUID = WebShelf.firstPage,
                at offset: Double = 0, awaiting: Bool = false) throws -> WebConversation {
        let turns = [WebTurn(role: .user, text: "Question \(id)")] + (awaiting ? [] : [WebTurn(role: .assistant, text: "Answer \(offset)")])
        shelf.record(on: site, page: page, url: site.conversationURL(id), pageTitle: nil,
                     reading: .read(title: id, turns: turns), now: now.addingTimeInterval(offset))
        return try #require(shelf.conversation(id, of: site))
    }

    @Test func legacyListDefaultsToUnpinnedWithoutRewritingOrLosingFields() throws {
        let folder = web.appending(path: "gemini")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let legacy = #"[{"id":"old1","url":"https://gemini.google.com/app/old1","title":"Legacy","messages":2,"file":"legacy.md","updatedAt":"2026-10-01T10:00:00Z","accountID":"a-work"}]"#
        let file = folder.appending(path: "conversations.json")
        try Data(legacy.utf8).write(to: file)
        let row = try #require(shelf().conversation("old1", of: .gemini))
        #expect(!row.isPinned && row.pinnedAt == nil)
        #expect(row.accountID == "a-work" && row.file == "legacy.md" && row.messages == 2)
        #expect(try String(contentsOf: file, encoding: .utf8) == legacy)
    }

    @Test func pinAndUnpinPersistWithoutNavigationOrTimestampChanges() throws {
        let shelf = shelf()
        let row = try record(shelf, "pin1")
        shelf.handled(.gemini)
        let open = shelf.open
        let front = shelf.front
        let status = shelf.status
        shelf.setPinned(true, conversation: row, of: .gemini, now: now)
        shelf.setPinned(true, conversation: row, of: .gemini, now: now.addingTimeInterval(20))
        let pinned = try #require(self.shelf().conversation("pin1", of: .gemini))
        #expect(pinned.pinnedAt == now && pinned.updatedAt == row.updatedAt)
        #expect(pinned.id == row.id && pinned.url == row.url && pinned.file == row.file)
        #expect(shelf.open == open && shelf.front == front && shelf.status == status)
        #expect(shelf.requested.isEmpty && shelf.requestedRow.isEmpty)
        shelf.setPinned(false, conversation: pinned, of: .gemini)
        #expect(self.shelf().conversation("pin1", of: .gemini)?.isPinned == false)
    }

    @Test func pinOrderSurvivesRefreshAndReloadAndUnpinnedKeepAwaitingThenRecentOrder() throws {
        let shelf = shelf()
        let first = try record(shelf, "pin1", at: 1)
        let second = try record(shelf, "pin2", at: 2)
        try record(shelf, "old1", at: 3)
        try record(shelf, "new1", at: 4)
        try record(shelf, "wait", at: 0, awaiting: true)
        shelf.setPinned(true, conversation: first, of: .gemini, now: now)
        shelf.setPinned(true, conversation: second, of: .gemini, now: now.addingTimeInterval(1))
        let expected = ["pin1", "pin2", "wait", "new1", "old1"]
        #expect(shelf.listed(of: .gemini).map(\.id) == expected)
        // Both a title refresh and a changed transcript preserve pin order and metadata.
        shelf.pageChanged(on: .gemini, url: second.url, pageTitle: "Refreshed", now: now.addingTimeInterval(50))
        try record(shelf, "pin2", at: 60)
        #expect(shelf.listed(of: .gemini).map(\.id) == expected)
        #expect(self.shelf().listed(of: .gemini).map(\.id) == expected)
        // The right panel keeps its original recency order.
        #expect(shelf.conversations(of: .gemini).first?.id == "pin2")
        shelf.setPinned(false, conversation: first, of: .gemini)
        #expect(shelf.listed(of: .gemini).map(\.id) == ["pin2", "wait", "new1", "old1", "pin1"])
    }

    @Test func equalPinTimesUseDeterministicIdentityOrder() throws {
        let shelf = shelf()
        for (index, id) in ["bbbb", "aaaa", "cccc"].enumerated() {
            let row = try record(shelf, id)
            shelf.setPinned(true, conversation: row, of: .gemini, now: now.addingTimeInterval(Double(index) / 10))
        }
        #expect(shelf.listed(of: .gemini).map(\.id) == ["aaaa", "bbbb", "cccc"])
        #expect(self.shelf().listed(of: .gemini).map(\.id) == ["aaaa", "bbbb", "cccc"])
    }

    @Test func pinnedRowsStayVisibleWhenSettledAndUnpinRestoresExistingFilter() throws {
        let shelf = shelf()
        let row = try record(shelf, "pin1")
        shelf.setPinned(true, conversation: row, of: .gemini, now: now)
        shelf.showing(.gemini)
        // Seeing the answer then leaving uses the existing navigation/settlement path.
        try record(shelf, "pin1")
        shelf.startNew(on: .gemini, now: now.addingTimeInterval(1))
        #expect(shelf.conversation(row.id, of: .gemini)?.isSettled == true)
        #expect(shelf.listed(of: .gemini).map(\.id) == [row.id])
        #expect(self.shelf().listed(of: .gemini).map(\.id) == [row.id])
        shelf.setPinned(false, conversation: row, of: .gemini)
        #expect(shelf.listed(of: .gemini).isEmpty)
        #expect(shelf.conversations(of: .gemini).count == 1)
    }

    @Test func providersAndAccountsRetainTheirIdentityProfilesAndOpenPages() throws {
        let shelf = shelf()
        let work = shelf.addAccount(on: .gemini, name: "work", now: now)
        let page = UUID()
        shelf.attach(page, account: work)
        shelf.bringToFront(page, on: .gemini)
        let workRow = try record(shelf, "work", page: page)
        let ownRow = try record(shelf, "home", page: UUID(), at: 1)
        let otherProvider = try record(shelf, "work", on: .chatgpt)
        let open = shelf.open
        let front = shelf.front
        let requested = shelf.requested
        shelf.setPinned(true, conversation: workRow, of: .gemini, now: now)
        #expect(shelf.open == open && shelf.front == front && shelf.requested == requested)
        #expect(shelf.row(of: page, on: .gemini)?.id == workRow.id)
        #expect(shelf.account(ofPage: page, on: .gemini).dataStoreID == work.dataStoreID)
        #expect(shelf.conversation(otherProvider.id, of: .chatgpt)?.isPinned == false)
        #expect(shelf.conversation(ownRow.id, of: .gemini)?.isPinned == false)
        let reloaded = self.shelf()
        let loadedWork = try #require(reloaded.conversation("work", of: .gemini))
        #expect(loadedWork.accountID == work.id && loadedWork.isPinned)
        #expect(reloaded.account(of: loadedWork, on: .gemini).dataStoreID == work.dataStoreID)
        reloaded.show(ownRow, of: .gemini)
        #expect(reloaded.account(of: .gemini).dataStoreID == WebSite.gemini.dataStoreID)
        reloaded.show(loadedWork, of: .gemini)
        #expect(reloaded.account(of: .gemini).dataStoreID == work.dataStoreID)
        #expect(reloaded.requestedRow["gemini"] == workRow.id)
        #expect(Set(reloaded.conversations(of: .gemini).map(\.id)).count == 2)
    }

    @Test func provisionalPinMovesToRealIDAndMergesWithoutDuplicatesOrCrossAccountPins() throws {
        let folder = root.appending(path: "store")
        var store = WebConversationStore(folder: folder)
        store.upsert(id: "new-temp", url: WebSite.gemini.startURL, title: "Question", at: now)
        store.update("new-temp") { $0.pinnedAt = now }
        store.adopt("new-temp", as: "real", url: WebSite.gemini.conversationURL("real"))
        #expect(store.conversations.count == 1 && store.conversation("real")?.pinnedAt == now)
        store.upsert(id: "new-again", url: WebSite.gemini.startURL, title: nil, at: now)
        store.update("new-again") { $0.pinnedAt = now.addingTimeInterval(-5) }
        store.adopt("new-again", as: "real", url: WebSite.gemini.conversationURL("real"))
        store.save()
        #expect(WebConversationStore(folder: folder).conversations.count == 1)
        #expect(store.conversation("real")?.pinnedAt == now.addingTimeInterval(-5))
        store.upsert(id: "new-work", url: WebSite.gemini.startURL, title: nil, at: now, account: "work-account")
        store.update("new-work") { $0.pinnedAt = now.addingTimeInterval(-10) }
        store.adopt("new-work", as: "real", url: WebSite.gemini.conversationURL("real"))
        #expect(store.conversation("real")?.pinnedAt == now.addingTimeInterval(-5))
        #expect(store.conversation("real")?.accountID == nil)
    }

    @Test func deletingPersistedRowCannotLeaveOrResurrectAGhostPin() throws {
        let shelf = shelf()
        let row = try record(shelf, "gone")
        shelf.setPinned(true, conversation: row, of: .gemini, now: now)
        // There is no separate pin index: exercise list removal as an external list edit.
        let file = web.appending(path: "gemini/conversations.json")
        try Data("[]".utf8).write(to: file, options: .atomic)
        let reloaded = self.shelf()
        #expect(reloaded.listed(of: .gemini).isEmpty)
        reloaded.setPinned(true, conversation: row, of: .gemini)
        #expect(reloaded.conversations(of: .gemini).isEmpty)
        let fresh = try record(reloaded, "gone")
        #expect(!fresh.isPinned)
        #expect(self.shelf().conversation("gone", of: .gemini)?.isPinned == false)
    }

    @Test(arguments: WebSite.all, [2, 5])
    func shortenedListRetainsAllPinsAndSelectedOlderRow(site: WebSite, pinCount: Int) throws {
        let shelf = shelf()
        let selected = try record(shelf, "older1234", on: site)
        for index in 0..<7 {
            let row = try record(shelf, "row\(index)1234", on: site, page: UUID(), at: Double(index + 1), awaiting: true)
            if index < pinCount {
                shelf.setPinned(true, conversation: row, of: site, now: now.addingTimeInterval(Double(index)))
            }
        }
        let all = shelf.listed(of: site)
        let shortened = shelf.listed(of: site, limit: TraceBook.listedAtMost)
        let pins = Array(all.prefix(pinCount))
        #expect(shortened.filter(\.isPinned) == pins)
        #expect(shortened.first?.isPinned == true)
        #expect(shortened.last?.id == selected.id)
        #expect(shortened.count == max(pinCount, TraceBook.listedAtMost) + 1)
        #expect(Set(shortened.map(\.id)).count == shortened.count)
        // Removing a pin restores awaiting-first ordering and still preserves selection.
        shelf.setPinned(false, conversation: pins[0], of: site)
        let after = shelf.listed(of: site, limit: TraceBook.listedAtMost)
        #expect(after.filter(\.isPinned).count == pinCount - 1)
        #expect(after.contains { $0.id == selected.id })
        #expect(after.count == max(pinCount - 1, TraceBook.listedAtMost) + 1)
        // Explicit settlement remains respected for an unpinned selected row.
        shelf.settle(selected, of: site, now: now)
        #expect(!shelf.listed(of: site, limit: TraceBook.listedAtMost).contains { $0.id == selected.id })
    }

    @Test func pinningAnotherAccountsRowPreservesBothNavigationSnapshots() throws {
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        let shelf = workspace.web
        let site = WebSite.gemini
        let first = shelf.account(of: site), work = shelf.addAccount(on: site)
        let personalPage = UUID(), workPage = UUID()
        workspace.navigate(to: site, account: first)
        shelf.handled(site)
        shelf.attach(personalPage, account: first)
        shelf.bringToFront(personalPage, on: site)
        let personal = try record(shelf, "personal1234", page: personalPage, awaiting: true)
        workspace.navigate(to: site, account: work)
        shelf.handled(site)
        shelf.attach(workPage, account: work)
        shelf.bringToFront(workPage, on: site)
        let workRow = try record(shelf, "work1234", page: workPage)
        let open = shelf.open, front = shelf.front, requested = shelf.requested
        let status = shelf.status
        shelf.setPinned(true, conversation: personal, of: site, now: now)
        shelf.setPinned(true, conversation: workRow, of: site, now: now.addingTimeInterval(1))
        #expect(shelf.open == open && shelf.front == front && shelf.requested == requested && shelf.status == status)
        for account in [first, work, first, work] {
            workspace.navigate(to: site, account: account)
            let expected = account == first ? personal : workRow
            #expect(shelf.open[site.id] == expected.id)
            #expect(shelf.frontPage(of: site) == (account == first ? personalPage : workPage))
            #expect(shelf.requested[site.id] == nil)
            #expect(shelf.account(of: site).dataStoreID == account.dataStoreID)
            #expect(shelf.listed(of: site, limit: 1).map(\.id) == [personal.id, workRow.id])
        }
        #expect(self.shelf().listed(of: site).map(\.id) == [personal.id, workRow.id])
    }

}
