import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The app's own words in five languages (Settings → General → Language), and the language
/// reaching the chat page and what bots are told.
@MainActor
struct LocalizationTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-language-\(UUID().uuidString)")

    // MARK: The tables

    @Test func everyWordHasAllFiveLanguages() {
        var seen: [String: String] = [:]
        var rows = 0
        for table in L10n.tables {
            for (english, others) in table.rows {
                rows += 1
                #expect(!english.trimmingCharacters(in: .whitespaces).isEmpty, "an empty key in \(table.name)")
                #expect(seen[english] == nil, "\"\(english)\" is in both \(seen[english] ?? "") and \(table.name)")
                seen[english] = table.name
                #expect(others.count == L10n.translated.count, "\"\(english)\" (\(table.name)) has \(others.count) translations")
                let marks = L10n.placeholders(in: english)
                for (language, text) in zip(L10n.translated, others) {
                    #expect(!text.trimmingCharacters(in: .whitespaces).isEmpty, "\"\(english)\" has no \(language.rawValue)")
                    #expect(L10n.placeholders(in: text) == marks, "\"\(english)\" in \(language.rawValue) keeps \(marks.sorted()), has \"\(text)\"")
                }
            }
        }
        #expect(rows > 0)
    }

    /// Every `L("…")` in the app's sources names a word the tables have, so none shows in English
    /// by mistake (a word built with \( ) instead of {0} would never be found).
    @Test func everyWordTheAppShowsIsInTheTables() throws {
        let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources").standardizedFileURL
        let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" && !$0.path.contains("/Strings/") && $0.lastPathComponent != "Localization.swift" }
        #expect(files.count > 20)
        var used = 0
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for key in Self.literals(in: text) {
                used += 1
                #expect(!key.contains("\\("), "\(file.lastPathComponent): L(\"\(key)\") interpolates; use {0}")
                #expect(L10n.lookup[key] != nil, "\(file.lastPathComponent): L(\"\(key)\") is in no table")
            }
        }
        #expect(used > 0)
    }

    /// The string literals right after `L(` in Swift source, unescaped.
    static func literals(in source: String) -> [String] {
        var keys: [String] = []
        var rest = source[...]
        while let range = rest.range(of: "L(\"") {
            let before = rest[..<range.lowerBound].last
            rest = rest[range.upperBound...]
            // `L(` itself, not the end of another name (`URL("…")`).
            if let before, before.isLetter || before.isNumber || before == "_" { continue }
            var key = ""
            var escaped = false
            var end = rest.startIndex
            for index in rest.indices {
                let character = rest[index]
                if escaped {
                    switch character {
                    case "n": key.append("\n")
                    case "t": key.append("\t")
                    case "(": key.append("\\(")
                    default: key.append(character)
                    }
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    end = index
                    break
                } else {
                    key.append(character)
                }
                end = index
            }
            keys.append(key)
            rest = rest[end...]
        }
        return keys
    }

    // MARK: Looking words up

    @Test func wordsComeInTheLanguageWithTheirValues() {
        #expect(L10n.text("System default ({0})", ["日本語"], in: .english) == "System default (日本語)")
        #expect(L10n.text("System default ({0})", ["English"], in: .traditionalChinese) == "系統預設（English）")
        #expect(L10n.text("Language", in: .japanese) == "言語")
        #expect(L10n.text("Language", in: .korean) == "언어")
        #expect(L10n.text("Language", in: .simplifiedChinese) == "语言")
        // A word no table has stays English.
        #expect(L10n.text("Not a word {0}", [3], in: .japanese) == "Not a word 3")
        // Tests and anything not told see English.
        #expect(L10n.language == .english)
        #expect(L("Language") == "Language")
    }

    @Test func theDefaultFollowsTheMacsPreferredLanguagesElseEnglish() {
        #expect(AppLanguage.preferred(["zh-Hant-TW", "en-US"]) == .traditionalChinese)
        #expect(AppLanguage.preferred(["zh-TW"]) == .traditionalChinese)
        #expect(AppLanguage.preferred(["zh-HK"]) == .traditionalChinese)
        #expect(AppLanguage.preferred(["zh-Hans-CN"]) == .simplifiedChinese)
        #expect(AppLanguage.preferred(["zh-CN"]) == .simplifiedChinese)
        #expect(AppLanguage.preferred(["zh"]) == .simplifiedChinese)
        #expect(AppLanguage.preferred(["ja-JP"]) == .japanese)
        #expect(AppLanguage.preferred(["ko_KR"]) == .korean)
        #expect(AppLanguage.preferred(["fr-FR", "de-DE", "ja-JP"]) == .japanese)
        #expect(AppLanguage.preferred(["fr-FR", "de-DE"]) == .english)
        #expect(AppLanguage.preferred([]) == .english)

        var settings = AppSettings()
        #expect(settings.languageChoice == nil)
        #expect(settings.language(preferred: ["ko-KR"]) == .korean)
        settings.languageChoice = .simplifiedChinese
        #expect(settings.language(preferred: ["ko-KR"]) == .simplifiedChinese)
        #expect(AppLanguage.allCases.map(\.nativeName) == ["English", "繁體中文", "简体中文", "日本語", "한국어"])
    }

    @Test func snapshotsCanAskForALanguage() {
        #expect(HeadlessRun.language(environment: [:], arguments: ["app", "--snapshot", "Main", "x.png", "--language", "ja"]) == .japanese)
        #expect(HeadlessRun.language(environment: ["CCB_LANGUAGE": "zh-Hant"], arguments: ["app"]) == .traditionalChinese)
        #expect(HeadlessRun.language(environment: ["CCB_LANGUAGE": "zh-TW"], arguments: ["app"]) == .traditionalChinese)
        #expect(HeadlessRun.language(environment: [:], arguments: ["app"]) == nil)
    }

    // MARK: What bots are told

    @Test func botsReplyInTheChosenLanguageUnlessTheUserWritesInAnother() {
        let profile = BotProfile.manager(name: "garden", avatar: "square", folder: URL(filePath: "/p/garden"))
        let japanese = BotPrompts(profile: profile, language: .japanese).system
        #expect(japanese.contains("Reply in Japanese by default: it is the language the user chose for the app. When the user writes to you in another language, reply in theirs (match the language of their latest message)."))
        #expect(!japanese.contains("Reply in the user's language"))
        #expect(BotPrompts(profile: .main(home: root), language: .traditionalChinese).system.contains("Reply in Traditional Chinese (as used in Taiwan) by default"))
        #expect(BotPrompts(profile: profile).system.contains("Reply in English by default"))
        let team = TeamPrompts.system(TeamSpec.defaults[0], folder: URL(filePath: "/r/run"), language: .korean)
        #expect(team.contains("Reply in Korean by default"))
    }

    @Test func theLanguageReachesThePageAndTheBriefingAndAwakeBotsHearOfIt() async throws {
        defer { L10n.language = .english }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let bot = workspace.mainBot
        bot.send("hi")
        await eventually { fake.agents.count == 1 && !bot.isWorking }
        let first = try #require(fake.agents.first)

        workspace.setLanguage(.japanese)
        #expect(workspace.settings.languageChoice == .japanese)
        #expect(AppSettings.load(from: workspace.settingsURL).languageChoice == .japanese)
        #expect(workspace.language == .japanese)
        #expect(L10n.language == .japanese)

        // The chat page draws its own words in it.
        let payload = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }
        let object = try #require(JSONSerialization.jsonObject(with: Data(payload.json().utf8)) as? [String: Any])
        #expect(object["lang"] as? String == "ja")

        // A new session starts with it in its system prompt.
        #expect(bot.prompts.system.contains("Reply in Japanese by default"))
        // The awake one (its resumed session keeps the old prompt) hears it with its next message.
        bot.send("next")
        await eventually { first.sent.count >= 2 }
        let note = try #require(first.sent.last)
        #expect(note.hasPrefix("(App: The user changed the app's language to Japanese."))
        #expect(note.contains("Reply in Japanese by default"))

        // System default follows the Mac again.
        workspace.setLanguage(nil)
        #expect(AppSettings.load(from: workspace.settingsURL).languageChoice == nil)
        #expect(workspace.language == AppLanguage.preferred())
    }

    /// Words the app once decided by (permission choices, spec samples, routine times) are only
    /// shown now: they follow the language, and what they mean does not change with it.
    @Test func wordsTheAppNoLongerDecidesByAreTranslated() throws {
        defer { L10n.language = .english }
        L10n.language = .japanese
        let every = try #require(CronSchedule("15 8 * * *"))
        #expect(every.description == "毎日 08:15")
        #expect(every.everyDayTime?.hour == 8)
        #expect(ComponentSpec.Sample(.reply, data: "{}").label == "この返信")
        // A spec saved before samples had a kind is still known by its English label.
        let old = try JSONDecoder().decode(ComponentSpec.Sample.self, from: Data(#"{"label":"Test run","data":"{}"}"#.utf8))
        #expect(old.kind == .testRun)
    }

    @Test func anOlderSettingsFileMeansSystemDefault() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appending(path: "settings.json")
        try Data(#"{"developerMode":false}"#.utf8).write(to: url)
        #expect(AppSettings.load(from: url).languageChoice == nil)
        var settings = AppSettings()
        settings.languageChoice = .korean
        settings.save(to: url)
        #expect(AppSettings.load(from: url).languageChoice == .korean)
    }
    // MARK: Words the core makes

    /// Dividers, choices and names the app writes into chats follow the language; what the bot
    /// is told about the same restart stays English.
    @Test func coreWordsFollowTheLanguage() {
        defer { L10n.language = .english }
        L10n.language = .japanese
        #expect(Bot.shownDivider(.plugins, resumed: false) == L("Handoff → {0}", L("loading new plugins")))
        #expect(Bot.shownDivider(.effort(.high), resumed: true) == L("Restarted → {0}", L("{0} effort", EffortLevel.high.displayName)))
        #expect(Bot.shownDivider(.subagentModel(.opus), resumed: false) != Bot.shownDivider(.subagentModel(.opus), resumed: true))
        #expect(Bot.shownDivider(.plugins, resumed: false) != "Handoff → loading new plugins")
        // What the bot is told stays English whatever the app's language.
        #expect(RestartReason.effort(.high).told == "High effort")
        #expect(EffortLevel.xhigh.englishName == "Extra high")
        #expect(ResultPublishing.localOnly.displayName == "常にローカルの HTML ページ")
        #expect(SlashCommands.all.first?.about == "Claude Design を作って claude.ai のリンクを受け取る")
        L10n.language = .traditionalChinese
        #expect(Bot.noLongerNeeded == "已不需要")
        #expect(Pins.FloatMenu.full.label == "浮在角落（已有 2 個浮動中）")
        L10n.language = .english
        #expect(Bot.shownDivider(.mayRead("laas-copy"), resumed: false).contains("laas-copy"))
    }
}
