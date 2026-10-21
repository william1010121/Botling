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

    /// WebKit plays a video or sound through `ccb-preview:` only when it is answered in byte
    /// ranges: `Range: bytes=0-1` first, then the parts it needs (206 + Content-Range).
    @Test func videoAndAudioBesideAPageAreServedInByteRanges() throws {
        let bytes = Data((0..<1000).map { UInt8($0 % 251) })
        let video = root.appending(path: "p/.bot/artifacts/demo.mp4")
        try FileManager.default.createDirectory(at: video.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: video)
        let sound = root.appending(path: "p/.bot/artifacts/voice.mp3")
        try bytes.write(to: sound)
        let url = PagePreview.previewURL(for: video)

        let probe = try #require(PagePreview.response(for: url, range: "bytes=0-1"))
        #expect(probe.statusCode == 206)
        #expect(probe.mimeType == "video/mp4")
        #expect(probe.data == bytes.prefix(2))
        #expect(probe.headers["Content-Range"] == "bytes 0-1/1000")
        #expect(probe.headers["Content-Length"] == "2")
        #expect(probe.headers["Content-Type"] == "video/mp4")
        #expect(probe.headers["Accept-Ranges"] == "bytes")

        let middle = try #require(PagePreview.response(for: url, range: "bytes=100-199"))
        #expect(middle.statusCode == 206)
        #expect(middle.data == bytes.subdata(in: 100..<200))
        #expect(middle.headers["Content-Range"] == "bytes 100-199/1000")
        let rest = try #require(PagePreview.response(for: url, range: "bytes=990-"))
        #expect(rest.data == bytes.suffix(10))
        #expect(rest.headers["Content-Range"] == "bytes 990-999/1000")
        let tail = try #require(PagePreview.response(for: url, range: "bytes=-5"))
        #expect(tail.data == bytes.suffix(5))
        #expect(tail.headers["Content-Range"] == "bytes 995-999/1000")
        // Past the end is cut to the end; a start past it cannot be answered.
        #expect(PagePreview.response(for: url, range: "bytes=900-5000")?.data == bytes.suffix(100))
        let beyond = try #require(PagePreview.response(for: url, range: "bytes=1000-"))
        #expect(beyond.statusCode == 416)
        #expect(beyond.headers["Content-Range"] == "bytes */1000")
        #expect(beyond.data.isEmpty)

        // Without a range: the whole file, saying ranges may be asked for.
        let whole = try #require(PagePreview.response(for: url))
        #expect(whole.statusCode == 200)
        #expect(whole.data == bytes)
        #expect(whole.headers["Accept-Ranges"] == "bytes")
        #expect(whole.headers["Content-Length"] == "1000")

        #expect(PagePreview.response(for: PagePreview.previewURL(for: sound), range: "bytes=0-1")?.mimeType == "audio/mpeg")
        // Still only files that may be served.
        let secret = root.appending(path: "p/clip.mp4")
        try bytes.write(to: secret)
        #expect(PagePreview.response(for: PagePreview.previewURL(for: secret), range: "bytes=0-1") == nil)
    }

    /// 開啟完整頁面: a page in an `artifacts` folder opens through `ccb-preview:` as well, since
    /// WebKit will not play a video beside a page loaded from data with a `file:` base.
    @Test func theFullWindowLoadsArtifactPagesThroughTheScheme() throws {
        let page = try write("p/.bot/artifacts/demo.html")
        let window = PagePreview.windowURL(for: page)
        #expect(window.scheme == PagePreview.scheme)
        #expect(PagePreview.file(forPreview: window) == page)
        let outside = try write("p/site/index.html")
        #expect(PagePreview.windowURL(for: outside) == outside)
        let picture = try write("p/.bot/artifacts/chart.svg", "<svg/>")
        #expect(PagePreview.windowURL(for: picture) == picture)
        let web = try #require(URL(string: "https://example.com/a/artifacts/x.html"))
        #expect(PagePreview.windowURL(for: web) == web)
    }

    @Test func picturesAComponentNamesByPathAreServedToItsFrame() throws {
        let chart = try write("p/charts/chart.png", "png")
        let photo = try write("p/photos/me.JPG", "jpg")
        let notes = try write("p/notes.txt", "secret")
        let unnamed = try write("p/charts/other.png", "png")
        let data = #"{"title":"Sales","image":"\#(chart.path)","more":[{"src":"\#(photo.absoluteString)"},{"src":"\#(root.path)/p/gone.png"}],"notes":"\#(notes.path)","n":3}"#
        let urls = ComponentImages.urls(in: data)
        #expect(Set(urls.keys) == [chart.path, photo.absoluteString])
        let src = try #require(urls[chart.path].flatMap(URL.init(string:)))
        #expect(src.scheme == PagePreview.scheme)
        #expect(PagePreview.file(forPreview: src) == chart)
        #expect(PagePreview.response(for: src)?.mimeType == "image/png")
        #expect(PagePreview.file(forPreview: try #require(urls[photo.absoluteString].flatMap(URL.init(string:)))) == photo)
        // Only the pictures named: not a text file, not another picture beside them.
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: notes)) == nil)
        #expect(PagePreview.file(forPreview: PagePreview.previewURL(for: unnamed)) == nil)
        #expect(ComponentImages.urls(in: #"{"title":"none"}"#).isEmpty)
        #expect(ComponentImages.urls(in: "not json /x.png").isEmpty)

        // The payload hands them to the page with the component.
        var shown = ChatMessage(role: .bot, text: "Chart:")
        shown.displays = [ComponentInstance(name: "chart", data: data)]
        #expect(ChatPayload.display(shown.displays![0]).images?[chart.path] == urls[chart.path])
        #expect(ChatPayload.display(ComponentInstance(name: "chart", data: "{}")).images == nil)
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

    /// A card shows a picture of its page once the app has taken one, so a chat with many cards
    /// does not run every page; the picture belongs to the page as it was (written again, a new one).
    @Test func cardShowsAPictureOfThePageOnceTaken() throws {
        let shots = root.appending(path: "shots")
        let (folder, maker) = (PageShots.folder, PageShots.maker)
        defer { PageShots.folder = folder; PageShots.maker = maker; PageShots.reset() }
        PageShots.folder = shots
        PageShots.reset()
        // Other tests may build cards meanwhile: only this test's pages count.
        let lock = NSLock()
        nonisolated(unsafe) var all: [(URL, URL)] = []
        PageShots.maker = { page, destination in lock.withLock { all.append((page, destination)) } }
        var asked: [(URL, URL)] { lock.withLock { all.filter { $0.0.path.hasPrefix(root.path) } } }

        let page = try write("p/.bot/artifacts/shot.html")
        // No picture yet: the page loads in a frame, and one picture is asked for (once).
        let first = try object(PagePreview.cardData(#"{"path":"\#(page.path)"}"#))
        #expect(first["shot"] == nil)
        #expect(first["src"] != nil)
        _ = PagePreview.cardData(#"{"path":"\#(page.path)"}"#)
        #expect(asked.count == 1)
        let (load, destination) = try #require(asked.first)
        #expect(PagePreview.file(forPreview: load) == page)
        #expect(destination.deletingLastPathComponent().path == shots.path)

        // Taken: the card names it, and the scheme serves it as a JPEG.
        try FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        try Data([0xFF, 0xD8, 0xFF]).write(to: destination)
        let card = try object(PagePreview.cardData(#"{"path":"\#(page.path)","shot":"ccb-preview://shot/x"}"#))
        let shot = try #require((card["shot"] as? String).flatMap(URL.init(string:)))
        #expect(shot.scheme == PagePreview.scheme)
        #expect(PagePreview.file(forPreview: shot) == destination)
        #expect(PagePreview.response(for: shot)?.mimeType == "image/jpeg")
        // Only pictures it made: no other names, no paths out of the folder.
        #expect(PagePreview.file(forPreview: try #require(URL(string: "ccb-preview://shot/../secret.jpg"))) == nil)
        #expect(PagePreview.file(forPreview: try #require(URL(string: "ccb-preview://shot\(page.path)"))) == nil)

        // The page written again: the old picture is not shown, a new one is asked for.
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: page.path)
        #expect(try object(PagePreview.cardData(#"{"path":"\#(page.path)"}"#))["shot"] == nil)
        #expect(asked.count == 2)
        #expect(asked[1].1 != destination)

        // A bot's own "shot" is never passed on, even with no maker.
        PageShots.maker = nil
        let other = try write("p/.bot/artifacts/other.html")
        #expect(try object(PagePreview.cardData(#"{"path":"\#(other.path)","shot":"https://x/y.jpg"}"#))["shot"] == nil)
    }

    @Test func oldestPagePicturesArePruned() throws {
        let shots = root.appending(path: "prune")
        let folder = PageShots.folder
        defer { PageShots.folder = folder }
        PageShots.folder = shots
        try FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        let now = Date()
        for index in 0..<(PageShots.limit + 3) {
            let file = shots.appending(path: String(format: "%032x.jpg", index))
            try Data([1]).write(to: file)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(Double(index))], ofItemAtPath: file.path)
        }
        PageShots.prune()
        let left = try FileManager.default.contentsOfDirectory(atPath: shots.path)
        #expect(left.count == PageShots.limit)
        #expect(!left.contains(String(format: "%032x.jpg", 0)))
        #expect(left.contains(String(format: "%032x.jpg", PageShots.limit + 2)))
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
        // Components and commands come after /; @ is only for bots.
        #expect(json["componentMentions"] == nil)
        #expect((json["slashComponents"] as? [String])?.contains(PagePreview.component) == true)
        #expect((json["slashComponents"] as? [String])?.contains("choices") == true)
        #expect((json["slashCommands"] as? [[String: Any]])?.compactMap { $0["name"] as? String }.contains("design") == true)
        #expect((json["mentions"] as? [String])?.contains(PagePreview.component) == false)
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

/// Components named with / in the input box (picked from its list of components and commands).
@MainActor
struct ComponentMentionTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-mention-\(UUID().uuidString)")

    @Test func namesAreFoundWholeLongestFirstAndInOrder() {
        let names = ["choices", "網頁預覽卡片", "網頁", "error", "error-toast"]
        #expect(ComponentMentions.names(in: "用/網頁預覽卡片請看，再用 /choices。", among: names) == ["網頁預覽卡片", "choices"])
        #expect(ComponentMentions.names(in: "/CHOICES first, then /網頁", among: names) == ["choices", "網頁"])
        #expect(ComponentMentions.names(in: "/error-toast and /error-x", among: names) == ["error-toast"])
        #expect(ComponentMentions.names(in: "see ~/choices or a/choices or /choicesX", among: names) == [])
        #expect(ComponentMentions.names(in: "/choices /choices", among: names) == ["choices"])
        // @ is for bots now.
        #expect(ComponentMentions.names(in: "@choices", among: names) == [])
        #expect(ComponentMentions.names(in: "no mention", among: names) == [])
    }

    @Test func theBotIsToldWhichComponentYouMean() async throws {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let note = try #require(workspace.components.mentionNote(for: "做一張 /網頁預覽卡片 給我"))
        #expect(note.hasPrefix("(App: With / the user names the in-chat component \"網頁預覽卡片\""))
        #expect(note.contains("- 網頁預覽卡片: "))
        #expect(!note.contains("- choices: "))
        #expect(workspace.components.mentionNote(for: "plain words") == nil)
        #expect(workspace.components.mentionNote(for: "做一張 @網頁預覽卡片 給我") == nil)

        await workspace.send("做一張 /網頁預覽卡片 給我", to: workspace.mainBot)
        await eventually { fake.agents.last?.sent.contains { $0.contains("做一張 /網頁預覽卡片 給我") } == true }
        let sent = try #require(fake.agents.last?.sent.first { $0.contains("做一張 /網頁預覽卡片 給我") })
        #expect(sent.contains("(App: With / the user names the in-chat component \"網頁預覽卡片\""))
        // The chat shows only what you typed.
        #expect(workspace.mainBot.messages.first { $0.role == .user }?.text == "做一張 /網頁預覽卡片 給我")
    }

    @Test func theSlashCommandsAreTheOnesTheBotsKnow() {
        #expect(SlashCommands.all.map(\.name) == ["design"])
        // The bots' rules say what /design means.
        #expect(BotPrompts(profile: .main(home: root)).system.contains("\"/design\""))
    }

    @Test func aGroupMemberIsToldToo() throws {
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let garden = workspace.addProject(folder: folder)
        let group = try #require(workspace.createGroup(name: "Team", members: [Workspace.mainBotID, garden.id]))
        let line = ChatMessage(role: .user, text: "@garden 用 /網頁預覽卡片 給我看")
        let member = workspace.members(of: group)[1]
        let prompt = workspace.groupPrompt(for: member, in: group, addressed: true, transcript: [line], newest: line.id, ask: nil)
        #expect(prompt.contains("in-chat component \"網頁預覽卡片\""))
        let plain = ChatMessage(role: .user, text: "@garden hi")
        #expect(!workspace.groupPrompt(for: member, in: group, addressed: true, transcript: [plain], newest: plain.id, ask: nil).contains("in-chat component"))
    }
}
