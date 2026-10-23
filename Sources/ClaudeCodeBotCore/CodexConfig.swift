import Foundation

/// What Codex's own config (`~/.codex/config.toml`, or `$CODEX_HOME/config.toml`) says workers
/// start on when Botling names nothing: read only, for Settings → Engines and subagents. Only the
/// three keys it shows are read (top level, then the active `[profiles.<name>]` over them); the
/// rest of the file is never interpreted.
public struct CodexConfig: Equatable, Sendable {
    public var model: String?
    /// `model_reasoning_effort` as written (Codex may know levels Botling does not).
    public var effortName: String?
    /// `service_tier`: `priority` (or `fast`) is Fast.
    public var serviceTier: String?

    public init(model: String? = nil, effortName: String? = nil, serviceTier: String? = nil) {
        self.model = model
        self.effortName = effortName
        self.serviceTier = serviceTier
    }

    public var effort: EffortLevel? { effortName.flatMap(EffortLevel.init(rawValue:)) }

    /// Nil when the file names no tier.
    public var fast: Bool? { serviceTier.map { ["priority", "fast"].contains($0.lowercased()) } }

    /// Codex's home folder: `$CODEX_HOME`, else `~/.codex`.
    public static var home: URL {
        if let custom = ProcessInfo.processInfo.environment["CODEX_HOME"], !custom.isEmpty {
            return URL(filePath: (custom as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".codex")
    }

    /// The file in `home`; a missing or unreadable one says nothing.
    public static func load(home: URL = CodexConfig.home) -> CodexConfig {
        guard let text = try? String(contentsOf: home.appending(path: "config.toml"), encoding: .utf8) else { return CodexConfig() }
        return parse(text)
    }

    static let keys = ["model", "model_reasoning_effort", "service_tier"]

    public static func parse(_ text: String) -> CodexConfig {
        var top: [String: String] = [:]
        var profiles: [String: [String: String]] = [:]
        // nil: the top level; a profile's name inside `[profiles.<name>]`; "" any other table.
        var table: String?
        for raw in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let line = stripComment(String(raw)).trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            if line.hasPrefix("[") {
                let name = line.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
                let parts = name.split(separator: ".", maxSplits: 1).map { unquote(String($0).trimmingCharacters(in: .whitespaces)) }
                table = parts.count == 2 && parts[0] == "profiles" ? parts[1] : ""
                continue
            }
            guard let equals = line.firstIndex(of: "=") else { continue }
            let key = unquote(line[..<equals].trimmingCharacters(in: .whitespaces))
            guard keys.contains(key) || (table == nil && key == "profile") else { continue }
            guard let value = scalar(line[line.index(after: equals)...].trimmingCharacters(in: .whitespaces)) else { continue }
            switch table {
            case nil: top[key] = value
            case let name? where !name.isEmpty: profiles[name, default: [:]][key] = value
            default: break
            }
        }
        var values = top
        if let profile = top["profile"], let overrides = profiles[profile] {
            values.merge(overrides) { _, new in new }
        }
        return CodexConfig(model: values["model"], effortName: values["model_reasoning_effort"], serviceTier: values["service_tier"])
    }

    /// The line without a `#` comment outside quotes.
    private static func stripComment(_ line: String) -> String {
        var quote: Character?
        var escaped = false
        for (offset, character) in line.enumerated() {
            if escaped { escaped = false; continue }
            if quote == "\"", character == "\\" { escaped = true; continue }
            if let open = quote {
                if character == open { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == "#" {
                return String(line.prefix(offset))
            }
        }
        return line
    }

    private static func unquote(_ text: String) -> String {
        if text.count >= 2, let first = text.first, first == text.last, first == "\"" || first == "'" {
            return String(text.dropFirst().dropLast())
        }
        return text
    }

    /// A string (basic or literal) or a bare word; nil for nothing, arrays and tables.
    private static func scalar(_ text: String) -> String? {
        guard !text.isEmpty, !text.hasPrefix("["), !text.hasPrefix("{") else { return nil }
        if text.hasPrefix("\"") || text.hasPrefix("'") {
            let value = unquote(text)
            guard value != text else { return nil }
            return text.hasPrefix("\"") ? value.replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\\\", with: "\\") : value
        }
        return text
    }
}

extension CodexWorkerDefaults {
    /// Botling's own choice when you stop following Codex's config: what the config says now,
    /// so turning the switch off changes nothing until you pick something.
    public static func seeded(from config: CodexConfig) -> CodexWorkerDefaults {
        CodexWorkerDefaults(model: config.model, effort: config.effort, fast: config.fast ?? false)
    }
}

/// What a Codex worker starts on, said in full for Settings ("In effect: …").
public struct EffectiveCodexWorker: Equatable, Sendable {
    /// Nil: Codex's default model.
    public var model: String?
    public var effort: EffortLevel?
    /// An effort Botling has no name for, as the config writes it.
    public var effortName: String?
    public var fast: Bool
}

extension AppSettings {
    /// What workers start on with these settings and this config, for a bot that names no
    /// Codex model or effort of its own.
    public func effectiveCodexWorker(config: CodexConfig) -> EffectiveCodexWorker {
        let own = appliedCodexWorkerDefaults
        return EffectiveCodexWorker(
            model: own.model ?? config.model,
            effort: own.effort ?? config.effort,
            effortName: own.effort == nil ? config.effortName : nil,
            fast: own.fast ?? config.fast ?? false
        )
    }
}
