import Combine
import CryptoKit
import Foundation

/// Any JSON value: a setting's default or what you set it to.
public enum JSONValue: Codable, Equatable, Sendable {
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var bool: Bool? { if case let .bool(value) = self { value } else { nil } }
    public var string: String? { if case let .string(value) = self { value } else { nil } }
    public var number: Double? { if case let .number(value) = self { value } else { nil } }
}

/// A plugin's `package.json`: npm's format with a `ccb` field, like a VS Code extension.
public struct PluginManifest: Codable, Equatable, Sendable {
    public var name: String
    public var displayName: String?
    public var version: String
    public var description: String?
    public var license: String?
    public var engines: [String: String]?
    public var scripts: [String: String]?
    public var ccb: Extension?

    public struct Extension: Codable, Equatable, Sendable {
        public var permissions: [String]?
        /// The web part's bundled ES module, run in the chat page.
        public var web: String?
        /// The program part, run in the plugin host (P3).
        public var host: String?
        /// Stylesheets the web part needs.
        public var styles: [String]?
        /// A standard Claude Code plugin folder handed to bots with --plugin-dir (P4).
        public var claude: String?
        public var contributes: Contributes?
    }

    public struct Contributes: Codable, Equatable, Sendable {
        public var commands: [Command]?
        public var settings: [String: Setting]?
        /// A folder of components (`<name>/template.html` and `about.md`).
        public var components: String?
        /// Pages in the right column, drawn by the web part (`ccb.panels.register`).
        public var panels: [Panel]?
    }

    public struct Panel: Codable, Equatable, Sendable {
        public var id: String
        public var title: String
        /// An SF Symbol name for its button.
        public var icon: String?
    }

    public struct Command: Codable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var key: String?
    }

    public struct Setting: Codable, Equatable, Sendable {
        /// boolean, enum, string or number.
        public var type: String
        public var `default`: JSONValue?
        public var title: String
        public var options: [String]?
        /// Kept in the keychain, never shown in ClaudeCodeBot or sent to the chat page.
        public var secret: Bool?
        /// For a secret: the environment variable bots get it in (for MCP servers' .mcp.json).
        public var env: String?
    }

    public var title: String { displayName ?? name }
}

/// One plugin found in the plugin library or shipped with ClaudeCodeBot.
public struct InstalledPlugin: Identifiable, Equatable, Sendable {
    public var manifest: PluginManifest
    public var folder: URL
    /// Shipped with ClaudeCodeBot (read-only); a plugin of the same name in the library replaces it.
    public var builtIn: Bool
    public var enabled: Bool
    /// Why its web part was turned off, when it broke.
    public var failure: String?
    /// Its newest version broke, so the last one that worked is still running.
    public var usingPrevious = false
    /// Installed from outside (git, npm, an archive, a folder): where from.
    public var installedFrom: String?

    public var id: String { manifest.name }
    public var name: String { manifest.name }

    public func url(_ path: String) -> URL { folder.appending(path: path) }
}

/// What the chat page needs to run a plugin's web part (matches the page's `PluginSpec`).
public struct WebPluginSpec: Encodable, Equatable {
    public var name: String
    public var version: String
    public var source: String
    public var styles: [String]
    public var settings: [String: JSONValue]
    public var commands: [PluginManifest.Command]
}

/// Plugins for ClaudeCodeBot itself: `~/.claudecodebot/plugins/<name>/` (the plugin library) plus the ones shipped
/// inside the app. Keeps which are on, their settings, and which broke, in `~/.claudecodebot/plugins.json`.
/// Watches the files so an edited plugin reloads without restarting ClaudeCodeBot.
@MainActor
public final class PluginRegistry: ObservableObject {
    @Published public private(set) var plugins: [InstalledPlugin] = []
    /// Folders that look like plugins but could not be read, with why.
    @Published public private(set) var problems: [String: [String]] = [:]
    /// Bumps whenever a plugin's files, its on/off state or its settings change.
    @Published public private(set) var revision = 0

    public let library: URL
    public let builtIns: URL?
    /// A plugin's web part broke or it said something: the main bot's chat shows it.
    public var onNotice: ((_ text: String) -> Void)?
    /// A plugin broke (check failed, threw on load): Maintainer should fix it.
    public var onBroken: ((_ plugin: String, _ problem: String) -> Void)?
    /// A plugin's version changed on disk (hot reload), with the version it had.
    public var onUpdated: ((_ plugin: InstalledPlugin, _ from: String) -> Void)?
    public let git: PluginLibraryGit
    /// Web parts that loaded fine: what a broken new version falls back to.
    private var lastGood: [String: WebPluginSpec] = [:]
    /// What was last handed to the page, to remember once it says it loaded.
    private var lastSent: [String: WebPluginSpec] = [:]
    private var reportedProblems: [String: [String]] = [:]
    private var state: State
    private var fingerprints: [String: String] = [:]
    /// What each plugin's Claude part holds (a hash of its files' paths and bytes), by plugin,
    /// for the fingerprint it was read at.
    private var claudeContents: [String: (fingerprint: String, hash: String)] = [:]
    private var watchTask: Task<Void, Never>?

    struct State: Codable {
        var disabled: [String] = []
        var settings: [String: [String: JSONValue]] = [:]
        /// Broken plugins, with the fingerprint of the files that broke, so a fixed version is
        /// tried again.
        var failures: [String: Failure] = [:]
        /// Plugins installed from outside, with their source.
        var installed: [String: String]? = [:]
    }

    struct Failure: Codable {
        var message: String
        var fingerprint: String
    }

    public let secrets: SecretStore

    public init(
        library: URL,
        builtIns: URL?,
        validateClaudePart: ((URL) async -> String?)? = nil,
        git: PluginLibraryGit? = nil,
        secrets: SecretStore = KeychainSecretStore()
    ) {
        self.library = library
        self.secrets = secrets
        self.git = git ?? PluginLibraryGit(folder: library)
        self.builtIns = builtIns
        self.validateClaudePart = validateClaudePart
        try? FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        state = (try? JSONDecoder().decode(State.self, from: Data(contentsOf: library.deletingLastPathComponent().appending(path: "plugins.json")))) ?? State()
        rescan()
    }

    private var stateURL: URL { library.deletingLastPathComponent().appending(path: "plugins.json") }

    private func saveState() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(state).write(to: stateURL, options: .atomic)
    }

    public func plugin(_ name: String) -> InstalledPlugin? {
        plugins.first { $0.name == name }
    }

    // MARK: Changing

    public func setEnabled(_ name: String, _ enabled: Bool) {
        state.disabled.removeAll { $0 == name }
        if !enabled { state.disabled.append(name) }
        // Turning it back on gives a broken plugin another try.
        if enabled { state.failures[name] = nil }
        saveState()
        rescan(force: true)
    }

    public func setting(_ plugin: String, _ key: String) -> JSONValue? {
        state.settings[plugin]?[key] ?? self.plugin(plugin)?.manifest.ccb?.contributes?.settings?[key]?.default
    }

    public func set(_ plugin: String, _ key: String, to value: JSONValue) {
        state.settings[plugin, default: [:]][key] = value
        saveState()
        revision += 1
    }

    /// The chat page reported that a plugin's web part threw: turn it off until its files change.
    public func markFailed(_ name: String, message: String) {
        guard state.failures[name]?.fingerprint != fingerprints[name] else { return }
        state.failures[name] = Failure(message: message, fingerprint: fingerprints[name] ?? "")
        saveState()
        rescan(force: true)
        let title = plugin(name)?.manifest.title ?? name
        if plugin(name)?.usingPrevious == true {
            onNotice?(L("Plugin \"{0}\": the new version failed; using the previous version and handed it to Maintainer: {1}", title, message))
        } else {
            onNotice?(L("Plugin \"{0}\" failed and was disabled for now: {1}", title, message))
        }
        onBroken?(name, message)
    }

    /// The page loaded this plugin's web part without trouble: remember it as the one to fall
    /// back to.
    public func markLoaded(_ name: String) {
        guard let spec = lastSent[name] else { return }
        lastGood[name] = spec
    }

    // MARK: Versions (git)

    /// The library folder of a plugin that git keeps (not one shipped inside the app).
    private func gitPath(_ name: String) -> String? {
        guard let plugin = plugin(name), !plugin.builtIn else { return nil }
        return plugin.folder.lastPathComponent
    }

    /// Whether git has an earlier version, asked in the background (false until it answers).
    @Published private var history: [String: Bool] = [:]

    public func hasPrevious(_ name: String) -> Bool {
        if let known = history[name] { return known }
        guard let path = gitPath(name) else { return false }
        let git = git
        Task { [weak self] in
            let answer = await blocking { git.hasPrevious(path) }
            self?.history[name] = answer
        }
        return false
    }

    /// Back to the version before its last change (a new commit); it then hot-reloads.
    @discardableResult
    public func revert(_ name: String) async -> String? {
        guard let path = gitPath(name) else { return L("Built-in plugins have no version history.") }
        let git = git
        let label = plugin(name)?.manifest.title ?? name
        let problem = await blocking { git.revert(path, label: label) }
        state.failures[name] = nil
        saveState()
        rescan(force: true)
        return problem
    }

    /// Takes a plugin out of the library (git history keeps it).
    @discardableResult
    public func remove(_ name: String) async -> String? {
        guard let path = gitPath(name) else { return L("Built-in plugins can't be removed, only turned off.") }
        let git = git
        let label = plugin(name)?.manifest.title ?? name
        let problem = await blocking { git.remove(path, label: label) }
        rescan(force: true)
        return problem
    }

    // MARK: Reading

    /// Every enabled plugin's web part, ready for `ccb.setPlugins`.
    public func webSpecs() -> [WebPluginSpec] {
        plugins.compactMap { plugin in
            guard plugin.enabled else { return nil }
            if plugin.failure != nil {
                // Broken new version: keep running the last one that worked.
                guard var previous = lastGood[plugin.name] else { return nil }
                previous.settings = resolvedSettings(plugin)
                return previous
            }
            guard let web = plugin.manifest.ccb?.web,
                  let source = try? String(contentsOf: plugin.url(web), encoding: .utf8) else { return nil }
            let settings = resolvedSettings(plugin)
            let spec = WebPluginSpec(
                name: plugin.name,
                version: plugin.manifest.version,
                source: source,
                styles: (plugin.manifest.ccb?.styles ?? []).map { plugin.url($0).absoluteString },
                settings: settings,
                commands: plugin.manifest.ccb?.contributes?.commands ?? []
            )
            lastSent[plugin.name] = spec
            return spec
        }
    }

    /// Every enabled plugin's program part, for the plugin host. Each keeps data in
    /// `<dataRoot>/<name>/`.
    public func hostSpecs(dataRoot: URL) -> [PluginHostClient.Spec] {
        plugins.compactMap { plugin in
            guard plugin.enabled, plugin.failure == nil, let host = plugin.manifest.ccb?.host else { return nil }
            var settings = resolvedSettings(plugin)
            // The program part (not the chat page) gets secrets too.
            for (key, setting) in plugin.manifest.ccb?.contributes?.settings ?? [:] where setting.secret == true {
                settings[key] = secrets.get(plugin: plugin.name, key: key).map(JSONValue.string) ?? .null
            }
            return PluginHostClient.Spec(
                name: plugin.name,
                version: plugin.manifest.version,
                main: plugin.url(host).path,
                fingerprint: fingerprints[plugin.name] ?? "",
                settings: settings,
                storageDir: dataRoot.appending(path: plugin.name).path
            )
        }
    }

    private func resolvedSettings(_ plugin: InstalledPlugin) -> [String: JSONValue] {
        var settings: [String: JSONValue] = [:]
        for (key, setting) in plugin.manifest.ccb?.contributes?.settings ?? [:] where setting.secret != true {
            settings[key] = state.settings[plugin.name]?[key] ?? setting.default ?? .null
        }
        return settings
    }

    /// When the plugin host reported each plugin breaking, for "3 times in 10 minutes".
    private var crashes: [String: [Date]] = [:]

    /// A plugin's program part threw or brought the host down. The third time within 10
    /// minutes it is turned off; a load failure turns it off at once.
    public func recordHostFailure(_ name: String, message: String, fatal: Bool = false, now: Date = Date()) {
        guard plugin(name) != nil else { return }
        let recent = (crashes[name] ?? []).filter { now.timeIntervalSince($0) < 600 } + [now]
        crashes[name] = recent
        if fatal || recent.count >= 3 {
            crashes[name] = nil
            markFailed(name, message: message)
        }
    }

    /// Component folders from enabled plugins.
    public func componentFolders() -> [URL] {
        plugins.compactMap { plugin in
            guard plugin.enabled, let folder = plugin.manifest.ccb?.contributes?.components else { return nil }
            return plugin.url(folder)
        }
    }

    // MARK: Watching

    public func startWatching(every interval: TimeInterval = 1.5) {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.rescan()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    /// Reads every plugin again; bumps `revision` if anything that matters changed.
    public func rescan(force: Bool = false) {
        var found: [String: InstalledPlugin] = [:]
        var problems: [String: [String]] = [:]
        var prints: [String: String] = [:]
        for (root, builtIn) in [(builtIns, true), (library, false)] {
            guard let root else { continue }
            let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            for folder in folders where FileManager.default.fileExists(atPath: folder.appending(path: "package.json").path) {
                switch Self.load(folder) {
                case let .success(manifest):
                    let print = Self.fingerprint(folder, manifest)
                    prints[manifest.name] = print
                    let failure = state.failures[manifest.name].flatMap { $0.fingerprint == print ? $0.message : nil }
                    let fallback = failure != nil && lastGood[manifest.name] != nil
                    found[manifest.name] = InstalledPlugin(
                        manifest: manifest,
                        folder: folder,
                        builtIn: builtIn,
                        enabled: !state.disabled.contains(manifest.name) && (failure == nil || fallback),
                        failure: failure,
                        usingPrevious: fallback,
                        installedFrom: builtIn ? nil : state.installed?[manifest.name]
                    )
                    reportedProblems[folder.lastPathComponent] = nil
                case let .failure(error):
                    problems[folder.lastPathComponent] = error.problems
                    // A plugin that was fine before keeps running its last version.
                    if let old = plugins.first(where: { $0.folder.standardizedFileURL == folder.standardizedFileURL }) {
                        found[old.name] = old
                        prints[old.name] = fingerprints[old.name]
                    }
                    if reportedProblems[folder.lastPathComponent] != error.problems {
                        reportedProblems[folder.lastPathComponent] = error.problems
                        if !fingerprints.isEmpty {
                            onBroken?(folder.lastPathComponent, "Check failed: " + error.problems.joined(separator: "; "))
                        }
                    }
                }
            }
        }
        let sorted = found.values.sorted { ($0.builtIn ? 0 : 1, $0.name) < ($1.builtIn ? 0 : 1, $1.name) }
        let changed = force || prints != fingerprints || sorted != plugins
        for plugin in sorted {
            if let old = plugins.first(where: { $0.name == plugin.name }), old.manifest.version != plugin.manifest.version {
                onUpdated?(plugin, old.manifest.version)
            }
        }
        if prints != fingerprints || force { history = [:] }
        fingerprints = prints
        if sorted != plugins { plugins = sorted }
        if problems != self.problems { self.problems = problems }
        if changed { revision += 1 }
        checkClaudeParts()
    }

    /// What decides whether a plugin reloads: its manifest and the files it names.
    nonisolated static func fingerprint(_ folder: URL, _ manifest: PluginManifest) -> String {
        var files = ["package.json", manifest.ccb?.web, manifest.ccb?.host].compactMap { $0 } + (manifest.ccb?.styles ?? [])
        files += claudeFiles(folder, manifest)
        return files.map { file -> String in
            let attributes = try? FileManager.default.attributesOfItem(atPath: folder.appending(path: file).path)
            let date = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            let size = (attributes?[.size] as? Int) ?? -1
            return "\(file):\(date):\(size)"
        }.joined(separator: "|")
    }

    /// Every file in a plugin's Claude part, relative to the plugin folder.
    nonisolated static func claudeFiles(_ folder: URL, _ manifest: PluginManifest) -> [String] {
        guard let claude = manifest.ccb?.claude,
              let walker = FileManager.default.enumerator(at: folder.appending(path: claude), includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        let base = folder.standardizedFileURL.path + "/"
        return walker.compactMap { item -> String? in
            guard let url = item as? URL, (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
            return url.standardizedFileURL.path.replacingOccurrences(of: base, with: "")
        }.sorted()
    }

    // MARK: Claude parts

    /// Runs `claude plugin validate --strict` on a Claude part: nil when it passes, else why not.
    /// Unset (tests), every Claude part counts as valid.
    public var validateClaudePart: ((URL) async -> String?)?
    /// Results by plugin, for the files they were run on.
    private var claudeChecks: [String: (fingerprint: String, problem: String?)] = [:]
    private var claudeChecking: Set<String> = []

    /// Claude parts of enabled plugins that passed the check, for `--plugin-dir`.
    public func claudeDirectories() -> [URL] {
        plugins.compactMap { plugin in
            guard plugin.enabled, let claude = plugin.manifest.ccb?.claude,
                  let check = claudeChecks[plugin.name], check.fingerprint == fingerprints[plugin.name], check.problem == nil else { return nil }
            return plugin.url(claude)
        }
    }

    /// The Claude parts `claudeDirectories()` gives, each with a hash of what its files hold: a
    /// session started with a different stamp has older skills, agents or MCP servers. A file
    /// written again with the same bytes (only its date changed), or a change outside the Claude
    /// part (package.json, the web part), leaves the stamp as it was: no bot restarts for it.
    public func claudeStamp() -> [String] {
        plugins.compactMap { plugin in
            guard plugin.enabled, let claude = plugin.manifest.ccb?.claude, let print = fingerprints[plugin.name],
                  let check = claudeChecks[plugin.name], check.fingerprint == print, check.problem == nil else { return nil }
            return plugin.url(claude).standardizedFileURL.path + "#" + claudeContent(of: plugin, claude: claude, fingerprint: print)
        }
    }

    private func claudeContent(of plugin: InstalledPlugin, claude: String, fingerprint: String) -> String {
        if let known = claudeContents[plugin.name], known.fingerprint == fingerprint { return known.hash }
        let hash = Self.contentHash(plugin.folder, Self.claudeFiles(plugin.folder, plugin.manifest))
        claudeContents[plugin.name] = (fingerprint, hash)
        return hash
    }

    /// A hash of a text (hex SHA-256).
    nonisolated static func contentHash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// A hash of `files` (relative to `folder`): their paths and bytes.
    nonisolated static func contentHash(_ folder: URL, _ files: [String]) -> String {
        var hasher = SHA256()
        for file in files {
            hasher.update(data: Data(file.utf8))
            hasher.update(data: Data([0]))
            hasher.update(data: (try? Data(contentsOf: folder.appending(path: file))) ?? Data())
            hasher.update(data: Data([0]))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// A Claude part changed and is still waiting for (or in) its check: it is left out of
    /// `claudeDirectories()` only until the check is done.
    public var checkingClaudeParts: Bool {
        plugins.contains { plugin in
            guard plugin.enabled, plugin.manifest.ccb?.claude != nil, let print = fingerprints[plugin.name] else { return false }
            return claudeChecks[plugin.name]?.fingerprint != print
        }
    }

    /// Tools bots may use from plugins' MCP servers (`mcp__plugin_<plugin>_<server>`), for the
    /// Claude parts that passed their check.
    public func claudeTools() -> [String] {
        plugins.flatMap { plugin -> [String] in
            guard let claude = plugin.manifest.ccb?.claude,
                  claudeDirectories().contains(where: { $0.standardizedFileURL == plugin.url(claude).standardizedFileURL }) else { return [] }
            let manifest = plugin.url("\(claude)/.claude-plugin/plugin.json")
            let name = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: manifest))) as? [String: Any])?["name"] as? String ?? plugin.name
            return PluginInstaller.mcpServers(of: plugin.folder, plugin.manifest).map { "mcp__plugin_\(name)_\($0)" }
        }
    }

    // MARK: Secrets

    public func secret(_ plugin: String, _ key: String) -> String? {
        secrets.get(plugin: plugin, key: key)
    }

    public func setSecret(_ plugin: String, _ key: String, to value: String?) {
        secrets.set(plugin: plugin, key: key, value: value)
        revision += 1
    }

    /// Secrets that declare an `env` name, for bots' processes (MCP servers read them).
    public func secretEnvironment() -> [String: String] {
        var environment: [String: String] = [:]
        for plugin in plugins where plugin.enabled {
            for (key, setting) in plugin.manifest.ccb?.contributes?.settings ?? [:] where setting.secret == true {
                if let name = setting.env, let value = secrets.get(plugin: plugin.name, key: key) { environment[name] = value }
            }
        }
        return environment
    }

    // MARK: Installing

    /// Puts a fetched plugin into the library (replacing one of the same name) and commits it.
    @discardableResult
    public func install(_ proposal: InstallProposal) async -> String? {
        guard proposal.problems.isEmpty else { return proposal.problems.joined(separator: "; ") }
        if let existing = plugin(proposal.manifest.name), existing.builtIn == false, state.installed?[existing.name] == nil {
            return L("The plugin library already has its own \"{0}\"; it won't be replaced by an outside one.", existing.name)
        }
        let target = library.appending(path: proposal.manifest.name)
        let git = git
        let label = "\(proposal.manifest.name) \(proposal.manifest.version)"
        let source = proposal.source
        let problem: String? = await blocking {
            let files = FileManager.default
            try? files.removeItem(at: target)
            do {
                try files.copyItem(at: proposal.folder, to: target)
            } catch {
                return L("Couldn't put it into the plugin library: {0}", error.localizedDescription)
            }
            git.run(["add", "-A", "--", proposal.manifest.name])
            git.run(["commit", "-q", "-m", "Install \(label) (\(source))", "--", proposal.manifest.name])
            return nil
        }
        guard problem == nil else { return problem }
        if state.installed == nil { state.installed = [:] }
        state.installed?[proposal.manifest.name] = proposal.source
        state.failures[proposal.manifest.name] = nil
        saveState()
        rescan(force: true)
        return nil
    }

    /// Panels from enabled plugins with a web part, in order.
    public func panels() -> [(plugin: InstalledPlugin, panel: PluginManifest.Panel)] {
        plugins.flatMap { plugin in
            plugin.enabled && plugin.manifest.ccb?.web != nil
                ? (plugin.manifest.ccb?.contributes?.panels ?? []).map { (plugin, $0) } : []
        }
    }

    /// Agent files (`claude/agents/*.md`) of enabled plugins: the temporary teams.
    public func agentFiles() -> [(plugin: String, url: URL)] {
        plugins.flatMap { plugin -> [(plugin: String, url: URL)] in
            guard plugin.enabled, let claude = plugin.manifest.ccb?.claude else { return [] }
            let folder = plugin.url(claude).appending(path: "agents")
            let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            return files.filter { $0.pathExtension == "md" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.map { (plugin.name, $0) }
        }
    }

    /// Checks Claude parts that are new or changed since their last check.
    private func checkClaudeParts() {
        for plugin in plugins where plugin.enabled {
            guard let claude = plugin.manifest.ccb?.claude, let print = fingerprints[plugin.name],
                  claudeChecks[plugin.name]?.fingerprint != print, !claudeChecking.contains(plugin.name) else { continue }
            guard let validate = validateClaudePart else {
                claudeChecks[plugin.name] = (print, nil)
                continue
            }
            claudeChecking.insert(plugin.name)
            let name = plugin.name
            let title = plugin.manifest.title
            let folder = plugin.url(claude)
            Task { [weak self] in
                let problem = await validate(folder)
                guard let self else { return }
                claudeChecking.remove(name)
                claudeChecks[name] = (print, problem)
                if let problem { onNotice?(L("The Claude part of plugin \"{0}\" failed the check and is not loaded for now: {1}", title, problem)) }
                revision += 1
                // The files may have changed again while it was checked.
                checkClaudeParts()
            }
        }
    }

    // MARK: Checking

    public struct CheckError: Error {
        public var problems: [String]
    }

    /// Reads and checks a plugin folder (`ccb plugin check`, the parts that need no browser).
    nonisolated public static func load(_ folder: URL) -> Result<PluginManifest, CheckError> {
        let problems = check(folder)
        guard problems.isEmpty,
              let data = try? Data(contentsOf: folder.appending(path: "package.json")),
              let manifest = try? JSONDecoder().decode(PluginManifest.self, from: data) else {
            return .failure(CheckError(problems: problems.isEmpty ? ["package.json could not be read."] : problems))
        }
        return .success(manifest)
    }

    /// The ClaudeCodeBot version plugins are written against.
    nonisolated public static let apiVersion = (major: 2, minor: 0)

    nonisolated public static func check(_ folder: URL) -> [String] {
        let packageURL = folder.appending(path: "package.json")
        guard let data = try? Data(contentsOf: packageURL) else { return ["package.json not found."] }
        let manifest: PluginManifest
        do {
            manifest = try JSONDecoder().decode(PluginManifest.self, from: data)
        } catch {
            return ["package.json is malformed: \(Self.describe(error))"]
        }
        var problems: [String] = []
        if manifest.name.range(of: #"^[a-z0-9][a-z0-9._-]*$"#, options: .regularExpression) == nil {
            problems.append("name \"\(manifest.name)\" may only use lowercase letters, digits, - . _.")
        }
        if manifest.version.range(of: #"^\d+\.\d+\.\d+"#, options: .regularExpression) == nil {
            problems.append("version \"\(manifest.version)\" must be semver, for example 1.0.0.")
        }
        guard let range = manifest.engines?["ccb"] else {
            problems.append("engines.ccb is missing (for example \"^2.0.0\").")
            return problems
        }
        if !compatible(range) { problems.append("engines.ccb \"\(range)\" is not compatible with this ClaudeCodeBot (2.\(apiVersion.minor)).") }
        guard let ccb = manifest.ccb else {
            problems.append("The ccb field is missing.")
            return problems
        }
        for (label, path) in [("web", ccb.web), ("host", ccb.host), ("claude", ccb.claude), ("contributes.components", ccb.contributes?.components)] {
            guard let path else { continue }
            if path.hasPrefix("/") || path.split(separator: "/").contains("..") {
                problems.append("\(label) \"\(path)\" must be a relative path inside the plugin folder.")
            } else if !FileManager.default.fileExists(atPath: folder.appending(path: path).path) {
                problems.append("\(label) points to \"\(path)\", which does not exist.")
            }
        }
        if let claude = ccb.claude, !FileManager.default.fileExists(atPath: folder.appending(path: "\(claude)/.claude-plugin/plugin.json").path) {
            problems.append("The Claude part \"\(claude)\" must contain .claude-plugin/plugin.json.")
        }
        for style in ccb.styles ?? [] where !FileManager.default.fileExists(atPath: folder.appending(path: style).path) {
            problems.append("\"\(style)\" in styles does not exist.")
        }
        let known = ["composer", "messages", "network", "files", "exec", "bots", "claude"]
        for permission in ccb.permissions ?? [] where !known.contains(permission) {
            problems.append("Unknown permission \"\(permission)\" (allowed: \(known.joined(separator: ", "))).")
        }
        var ids = Set<String>()
        for command in ccb.contributes?.commands ?? [] {
            if !ids.insert(command.id).inserted { problems.append("Command \"\(command.id)\" is declared twice.") }
            if let key = command.key, key.range(of: #"^((cmd|ctrl|alt|option|shift)\+)*[^+]+$"#, options: .regularExpression) == nil {
                problems.append("Command \"\(command.id)\" has an unreadable shortcut \"\(key)\" (for example cmd+shift+l).")
            }
        }
        for panel in ccb.contributes?.panels ?? [] where ccb.web == nil {
            problems.append("Panel \"\(panel.id)\" needs a web part (ccb.web) to draw it.")
        }
        for (key, setting) in ccb.contributes?.settings ?? [:] {
            if let env = setting.env, env.range(of: #"^[A-Z_][A-Z0-9_]*$"#, options: .regularExpression) == nil {
                problems.append("Setting \"\(key)\": env \"\(env)\" must use uppercase letters, digits and underscores.")
            }
            switch setting.type {
            case "boolean":
                if let value = setting.default, value.bool == nil { problems.append("Setting \"\(key)\": the default must be true or false.") }
            case "enum":
                let options = setting.options ?? []
                if options.isEmpty { problems.append("Setting \"\(key)\" is an enum and needs options.") }
                if let value = setting.default, !(value.string.map(options.contains) ?? false) {
                    problems.append("Setting \"\(key)\": the default is not one of the options.")
                }
            case "string":
                if let value = setting.default, value.string == nil { problems.append("Setting \"\(key)\": the default must be text.") }
            case "number":
                if let value = setting.default, value.number == nil { problems.append("Setting \"\(key)\": the default must be a number.") }
            default:
                problems.append("Setting \"\(key)\": type \"\(setting.type)\" must be boolean, enum, string or number.")
            }
        }
        return problems
    }

    /// `^2.0.0`, `~2.0.0`, `>=2.0.0`, `2.x`, `*`.
    nonisolated static func compatible(_ range: String) -> Bool {
        let range = range.trimmingCharacters(in: .whitespaces)
        if range == "*" { return true }
        let digits = range.drop { !$0.isNumber }
        let parts = digits.split(separator: ".").map { Int($0.prefix { $0.isNumber }) }
        guard let major = parts.first ?? nil else { return false }
        let minor = parts.count > 1 ? parts[1] ?? 0 : 0
        if range.hasPrefix(">=") { return (major, minor) <= (apiVersion.major, apiVersion.minor) }
        return major == apiVersion.major && minor <= apiVersion.minor
    }

    nonisolated private static func describe(_ error: Error) -> String {
        switch error {
        case let DecodingError.keyNotFound(key, context):
            return "missing \((context.codingPath.map(\.stringValue) + [key.stringValue]).joined(separator: "."))"
        case let DecodingError.typeMismatch(_, context), let DecodingError.valueNotFound(_, context):
            return "\(context.codingPath.map(\.stringValue).joined(separator: ".")) has the wrong type"
        case let DecodingError.dataCorrupted(context):
            return context.debugDescription
        default:
            return error.localizedDescription
        }
    }
}
