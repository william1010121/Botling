import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Botling 2.0 (desktop/) Phase 5a ports the rest of Maintainer's component work (the / menu and its
/// mention note, specs and suggestions, reports) and the completion checks. This writes the Swift
/// app's own strings for them to a JSON file, which desktop/test/unit/phase5.test.ts compares the port
/// against, character for character. Runs only when asked:
///
///     CCB_DESKTOP_PHASE5_EXPORT=/path/phase5-golden.json TZ=UTC swift test --filter DesktopPhase5GoldenExport
struct DesktopPhase5GoldenExport {
    @MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_DESKTOP_PHASE5_EXPORT"] != nil))
    func exportPhase5Strings() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_DESKTOP_PHASE5_EXPORT"])
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-desktop-phase5-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        // Two components of the library's own, one of which starts the other's name.
        let library = workspace.components
        for (name, about) in [("test-status", "Test results: passed and failed counts.\nData: {\"passed\": 3, \"failed\": 1}\nCommand: npm test --json"),
                              ("test", "A plain test card.\n\nIt takes {\"text\": \"…\"}.")] {
            let folder = library.folder.appending(path: name)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("<div>\(name)</div>".utf8).write(to: folder.appending(path: "template.html"))
            try Data(about.utf8).write(to: folder.appending(path: "about.md"))
        }
        library.rescan()
        let shopFolder = root.appending(path: "work/Shop")
        try FileManager.default.createDirectory(at: shopFolder, withIntermediateDirectories: true)
        let shop = workspace.addProject(folder: shopFolder, select: false)
        let members = workspace.everyMember
        let member = { (id: UUID) in members.first { $0.id == id }! }

        // The / mentions.
        let names = library.names
        let mentionTexts = ["/test-status please", "use /test and /test-status", "/TEST", "a/test", "~/test", "用/test看看", "(/test)", "/test/x", "/tests", "/test-status/test", "\"/test\"", "/choices then /網頁預覽卡片", "no slash", "/test /test"]
        let mentions = mentionTexts.map { ["text": $0, "names": ComponentMentions.names(in: $0, among: names)] as [String: Any] }
        let notes = ["/test-status please", "use /test and /test-status", "nothing named"].map { ["text": $0, "note": library.mentionNote(for: $0) ?? NSNull()] as [String: Any] }

        // A call-in and a group turn whose newest line names a component.
        let date = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let first = ChatMessage(id: UUID(uuidString: "00000000-0000-4000-8000-0000000000A1")!, role: .user, text: "@Shop show me /test-status", date: date)
        workspace.mainBot.post(first, unread: false)
        let before = Workspace.transcriptBefore(first.id, in: workspace.mainBot.messages)
        let callIn = workspace.callInPrompt(for: member(shop.id), into: workspace.mainBot, transcript: before, newest: first.id, ask: nil)
        let group = try #require(workspace.createGroup(name: "Pair", members: [Workspace.mainBotID, shop.id]))
        let groupChat = try #require(workspace.groupChats[group.id])
        groupChat.post(first, unread: false)
        let groupBefore = Workspace.transcriptBefore(first.id, in: groupChat.messages)
        let groupTurn = workspace.groupPrompt(for: member(shop.id), in: group, addressed: false, transcript: groupBefore, newest: first.id, ask: nil)

        var export: [String: Any] = [
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopPhase5GoldenExport.swift from the Swift app's own code.",
            "names": names,
            "mentions": mentions,
            "mentionNotes": notes,
            "callIn": callIn,
            "groupTurn": groupTurn,
            "shop": shop.id.uuidString,
            "group": group.id.uuidString,
            "messages": try JSONSerialization.jsonObject(with: JSONEncoder().encode(workspace.mainBot.messages)),
        ]
        export["more"] = Self.more(workspace: workspace, root: root)
        try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys]).write(to: URL(filePath: path))
    }

    /// The later parts (specs, reports, feedback, completion checks) add theirs here.
    @MainActor static func more(workspace: Workspace, root: URL) -> [String: Any] {
        [:]
    }
}
