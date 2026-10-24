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
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopPromptGoldenExport.swift from the Swift app's own code (TZ=\(TimeZone.current.identifier), locale \(Locale.current.identifier)).",
            "timeZone": TimeZone.current.identifier,
            "locale": Locale.current.identifier,
            "prompts": prompts,
            "briefing": briefing,
            "notes": notes,
        ]
        try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys]).write(to: URL(filePath: path))
    }
}
