import Foundation

/// The languages ClaudeCodeBot's own words come in (Settings → General → Language). Bots reply
/// in it by default too (`BotPrompts.languageRule`).
public enum AppLanguage: String, Codable, CaseIterable, Sendable {
    case english = "en"
    case traditionalChinese = "zh-Hant"
    case simplifiedChinese = "zh-Hans"
    case japanese = "ja"
    case korean = "ko"

    /// Its name in itself, for the picker.
    public var nativeName: String {
        switch self {
        case .english: "English"
        case .traditionalChinese: "繁體中文"
        case .simplifiedChinese: "简体中文"
        case .japanese: "日本語"
        case .korean: "한국어"
        }
    }

    /// Its name as bots are told it.
    public var promptName: String {
        switch self {
        case .english: "English"
        case .traditionalChinese: "Traditional Chinese (as used in Taiwan)"
        case .simplifiedChinese: "Simplified Chinese"
        case .japanese: "Japanese"
        case .korean: "Korean"
        }
    }

    /// The first of the Mac's preferred languages (System Settings → Language & Region) that the
    /// app has, else English. "zh-TW", "zh-HK" and "zh-Hant-…" are Traditional Chinese; any other
    /// Chinese is Simplified.
    public static func preferred(_ languages: [String] = Locale.preferredLanguages) -> AppLanguage {
        for code in languages {
            let parts = code.replacingOccurrences(of: "_", with: "-").lowercased().split(separator: "-").map(String.init)
            switch parts.first {
            case "en": return .english
            case "ja": return .japanese
            case "ko": return .korean
            case "zh":
                let rest = Set(parts.dropFirst())
                return rest.contains("hant") || (!rest.contains("hans") && !rest.isDisjoint(with: ["tw", "hk", "mo"]))
                    ? .traditionalChinese : .simplifiedChinese
            default: continue
            }
        }
        return .english
    }
}

/// The app's own words in every `AppLanguage`. Each is written in English where it is used,
/// `L("Settings…")`, and that English is its key in the tables (`Strings/`); `{0}`, `{1}` stand
/// for the values given after it. Bot-written text, component content, paths and the user's own
/// data are never put through it.
public enum L10n {
    /// The language words are shown in now. The app sets it from Settings at launch and when it
    /// changes; tests and anything else not told see English.
    nonisolated(unsafe) public static var language: AppLanguage = .english

    /// English → its other languages, in `translated` order.
    typealias Table = KeyValuePairs<String, [String]>

    /// The order of each table row's translations.
    static let translated: [AppLanguage] = [.traditionalChinese, .simplifiedChinese, .japanese, .korean]

    /// Every table, by where its words are used.
    static let tables: [(name: String, rows: Table)] = [
        ("Common", commonStrings),
        ("App", appStrings),
        ("Settings", settingsStrings),
        ("Panels", panelStrings),
        ("Views", viewStrings),
        ("Core", coreStrings),
    ]

    /// All rows, English first then `translated`; the first row of a key wins.
    static let lookup: [String: [String]] = {
        var all: [String: [String]] = [:]
        for table in tables {
            for (english, others) in table.rows where all[english] == nil { all[english] = others }
        }
        return all
    }()

    /// `english` in `language`, its `{n}` filled with `values`. A missing word stays English.
    public static func text(_ english: String, _ values: [Any] = [], in language: AppLanguage = L10n.language) -> String {
        var text = english
        if language != .english, let others = lookup[english], let index = translated.firstIndex(of: language),
           index < others.count, !others[index].isEmpty {
            text = others[index]
        }
        for (index, value) in values.enumerated() {
            text = text.replacingOccurrences(of: "{\(index)}", with: "\(value)")
        }
        return text
    }

    /// The `{n}` marks in a string, for checking a translation keeps them all.
    static func placeholders(in text: String) -> Set<String> {
        var marks: Set<String> = []
        var rest = text[...]
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            let inside = rest[rest.index(after: open)..<close]
            if !inside.isEmpty, inside.allSatisfy(\.isNumber) { marks.insert(String(rest[open...close])) }
            rest = rest[rest.index(after: open)...]
        }
        return marks
    }
}

/// The app's own words in the language Settings has (see `L10n`): `L("Open {0}", name)`.
public func L(_ english: String, _ values: Any...) -> String {
    L10n.text(english, values)
}
