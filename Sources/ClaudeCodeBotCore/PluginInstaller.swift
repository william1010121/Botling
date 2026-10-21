import Foundation

/// A plugin fetched and checked but not installed yet: what ClaudeCodeBot shows you before asking.
public struct InstallProposal: Identifiable, Sendable {
    public let id = UUID()
    /// What was given: a folder, git URL, npm name or archive URL.
    public var source: String
    /// The fetched plugin folder (in a scratch folder until installed).
    public var folder: URL
    public var manifest: PluginManifest
    public var author: String?
    /// MCP servers its Claude part starts.
    public var mcpServers: [String]
    /// Why it cannot be installed, if anything.
    public var problems: [String]

    /// Each permission in words, as the permission card shows them.
    public var permissionLines: [String] {
        (manifest.ccb?.permissions ?? []).map { PluginInstaller.describe(permission: $0) }
    }

    /// The text of the permission card.
    public var summary: String {
        var lines = [L("Install the plugin \"{0}\" {1}?", manifest.title, manifest.version)]
        if let description = manifest.description { lines.append(description) }
        lines.append(L("Source: {0}", source))
        lines.append(L("Author: {0}; license: {1}", author ?? L("not given"), manifest.license ?? L("not given")))
        let permissions = permissionLines
        lines.append(permissions.isEmpty ? L("It asks for no permissions.") : L("It will: {0}", permissions.joined(separator: ", ")))
        if !mcpServers.isEmpty { lines.append(L("It gives the bots new tools (MCP): {0}", mcpServers.joined(separator: ", "))) }
        if manifest.ccb?.host != nil { lines.append(L("It has a program part that runs on your computer (permissions are only declared, not sandboxed).")) }
        return lines.joined(separator: "\n")
    }
}

/// Fetches plugins from outside: a local folder, a git URL, an npm package, or a .zip / .tgz URL.
public enum PluginInstaller {
    public enum Source: Equatable {
        case folder(URL)
        case git(String)
        case npm(String)
        case archive(URL)
    }

    public struct InstallError: Error, LocalizedError {
        public var message: String
        public var errorDescription: String? { message }
    }

    /// What kind of source `text` is.
    public static func classify(_ text: String) -> Source? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let expanded = (text as NSString).expandingTildeInPath
        if text.hasPrefix("/") || text.hasPrefix("~") {
            var isFolder: ObjCBool = false
            return FileManager.default.fileExists(atPath: expanded, isDirectory: &isFolder) && isFolder.boolValue
                ? .folder(URL(filePath: expanded)) : nil
        }
        if let url = URL(string: text), let scheme = url.scheme?.lowercased() {
            let path = url.path.lowercased()
            if ["http", "https"].contains(scheme), path.hasSuffix(".zip") || path.hasSuffix(".tgz") || path.hasSuffix(".tar.gz") {
                return .archive(url)
            }
            if ["http", "https", "ssh", "git", "file"].contains(scheme) { return .git(text) }
        }
        if text.hasPrefix("git@") { return .git(text) }
        if text.range(of: #"^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9.^~<>=*-]+)?$"#, options: .regularExpression) != nil {
            return .npm(text)
        }
        return nil
    }

    /// Fetches `source` into a new folder under `scratch` and reads it.
    public static func fetch(_ source: String, scratch: URL) async throws -> InstallProposal {
        guard let kind = classify(source) else {
            throw InstallError(message: "Can't tell what \"\(source)\" is: it must be a folder, a git URL, an npm package name, or a .zip/.tgz URL.")
        }
        let work = scratch.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let fetched: URL
        switch kind {
        case let .folder(url):
            fetched = work.appending(path: url.lastPathComponent)
            try FileManager.default.copyItem(at: url, to: fetched)
            try? FileManager.default.removeItem(at: fetched.appending(path: ".git"))
        case let .git(url):
            fetched = work.appending(path: "repo")
            try await run("/usr/bin/env", ["git", "clone", "--depth", "1", "--quiet", url, fetched.path], in: work)
            try? FileManager.default.removeItem(at: fetched.appending(path: ".git"))
        case let .npm(name):
            try await run("/usr/bin/env", ["npm", "pack", name, "--silent", "--pack-destination", work.path], in: work)
            guard let tarball = try FileManager.default.contentsOfDirectory(at: work, includingPropertiesForKeys: nil)
                .first(where: { $0.pathExtension == "tgz" }) else { throw InstallError(message: "npm did not return a package.") }
            try await run("/usr/bin/tar", ["xzf", tarball.path, "-C", work.path], in: work)
            fetched = work.appending(path: "package")
        case let .archive(url):
            let (download, _) = try await URLSession.shared.download(from: url)
            let archive = work.appending(path: url.lastPathComponent)
            try FileManager.default.moveItem(at: download, to: archive)
            let unpacked = work.appending(path: "unpacked")
            try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
            if url.path.lowercased().hasSuffix(".zip") {
                try await run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path], in: work)
            } else {
                try await run("/usr/bin/tar", ["xzf", archive.path, "-C", unpacked.path], in: work)
            }
            fetched = try pluginRoot(in: unpacked)
        }
        return read(fetched, source: source)
    }

    /// The folder holding package.json: the folder itself, or its only subfolder.
    static func pluginRoot(in folder: URL) throws -> URL {
        if FileManager.default.fileExists(atPath: folder.appending(path: "package.json").path) { return folder }
        let children = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey])
            .filter { !$0.lastPathComponent.hasPrefix(".") }
        if children.count == 1, FileManager.default.fileExists(atPath: children[0].appending(path: "package.json").path) {
            return children[0]
        }
        throw InstallError(message: "No package.json inside.")
    }

    /// Reads and checks a fetched plugin.
    public static func read(_ folder: URL, source: String) -> InstallProposal {
        let problems = PluginRegistry.check(folder)
        let data = (try? Data(contentsOf: folder.appending(path: "package.json"))) ?? Data()
        let manifest = (try? JSONDecoder().decode(PluginManifest.self, from: data))
            ?? PluginManifest(name: folder.lastPathComponent, version: "?")
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let author = (object?["author"] as? String) ?? ((object?["author"] as? [String: Any])?["name"] as? String)
        return InstallProposal(
            source: source,
            folder: folder,
            manifest: manifest,
            author: author,
            mcpServers: mcpServers(of: folder, manifest),
            problems: problems
        )
    }

    /// The MCP servers a plugin's Claude part declares in its .mcp.json.
    static func mcpServers(of folder: URL, _ manifest: PluginManifest) -> [String] {
        guard let claude = manifest.ccb?.claude,
              let data = try? Data(contentsOf: folder.appending(path: "\(claude)/.mcp.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        let servers = (object["mcpServers"] as? [String: Any]) ?? object
        return servers.keys.sorted()
    }

    static func describe(permission: String) -> String {
        PluginPermission(rawValue: permission)?.allows ?? "\"\(permission)\""
    }

    private static func run(_ executable: String, _ arguments: [String], in folder: URL) async throws {
        try await blocking {
            let process = Process()
            process.executableURL = URL(filePath: executable)
            process.arguments = arguments
            process.currentDirectoryURL = folder
            var environment = ProcessInfo.processInfo.environment
            environment["GIT_TERMINAL_PROMPT"] = "0"
            process.environment = environment
            let output = Pipe()
            process.standardOutput = output
            process.standardError = output
            try process.run()
            let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                throw InstallError(message: "\(arguments.first ?? executable) failed: \(text.trimmingCharacters(in: .whitespacesAndNewlines).suffix(300))")
            }
        }
    }
}

extension PluginManifest {
    init(name: String, version: String) {
        self.init(name: name, displayName: nil, version: version, description: nil, license: nil, engines: nil, scripts: nil, ccb: nil)
    }
}
