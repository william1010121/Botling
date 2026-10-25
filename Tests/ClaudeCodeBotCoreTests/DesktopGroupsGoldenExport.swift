import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Botling 2.0 (desktop/) Phase 4c ports call-ins, bots' @ and group chats. This writes the Swift app's
/// own strings for them (the prompts, the transcript, mentions, PASS) to a JSON file, which
/// desktop/test/unit/groups.test.ts compares the port against, character for character. Runs only
/// when asked:
///
///     CCB_DESKTOP_GROUPS_EXPORT=/path/groups-golden.json TZ=UTC swift test --filter DesktopGroupsGoldenExport
struct DesktopGroupsGoldenExport {
    @MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_DESKTOP_GROUPS_EXPORT"] != nil))
    func exportGroupStrings() throws {
        let path = try #require(ProcessInfo.processInfo.environment["CCB_DESKTOP_GROUPS_EXPORT"])
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-desktop-groups-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher()
        let workspace = Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
        let shopFolder = root.appending(path: "work/Shop")
        try FileManager.default.createDirectory(at: shopFolder, withIntermediateDirectories: true)
        let shop = workspace.addProject(folder: shopFolder, select: false)
        let news = try #require(workspace.createBot(name: "Morning news", job: "The news at 08:00."))
        let members = workspace.everyMember
        let member = { (id: UUID) in members.first { $0.id == id }! }
        let main = member(Workspace.mainBotID)
        let maintainer = member(Workspace.maintainerID)

        // The main bot's chat, with every kind of line a guest reads.
        let date = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let ghost = UUID(uuidString: "0000AAAA-0000-4000-8000-000000000001")!
        var lines: [ChatMessage] = []
        func line(_ id: String, _ role: ChatMessage.Role, _ text: String, choices: [Choice]? = nil, source: UUID? = nil, change: (inout ChatMessage) -> Void = { _ in }) {
            var message = ChatMessage(id: UUID(uuidString: id)!, role: role, text: text, date: date.addingTimeInterval(Double(lines.count)), choices: choices, sourceID: source)
            change(&message)
            lines.append(message)
        }
        line("00000000-0000-4000-8000-000000000001", .user, "Hi all\nsecond line")
        line("00000000-0000-4000-8000-000000000002", .bot, "Hello! Which theme?", choices: [Choice(label: "Dark", recommended: true), Choice(label: "Light")]) {
            $0.chosen = 0
            $0.reactions = [MessageReaction(emoji: "👍", actor: "user")]
        }
        line("00000000-0000-4000-8000-000000000003", .notice, "Plugin \"x\" said hi")
        line("00000000-0000-4000-8000-000000000004", .bot, "From \"Shop\": done", choices: [Choice(label: "Yes"), Choice(label: "No")], source: shop.id) {
            $0.answer = "maybe later"
        }
        line("00000000-0000-4000-8000-000000000005", .divider, "New session")
        line("00000000-0000-4000-8000-000000000006", .user, "@Shop can you check?\n\n\nThanks") {
            $0.attachments = [Attachment(url: URL(filePath: "/tmp/a b.png"))]
        }
        line("00000000-0000-4000-8000-000000000007", .bot, "ghost line", source: ghost)
        line("00000000-0000-4000-8000-000000000008", .bot, String(repeating: "long ", count: 100), source: Workspace.maintainerID)
        for message in lines { workspace.mainBot.post(message, unread: false) }
        let chat = workspace.mainBot
        let newest = lines[5].id
        let before = Workspace.transcriptBefore(newest, in: chat.messages)

        // A group of three (with the main bot), and one without it (its front desk is the first member).
        let group = try #require(workspace.createGroup(name: "Team \"A\"\nsecond", members: [news.id, Workspace.mainBotID, shop.id]))
        let groupChat = try #require(workspace.groupChats[group.id])
        for message in lines.prefix(4) { groupChat.post(message, unread: false) }
        let groupBefore = Workspace.transcriptBefore(lines[0].id, in: groupChat.messages)
        let small = try #require(workspace.createGroup(name: "Pair", members: [news.id, shop.id]))
        var groupPrompts: [[String: Any]] = []
        for (g, transcript) in [(group, groupBefore), (small, [ChatMessage]())] {
            for who in workspace.members(of: g) {
                for (addressed, ask) in [(false, nil), (true, nil), (true, "The user picked: Dark")] as [(Bool, String?)] {
                    groupPrompts.append([
                        "group": g.id.uuidString, "member": who.id.uuidString, "addressed": addressed, "ask": ask ?? NSNull(),
                        "prompt": workspace.groupPrompt(for: who, in: g, addressed: addressed, transcript: transcript, newest: transcript.isEmpty ? nil : lines[0].id, ask: ask),
                    ])
                }
            }
        }

        let encoder = JSONEncoder()
        let records = try JSONSerialization.jsonObject(with: encoder.encode(chat.messages))
        let groupRecords = try JSONSerialization.jsonObject(with: encoder.encode(groupChat.messages))
        let texts = [
            "@Maintainer is the flag component still yours?",
            "Sure.\n  @Shop, please look\nat the cart\n\n@morning news: hi",
            "> @Shop quoted\n```\n@Shop in code\n```\n    @Shop indented\n\t@Shop tab",
            "no mentions @ here",
            "@Morning news，早安",
            "~~~\n@Shop\n~~~\n@Main bot hello",
        ]
        let mentionTexts = ["@shop and @Morning news", "@Morning newsy", "x@Shop", "@Shop請看", "@Main bot, @maintainer!", "@MAINTAINER @Shop @shop", "nobody"]
        let export: [String: Any] = [
            "about": "Written by Tests/ClaudeCodeBotCoreTests/DesktopGroupsGoldenExport.swift from the Swift app's own code.",
            "members": members.map { ["id": $0.id.uuidString, "name": $0.name] },
            "ids": ["main": main.id.uuidString, "shop": shop.id.uuidString, "news": news.id.uuidString, "maintainer": maintainer.id.uuidString, "group": group.id.uuidString, "small": small.id.uuidString],
            "messages": records,
            "groupMessages": groupRecords,
            "newest": newest.uuidString,
            "before": before.map(\.id.uuidString),
            "transcript": workspace.transcriptLines(chat.messages, newest: newest, host: "Main \"bot\""),
            "transcriptNoHost": workspace.transcriptLines(chat.messages, newest: nil),
            "snapshot": ReactionContext.snapshot(chat.messages, through: before.last?.id),
            "snapshotAll": ReactionContext.snapshot(chat.messages),
            "callIn": workspace.callInPrompt(for: member(shop.id), into: chat, transcript: before, newest: newest, ask: nil),
            "callInAsk": workspace.callInPrompt(for: member(shop.id), into: chat, transcript: before, newest: nil, ask: "The user picked: Yes"),
            "callInEmpty": workspace.callInPrompt(for: maintainer, into: chat, transcript: [], newest: nil, ask: nil),
            "botCallIn": workspace.botCallInPrompt(for: maintainer, into: chat, transcript: before, mention: BotMention(message: lines[1].id, recipient: maintainer.id, body: "is the flag component still yours?")),
            "botCallInEmpty": workspace.botCallInPrompt(for: maintainer, into: chat, transcript: before, mention: BotMention(message: lines[1].id, recipient: maintainer.id, body: "")),
            "callInNote1": workspace.callInNote([member(shop.id)]) ?? NSNull(),
            "callInNote2": workspace.callInNote([member(shop.id), maintainer]) ?? NSNull(),
            "heard": workspace.heardSinceLastTurn(in: chat) ?? NSNull(),
            "groupPrompts": groupPrompts,
            "candidates": texts.map { ["text": $0, "found": Workspace.botMentionCandidates(in: $0)] },
            "mentioned": mentionTexts.map { text in ["text": text, "ids": workspace.mentioned(in: text, among: members).map(\.id.uuidString)] },
            "pass": ["PASS", "pass.", "`PASS`", "PASS — not my area", "Passing thoughts", "", "  \n", "**Pass**", "I pass", "PASSED", "PASS\nmore"].map { ["text": $0, "pass": Workspace.isPass($0)] },
            "oneLine": ["a\nb\r\nc", String(repeating: "字", count: 50), "x\u{2028}y"].map { ["text": $0, "line": Workspace.oneLine($0, limit: 40)] },
            "groupNames": ["  Team A  ", "first\nsecond", String(repeating: "g", count: 70), "\n\nlate", ""].map { ["text": $0, "name": Workspace.groupName($0)] },
            "quoteNames": ["Main \"bot\"", "a\nb", String(repeating: "n", count: 45)].map { ["text": $0, "quoted": Workspace.quoteName($0)] },
        ]
        try JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys]).write(to: URL(filePath: path))
    }
}
