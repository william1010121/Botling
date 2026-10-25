import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Botling 2.0 (desktop/) Phase 5c ports the component brief, switching a head's engine through a handoff,
/// and the usage page's numbers (rate limits, tokens, spending). This writes the Swift app's own strings and
/// values for them to a JSON file, which desktop/test/unit/phase5c.test.ts compares the port against. Runs only
/// when asked:
///
///     CCB_DESKTOP_PHASE5C_EXPORT=/path/phase5c-golden.json TZ=UTC swift test --filter DesktopPhase5cGoldenExport
struct DesktopPhase5cGoldenExport {
    @MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_DESKTOP_PHASE5C_EXPORT"] != nil))
    func exportPhase5cStrings() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_DESKTOP_PHASE5C_EXPORT"])
        let date = Date(timeIntervalSinceReferenceDate: 800_000_000)

        // The brief: what the fork is asked (with and without the user's message, a long one clipped), and
        // what is taken from its answer.
        let reply = ChatMessage(role: .bot, text: "Your 3 tests:\n- 2 passed\n- 1 failed (parser)", date: date)
        let when = reply.date.formatted(date: .omitted, time: .shortened)
        let preview = Bot.preview(of: reply)
        let folder = "/Users/me/work/Shop"
        let long = String(repeating: "測試 tests ", count: 600)
        let requests: [[String: Any]] = [
            ["asked": NSNull(), "text": ComponentBrief.request(reply: reply, asked: nil, folder: folder)],
            ["asked": "", "text": ComponentBrief.request(reply: reply, asked: "", folder: folder)],
            ["asked": "show me the tests", "text": ComponentBrief.request(reply: reply, asked: "show me the tests", folder: folder)],
            ["asked": long, "text": ComponentBrief.request(reply: reply, asked: long, folder: folder)],
        ]
        let answers = [
            "<component-brief>\n1. Purpose: tests\n</component-brief>",
            "Sure.\n<component-brief>  only this  </component-brief> trailing",
            "<component-brief>unclosed brief",
            "no tag at all\n",
            "<component-brief> \n </component-brief>",
            "",
            "<component-brief>" + String(repeating: "x", count: 9_000) + "</component-brief>",
        ]
        let briefs = answers.map { ["answer": $0, "brief": ComponentBrief.brief(from: $0) ?? NSNull()] as [String: Any] }
        let job = BriefJob(session: UUID(uuidString: "0B07E11C-0000-4000-8000-0000000000AB")!, model: .sonnet, effort: .high, folder: URL(filePath: folder), prompt: "p")
        let arguments = ClaudeAgentProcess.arguments(for: ComponentBrief.launch(for: job))

        // Switching a head's engine.
        let dividers: [String: Any] = [
            "handoffCodex": Bot.shownDivider(.engine(.codex), resumed: false),
            "handoffClaude": Bot.shownDivider(.engine(.claude), resumed: false),
            "switchedCodex": L("Switched to {0}", BotEngine.codex.displayName),
            "switchedClaude": L("Switched to {0}", BotEngine.claude.displayName),
            "toldCodex": RestartReason.engine(.codex).told,
        ]

        // Usage: the CLIs' lines read, spending added up, and the words around the limits.
        let seen = Date(timeIntervalSinceReferenceDate: 700_000_000)
        let claudeLines: [[String: Any]] = [
            ["type": "rate_limit_event", "rate_limit_info": ["status": "allowed", "unifiedWindows": ["five_hour": ["utilization": 0.47, "resetsAt": 1_800_000_000], "seven_day": ["utilization": 1.5]]]],
            ["type": "rate_limit_event", "rate_limit_info": ["status": "rejected", "rateLimitType": "seven_day", "resetsAt": 1_800_000_000]],
            ["type": "rate_limit_event", "rate_limit_info": ["status": "allowed", "rateLimitType": "five_hour", "utilization": -0.2, "resetsAt": 1_700_000_000.5]],
            ["type": "rate_limit_event", "rate_limit_info": ["status": "allowed", "rateLimitType": "five_hour"]],
            ["type": "result", "total_cost_usd": 0.25],
        ]
        let claudeLimits = claudeLines.map { line in
            ["line": line, "limits": RateLimits.parse(line, seen: seen).map(Self.limits) ?? NSNull()] as [String: Any]
        }
        let resultLines = [
            "{\"type\":\"result\",\"subtype\":\"success\",\"total_cost_usd\":0.125,\"usage\":{\"input_tokens\":10,\"output_tokens\":20,\"cache_creation_input_tokens\":30,\"cache_read_input_tokens\":40}}",
            "{\"type\":\"result\",\"subtype\":\"success\",\"total_cost_usd\":1}",
            "{\"type\":\"result\",\"subtype\":\"success\"}",
            "{\"type\":\"assistant\",\"total_cost_usd\":1}",
        ]
        let usages = resultLines.map { line -> [String: Any] in
            guard case let .usage(total, tokens) = StreamEvent.usage(in: line) else { return ["line": line, "usage": NSNull()] }
            return ["line": line, "usage": ["totalCost": total, "tokens": Self.tokens(tokens)]]
        }
        let snapshots: [[String: Any]] = [
            ["primary": ["usedPercent": 7, "windowDurationMins": 300, "resetsAt": 1_800_000_000], "secondary": ["usedPercent": 131, "windowDurationMins": 10080]],
            ["secondary": ["usedPercent": 5]],
            ["primary": ["windowDurationMins": 300]],
        ]
        let codexLimits = snapshots.map { ["snapshot": $0, "limits": Self.limits(CodexSession.rateLimits($0, seen: seen))] as [String: Any] }
        let breakdowns: [[String: Any]] = [
            ["inputTokens": 2000, "cachedInputTokens": 1500, "outputTokens": 250],
            ["inputTokens": 10, "cachedInputTokens": 50, "cacheWriteInputTokens": 7],
            [:],
        ]
        let codexTokens = breakdowns.map { ["breakdown": $0, "tokens": Self.tokens(CodexSession.tokens($0))] as [String: Any] }

        var spending = Spending(day: "2026-10-24")
        var steps: [[String: Any]] = []
        let adds: [(Double, TokenUsage, String, TimeInterval)] = [
            (0.5, TokenUsage(input: 1, output: 2, cacheWrite: 3, cacheRead: 4), "Main bot", 814_000_000),
            (0, TokenUsage(), "Shop", 814_000_100),
            (0, TokenUsage(input: 5), "Shop", 814_000_200),
            (0.25, TokenUsage(output: 9), "Main bot", 814_100_000),
        ]
        for (amount, tokens, bot, at) in adds {
            spending.add(amount, tokens: tokens, by: bot, on: Date(timeIntervalSinceReferenceDate: at))
            let encoded = try JSONEncoder().encode(spending)
            steps.append(["amount": amount, "tokens": Self.tokens(tokens), "bot": bot, "at": at, "spending": try JSONSerialization.jsonObject(with: encoded)])
        }

        let now = Date(timeIntervalSinceReferenceDate: 800_000_000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let windows: [(String, RateLimitWindow)] = [
            ("in2h13m", RateLimitWindow(used: 0.42, resetsAt: now.addingTimeInterval(2 * 3600 + 780), seen: now)),
            ("in8m", RateLimitWindow(used: 0.005, resetsAt: now.addingTimeInterval(7 * 60 + 1), seen: now.addingTimeInterval(-25 * 60))),
            ("in1m", RateLimitWindow(used: 0.995, resetsAt: now.addingTimeInterval(5), seen: now.addingTimeInterval(-3 * 3600))),
            ("today", RateLimitWindow(used: 0.18, resetsAt: now.addingTimeInterval(3600), seen: now.addingTimeInterval(-3 * 86400))),
            ("days", RateLimitWindow(used: 0.31, resetsAt: now.addingTimeInterval(3 * 86400 + 600), seen: now)),
            ("reset", RateLimitWindow(used: 0.9, resetsAt: now.addingTimeInterval(-1), seen: now)),
            ("noReset", RateLimitWindow(used: 0.5, resetsAt: nil, seen: now)),
        ]
        let texts = windows.map { label, window in
            ["label": label, "window": Self.window(window), "percent": RateLimitText.percent(window, now: now), "countdown": RateLimitText.countdown(window, now: now),
             "resetDay": RateLimitText.resetDay(window, now: now, calendar: calendar, locale: locale), "asOf": RateLimitText.asOf(window.seen, now: now)] as [String: Any]
        }
        let stale = [
            ["five": 0, "week": 0], ["five": -9 * 60, "week": -1], ["five": -10 * 60, "week": -1], ["five": -60, "week": -3600],
        ].map { offsets -> [String: Any] in
            let limits = RateLimits(fiveHour: RateLimitWindow(used: 0.1, resetsAt: nil, seen: now.addingTimeInterval(TimeInterval(offsets["five"]!))),
                                    week: RateLimitWindow(used: 0.2, resetsAt: nil, seen: now.addingTimeInterval(TimeInterval(offsets["week"]!))))
            return ["limits": Self.limits(limits), "staleSince": limits.staleSince(now: now)?.timeIntervalSinceReferenceDate ?? NSNull()]
        }
        let counts = [0, 812, 999, 1_000, 1_049, 1_050, 34_500, 999_949, 999_950, 1_000_000, 1_250_000, 12_345_678]
        let amounts = [0, 0.004, 0.005, 0.015, 1.234, 12.5, 100]

        // Result pages' preview cards: the card's data, the cards a message's links make, a spec from one, and
        // the app's own card (template and about.md). Paths are under `root`, which the test puts its own in for.
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-5c-preview-\(UUID().uuidString)").resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        for (file, text) in [("p/.bot/artifacts/report.html", "<!doctype html><h1>報告</h1><ul><li>One</li><li>Two</li></ul>"), ("p/.bot/artifacts/sub/chart.HTM", "<p>chart</p>"),
                             ("p/site/index.html", "<p>site</p>"), ("p/.bot/artifacts/notes.txt", "notes"), ("p/.bot/artifacts/My Report 2.html", "<p>two</p>")] {
            let url = root.appending(path: file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
        }
        try FileManager.default.createDirectory(at: root.appending(path: "p/.bot/artifacts/folder.html"), withIntermediateDirectories: true)
        let r = root.path
        let cardInputs = [
            "{\"path\":\"\(r)/p/.bot/artifacts/report.html\",\"title\":\"競品比較\"}",
            "{\"url\":\"file://\(r)/p/.bot/artifacts/sub/chart.HTM\"}",
            "{\"path\":\"\(r)/p/.bot/artifacts/missing.html\",\"title\":\"  \"}",
            "{\"path\":\"\(r)/p/.bot/artifacts/notes.txt\",\"shot\":\"x\"}",
            "{\"path\":\"\(r)/p/.bot/artifacts/folder.html\"}",
            "{\"path\":\"relative/x.html\",\"title\":\"Rel\"}",
            "{\"title\":\"none\"}",
            "[1, 2]",
            "not json",
        ]
        let cards = cardInputs.map { ["data": $0, "card": PagePreview.cardData($0)] }
        let linkTexts = [
            "See [競品比較](file://\(r)/p/.bot/artifacts/report.html) and [chart](file://\(r)/p/.bot/artifacts/sub/chart.HTM).",
            "[again](file://\(r)/p/.bot/artifacts/report.html) [twice](file://\(r)/p/.bot/artifacts/report.html) [site](file://\(r)/p/site/index.html) [gone](file://\(r)/p/.bot/artifacts/gone.html)",
            "[a](file://\(r)/p/.bot/artifacts/report.html) [b](file://\(r)/p/.bot/artifacts/sub/chart.HTM) [c](file://\(r)/p/.bot/artifacts/My%20Report%202.html) [d](file://\(r)/p/.bot/artifacts/report.html)",
            "[web](https://example.com/artifacts/x.html) [multi\nline](file://\(r)/p/.bot/artifacts/report.html)",
        ]
        let linked = linkTexts.map { ["text": $0, "cards": PagePreview.linkedCards(in: $0), "skipping": PagePreview.linkedCards(in: $0, skipping: [root.appending(path: "p/.bot/artifacts/report.html")])] as [String: Any] }
        let pageReply = ChatMessage(role: .bot, text: "Here: [競品比較](file://\(r)/p/.bot/artifacts/report.html)", date: date)
        let library = Workspace(root: root.appending(path: "ccb"), launcher: FakeLauncher().launcher) { profile, store in Bot(profile: profile, launcher: FakeLauncher().launcher, store: store) }.components
        let pageSpec = ComponentSpecs.draft(from: pageReply, bot: "Shop", folder: URL(filePath: "\(r)/p"), library: library, page: "\(r)/p/.bot/artifacts/My Report 2.html")
        let previews: [String: Any] = [
            "root": r, "cards": cards, "linked": linked,
            "spec": ["name": pageSpec.name, "page": pageSpec.page ?? NSNull(), "shownAs": pageSpec.shownAs ?? NSNull(), "existing": pageSpec.existing ?? NSNull(), "command": pageSpec.command ?? NSNull(),
                     "samples": pageSpec.samples.map { ["label": $0.label, "data": $0.data] }],
            "pages": ComponentSpecs.pages(of: pageReply, page: "\(r)/p/.bot/artifacts/My Report 2.html").map { ["path": $0.path, "text": $0.text] },
            "template": ComponentDefaults.previewTemplate, "about": ComponentDefaults.previewAbout, "olderTemplates": ComponentDefaults.olderPreviewTemplates,
        ]

        let export: [String: Any] = [
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopPhase5cGoldenExport.swift from the Swift app's own code.",
            "brief": ["when": when, "preview": preview, "folder": folder, "requests": requests, "briefs": briefs, "arguments": arguments,
                      "timeout": ComponentBrief.timeout, "limit": ComponentBrief.limit, "tools": ComponentBrief.tools, "denied": ComponentBrief.deniedTools],
            "engine": dividers,
            "preview": previews,
            "usage": ["now": now.timeIntervalSinceReferenceDate, "seen": seen.timeIntervalSinceReferenceDate, "claudeLimits": claudeLimits, "claudeUsage": usages,
                      "codexLimits": codexLimits, "codexTokens": codexTokens, "spending": steps, "texts": texts, "stale": stale,
                      "tokenCount": counts.map { ["count": $0, "text": Workspace.tokenCount($0)] }, "dollars": amounts.map { ["amount": $0, "text": Workspace.dollars($0)] }],
        ]
        let data = try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: URL(filePath: path))
    }

    static func window(_ window: RateLimitWindow) -> [String: Any] {
        ["used": window.used, "resetsAt": window.resetsAt?.timeIntervalSinceReferenceDate ?? NSNull(), "seen": window.seen.timeIntervalSinceReferenceDate]
    }

    static func limits(_ limits: RateLimits) -> [String: Any] {
        ["fiveHour": limits.fiveHour.map(window) ?? NSNull(), "week": limits.week.map(window) ?? NSNull()]
    }

    static func tokens(_ tokens: TokenUsage) -> [String: Any] {
        ["input": tokens.input, "output": tokens.output, "cacheWrite": tokens.cacheWrite, "cacheRead": tokens.cacheRead]
    }
}
