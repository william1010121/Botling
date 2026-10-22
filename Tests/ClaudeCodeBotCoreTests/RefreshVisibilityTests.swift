import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A pin refreshed by itself reruns its command only while the user can see it: the window is
/// shown (not minimized, hidden or covered), its chat is the one on screen, and the page saw the
/// pin (its chip, its opened panel, its Board tile scrolled into view, its floating card).
@MainActor
struct RefreshVisibilityTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-sight-\(UUID().uuidString)")

    func makeWorkspace() -> Workspace {
        let fake = FakeLauncher()
        return Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, command: String, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "\(name).\nCommand: `\(command)`".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func garden(_ workspace: Workspace) throws -> Bot {
        let folder = root.appending(path: "code/garden")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try #require(workspace.bot(for: workspace.addProject(folder: folder, select: false)))
    }

    /// A pin in the main bot's chat refreshed every 5 seconds, allowed.
    func livePin(_ workspace: Workspace) throws -> PinnedComponent {
        try addComponent("release", command: "printf 1", to: workspace)
        workspace.componentCommands.approve("printf 1", in: workspace.pinFolder(for: workspace.mainBot))
        return try #require(workspace.pin(named: "release", in: workspace.mainBot, refresh: .interval, seconds: 5))
    }

    @Test func aPinNobodySeesDoesNotRun() async throws {
        let workspace = makeWorkspace()
        let pin = try livePin(workspace)
        // The page has not said it shows the pin (another tab, scrolled away, folded panel).
        await workspace.refreshDuePins()
        #expect(workspace.componentCommands.runs[pin.card] == nil)
        await workspace.pinsVisible([pin.id], in: workspace.mainBot)
        #expect(workspace.componentCommands.runs[pin.card]?.data == "1")
    }

    @Test func aHiddenWindowStopsEveryPinAndShownAgainRunsOnceRightAway() async throws {
        let workspace = makeWorkspace()
        let pin = try livePin(workspace)
        await workspace.pinsVisible([pin.id], in: workspace.mainBot)
        let ran = try #require(workspace.componentCommands.runs[pin.card]?.ranAt)
        await workspace.setWindowVisible(false, now: ran.addingTimeInterval(1))
        // Minimized, hidden or covered: not even once it is long overdue.
        await workspace.refreshDuePins(now: ran.addingTimeInterval(60))
        #expect(workspace.componentCommands.runs[pin.card]?.ranAt == ran)
        // Shown again after longer than its interval: it runs at once, not at the next tick.
        await workspace.setWindowVisible(true, now: ran.addingTimeInterval(60))
        let again = try #require(workspace.componentCommands.runs[pin.card]?.ranAt)
        #expect(again > ran)
        // Then on its timer again: not before its 5 seconds.
        await workspace.refreshDuePins(now: again.addingTimeInterval(4))
        #expect(workspace.componentCommands.runs[pin.card]?.ranAt == again)
        await workspace.refreshDuePins(now: again.addingTimeInterval(5))
        #expect(try #require(workspace.componentCommands.runs[pin.card]?.ranAt) > again)
    }

    @Test func shownAgainSoonerThanItsIntervalWaitsForIt() async throws {
        let workspace = makeWorkspace()
        let pin = try livePin(workspace)
        await workspace.pinsVisible([pin.id], in: workspace.mainBot)
        let ran = try #require(workspace.componentCommands.runs[pin.card]?.ranAt)
        await workspace.pinsVisible([], in: workspace.mainBot, now: ran.addingTimeInterval(1))
        await workspace.pinsVisible([pin.id], in: workspace.mainBot, now: ran.addingTimeInterval(2))
        #expect(workspace.componentCommands.runs[pin.card]?.ranAt == ran)
    }

    @Test func aPinOfAChatNotOnScreenDoesNotRun() async throws {
        // The release-progress case: a pin refreshed every 5 s floating in a project's chat ran
        // `git status` in the background while another chat was shown.
        let workspace = makeWorkspace()
        try addComponent("release", command: "printf 2", to: workspace)
        try addComponent("slow", command: "printf 2", to: workspace)
        let code = try garden(workspace)
        workspace.componentCommands.approve("printf 2", in: workspace.pinFolder(for: code))
        let live = try #require(workspace.pin(named: "release", in: code, refresh: .interval, seconds: 5))
        workspace.floatPin(live.id, true, in: code)
        let slow = try #require(workspace.pin(named: "slow", in: code, refresh: .interval, minutes: 1))
        #expect(workspace.selectedBot === workspace.mainBot)
        await workspace.refreshDuePins()
        #expect(workspace.componentCommands.runs[live.card] == nil)
        #expect(workspace.componentCommands.runs[slow.card] == nil)
        // What a page showing another chat saw does not count for this one.
        await workspace.pinsVisible([slow.id], in: code)
        #expect(workspace.componentCommands.runs[slow.card] == nil)
        // Its chat shown and its chip seen: it runs.
        workspace.select(workspace.everyProject.first { workspace.bot(for: $0) === code }?.id)
        await workspace.pinsVisible([slow.id], in: code)
        #expect(workspace.componentCommands.runs[slow.card]?.data == "2")
    }

    @Test func theWindowRule() {
        #expect(RefreshSight.windowShows(occlusionVisible: true, miniaturized: false, appHidden: false))
        #expect(!RefreshSight.windowShows(occlusionVisible: false, miniaturized: false, appHidden: false))
        #expect(!RefreshSight.windowShows(occlusionVisible: true, miniaturized: true, appHidden: false))
        #expect(!RefreshSight.windowShows(occlusionVisible: true, miniaturized: false, appHidden: true))
    }
}
