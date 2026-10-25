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
        out["shots"] = shots(root: root)
        out["completion"] = completion()
        return out
    }

    /// The completion judge's strings, its evidence record and its reviews (`PromiseCheck`).
    static func completion() -> [String: Any] {
        func ends() -> [(String, PromiseCheck.TurnEnd)] {
            var plain = PromiseCheck.TurnEnd(reply: "Done: the parser is faster. See /tmp/a/b.", workPending: false, task: "Make the parser faster", conversation: "[user] Make the parser faster",
                                             dependencies: [], actions: ["Bash: Run; input: npm test; done: true; failed: false; output: ok"], memory: "## Current status\n", terminalRequired: false, signals: [])
            plain.evaluatedAt = "2026-10-25T04:00:00Z"
            plain.timeZone = "UTC"
            var workers = plain
            workers.workPending = true
            workers.workerDependencies = [.init(id: "w1", run: 1, task: String(repeating: "長", count: 1500), state: .running, callback: "app_task_result"),
                                          .init(id: "w2", run: 2, task: "report", state: .reportQueued, callback: nil, outcome: "completed")]
            workers.scheduledWakeups = [.init(id: PromiseCheck.wakeupID("routine:r1"), task: "Check again", fireAt: Date(timeIntervalSince1970: 1_792_900_000), callback: "app_routine"),
                                        .init(id: "s2", task: "Past", fireAt: Date(timeIntervalSince1970: 1_700_000_000), callback: "session_wakeup")]
            workers.completed = ["Task: old\nReported complete: merged"]
            workers.signals = [.init(kind: .end, evidence: "merged abc123")]
            workers.terminalRequired = true
            var long = plain
            long.reply = String(repeating: "r", count: 7000)
            long.task = String(repeating: "t", count: 13000)
            long.conversation = String(repeating: "c", count: 13000)
            long.dependencies = (0..<30).map { "dep \($0) " + String(repeating: "d", count: 1300) }
            long.actions = (0..<15).map { "act \($0) " + String(repeating: "a", count: 1700) }
            var huge = plain
            huge.conversation = String(repeating: "中文", count: 6000)
            huge.memory = String(repeating: "記", count: 6000)
            huge.reply = String(repeating: "答", count: 6000)
            huge.task = String(repeating: "務", count: 12000)
            huge.dependencies = (0..<24).map { _ in String(repeating: "依", count: 1200) }
            huge.actions = (0..<12).map { _ in String(repeating: "動", count: 1600) }
            return [("plain", plain), ("workers", workers), ("long", long), ("huge", huge)]
        }
        let judgments: [PromiseCheck.Judgment] = [
            .init(verdict: .complete, reason: "done"), .init(verdict: .waitingUser, reason: "needs key"), .init(verdict: .unknown, reason: "unclear"),
            .init(verdict: .waitingTimer, reason: "cooldown", wakeupID: PromiseCheck.wakeupID("routine:r1")), .init(verdict: .waitingTimer, reason: "past", wakeupID: "s2"),
            .init(verdict: .waitingDependency, reason: "w1 owns it"), .init(verdict: .continueWork, reason: "more"),
        ]
        var reviews: [[String: Any]] = []
        for (label, end) in ends() {
            for judgment in judgments {
                let reviewed = PromiseCheck.review(judgment, for: end)
                reviews.append(["end": label, "verdict": judgment.verdict.rawValue, "wakeupID": judgment.wakeupID ?? NSNull(), "reviewed": reviewed.verdict.rawValue, "reason": reviewed.reason])
            }
        }
        let parses = [#"{"verdict":"COMPLETE","reason":"ok","wakeupID":null}"#, #"{"verdict":"COMPLETE","reason":"  "}"#, #"{"verdict":"UNAVAILABLE","reason":"x"}"#, #"{"verdict":"NOPE","reason":"x"}"#, "nope",
                      #"{"verdict":"WAITING_TIMER","reason":"wait","wakeupID":"abc"}"#].map { text -> [String: Any] in
            if let judgment = try? PromiseCheck.parseVerdict(text) { return ["text": text, "verdict": judgment.verdict.rawValue, "reason": judgment.reason, "wakeupID": judgment.wakeupID ?? NSNull()] }
            return ["text": text, "failed": true]
        }
        return [
            "followUp": PromiseCheck.followUp, "terminalFollowUp": PromiseCheck.terminalFollowUp, "classifierPrompt": PromiseCheck.classifierPrompt,
            "schema": PromiseCheck.judgmentSchema, "judgeModel": PromiseCheck.judgeModel, "wakeupID": PromiseCheck.wakeupID("routine:r1"),
            "arguments": PromiseCheck.classifierArguments(message: "THE MESSAGE", folder: URL(filePath: "/tmp/judge"), model: "gpt-x"),
            "messages": ends().map { ["end": $0.0, "message": PromiseCheck.classifierMessage($0.1), "live": PromiseCheck.hasLiveWorkerOwner($0.1)] as [String: Any] },
            "reviews": reviews, "parses": parses,
        ]
    }

    static func encode<T: Encodable>(_ value: T) -> Any {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(value))) ?? NSNull()
    }

    /// `botling --component-shot` (ComponentShot.swift): its usage, how it reads the command line, where
    /// its data comes from, its Command check, `judge`, `isUniform` and `summary`. Paths under `root` are
    /// written as "<root>" (the desktop test makes its own folder).
    static func shots(root: URL) -> [String: Any] {
        let base = root.appending(path: "shots")
        let files = FileManager.default
        let template = { (folder: URL, about: String?) in
            try? files.createDirectory(at: folder, withIntermediateDirectories: true)
            try? Data("<div>card</div>".utf8).write(to: folder.appending(path: "template.html"))
            if let about { try? Data(about.utf8).write(to: folder.appending(path: "about.md")) }
        }
        template(base.appending(path: "comp"), "A card.")
        let place = { (text: String) in text.replacingOccurrences(of: base.path, with: "<root>") }

        // The command line, from the folder `base`.
        let lines: [[String]] = [
            ["botling", "--component-shot"],
            ["botling", "--component-shot", "--out", "x"],
            ["botling", "--component-shot", "comp"],
            ["botling", "--component-shot", "comp", "--out", "shots", "--data", "d.json", "--folder", "/abs/proj", "--surfaces", "Board, chat,board", "--sizes", "2x1,small,2×1", "--theme", "Dark"],
            ["botling", "--component-shot", "./comp/../comp", "--sizes", "ALL"],
            ["botling", "--component-shot", "comp", "--sizes", "4x2, M"],
            ["botling", "--component-shot", "comp", "--surfaces", "chat,side"],
            ["botling", "--component-shot", "comp", "--surfaces", ","],
            ["botling", "--component-shot", "comp", "--sizes", "9x9"],
            ["botling", "--component-shot", "comp", "--sizes", ","],
            ["botling", "--component-shot", "comp", "--theme", "light"],
            ["botling", "--component-shot", "comp", "--out"],
            ["botling", "--component-shot", "nothing"],
            ["botling", "--component-shot", "nothing", "--theme", "light"],
            ["-psn_0", "--component-shot", "comp", "--verbose", "--sizes", "1x1", "stray"],
            ["botling", "--component-shot", base.appending(path: "comp").path, "--surfaces", "floating,pinned"],
        ]
        let parsed = lines.map { arguments -> [String: Any] in
            switch ComponentShot.parse(arguments, cwd: base) {
            case let .success(options):
                let out = options.out.lastPathComponent.hasPrefix("ccb-shot-comp-") && options.out.deletingLastPathComponent().standardizedFileURL == files.temporaryDirectory.standardizedFileURL ? "<default>" : place(options.out.path)
                return ["arguments": arguments.map(place), "options": [
                    "component": place(options.component.path), "out": out, "data": options.data.map { place($0.path) } ?? NSNull(),
                    "folder": options.folder.map { place($0.path) } ?? NSNull(), "surfaces": options.surfaces.map(\.rawValue),
                    "sizes": options.sizes?.map(\.rawValue) ?? NSNull(), "theme": options.theme,
                ] as [String: Any]]
            case let .failure(error):
                return ["arguments": arguments.map(place), "error": place(error.description)]
            }
        }

        let abouts = [
            "A card.\n\n```json\n{\"a\": 1,\n \"b\": [2]}\n```\n",
            "Broken first:\n```json\n{nope\n```\nthen\n```JSON\n[1, 2]\n```",
            "- Data: {\"count\": 3}",
            "Example: `[\"x\", \"y\"]`",
            "  * example data: {\"a\": true}",
            "Sample: nope\nData: \"text\"\nData: 42\nSample: {\"ok\": 1}",
            "No example here.",
            "```json\n{\"never\": \"closed\"}",
            "```json\n\n```\nData: [1]",
        ]
        let samples = abouts.map { ["about": $0, "data": ComponentShot.sampleData(fromAbout: $0) ?? NSNull()] as [String: Any] }

        let spelled = { (texts: [String]) in texts.compactMap { PinnedComponent.Size(spelled: $0) } }
        let sizeCases: [([String]?, [String])] = [(nil, []), (nil, ["2x2"]), (nil, ["1x2", "2x1", "3x3"]), (["1x1"], ["3x3"]), ([], ["2x2"])]
        let sizes = sizeCases.map { asked, hinted in
            ["asked": asked ?? NSNull(), "hinted": hinted, "sizes": ComponentShot.sizes(asked: asked.map(spelled), hinted: spelled(hinted)).map(\.rawValue)] as [String: Any]
        }
        let folders = ["/lib/plug/components/card", "/lib/card", "/components/card", "/lib/plug/components"].map {
            ["component": $0, "folder": ComponentShot.commandFolder(for: URL(filePath: $0)).path]
        }
        let sources: [String] = [ComponentShot.DataSource.file("/a/d.json"), .command("npm test --json"), .example, .none].map(\.description)

        typealias Report = ComponentShot.FrameReport
        let reports: [(String, Report, String, Bool)] = [
            ("fine", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 120), "chat", false),
            ("errors", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 120,
                              errors: ["TypeError: x is undefined\n  at draw (line 3)\n\n  at load"], rejections: ["Error: nope"], console: ["bad thing {\"a\":1}"],
                              ccb: ["ccb.nope is not part of ccb (see PLUGINS.md for the API)"], resources: ["img https://example.com/a.png"]), "chat", false),
            ("long", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 120,
                            errors: [String(repeating: "ab", count: 400)]), "chat", false),
            ("wide", Report(surface: "board", size: "2x1", width: 340.6, height: 160, scrollWidth: 420.9, scrollHeight: 160, contentHeight: 150,
                            widest: "table.list", widestRight: 419.7), "board 2x1", false),
            ("wideNoElement", Report(surface: "pinned", size: "2x2", width: 500, height: 300, scrollWidth: 502, scrollHeight: 300, contentHeight: 150), "pinned", false),
            ("slack", Report(surface: "board", size: "1x1", width: 160, height: 160, scrollWidth: 161, scrollHeight: 161, contentHeight: 150), "board 1x1", false),
            ("tall", Report(surface: "board", size: "1x1", width: 160, height: 160, scrollWidth: 160, scrollHeight: 260.5, contentHeight: 260), "board 1x1", false),
            ("tallChat", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 900, contentHeight: 880), "chat", false),
            ("nothing", Report(surface: "floating", size: "2x2", width: 300, height: 200, scrollWidth: 300, scrollHeight: 200, contentHeight: 1.5), "floating", true),
            ("blank", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 40, hasText: false), "chat", true),
            ("blankText", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 40, hasText: true), "chat", true),
            ("blankMedia", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 40, hasText: false, hasMedia: true), "chat", true),
            ("notUniform", Report(surface: "chat", size: "4x2", width: 600, height: 300, scrollWidth: 600, scrollHeight: 300, contentHeight: 40, hasText: false), "chat", false),
        ]
        let judged = reports.map { label, report, at, uniform in
            ["label": label, "report": encode(report), "place": at, "uniform": uniform, "masked": report.hasMaskedErrors,
             "findings": encode(ComponentShot.judge(report, place: at, uniform: uniform))] as [String: Any]
        }
        let masked = Report(surface: "chat", size: "4x2", width: 1, height: 1, scrollWidth: 1, scrollHeight: 1, contentHeight: 1, errors: ["Script error. (line 0)"]).hasMaskedErrors

        // Pictures: one colour, a little noise, a stripe, half and half, nothing.
        let pixels = { (count: Int, colour: (Int) -> [UInt8]) in (0..<count).flatMap { colour($0) } }
        let pictures: [(String, [UInt8])] = [
            ("flat", pixels(400) { _ in [30, 30, 34, 255] }),
            ("noise", pixels(400) { i in [UInt8(30 + i % 7), 30, UInt8(34 + i % 5), 255] }),
            ("stripe", pixels(400) { i in i < 4 ? [240, 240, 240, 255] : [30, 30, 34, 255] }),
            ("dot", pixels(1000) { i in i == 0 ? [240, 240, 240, 255] : [30, 30, 34, 255] }),
            ("half", pixels(400) { i in i < 150 ? [200, 40, 40, 255] : [30, 30, 34, 255] }),
            ("empty", []),
            ("edge", pixels(400) { i in i < 300 ? [15, 15, 15, 255] : [33, 33, 33, 255] }),
        ]
        let uniform = pictures.map { ["label": $0.0, "pixels": Data($0.1).base64EncodedString(), "uniform": ComponentShot.isUniform($0.1)] as [String: Any] }

        typealias Finding = ComponentShot.Finding
        let shotsMade = [ComponentShot.Shot(place: "chat", path: "/out/chat.png"), ComponentShot.Shot(place: "board 2x1", path: "/out/board-2x1.png"), ComponentShot.Shot(place: "board 2x2", path: "/out/board-2x2.png")]
        let wide = "Wider than its frame: 420px of content in 340px, cut off on the right"
        let summaryCases: [(String, ComponentShot.DataSource, [Finding], [ComponentShot.Shot], String?, [String])] = [
            ("clean", .example, [], shotsMade, "/out/contact-sheet.png", []),
            ("one", .file("/a/d.json"), [], [shotsMade[0]], nil, ["Its Command ran as written in /lib/plug."]),
            ("none", .none, [Finding(level: .warning, place: "chat", text: "Not drawn: with null data the chat shows \"Nothing to show\" (give --data or add an example to about.md)")], [], nil, []),
            ("grouped", .command("git log -1"), [
                Finding(level: .problem, place: "board 2x1", text: wide), Finding(level: .problem, place: "chat", text: "Script error: boom"),
                Finding(level: .problem, place: "board 2x2", text: wide), Finding(level: .warning, place: "board 1x1", text: "Taller than its tile"),
                Finding(level: .problem, place: "board 2x1", text: wide), Finding(level: .warning, place: "board 2x1", text: "Taller than its tile"),
            ], shotsMade, "/out/contact sheet.png", ["It has a Command; pass --folder <project> to draw what the command prints."]),
        ]
        let summaries = summaryCases.map { label, source, findings, shots, sheet, notes in
            ["label": label, "component": "status card", "source": sources[[ComponentShot.DataSource.file("/a/d.json"), .command("git log -1"), .example, .none].firstIndex(of: source) ?? 0],
             "findings": encode(findings), "shots": encode(shots), "sheet": sheet ?? NSNull(), "notes": notes,
             "text": ComponentShot.summary(component: "status card", data: source, findings: findings, shots: shots, sheet: sheet, notes: notes)] as [String: Any]
        }

        // Its Command, run once as written (each in a folder of its own under `base`).
        let commandCases: [(String, String?, String?, Double)] = [
            ("noCommand", nil, nil, 30),
            ("works", "echo '{\"n\": 1}'", nil, 30),
            ("fails", "echo oops >&2; echo more >&2; exit 3", nil, 30),
            ("failsInFolder", "echo oops >&2; exit 3", "project", 30),
            ("noFolder", "echo hi", "missing", 30),
            ("slow", "sleep 5", nil, 1),
        ]
        var commands: [[String: Any]] = []
        for (label, command, folder, timeout) in commandCases {
            let component = base.appending(path: "plug-\(label)/components/card")
            template(component, command.map { "A card.\nCommand: \($0)\n" } ?? "A card.\n")
            let project = folder.map { base.appending(path: $0) }
            if folder == "project" { try? files.createDirectory(at: project!, withIntermediateDirectories: true) }
            let done = DispatchSemaphore(value: 0)
            nonisolated(unsafe) var check: ComponentShot.CommandCheck?
            Task.detached {
                check = await ComponentShot.checkCommand(component: component, folder: project, timeout: timeout)
                done.signal()
            }
            done.wait()
            commands.append(["label": label, "command": command ?? NSNull(), "folder": folder ?? NSNull(), "timeout": timeout,
                             "check": check.map { ["command": $0.command, "folder": place($0.folder.path), "data": $0.outcome.data ?? NSNull(), "timedOut": $0.outcome.timedOut,
                                                   "findings": (encode($0.findings) as? [[String: Any]] ?? []).map { finding in finding.mapValues { ($0 as? String).map(place) ?? $0 } }] as [String: Any] } ?? NSNull()])
        }

        return [
            "usage": ComponentShot.usage,
            "flag": ComponentShot.flag,
            "parse": parsed,
            "samples": samples,
            "sizes": sizes,
            "commandFolders": folders,
            "sources": sources,
            "judge": judged,
            "maskedScriptError": masked,
            "uniform": uniform,
            "summaries": summaries,
            "fileNames": ["board 2x1", "chat", "board  4x2"].map { ["place": $0, "file": ComponentShot.fileName($0)] },
            "commands": commands,
            "commandCheckTimeout": ComponentShot.commandCheckTimeout,
        ]
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
