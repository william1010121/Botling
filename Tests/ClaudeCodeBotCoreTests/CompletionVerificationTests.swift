import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct CompletionVerificationTests {
    private func open(_ root: URL, _ fake: FakeLauncher,
                      classify: @escaping (String) -> PromiseCheck.Classifier) -> Workspace {
        Workspace(root: root, launcher: fake.launcher, completionClassifier: classify) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }
    private func model(_ id: String, efforts: [String]? = ["medium"]) -> CodexModel {
        .init(id: id, name: id, isDefault: false, supportedReasoningEfforts: efforts)
    }

    @Test func catalogueAndLegacySettings() throws {
        let line = #"{"id":2,"result":{"data":[{"id":"available","supportedReasoningEfforts":[{"reasoningEffort":"medium"}]},{"id":"low-only","supportedReasoningEfforts":[{"reasoningEffort":"low"}]},{"id":"unknown"},{"id":"hidden","hidden":true,"supportedReasoningEfforts":[{"reasoningEffort":"medium"}]}]}}"#
        #expect(try #require(CodexModels.parse(line)).filter(\.supportsCompletionVerification).map(\.id) == ["available"])
        #expect(try JSONDecoder().decode(AppSettings.self, from: Data(#"{"developerMode":false}"#.utf8)).completionVerificationModel == "gpt-6-luna")
        #expect(SettingsSection.matching("Completion verification", in: SettingsSection.allCases) == [.engines])
    }

    /// Production classifier, actual subprocess, fixture inference: asserts the real argv.
    @Test func persistentSelectionReachesJudgeProcessForBothHeadsAndNewBots() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-verifier-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appending(path: "judge-fixture"), observed = root.appending(path: "observed")
        try """
        #!/bin/sh
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --model) shift; selected="$1" ;;
            --output-last-message) shift; result_path="$1" ;;
          esac
          shift
        done
        printf '%s\\n' "$selected" >> '\(observed.path)'
        printf '{"verdict":"COMPLETE","reason":"Actual model: %s"}' "$selected" > "$result_path"
        printf '%s\\n' '{"type":"turn.completed"}'
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let factory: (String) -> PromiseCheck.Classifier = { PromiseCheck.codexClassifier(executable: executable, model: $0, timeout: 3) }
        let fake = FakeLauncher(), workspace = open(root.appending(path: "data"), fake, classify: factory)
        defer { workspace.modelSettingsBots.forEach { $0.stop() } }
        let bot = workspace.mainBot
        await bot.setHeads([.claude, .codex])
        #expect(!workspace.setCompletionVerificationModel(model("unsupported", efforts: ["high"])))
        #expect(workspace.settings.completionVerificationModel == "gpt-6-luna")
        #expect(workspace.setCompletionVerificationModel(model("fixture-alpha")))
        for engine in [BotEngine.claude, .codex] {
            let previous = bot.messages.last(where: { $0.role == .bot })?.id
            bot.send("Report a completed result", to: engine == .claude ? .claude : .codex)
            let head = engine == .claude ? bot : try #require(bot.partner)
            await eventually { head.messages.last(where: { $0.role == .bot })?.id != previous && head.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .judged }
            let record = try #require(head.messages.last(where: { $0.role == .bot })?.completionVerification)
            #expect(record.model == "fixture-alpha" && record.verdict == .complete)
            #expect(record.reason == "Actual model: fixture-alpha")
        }
        #expect(bot.partner?.completionVerificationModel == "fixture-alpha")
        #expect(workspace.setCompletionVerificationModel(model("fixture-beta")))
        #expect(bot.partner?.completionVerificationModel == "fixture-beta")
        let reloaded = open(root.appending(path: "data"), FakeLauncher(), classify: factory)
        defer { reloaded.modelSettingsBots.forEach { $0.stop() } }
        #expect(reloaded.settings.completionVerificationModel == "fixture-beta")
        let project = reloaded.addProject(folder: root.appending(path: "project"), select: false)
        let newBot = try #require(reloaded.bot(for: project))
        #expect(newBot.completionVerificationModel == "fixture-beta")
        for target in [reloaded.mainBot, newBot] {
            let previous = target.messages.last(where: { $0.role == .bot })?.id
            target.send("Report a completed result", to: .claude)
            await eventually { target.messages.last(where: { $0.role == .bot })?.id != previous && target.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .judged }
            #expect(target.messages.last(where: { $0.role == .bot })?.completionVerification?.reason == "Actual model: fixture-beta")
        }
        let observedModels = try String(contentsOf: observed, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(observedModels == ["fixture-alpha", "fixture-alpha", "fixture-beta", "fixture-beta"])
        let payload = ChatPayload.make(bot: newBot, components: reloaded.components, pending: [], replyingTo: nil) { _ in "" }
        #expect(payload.messages.last?.completionVerification?.model == "fixture-beta")
        #expect(payload.json().contains("Actual model: fixture-beta"))
        let stored = BotStore(directory: Workspace.Layout.mainBot(in: root.appending(path: "data"))).loadMessages()
        #expect(stored.last(where: { $0.role == .bot })?.completionVerification?.verdict == .complete)
    }

    @Test func inFlightProvenanceSurvivesSettingChangeAndStop() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-verifier-gate-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let fake = FakeLauncher(), gate = AsyncStream<Void>.makeStream()
        let workspace = open(root, fake) { selected in { _ in
            for await _ in gate.stream { break }
            return .init(verdict: .complete, reason: selected)
        } }
        let bot = workspace.mainBot
        defer { gate.continuation.finish(); bot.stop() }
        bot.send("Complete this")
        await eventually { bot.messages.last?.completionVerification?.state == .checking }
        #expect(bot.messages.last?.completionVerification?.model == "gpt-6-luna")
        workspace.setCompletionVerificationModel(model("fixture-new"))
        gate.continuation.yield()
        await eventually { bot.messages.last?.completionVerification?.state == .judged }
        #expect(bot.messages.last?.completionVerification?.model == "gpt-6-luna")
        #expect(bot.messages.last?.completionVerification?.reason == "gpt-6-luna")
        bot.send("Second result")
        await eventually { bot.messages.last?.completionVerification?.state == .checking }
        #expect(bot.messages.last?.completionVerification?.model == "fixture-new")
        bot.stopRounds()
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .interrupted)
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.verdict == nil)
        gate.continuation.yield()
        try await Task.sleep(for: .milliseconds(50))
        #expect(bot.messages.last(where: { $0.role == .bot })?.completionVerification?.state == .interrupted)
    }

    @Test func restartKeepsResultsButInterruptsPendingVerification() {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-verifier-restart-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = BotStore(directory: root), fake = FakeLauncher()
        var pending = ChatMessage(role: .bot, text: "Pending")
        pending.completionVerification = .init(model: "actual-pending")
        var done = ChatMessage(role: .bot, text: "Done")
        done.completionVerification = .init(model: "actual-done", state: .judged, verdict: .complete, reason: "Observed result")
        store.save(messages: [ChatMessage(role: .bot, text: "Legacy"), done, pending])
        let bot = Bot(profile: .main(home: root), launcher: fake.launcher, store: store)
        #expect(bot.messages[0].completionVerification == nil)
        #expect(bot.messages[1].completionVerification == done.completionVerification)
        #expect(bot.messages[2].completionVerification?.state == .interrupted)
        #expect(store.loadMessages()[2].completionVerification?.state == .interrupted)
    }
}

extension CompletionVerificationTests {
    @Test(arguments: [PromiseCheck.Verdict.continueWork, .continueAnalysis, .complete, .needsTerminalSignal, .waitingUser, .cancelled, .waitingDependency, .unknown, .unavailable])
    func everyActualVerdictIsAttachedToItsReply(_ verdict: PromiseCheck.Verdict) async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let bot = makeBot(fake)
        defer { bot.stop() }
        bot.promiseCheck = { _ in .init(verdict: verdict, reason: "Concrete reason for \(verdict.rawValue)") }
        bot.send("Continue authorized research only; do not implement.")
        await eventually { fake.agents.count == 1 }
        fake.agents[0].reply("Observed research result.")
        await eventually { bot.messages.contains { $0.completionVerification?.state == .judged } }
        let reply = try #require(bot.messages.first { $0.role == .bot })
        #expect(reply.completionVerification?.verdict == verdict)
        #expect(reply.completionVerification?.reason == "Concrete reason for \(verdict.rawValue)")
        #expect(reply.completionVerification?.model == "gpt-6-luna")
    }
}
