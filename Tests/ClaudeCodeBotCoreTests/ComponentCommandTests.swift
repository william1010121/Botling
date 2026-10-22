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

    @Test func commandsRunInTheFolderWithLimits() async throws {
        let folder = root.appending(path: "project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        func run(_ command: String, timeout: TimeInterval = 10, limit: Int = 100_000) async -> CommandOutcome {
            await ComponentCommands.execute(command, in: folder, timeout: timeout, limit: limit)
        }
        #expect(await run(#"printf '{"ok":true}'"#).data == #"{"ok":true}"#)
        let pwd = try #require(await run("pwd -P").data)
        #expect(pwd.hasSuffix("\(root.lastPathComponent)/project\""))
        let failed = await run("echo nope >&2; exit 3")
        #expect(failed.data == nil)
        #expect(failed.error?.contains("exit code 3") == true)
        #expect(failed.error?.contains("nope") == true)
        let slow = await run("sleep 5", timeout: 0.5)
        #expect(slow.data == nil)
        #expect(slow.error?.contains("took longer") == true)
        let loud = await run("yes | head -c 50000", limit: 1_000)
        #expect(loud.data == nil)
        #expect(loud.error?.contains("printed more than") == true)
        #expect(await ComponentCommands.execute("true", in: folder.appending(path: "gone"), timeout: 5, limit: 100).error?.contains("not there") == true)
    }

    /// Whether `pid` is gone, within a few seconds.
    func gone(_ pid: pid_t) async -> Bool {
        for _ in 0..<60 {
            if kill(pid, 0) != 0, errno == ESRCH { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return false
    }

    @Test(.wallClock) func stoppingACommandStopsWhatItStarted() async throws {
        let folder = root.appending(path: "project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Children that shrug off a polite stop outlive the shell unless their whole group is killed.
        // Timed where it runs, not across the hop back to the main actor: the other tests share
        // that actor and, in a busy parallel run, kept it for many seconds after the command ended.
        func execute(_ command: String, timeout: TimeInterval, limit: Int) async -> (CommandOutcome, took: TimeInterval) {
            await blocking {
                let started = Date()
                return (ComponentCommands.execute(command, in: folder, timeout: timeout, limit: limit), Date().timeIntervalSince(started))
            }
        }
        // The limit leaves the login shell time to start on a busy machine (it took over 1 s
        // under load, before the command could even write its pid).
        let (slow, _) = await execute("sh -c 'trap \"\" TERM; sleep 30 & echo $! > slow.pid; wait'", timeout: 5, limit: 100_000)
        #expect(slow.error?.contains("took longer") == true)
        let slowPID = try #require(pid_t(String(contentsOf: folder.appending(path: "slow.pid"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
        #expect(await gone(slowPID))
        let timeout: TimeInterval = 10
        let (loud, took) = await execute("sh -c 'trap \"\" TERM; sleep 30 > /dev/null & echo $! > loud.pid; sleep 0.3; yes'", timeout: timeout, limit: 1_000)
        #expect(loud.error?.contains("printed more than") == true)
        // Stopped once it went over, not by the time limit.
        #expect(took < timeout)
        let loudPID = try #require(pid_t(String(contentsOf: folder.appending(path: "loud.pid"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
        #expect(await gone(loudPID))
    }

    @Test func aCardsRunIsForItsCommandAndFolder() async {
        let commands = ComponentCommands(approvalsURL: root.appending(path: "a.json")) { command, folder in
            CommandOutcome(data: "\"\(command) in \(folder.path)\"")
        }
        let garden = URL(filePath: "/p/garden"), other = URL(filePath: "/p/other")
        for folder in [garden, other] { for command in ["ls", "pwd"] { commands.approve(command, in: folder) } }
        await commands.run(card: "m/0", command: "ls", in: garden)
        #expect(commands.state(for: "m/0", command: "ls", in: garden).data == #""ls in /p/garden""#)
        // Its command or folder changed: the old output is not shown under it, and it runs anew.
        #expect(commands.state(for: "m/0", command: "pwd", in: garden) == .init(status: .idle))
        #expect(commands.state(for: "m/0", command: "ls", in: other) == .init(status: .idle))
        await commands.run(card: "m/0", command: "pwd", in: garden)
        #expect(commands.state(for: "m/0", command: "pwd", in: garden).data == #""pwd in /p/garden""#)
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

    @Test func forgettingACommandAsksAgainAndIsRemembered() async {
        let file = root.appending(path: "approved-commands.json")
        let commands = ComponentCommands(approvalsURL: file) { _, _ in CommandOutcome(data: "[1]") }
        let garden = URL(filePath: "/p/garden"), other = URL(filePath: "/p/other")
        commands.approve("ls", in: garden)
        commands.approve("git diff --stat", in: garden)
        commands.approve("ls", in: other)
        await commands.run(card: "m/0", command: "ls", in: garden)
        #expect(commands.approvals.map { "\($0.folder) \($0.command)" } == ["/p/garden ls", "/p/garden git diff --stat", "/p/other ls"])

        commands.forget("ls", inFolderPath: "/p/garden")
        // The card that ran it asks again, and a refresh does not run it.
        #expect(commands.state(for: "m/0", command: "ls", in: garden).status == .approve)
        await commands.run(card: "m/0", command: "ls", in: garden, force: true)
        #expect(commands.runs["m/0"]?.status == .done)
        #expect(commands.isApproved("ls", in: other))
        commands.forget("git diff --stat", inFolderPath: "/p/garden")
        commands.forget("nothing", inFolderPath: "/p/none")
        #expect(commands.approved["/p/garden"] == nil)
        let later = ComponentCommands(approvalsURL: file)
        #expect(later.approvals.map(\.command) == ["ls"])
        #expect(!later.isApproved("ls", in: garden))
    }

    @Test func settingsListApprovedCommandsByBot() throws {
        let workspace = makeWorkspace()
        let home = workspace.mainBot.profile.workingDirectory
        workspace.componentCommands.approve("ls", in: home)
        workspace.componentCommands.approve("pwd", in: URL(filePath: "/nowhere/garden"))
        let listed = workspace.approvedCommands
        #expect(Set(listed.map(\.command)) == ["ls", "pwd"])
        let mine = try #require(listed.first { $0.command == "ls" })
        #expect(mine.owner == workspace.mainBot.profile.name)
        #expect(listed.first { $0.command == "pwd" }?.owner == "garden")
        workspace.forget(mine)
        #expect(workspace.approvedCommands.map(\.command) == ["pwd"])
        #expect(!workspace.componentCommands.isApproved("ls", in: home))
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
        // No data and no command: nothing is drawn (no error card in the user's chat; the bot
        // is told with the next message, see EmptyShowTests).
        #expect(shown[1]["status"] as? String == "empty")
        #expect(shown[1]["error"] == nil)
        #expect(shown[1]["command"] == nil)

        // Not allowed: asking for a run does nothing.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot)
        #expect(try displays()[0]["status"] as? String == "approve")
        let shownCommand = try #require(shown[0]["command"] as? String), shownFolder = try #require(shown[0]["folder"] as? String)
        // Allowing needs the command the card showed.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, approve: true)
        #expect(try displays()[0]["status"] as? String == "approve")
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: shownCommand, folder: shownFolder, approve: true)
        shown = try displays()
        #expect(shown[0]["status"] as? String == "done")
        #expect(shown[0]["data"] as? String == #"{"n":7}"#)
        #expect(shown[0]["ranAt"] != nil)
        #expect(workspace.componentCommands.isApproved(#"printf '{"n":7}'"#, in: bot.profile.workingDirectory))
    }

    @Test func allowingRunsOnlyTheCommandTheCardShowed() async throws {
        let workspace = makeWorkspace()
        let component = workspace.components.folder.appending(path: "usage")
        try FileManager.default.createDirectory(at: component, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: component.appending(path: "template.html"), atomically: true, encoding: .utf8)
        func declare(_ command: String) throws {
            try "Usage.\nCommand: `\(command)`".write(to: component.appending(path: "about.md"), atomically: true, encoding: .utf8)
            workspace.components.rescan()
        }
        try declare("printf '[1]'")
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "Usage:")
        message.displays = [ComponentInstance(name: "usage", data: "null")]
        bot.post(message, unread: false)
        let folder = workspace.commandFolder(for: message, in: bot)
        // The card showed printf '[1]'; about.md changed before the click.
        try declare("printf '[2]'")
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: "printf '[1]'", folder: folder.path, approve: true)
        #expect(!workspace.componentCommands.isApproved("printf '[2]'", in: folder))
        #expect(!workspace.componentCommands.isApproved("printf '[1]'", in: folder))
        #expect(workspace.componentCommands.runs.isEmpty)
        // Nor in another folder than the one shown.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: "printf '[2]'", folder: "/elsewhere", approve: true)
        #expect(!workspace.componentCommands.isApproved("printf '[2]'", in: folder))
        // What the card shows now is allowed and runs.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: "printf '[2]'", folder: folder.path, approve: true)
        #expect(workspace.componentCommands.isApproved("printf '[2]'", in: folder))
        #expect(workspace.componentCommands.state(for: "\(message.id.uuidString)/0", command: "printf '[2]'", in: folder).data == "[2]")
    }

    @Test func onlyTheChatPageItselfIsHeard() {
        #expect(PageMessages.accepts("componentCommand", fromMainFrame: true))
        #expect(PageMessages.accepts("answer", fromMainFrame: true))
        // A component's frame talks to the page (which answers for it), never to the app.
        #expect(!PageMessages.accepts("componentCommand", fromMainFrame: false))
        #expect(!PageMessages.accepts("choose", fromMainFrame: false))
        #expect(!PageMessages.accepts("send", fromMainFrame: false))
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

    // MARK: Detail commands (ccb.runDetail)

    @Test func aboutCanDeclareADetailCommand() {
        let about = "Commits.\nCommand: `git log --format=%h -20`\n- Detail command: `git show --patch --stat {hash}`\nData: …"
        #expect(ComponentLibrary.command(inAbout: about) == "git log --format=%h -20")
        #expect(ComponentLibrary.detailCommand(inAbout: about) == "git show --patch --stat {hash}")
        #expect(ComponentLibrary.detailCommand(inAbout: "Commits.\nCommand: git log") == nil)
        // A Detail command line is not taken for the Command.
        #expect(ComponentLibrary.command(inAbout: "Detail command: git show {hash}") == nil)
    }

    @Test func placeholdersAreFilledAsSingleQuotedArguments() {
        #expect(ComponentCommands.placeholders(in: "git diff {from} {to} -- {path} {from}") == ["from", "to", "path"])
        // Braces that are not {name} are left to the shell (awk, ${HOME}'s name is a placeholder).
        #expect(ComponentCommands.placeholders(in: "awk '{print $1}' {file}") == ["file"])
        #expect(ComponentCommands.detailCommand("git show --patch --stat {hash}", values: ["hash": "2aed630"]) == .success("git show --patch --stat '2aed630'"))
        #expect(ComponentCommands.detailCommand("git diff {a}..{b} -- {path}", values: ["a": "v1.0", "b": "HEAD", "path": "Sources/App_1.swift"])
            == .success("git diff 'v1.0'..'HEAD' -- 'Sources/App_1.swift'"))
        #expect(ComponentCommands.detailCommand("echo {x} {x}", values: ["x": "a"]) == .success("echo 'a' 'a'"))
        #expect(ComponentCommands.detailCommand("git log -5", values: [:]) == .success("git log -5"))
    }

    @Test func placeholderValuesAreChecked() {
        func problem(_ values: [String: String], _ template: String = "git show {hash}") -> String? {
            if case .failure(let problem) = ComponentCommands.detailCommand(template, values: values) { return problem.message }
            return nil
        }
        #expect(problem([:]) == "No value for {hash}.")
        #expect(problem(["hash": "abc", "path": "x"]) == "The Detail command has no {path}.")
        #expect(problem(["other": "abc"]) == "The Detail command has no {other}.")
        for bad in ["", "-p", "--output=/tmp/x", "a b", "a;rm", "$(id)", "`id`", "a'b", "a\"b", "a\nb", "é", "a|b", "a&b", "~/x", "*", String(repeating: "a", count: 201)] {
            #expect(problem(["hash": bad]) != nil, "\(bad) should be refused")
        }
        #expect(problem(["hash": String(repeating: "a", count: 200)]) == nil)
        #expect(problem(["hash": "../a/b.c_d-e"]) == nil)
        #expect(ComponentCommands.problem(withValue: "-x", for: "hash") == "The value for {hash} starts with \"-\".")
    }

    @Test func aDetailRunsOnlyOnceAllowedAndOnlyItsTemplate() async {
        let file = root.appending(path: "a.json")
        let ran = Ran()
        let commands = ComponentCommands(approvalsURL: file) { command, folder in
            ran.add(command)
            return CommandOutcome(data: #"{"ran":true}"#)
        }
        let folder = URL(filePath: "/tmp")
        let template = "git show --stat {hash}"
        var outcome = await commands.runDetail(template, values: ["hash": "2aed630"], in: folder)
        #expect(outcome.data == nil)
        #expect(outcome.error?.contains("not allowed yet") == true)
        #expect(ran.all.isEmpty)
        // The card's main command being allowed is not enough.
        commands.approve("git log", in: folder)
        #expect(await commands.runDetail(template, values: ["hash": "2aed630"], in: folder).data == nil)
        commands.approve(detail: template, in: folder)
        outcome = await commands.runDetail(template, values: ["hash": "2aed630"], in: folder)
        #expect(outcome.data == #"{"ran":true}"#)
        #expect(ran.all == ["git show --stat '2aed630'"])
        // A changed template, another folder, or a bad value: nothing runs.
        #expect(await commands.runDetail("git show {hash}; rm -rf .", values: ["hash": "2aed630"], in: folder).data == nil)
        #expect(await commands.runDetail(template, values: ["hash": "2aed630"], in: URL(filePath: "/elsewhere")).data == nil)
        #expect(await commands.runDetail(template, values: ["hash": "-p"], in: folder).error?.contains("starts with") == true)
        #expect(ran.all.count == 1)
        // Remembered, and listed with the allowed commands (so it can be taken back).
        let later = ComponentCommands(approvalsURL: file)
        #expect(later.isApproved(detail: template, in: folder))
        #expect(later.approvals.map(\.command).contains("Detail command: git show --stat {hash}"))
        later.forget("Detail command: git show --stat {hash}", inFolderPath: folder.standardizedFileURL.path)
        #expect(!later.isApproved(detail: template, in: folder))
    }

    @Test func aDetailsOutputIsDataWithTheCommandsLimits() async throws {
        let folder = root.appending(path: "project")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "inside".write(to: folder.appending(path: "note.txt"), atomically: true, encoding: .utf8)
        let commands = ComponentCommands(approvalsURL: root.appending(path: "a.json"))
        let json = #"printf '{"n":%s}' {n}"#, text = "cat {file}", fails = "ls {file}"
        for template in [json, text, fails] { commands.approve(detail: template, in: folder) }
        #expect(await commands.runDetail(json, values: ["n": "7"], in: folder).data == #"{"n":7}"#)
        // Run in the folder; plain text comes back as one JSON string.
        #expect(await commands.runDetail(text, values: ["file": "note.txt"], in: folder).data == #""inside""#)
        let failed = await commands.runDetail(fails, values: ["file": "missing.txt"], in: folder)
        #expect(failed.data == nil)
        #expect(failed.error?.contains("exit code") == true)
        // The same cap as the card's command.
        let big = await ComponentCommands.execute("head -c 3000 /dev/zero | tr '\\0' a", in: folder, timeout: 10, limit: 1000)
        #expect(big.error?.contains("more than 1 KB") == true)
    }

    @Test func theCardAllowsItsDetailCommandWithItsCommand() async throws {
        let workspace = makeWorkspace()
        let component = workspace.components.folder.appending(path: "commits")
        try FileManager.default.createDirectory(at: component, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: component.appending(path: "template.html"), atomically: true, encoding: .utf8)
        func declare(detail: String) throws {
            try "Commits.\nCommand: `printf '[1]'`\nDetail command: `\(detail)`".write(to: component.appending(path: "about.md"), atomically: true, encoding: .utf8)
            workspace.components.rescan()
        }
        try declare(detail: "printf '{\"hash\":\"%s\"}' {hash}")
        let bot = workspace.mainBot
        var message = ChatMessage(role: .bot, text: "Log:")
        message.displays = [ComponentInstance(name: "commits", data: "null")]
        bot.post(message, unread: false)
        let folder = workspace.commandFolder(for: message, in: bot)
        func shown() throws -> [String: Any] {
            let payload = ChatPayload.make(bot: bot, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: bot)) { _ in "" }
            let messages = try #require(try object(payload.json())["messages"] as? [[String: Any]])
            return try #require((messages.last?["displays"] as? [[String: Any]])?.first)
        }
        var card = try shown()
        #expect(card["status"] as? String == "approve")
        #expect(card["detail"] as? String == #"printf '{"hash":"%s"}' {hash}"#)
        // Not allowed yet: runDetail says so and runs nothing.
        var outcome = await workspace.runComponentDetail("commits", values: ["hash": "abc"], folder: folder.path)
        #expect(outcome.error?.contains("not allowed yet") == true)
        // Allowing without the Detail command the card showed allows nothing.
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: "printf '[1]'", folder: folder.path, approve: true)
        #expect(!workspace.componentCommands.isApproved("printf '[1]'", in: folder))
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: "printf '[1]'", folder: folder.path, detail: #"printf '{"hash":"%s"}' {hash}"#, approve: true)
        card = try shown()
        #expect(card["status"] as? String == "done")
        outcome = await workspace.runComponentDetail("commits", values: ["hash": "abc"], folder: folder.path)
        #expect(outcome.data == #"{"hash":"abc"}"#)
        // about.md's Detail command changed after the user allowed it: it does not run, and the card asks again.
        try declare(detail: "printf 'changed %s' {hash}")
        outcome = await workspace.runComponentDetail("commits", values: ["hash": "abc"], folder: folder.path)
        #expect(outcome.error?.contains("not allowed yet") == true)
        #expect(try shown()["status"] as? String == "approve")
        // A component without a Detail command.
        #expect(await workspace.runComponentDetail("nothing", values: [:], folder: folder.path).error?.contains("no Detail command") == true)
    }

    @Test func runDetailCallsAreReadAndAnsweredSafely() {
        #expect(ComponentCommands.detailValues(["hash": "abc", "n": NSNumber(value: 7)]) == ["hash": "abc", "n": "7"])
        #expect(ComponentCommands.detailValues(nil) == [:])
        #expect(ComponentCommands.detailValues(["b": NSNumber(value: true)]) == nil)
        #expect(ComponentCommands.detailValues(["x": NSNumber(value: 1.5)]) == nil)
        #expect(ComponentCommands.detailValues(["x": ["nested"]]) == nil)
        #expect(ComponentCommands.detailValues("text") == nil)
        #expect(ComponentCommands.detailReplyScript(3, CommandOutcome(data: #"{"a":"</script>"}"#)) == #"ccb.detailReply(3, true, "{\"a\":\"<\/script>\"}")"#)
        #expect(ComponentCommands.detailReplyScript(4, CommandOutcome(error: "No \"x\".")) == #"ccb.detailReply(4, false, "No \"x\".")"#)
    }

    // MARK: Leaving the page while a card runs

    @Test func aSavedDetailRunFinishesIntoItsCardAfterThePageIsLeft() async throws {
        // The card's own "rescan" button: a slow forced scan, whose output is the card's data.
        let gate = DispatchSemaphore(value: 0)
        let ran = Ran()
        let commands = ComponentCommands(approvalsURL: root.appending(path: "a.json")) { command, _ in
            ran.add(command)
            if command.contains("--force") {
                gate.wait()
                return CommandOutcome(data: #"{"free":27}"#)
            }
            return CommandOutcome(data: #"{"free":2.3}"#)
        }
        let folder = URL(filePath: "/p")
        let template = "scan --force {scan}"
        commands.approve("scan", in: folder)
        commands.approve(detail: template, in: folder)
        await commands.run(card: "m/0", command: "scan", in: folder)
        #expect(commands.state(for: "m/0", command: "scan", detail: template, in: folder).data == #"{"free":2.3}"#)

        // Pressed, then the user switches to another chat: the frame that asked is gone (its
        // task dropped, its answer has nowhere to go).
        let asked = Task { await commands.runDetail(template, values: ["scan": "now"], in: folder, saving: (card: "m/0", command: "scan")) }
        while commands.runs["m/0"]?.status != .running { await Task.yield() }
        asked.cancel()
        // Back on the chat, the card shows it still running, with the data it had.
        var state = commands.state(for: "m/0", command: "scan", detail: template, in: folder)
        #expect(state.status == .running)
        #expect(state.data == #"{"free":2.3}"#)
        // Pressing it again, or ↻, starts no second run: it waits for the one under way.
        let again = Task { await commands.runDetail(template, values: ["scan": "now"], in: folder, saving: (card: "m/0", command: "scan")) }
        await commands.run(card: "m/0", command: "scan", in: folder, force: true)
        gate.signal()
        #expect(await asked.value.data == #"{"free":27}"#)
        #expect(await again.value.data == #"{"free":27}"#)
        #expect(ran.all == ["scan", "scan --force 'now'"])
        // The finished scan is the card's data now, wherever it is drawn next.
        state = commands.state(for: "m/0", command: "scan", detail: template, in: folder)
        #expect(state.status == .done)
        #expect(state.data == #"{"free":27}"#)
        // A plain Detail call (a commit's diff) leaves the card's data as it was.
        gate.signal()
        #expect(await commands.runDetail(template, values: ["scan": "x"], in: folder).data == #"{"free":27}"#)
        #expect(commands.runs["m/0"]?.status == .done)
        #expect(commands.runs["m/0"]?.data == #"{"free":27}"#)
    }

    @Test func aRefreshedCardStillShowsItsNewDataAfterAnotherChatWasOpened() async throws {
        let workspace = makeWorkspace()
        let component = workspace.components.folder.appending(path: "disk")
        try FileManager.default.createDirectory(at: component, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: component.appending(path: "template.html"), atomically: true, encoding: .utf8)
        let detail = #"printf '{"free":27,"scan":"%s"}' {scan}"#
        try "Disk.\nCommand: `cat free.json`\nDetail command: `\(detail)`".write(to: component.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
        let bot = workspace.mainBot
        let folder = bot.profile.workingDirectory
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try #"{"free":2.3}"#.write(to: folder.appending(path: "free.json"), atomically: true, encoding: .utf8)
        var message = ChatMessage(role: .bot, text: "Disk:")
        message.displays = [ComponentInstance(name: "disk", data: "null")]
        bot.post(message, unread: false)
        // The chat page as the app sends it: only what changed, all of it again after a switch.
        var patcher = ChatPayload.Patcher()
        func page(_ chat: Bot) -> ChatPayload {
            ChatPayload.make(bot: chat, components: workspace.components, pending: [], replyingTo: nil, commands: workspace.commandContext(for: chat)) { _ in "" }
        }
        func cardAfterSwitchingBack() throws -> [String: Any] {
            _ = patcher.script(for: page(workspace.codexBot))
            let sent = patcher.script(for: page(bot))
            let script = try #require(sent)
            let json = script.dropFirst("ccb.patchState(".count).dropLast()
            let patch = try object(String(json))
            let changed = try #require(patch["changed"] as? [[String: Any]])
            let shown = try #require(changed.first { $0["id"] as? String == message.id.uuidString })
            return try #require((shown["displays"] as? [[String: Any]])?.first)
        }
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, command: "cat free.json", folder: folder.path, detail: detail, approve: true)
        _ = patcher.script(for: page(bot))
        #expect(try cardAfterSwitchingBack()["data"] as? String == #"{"free":2.3}"#)
        let firstRan = try #require(workspace.componentCommands.runs["\(message.id.uuidString)/0"]?.ranAt)

        // ↻ on the card's header: new output, still there after another chat was opened.
        try #"{"free":5}"#.write(to: folder.appending(path: "free.json"), atomically: true, encoding: .utf8)
        await workspace.runComponentCommand(messageID: message.id, index: 0, in: bot, force: true)
        var card = try cardAfterSwitchingBack()
        #expect(card["data"] as? String == #"{"free":5}"#)
        #expect(card["status"] as? String == "done")

        // The component's own "rescan" button (ccb.runDetail(values, {save: true})).
        #expect(card["card"] as? String == "\(message.id.uuidString)/0")
        let outcome = await workspace.runComponentDetail("disk", values: ["scan": "now"], folder: folder.path, card: card["card"] as? String, command: card["command"] as? String, in: bot)
        #expect(outcome.data == #"{"free":27,"scan":"now"}"#)
        card = try cardAfterSwitchingBack()
        #expect(card["data"] as? String == #"{"free":27,"scan":"now"}"#)
        #expect(try #require(workspace.componentCommands.runs["\(message.id.uuidString)/0"]?.ranAt) > firstRan)
    }

    @Test func aSavedDetailRunIsKeptOnItsPin() async throws {
        let workspace = makeWorkspace()
        let component = workspace.components.folder.appending(path: "disk")
        try FileManager.default.createDirectory(at: component, withIntermediateDirectories: true)
        try "<pre></pre>".write(to: component.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "Disk.\nCommand: `printf '{\"free\":2}'`\nDetail command: `printf '{\"free\":27,\"scan\":\"%s\"}' {scan}`".write(to: component.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
        let bot = workspace.mainBot
        let pin = try #require(workspace.pin(named: "disk", in: bot))
        let folder = workspace.pinFolder(for: bot)
        await workspace.runPin(pin.id, in: bot, command: #"printf '{"free":2}'"#, folder: folder.path, detail: #"printf '{"free":27,"scan":"%s"}' {scan}"#, approve: true)
        #expect(bot.pins.first?.data == #"{"free":2}"#)
        let outcome = await workspace.runComponentDetail("disk", values: ["scan": "now"], folder: folder.path, card: pin.card, command: #"printf '{"free":2}'"#)
        #expect(outcome.data == #"{"free":27,"scan":"now"}"#)
        // Kept on the pin, so the Board and its chip show it, after a restart too.
        #expect(bot.pins.first?.data == #"{"free":27,"scan":"now"}"#)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}

private final class Ran: @unchecked Sendable {
    private let lock = NSLock()
    private var commands: [String] = []
    var all: [String] { lock.withLock { commands } }
    func add(_ command: String) { lock.withLock { commands.append(command) } }
}
