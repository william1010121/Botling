import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Several Google accounts on Gemini: each its own data store; the one from before accounts is
/// the first, on the site's original store; each row opens in the account it was asked in.
@MainActor
struct WebAccountTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-web-accounts-\(UUID().uuidString)")
    let now = Date(timeIntervalSince1970: 1_792_655_000)
    let gemini = WebSite.gemini
    var web: URL { root.appending(path: "web") }

    private func shelf() -> WebShelf { WebShelf(folder: web, library: root.appending(path: "plugins")) }

    private func workspace() -> Workspace {
        Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
    }

    private func answered(_ q: String) -> WebReading {
        .read(title: q, turns: [WebTurn(role: .user, text: q), WebTurn(role: .assistant, text: "a: " + q)])
    }

    // MARK: Migration

    @Test func theFirstAccountIsTheSitesOriginalStoreAndLegacyRowsAreIts() throws {
        // A conversation list written before accounts existed (no accountID).
        let folder = web.appending(path: "gemini")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let legacy = """
        [{"id":"8f3a2c1d","url":"https://gemini.google.com/app/8f3a2c1d","title":"Old one","messages":2,"file":"old-one.md","updatedAt":"2026-10-01T10:00:00Z","savedAt":"2026-10-01T10:00:00Z"}]
        """
        try Data(legacy.utf8).write(to: folder.appending(path: "conversations.json"))
        try Data("# Old one\n".utf8).write(to: folder.appending(path: "old-one.md"))

        let shelf = shelf()
        let list = shelf.accounts(of: gemini)
        #expect(list.accounts.count == 1)
        #expect(list.first.id == WebAccount.firstID)
        // The store the user signed in to before is account #1's, unchanged.
        #expect(list.first.dataStoreID == gemini.dataStoreID)
        #expect(list.first.dataStoreID.uuidString == "3E3B0000-0000-4000-8000-0000000000D1")
        #expect(!list.hasSeveral)
        let row = try #require(shelf.conversations(of: gemini).first)
        #expect(row.accountID == nil)
        #expect(shelf.account(of: row, on: gemini).isFirst)
        #expect(shelf.account(of: gemini).isFirst)
        // Loading writes nothing: no accounts file until one is added, and the old list and its
        // file are as they were.
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: WebAccountList.fileName).path))
        #expect(try String(contentsOf: folder.appending(path: "conversations.json"), encoding: .utf8) == legacy)
        // Showing it opens it in the first account.
        shelf.show(row, of: gemini, now: now)
        #expect(shelf.account(of: gemini).isFirst)
        #expect(shelf.requested["gemini"] == row.url)
    }

    @Test func aRowOfTheFirstAccountIsSavedWithoutAnAccountKey() throws {
        let shelf = shelf()
        shelf.record(on: gemini, url: URL(string: "https://gemini.google.com/app/feed1234")!, pageTitle: nil, reading: answered("q"), now: now)
        let text = try String(contentsOf: web.appending(path: "gemini/conversations.json"), encoding: .utf8)
        #expect(!text.contains("accountID"))
    }

    // MARK: The list

    @Test func addedAccountsGetTheirOwnRandomStoresAndColoursAndLastARestart() throws {
        let shelf = shelf()
        let work = shelf.addAccount(on: gemini, name: "  work ", now: now)
        let second = shelf.addAccount(on: gemini, now: now)
        let builtIn = Set(WebSite.all.map(\.dataStoreID))
        #expect(work.name == "work")
        #expect(!builtIn.contains(work.dataStoreID))
        #expect(!builtIn.contains(second.dataStoreID))
        #expect(work.dataStoreID != second.dataStoreID)
        #expect(Set([0, work.color, second.color]).count == 3)
        #expect(shelf.accounts(of: gemini).hasSeveral)

        let list = shelf.accounts(of: gemini)
        #expect(list.label(of: list.first) == "Account 1")
        #expect(list.label(of: work) == "work")
        #expect(list.label(of: second) == "Account 3")
        #expect(list.letter(of: work) == "W")
        #expect(list.letter(of: second) == "3")

        shelf.renameAccount(second.id, to: "user2", on: gemini)
        shelf.renameAccount(WebAccount.firstID, to: "user1", on: gemini)
        // Names that start alike are told apart by number.
        let renamed = shelf.accounts(of: gemini)
        #expect(renamed.accounts.map { renamed.letter(of: $0) } == ["1", "W", "3"])
        shelf.renameAccount(WebAccount.firstID, to: "me", on: gemini)
        let reloaded = self.shelf().accounts(of: gemini)
        #expect(reloaded.accounts.map(\.id) == [WebAccount.firstID, work.id, second.id])
        #expect(reloaded.accounts.map(\.name) == ["me", "work", "user2"])
        #expect(reloaded.accounts.map(\.dataStoreID) == [gemini.dataStoreID, work.dataStoreID, second.dataStoreID])
        // Other sites keep their single account.
        #expect(!reloaded.site.id.isEmpty && !self.shelf().accounts(of: .chatgpt).hasSeveral)
    }

    @Test func aTamperedListNeverMovesTheFirstAccountOrReusesABuiltInStore() throws {
        let folder = web.appending(path: "gemini")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let other = UUID()
        let json = """
        [{"id":"first","name":"me","color":2,"dataStoreID":"\(UUID().uuidString)"},
         {"id":"a-1","name":"chatgpt's","color":1,"dataStoreID":"3E3B0000-0000-4000-8000-0000000000D2"},
         {"id":"a-2","name":"ok","color":1,"dataStoreID":"\(other.uuidString)"},
         {"id":"a-3","name":"dup","color":3,"dataStoreID":"\(other.uuidString)"}]
        """
        try Data(json.utf8).write(to: folder.appending(path: WebAccountList.fileName))
        let list = shelf().accounts(of: gemini)
        #expect(list.accounts.map(\.id) == [WebAccount.firstID, "a-2"])
        #expect(list.first.dataStoreID == gemini.dataStoreID)
        #expect(list.first.name == "me")
    }

    @Test func accountColoursAreNeverBlue() {
        // A blue dot means a row waits for its answer: no account may look like it.
        for color in WebAccount.palette {
            let r = Double((color >> 16) & 0xFF) / 255, g = Double((color >> 8) & 0xFF) / 255, b = Double(color & 0xFF) / 255
            let high = max(r, g, b), low = min(r, g, b)
            guard high - low > 0.05 else { continue }
            var hue: Double
            if high == r { hue = (g - b) / (high - low) } else if high == g { hue = 2 + (b - r) / (high - low) } else { hue = 4 + (r - g) / (high - low) }
            hue = (hue * 60 + 360).truncatingRemainder(dividingBy: 360)
            #expect(!(180...245).contains(hue), "colour \(String(color, radix: 16)) reads as blue (hue \(Int(hue)))")
        }
        #expect(Set(WebAccount.palette).count == WebAccount.palette.count)
    }

    // MARK: Routing

    @Test func aConversationIsOfThePagesAccountAndOpensInIt() throws {
        let shelf = shelf()
        let work = shelf.addAccount(on: gemini, name: "work", now: now)
        // A page signed in to "work" reads a conversation: its row is work's.
        let page = UUID()
        shelf.attach(page, account: work)
        shelf.startNew(on: gemini, account: work, now: now)
        #expect(shelf.account(of: gemini) == work)
        shelf.bringToFront(page, on: gemini)
        shelf.record(on: gemini, page: page, url: URL(string: "https://gemini.google.com/app/w0rk0001")!, pageTitle: nil, reading: answered("work q"), now: now)
        // The first account's page reads another.
        shelf.record(on: gemini, url: URL(string: "https://gemini.google.com/app/f1rst001")!, pageTitle: nil, reading: answered("own q"), now: now.addingTimeInterval(1))
        let workRow = try #require(shelf.conversation("w0rk0001", of: gemini))
        let ownRow = try #require(shelf.conversation("f1rst001", of: gemini))
        #expect(workRow.accountID == work.id)
        #expect(ownRow.accountID == nil)
        #expect(shelf.account(ofPage: page, on: gemini) == work)
        #expect(shelf.account(ofPage: WebShelf.firstPage, on: gemini).isFirst)

        // Clicking a row opens it in its own account.
        shelf.show(ownRow, of: gemini, now: now)
        #expect(shelf.account(of: gemini).isFirst)
        #expect(shelf.requested["gemini"] == ownRow.url)
        shelf.show(workRow, of: gemini, now: now)
        #expect(shelf.account(of: gemini) == work)
        #expect(shelf.requested["gemini"] == workRow.url)

        // Both are kept over a restart, each with its account.
        let reloaded = self.shelf()
        #expect(reloaded.conversation("w0rk0001", of: gemini).map { reloaded.account(of: $0, on: gemini) } == work)
        #expect(reloaded.conversation("f1rst001", of: gemini).map { reloaded.account(of: $0, on: gemini).isFirst } == true)
    }

    @Test func rowsWaitingAreReadAgainOnTheirOwnAccountsStore() {
        let shelf = shelf()
        let work = shelf.addAccount(on: gemini, name: "work", now: now)
        let page = UUID()
        shelf.attach(page, account: work)
        shelf.record(on: gemini, page: page, url: URL(string: "https://gemini.google.com/app/w0rk0002")!, pageTitle: nil,
                     reading: .read(title: nil, turns: [WebTurn(role: .user, text: "q")]), now: now)
        shelf.record(on: gemini, url: URL(string: "https://gemini.google.com/app/f1rst002")!, pageTitle: nil,
                     reading: .read(title: nil, turns: [WebTurn(role: .user, text: "q2")]), now: now)
        shelf.closed(page)
        shelf.closed(WebShelf.firstPage)
        #expect(shelf.toReadAgain(on: gemini, account: work).map(\.id) == ["w0rk0002"])
        #expect(shelf.toReadAgain(on: gemini, account: shelf.accounts(of: gemini).first).map(\.id) == ["f1rst002"])
        // After a restart too.
        let reloaded = self.shelf()
        #expect(reloaded.toReadAgain(on: gemini, account: work).map(\.id) == ["w0rk0002"])
    }

    @Test func aQuestionWithNoIDYetIsNeverAdoptedByAnotherAccountsConversation() {
        let shelf = shelf()
        let work = shelf.addAccount(on: gemini, name: "work", now: now)
        let question = "Same words in both accounts"
        // Asked in the first account; its page closes before it had an id.
        shelf.record(on: gemini, url: gemini.startURL, pageTitle: nil, reading: .read(title: nil, turns: [WebTurn(role: .user, text: question)]), now: now)
        shelf.closed(WebShelf.firstPage)
        // "work" shows a conversation with the same question: it is work's own row.
        let page = UUID()
        shelf.attach(page, account: work)
        shelf.record(on: gemini, page: page, url: URL(string: "https://gemini.google.com/app/w0rk0003")!, pageTitle: nil, reading: .read(title: nil, turns: [
            WebTurn(role: .user, text: question), WebTurn(role: .assistant, text: "a"),
        ]), now: now.addingTimeInterval(5))
        #expect(shelf.conversations(of: gemini).count == 2)
        #expect(shelf.conversation("w0rk0003", of: gemini)?.accountID == work.id)
        #expect(shelf.conversations(of: gemini).contains { $0.id.hasPrefix("new-") && $0.accountID == nil })
    }

    @Test func sameTitlesInTwoAccountsSaveToTwoFiles() throws {
        let shelf = shelf()
        let work = shelf.addAccount(on: gemini, name: "work", now: now)
        let page = UUID()
        shelf.attach(page, account: work)
        let a = try #require(shelf.record(on: gemini, url: URL(string: "https://gemini.google.com/app/aaaa0001")!, pageTitle: nil, reading: answered("Plan"), now: now))
        let b = try #require(shelf.record(on: gemini, page: page, url: URL(string: "https://gemini.google.com/app/bbbb0001")!, pageTitle: nil, reading: answered("Plan"), now: now))
        #expect(a != b)
        #expect(try String(contentsOf: a, encoding: .utf8).contains("a: Plan"))
        #expect(try String(contentsOf: b, encoding: .utf8).contains("a: Plan"))
    }

    @Test func pickingAnAccountInTheMenuOpensANewQuestionInIt() {
        let workspace = workspace()
        let shelf = workspace.web
        let work = shelf.addAccount(on: gemini, name: "work", now: now)
        workspace.openFresh(gemini)
        shelf.handled(gemini)
        #expect(shelf.account(of: gemini).isFirst)
        // On a fresh page of the first account, picking "work" still opens a fresh one in work.
        workspace.openFresh(gemini, account: work)
        #expect(workspace.selectedWebSite == gemini)
        #expect(shelf.account(of: gemini) == work)
        #expect(shelf.requested["gemini"] == gemini.startURL)
        #expect(shelf.open["gemini"] == nil)
        shelf.handled(gemini)
        // Picking it again on its fresh page reloads nothing.
        workspace.openFresh(gemini, account: work)
        #expect(shelf.requested["gemini"] == nil)
        // The site's own row asks in the account shown.
        workspace.openFresh(gemini)
        #expect(shelf.account(of: gemini) == work)
    }

    // MARK: Removal

    @Test func removingAnAccountKeepsItsTextAndNeverTheFirst() throws {
        let shelf = shelf()
        let work = shelf.addAccount(on: gemini, name: "work", now: now)
        let page = UUID()
        shelf.attach(page, account: work)
        shelf.startNew(on: gemini, account: work, now: now)
        let file = try #require(shelf.record(on: gemini, page: page, url: URL(string: "https://gemini.google.com/app/w0rk0004")!, pageTitle: nil, reading: answered("kept"), now: now))
        shelf.handled(gemini)

        #expect(shelf.removeAccount(WebAccount.firstID, on: gemini) == nil)
        #expect(shelf.accounts(of: gemini).first.dataStoreID == gemini.dataStoreID)

        let removed = try #require(shelf.removeAccount(work.id, on: gemini, now: now))
        #expect(removed.dataStoreID == work.dataStoreID)
        #expect(WebAccountList.isRemovableStore(removed.dataStoreID))
        for site in WebSite.all { #expect(!WebAccountList.isRemovableStore(site.dataStoreID)) }
        // The column goes back to the first account, on a new question.
        #expect(shelf.account(of: gemini).isFirst)
        #expect(shelf.requested["gemini"] == gemini.startURL)
        #expect(shelf.account(ofPage: page, on: gemini).isFirst)
        // Its saved text stays for the main bot; its row now opens in the first account.
        #expect(FileManager.default.fileExists(atPath: file.path))
        let row = try #require(shelf.conversation("w0rk0004", of: gemini))
        #expect(shelf.account(of: row, on: gemini).isFirst)
        #expect(!self.shelf().accounts(of: gemini).hasSeveral)
    }
}
