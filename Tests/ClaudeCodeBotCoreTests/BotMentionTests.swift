import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// A bot that starts a line of its own reply with @Name calls that bot into its chat, the way
/// the user's @ does: the named bot reads the chat and answers there, once.
@MainActor
struct BotMentionTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-bot-mention-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func folder(_ name: String) throws -> URL {
        let url = root.appending(path: "code/\(name)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func owner(of agent: FakeAgent) -> String { agent.launch.workingDirectory.lastPathComponent }

    /// The call-in prompts sent to bots.
    static func calledPrompts(_ fake: FakeLauncher) -> [String] {
        fake.agents.flatMap(\.sent).filter { $0.contains("called you in") }
    }

    /// garden answers the user with `reply`; whoever it calls in answers "Yes, still mine."
    func gardenReplying(_ reply: String) -> FakeLauncher {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("called you in") { return "Yes, still mine." }
            if text.contains("Please ask") { return reply }
            return isAppOnly(text) ? "OK" : "Got it"
        }
        return fake
    }

    /// Regression: Maintainer was told "有問題就直接 @ 他", wrote "@botling …" in its reply, and
    /// botling never heard it — a bot's @ was only text.
    @Test func aBotsOwnLineStartingWithAtReachesTheNamedBot() async throws {
        let fake = gardenReplying("Checking with them.\n@Maintainer is the flag component still yours?")
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))

        await workspace.send("Please ask who owns the flag", to: chat)
        await eventually { chat.messages.contains { $0.sourceID == Workspace.maintainerID } }
        await workspace.callInQueues[garden.id]?.value

        // Maintainer was asked once, and told the bot (not the user) called it in.
        let prompts = Self.calledPrompts(fake)
        #expect(prompts.count == 1)
        let prompt = try #require(prompts.first)
        #expect(prompt.contains("is the flag component still yours?"))
        #expect(prompt.contains("\"garden\" called you into its own chat with @"))
        #expect(prompt.contains("not the user's request"))
        // Its answer is in garden's chat under its own name; its own chat keeps the exchange.
        let answer = try #require(chat.messages.first { $0.sourceID == Workspace.maintainerID })
        #expect(answer.text == "Yes, still mine.")
        #expect(workspace.maintainer.messages.map(\.role) == [.notice, .bot])
        #expect(workspace.callInSpeakers.isEmpty)
    }

    @Test func mentionsInProseQuotesAndCodeStayText() async throws {
        let replies = [
            "I could ask @Maintainer about it later.",
            "> @Maintainer is it yours?\nThat is what the user wrote before.",
            "Run this:\n```\n@Maintainer is it yours?\n```",
            "`@Maintainer is it yours?` is the syntax.",
            "@garden note to self",
            "@Nobody is it yours?",
            "mail me@Maintainer.com",
        ]
        for reply in replies {
            let fake = gardenReplying(reply)
            let workspace = makeWorkspace(fake)
            let garden = workspace.addProject(folder: try folder("garden"))
            let chat = try #require(workspace.bot(for: garden))
            await workspace.send("Please ask who owns the flag", to: chat)
            await eventually { chat.messages.contains { $0.role == .bot && $0.sourceID == nil } }
            await workspace.callInQueues[garden.id]?.value
            #expect(workspace.callInQueues[garden.id] == nil, "\(reply)")
            #expect(Self.calledPrompts(fake).isEmpty, "\(reply)")
        }
    }

    /// One bot per reply: two different bots named is no broadcast; it says so instead.
    @Test func twoBotsInOneReplyCallNobodyAndSaySo() async throws {
        let fake = gardenReplying("@Maintainer is it yours?\n@Main bot is it yours?")
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("Please ask who owns the flag", to: chat)
        await eventually { chat.messages.contains { $0.role == .notice } }
        #expect(Self.calledPrompts(fake).isEmpty)
        #expect(workspace.callInQueues[garden.id] == nil)
    }

    /// The same reply heard again (a repeated callback, or after the app restarts) is not
    /// delivered again: what was delivered is kept on disk.
    @Test func theSameReplyIsDeliveredOnceAcrossRestarts() async throws {
        let fake = gardenReplying("@Maintainer is the flag component still yours?")
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("Please ask who owns the flag", to: chat)
        await eventually { chat.messages.contains { $0.sourceID == Workspace.maintainerID } }
        await workspace.callInQueues[garden.id]?.value
        let reply = try #require(chat.messages.first { $0.role == .bot && $0.sourceID == nil })

        workspace.receiveBotMention(reply, from: chat)
        await workspace.callInQueues[garden.id]?.value
        #expect(Self.calledPrompts(fake).count == 1)

        let reopened = makeWorkspace(fake)
        let again = try #require(reopened.bot(for: garden))
        reopened.receiveBotMention(reply, from: again)
        await reopened.callInQueues[garden.id]?.value
        #expect(Self.calledPrompts(fake).count == 1)
    }

    /// A called-in bot's answer is never dispatched: "@garden …" in it reaches nobody, and its
    /// tags do not act, so two bots cannot keep pinging each other.
    @Test func aCalledInBotsAnswerDoesNotCallBack() async throws {
        let fake = FakeLauncher()
        fake.respond = { text in
            if text.contains("called you in") { return "@garden yes, and is the button yours?\n<handoff to=\"codex\" kind=\"task\">ping garden</handoff>" }
            if text.contains("Please ask") { return "@Maintainer is it yours?" }
            return isAppOnly(text) ? "OK" : "Got it"
        }
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("Please ask who owns the flag", to: chat)
        await eventually { chat.messages.contains { $0.sourceID == Workspace.maintainerID } }
        await workspace.callInQueues[garden.id]?.value
        await workspace.callInQueues[Workspace.maintainerID]?.value
        // Maintainer answered once; garden was not called back, in either chat.
        #expect(Self.calledPrompts(fake).count == 1)
        let gardenAgent = try #require(fake.agents.first { Self.owner(of: $0) == "garden" })
        #expect(!gardenAgent.sent.contains { $0.contains("called you in") })
        #expect(workspace.callInQueues[Workspace.maintainerID] == nil)
        #expect(!workspace.maintainer.messages.contains { $0.sourceID == garden.id })
        #expect(chat.messages.first { $0.sourceID == Workspace.maintainerID }?.text.hasPrefix("@garden yes") == true)
    }

    /// A bot that keeps calling the same bot without the user speaking is stopped.
    @Test func repeatedCallsWithoutTheUserAreBounded() async throws {
        let fake = gardenReplying("@Maintainer is it yours?")
        let workspace = makeWorkspace(fake)
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("Please ask who owns the flag", to: chat)
        await eventually { chat.messages.contains { $0.sourceID == Workspace.maintainerID } }
        await workspace.callInQueues[garden.id]?.value
        // Further replies of its own (background work reporting back), each a new message.
        for n in 0..<5 {
            var line = ChatMessage(role: .bot, text: "@Maintainer still yours? (\(n))")
            line.engine = chat.engine
            chat.post(line, unread: false)
            workspace.receiveBotMention(line, from: chat)
            await workspace.callInQueues[garden.id]?.value
        }
        #expect(Self.calledPrompts(fake).count == Workspace.botMentionsPerUserLine)
    }

    /// A two-head bot that is called in answers from one head, as with the user's @.
    @Test func aTwoHeadBotIsAskedOnOneHeadOnly() async throws {
        let fake = gardenReplying("@Maintainer is the flag component still yours?")
        let workspace = makeWorkspace(fake)
        await workspace.maintainer.setHeads([.claude, .codex])
        let garden = workspace.addProject(folder: try folder("garden"))
        let chat = try #require(workspace.bot(for: garden))
        await workspace.send("Please ask who owns the flag", to: chat)
        await eventually { chat.messages.contains { $0.sourceID == Workspace.maintainerID } }
        await workspace.callInQueues[garden.id]?.value
        let asked = fake.agents.filter { $0.sent.contains { $0.contains("called you in") } }
        #expect(asked.count == 1)
        #expect(chat.messages.filter { $0.sourceID == Workspace.maintainerID }.count == 1)
    }
}
