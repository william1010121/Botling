import Foundation
import Testing
@testable import ClaudeCodeBotCore

struct ProjectBotNamingTests {
    func source(in root: URL, name: String = "ClaudeCodeBot") throws -> URL {
        let folder = root.appending(path: name)
        let app = folder.appending(path: "Sources/ClaudeCodeBot/ClaudeCodeBotApp.swift")
        try FileManager.default.createDirectory(at: app.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("struct BotlingApp: App {}".utf8).write(to: app)
        try Data(#"let package = Package(name: "botling", targets: [.target(name: "ClaudeCodeBotCore")])"#.utf8)
            .write(to: folder.appending(path: "Package.swift"))
        return folder
    }

    @Test(arguments: ["ClaudeCodeBot", "ClaudeCodeBOt"])
    func onlyTheConfiguredOwnProjectChangesAndUnknownFieldsSurvive(legacyName: String) throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "botling-project-name-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = try source(in: root)
        let own = UUID(), other = UUID()
        let projects: [[String: Any]] = [
            ["id": own.uuidString, "name": legacyName, "folder": folder.absoluteString,
             "avatar": "square", "futureField": ["keep": true]],
            ["id": other.uuidString, "name": "ClaudeCodeBot", "folder": folder.absoluteString, "avatar": "star"]
        ]
        let input = try JSONSerialization.data(withJSONObject: projects)
        let output = try ProjectBotNaming.migrate(input, developerProjectID: own)
        let result = try #require(JSONSerialization.jsonObject(with: output) as? [[String: Any]])
        #expect(result[0]["name"] as? String == "botling")
        var expected = projects[0]; expected["name"] = "botling"
        #expect(NSDictionary(dictionary: result[0]).isEqual(to: expected))
        #expect(NSDictionary(dictionary: result[1]).isEqual(to: projects[1]))
        #expect(try ProjectBotNaming.migrate(output, developerProjectID: own) == output)
        // Persist/reload a temporary fixture only: the app's existing metadata file is never opened here.
        let stored = root.appending(path: "projects.json")
        try output.write(to: stored, options: .atomic)
        #expect(try Data(contentsOf: stored) == output)
    }

    @Test func customNamesStandaloneBotsAndUnverifiedSourcesAreUntouched() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "botling-project-guards-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = try source(in: root)
        let id = UUID()
        for (name, job, path) in [("My research app", nil as String?, folder),
                                  ("ClaudeCodeBot", "custom bot", folder),
                                  ("ClaudeCodeBot", nil, root.appending(path: "unrelated/ClaudeCodeBot"))] {
            var item: [String: Any] = ["id": id.uuidString, "name": name, "folder": path.absoluteString]
            if let job { item["job"] = job }
            let input = try JSONSerialization.data(withJSONObject: [item])
            #expect(try ProjectBotNaming.migrate(input, developerProjectID: id) == input)
        }
        let input = try JSONSerialization.data(withJSONObject: [["id": id.uuidString, "name": "ClaudeCodeBot", "folder": folder.absoluteString]])
        #expect(try ProjectBotNaming.migrate(input, developerProjectID: nil) == input)
        #expect(try ProjectBotNaming.migrate(input, developerProjectID: UUID()) == input)
    }

    @Test func ownSourceDefaultsToLowercaseWithoutChangingOtherFolderNames() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "botling-project-default-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = try source(in: root)
        #expect(ProjectBotNaming.defaultName(for: source) == "botling")
        #expect(ProjectBotNaming.defaultName(for: root.appending(path: "unrelated/ClaudeCodeBot")) == "ClaudeCodeBot")
        #expect(ProjectBotNaming.defaultName(for: root.appending(path: "Garden")) == "Garden")
        let slug = try self.source(in: root, name: "botling")
        #expect(ProjectBotNaming.defaultName(for: slug) == "botling")
        let custom = try self.source(in: root, name: "My own checkout")
        #expect(ProjectBotNaming.defaultName(for: custom) == "My own checkout")
    }
}
