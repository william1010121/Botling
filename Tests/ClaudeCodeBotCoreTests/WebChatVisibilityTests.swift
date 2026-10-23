import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct WebChatVisibilityTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-web-visibility-\(UUID())")
    let now = Date(timeIntervalSince1970: 1_792_655_000)

    func workspace() -> Workspace {
        Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
    }

    @Test(arguments: WebSite.all, [false, true])
    func providerNavigationKeepsCurrentConversation(site: WebSite, waiting: Bool) throws {
        let workspace = workspace()
        let shelf = workspace.web
        let page = UUID()
        workspace.select(site)
        shelf.bringToFront(page, on: site)
        let turns = [WebTurn(role: .user, text: "Current question")]
            + (waiting ? [] : [WebTurn(role: .assistant, text: "Current answer")])
        shelf.record(on: site, page: page, url: site.conversationURL("current1234"), pageTitle: nil,
                     reading: .read(title: "Current question", turns: turns), now: now)
        let status = shelf.status[site.id]
        #expect(shelf.listed(of: site).map(\.id) == ["current1234"])
        // The same callback used by expanded and folded provider rows.
        for destination in [site.selectionID, nil, WebSite.all.first { $0 != site }!.selectionID] {
            workspace.select(destination)
            workspace.navigate(to: site)
            #expect(workspace.selectedWebSite == site)
            #expect(shelf.open[site.id] == "current1234")
            #expect(shelf.frontPage(of: site) == page)
            #expect(shelf.requested[site.id] == nil)
            #expect(shelf.status[site.id] == status)
            #expect(shelf.listed(of: site).map(\.id) == ["current1234"])
            #expect(shelf.conversation("current1234", of: site)?.isAwaiting == waiting)
        }
    }

    @Test func accountNavigationRestoresOwnConversationWithoutLoadingAnotherAccountsPage() throws {
        let workspace = workspace()
        let shelf = workspace.web
        let site = WebSite.gemini
        let first = shelf.account(of: site)
        let work = shelf.addAccount(on: site, name: "work", now: now)
        let profiles = shelf.accounts(of: site).accounts.map(\.dataStoreID)
        let firstPage = UUID(), workPage = UUID()
        workspace.select(site)
        shelf.attach(firstPage, account: first)
        shelf.bringToFront(firstPage, on: site)
        shelf.record(on: site, page: firstPage, url: site.conversationURL("personal1234"), pageTitle: nil,
                     reading: .read(title: "Personal", turns: [WebTurn(role: .user, text: "personal")]), now: now)
        workspace.navigate(to: site, account: work)
        shelf.handled(site)
        shelf.attach(workPage, account: work)
        shelf.bringToFront(workPage, on: site)
        shelf.record(on: site, page: workPage, url: site.conversationURL("work1234"), pageTitle: nil,
                     reading: .read(title: "Work", turns: [WebTurn(role: .user, text: "work"), WebTurn(role: .assistant, text: "answer")]), now: now)
        for _ in 0..<2 {
            workspace.navigate(to: site, account: first)
            #expect(shelf.account(of: site) == first)
            #expect(shelf.open[site.id] == "personal1234")
            #expect(shelf.frontPage(of: site) == firstPage)
            #expect(shelf.requested[site.id] == nil)
            workspace.navigate(to: site, account: work)
            #expect(shelf.account(of: site) == work)
            #expect(shelf.open[site.id] == "work1234")
            #expect(shelf.frontPage(of: site) == workPage)
            #expect(shelf.requested[site.id] == nil)
        }
        #expect(Set(shelf.listed(of: site).map(\.id)) == ["personal1234", "work1234"])
        #expect(shelf.accounts(of: site).accounts.map(\.dataStoreID) == profiles)
        #expect(shelf.account(of: try #require(shelf.conversation("work1234", of: site)), on: site) == work)
    }

    @Test func navigationDoesNotReplaceAPendingConversationRequest() throws {
        let workspace = workspace()
        let site = WebSite.grok
        let shelf = workspace.web
        shelf.pageChanged(on: site, url: site.conversationURL("pending1234"), pageTitle: "Pending", now: now)
        workspace.open(try #require(shelf.openConversation(of: site)), on: site)
        workspace.navigate(to: site)
        #expect(shelf.requested[site.id] == site.conversationURL("pending1234"))
        #expect(shelf.requestedRow[site.id] == "pending1234")
        #expect(shelf.open[site.id] == "pending1234")
    }

    @Test func selectedOlderConversationStaysVisibleWhenOtherRowsAreShortened() throws {
        let workspace = workspace()
        let shelf = workspace.web
        let site = WebSite.chatgpt
        workspace.select(site)
        shelf.record(on: site, url: site.conversationURL("older1234"), pageTitle: nil,
                     reading: .read(title: "Selected older question", turns: [WebTurn(role: .user, text: "q"), WebTurn(role: .assistant, text: "a")]), now: now)
        for i in 0..<7 {
            shelf.record(on: site, page: UUID(), url: site.conversationURL("waiting\(i)1234"), pageTitle: nil,
                         reading: .read(title: "Waiting \(i)", turns: [WebTurn(role: .user, text: "q")]), now: now.addingTimeInterval(Double(i + 1)))
        }
        let shortened = shelf.listed(of: site, limit: TraceBook.listedAtMost)
        #expect(shortened.count == TraceBook.listedAtMost + 1)
        #expect(shortened.contains { $0.id == "older1234" })
        #expect(shelf.listed(of: site).count == 8)
        workspace.navigate(to: site)
        #expect(shelf.listed(of: site, limit: TraceBook.listedAtMost) == shortened)
        // Explicitly settling the selected row is still respected, including after navigation.
        shelf.settle(try #require(shelf.conversation("older1234", of: site)), of: site, now: now)
        workspace.navigate(to: site)
        #expect(!shelf.listed(of: site, limit: TraceBook.listedAtMost).contains { $0.id == "older1234" })
        #expect(shelf.listed(of: site, limit: TraceBook.listedAtMost).count == TraceBook.listedAtMost)
    }

    @Test func pendingRequestsStayWithTheirOwnAccount() throws {
        let workspace = workspace()
        let shelf = workspace.web
        let site = WebSite.gemini
        let first = shelf.account(of: site)
        let work = shelf.addAccount(on: site)
        shelf.pageChanged(on: site, url: site.conversationURL("personal1234"), pageTitle: "Personal", now: now)
        workspace.open(try #require(shelf.openConversation(of: site)), on: site)
        workspace.navigate(to: site, account: work)
        #expect(shelf.requested[site.id] == nil)
        #expect(shelf.open[site.id] == nil)
        workspace.navigate(to: site, account: first)
        #expect(shelf.requested[site.id] == site.conversationURL("personal1234"))
        #expect(shelf.requestedRow[site.id] == "personal1234")
        workspace.navigate(to: site, account: work)
        #expect(shelf.requested[site.id] == nil)
    }

    @Test func replyFinishedInAnotherAccountIsRestoredWithCurrentStatus() throws {
        let workspace = workspace()
        let shelf = workspace.web
        let site = WebSite.gemini
        let first = shelf.account(of: site)
        let work = shelf.addAccount(on: site)
        let page = UUID()
        workspace.select(site)
        shelf.bringToFront(page, on: site)
        shelf.record(on: site, page: page, url: site.conversationURL("personal1234"), pageTitle: nil,
                     reading: .read(title: "Question", turns: [WebTurn(role: .user, text: "q")]), now: now)
        workspace.navigate(to: site, account: work)
        shelf.record(on: site, page: page, url: site.conversationURL("personal1234"), pageTitle: nil,
                     reading: .read(title: "Question", turns: [WebTurn(role: .user, text: "q"), WebTurn(role: .assistant, text: "finished")]), now: now.addingTimeInterval(1))
        workspace.navigate(to: site, account: first)
        #expect(shelf.status[site.id] == .saved(messages: 2, at: now.addingTimeInterval(1)))
        #expect(shelf.open[site.id] == "personal1234")
        #expect(shelf.requested[site.id] == nil)
        #expect(shelf.listed(of: site).map(\.id) == ["personal1234"])
    }

    @Test func nativeChatAndItsDraftSurviveAWebNavigationRoundTrip() {
        BotStore(directory: Workspace.Layout.mainBot(in: root)).save(messages: [ChatMessage(role: .user, text: "Native conversation")])
        let workspace = workspace()
        let bot = workspace.selectedBot
        let messages = bot.messages
        workspace.drafts.set("native", ComposerDrafts.Draft(text: "Unsent thought", cursor: 3))
        for site in WebSite.all {
            workspace.navigate(to: site)
            workspace.select(nil)
            #expect(workspace.selection == nil)
            #expect(workspace.selectedBot === bot)
            #expect(bot.messages == messages)
            #expect(workspace.drafts.all["native"]?.text == "Unsent thought")
        }
    }


    @Test func clickingAnotherAccountsRowKeepsThePreviousAccountsCurrentConversation() throws {
        let workspace = workspace()
        let shelf = workspace.web
        let site = WebSite.gemini
        let first = shelf.account(of: site)
        let work = shelf.addAccount(on: site)
        let page = UUID()
        workspace.select(site)
        shelf.record(on: site, url: site.conversationURL("personal1234"), pageTitle: nil,
                     reading: .read(title: "Personal", turns: [WebTurn(role: .user, text: "q"), WebTurn(role: .assistant, text: "a")]), now: now)
        shelf.attach(page, account: work)
        shelf.record(on: site, page: page, url: site.conversationURL("work1234"), pageTitle: nil,
                     reading: .read(title: "Work", turns: [WebTurn(role: .user, text: "work")]), now: now)
        workspace.open(try #require(shelf.conversation("work1234", of: site)), on: site)
        #expect(shelf.account(of: site) == work)
        #expect(shelf.requested[site.id] == site.conversationURL("work1234"))
        #expect(shelf.conversation("personal1234", of: site)?.isSettled == false)
        workspace.navigate(to: site, account: first)
        #expect(shelf.open[site.id] == "personal1234")
        #expect(shelf.requested[site.id] == nil)
        #expect(Set(shelf.listed(of: site).map(\.id)) == ["personal1234", "work1234"])
    }

}
