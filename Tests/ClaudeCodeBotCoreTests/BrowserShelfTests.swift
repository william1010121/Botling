import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct BrowserShelfTests {
    @Test func directNavigationPinAndAccountIdentitySurviveReload() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let shelf = BrowserShelf(folder: folder)
        let original = shelf.page
        let target = try #require(BrowserShelf.address("fixture.test/tasks"))
        shelf.update(original.id, url: target, title: "Tasks"); shelf.togglePin(); shelf.newAccount()
        #expect(shelf.page.account != original.account)
        #expect(shelf.page.id != original.id)
        shelf.open(original.id)
        let restored = BrowserShelf(folder: folder)
        #expect(restored.page.id == original.id)
        #expect(restored.page.account == original.account)
        #expect(restored.pins.count == 1)
        #expect(restored.page.url == target)
        #expect(restored.page.captureSite.dataStoreID == original.account)
    }
    @Test func pinKeepsWebsiteWhenTheBrowserMovesToAnotherOrigin() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let shelf = BrowserShelf(folder: folder)
        shelf.togglePin()
        let pin = shelf.pins[0]
        shelf.update(shelf.current, url: URL(string: "https://other.test/path")!, title: "Other")
        #expect(shelf.pins[0].origin == "https://example.com")
        #expect(!shelf.page.pinned)
        shelf.togglePin()
        #expect(Set(shelf.pins.map(\.pinID)).count == 2)
        shelf.openPin(pin)
        #expect(shelf.page.origin == "https://example.com")
        #expect(shelf.requestedURL == pin.url)
    }
    @Test func originsAndAddressesRejectNonWebAndCredentialURLs() {
        #expect(BrowserShelf.address("javascript:alert(1)") == nil)
        #expect(BrowserShelf.address("file:///etc/passwd") == nil)
        #expect(BrowserShelf.address("https://name:secret@fixture.test") == nil)
        #expect(BrowserShelf.address("") == nil)
        #expect(BrowserShelf.origin(URL(string: "https://FIXTURE.test:443/a")!) == "https://fixture.test")
        #expect(BrowserShelf.origin(URL(string: "http://localhost:8712/a")!) == "http://localhost:8712")
    }
    @Test func toolsAssociateWithExactOriginsAndDispose() throws {
        let shelf = BrowserShelf(folder: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        try shelf.register(plugin: "fixture", key: "tasks", title: "Read tasks", origin: "https://example.com")
        #expect(shelf.tools(for: shelf.page).count == 1)
        shelf.update(shelf.current, url: URL(string: "https://example.com.evil.test")!, title: nil)
        #expect(shelf.tools(for: shelf.page).isEmpty)
        #expect(throws: (any Error).self) { try shelf.register(plugin: "fixture", key: "bad", title: "bad", origin: "https://example.com/path") }
        shelf.unregister(plugin: "fixture", key: "tasks")
        #expect(shelf.tools.isEmpty)
        try shelf.register(plugin: "disabled", key: "tasks", title: "Read tasks", origin: "https://example.com")
        shelf.retainTools(plugins: ["other"])
        #expect(shelf.tools.isEmpty)
    }
    @Test func generalBrowserIsNotViewingTheChatBehindIt() {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let workspace = Workspace(root: root) { profile, store in Bot(profile: profile, launcher: FakeLauncher().launcher, store: store) }
        workspace.windowFocused = true
        workspace.select(BrowserShelf.selectionID)
        #expect(!workspace.isViewing(workspace.mainBot))
        #expect(!workspace.showsBoardSwitch)
    }
    @Test func generalWebsiteCapturesAreDiscoveredAndExpired() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let now = Date()
        let page = BrowserShelf.Page(url: URL(string: "https://fixture.test")!)
        for daysAgo in [1.0, 40] {
            let date = now.addingTimeInterval(-daysAgo * 86400)
            let input = WebCaptureInput(site: page.captureSite, url: page.url, pageTitle: "Fixture", startedAt: date, endedAt: date,
                stoppedBy: "you", events: [], html: "<p>Fixture</p>", outline: nil, screenshot: nil, extractor: nil, output: nil, appVersion: "test")
            _ = try WebCapturePack.write(input, in: root)
        }
        #expect(WebCapturePack.packs(at: root).count == 2)
        #expect(WebCapturePack.prune(in: root, now: now).count == 1)
        #expect(WebCapturePack.packs(at: root).count == 1)
    }
    @Test func clickOptInIsSavedForOnlyItsExactWebsiteAndAccount() {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let shelf = BrowserShelf(folder: root)
        let first = shelf.page
        #expect(!shelf.clicksAllowed(for: first))
        shelf.allowClicks(true, for: first)
        shelf.newAccount()
        #expect(!shelf.clicksAllowed(for: shelf.page))
        shelf.open(first.id)
        shelf.update(first.id, url: URL(string: "https://other.test")!, title: nil)
        #expect(!shelf.clicksAllowed(for: shelf.page))
        let restored = BrowserShelf(folder: root)
        #expect(restored.clicksAllowed(for: first))
        restored.allowClicks(false, for: first)
        #expect(!BrowserShelf(folder: root).clicksAllowed(for: first))
    }
    @Test func handoffRejectsMismatchedCaptureWithoutSending() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = Workspace(root: root) { profile, store in Bot(profile: profile, launcher: FakeLauncher().launcher, store: store) }
        let page = BrowserShelf.Page(url: URL(string: "https://fixture.test")!)
        let input = WebCaptureInput(site: page.captureSite, url: page.url, pageTitle: "Fixture", startedAt: Date(), endedAt: Date(),
            stoppedBy: "you", events: [], html: "<p>Fixture</p>", outline: nil, screenshot: nil, extractor: nil, output: nil, appVersion: "test")
        let pack = try WebCapturePack.write(input, in: workspace.web.capturesFolder)
        let other = BrowserShelf.Page(url: URL(string: "https://other.test")!)
        #expect(throws: (any Error).self) { try workspace.sendWebsiteCaptureToMaintainer(pack, page: other, request: "Read tasks") }
        #expect(!FileManager.default.fileExists(atPath: pack.folder.appending(path: "website-request.json").path))
    }
    @Test func captureHandoffPreservesRequestAndUsesSeparateActionContract() {
        let page = BrowserShelf.Page(url: URL(string: "https://fixture.test/tasks")!)
        let message = Workspace.websiteCaptureHandoff(WebCapturePack(folder: URL(filePath: "/tmp/private-pack")), page: page, request: "Open details and extract tasks", library: URL(filePath: "/tmp/plugins"))
        #expect(message.contains("Open details and extract tasks"))
        #expect(message.contains(page.account.uuidString))
        #expect(message.contains(page.id.uuidString))
        #expect(message.contains("ccb.browser.registerTool"))
        #expect(message.contains("Do not modify the App"))
    }
}
