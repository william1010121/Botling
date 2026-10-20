import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Components whose data comes from a CLI command (`<show name="x" command="…">`).
@MainActor
struct ComponentCommandTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-commands-\(UUID().uuidString)")

    func makeWorkspace() -> Workspace {
        let fake = FakeLauncher()
        return Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func object(_ json: String) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    // MARK: The tag

    @Test func showTagsCarryACommand() {
        let parsed = ReplyParser.parseAll("""
        Changes so far:
        <show name="diff" command="git diff --stat"></show>
        <show command='git log --format="%h %s" -3' name="log"/>
        <show name="usage" command="npx ccusage daily --json &amp;&amp; echo &quot;ok&quot;">{"title":"Usage"}</show>
        <show name="own"></show>
        <show name="plain">{"x":1}</show>
        """)
        #expect(parsed.body == "Changes so far:")
        #expect(parsed.displays.map(\.name) == ["diff", "log", "usage", "own", "plain"])
        #expect(parsed.displays.map(\.command) == ["git diff --stat", #"git log --format="%h %s" -3"#, #"npx ccusage daily --json && echo "ok""#, nil, nil])
        #expect(parsed.displays.map(\.data) == ["null", "null", #"{"title":"Usage"}"#, "null", #"{"x":1}"#])
    }

    @Test func showsWithoutACommandParseAsBefore() {
        #expect(ReplyParser.parseAll(#"<show name="x">{oops</show>OK"#).displays.isEmpty)
        #expect(ReplyParser.parseAll(#"<show name="x" command="ls">{oops</show>"#).displays.isEmpty)
        #expect(ReplyParser.parseAll(#"<show name="x">{"a":1}</show>"#).displays == [ComponentInstance(name: "x", data: #"{"a":1}"#, at: 0)])
    }

    @Test func aboutCanDeclareTheCommand() {
        #expect(ComponentLibrary.command(inAbout: "Usage card.\nCommand: `npx ccusage daily --json`\nData: …") == "npx ccusage daily --json")
        #expect(ComponentLibrary.command(inAbout: "- command: git diff --stat") == "git diff --stat")
        #expect(ComponentLibrary.command(inAbout: "No command here.\nCommands are nice.") == nil)
    }

    @Test func savedMessagesKeepTheirCommand() throws {
        var message = ChatMessage(role: .bot, text: "")
        message.displays = [ComponentInstance(name: "diff", data: "null", command: "git diff --stat")]
        let decoded = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
        #expect(decoded.shown.first?.command == "git diff --stat")
        // Saved by versions before commands.
        let old = try JSONDecoder().decode(ComponentInstance.self, from: Data(#"{"name":"a","data":"[1]"}"#.utf8))
        #expect(old.command == nil)
    }

    // MARK: Running

    @Test func outputBecomesData() {
        #expect(ComponentCommands.data(fromOutput: "{\"a\": 1}\n") == "{\"a\": 1}")
        #expect(ComponentCommands.data(fromOutput: "[1,2]") == "[1,2]")
        #expect(ComponentCommands.data(fromOutput: " 2 files changed, 3 insertions(+)\n") == #"" 2 files changed, 3 insertions(+)""#)
        #expect(ComponentCommands.data(fromOutput: "") == #""""#)
        #expect(ComponentCommands.data(fromOutput: "a/b \"c\"\nd\n") == #""a/b \"c\"\nd""#)
    }

    @Test func commandsRunInTheFolderWithLimits() throws {
        let folder = root.appending(path: "project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        func run(_ command: String, timeout: TimeInterval = 10, limit: Int = 100_000) -> CommandOutcome {
            ComponentCommands.execute(command, in: folder, timeout: timeout, limit: limit)
        }
        #expect(run(#"printf '{"ok":true}'"#).data == #"{"ok":true}"#)
        let pwd = try #require(run("pwd -P").data)
        #expect(pwd.hasSuffix("\(root.lastPathComponent)/project\""))
        let failed = run("echo nope >&2; exit 3")
        #expect(failed.data == nil)
        #expect(failed.error?.contains("exit code 3") == true)
        #expect(failed.error?.contains("nope") == true)
        let slow = run("sleep 5", timeout: 0.5)
        #expect(slow.data == nil)
        #expect(slow.error?.contains("took longer") == true)
        let loud = run("yes | head -c 50000", limit: 1_000)
        #expect(loud.data == nil)
        #expect(loud.error?.contains("printed more than") == true)
        #expect(ComponentCommands.execute("true", in: folder.appending(path: "gone"), timeout: 5, limit: 100).error?.contains("not there") == true)
    }

    @Test func nothingRunsUntilAllowedAndAllowingIsRemembered() async {
        let file = root.appending(path: "approved-commands.json")
        let count = Counter()
        let commands = ComponentCommands(approvalsURL: file) { command, _ in
            count.add()
            return CommandOutcome(data: "[\(count.value)]")
        }
        let folder = URL(filePath: "/p/garden")
        #expect(commands.state(for: "m/0", command: "ls", in: folder).status == .approve)
        await commands.run(card: "m/0", command: "ls", in: folder)
        #expect(count.value == 0)
        commands.approve("ls", in: folder)
        #expect(commands.state(for: "m/0", command: "ls", in: folder).status == .idle)
        await commands.run(card: "m/0", command: "ls", in: folder)
        #expect(commands.state(for: "m/0", command: "ls", in: folder) == .init(status: .done, data: "[1]", ranAt: commands.runs["m/0"]?.ranAt))
        // Drawn again: not run again unless refreshed.
        await commands.run(card: "m/0", command: "ls", in: folder)
        #expect(count.value == 1)
        await commands.run(card: "m/0", command: "ls", in: folder, force: true)
        #expect(commands.runs["m/0"]?.data == "[2]")
        // Per project and command, and kept for next time.
        let later = ComponentCommands(approvalsURL: file)
        #expect(later.isApproved("ls", in: folder))
        #expect(!later.isApproved("ls -a", in: folder))
        #expect(!later.isApproved("ls", in: URL(filePath: "/p/other")))
    }

    @Test func aFailedRunSaysWhy() async {
        let commands = ComponentCommands(approvalsURL: root.appending(path: "a.json")) { _, _ in CommandOutcome(error: "The command failed (exit code 1).") }
        let folder = URL(filePath: "/p")
        commands.approve("false", in: folder)
        await commands.run(card: "c", command: "false", in: folder)
        #expect(commands.runs["c"]?.status == .failed)
        #expect(commands.runs["c"]?.error == "The command failed (exit code 1).")
    }

    // MARK: In the chat

    @Test func theCardAsksThenShowsTheOutput() async throws {
        let home = root.appending(path: "ccb/main")
        var message = ChatMessage(role: .bot, text: "Here:")
        message.displays = [
            ComponentInstance(name: "choices", data: "null", at: 5, command: #"printf '{"n":7}'"#),
            ComponentInstance(name: "choices", data: "null", at: 5),
        ]
        BotStore(directory: home).save(messages: [message])
        let workspace = makeWorkspace()
        let bot = workspace.mainBot
        func displays() throws -> [[String: Any]] {
            let payload = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot)) { _ in "" }
            let messages = try #require(try object(payload.json())["messages"] as? [[String: Any]])
            return try #require(messages.first?["displays"] as? [[String: Any]])
        }
        var shown = try displays()
        #expect(shown[0]["status"] as? String == "approve")
        #expect(shown[0]["command"] as? String == #"printf '{"n":7}'"#)
        #expect(shown[0]["folder"] as? String == bot.profile.workingDirectory.path)
        // No data and no command: a clear error instead of an empty component.
        #expect(shown[1]["status"] as? String == "failed")
        #expect(shown[1]["command"] == nil)

        // Not allowed: asking for a run does nothing.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot)
        #expect(try displays()[0]["status"] as? String == "approve")
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, approve: true)
        shown = try displays()
        #expect(shown[0]["status"] as? String == "done")
        #expect(shown[0]["data"] as? String == #"{"n":7}"#)
        #expect(shown[0]["ranAt"] != nil)
        #expect(workspace.componentCommands.isApproved(#"printf '{"n":7}'"#, in: bot.profile.workingDirectory))
    }

    @Test func aComponentsOwnCommandIsUsedWhenTheShowHasNone() throws {
        let workspace = makeWorkspace()
        let folder = workspace.components.folder.appending(path: "usage")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "Usage per day.\nCommand: `npx ccusage daily --json`".write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
        let bot = ChatMessage(role: .bot, text: "")
        #expect(ChatPayload.command(of: ComponentInstance(name: "usage", data: "null"), in: bot, library: workspace.components) == "npx ccusage daily --json")
        // Data written out wins; and only a bot's lines run commands.
        #expect(ChatPayload.command(of: ComponentInstance(name: "usage", data: "[1]"), in: bot, library: workspace.components) == nil)
        #expect(ChatPayload.command(of: ComponentInstance(name: "usage", data: "null", command: "ls"), in: ChatMessage(role: .user, text: ""), library: workspace.components) == nil)
        #expect(workspace.componentBriefing().contains("command=\""))
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}
