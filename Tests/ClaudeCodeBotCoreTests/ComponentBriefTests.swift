import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// "Make into component" asks a fork of the bot that wrote the reply (`claude --resume <session>
/// --fork-session`, read-only, out of the chat) for a brief for Maintainer: what it is for, the
/// user's own message, each data field and whether a CLI command can get it. Without a brief (no
/// session, the fork failed or took too long) the request still carries the user's message.
/// Pinning a bot-filled component whose about.md suggests a `Board command:` has Maintainer give
/// it a Command, so the same component refreshes on the Board.
@MainActor
struct ComponentBriefTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-brief-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher = FakeLauncher()) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func addComponent(_ name: String, about: String, to workspace: Workspace) throws {
        let folder = workspace.components.folder.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "<p>\(name)</p>".write(to: folder.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try about.write(to: folder.appending(path: "about.md"), atomically: true, encoding: .utf8)
        workspace.components.rescan()
    }

    func relays(_ workspace: Workspace) -> [ChatMessage] {
        workspace.maintainer.messages.filter { $0.role == .relay }
    }

    static let asked = "幫我看一下 GPU 現在的使用率，順便說要不要換卡"

    /// The user's message, then the bot's reply written in `session`.
    @discardableResult
    func exchange(in bot: Bot, session: UUID? = UUID()) -> (asked: ChatMessage, reply: ChatMessage) {
        let asked = ChatMessage(role: .user, text: Self.asked)
        bot.post(asked, unread: false)
        var reply = ChatMessage(role: .bot, text: "GPU 0 使用率 87%，溫度 71°C。建議：先不用換卡。")
        reply.steps = [Step(id: "1", kind: .tool, tool: "Bash", title: "Run nvidia-smi", detail: "nvidia-smi --query-gpu=utilization.gpu,temperature.gpu --format=csv", done: true)]
        reply.session = session
        bot.post(reply, unread: false)
        return (asked, reply)
    }

    /// Records each job and answers with `answer`.
    final class Briefs: @unchecked Sendable {
        private let lock = NSLock()
        private var _jobs: [BriefJob] = []
        var jobs: [BriefJob] { lock.withLock { _jobs } }
        let answer: String?
        let delay: Duration

        init(answer: String?, delay: Duration = .zero) {
            self.answer = answer
            self.delay = delay
        }

        var writer: BriefWriter {
            { [self] job in
                lock.withLock { _jobs.append(job) }
                try? await Task.sleep(for: delay)
                return answer
            }
        }
    }

    // MARK: The fork

    @Test func theForkResumesTheBotsSessionReadOnlyWithoutKeepingIt() {
        let session = UUID()
        let job = BriefJob(session: session, model: .opus, effort: .high, folder: URL(filePath: "/tmp/garden"), prompt: "Write a brief")
        let launch = ComponentBrief.launch(for: job)
        #expect(launch.resume)
        #expect(launch.forkSession)
        #expect(!launch.persistSession)
        #expect(launch.model == .opus)
        #expect(launch.effort == .high)
        #expect(launch.workingDirectory.path == "/tmp/garden")
        #expect(!launch.autoMode)
        #expect(!launch.asksPermission)
        let arguments = ClaudeAgentProcess.arguments(for: launch)
        let joined = arguments.joined(separator: " ")
        #expect(joined.contains("--resume \(session.uuidString.lowercased())"))
        #expect(arguments.contains("--fork-session"))
        #expect(arguments.contains("--no-session-persistence"))
        #expect(!arguments.contains("--session-id"))
        let allowed = arguments.firstIndex(of: "--allowedTools").map { arguments[$0 + 1] }
        #expect(allowed == "Read,Grep,Glob")
        let disallowed = arguments.firstIndex(of: "--disallowedTools").map { arguments[$0 + 1] } ?? ""
        for tool in ["Bash", "Write", "Edit", "Agent"] { #expect(disallowed.contains(tool)) }
        // A bot's own launch keeps its session.
        let own = ClaudeAgentProcess.arguments(for: AgentLaunch(model: .sonnet, sessionID: session, workingDirectory: URL(filePath: "/tmp"), systemPrompt: ""))
        #expect(!own.contains("--fork-session"))
        #expect(!own.contains("--no-session-persistence"))
    }

    @Test func theForkIsAskedForPurposeTheUsersMessageAndEachFieldsSource() {
        let message = ChatMessage(role: .bot, text: "GPU 0 使用率 87%")
        let prompt = ComponentBrief.request(reply: message, asked: Self.asked, folder: "/tmp/garden")
        #expect(prompt.contains("<component-brief>"))
        #expect(prompt.contains("verbatim"))
        for group in ComponentFieldGroup.allCases { #expect(prompt.contains(group.label)) }
        #expect(prompt.contains("Board command"))
        #expect(prompt.contains("/tmp/garden"))
        #expect(prompt.contains(Self.asked))
        // It changes nothing and does not do the work again.
        #expect(prompt.contains("run nothing"))
    }

    @Test func theBriefIsWhatTheTagHolds() {
        #expect(ComponentBrief.brief(from: "Sure.\n<component-brief>\nPurpose: GPU\n</component-brief>") == "Purpose: GPU")
        #expect(ComponentBrief.brief(from: "Purpose: GPU, plain") == "Purpose: GPU, plain")
        #expect(ComponentBrief.brief(from: "  \n") == nil)
        #expect(ComponentBrief.brief(from: "<component-brief> </component-brief>") == nil)
    }

    @Test func theWriterStartsTheForkAndEndsItWithItsBrief() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "<component-brief>Purpose: GPU load</component-brief>" }
        let writer = ComponentBrief.writer(launcher: fake.launcher)
        let job = BriefJob(session: UUID(), model: .sonnet, folder: URL(filePath: "/tmp"), prompt: "Write a brief", timeout: 5)
        let brief = await writer(job)
        #expect(brief == "Purpose: GPU load")
        let agent = try #require(fake.agents.first)
        #expect(agent.launch.forkSession)
        #expect(agent.launch.sessionID == job.session)
        #expect(agent.sent == ["Write a brief"])
        #expect(agent.finished)
    }

    @Test func theWriterGivesUpWhenTheForkTakesTooLongOrFails() async throws {
        let silent = FakeLauncher()
        silent.respond = { _ in nil }
        let job = BriefJob(session: UUID(), model: .sonnet, folder: URL(filePath: "/tmp"), prompt: "Write a brief", timeout: 0.2)
        #expect(await ComponentBrief.writer(launcher: silent.launcher)(job) == nil)
        #expect(silent.agents.first?.finished == true)
        let failing: AgentLauncher = { _ in throw CocoaError(.featureUnsupported) }
        #expect(await ComponentBrief.writer(launcher: failing)(job) == nil)
    }

    // MARK: Make into component

    @Test func makingOneAsksAForkForABriefThenHandsItToMaintainer() async throws {
        let workspace = makeWorkspace()
        let briefs = Briefs(answer: "Purpose: GPU load at a glance.\nFields: util (From command: nvidia-smi …), advice (Optional (bot only))", delay: .milliseconds(100))
        workspace.briefWriter = briefs.writer
        let bot = workspace.mainBot
        bot.sessionExists = { _, _ in true }
        let (_, reply) = exchange(in: bot)
        let lines = bot.messages.count
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        #expect(spec.status == .building)
        // Nothing goes to Maintainer until the brief is in.
        #expect(relays(workspace).isEmpty)
        #expect(spec.conversation.last?.text.contains("brief") == true)
        await eventually { !relays(workspace).isEmpty }
        let job = try #require(briefs.jobs.first)
        #expect(job.session == reply.session)
        #expect(job.model == bot.model)
        #expect(job.folder.standardizedFileURL == bot.profile.workingDirectory.standardizedFileURL)
        #expect(job.prompt.contains(Self.asked))
        let relay = try #require(relays(workspace).first)
        #expect(relay.text.hasPrefix(ComponentAction.buildFirst.header(spec.id.uuidString)))
        #expect(relay.text.contains("Purpose: GPU load at a glance."))
        #expect(relay.text.contains(Self.asked))
        #expect(relay.text.contains("GPU 0 使用率 87%"))
        // Kept on the spec.
        #expect(bot.specs.first?.brief?.contains("Purpose: GPU load") == true)
        // The bot's own chat is untouched and it was not woken.
        #expect(bot.messages.count == lines)
        #expect(bot.phase == .asleep)
        #expect(relays(workspace).count == 1)
    }

    @Test func withoutABriefTheRequestStillCarriesTheUsersMessage() async throws {
        let workspace = makeWorkspace()
        let briefs = Briefs(answer: nil)
        workspace.briefWriter = briefs.writer
        let bot = workspace.mainBot
        bot.sessionExists = { _, _ in true }
        let (_, reply) = exchange(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        await eventually { !relays(workspace).isEmpty }
        let relay = try #require(relays(workspace).first)
        #expect(relay.text.hasPrefix(ComponentAction.buildFirst.header(spec.id.uuidString)))
        #expect(relay.text.contains(Self.asked))
        #expect(!relay.text.contains("brief for you"))
        #expect(bot.specs.first?.brief == nil)
        #expect(bot.specs.first?.conversation.contains { $0.text.contains("no brief") } == true)
    }

    @Test func aReplyWithNoSessionLeftGoesToMaintainerRightAway() throws {
        let workspace = makeWorkspace()
        let briefs = Briefs(answer: "never asked")
        workspace.briefWriter = briefs.writer
        let bot = workspace.mainBot
        // The transcript is gone (or the reply is from before sessions were kept).
        bot.sessionExists = { _, _ in false }
        let (_, reply) = exchange(in: bot)
        _ = try #require(workspace.makeComponent(from: reply.id, in: bot))
        let relay = try #require(relays(workspace).first)
        #expect(relay.text.contains(Self.asked))
        #expect(briefs.jobs.isEmpty)
        let (_, old) = exchange(in: bot, session: nil)
        _ = try #require(workspace.makeComponent(from: old.id, in: bot))
        #expect(relays(workspace).count == 2)
        #expect(briefs.jobs.isEmpty)
    }

    @Test func aCancelledSpecSendsNothingWhenTheBriefComes() async throws {
        let workspace = makeWorkspace()
        let briefs = Briefs(answer: "Purpose: x", delay: .milliseconds(200))
        workspace.briefWriter = briefs.writer
        let bot = workspace.mainBot
        bot.sessionExists = { _, _ in true }
        let (_, reply) = exchange(in: bot)
        let spec = try #require(workspace.makeComponent(from: reply.id, in: bot))
        workspace.cancelSpec(spec.id, in: bot)
        await eventually { !briefs.jobs.isEmpty }
        try await Task.sleep(for: .milliseconds(400))
        #expect(relays(workspace).isEmpty)
    }

    @Test func aBotsReplyKeepsTheSessionThatWroteIt() async throws {
        let fake = FakeLauncher()
        let bot = makeBot(fake)
        bot.send("hi")
        await eventually { bot.messages.last?.role == .bot }
        let session = try #require(fake.agents.first?.launch.sessionID)
        #expect(bot.messages.last?.session == session)
    }

    // MARK: Field groups

    @Test func maintainerIsToldToSplitFieldsAndSuggestABoardCommand() {
        let spec = ComponentSpec(name: "gpu", folder: "/tmp", bots: ["main"])
        let request = ComponentSpecs.firstBuildRequest(spec, reply: "GPU 87%", asked: Self.asked, brief: "Purpose: GPU", from: "main")
        for group in ComponentFieldGroup.allCases { #expect(request.contains(group.label)) }
        #expect(request.contains("Board command:"))
        #expect(request.contains("missing"))
        #expect(request.contains(Self.asked))
        #expect(request.contains("Purpose: GPU"))
        let build = ComponentSpecs.buildRequest(spec)
        #expect(build.contains(ComponentFieldGroup.botOnly.label))
        #expect(ComponentPrompts.system.contains(ComponentFieldGroup.botOnly.label))
        #expect(ComponentPrompts.system.contains("Board command:"))
        #expect(PluginGuide.text(builtIns: "/x").contains("Board command:"))
    }

    @Test func aBoardCommandLineIsASuggestionNotTheCommand() {
        let about = "GPU card.\nCommand line: none\nBoard command: `nvidia-smi --format=csv`\n"
        #expect(ComponentLibrary.boardCommand(inAbout: about) == "nvidia-smi --format=csv")
        #expect(ComponentLibrary.command(inAbout: about) == nil)
    }

    // MARK: Pinned to the Board

    /// A built spec the bot filled, of a component whose about.md suggests a Board command.
    func filledSpec(in workspace: Workspace, about: String) throws -> (Bot, ComponentSpec) {
        try addComponent("gpu-card", about: about, to: workspace)
        let bot = workspace.mainBot
        let (_, reply) = exchange(in: bot, session: nil)
        var spec = ComponentSpec(messageID: reply.id, name: "gpu-card", folder: bot.profile.workingDirectory.path, bots: [bot.name])
        spec.status = .done
        spec.built = "gpu-card"
        spec.filledBy = bot.name
        spec.filled = #"{"util":87,"advice":"先不用換卡"}"#
        bot.editSpecs { $0.append(spec) }
        return (bot, spec)
    }

    @Test func pinningABotFilledComponentHasMaintainerMakeItLive() async throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try filledSpec(in: workspace, about: "GPU load.\nBoard command: nvidia-smi --query-gpu=utilization.gpu --format=csv\n")
        let pin = try #require(workspace.pin(spec: spec.id, in: bot))
        #expect(pin.name == "gpu-card")
        #expect(pin.command == nil)
        #expect(pin.data == #"{"util":87,"advice":"先不用換卡"}"#)
        #expect(bot.pins.first?.makingLive == true)
        let relay = try #require(relays(workspace).last)
        #expect(relay.text.contains("gpu-card"))
        #expect(relay.text.contains("nvidia-smi --query-gpu=utilization.gpu --format=csv"))
        #expect(relay.text.contains("Command:"))
        #expect(relay.text.contains(bot.profile.workingDirectory.path))
        #expect(relay.text.hasPrefix(ComponentAction.liveOnBoard.header("gpu-card")))
        // The pin says so while it waits.
        let view = ChatPayload.pin(view: try #require(bot.pins.first), context: workspace.pinContext(for: bot, board: true))
        #expect(view.makingLive == true)

        // Asked once for that component.
        workspace.unpin(pin.id, in: bot)
        _ = try #require(workspace.pin(spec: spec.id, in: bot))
        #expect(relays(workspace).count == 1)

        // Its Command lands: the same pin runs it from now on, once the user allows it.
        try addComponent("gpu-card", about: "GPU load.\nCommand: node board.mjs\nBoard command: nvidia-smi --query-gpu=utilization.gpu --format=csv\n", to: workspace)
        workspace.finishBoardCommands()
        let live = try #require(bot.pins.first)
        #expect(live.command == "node board.mjs")
        #expect(live.makingLive != true)
        #expect(live.refresh == .shown)
        #expect(live.data == #"{"util":87,"advice":"先不用換卡"}"#)
        #expect(workspace.componentCommands.runs.isEmpty)
        let shown = ChatPayload.pin(view: live, context: workspace.pinContext(for: bot, board: true))
        #expect(shown.makingLive == nil)
        #expect(shown.display.status == ComponentCommands.Status.approve.rawValue)
        // The chat keeps the bot's fill.
        #expect(ChatPayload.specCommand(try #require(bot.specs.first), component: "gpu-card", library: workspace.components) == nil)
    }

    @Test func aComponentWithoutABoardCommandIsPinnedAsItIs() throws {
        let workspace = makeWorkspace()
        let (bot, spec) = try filledSpec(in: workspace, about: "GPU advice only.\n")
        let pin = try #require(workspace.pin(spec: spec.id, in: bot))
        #expect(pin.command == nil)
        #expect(bot.pins.first?.makingLive != true)
        #expect(relays(workspace).isEmpty)
    }

    @Test func pinningFromAMessageAlsoMakesItLive() throws {
        let workspace = makeWorkspace()
        try addComponent("gpu-card", about: "GPU load.\nBoard command: nvidia-smi\n", to: workspace)
        let bot = workspace.mainBot
        var reply = ChatMessage(role: .bot, text: "GPU")
        reply.displays = [ComponentInstance(name: "gpu-card", data: #"{"util":87}"#)]
        bot.post(reply, unread: false)
        _ = try #require(workspace.pin(messageID: reply.id, index: 0, in: bot))
        #expect(bot.pins.first?.makingLive == true)
        #expect(relays(workspace).count == 1)
    }

    @Test func aPinSavedWhileMakingItLiveStillSaysSo() throws {
        var pin = PinnedComponent(name: "gpu-card", data: "{}")
        pin.makingLive = true
        let data = try JSONEncoder().encode(pin)
        #expect(try JSONDecoder().decode(PinnedComponent.self, from: data).makingLive == true)
        let old = #"{"id":"\#(UUID().uuidString)","name":"x","data":"{}","refresh":"manual","minutes":15,"size":"2x2"}"#
        #expect(try JSONDecoder().decode(PinnedComponent.self, from: Data(old.utf8)).makingLive == false)
    }
}
