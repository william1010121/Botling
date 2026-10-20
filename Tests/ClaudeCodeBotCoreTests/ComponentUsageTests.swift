import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Each component card made for a new message adds one use to `component-usage.json`, so you can
/// see which components are used and which are not.
@MainActor
struct ComponentUsageTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-usage-\(UUID().uuidString)").resolvingSymlinksInPath()

    var usageURL: URL { root.appending(path: "ccb/component-usage.json") }

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func fake(replying reply: String) -> FakeLauncher {
        let fake = FakeLauncher()
        fake.respond = { text in isAppOnly(text) ? "OK" : reply }
        return fake
    }

    func usage() throws -> [String: Any] {
        let data = try Data(contentsOf: usageURL)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func entry(_ name: String) throws -> [String: Any]? {
        (try usage()["components"] as? [String: Any])?[name] as? [String: Any]
    }

    func count(_ name: String) -> Int {
        ((try? entry(name))??["count"] as? Int) ?? 0
    }

    @Test func aShowCardCountsOnceForTheBotThatDrewIt() async throws {
        let fake = fake(replying: #"Here: <show name="diff">{"a":1}</show> and <show name="diff">{"a":2}</show>"#)
        let workspace = makeWorkspace(fake)
        await workspace.send("show me", to: workspace.mainBot)
        await eventually { workspace.mainBot.messages.contains { !$0.shown.isEmpty } }
        await eventually { count("diff") == 2 }
        let diff = try #require(try entry("diff"))
        #expect(diff["byBot"] as? [String: Int] == [workspace.mainBot.name: 2])
        #expect((diff["lastUsed"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) } != nil)
        let since = try #require(try usage()["since"] as? String)
        #expect(ISO8601DateFormatter().date(from: since) != nil)
    }

    @Test func choicesCountAsTheChoicesComponent() async throws {
        let fake = fake(replying: "Which one?\n<choices>\n* Red\n- Blue\n</choices>")
        let workspace = makeWorkspace(fake)
        await workspace.send("pick", to: workspace.mainBot)
        await eventually { workspace.mainBot.messages.contains { $0.choices != nil } }
        await eventually { count("choices") == 1 }
    }

    @Test func aLinkedResultPageCountsAsAPreviewCard() async throws {
        let page = root.appending(path: "p/.bot/artifacts/report.html")
        try FileManager.default.createDirectory(at: page.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "<h1>hi</h1>".write(to: page, atomically: true, encoding: .utf8)
        let fake = fake(replying: "Done: [Report](\(page.absoluteString))")
        let workspace = makeWorkspace(fake)
        await workspace.send("make a page", to: workspace.mainBot)
        await eventually { workspace.mainBot.messages.contains { $0.text.contains("Report") } }
        await eventually { count(PagePreview.component) == 1 }
    }

    @Test func reopeningAChatDoesNotCountAgain() async throws {
        let fake = fake(replying: "Pick\n<choices>\n* A\n- B\n</choices>\n<show name=\"diff\">{}</show>")
        let workspace = makeWorkspace(fake)
        await workspace.send("go", to: workspace.mainBot)
        await eventually { count("choices") == 1 && count("diff") == 1 }
        // Drawing the chat again (scrolling, switching chats) is not a new card.
        _ = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }
        // Nor is opening the app again with the same chat.
        let reopened = makeWorkspace(FakeLauncher())
        #expect(reopened.mainBot.messages.contains { $0.choices != nil })
        _ = ChatPayload.make(bot: reopened.mainBot, components: reopened.components, pending: [], replyingTo: nil) { _ in "" }
        #expect(count("choices") == 1)
        #expect(count("diff") == 1)
    }

    @Test func aMissingOrBrokenFileStartsOver() throws {
        let file = root.appending(path: "usage.json")
        let usage = ComponentUsage(url: file)
        usage.record(["x"], bot: "B")
        #expect(ComponentUsage.load(from: file).components["x"]?.count == 1)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file)
        let fresh = ComponentUsage(url: file)
        fresh.record(["x", "x", "y"], bot: "B")
        let loaded = ComponentUsage.load(from: file)
        #expect(loaded.components["x"]?.count == 2)
        #expect(loaded.components["x"]?.byBot == ["B": 2])
        #expect(loaded.components["y"]?.count == 1)
    }
}
