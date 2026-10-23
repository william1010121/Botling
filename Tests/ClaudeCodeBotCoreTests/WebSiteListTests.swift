import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// ChatGPT and Claude next to Gemini: each a `WebSite` entry (data only), read by its own script
/// in the plugin, and everything else (rows, the right panel, saved text) shared.
@MainActor
struct WebSiteListTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-web-list-\(UUID().uuidString)")
    let now = Date(timeIntervalSince1970: 1_792_655_000)
    let chatgpt = WebSite.chatgpt
    let claude = WebSite.claude

    @Test func theColumnListsAllWebProviders() {
        #expect(WebSite.all.map(\.id) == ["gemini", "chatgpt", "claude", "grok"])
        #expect(WebSite.all.map(\.name) == ["Gemini", "ChatGPT", "Claude", "Grok"])
        // Each its own selection, sign-in store and face.
        #expect(Set(WebSite.all.map(\.selectionID)).count == WebSite.all.count)
        #expect(Set(WebSite.all.map(\.dataStoreID)).count == WebSite.all.count)
        #expect(Set(WebSite.all.map(\.accent)).count == WebSite.all.count)
        #expect(Set(WebSite.all.map(\.symbol)).count == WebSite.all.count)
        for site in WebSite.all {
            #expect(WebSite.site(selection: site.selectionID) == site)
            #expect(!site.symbol.isEmpty)
        }
    }

    @Test func eachSitesStartPageIsANewQuestionOnItsOwnHost() {
        #expect(chatgpt.startURL.absoluteString == "https://chatgpt.com/")
        #expect(claude.startURL.absoluteString == "https://claude.ai/new")
        for site in WebSite.all {
            #expect(site.startURL.host() == site.host)
            #expect(site.conversationID(in: site.startURL) == nil)
        }
    }

    @Test func aChatGPTConversationIsKnownByItsURL() {
        let id = "68f1c2a4-93b0-8001-a7e2-5c0d1e9f4b21"
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/c/\(id)")!) == id)
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/c/\(id)?model=gpt-5")!) == id)
        // In a GPT or a project.
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/g/g-p-67a0b1c2d3e4-release-notes/c/\(id)")!) == id)
        // New chat, a temporary chat, a GPT's start page, a shared link, another host: none.
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/")!) == nil)
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/?temporary-chat=true")!) == nil)
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/g/g-p-67a0b1c2d3e4-release-notes/project")!) == nil)
        #expect(chatgpt.conversationID(in: URL(string: "https://chatgpt.com/share/\(id)")!) == nil)
        #expect(chatgpt.conversationID(in: URL(string: "https://auth.openai.com/c/\(id)")!) == nil)
    }

    @Test func aClaudeConversationIsKnownByItsURL() {
        let id = "4b9e2f10-6c3d-4a8e-9f21-0d7c5b3a1e88"
        #expect(claude.conversationID(in: URL(string: "https://claude.ai/chat/\(id)")!) == id)
        #expect(claude.conversationID(in: URL(string: "https://claude.ai/chat/\(id)?artifactId=x")!) == id)
        #expect(claude.conversationID(in: URL(string: "https://claude.ai/new")!) == nil)
        #expect(claude.conversationID(in: URL(string: "https://claude.ai/recents")!) == nil)
        #expect(claude.conversationID(in: URL(string: "https://claude.ai/project/\(id)")!) == nil)
        #expect(claude.conversationID(in: URL(string: "https://claude.ai/artifact/\(id)")!) == nil)
    }

    @Test func grokRoutesAndLoginStayInsideItsOwnProfile() {
        let grok = WebSite.grok
        let id = "4b9e2f10-6c3d-4a8e-9f21-0d7c5b3a1e88"
        #expect(grok.startURL.absoluteString == "https://grok.com/")
        #expect(grok.conversationURL(id).absoluteString == "https://grok.com/c/\(id)")
        #expect(grok.conversationID(in: URL(string: "https://grok.com/c/\(id)?ref=web")!) == id)
        for url in ["https://grok.com/", "https://grok.com/sign-in", "https://grok.com/share/\(id)", "https://accounts.x.ai/c/\(id)", "https://grok.com/c/a%20b"] {
            #expect(grok.conversationID(in: URL(string: url)!) == nil)
        }
        for host in ["grok.com", "accounts.x.ai", "auth.x.ai", "accounts.google.com", "appleid.apple.com", "x.com", "twitter.com", "github.com"] {
            #expect(grok.keepsInside(URL(string: "https://\(host)/sign-in")!))
            #expect(!grok.keepsInside(URL(string: "https://not\(host)/sign-in")!))
        }
        // Existing login identities must never move when another provider is added.
        for (site, suffix) in zip([WebSite.gemini, .chatgpt, .claude, .grok], ["1", "2", "3", "4"]) {
            #expect(site.dataStoreID.uuidString == "3E3B0000-0000-4000-8000-0000000000D" + suffix)
            #expect(site.selectionID.uuidString == "3E3B0000-0000-4000-8000-0000000000E" + suffix)
        }
    }

    @Test func grokOpensSelectsAndRestoresItsSavedConversation() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        workspace.openFresh(.grok)
        #expect(workspace.selectedWebSite == .grok)
        #expect(workspace.web.requested["grok"] == WebSite.grok.startURL)
        #expect(!workspace.showsBoardSwitch)
        let url = WebSite.grok.conversationURL("grok-test-1234")
        let file = try #require(workspace.web.record(on: .grok, url: url, pageTitle: "Check - Grok",
            reading: .read(title: nil, turns: [.init(role: .user, text: "Check"), .init(role: .assistant, text: "Ready")]), now: now))
        let reloaded = WebShelf(folder: root.appending(path: "web"), library: root)
        let conversation = try #require(reloaded.conversations(of: .grok).first)
        #expect(conversation.url == url && conversation.messages == 2)
        #expect(reloaded.conversation(savedIn: file)?.site == .grok)
        #expect(reloaded.conversations(of: .claude).isEmpty)
        #expect(workspace.openSavedWebConversation(file))
        #expect(workspace.selectedWebSite == .grok)
        #expect(workspace.web.requested["grok"] == url)
        workspace.openFresh(.chatgpt)
        #expect(workspace.selectedWebSite == .chatgpt)
        #expect(workspace.web.conversations(of: .grok).count == 1)
    }

    @Test func aConversationsAddressIsBuiltFromItsID() {
        for site in WebSite.all {
            let url = site.conversationURL("8f3a2c1d9e0b")
            #expect(url.host() == site.host)
            #expect(site.conversationID(in: url) == "8f3a2c1d9e0b")
        }
        #expect(WebSite.gemini.conversationURL("8f3a2c1d").absoluteString == "https://gemini.google.com/app/8f3a2c1d")
        #expect(chatgpt.conversationURL("8f3a2c1d").absoluteString == "https://chatgpt.com/c/8f3a2c1d")
        #expect(claude.conversationURL("8f3a2c1d").absoluteString == "https://claude.ai/chat/8f3a2c1d")
    }

    @Test func signInPagesStayInsideAndOtherSitesOpenInTheBrowser() {
        for url in ["https://chatgpt.com/auth/login", "https://auth.openai.com/log-in", "https://accounts.google.com/o/oauth2/v2/auth",
                    "https://appleid.apple.com/auth/authorize", "https://login.microsoftonline.com/common/oauth2", "https://login.live.com/oauth20_authorize.srf"] {
            #expect(chatgpt.keepsInside(URL(string: url)!), "\(url)")
        }
        for url in ["https://claude.ai/login", "https://accounts.google.com/o/oauth2/v2/auth", "https://appleid.apple.com/auth/authorize"] {
            #expect(claude.keepsInside(URL(string: url)!), "\(url)")
        }
        // A link in an answer goes to the browser.
        for site in [chatgpt, claude, .grok] {
            #expect(!site.keepsInside(URL(string: "https://www.google.com/search?q=x")!))
            #expect(!site.keepsInside(URL(string: "https://example.com/?q=\(site.host)")!))
            #expect(!site.keepsInside(URL(string: "https://not\(site.host)/")!))
        }
        #expect(!claude.keepsInside(URL(string: "https://www.anthropic.com/news")!))
        // Gemini's stay as they were: all of google.com.
        #expect(WebSite.gemini.keepsInside(URL(string: "https://accounts.google.com/signin")!))
        #expect(WebSite.gemini.keepsInside(URL(string: "https://google.com/")!))
        #expect(!WebSite.gemini.keepsInside(URL(string: "https://chatgpt.com/")!))
    }

    @Test func aTabTitleLosesTheSitesName() {
        let turns = [WebTurn(role: .user, text: "Why hash?")]
        #expect(WebTranscript.title(extracted: nil, pageTitle: "Hashing basics - Claude", turns: turns, site: claude) == "Hashing basics")
        #expect(WebTranscript.title(extracted: nil, pageTitle: "Claude", turns: turns, site: claude) == "Why hash?")
        #expect(WebTranscript.title(extracted: nil, pageTitle: "ChatGPT", turns: turns, site: chatgpt) == "Why hash?")
        #expect(WebTranscript.title(extracted: nil, pageTitle: "Hashing basics", turns: turns, site: chatgpt) == "Hashing basics")
    }

    @Test func eachSiteSavesToItsOwnFolderAndALinkToTheFileOpensIt() throws {
        let shelf = WebShelf(folder: root.appending(path: "web"), library: root)
        for site in [chatgpt, claude, .grok] {
            // A question sent on the start page is a row at once, before the page has an id.
            shelf.startNew(on: site)
            shelf.record(on: site, url: site.startURL, pageTitle: site.name,
                         reading: .read(title: nil, turns: [WebTurn(role: .user, text: "What is $\\alpha$?")]), settled: false, now: now)
            let pending = try #require(shelf.conversations(of: site).first)
            #expect(pending.isAwaiting && pending.id.hasPrefix("new-"))
            // The page gets its id and the answer comes: the row becomes that conversation.
            let url = site.conversationURL("68f1c2a4-93b0")
            shelf.pageChanged(on: site, url: url, pageTitle: site.name, now: now)
            let file = try #require(shelf.record(on: site, url: url, pageTitle: site.name, reading: .read(title: "Load factor", turns: [
                WebTurn(role: .user, text: "What is $\\alpha$?"), WebTurn(role: .assistant, text: "$\\alpha := n/m$"),
            ]), now: now))
            #expect(file.path == root.appending(path: "web/\(site.id)/load-factor.md").path)
            #expect(shelf.conversations(of: site).map(\.id) == ["68f1c2a4-93b0"])
            #expect(shelf.conversations(of: site).first?.isAwaiting == false)
            let text = try String(contentsOf: file, encoding: .utf8)
            #expect(text.contains("- Site: \(site.name)\n- URL: \(url.absoluteString)"))
            #expect(text.contains("## \(site.name)\n\n$\\alpha := n/m$"))
            #expect(shelf.conversation(savedIn: file)?.site == site)
        }
        #expect(shelf.conversations(of: .gemini).isEmpty)
    }

    @Test func theMainBotIsToldOfEverySitesFolder() {
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        let note = workspace.mainBot.wakeNote?() ?? ""
        let folder = root.appending(path: "web").path
        #expect(note.contains("Gemini in \(folder)/gemini/, ChatGPT in \(folder)/chatgpt/, Claude in \(folder)/claude/"))
    }

    @Test func everySiteHasAPageReaderInTheApp() throws {
        let bundled = TestPaths.repo.appending(path: "Sources/ClaudeCodeBot/Resources/web-extractors")
        let library = root.appending(path: "plugins")
        WebExtractors.install(in: library, bundled: bundled)
        for site in WebSite.all {
            let script = try #require(WebExtractors.script(for: site, library: library, bundled: bundled))
            #expect(script.url.path == library.appending(path: "ccb-web-extractors/\(site.extractorFile)").path)
            #expect(script.source.contains("function extract(doc)"))
        }
        let manifest = try String(contentsOf: library.appending(path: "ccb-web-extractors/package.json"), encoding: .utf8)
        #expect(manifest.contains("Gemini, ChatGPT, Claude, Grok"))
    }
}
