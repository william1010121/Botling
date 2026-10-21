import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// What you typed but did not send, kept per chat across switching bots and restarts.
@MainActor
struct ComposerDraftTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-drafts-\(UUID().uuidString)")

    @Test func aDraftIsKeptPerChatAndSurvivesARestart() {
        let url = root.appending(path: "drafts.json")
        let drafts = ComposerDrafts(url: url)
        drafts.set("A", ComposerDrafts.Draft(text: "half a thought", cursor: 4))
        drafts.set("B", ComposerDrafts.Draft(text: "other", cursor: 5))
        drafts.set("B", nil)
        let reopened = ComposerDrafts(url: url)
        #expect(reopened.all == ["A": ComposerDrafts.Draft(text: "half a thought", cursor: 4)])
    }

    @Test func emptyTextRemovesTheDraft() {
        let drafts = ComposerDrafts(url: root.appending(path: "drafts.json"))
        drafts.set("A", ComposerDrafts.Draft(text: "x", cursor: 1))
        drafts.set("A", ComposerDrafts.Draft(text: "", cursor: 0))
        #expect(drafts.all.isEmpty)
        #expect(ComposerDrafts(url: root.appending(path: "drafts.json")).all.isEmpty)
    }

    @Test func thePageGetsEveryDraftAsOneScript() {
        let drafts = ComposerDrafts(url: root.appending(path: "drafts.json"))
        drafts.set("A", ComposerDrafts.Draft(text: "say \"hi\"\n", cursor: 2))
        #expect(drafts.script == #"ccb.setDrafts({"A":{"cursor":2,"text":"say \"hi\"\n"}})"#)
    }

    @Test func theWorkspaceKeepsItsDraftsInItsFolder() {
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: FakeLauncher().launcher) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }
        workspace.drafts.set("A", ComposerDrafts.Draft(text: "kept", cursor: 4))
        #expect(ComposerDrafts(url: root.appending(path: "ccb/drafts.json")).all["A"]?.text == "kept")
    }
}
