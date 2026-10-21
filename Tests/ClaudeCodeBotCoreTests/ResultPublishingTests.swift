import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Where bots put results for the user (Settings → Reports and results), and the cards a
/// claude.ai Artifact link gets in the chat.
@MainActor
struct ResultPublishingTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-results-\(UUID().uuidString)")

    func manager(_ choice: ResultPublishing) -> String {
        BotPrompts(profile: .manager(name: "garden", avatar: "square", folder: URL(filePath: "/p/garden")), results: choice).system
    }

    // MARK: The rule

    @Test func byDefaultResultsAreArtifactsAndOnlySensitiveOnesStayLocal() {
        let system = manager(.artifactUnlessSensitive)
        #expect(AppSettings().resultPublishing == .artifactUnlessSensitive)
        #expect(system == BotPrompts(profile: .manager(name: "garden", avatar: "square", folder: URL(filePath: "/p/garden"))).system)
        // The choice's rule is in the prompt: publishing, with the bot's own folder to fall back to.
        #expect(system.contains(BotPrompts.resultsRule(.artifactUnlessSensitive, folder: "/p/garden/.bot/artifacts")))
        #expect(system.contains(BotPrompts.artifactPage))
        #expect(system.contains(BotPrompts.localPage(folder: "/p/garden/.bot/artifacts")))
    }

    @Test func alwaysLocalNeverPublishes() {
        let system = manager(.localOnly)
        #expect(system.contains(BotPrompts.resultsRule(.localOnly, folder: "/p/garden/.bot/artifacts")))
        #expect(system.contains(BotPrompts.localPage(folder: "/p/garden/.bot/artifacts")))
        #expect(!system.contains(BotPrompts.artifactPage))
    }

    @Test func alwaysArtifactPublishesSensitiveOnesTooAndFallsBackOnlyWhenItCannot() {
        let system = manager(.artifactAlways)
        #expect(system.contains(BotPrompts.resultsRule(.artifactAlways, folder: "/p/garden/.bot/artifacts")))
        #expect(system.contains(BotPrompts.artifactPage))
        // Each choice is a rule of its own.
        let rules = Set(ResultPublishing.allCases.map { BotPrompts.resultsRule($0, folder: "/f") })
        #expect(rules.count == ResultPublishing.allCases.count)
    }

    @Test func theMainBotHandsWorkOverWhateverTheChoice() {
        let main = BotPrompts(profile: .main(home: root), results: .localOnly).system
        #expect(main.contains("they hand the result link back"))
        #expect(!main.contains("Results meant for the user"))
    }

    @Test func teamsAreToldTheSameRuleForTheirOwnFolder() {
        let folder = URL(filePath: "/r/run-research")
        let spec = TeamSpec.defaults[0]
        for choice in ResultPublishing.allCases {
            let system = TeamPrompts.system(spec, folder: folder, results: choice)
            #expect(system.contains(BotPrompts.resultsRule(choice, folder: "/r/run-research/artifacts")))
            #expect(system.contains("then the result's link, [result name](url)"))
        }
        // Only the Artifact tool is added, and not when results stay local.
        #expect(TeamPrompts.tools(spec, results: .artifactUnlessSensitive) == spec.tools + ["Artifact"])
        #expect(TeamPrompts.tools(spec, results: .artifactAlways) == spec.tools + ["Artifact"])
        #expect(TeamPrompts.tools(spec, results: .localOnly) == spec.tools)
    }

    // MARK: The setting

    @Test func theSettingIsSavedAndAnOlderFileMeansTheDefault() throws {
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        workspace.setResultPublishing(.localOnly)
        #expect(AppSettings.load(from: workspace.settingsURL).resultPublishing == .localOnly)
        try Data(#"{"developerMode":false}"#.utf8).write(to: workspace.settingsURL)
        #expect(AppSettings.load(from: workspace.settingsURL).resultPublishing == .artifactUnlessSensitive)
    }

    @Test func botsMayUseTheArtifactToolWithoutAskingUnlessResultsStayLocal() async throws {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let bot = try #require(workspace.bot(for: workspace.addProject(folder: folder)))
        bot.send("hi")
        await eventually { fake.agents.contains { $0.launch.workingDirectory.lastPathComponent == "garden" } }
        let first = try #require(fake.agents.last { $0.launch.workingDirectory.lastPathComponent == "garden" })
        #expect(first.launch.tools.contains("Artifact"))
        #expect(first.launch.systemPrompt.contains("published as a claude.ai Artifact"))
        // Nothing else is let through: the toolbox plus Artifact, and Bash for a project.
        #expect(Set(first.launch.tools) == Set(BotProfile.toolbox + ["Bash"]))
        #expect(BotProfile.toolbox.filter { $0 == "Artifact" }.count == 1)

        // An awake bot hears the new rule with its next message (its resumed session keeps the old prompt).
        await eventually { !bot.isWorking }
        workspace.setResultPublishing(.localOnly)
        bot.send("next")
        await eventually { first.sent.count >= 2 }
        let note = try #require(first.sent.last)
        #expect(note.hasPrefix("(App: The user changed where results go."))
        #expect(note.contains("do not publish them with the Artifact tool"))
        // A new session starts with it in its system prompt, and asks before publishing.
        #expect(bot.prompts.system.contains("The user chose to keep results local"))
        #expect(!bot.launchTools.contains("Artifact"))
    }

    // MARK: Links

    @Test func artifactLinksAreToldFromOtherLinks() throws {
        for text in ["https://claude.ai/artifact/abc123", "https://claude.ai/code/artifact/0b5c-4e1f", "https://www.claude.ai/artifact/x"] {
            #expect(ArtifactLink.isArtifact(try #require(URL(string: text))), "\(text)")
        }
        for text in ["https://claude.ai/", "https://claude.ai/artifact/", "https://claude.ai/chat/abc", "https://claude.ai/code/abc",
                     "http://claude.ai/artifact/abc", "https://evil.com/artifact/abc", "https://claude.ai.evil.com/artifact/abc",
                     "file:///p/.bot/artifacts/report.html"] {
            #expect(!ArtifactLink.isArtifact(try #require(URL(string: text))), "\(text)")
        }
    }

    @Test func aReplyGetsOneCardPerArtifactItLinks() {
        let text = "效能報告好了：[效能報告](https://claude.ai/code/artifact/perf) 另見 [效能報告](https://claude.ai/code/artifact/perf)、[docs](https://example.com) 和 [本機](file:///p/.bot/artifacts/x.html)"
        #expect(ArtifactLink.cards(in: text) == [ArtifactLink.Card(title: "效能報告", url: "https://claude.ai/code/artifact/perf", host: "claude.ai")])
        #expect(ArtifactLink.cards(in: "nothing here").isEmpty)
        let many = (1...5).map { "[r\($0)](https://claude.ai/artifact/\($0))" }.joined(separator: " ")
        #expect(ArtifactLink.cards(in: many).count == 3)

        let reply = ChatMessage(role: .bot, text: text)
        #expect(ChatPayload.artifactCards(for: reply)?.count == 1)
        #expect(ChatPayload.artifactCards(for: ChatMessage(role: .user, text: text)) == nil)
    }

    @Test func artifactLinksAreInTheResultsList() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : "Done: [效能報告](https://claude.ai/code/artifact/perf)" }
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher)
        bot.send("report")
        await eventually { !bot.results.isEmpty }
        #expect(bot.results.first?.label == "效能報告")
        #expect(bot.results.first.map { ArtifactLink.isArtifact($0.url) } == true)
    }
}
