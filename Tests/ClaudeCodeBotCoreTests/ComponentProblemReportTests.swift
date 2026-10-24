import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// "Report a problem…" in a component card's ⋯ menu: the report goes to Maintainer the way a
/// bot's `<component name="…">` request does, saying which card, whose chat, how it refreshes,
/// when its data is from, and where the screenshot of the card is kept.
@MainActor
struct ComponentProblemReportTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-problem-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func garden(in workspace: Workspace) throws -> Bot {
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let project = workspace.addProject(folder: folder)
        return try #require(workspace.bot(for: project))
    }

    func addComponent(_ name: String, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<p>\(name)</p>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "\(name) card.".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func screenshot() throws -> URL {
        let shot = FileManager.default.temporaryDirectory.appending(path: "ccb-card-\(UUID().uuidString).png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: shot)
        return shot
    }

    @Test func theRequestSaysWhichCardWhoseChatHowItRefreshesAndWhenItsDataIsFrom() {
        let ran = DateComponents(calendar: .current, year: 2026, month: 10, day: 24, hour: 18, minute: 54, second: 12).date!
        let live = PinnedComponent(name: "agent-activity", command: "python3 activity.py", data: "{}", ranAt: ran, refresh: .interval, minutes: 15, seconds: 5)
        let shot = URL(filePath: "/p/.bot/attachments/20261024-185500-agent-activity-screenshot.png")
        let request = Workspace.problemReport("The Codex rows never update", chat: "garden", pin: live, screenshot: shot)
        #expect(request == "Problem reported from the card in garden's chat: The Codex rows never update (Card: refreshes every 5 sec; data from 2026-10-24 18:54:12. Screenshot of the card: /p/.bot/attachments/20261024-185500-agent-activity-screenshot.png)")

        // Every few minutes, when shown, only on ↻, or no command at all.
        #expect(Workspace.problemReport("x", chat: "garden", pin: PinnedComponent(name: "a", command: "ls", data: "{}", refresh: .interval, minutes: 15), screenshot: nil).contains("refreshes every 15 min"))
        #expect(Workspace.problemReport("x", chat: "garden", pin: PinnedComponent(name: "a", command: "ls", data: "{}", refresh: .shown), screenshot: nil).contains("refreshes when shown"))
        #expect(Workspace.problemReport("x", chat: "garden", pin: PinnedComponent(name: "a", command: "ls", data: "{}", refresh: .manual), screenshot: nil).contains("refreshes only on ↻"))
        #expect(Workspace.problemReport("x", chat: "garden", pin: PinnedComponent(name: "a", data: "{}"), screenshot: nil).contains("no command; keeps the data it was drawn with"))
        // A card in the chat (not pinned) has no refresh to tell.
        #expect(Workspace.problemReport("x", chat: "garden", pin: nil, screenshot: nil) == "Problem reported from the card in garden's chat: x")
    }

    @Test func aReportGoesToMaintainerWithTheScreenshotKeptInThatBotsAttachments() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        await workspace.pluginLibraryReady.value
        try addComponent("agent-activity", to: workspace)
        let bot = try garden(in: workspace)
        let live = PinnedComponent(name: "agent-activity", command: "python3 activity.py", data: "{}", ranAt: Date(), refresh: .interval, minutes: 15, seconds: 5)
        bot.editPins { $0.append(live) }
        let shot = try screenshot()
        defer { try? FileManager.default.removeItem(at: shot) }

        #expect(workspace.reportComponentProblem("agent-activity", text: "  The Codex rows never update ", in: bot, pinID: live.id, screenshot: shot))

        // Kept with the files sent to that bot, so its path still works later.
        let kept = try FileManager.default.contentsOfDirectory(at: bot.profile.attachmentsURL, includingPropertiesForKeys: nil)
        let copy = try #require(kept.first { $0.lastPathComponent.hasSuffix(shot.lastPathComponent) })
        #expect(copy.path.contains("/.bot/attachments/"))

        // The same road a bot's <component> tag takes: the component is marked as being changed,
        // and Maintainer has the request and the picture.
        #expect(workspace.components.working["agent-activity"] != nil)
        let relay = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(relay.text.hasPrefix("The user's request for the component \"agent-activity\": Problem reported from the card in garden's chat: The Codex rows never update (Card: refreshes every 5 sec; data from "))
        #expect(relay.text.contains("Screenshot of the card: /"))
        #expect(relay.text.contains("/.bot/attachments/\(copy.lastPathComponent))"))
        #expect(relay.attachments?.count == 1)
        await eventually { fake.agents.last?.sent.first?.contains("The Codex rows never update") == true }
    }

    @Test func aPinFoundByNameWhenTheCardInTheChatIsPinned() async throws {
        let workspace = makeWorkspace()
        await workspace.pluginLibraryReady.value
        let bot = workspace.mainBot
        bot.editPins { $0.append(PinnedComponent(name: "weather", command: "curl wttr.in", data: "{}", refresh: .manual)) }
        #expect(workspace.reportComponentProblem("weather", text: "Shows yesterday", in: bot))
        let relay = try #require(workspace.maintainer.messages.last { $0.role == .relay })
        #expect(relay.text.contains("Problem reported from the card in \(bot.name)'s chat: Shows yesterday (Card: refreshes only on ↻.)"))
    }

    @Test func aScreenshotAloneIsNoReport() async throws {
        let workspace = makeWorkspace()
        await workspace.pluginLibraryReady.value
        let shot = try screenshot()
        defer { try? FileManager.default.removeItem(at: shot) }
        #expect(!workspace.reportComponentProblem("weather", text: "   ", in: workspace.mainBot, screenshot: shot))
        #expect(!workspace.maintainer.messages.contains { $0.role == .relay })
    }
}
