import Foundation

/// Product branding and user project names are separate. Only the app's own source gets this default.
enum ProjectBotNaming {
    static func defaultName(for folder: URL) -> String {
        let name = folder.lastPathComponent
        return ["claudecodebot", "botling"].contains(name.lowercased()) && isOwnSource(folder) ? "botling" : name
    }

    /// The selected developer project's stable ID identifies the existing bot, even if its folder
    /// has another name. Preserve every JSON field; only its old default display name may change.
    static func migrate(_ data: Data, developerProjectID: UUID?) throws -> Data {
        guard let id = developerProjectID,
              var projects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let index = projects.firstIndex(where: { ($0["id"] as? String).flatMap(UUID.init(uuidString:)) == id }),
              let name = projects[index]["name"] as? String, name.lowercased() == "claudecodebot",
              projects[index]["job"] == nil || projects[index]["job"] is NSNull,
              projects[index]["plugin"] == nil || projects[index]["plugin"] is NSNull,
              let path = projects[index]["folder"] as? String,
              let folder = URL(string: path), folder.isFileURL, isOwnSource(folder) else { return data }
        projects[index]["name"] = "botling"
        return try JSONSerialization.data(withJSONObject: projects, options: [.sortedKeys])
    }

    /// Do not infer identity from a folder/name alone or from an arbitrary developer-mode selection.
    private static func isOwnSource(_ folder: URL) -> Bool {
        guard let manifest = try? String(contentsOf: folder.appending(path: "Package.swift"), encoding: .utf8),
              manifest.contains("name: \"ClaudeCodeBotCore\""),
              manifest.contains("name: \"botling\"") || manifest.contains("name: \"ClaudeCodeBot\""),
              let app = try? String(contentsOf: folder.appending(path: "Sources/ClaudeCodeBot/ClaudeCodeBotApp.swift"), encoding: .utf8)
        else { return false }
        return app.contains("struct BotlingApp: App") || app.contains("struct ClaudeCodeBotApp: App")
    }
}
