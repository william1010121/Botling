import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The 「網頁預覽卡片」 component: result pages drawn inline, and served to its frame.
@MainActor
struct PagePreviewTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-preview-\(UUID().uuidString)").resolvingSymlinksInPath()

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    /// Writes `text` at `path` under the test folder.
    @discardableResult
    func write(_ path: String, _ text: String = "<!doctype html><meta charset=\"utf-8\"><h1>報告</h1>") throws -> URL {
        let url = root.appending(path: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func object(_ json: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    @Test func shipsAsAComponentWithItsAboutInChinese() throws {
        let library = makeWorkspace().components
        #expect(library.names.contains(PagePreview.component))
        let template = try #require(library.template(PagePreview.component))
        #expect(template.contains("ccb.open(data.url, title)"))
        #expect(template.contains("sandbox"))
        let catalog = library.catalog()
        #expect(catalog.contains("- 網頁預覽卡片: 網頁預覽卡片：把一頁式 HTML 結果直接縮小預覽在對話裡"))
        #expect(catalog.contains("<show name=\"網頁預覽卡片\">"))
        #expect(catalog.contains("\"path\""))
    }

    @Test func readsPathsTheWayBotsWriteThem() {
        #expect(PagePreview.fileURL(from: "file:///tmp/a/artifacts/x.html")?.path == "/tmp/a/artifacts/x.html")
        #expect(PagePreview.fileURL(from: "file:///tmp/%E5%A0%B1%E5%91%8A.html")?.path == "/tmp/報告.html")
        #expect(PagePreview.fileURL(from: " /tmp/a/../b.html ")?.path == "/tmp/b.html")
        #expect(PagePreview.fileURL(from: "~/x.html")?.path == FileManager.default.homeDirectoryForCurrentUser.appending(path: "x.html").path)
        #expect(PagePreview.fileURL(from: "relative/x.html") == nil)
        #expect(PagePreview.fileURL(from: "https://example.com/x.html") == nil)
        #expect(PagePreview.isArtifactPage(URL(filePath: "/p/.bot/artifacts/x.html")))
        #expect(PagePreview.isArtifactPage(URL(filePath: "/runs/1-prototype/artifacts/sub/x.HTM")))
        #expect(!PagePreview.isArtifactPage(URL(filePath: "/p/.bot/artifacts/x.png")))
        #expect(!PagePreview.isArtifactPage(URL(filePath: "/p/site/x.html")))
    }

    @Test func servesOnlyArtifactsAndPagesShownInACard() throws {
        let page = try write("p/.bot/artifacts/report.html")
        let picture = try write("p/.bot/artifacts/img/chart.svg", "<svg/>")
        let secret = try write("p/secret.txt", "key")
        let outside = try write("p/site/index.html")
        // A link inside artifacts that leads out of it.
        let link = root.appending(path: "p/.bot/artifacts/escape.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: secret)

        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: page)) == page)
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: picture)) == picture)
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: secret)) == nil)
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: link)) == nil)
        let sneaky = try #require(URL(string: "\(PagePreview.scheme)://page\(root.path)/p/.bot/artifacts/../secret.txt"))
        #expect(PagePreview.file(forPreview: sneaky) == nil)
        #expect(PagePreview.file(forPreview: try #require(URL(string: "\(PagePreview.scheme)://other\(page.path)"))) == nil)

        // A page elsewhere is served once a card shows it, and only that file.
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: outside)) == nil)
        _ = PagePreview.cardData(#"{"path":"\#(outside.path)"}"#)
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: outside)) == outside)
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: secret)) == nil)

        let answer = try #require(PagePreview.response(for: PagePreview.previewURL(for: page, version: Date())))
        #expect(answer.mimeType == "text/html")
        #expect(answer.encoding == "utf-8")
        #expect(String(decoding: answer.data, as: UTF8.self).contains("報告"))
        #expect(PagePreview.response(for: PagePreview.previewURL(for: picture))?.mimeType == "image/svg+xml")
    }

    @Test func cardDataSaysWhereToLoadAndOpenThePage() throws {
        let page = try write("p/.bot/artifacts/competitor-report.html")
        let card = try object(PagePreview.cardData(#"{"path":"\#(page.absoluteString)","title":"競品比較"}"#))
        #expect(card["path"] as? String == page.path)
        #expect(card["url"] as? String == page.absoluteString)
        #expect(card["name"] as? String == "competitor-report.html")
        #expect(card["title"] as? String == "競品比較")
        #expect(card["missing"] as? Bool == false)
        let src = try #require((card["src"] as? String).flatMap(URL.init(string:)))
        #expect(src.scheme == PagePreview.scheme)
        #expect(PagePreview.file(forPreview: src) == page)

        // No title: the file's name. No such file: said so, nothing to load.
        let untitled = try object(PagePreview.cardData(#"{"path":"\#(page.path)"}"#))
        #expect(untitled["title"] as? String == "competitor-report")
        let gone = try object(PagePreview.cardData(#"{"path":"\#(root.path)/p/.bot/artifacts/gone.html","title":"G"}"#))
        #expect(gone["missing"] as? Bool == true)
        #expect(gone["src"] == nil)
        #expect(try object(PagePreview.cardData(#"{"title":"no path"}"#))["missing"] as? Bool == true)
        // Not JSON: left as it was.
        #expect(PagePreview.cardData("nope") == "nope")
    }

    @Test func linksToResultPagesBecomeCards() throws {
        let a = try write("p/.bot/artifacts/a.html")
        let b = try write("runs/1-prototype/artifacts/b.html")
        let text = """
        Done: [A page](\(a.absoluteString)), again [A](\(a.absoluteString)), [B](\(b.absoluteString)),
        [missing](file://\(root.path)/p/.bot/artifacts/none.html), [site](https://example.com/x.html),
        [picture](file://\(root.path)/p/.bot/artifacts/x.png), [elsewhere](file://\(root.path)/p/site/index.html)
        """
        let cards = try PagePreview.linkedCards(in: text).map(object)
        #expect(cards.map { $0["path"] as? String } == [a.path, b.path])
        #expect(cards.map { $0["title"] as? String } == ["A page", "B"])
        #expect(try PagePreview.linkedCards(in: text, skipping: [a]).map(object).map { $0["path"] as? String } == [b.path])

        let many = try (0..<5).map { try write("p/.bot/artifacts/\($0).html") }
        #expect(PagePreview.linkedCards(in: many.map { "[\($0.lastPathComponent)](\($0.absoluteString))" }.joined(separator: " ")).count == 3)
    }

    @Test func thePayloadCarriesCardsAndWhatCanBeMentioned() throws {
        let page = try write("p/.bot/artifacts/report.html")
        let other = try write("p/.bot/artifacts/other.html")
        let home = root.appending(path: "ccb/main")
        var shown = ChatMessage(role: .bot, text: "See [Report](\(page.absoluteString)) and [Other](\(other.absoluteString))")
        shown.displays = [ComponentInstance(name: PagePreview.component, data: #"{"path":"\#(page.path)","title":"報告"}"#)]
        BotStore(directory: home).save(messages: [
            ChatMessage(role: .user, text: "My [own link](\(page.absoluteString))"),
            ChatMessage(role: .notice, text: "Prototype team: done. [Report](\(page.absoluteString))", sourceID: UUID()),
            shown,
        ])
        let workspace = makeWorkspace()
        let payload = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }
        let json = try object(payload.json())
        #expect((json["componentMentions"] as? [String])?.contains(PagePreview.component) == true)
        #expect((json["componentMentions"] as? [String])?.contains("choices") == true)
        let messages = try #require(json["messages"] as? [[String: Any]])
        // Your own links stay links.
        #expect(messages[0]["previews"] == nil)
        let notice = try #require(messages[1]["previews"] as? [[String: Any]])
        #expect(notice.count == 1)
        #expect(notice[0]["name"] as? String == PagePreview.component)
        #expect(try object(try #require(notice[0]["data"] as? String))["src"] != nil)
        // A <show> card gets where to load from; the page it shows is not drawn twice.
        let display = try #require((messages[2]["displays"] as? [[String: Any]])?.first)
        let card = try object(try #require(display["data"] as? String))
        #expect(card["title"] as? String == "報告")
        #expect((card["src"] as? String)?.hasPrefix("\(PagePreview.scheme)://page/") == true)
        let rest = try #require(messages[2]["previews"] as? [[String: Any]])
        #expect(try rest.map { try object(try #require($0["data"] as? String))["path"] as? String } == [other.path])
    }

    /// The chat page's Content-Security-Policy is inherited by component frames: it must let
    /// them load preview pages, or the card stays blank.
    @Test func theChatPageLetsFramesLoadPreviews() throws {
        let page = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../Sources/ClaudeCodeBot/Resources/web/chat.html").standardizedFileURL
        let html = try String(contentsOf: page, encoding: .utf8)
        let frameSource = try #require(html.range(of: #"frame-src [^;"]*"#, options: .regularExpression).map { String(html[$0]) })
        #expect(frameSource.contains("\(PagePreview.scheme):"))
    }

    @Test func withoutTheComponentLinksStayChips() throws {
        let page = try write("p/.bot/artifacts/report.html")
        let workspace = makeWorkspace()
        try FileManager.default.removeItem(at: workspace.components.folder.appending(path: PagePreview.component))
        workspace.components.rescan()
        let message = ChatMessage(role: .bot, text: "[Report](\(page.absoluteString))")
        #expect(ChatPayload.previews(for: message, in: workspace.components) == nil)
        #expect(ChatPayload.previews(for: message, in: nil) == nil)
    }
}

/// Components named with @ in the input box.
@MainActor
struct ComponentMentionTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-mention-\(UUID().uuidString)")

    @Test func namesAreFoundWholeLongestFirstAndInOrder() {
        let names = ["choices", "網頁預覽卡片", "網頁", "error", "error-toast"]
        #expect(ComponentMentions.names(in: "用@網頁預覽卡片請看，再用 @choices。", among: names) == ["網頁預覽卡片", "choices"])
        #expect(ComponentMentions.names(in: "@CHOICES first, then @網頁", among: names) == ["choices", "網頁"])
        #expect(ComponentMentions.names(in: "@error-toast and @error-x", among: names) == ["error-toast"])
        #expect(ComponentMentions.names(in: "mail me@choices.dev or @choicesX", among: names) == [])
        #expect(ComponentMentions.names(in: "@choices @choices", among: names) == ["choices"])
        #expect(ComponentMentions.names(in: "no mention", among: names) == [])
    }

    @Test func theBotIsToldWhichComponentYouMean() async throws {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let note = try #require(workspace.components.mentionNote(for: "做一張 @網頁預覽卡片 給我"))
        #expect(note.hasPrefix("(App: With @ the user names the in-chat component \"網頁預覽卡片\""))
        #expect(note.contains("- 網頁預覽卡片: "))
        #expect(!note.contains("- choices: "))
        #expect(workspace.components.mentionNote(for: "plain words") == nil)

        await workspace.send("做一張 @網頁預覽卡片 給我", to: workspace.mainBot)
        await eventually { fake.agents.last?.sent.contains { $0.contains("做一張 @網頁預覽卡片 給我") } == true }
        let sent = try #require(fake.agents.last?.sent.first { $0.contains("做一張 @網頁預覽卡片 給我") })
        #expect(sent.contains("(App: With @ the user names the in-chat component \"網頁預覽卡片\""))
        // The chat shows only what you typed.
        #expect(workspace.mainBot.messages.first { $0.role == .user }?.text == "做一張 @網頁預覽卡片 給我")
    }

    @Test func aGroupMemberIsToldToo() throws {
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let garden = workspace.addProject(folder: folder)
        let group = try #require(workspace.createGroup(name: "Team", members: [Workspace.mainBotID, garden.id]))
        let line = ChatMessage(role: .user, text: "@garden 用 @網頁預覽卡片 給我看")
        let member = workspace.members(of: group)[1]
        let prompt = workspace.groupPrompt(for: member, in: group, addressed: true, transcript: [line], newest: line.id, ask: nil)
        #expect(prompt.contains("in-chat component \"網頁預覽卡片\""))
        let plain = ChatMessage(role: .user, text: "@garden hi")
        #expect(!workspace.groupPrompt(for: member, in: group, addressed: true, transcript: [plain], newest: plain.id, ask: nil).contains("in-chat component"))
    }
}
