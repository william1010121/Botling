import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Botling 2.0 (desktop/) Phase 4b ports the temporary teams, bots of their own and the main bot's
/// project list with its team lines. This writes the Swift app's own strings for them to a JSON file,
/// which desktop/test/unit/teams.test.ts compares the port against, character for character. Runs
/// only when asked:
///
///     CCB_DESKTOP_TEAMS_EXPORT=/path/teams-golden.json TZ=UTC swift test --filter DesktopTeamsGoldenExport
struct DesktopTeamsGoldenExport {
    @MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_DESKTOP_TEAMS_EXPORT"] != nil))
    func exportTeamStrings() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_DESKTOP_TEAMS_EXPORT"])
        let folder = URL(filePath: "/r/runs/20260101-120000-research")
        var system: [[String: Any]] = []
        for spec in TeamSpec.defaults {
            for results in [ResultPublishing.artifactUnlessSensitive, .localOnly, .artifactAlways] {
                for language in [AppLanguage.english, .traditionalChinese] {
                    system.append([
                        "team": spec.name, "results": results.rawValue, "language": language.rawValue,
                        "system": TeamPrompts.system(spec, folder: folder, results: results, language: language),
                        "tools": TeamPrompts.tools(spec, results: results),
                    ])
                }
            }
        }
        let parsed = [
            "---\nname: writers\ntitle: Writers\nmodel: haiku\ntools: Read, Write\ndescription: Writes things.\n---\nYou write.\n---\nStill the role.\n",
            "---\nname: plain\n---\n",
            "---\ntitle: No name\n---\nrole",
            "no front matter",
            "---\nname: odd\nmodel: gpt\ntools: Read,Bash ,  WebFetch\n---\n  Role with spaces  \n",
        ].map { text -> Any in
            guard let spec = TeamSpec.parse(text) else { return ["text": text, "spec": NSNull()] }
            return ["text": text, "spec": ["name": spec.name, "title": spec.title, "model": spec.model.rawValue, "tools": spec.tools, "description": spec.description, "role": spec.role]]
        }

        // The project list the main bot wakes with: a project, a bot of its own, Maintainer, the teams.
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-desktop-teams-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let empty = workspace.projectBriefing()
        let shop = root.appending(path: "work/Shop")
        try FileManager.default.createDirectory(at: shop, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: shop, select: false)
        let news = try #require(workspace.createBot(name: "Morning \"news\" @bot", job: "Every day at 08:00, the top 5 tech stories.\nIn English."))
        let plain = workspace.projectBriefing()
        let manager = try #require(workspace.managers[project.id])
        manager.post(ChatMessage(role: .bot, text: "Which theme?\nMore words", choices: [Choice(label: "Dark", detail: nil, recommended: true)]))
        let asking = workspace.projectBriefing()

        let export: [String: Any] = [
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopTeamsGoldenExport.swift from the Swift app's own code.",
            "defaults": TeamSpec.defaults.map { ["name": $0.name, "fileText": $0.fileText] },
            "task": TeamPrompts.task("Compare three note apps"),
            "system": system,
            "parsed": parsed,
            "botNames": ["  Morning news  ", "a\"b@c<d>e`f", "first line\nsecond", String(repeating: "x", count: 50) + " ", ""].map(Workspace.botName),
            "briefing": [
                "root": root.appending(path: "ccb").path,
                "shop": shop.path,
                "news": news.folder.path,
                "newsName": news.name,
                "empty": empty,
                "plain": plain,
                "asking": asking,
            ],
        ]
        try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys]).write(to: URL(filePath: path))
    }
}
