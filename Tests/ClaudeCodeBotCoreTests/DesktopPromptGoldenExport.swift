import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Botling 2.0 (desktop/) ports the generated instructions to TypeScript. This writes the Swift
/// app's own strings for a set of inputs to a JSON file, which desktop/test/unit/prompts.test.ts
/// compares the port against, character for character. Runs only when asked:
///
///     CCB_DESKTOP_PROMPT_EXPORT=/path/prompts-golden.json TZ=UTC swift test --filter DesktopPromptGoldenExport
struct DesktopPromptGoldenExport {
    @MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_DESKTOP_PROMPT_EXPORT"] != nil))
    func exportPromptStrings() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_DESKTOP_PROMPT_EXPORT"])
        var prompts: [[String: Any]] = []
        func add(_ name: String, _ profile: BotProfile, profileInfo: [String: Any], language: AppLanguage = .english,
                 results: ResultPublishing = .artifactUnlessSensitive, dual: Bool = false) {
            let heads: HeadsSettings? = dual ? .init(engines: [.claude, .codex]) : nil
            let p = BotPrompts(profile: profile, results: results, language: language, engine: .claude, heads: heads)
            prompts.append([
                "name": name,
                "input": ["profile": profileInfo, "language": language.rawValue, "results": results.rawValue, "dual": dual],
                "output": ["system": p.system, "headsRule": p.headsRule, "wake": p.wake, "tidy": p.tidy, "handoff": p.handoff, "resume": p.resume],
            ])
        }
        let root = URL(filePath: "/tmp/claude-dispatch-compatibility")
        let main = BotProfile.main(home: root)
        let mainInfo: [String: Any] = ["role": "main", "name": main.name, "folder": root.path]
        var probe = BotProfile.manager(name: "Probe", avatar: "square", folder: root)
        probe.instructions = "Keep the project's billing API stable."
        let probeInfo: [String: Any] = ["role": "manager", "name": "Probe", "folder": root.path, "instructions": probe.instructions!]
        // The eight configurations ClaudePromptCompatibilityTests hashes.
        for (index, (profile, info)) in [(main, mainInfo), (probe, probeInfo)].enumerated() {
            for language in [AppLanguage.english, .traditionalChinese] {
                for dual in [false, true] {
                    add("\(index)-\(language.rawValue)-\(dual)", profile, profileInfo: info, language: language, dual: dual)
                }
            }
        }
        // More inputs: other languages and result choices, a bot of its own, a manager with no extra instructions.
        let plainFolder = URL(filePath: "/Users/someone/Projects/garden app")
        let plain = BotProfile.manager(name: "garden", avatar: "hexagon", folder: plainFolder)
        let plainInfo: [String: Any] = ["role": "manager", "name": "garden", "folder": plainFolder.path]
        add("manager-plain-ja-local", plain, profileInfo: plainInfo, language: .japanese, results: .localOnly)
        add("manager-plain-ko-always", plain, profileInfo: plainInfo, language: .korean, results: .artifactAlways)
        add("main-zh-Hans-local", main, profileInfo: mainInfo, language: .simplifiedChinese, results: .localOnly)
        let newsFolder = URL(filePath: "/Users/someone/Library/Botling 2/core/bots/1B2C3D4E-0000-4000-8000-000000000001")
        let news = BotProfile.standalone(name: "Morning news", avatar: "star", folder: newsFolder, job: "Every day at 08:00, collect the top five tech headlines and post them here.")
        let newsInfo: [String: Any] = ["role": "bot", "name": "Morning news", "folder": newsFolder.path, "job": news.job!]
        add("standalone-en", news, profileInfo: newsInfo)
        add("standalone-zh-Hant-dual", news, profileInfo: newsInfo, language: .traditionalChinese, dual: true)

        // The wake briefing's recent lines, an archive entry each, and the reactions intro.
        let home = FileManager.default.temporaryDirectory.appending(path: "ccb-golden-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let base = Date(timeIntervalSinceReferenceDate: 783_000_000) // 2025-10-24 10:40 UTC
        func line(_ id: String, _ role: ChatMessage.Role, _ text: String, minutes: Double) -> ChatMessage {
            ChatMessage(id: UUID(uuidString: id)!, role: role, text: text, date: base.addingTimeInterval(minutes * 60))
        }
        var lines = [
            line("11111111-0000-4000-8000-000000000001", .user, "Every folder under ~/tool\nshould have a bot", minutes: 0),
            line("11111111-0000-4000-8000-000000000002", .bot, "Which first?", minutes: 1),
            line("11111111-0000-4000-8000-000000000003", .user, "Forms", minutes: 2),
            line("11111111-0000-4000-8000-000000000004", .notice, "The app restarted.", minutes: 3),
            line("11111111-0000-4000-8000-000000000005", .bot, String(repeating: "long words ", count: 70), minutes: 4),
            line("11111111-0000-4000-8000-000000000006", .bot, "Pick one", minutes: 61),
            line("11111111-0000-4000-8000-000000000007", .error, "claude exited unexpectedly (1)", minutes: 62),
            line("11111111-0000-4000-8000-000000000008", .user, "  ", minutes: 63),
            line("11111111-0000-4000-8000-000000000009", .bot, "Cut off here", minutes: 64),
            line("11111111-0000-4000-8000-00000000000A", .user, "And now?", minutes: 65),
        ]
        lines[1].choices = [Choice(label: "Forms", recommended: true), Choice(label: "Jumps", detail: "slower")]
        lines[1].chosen = 0
        lines[5].choices = [Choice(label: "A"), Choice(label: "B")]
        lines[2].attachments = [Attachment(url: URL(filePath: "/Users/someone/Pictures/shot one.png"))]
        lines[8].interrupted = true
        lines[0].reactions = [MessageReaction(emoji: "👍", actor: "head:claude")]
        let store = BotStore(directory: home.appending(path: "store"))
        store.save(messages: lines)
        let bot = Bot(profile: .main(home: home.appending(path: "main")), launcher: FakeLauncher().launcher, store: store)
        let current = lines.last!.id
        let intro = ReactionContext.intro(bot.messages, current: current)
        let update = ReactionContext.update(bot.messages, seen: ReactionContext.seen(bot.messages).mapValues { _ in [] }, current: current)
        let briefing: [String: Any] = [
            "home": home.appending(path: "main").path,
            "messages": lines.map { message -> [String: Any] in
                var row: [String: Any] = ["id": message.id.uuidString, "role": message.role.rawValue, "text": message.text,
                                          "date": message.date.timeIntervalSinceReferenceDate]
                if let choices = message.choices {
                    row["choices"] = choices.map { choice -> [String: Any] in
                        var c: [String: Any] = ["label": choice.label, "recommended": choice.recommended]
                        if let detail = choice.detail { c["detail"] = detail }
                        return c
                    }
                }
                if let chosen = message.chosen { row["chosen"] = chosen }
                if let files = message.attachments { row["attachments"] = files.map { ["url": $0.url.absoluteString, "kind": $0.kind.rawValue] } }
                if message.interrupted == true { row["interrupted"] = true }
                if let reactions = message.reactions { row["reactions"] = reactions.map { ["emoji": $0.emoji, "actor": $0.actor] } }
                return row
            },
            "recentLeavingOutLast": bot.recentChat(leavingOut: current),
            "recentAll": bot.recentChat(),
            "archiveEntries": lines.map { (Bot.archiveEntry($0) as Any?) ?? NSNull() },
            "reactionIntro": intro.text,
            "reactionUpdate": update.text,
        ]
        let subagents = [Subagent(id: "toolu_1", description: "Research the API", prompt: "Look it up", status: .completed),
                         Subagent(id: "toolu_2", description: "Check tests", prompt: "Run them", status: .failed)]
        let notes: [String: Any] = [
            "reportNote": Bot.reportNote(subagents),
            "pauseNote": Bot.pauseNote,
            "wakeLead": BotPrompts.wakeLead,
            "tidyLead": BotPrompts.tidyLead,
            "relayPrefix": BotPrompts.relayPrefix,
        ]
        let export: [String: Any] = [
            "replies": Self.replySamples.map { sample -> [String: Any] in
                let parsed = ReplyParser.parseAll(sample)
                return [
                    "reply": sample,
                    "body": parsed.body,
                    "choices": parsed.choices.map { $0.map { c -> [String: Any] in
                        var row: [String: Any] = ["label": c.label, "recommended": c.recommended]
                        if let detail = c.detail { row["detail"] = detail }
                        return row
                    } } ?? NSNull(),
                    "tasks": parsed.tasks.map(Self.tagRow),
                    "reactions": parsed.reactions.map { ["messageId": $0.messageID.uuidString, "emoji": $0.emoji, "present": $0.present] },
                    "displays": parsed.displays.map { d -> [String: Any] in
                        var row: [String: Any] = ["name": d.name, "data": d.data]
                        if let at = d.at { row["at"] = at }
                        if let command = d.command { row["command"] = command }
                        if let id = d.id { row["id"] = id }
                        return row
                    },
                    "requests": parsed.requests.map(Self.requestRow),
                    "signals": parsed.completionSignals.map { ["kind": $0.kind == .end ? "end" : "block", "evidence": $0.evidence] },
                    "decisionReference": parsed.decisionReference?.uuidString ?? NSNull(),
                    "saysNoReply": ReplyParser.saysNoReply(sample),
                    "saysNothing": Bot.saysNothing(sample),
                ]
            },
            "taskScenario": Self.taskScenario(),
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopPromptGoldenExport.swift from the Swift app's own code (TZ=\(TimeZone.current.identifier), locale \(Locale.current.identifier)).",
            "timeZone": TimeZone.current.identifier,
            "locale": Locale.current.identifier,
            "prompts": prompts,
            "briefing": briefing,
            "notes": notes,
        ]
        try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys]).write(to: URL(filePath: path))
    }

    static let replySamples = [
        "Pick one.\n<choices>\n* Fast | cheap\n- Slow | costly\n</choices>",
        "Nothing new. <no-reply/>",
        "<no-reply/>",
        "<no-reply></no-reply>\n<task name=\"Docs\" state=\"done\"/>",
        "Working on it.\n<task name=\"Docs\" now=\"writing\" next=\"review\" state=\"running\"/>",
        "`<choices>* a</choices>` is an example\n```\n<no-reply/>\n<task name=\"x\"/>\n```\nDone.",
        "Two parts\n<task name=\"A\"/>\n<task continues=\"B\" state=\"done\" blocked=\"\"/>",
        "<task name='x &amp; y' now='it&#39;s &lt;here&gt;' state='Waiting'/>\n<task state=\"pending\"></task>",
        "Thanks!\n<reaction message=\"11111111-0000-4000-8000-000000000001\" emoji=\"👍\" present=\"true\"/>",
        "<reaction message=\"11111111-0000-4000-8000-000000000001\" emoji=\"🙃\" present=\"true\"/>\nInline <reaction message=\"11111111-0000-4000-8000-000000000002\" emoji=\"👀\" present=\"false\"/> stays",
        "<blockquote>\n<reaction message=\"11111111-0000-4000-8000-000000000001\" emoji=\"👍\" present=\"true\"/>\n</blockquote>",
        "Here:\n<show name=\"status\">{\"ok\":true}</show>\nAnd more <show name=\"bad\">{oops</show> end <show id=\"t\" name='tests' command=\" git status \"/>",
        "前言 😀\n<show name=\"c\"/>\n後記",
        "<team name=\"research\">Find X</team> and <plugin>add Y</plugin> <new-project folder=\" ~/tool/** \"/> <open-question from='garden'/> <suggest-component name=\"tests\">t</suggest-component> <install>git+https://x</install> <new-bot name=\"News\">daily</new-bot> <component name=\"chart\">bigger</component> <need-folder>/tmp/x</need-folder> <app-screenshot/> <give-component bot=\"garden\">weather</give-component>",
        "First\n<choices>\n* A\n</choices>\nThen\n<choices>\n- B | b\n* C\n</choices>",
        "<choices>\n★ One\n• Two | d\n  Three  |  \n|\n</choices>",
        "<end>All done: tests pass</end> and <block>needs a key</block>",
        "<decision-ref id=\"22222222-0000-4000-8000-000000000001\"/>\nAs before.",
        "Plain words.",
        "  \n",
        "~~~\n<choices>\n* fenced\n</choices>\n~~~\nunterminated ```\n<no-reply/>",
    ]

    static func tagRow(_ tag: TaskTag) -> [String: Any] {
        var row: [String: Any] = [:]
        if let v = tag.name { row["name"] = v }
        if let v = tag.continues { row["continues"] = v }
        if let v = tag.now { row["now"] = v }
        if let v = tag.next { row["next"] = v }
        if let v = tag.blocked { row["blocked"] = v }
        if let v = tag.state { row["state"] = v.rawValue }
        return row
    }

    static func requestRow(_ request: BotRequest) -> [String: Any] {
        switch request {
        case let .team(name, task): ["kind": "team", "name": name, "task": task]
        case let .component(name, request): ["kind": "component", "name": name, "request": request]
        case let .plugin(request): ["kind": "plugin", "request": request]
        case let .folder(path): ["kind": "folder", "path": path]
        case let .install(source): ["kind": "install", "source": source]
        case let .newBot(name, job): ["kind": "newBot", "name": name, "job": job]
        case let .newProject(folder, task): ["kind": "newProject", "folder": folder, "task": task]
        case let .installBuild(path, note): ["kind": "installBuild", "path": path, "note": note]
        case .appScreenshot: ["kind": "appScreenshot"]
        case let .openQuestion(from): ["kind": "openQuestion", "from": from]
        case let .giveComponent(bot, name): ["kind": "giveComponent", "bot": bot, "name": name]
        case let .takeComponent(bot, name): ["kind": "takeComponent", "bot": bot, "name": name]
        case let .suggestComponent(name, draft): ["kind": "suggestComponent", "name": name, "draft": draft]
        case let .componentDeclined(id, reason): ["kind": "componentDeclined", "id": id, "reason": reason]
        case let .componentSpec(id, json): ["kind": "componentSpec", "id": id, "json": json]
        }
    }

    /// A run of TaskBook operations with fixed message ids and dates, and the cards after each.
    static func taskScenario() -> [[String: Any]] {
        let t0 = Date(timeIntervalSinceReferenceDate: 783_000_000)
        func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }
        func m(_ n: Int) -> UUID { UUID(uuidString: String(format: "33333333-0000-4000-8000-%012d", n))! }
        var book = TaskBook()
        var steps: [[String: Any]] = []
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func record(_ op: String, _ result: Any = NSNull()) {
            let data = try! encoder.encode(book.tasks)
            steps.append(["op": op, "result": result, "tasks": try! JSONSerialization.jsonObject(with: data)])
        }
        func turn(_ message: Int?, _ text: String?, started: Double?, tools: Bool = false, asks: Bool = false, running: Set<String> = [], reporting: [String] = []) -> TaskBook.Turn {
            TaskBook.Turn(head: .claude, userMessage: message.map(m), userText: text, started: started.map(at), usedTools: tools, reporting: reporting, asks: asks, runningSubagents: running)
        }
        let long = "Write the docs for the API, with examples for every endpoint\nand more"
        book.begin(message: m(1), text: long, owner: .claude, at: at(0)); record("begin 1")
        record("claim 1", book.claim(message: m(1), by: .claude, at: at(1)))
        book.working(on: m(1), text: long, by: .claude, at: at(2)); record("working 1")
        record("replied 101", book.replied(m(101), turn: turn(1, long, started: 0, tools: true), tags: [TaskTag(name: "Docs", now: "writing", state: .running)], at: at(30)).count)
        book.begin(message: m(2), text: "thanks", owner: .claude, at: at(40)); record("begin 2")
        record("replied 102 quick", book.replied(m(102), turn: turn(2, "thanks", started: 40), tags: [], at: at(45)).count)
        book.begin(message: m(3), text: "\n  A long question  \nwith lines", owner: .claude, at: at(50)); record("begin 3")
        record("replied 103 slow", book.replied(m(103), turn: turn(3, "\n  A long question  \nwith lines", started: 50), tags: [], at: at(100)).count)
        book.begin(message: m(4), text: "follow up on docs", owner: .claude, at: at(200)); record("begin 4")
        record("replied 104 continues", book.replied(m(104), turn: turn(4, "follow up on docs", started: 200), tags: [TaskTag(continues: "docs", now: "", state: .done)], at: at(230)).count)
        book.begin(message: m(5), text: "Which?", owner: .claude, replyingTo: m(101), at: at(300)); record("begin 5 replying")
        book.begin(message: m(6), text: "part one", owner: .claude, at: at(400))
        book.begin(message: m(7), text: "part two", owner: .claude, at: at(401))
        book.join(message: m(6), into: m(7)); record("join 6 7")
        book.begin(message: m(8), text: "decide something", owner: .claude, at: at(500))
        record("replied 108 asks", book.replied(m(108), turn: turn(8, "decide something", started: 500, tools: true, asks: true), tags: [], at: at(530)).count)
        book.begin(message: m(9), text: "research", owner: .claude, at: at(600))
        if let card = book.task(containing: m(9)) { book.link(subagent: "toolu_x", to: card.id) }
        record("link 9")
        record("replied 109 running sub", book.replied(m(109), turn: turn(9, "research", started: 600, tools: true, running: ["toolu_x"]), tags: [], at: at(610)).count)
        record("replied 110 report", book.replied(m(110), turn: turn(nil, nil, started: nil, reporting: ["toolu_x"]), tags: [], at: at(900)).count)
        book.begin(message: m(11), text: "two things", owner: .claude, at: at(1000))
        record("replied 111 two tags", book.replied(m(111), turn: turn(11, "two things", started: 1000, tools: true), tags: [TaskTag(name: "One", state: .running), TaskTag(name: "Two", next: "later")], at: at(1010)).count)
        record("replied 112 bg new", book.replied(m(112), turn: turn(nil, nil, started: nil), tags: [TaskTag(name: "Background")], at: at(1100)).count)
        return steps
    }
}
