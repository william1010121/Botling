import Foundation

/// The existing ccb-core Claude editor, exposed to the Codex Maintainer without making
/// generic execution workers delegate or inherit the Maintainer's no-template-edit rule.
enum ComponentEditorRoute {
    case available(AgentLaunch)
    case unavailable(String)

    var launch: AgentLaunch? {
        if case let .available(launch) = self { return launch }
        return nil
    }

    static let coordinatorRule = """
    Component editing on this Codex Maintainer: use app_handoff with role="component-editor" for each authorized component edit, never a generic worker. The app starts the existing ccb-core Claude component editor using its agent file and configured model; you and generic workers still must not edit template.html/about.md. Include the component folder, request, attachment paths and exact component-shot command. Send corrections to the same task_id with app_send_message; its editor role is retained. After its report, delegate review/check/version/commit work to an ordinary worker, serially, keeping any further template edits with the editor. This route grants no new authorization or folders. If unavailable or denied, report the exact failure; do not substitute a generic worker or change settings.
    """

    static func load(for parent: AgentLaunch) -> ComponentEditorRoute? {
        guard parent.componentEditorEnabled else { return nil }
        let file = parent.workingDirectory.appending(path: "ccb-core/claude/agents/component-editor.md")
        guard let text = try? String(contentsOf: file, encoding: .utf8),
              let spec = TeamSpec.parse(text), spec.name == "component-editor", !spec.role.isEmpty else {
            return .unavailable("Cannot load the existing component-editor definition at \(file.path). No generic worker was substituted.")
        }
        let header = text.components(separatedBy: "---")[1]
        let declaredModel = header.split(separator: "\n").compactMap { line -> String? in
            let pair = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            return pair.count == 2 && pair[0] == "model" ? pair[1] : nil
        }.first
        guard let declaredModel, BotModel(rawValue: declaredModel) != nil else {
            return .unavailable("The component-editor definition has no supported explicit Claude model. No model or settings were substituted.")
        }
        let tools: Set<String> = ["Read", "Write", "Edit", "Bash"]
        guard !spec.tools.isEmpty, Set(spec.tools).isSubset(of: tools) else {
            return .unavailable("The component-editor definition requests tools outside its existing Read/Write/Edit/Bash boundary; no tools or settings were changed.")
        }
        var editor = AgentLaunch(model: spec.model, sessionID: UUID(), workingDirectory: parent.workingDirectory,
            systemPrompt: """
            \(spec.role)

            You are the app-managed ccb-core:component-editor execution role for Maintainer. Execute only the assigned component task yourself and return concrete evidence. Do not delegate, route to another bot, edit the editor definition, or perform release/version/commit/tag work: Maintainer owns review and release. Read PLUGINS.md first. Preserve the user's authorization phase: research-only work never authorizes source edits, even in new files or isolated worktrees. Do not change shared memory or routines unless explicitly assigned. Preserve other workers' files. Folders outside the plugin library may only be read when already approved; a missing permission or a denial is a blocker to report, never permission to change settings or bypass it. The task supplies component folder, attachments, scope and validation command. A final report ends this execution turn: include changed files, actual checks/results and remaining blockers; never claim unperformed acceptance passed.
            """,
            tools: spec.tools, restrictedTools: spec.tools, extraDirectories: parent.extraDirectories,
            environment: parent.environment, asksPermission: parent.asksPermission,
            disallowedTools: parent.disallowedTools + ["Agent", "Task", "SendMessage"],
            autoMode: parent.autoMode, allowRules: parent.allowRules, effort: parent.effort)
        editor.engine = .claude
        return .available(editor)
    }
}

/// Effects are executed by the transport through the existing Claude launcher. Session
/// bookkeeping, task ownership, approval decisions and result reconciliation stay app-owned.
enum ComponentEditorAction {
    case start(task: String, run: Int, launch: AgentLaunch, text: String)
    case send(task: String, text: String)
    case stop(task: String)
    case answer(task: String, request: PermissionRequest, allow: Bool, message: String?)
}
