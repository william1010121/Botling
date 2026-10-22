import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Web capture: the web bots' traffic kept in memory, read beside the page, and saved as a
/// private capture Maintainer fixes and tests the page reader from. The traffic here is made up
/// in the tests (and mimics each site only loosely); the real sites were not captured.
@MainActor
struct WebCaptureTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-capture-\(UUID().uuidString)")
    let gemini = WebSite.gemini
    let t0 = 1_792_655_000_000.0

    func event(_ id: String, _ phase: WebNetEvent.Phase, at seconds: Double, kind: WebNetEvent.Kind = .fetch, url: String? = nil, body: String? = nil, method: String? = nil) -> WebNetEvent {
        WebNetEvent(t: t0 + seconds * 1000, id: id, kind: kind, phase: phase, url: url, method: method, body: body)
    }

    // MARK: The tap's events

    @Test func anEventIsReadFromTheTapsMessageAndNothingElse() {
        let made = WebNetEvent(message: ["id": "f-1", "kind": "fetch", "phase": "chunk", "t": NSNumber(value: 5.0), "body": "hi", "headers": ["a": "b", "n": NSNumber(value: 1)]])
        #expect(made == WebNetEvent(t: 5, id: "f-1", kind: .fetch, phase: .chunk, headers: ["a": "b"], body: "hi"))
        #expect(WebNetEvent(message: "changed") == nil)
        #expect(WebNetEvent(message: ["id": "x", "kind": "carrier-pigeon", "phase": "chunk"]) == nil)
        #expect(WebNetEvent(message: ["kind": "fetch", "phase": "chunk"]) == nil)
    }

    @Test func eventsGoToJSONLinesAndBack() {
        let events = [event("a", .request, at: 0, url: "https://x/a", method: "GET"), event("a", .chunk, at: 1, body: "line\nbreak")]
        let text = events.map { $0.jsonLine() + "\n" }.joined() + "not json\n"
        #expect(WebNetEvent.parse(jsonl: text) == events)
    }

    // MARK: The buffer

    @Test func theBufferKeepsTheLastFiveMinutes() {
        var buffer = WebNetBuffer()
        buffer.append(event("old", .request, at: 0))
        buffer.append(event("new", .request, at: 200))
        #expect(buffer.events.map(\.id) == ["old", "new"])
        buffer.append(event("newer", .request, at: 301))
        #expect(buffer.events.map(\.id) == ["new", "newer"])
        #expect(buffer.bytes == buffer.events.reduce(0) { $0 + $1.size })
    }

    @Test func whileRecordingNothingFromTheRecordingOrTheMinutesBeforeItIsDropped() {
        var buffer = WebNetBuffer()
        buffer.append(event("before", .request, at: 0))
        buffer.append(event("pre-roll", .request, at: 150))
        buffer.startRecording(at: t0 + 400_000)
        buffer.append(event("during", .request, at: 480))
        // Five minutes on: without the recording "pre-roll" would be gone.
        buffer.append(event("late", .request, at: 700))
        #expect(buffer.events.map(\.id) == ["pre-roll", "during", "late"])
        #expect(buffer.events(since: t0 + 400_000).map(\.id) == ["during", "late"])
        let held = buffer.stopRecording(at: t0 + 700_000)
        #expect(held.map(\.id) == ["pre-roll", "during", "late"])
        #expect(buffer.recordingSince == nil)
        #expect(buffer.events.map(\.id) == ["during", "late"])
    }

    @Test func theBufferDropsTheOldestBeyondItsSize() {
        var buffer = WebNetBuffer()
        let big = String(repeating: "x", count: WebNetBuffer.keepBytes / 4)
        for index in 0..<5 { buffer.append(event("e\(index)", .chunk, at: Double(index), body: big)) }
        #expect(buffer.events.map(\.id) == ["e2", "e3", "e4"])
        #expect(buffer.bytes <= WebNetBuffer.keepBytes)
    }

    @Test func countsAreRequestsStreamsAndBytes() {
        let events = [
            event("a", .request, at: 0), event("a", .chunk, at: 1, body: "one"),
            event("b", .request, at: 0), event("b", .chunk, at: 1, body: "x"), event("b", .chunk, at: 2, body: "y"),
            event("s", .request, at: 0, kind: .sse), event("s", .chunk, at: 1, kind: .sse, body: "data: 1"),
            event("w", .request, at: 0, kind: .ws), event("w", .send, at: 1, kind: .ws, body: "hi"),
        ]
        let counts = WebNetCounts.of(events)
        #expect(counts.requests == 4)
        #expect(counts.streams == 3)
        #expect(counts.bytes == events.reduce(0) { $0 + $1.size })
    }

    // MARK: Exchanges

    @Test func eachRequestsEventsArePutTogether() {
        var response = event("a", .response, at: 1)
        response.status = 200
        response.contentType = "text/event-stream"
        let exchanges = WebNetExchange.assemble([
            event("a", .request, at: 0, url: "https://chatgpt.com/backend-api/conversation", body: "{\"q\":1}", method: "POST"),
            event("w", .request, at: 0, kind: .ws, url: "wss://x/socket"),
            response,
            event("a", .chunk, at: 2, body: "data: one\n\n"),
            event("w", .send, at: 2, kind: .ws, body: "ping"),
            event("a", .chunk, at: 3, body: "data: two\n\n"),
            event("w", .message, at: 3, kind: .ws, body: "pong"),
            event("a", .end, at: 4),
        ])
        #expect(exchanges.map(\.id) == ["a", "w"])
        let a = exchanges[0]
        #expect(a.method == "POST" && a.status == 200 && a.contentType == "text/event-stream")
        #expect(a.requestBody == "{\"q\":1}")
        #expect(a.responseBody == "data: one\n\ndata: two\n\n")
        #expect(a.done && a.endedAt == t0 + 4000)
        #expect(exchanges[1].messages.map(\.dir) == ["out", "in"])
        #expect(!exchanges[1].done)
    }

    @Test func aReaderGetsOnlyTheRequestsItDeclares() {
        let exchanges = WebNetExchange.assemble([
            event("a", .request, at: 0, url: "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&rt=c"),
            event("b", .request, at: 0, url: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c"),
            event("c", .request, at: 0, url: "https://play.google.com/log?format=json"),
        ])
        #expect(WebNetExchange.matching(exchanges, patterns: ["/StreamGenerate", "rpcids=hNvQHb"]).map(\.id) == ["a", "b"])
        #expect(WebNetExchange.matching(exchanges, patterns: []).count == 3)
        // Also matched as plain text.
        #expect(WebNetExchange.matching(exchanges, patterns: ["log?format"]).map(\.id) == ["c"])
    }

    // MARK: Masking

    @Test func signInSecretsAreMaskedAndTheConversationStays() {
        var redactor = WebRedactor()
        let headers = redactor.redact(headers: ["Cookie": "SID=abc", "authorization": "Bearer x", "x-csrf-token": "t", "content-type": "application/json", "OAI-Device-Id": "d"])
        #expect(headers == ["Cookie": "[redacted]", "authorization": "[redacted]", "x-csrf-token": "[redacted]", "content-type": "application/json", "OAI-Device-Id": "[redacted]"])

        let url = redactor.redact(url: "https://claude.ai/api/organizations/0b5e2a8c-1d2f-4e3a-9b7c-5d6e7f8a9b0c/chat_conversations/abc?tree=True&f.sid=-123&at=tok")
        #expect(url == "https://claude.ai/api/organizations/redacted/chat_conversations/abc?tree=True&f.sid=redacted&at=redacted")

        let form = redactor.redact(body: "f.req=%5B%22hello%22%5D&at=AFixture%3A123&", contentType: "application/x-www-form-urlencoded")
        #expect(form == "f.req=%5B%22hello%22%5D&at=redacted&")

        let json = redactor.redact(body: #"{"accessToken":"secret-value-1","user":{"id":"user-123456","email":"me@example.com","name":"Mei"},"title":"Load factor","author":{"role":"user"},"name":"Conversation name"}"#, contentType: "application/json")
        #expect(!json.contains("secret-value-1") && !json.contains("user-123456") && !json.contains("me@example.com") && !json.contains("Mei"))
        #expect(json.contains("Load factor") && json.contains("Conversation name") && json.contains("\"role\":\"user\""))

        // Tokens, quoted secrets and addresses in text that is no whole JSON (a stream).
        let text = redactor.redact(text: #"data: {"sessionToken":"abc123def","text":"mail me at a.b@example.org"} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl"#)
        #expect(text == #"data: {"sessionToken":"[redacted]","text":"mail me at [email]"} [redacted]"#)
        #expect((redactor.counts["headers"] ?? 0) == 4)
    }

    @Test func aSecretMaskedOnceIsMaskedEverywhere() {
        var redactor = WebRedactor()
        let events = redactor.redact([
            event("a", .request, at: 0, url: "https://claude.ai/api/organizations/0b5e2a8c-org-uuid/chat_conversations/abc"),
            event("b", .chunk, at: 1, body: "{\"text\":\"your org is 0b5e2a8c-org-uuid\"}"),
        ])
        #expect(events[1].body?.contains("0b5e2a8c-org-uuid") == false)
        #expect((redactor.counts["known values"] ?? 0) >= 1)
    }

    @Test func aPagesInlineScriptsAreRemoved() {
        var redactor = WebRedactor()
        let html = redactor.redact(html: #"<html><script>WIZ_global_data={"SNlM0e":"tok"}</script><script src="/a.js"></script><p>Hi a@b.co</p></html>"#)
        #expect(html == #"<html><script>/* removed by ClaudeCodeBot */</script><script src="/a.js"></script><p>Hi [email]</p></html>"#)
        #expect(redactor.counts["inline scripts"] == 1)
    }

    // MARK: HAR

    @Test func theTrafficIsAlsoAHARFile() throws {
        var response = event("a", .response, at: 1)
        response.status = 200
        let exchanges = WebNetExchange.assemble([
            event("a", .request, at: 0, url: "https://x.test/api?q=1", body: "{}", method: "POST"), response,
            event("a", .chunk, at: 1, body: "ok"), event("a", .end, at: 2),
            event("w", .request, at: 0, kind: .ws, url: "wss://x.test/ws"), event("w", .message, at: 1, kind: .ws, body: "hello"),
        ])
        let har = try #require(try JSONSerialization.jsonObject(with: WebHAR.make(exchanges, pageURL: "https://x.test/", pageTitle: "T", startedAt: t0, appVersion: "9.9")) as? [String: Any])
        let log = try #require(har["log"] as? [String: Any])
        #expect(log["version"] as? String == "1.2")
        let entries = try #require(log["entries"] as? [[String: Any]])
        #expect(entries.count == 2)
        let request = try #require(entries[0]["request"] as? [String: Any])
        #expect(request["method"] as? String == "POST")
        #expect((request["queryString"] as? [[String: String]])?.first?["value"] == "1")
        let content = try #require((entries[0]["response"] as? [String: Any])?["content"] as? [String: Any])
        #expect(content["text"] as? String == "ok")
        #expect(entries[0]["time"] as? Double == 2000)
        #expect((entries[1]["_webSocketMessages"] as? [[String: Any]])?.first?["data"] as? String == "hello")
    }

    // MARK: The page and its traffic

    func turns(_ texts: String...) -> [WebTurn] {
        texts.enumerated().map { WebTurn(role: $0.offset % 2 == 0 ? .user : .assistant, text: $0.element) }
    }

    @Test func aReaderWithoutTrafficReadsThePageAsBefore() {
        let page = WebReading.read(title: "T", turns: turns("q", "a"))
        #expect(WebReaderMerge.merge(page: page, network: nil) == (page, .pageOnly))
    }

    @Test func theTrafficsMarkdownReplacesThePagesTextWhenTheyAgree() {
        let page = WebReading.read(title: "Page title", turns: turns("Why is it O(1)?", "Each slot holds about n/m keys.\n\nHash the key.", "And the worst case?"))
        // The traffic has only the last exchange's question and the answer (the page had loaded earlier).
        let network = WebReading.read(title: nil, turns: [WebTurn(role: .assistant, text: "Each slot holds about **n/m** keys.\n\n- Hash the key.")])
        let merged = WebReaderMerge.merge(page: page, network: network)
        #expect(merged.check == .agree)
        #expect(merged.reading == .read(title: "Page title", turns: turns("Why is it O(1)?", "Each slot holds about **n/m** keys.\n\n- Hash the key.", "And the worst case?")))
    }

    @Test func whenThePageShowsOnlyPartOfItTheTrafficIsSaved() {
        let page = WebReading.read(title: nil, turns: turns("second question", "second answer"))
        let network = WebReading.read(title: "From the traffic", turns: turns("first question", "first answer", "second question", "second answer"))
        let merged = WebReaderMerge.merge(page: page, network: network)
        #expect(merged.check == .agree)
        #expect(merged.reading == network)
    }

    @Test func whenTheyDifferThePageIsKeptAndTheReaderMayBeOutOfDate() {
        let page = WebReading.read(title: nil, turns: turns("question", "An older layout drew this answer instead."))
        let network = WebReading.read(title: nil, turns: turns("question", "Every key can land in one slot."))
        let merged = WebReaderMerge.merge(page: page, network: network)
        #expect(merged.reading == page)
        guard case .mismatch(let why) = merged.check else { Issue.record("not a mismatch"); return }
        #expect(why.contains("Message 2") && why.contains("Every key can land"))
    }

    @Test func aPageReaderThatFindsNothingFallsBackToTheTraffic() {
        let network = WebReading.read(title: nil, turns: turns("q", "a"))
        let merged = WebReaderMerge.merge(page: .nothing("No messages were found on the page."), network: network)
        #expect(merged.reading == network)
        #expect(merged.check.isMismatch)
        // A traffic reader that throws is a problem too; the page's reading is still saved.
        let page = WebReading.read(title: nil, turns: turns("q", "a"))
        let failed = WebReaderMerge.merge(page: page, network: .nothing("The page reader failed: x is undefined"))
        #expect(failed.reading == page && failed.check.isMismatch)
    }

    @Test func similarityIgnoresMarkdownAndSpacing() {
        #expect(WebReaderMerge.similarity("**Bold** and `code`\n\n- item", "Bold and code item") == 1)
        #expect(WebReaderMerge.similarity("Every key can land in one slot", "Every key can land in one slot, so O(n).") > 0.8)
        #expect(WebReaderMerge.similarity("Every key can land in one slot", "An older layout drew this") < 0.5)
        #expect(WebReaderMerge.similarity("雜湊表的負載因子", "雜湊表的負載因子") == 1)
    }

    @Test func bothReadingsComeBackFromTheReadersAnswer() {
        let both = WebExtractors.decodeBoth(#"{"page":{"title":"T","turns":[{"role":"user","text":"q"}]},"network":{"title":null,"turns":[]}}"#)
        #expect(both.page == .read(title: "T", turns: [WebTurn(role: .user, text: "q")]))
        // No messages in the traffic is no news, not a failure.
        #expect(both.network == nil)
        let failed = WebExtractors.decodeBoth(#"{"page":{"error":"signed out"},"network":{"error":"The page reader failed: boom"}}"#)
        #expect(failed.page == .nothing("signed out"))
        #expect(failed.network == .nothing("The page reader failed: boom"))
        #expect(WebExtractors.decodeBoth(#"{"page":{"turns":[{"role":"user","text":"q"}]},"network":null}"#).network == nil)
        #expect(WebExtractors.decodeBoth("junk").page == .nothing("The page reader gave back nothing it understood."))
    }

    @Test func aReaderDeclaresTheTrafficItReads() {
        #expect(!WebExtractors.readsNetwork("function extract(doc) {}"))
        #expect(WebExtractors.readsNetwork("function extract(doc) {}\nfunction extractNetwork(exchanges, context) {}"))
        #expect(WebExtractors.decodeDeclaration(#"{"network":true,"urls":["/StreamGenerate"]}"#) == (true, ["/StreamGenerate"]))
        #expect(WebExtractors.decodeDeclaration(nil) == (false, []))
        let call = WebExtractors.callBoth("function extract(doc) { return 1 }")
        #expect(call.contains("extract(document)") && call.contains("extractNetwork(JSON.parse(net), JSON.parse(context))"))
        #expect(WebExtractors.context(site: gemini, url: URL(string: "https://gemini.google.com/app/8f3a2c1d9e0b")!)
                == #"{"conversationID":"8f3a2c1d9e0b","site":"gemini","url":"https://gemini.google.com/app/8f3a2c1d9e0b"}"#)
    }

    // MARK: The bot's check

    @Test func aChangedReaderThatReadsThePageAgainIsReportedUpdated() {
        let shelf = WebShelf(folder: root.appending(path: "web"), library: root.appending(path: "plugins"))
        let url = URL(string: "https://gemini.google.com/app/8f3a2c1d9e0b")!
        let read = WebReading.read(title: nil, turns: turns("q", "a"))
        shelf.noteReader(.mismatch("differs"), reading: read, on: gemini, url: url, readerHash: "old")
        #expect(shelf.readerCheck["gemini"]?.isMismatch == true)
        // The same reader reading it fine again is no news.
        shelf.noteReader(.agree, reading: read, on: gemini, url: url, readerHash: "old")
        #expect(shelf.readerFixedAt["gemini"] == nil)
        shelf.noteReader(.pageOnly, reading: .nothing("No messages were found on the page."), on: gemini, url: url, readerHash: "old")
        // Maintainer's fix.
        shelf.noteReader(.agree, reading: read, on: gemini, url: url, readerHash: "new")
        #expect(shelf.readerFixedAt["gemini"] != nil)
        #expect(shelf.readerCheck["gemini"] == .agree)
        // A page behind the front one does not change what the strip shows.
        shelf.noteReader(.mismatch("x"), reading: read, on: gemini, page: UUID(), url: url, readerHash: "new")
        #expect(shelf.readerCheck["gemini"] == .agree)
        #expect(shelf.capturesFolder == root.appending(path: "captures"))
    }

    // MARK: Captures

    func input(at date: Date, events: [WebNetEvent] = []) -> WebCaptureInput {
        WebCaptureInput(site: gemini, url: URL(string: "https://gemini.google.com/app/8f3a2c1d9e0b")!, pageTitle: "Load factor", startedAt: date.addingTimeInterval(-60), endedAt: date,
                        stoppedBy: "you", events: events, html: "<html><script>var at='x'</script><body>me@example.com</body></html>", outline: "{\"elements\":[]}",
                        screenshot: Data([0x89, 0x50]), extractor: ("function extract(doc) {}\nfunction extractNetwork(e, c) {}", URL(filePath: "/x/gemini.js"), true),
                        output: #"{"page":{"title":null,"turns":[{"role":"user","text":"q"}]},"network":null}"#, appVersion: "1.2.3")
    }

    @Test func aCaptureIsWrittenMaskedWithItsManifest() throws {
        let date = Date(timeIntervalSince1970: t0 / 1000 + 120)
        let events = [
            WebNetEvent(t: t0, id: "x", kind: .xhr, phase: .request, url: "https://gemini.google.com/_/StreamGenerate?f.sid=1", method: "POST",
                        headers: ["content-type": "application/x-www-form-urlencoded", "cookie": "SID=1"], body: "f.req=hi&at=SECRETTOKEN1"),
            WebNetEvent(t: t0 + 1000, id: "x", kind: .xhr, phase: .chunk, body: "answer"),
            WebNetEvent(t: t0 + 2000, id: "x", kind: .xhr, phase: .end),
        ]
        let pack = try WebCapturePack.write(input(at: date, events: events), in: root.appending(path: "captures"))
        #expect(pack.folder.path.hasSuffix("captures/gemini/" + WebCapturePack.folderName(at: date)))
        let manifest = try #require(pack.manifest)
        #expect(manifest.private && manifest.site == "gemini" && manifest.appVersion == "1.2.3")
        #expect(manifest.files == ["dom.html", "events.jsonl", "extractor/gemini.js", "extractor/output.json", "manifest.json", "network.har", "outline.json", "screenshot.png"])
        #expect(manifest.extractor?.readsNetwork == true && manifest.extractor?.source == "plugin")
        #expect(manifest.counts.requests == 0 && manifest.counts.events == 3)
        #expect(manifest.preRollSeconds == 60)
        #expect(manifest.redacted["headers"] == 1 && manifest.redacted["form values"] == 1 && manifest.redacted["inline scripts"] == 1)
        for file in manifest.files {
            let text = (try? String(contentsOf: pack.folder.appending(path: file), encoding: .utf8)) ?? ""
            #expect(!text.contains("SECRETTOKEN1") && !text.contains("SID=1") && !text.contains("me@example.com"), "\(file) keeps a secret")
        }
        #expect(pack.events().count == 3)
        #expect(pack.output()?.page == .read(title: nil, turns: [WebTurn(role: .user, text: "q")]))
        // Two in the same second do not overwrite each other.
        let second = try WebCapturePack.write(input(at: date), in: root.appending(path: "captures"))
        #expect(second.folder != pack.folder)
    }

    @Test func onlyTheNewestFivePerSiteAreKeptAndNoneOlderThanThirtyDays() throws {
        let captures = root.appending(path: "captures")
        let now = Date(timeIntervalSince1970: t0 / 1000)
        for day in [40.0, 6, 5, 4, 3, 2, 1] {
            _ = try WebCapturePack.write(input(at: now.addingTimeInterval(-day * 86_400)), in: captures)
        }
        WebCapturePack.prune(in: captures, now: now)
        let left = WebCapturePack.list(gemini, in: captures)
        #expect(left.count == 5)
        #expect(left.first?.name == WebCapturePack.folderName(at: now.addingTimeInterval(-86_400)))
        #expect(WebCapturePack.packs(at: captures).count == 5)
        #expect(WebCapturePack.packs(at: captures.appending(path: "gemini")).count == 5)
        #expect(WebCapturePack.packs(at: left[0].folder).count == 1)
    }

    @Test func theExpectedAnswerIsConfirmedAndComparedWord_for_word() throws {
        let pack = try WebCapturePack.write(input(at: Date()), in: root.appending(path: "captures"))
        let expected = WebCaptureExpected(title: "Load factor", turns: turns("q", "Each slot\n\n- Hash it"))
        try JSONEncoder().encode(expected).write(to: pack.folder.appending(path: "expected.json"))
        let loaded = try #require(WebCapturePack(folder: pack.folder).expected)
        #expect(!loaded.confirmed)
        try WebCapturePack(folder: pack.folder).confirmExpected(at: Date(timeIntervalSince1970: 100))
        #expect(WebCapturePack(folder: pack.folder).expected?.confirmed == true)

        #expect(expected.difference(from: .read(title: "Load factor", turns: turns("q ", "Each  slot\n\n\n- Hash it  "))) == nil)
        #expect(expected.difference(from: .read(title: "Other", turns: turns("q", "Each slot\n\n- Hash it")))?.contains("title") == true)
        #expect(expected.difference(from: .read(title: "Load factor", turns: turns("q")))?.contains("missing") == true)
        #expect(expected.difference(from: .read(title: "Load factor", turns: turns("q", "Each slot\n\n- Hash")))?.contains("Message 2") == true)
        #expect(expected.difference(from: .nothing("signed out")) == "Nothing was read: signed out")
    }

    // MARK: Maintainer

    @Test func maintainerIsToldWhereTheCaptureIsAndWhatToDo() throws {
        let pack = try WebCapturePack.write(input(at: Date()), in: root.appending(path: "captures"))
        let text = Workspace.webCaptureHandoff(pack, site: gemini, plugin: root.appending(path: "plugins/ccb-web-extractors"), summary: "It differs.", testCommand: "'/A/ClaudeCodeBot' --test-extractor")
        #expect(text.hasPrefix("(App: Web capture)"))
        #expect(text.contains(pack.folder.path) && text.contains("It differs."))
        #expect(text.contains(root.appending(path: "plugins/ccb-web-extractors/gemini.js").path))
        #expect(text.contains("'/A/ClaudeCodeBot' --test-extractor <capture folder>"))
        #expect(text.contains("expected.json") && text.contains("never commit") && text.contains("never send a request"))
    }

    @Test func sendingACaptureLetsMaintainerReadCapturesAndHandsItOver() async throws {
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        let pack = try WebCapturePack.write(input(at: Date()), in: workspace.web.capturesFolder)
        workspace.sendCaptureToMaintainer(pack, site: gemini, summary: "It differs.", testCommand: nil)
        for _ in 0..<50 where !workspace.maintainer.messages.contains(where: { $0.text.contains("(App: Web capture)") }) {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(workspace.approvedFolders.contains { $0.path == workspace.web.capturesFolder.standardizedFileURL.path })
        let sent = try #require(workspace.maintainer.messages.last { $0.text.contains("(App: Web capture)") })
        #expect(sent.attachments?.first?.url.lastPathComponent.hasSuffix("screenshot.png") == true)
    }
}
