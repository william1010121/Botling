import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Settings → Doctor: is Claude Code (and Codex) installed, new enough and signed in.
struct DoctorTests {
    // MARK: Versions

    @Test func readsVersionsAsTheCLIsPrintThem() {
        #expect(CLIVersion("2.1.304 (Claude Code)") == CLIVersion(parts: [2, 1, 304]))
        #expect(CLIVersion("codex-cli 0.163.0") == CLIVersion(parts: [0, 163, 0]))
        #expect(CLIVersion("v1.2\n") == CLIVersion(parts: [1, 2]))
        #expect(CLIVersion("2.1.304\n")?.description == "2.1.304")
        #expect(CLIVersion("command not found") == nil)
        #expect(CLIVersion("") == nil)
    }

    @Test func comparesPartByPart() {
        let minimum = CLIVersion(parts: [2, 1, 111])
        #expect(CLIVersion("2.1.110")! < minimum)
        #expect(CLIVersion("2.0.999")! < minimum)
        #expect(!(CLIVersion("2.1.111")! < minimum))
        #expect(CLIVersion("2.1.111.0")! == minimum)
        #expect(CLIVersion("2.2")! > minimum)
        #expect(CLIVersion("10.0.0")! > CLIVersion("9.9.9")!)
    }

    @Test func minimumsCoverTheFlagsTheAppPasses() {
        // `--effort xhigh` (Claude Code 2.1.111) and `codex exec --ephemeral` (Codex 0.99.0).
        #expect(DoctorTool.claude.minimum == CLIVersion(parts: [2, 1, 111]))
        #expect(DoctorTool.codex.minimum == CLIVersion(parts: [0, 99, 0]))
    }

    // MARK: Sign-in

    @Test func readsClaudeAuthStatus() {
        let subscription = DoctorTool.parseClaudeAuth(#"{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", "email": "a@b.c"}"#)
        #expect(subscription == .signedIn("Claude subscription (max)"))
        #expect(DoctorTool.parseClaudeAuth(#"{"loggedIn": true, "authMethod": "api_key"}"#) == .signedIn("API key"))
        #expect(DoctorTool.parseClaudeAuth(#"{"loggedIn": false}"#) == .signedOut)
        #expect(DoctorTool.parseClaudeAuth("error: unknown command 'auth'") == .unknown)
    }

    @Test func readsCodexLoginStatusWithoutTheKey() {
        #expect(DoctorTool.parseCodexAuth("Logged in using ChatGPT", exitCode: 0) == .signedIn("ChatGPT"))
        #expect(DoctorTool.parseCodexAuth("Logged in using an API key - sk-proj-***abcd", exitCode: 0) == .signedIn("API key"))
        #expect(DoctorTool.parseCodexAuth("Not logged in", exitCode: 1) == .signedOut)
        #expect(DoctorTool.parseCodexAuth("Error loading configuration: config.toml:3:1: bad", exitCode: 1) == .unknown)
        // Signed in is its exit status: other words still count.
        #expect(DoctorTool.parseCodexAuth("Authenticated with a workspace token", exitCode: 0) != .unknown)
    }

    /// `claude plugin validate`: its exit status decides; what it printed is kept whole.
    @Test func pluginValidationGoesByTheExitStatus() {
        #expect(ClaudePluginValidator.problem(status: 0, output: "All good") == nil)
        let problem = ClaudePluginValidator.problem(status: 1, output: "Checking…\n  • agents/x.md: missing name\n")
        #expect(problem?.contains("agents/x.md: missing name") == true)
        #expect(ClaudePluginValidator.problem(status: 2, output: "") != nil)
    }

    // MARK: One row

    private func evaluate(_ tool: DoctorTool, path: String? = "/x/bin/tool", version: String? = "9.9.9", auth: DoctorAuth = .signedIn("ChatGPT"), latest: String? = nil) -> DoctorCheck {
        tool.evaluate(path: path.map { URL(filePath: $0) }, versionOutput: version, auth: auth, latest: latest.flatMap(CLIVersion.init))
    }

    @Test func missingClaudeIsRedWithAnInstallCommand() {
        let check = evaluate(.claude, path: nil, version: nil, auth: .unknown)
        #expect(check.status == .failing)
        #expect(check.fix == "npm i -g @anthropic-ai/claude-code@latest")
        #expect(check.path == nil)
        #expect(check.isRequired)
    }

    @Test func missingCodexIsOnlyAWarning() {
        let check = evaluate(.codex, path: nil, version: nil, auth: .unknown)
        #expect(check.status == .warning)
        #expect(check.fix == "npm i -g @openai/codex@latest")
        #expect(!check.isRequired)
    }

    @Test func tooOldIsRedWithAnUpdateCommandForThatInstall() {
        let claude = evaluate(.claude, path: "/u/.local/bin/claude", version: "2.1.90 (Claude Code)")
        #expect(claude.status == .failing)
        #expect(claude.version == "2.1.90")
        #expect(claude.fix == "'/u/.local/bin/claude' update")
        #expect(claude.summary.contains("2.1.111"))

        let codex = evaluate(.codex, version: "codex-cli 0.98.2")
        #expect(codex.status == .failing)
        #expect(codex.fix == "npm i -g @openai/codex@latest")
    }

    @Test func signedOutIsRedWithTheLoginCommand() {
        let claude = evaluate(.claude, path: "/u/bin/claude", version: "2.1.304", auth: .signedOut)
        #expect(claude.status == .failing)
        #expect(claude.fix == "'/u/bin/claude' auth login")
        let codex = evaluate(.codex, path: "/u/bin/codex", version: "0.163.0", auth: .signedOut)
        #expect(codex.status == .failing)
        #expect(codex.fix == "'/u/bin/codex' login")
    }

    @Test func unreadableVersionOrSignInIsAWarning() {
        #expect(evaluate(.claude, version: nil).status == .warning)
        #expect(evaluate(.codex, version: "0.163.0", auth: .unknown).status == .warning)
    }

    @Test func healthyIsGreenAndANewerReleaseIsOnlyMentioned() {
        let current = evaluate(.claude, version: "2.1.304", auth: .signedIn("Claude subscription (max)"), latest: "2.1.304")
        #expect(current.status == .ok)
        #expect(current.fix == nil)
        #expect(current.auth == "Claude subscription (max)")

        let behind = evaluate(.claude, path: "/u/bin/claude", version: "2.1.300", latest: "2.1.304")
        #expect(behind.status == .ok)
        #expect(behind.latest == "2.1.304")
        #expect(behind.summary.contains("2.1.304"))
        #expect(behind.fix == "'/u/bin/claude' update")
    }

    // MARK: Running commands

    @Test func aCommandThatHangsIsStoppedAtTheTimeout() async {
        let start = Date()
        let result = await CommandRunner.run(URL(filePath: "/bin/sleep"), ["30"], timeout: 0.5)
        #expect(result?.timedOut == true)
        #expect(Date().timeIntervalSince(start) < 5)
    }

    @Test func aCommandsOutputAndExitCodeAreKept() async {
        let result = await CommandRunner.run(URL(filePath: "/bin/sh"), ["-c", "echo out; echo err >&2; exit 3"], timeout: 5)
        #expect(result?.exitCode == 3)
        #expect(result?.output.contains("out") == true)
        #expect(result?.output.contains("err") == true)
        #expect(result?.timedOut == false)
    }

    @Test func aMissingExecutableGivesNoResult() async {
        #expect(await CommandRunner.run(URL(filePath: "/nonexistent/claude"), ["--version"], timeout: 5) == nil)
    }

    // MARK: The whole page

    @Test func noBinariesAndOfflineStillGivesTwoRows() async {
        let doctor = Doctor(
            locateClaude: { nil },
            locateCodex: { nil },
            run: { _, _, _ in nil },
            latest: { _ in nil }
        )
        let checks = await doctor.check(includeLatest: true)
        #expect(checks.map(\.tool) == [.claude, .codex])
        #expect(checks.map(\.status) == [.failing, .warning])
        #expect(checks.allSatisfy { $0.latest == nil })
    }

    @Test func runsVersionAndSignInForEachTool() async {
        let doctor = Doctor(
            locateClaude: { URL(filePath: "/u/bin/claude") },
            locateCodex: { URL(filePath: "/u/bin/codex") },
            run: { executable, arguments, _ in
                switch (executable.lastPathComponent, arguments) {
                case ("claude", ["--version"]): CommandResult(output: "2.1.304 (Claude Code)\n", exitCode: 0)
                case ("claude", ["auth", "status"]): CommandResult(output: #"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}"#, exitCode: 0)
                case ("codex", ["--version"]): CommandResult(output: "codex-cli 0.163.0\n", exitCode: 0)
                case ("codex", ["login", "status"]): CommandResult(output: "Logged in using ChatGPT\n", exitCode: 0)
                default: nil
                }
            },
            latest: { package in package == DoctorTool.claude.package ? "2.1.305" : nil }
        )
        let checks = await doctor.check(includeLatest: true)
        #expect(checks.map(\.status) == [.ok, .ok])
        #expect(checks[0].version == "2.1.304")
        #expect(checks[0].latest == "2.1.305")
        #expect(checks[0].auth == "Claude subscription (pro)")
        #expect(checks[1].auth == "ChatGPT")
        #expect(checks[1].latest == nil)
    }

    @Test func aVersionCommandThatTimesOutIsAWarningNotAHang() async {
        let doctor = Doctor(
            locateClaude: { URL(filePath: "/u/bin/claude") },
            locateCodex: { nil },
            run: { _, _, _ in CommandResult(output: "", exitCode: 15, timedOut: true) },
            latest: { _ in nil }
        )
        let checks = await doctor.check(includeLatest: false)
        #expect(checks[0].status == .warning)
        #expect(checks[0].summary.contains("did not answer"))
    }

    @Test func latestVersionIsReadFromNpmOutput() {
        #expect(Doctor.parseLatest("2.1.305\n") == "2.1.305")
        #expect(Doctor.parseLatest("npm error code ENOTFOUND\nnpm error network request failed") == nil)
        #expect(Doctor.parseLatest("") == nil)
    }

    @MainActor
    @Test func modelFlagsARequiredFailureForTheGear() async {
        let model = DoctorModel(doctor: Doctor(locateClaude: { nil }, locateCodex: { nil }, run: { _, _, _ in nil }, latest: { _ in nil }))
        #expect(!model.needsAttention)
        await model.run(includeLatest: false)
        #expect(model.needsAttention)
        #expect(model.checks.count == 2)
        #expect(!model.isRunning)
    }

    @Test func doctorIsASettingsSection() {
        #expect(SettingsSection.allCases.last == .doctor)
        #expect(SettingsSection.doctor.title == "Doctor")
    }
}
