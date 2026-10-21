import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The chat page gets only what changed (`ccb.patchState`), not every message and the whole
/// components text on each streamed step.
@MainActor
struct ChatPayloadPatchTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-patch-\(UUID().uuidString)")

    let empty: ChatPayload

    init() {
        let fake = FakeLauncher()
        let workspace = Workspace(root: root, launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        empty = ChatPayload.make(bot: workspace.mainBot, components: workspace.components, pending: [], replyingTo: nil) { _ in "" }
    }

    func payload(_ messages: [ChatPayload.Message], working: Bool = false) -> ChatPayload {
        var payload = empty
        payload.messages = messages
        payload.working = working
        return payload
    }

    func message(_ id: String, _ text: String) -> ChatPayload.Message {
        ChatPayload.Message(id: id, role: "bot", text: text, open: false, openable: false)
    }

    /// The JSON inside `ccb.patchState(…)`.
    func patch(_ script: String?) throws -> [String: Any] {
        let script = try #require(script)
        #expect(script.hasPrefix("ccb.patchState(") && script.hasSuffix(")"))
        let json = script.dropFirst("ccb.patchState(".count).dropLast()
        return try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    func ids(_ value: Any?) -> [String] {
        (value as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
    }

    @Test func sendsEverythingFirstThenOnlyWhatChanged() throws {
        var patcher = ChatPayload.Patcher()
        let first = payload([message("a", "one"), message("b", "two")])
        let whole = try patch(patcher.script(for: first))
        #expect(whole["base"] is [String: Any])
        #expect(whole["components"] is [String: Any])
        #expect((whole["base"] as? [String: Any])?["messages"] as? [Any] == nil || ((whole["base"] as? [String: Any])?["messages"] as? [Any])?.isEmpty == true)
        #expect(whole["order"] as? [String] == ["a", "b"])
        #expect(ids(whole["changed"]) == ["a", "b"])

        // The same state again: nothing to send.
        #expect(patcher.script(for: first) == nil)

        // A reply grows and one is added: just those two, no base or components.
        let next = try patch(patcher.script(for: payload([message("a", "one"), message("b", "two, more"), message("c", "three")])))
        #expect(next["base"] == nil)
        #expect(next["components"] == nil)
        #expect(next["order"] as? [String] == ["a", "b", "c"])
        #expect(ids(next["changed"]) == ["b", "c"])

        // The bot starts working: the base, and no messages.
        let working = try patch(patcher.script(for: payload([message("a", "one"), message("b", "two, more"), message("c", "three")], working: true)))
        #expect((working["base"] as? [String: Any])?["working"] as? Bool == true)
        #expect(ids(working["changed"]).isEmpty)

        // A message removed: only the order.
        let removed = try patch(patcher.script(for: payload([message("a", "one"), message("c", "three")], working: true)))
        #expect(removed["order"] as? [String] == ["a", "c"])
        #expect(ids(removed["changed"]).isEmpty)

        // After a reset (the page loaded again or asked), everything again.
        patcher.reset()
        let again = try patch(patcher.script(for: payload([message("a", "one"), message("c", "three")], working: true)))
        #expect(again["base"] != nil && again["components"] != nil)
        #expect(ids(again["changed"]) == ["a", "c"])
    }
}
