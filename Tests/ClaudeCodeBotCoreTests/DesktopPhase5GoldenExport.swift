import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Botling 2.0 (desktop/) Phase 5a ports the rest of Maintainer's component work (the / menu and its
/// mention note, specs and suggestions, reports) and the completion checks. This writes the Swift
/// app's own strings for them to a JSON file, which desktop/test/unit/phase5.test.ts compares the port
/// against, character for character. Runs only when asked:
///
///     CCB_DESKTOP_PHASE5_EXPORT=/path/phase5-golden.json TZ=UTC swift test --filter DesktopPhase5GoldenExport
struct DesktopPhase5GoldenExport {
    @MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_DESKTOP_PHASE5_EXPORT"] != nil))
    func exportPhase5Strings() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_DESKTOP_PHASE5_EXPORT"])
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-desktop-phase5-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        // Two components of the library's own, one of which starts the other's name.
        let library = workspace.components
        for (name, about) in [("test-status", "Test results: passed and failed counts.\nData: {\"passed\": 3, \"failed\": 1}\nCommand: npm test --json"),
                              ("test", "A plain test card.\n\nIt takes {\"text\": \"…\"}.")] {
            let folder = library.folder.appending(path: name)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("<div>\(name)</div>".utf8).write(to: folder.appending(path: "template.html"))
            try Data(about.utf8).write(to: folder.appending(path: "about.md"))
        }
        library.rescan()
        let shopFolder = root.appending(path: "work/Shop")
        try FileManager.default.createDirectory(at: shopFolder, withIntermediateDirectories: true)
        let shop = workspace.addProject(folder: shopFolder, select: false)
        let members = workspace.everyMember
        let member = { (id: UUID) in members.first { $0.id == id }! }

        // The / mentions.
        let names = library.names
        let mentionTexts = ["/test-status please", "use /test and /test-status", "/TEST", "a/test", "~/test", "用/test看看", "(/test)", "/test/x", "/tests", "/test-status/test", "\"/test\"", "/choices then /網頁預覽卡片", "no slash", "/test /test"]
        let mentions = mentionTexts.map { ["text": $0, "names": ComponentMentions.names(in: $0, among: names)] as [String: Any] }
        let notes = ["/test-status please", "use /test and /test-status", "nothing named"].map { ["text": $0, "note": library.mentionNote(for: $0) ?? NSNull()] as [String: Any] }

        // A call-in and a group turn whose newest line names a component.
        let date = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let first = ChatMessage(id: UUID(uuidString: "00000000-0000-4000-8000-0000000000A1")!, role: .user, text: "@Shop show me /test-status", date: date)
        workspace.mainBot.post(first, unread: false)
        let before = Workspace.transcriptBefore(first.id, in: workspace.mainBot.messages)
        let callIn = workspace.callInPrompt(for: member(shop.id), into: workspace.mainBot, transcript: before, newest: first.id, ask: nil)
        let group = try #require(workspace.createGroup(name: "Pair", members: [Workspace.mainBotID, shop.id]))
        let groupChat = try #require(workspace.groupChats[group.id])
        groupChat.post(first, unread: false)
        let groupBefore = Workspace.transcriptBefore(first.id, in: groupChat.messages)
        let groupTurn = workspace.groupPrompt(for: member(shop.id), in: group, addressed: false, transcript: groupBefore, newest: first.id, ask: nil)

        var export: [String: Any] = [
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopPhase5GoldenExport.swift from the Swift app's own code.",
            "names": names,
            "mentions": mentions,
            "mentionNotes": notes,
            "callIn": callIn,
            "groupTurn": groupTurn,
            "shop": shop.id.uuidString,
            "group": group.id.uuidString,
            "messages": try JSONSerialization.jsonObject(with: JSONEncoder().encode(workspace.mainBot.messages)),
        ]
        export["more"] = Self.more(workspace: workspace, root: root)
        try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys]).write(to: URL(filePath: path))
    }

    /// The later parts (specs, reports, feedback, completion checks) add theirs here.
    @MainActor static func more(workspace: Workspace, root: URL) -> [String: Any] {
        var out: [String: Any] = [:]
        out["reports"] = reports(workspace: workspace, root: root)
        out["specs"] = specs(workspace: workspace, root: root)
        out["feedback"] = feedback(workspace: workspace, root: root)
        return out
    }

    /// "Not right" on a reply in developer mode (`reportFeedback`): what the developer project's manager gets.
    @MainActor static func feedback(workspace: Workspace, root: URL) -> [String: Any] {
        guard let shop = workspace.projects.first(where: { $0.name == "Shop" }) else { return [:] }
        let chat = workspace.mainBot
        let date = Date(timeIntervalSinceReferenceDate: 800_000_100)
        var asked = ChatMessage(id: UUID(uuidString: "00000000-0000-4000-8000-0000000000C1")!, role: .user, text: "How many tests failed?", date: date)
        asked.attachments = nil
        var answer = ChatMessage(id: UUID(uuidString: "00000000-0000-4000-8000-0000000000C2")!, role: .bot, text: "None failed.", date: date.addingTimeInterval(5))
        answer.steps = [Step(id: "a", kind: .tool, tool: "Bash", title: "Run the tests", detail: "npm test"), Step(id: "b", kind: .text, title: "Thinking")]
        chat.post(asked, unread: false)
        chat.post(answer, unread: false)
        let noDeveloper = workspace.reportFeedback("x", on: answer.id, in: chat)
        workspace.setDeveloperMode(true, project: shop.id)
        let picture = root.appending(path: "mine.png")
        try? Data([0x89, 0x50, 0x4E, 0x47]).write(to: picture)
        let sent = workspace.reportFeedback("  It says none but one failed  ", on: answer.id, in: chat, screenshot: picture, files: [picture])
        let manager = workspace.bot(for: shop)
        let relay = manager?.messages.last { $0.role == .relay }
        let empty = workspace.reportFeedback("", on: asked.id, in: chat)
        let second = manager?.messages.last { $0.role == .relay }
        return ["noDeveloper": noDeveloper, "sent": sent, "relay": relay?.text ?? NSNull(), "note": relay?.feedback.map { ["about": $0.about, "words": $0.words] } ?? NSNull(),
                "empty": empty, "relayEmpty": second?.text ?? NSNull(), "notice": chat.messages.last { $0.role == .notice }?.text ?? NSNull(),
                "messages": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(chat.messages))) ?? NSNull(),
                "parsed": [FeedbackNote.parse(relay?.text ?? "").map { ["about": $0.about, "words": $0.words] } ?? NSNull(), FeedbackNote.parse(second?.text ?? "").map { ["about": $0.about, "words": $0.words] } ?? NSNull()]]
    }

    /// Specs: the pure parts (`ComponentSpecs`), then one made through the workspace end to end.
    @MainActor static func specs(workspace: Workspace, root: URL) -> [String: Any] {
        let date = Date(timeIntervalSinceReferenceDate: 800_000_000)
        func message(_ id: String, _ text: String, displays: [ComponentInstance]? = nil, steps: [Step]? = nil) -> ChatMessage {
            var m = ChatMessage(id: UUID(uuidString: id)!, role: .bot, text: text, date: date)
            m.displays = displays
            m.steps = steps
            return m
        }
        let folder = root.appending(path: "work/Shop")
        let artifacts = folder.appending(path: ".bot/artifacts")
        try? FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
        let page = artifacts.appending(path: "report.html")
        try? Data("<html><head><title>T</title><style>p{}</style></head><body><h1>Sales &amp; costs</h1><p>Line one<br>two</p><ul><li>a</li><li>b &#x4E2D;</li></ul><table><tr><td>x</td><td>y</td></tr></table><script>var a=1</script></body></html>".utf8).write(to: page)
        let messages: [(String, ChatMessage)] = [
            ("text", message("00000000-0000-4000-8000-0000000000B1", "Your 3 tests: 2 passed, 1 failed (the cart total).")),
            ("shown", message("00000000-0000-4000-8000-0000000000B2", "Here:", displays: [ComponentInstance(name: "my-chart", data: "{\"total\": 3, \"failures\": [{\"suite\": \"cart\", \"test\": \"total\"}], \"ok\": false, \"rate\": 0.5, \"at\": \"2026-10-24T10:00:00Z\"}", command: "npm test --json")])),
            ("existing", message("00000000-0000-4000-8000-0000000000B3", "Status:", displays: [ComponentInstance(name: "test-status", data: "{\"passed\": 3}")])),
            ("bash", message("00000000-0000-4000-8000-0000000000B4", "Done reading.", steps: [Step(id: "s1", kind: .tool, tool: "Bash", title: "Run", detail: "cat notes.txt"), Step(id: "s2", kind: .tool, tool: "Bash", title: "Run", detail: "git log -3", failed: true)])),
            ("linked", message("00000000-0000-4000-8000-0000000000B5", "See [the report](\(page.absoluteString)) for details.")),
        ]
        var drafts: [[String: Any]] = []
        for (label, m) in messages {
            let spec = ComponentSpecs.draft(from: m, bot: "Shop", folder: folder, library: workspace.components)
            drafts.append(["label": label, "message": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(m))) ?? NSNull(),
                           "spec": encoded(spec), "lastCommand": ComponentSpecs.lastCommand(in: m) ?? NSNull(),
                           "pages": ComponentSpecs.pages(of: m).map { ["path": $0.path, "text": $0.text] }])
        }
        let pageDraft = ComponentSpecs.draft(from: messages[4].1, bot: "Shop", folder: folder, library: workspace.components, page: page.path)
        drafts.append(["label": "page", "spec": encoded(pageDraft)])

        let slugs = ["Show the Test Results now", "2 tests: 12 passed", "測試 results", "", "git diff --stat", "a-b_c d"].map { ["text": $0, "slug": ComponentSpecs.slug($0)] }
        let jsons = ["{\"b\": 1, \"a\": \"x\"}", "[{\"z\": true, \"y\": 1.5}]", "[1, 2]", "nope", "{\"list\": [{\"n\": 1, \"m\": 2}], \"obj\": {}, \"when\": \"2026-01-02\", \"none\": null, \"strs\": [\"a\"]}"]
            .map { ["json": $0, "fields": ComponentSpecs.fields(fromJSON: $0).map { ["name": $0.name, "type": $0.type] }] }
        let parsed = ["total: int, failures: [suite, test]", "name", " a : , b:num ,, {x, y}: obj", ""].map { ["text": $0, "fields": ComponentSpecs.parseFields($0).map { ["name": $0.name, "type": $0.type] }] }
        let matches = [("{\"total\": 1, \"failures\": []}", true), ("[{\"total\": 1, \"failures\": 2}]", true), ("{\"total\": 1}", false), ("plain", false)].map { json, _ in
            ["output": json, "matches": ComponentSpecs.outputMatches(json, fields: [.init(name: "total", type: "int"), .init(name: "failures", type: "[…]")])] as [String: Any]
        }

        // A spec changed by the user and Maintainer, in order: each state after.
        var spec = ComponentSpecs.draft(from: messages[1].1, bot: "Shop", folder: folder, library: workspace.components)
        spec.purpose = "see the tests at a glance"
        var steps: [[String: Any]] = []
        func step(_ what: String, _ changed: Bool) { steps.append(["what": what, "changed": changed, "spec": encoded(spec)]) }
        step("edit name", ComponentSpecs.edit("name", to: "Test Board!", in: &spec))
        step("edit refresh", ComponentSpecs.edit("refresh", to: "interval", in: &spec))
        step("edit minutes", ComponentSpecs.edit("minutes", to: "5000", in: &spec))
        step("edit bots", ComponentSpecs.edit("bots", to: "Shop, main bot, shop,", in: &spec))
        step("edit reuse", ComponentSpecs.edit("reuse", to: "yes", in: &spec))
        step("edit fields", ComponentSpecs.edit("fields", to: "total: int, failures: [suite, test], extra", in: &spec))
        step("edit same", ComponentSpecs.edit("about", to: "", in: &spec))
        step("update", ComponentSpecs.update(&spec, with: "{\"about\": \"Test results at a glance\", \"fields\": [{\"name\": \"total\", \"type\": \"int\"}, \"passed: int\", {\"name\": \"\"}], \"minutes\": 10, \"reuse\": false, \"similar\": \"test-status\", \"samples\": [{\"label\": \"Failing run\", \"data\": {\"total\": 0}}, {\"label\": \"Empty\", \"data\": \"{}\"}], \"questions\": [{\"key\": \"refresh\", \"text\": \"How often?\", \"options\": [{\"label\": \"When shown\", \"value\": \"shown\"}, \"Only by hand\"], \"suggested\": 0}, {\"id\": \"live\", \"key\": \"reuse\", \"text\": \"Reuse it?\", \"options\": [{\"label\": \"Yes\", \"value\": true}, {\"label\": \"No\", \"value\": false}], \"suggested\": 5}, {\"text\": \"no options\", \"options\": []}]}", ))
        step("update same", ComponentSpecs.update(&spec, with: "{\"about\": \"Test results at a glance\"}"))
        step("answer", ComponentSpecs.answer("q1", option: 0, in: &spec))
        step("answer open", { ComponentSpecs.answerOpenQuestions(in: &spec); return true }())
        let summary = ComponentSpecs.summary(of: spec)
        var built = spec
        built.built = "test-board"
        built.version = 2
        built.testRun = ComponentSpec.TestRun(command: "npm test --json", folder: folder.path, output: String(repeating: "x", count: 700), matches: false)
        let reply = messages[1].1
        let pages = ComponentSpecs.pages(of: messages[4].1)
        let requests: [String: Any] = [
            "summaryBuilt": ComponentSpecs.summary(of: built),
            "tagNote": ComponentSpecs.tagNote(spec),
            "draft": ComponentSpecs.draftRequest(spec, reply: reply.text, pages: pages, ran: "cat x", from: "Shop"),
            "draftPlain": ComponentSpecs.draftRequest(ComponentSpecs.draft(from: messages[0].1, bot: "Shop", folder: folder, library: workspace.components), reply: messages[0].1.text, from: "Shop"),
            "firstBuildLive": ComponentSpecs.firstBuildRequest(spec, reply: reply.text, pages: pages, ran: nil, asked: "  show me the tests  ", brief: " The brief. ", from: "Shop"),
            "firstBuildFilled": ComponentSpecs.firstBuildRequest(ComponentSpecs.draft(from: messages[0].1, bot: "Shop", folder: folder, library: workspace.components), reply: messages[0].1.text, ran: "npm test", from: "Main bot"),
            "say": ComponentSpecs.sayRequest(spec, text: "make it red"),
            "sayEmpty": ComponentSpecs.sayRequest(spec, text: ""),
            "change0": ComponentSpecs.changeRequest(built, said: [], version: 3),
            "change1": ComponentSpecs.changeRequest(built, said: [" bigger "], version: 3),
            "change2": ComponentSpecs.changeRequest(built, said: ["bigger", "", "green"], version: 3),
            "build": ComponentSpecs.buildRequest(spec),
            "buildFilled": ComponentSpecs.buildRequest(ComponentSpecs.draft(from: messages[0].1, bot: "Shop", folder: folder, library: workspace.components)),
            "board": ComponentSpecs.boardCommandRequest(component: "test-board", suggested: "npm test --json", folder: folder.path, bot: "Shop", brief: "brief"),
            "boardNoBrief": ComponentSpecs.boardCommandRequest(component: "test-board", suggested: "npm test --json", folder: folder.path, bot: "Shop"),
            "fill": ComponentSpecs.fillRequest(spec, component: "test-board", reply: reply, pages: [page.path], usage: "- test-board: shows tests"),
            "fillNoReply": ComponentSpecs.fillRequest(ComponentSpecs.draft(from: messages[0].1, bot: "Shop", folder: folder, library: workspace.components), component: "x", reply: nil, usage: ""),
            "purposeNone": ComponentSpecs.purposeLine(ComponentSpecs.draft(from: messages[0].1, bot: "Shop", folder: folder, library: workspace.components), from: "Shop"),
            "headers": ComponentAction.allCases.map { $0.header("ID") },
        ]
        let fills = ["<show name=\"test-board\">{\"a\":1}</show>", "Sure <show name=\"other\">{\"b\":2}</show>", "<show name=\"test-board\">null</show>", "It does not fit.\nMore.", ""].map { answer -> [String: Any] in
            switch ComponentSpecs.filledData(from: answer, component: "test-board") {
            case let .success(data): return ["answer": answer, "data": data]
            case let .failure(problem): return ["answer": answer, "problem": problem.text]
            }
        }
        return ["drafts": drafts, "slugs": slugs, "jsons": jsons, "parsed": parsed, "matches": matches, "steps": steps, "summary": summary, "requests": requests, "fills": fills,
                "folder": folder.path, "page": page.path, "pageText": ComponentSpecs.pageText(String(decoding: (try? Data(contentsOf: page)) ?? Data(), as: UTF8.self))]
    }

    static func encoded(_ spec: ComponentSpec) -> Any {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(spec))) ?? NSNull()
    }

    /// "Report a problem…" and the change requests Maintainer gets (`problemReport`, `requestComponentChange`).
    @MainActor static func reports(workspace: Workspace, root: URL) -> [String: Any] {
        let ran = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let pins: [(String, PinnedComponent?)] = [
            ("none", nil),
            ("noCommand", PinnedComponent(name: "test", data: "{}", savedAt: ran)),
            ("shown", PinnedComponent(name: "test-status", command: "npm test --json", data: "{}", ranAt: ran)),
            ("manual", PinnedComponent(name: "test-status", command: "npm test --json", data: "{}", refresh: .manual)),
            ("minutes", PinnedComponent(name: "test-status", command: "npm test --json", data: "{}", ranAt: ran, refresh: .interval, minutes: 30)),
            ("seconds", PinnedComponent(name: "test-status", command: "npm test --json", data: "{}", refresh: .interval, seconds: 5)),
        ]
        let problems = pins.map { label, pin in
            ["label": label, "pin": pin.map { ["command": $0.command ?? NSNull(), "refresh": $0.refresh.rawValue, "minutes": $0.minutes, "seconds": $0.seconds ?? NSNull(),
                                                "ranAt": $0.ranAt?.timeIntervalSinceReferenceDate ?? NSNull(), "savedAt": $0.savedAt?.timeIntervalSinceReferenceDate ?? NSNull()] as [String: Any] } ?? NSNull(),
             "report": Workspace.problemReport("It is cut off", chat: "Shop", pin: pin, screenshot: label == "shown" ? URL(filePath: "/tmp/shot one.png") : nil)] as [String: Any]
        }
        // What Maintainer is handed: words, pictures only, a new component, with the list note of a bot.
        let picture = root.appending(path: "look.png")
        try? Data([0x89, 0x50, 0x4E, 0x47]).write(to: picture)
        var relays: [[String: Any]] = []
        for (name, request, files) in [("test", "Make it blue", [URL]()), ("test", "", [picture]), ("test-status", "add a total", [picture, picture]), ("brand-new", "a clock", [URL]())] {
            workspace.requestComponentChange(name, request: request, from: "The user", files: files)
            relays.append(["name": name, "request": request, "files": files.count, "text": workspace.maintainer.messages.last { $0.role == .relay }?.text ?? NSNull()])
        }
        return ["problems": problems, "relays": relays]
    }
}
