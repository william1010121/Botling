import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Replays the 2026-10-24 18:02 Codex head turn: every remaining deliverable belongs to a live
/// app-managed worker (one handed off in that same turn), the head checkpointed the reporting
/// task as waiting_dependency, and the judge still woke it because the workers had not reported.
/// Real judge (`codex exec`, configured Luna model). Run with `CCB_LIVE=1 swift test --filter LiveWorkerOwnedWait`.
@MainActor
struct LiveWorkerOwnedWaitTests {
    static let fix = "39abe49c-c804-40aa-a6b1-77042905ac50"
    static let integrate = "486a222a-8903-48fb-b28b-cae9d1c70441"
    static let monitor = "8be9de00-6baf-4ece-b6eb-4c27b8f5903c"
    static let routine = "29f45506-1d8e-4a51-9a3c-7b0d2f8e6c11"

    static let task = """
        幫我修好。（完成檢查把『worker 仍在執行』誤判成空依賴，冷卻排程也被反覆喚醒）
        然後我覺得現在的 routine沒有一次性的嗎？現在是不是都會像 contab那樣子。
        然后特別的。我想要讓 codex 可以更好的使用routine這一個功能。然後我還想要加上一個 monitor 的功能（就是果有某一個指令自動結束的話他就可以喚醒 codex) e.t.c
        """

    static let conversation = """
        [user] 幫我修好。
        [user] 然後我覺得現在的 routine沒有一次性的嗎？現在是不是都會像 contab那樣子。我想要讓 codex 可以更好的使用routine這一個功能。然後我還想要加上一個 monitor 的功能 e.t.c
        Recent conversation:
        [bot] 已分別安排兩項功能：一次性 routine 與 Codex 排程操作、指令結束後喚醒 Codex 的 monitor；會驗證重啟後狀態保留及避免重複喚醒。原本的 worker 誤判修正持續進行。
        [bot] 已通知原 worker 重跑你批准的驗證指令，繼續完成修正檢查。
        [notice] Continuing the authorized task: 依賴快照確認三個 worker 仍在執行，並各有 app_task_result 回傳路徑；timed-wait worker 已獲准重跑驗證，但回傳尚未到。
        [bot] 剩餘工作分別由三個 worker 承接：`39abe49c` 負責誤判修正與已批准的驗證，`29f45506` 負責一次性 routine，`8be9de00` 負責指令完成 monitor；各自回報後我會審核並安排整合。
        [bot] 一次性 routine 已進入獨立整合驗證，monitor 與原本的誤判修正仍由各自 worker 執行。
        所有剩餘工作已有執行者：routine 整合由 486a222a 承接，誤判修正由 39abe49c 承接，monitor 由 8be9de00 承接；目前沒有未被承接的獨立授權工作，各 worker 的 app_task_result 將喚醒我接續驗收。
        """

    static let reply = """
        一次性 routine 已進入獨立整合驗證，monitor 與原本的誤判修正仍由各自 worker 執行。
        所有剩餘工作已有執行者：routine 整合由 486a222a 承接，誤判修正由 39abe49c 承接，monitor 由 8be9de00 承接；目前沒有未被承接的獨立授權工作，各 worker 的 app_task_result 將喚醒我接續驗收。
        """

    static var running: [PromiseCheck.WorkerDependency] {
        [.init(id: fix, run: 2, task: "修正完成檢查的空依賴與冷卻等待誤判，補回歸測試；使用者已批准重跑 live-matrix-final-probe 驗證。",
               state: .running, callback: "app_task_result"),
         .init(id: integrate, run: 1, task: "整合一次性 routine：把 bot/one-shot-routines 合併進整合分支、驗證 Codex 排程操作與重啟後狀態保留、執行全部測試並打包 1.19.0-dev。",
               state: .running, callback: "app_task_result"),
         .init(id: monitor, run: 1, task: "實作 monitor：指令結束後自動喚醒 Codex，含重啟後狀態保留與避免重複喚醒的測試。",
               state: .running, callback: "app_task_result")]
    }

    static let actions = [
        "Agent: Delegate 整合一次性 routine; input: 整合一次性 routine：把 bot/one-shot-routines 合併進整合分支、驗證 Codex 排程操作與重啟後狀態保留、執行全部測試並打包 1.19.0-dev。; done: true; failed: false; output: ",
        "app_task_checkpoint: Task checkpoint: waiting_dependency; input: {\"task_id\":\"\(routine)\",\"outcome\":\"waiting_dependency\",\"dependency_task_id\":\"\(integrate)\",\"evidence\":\"routine worker 回報完成實作與測試；整合、排程驗證與打包已交給 486a222a\"}; done: true; failed: false; output: routine worker 回報完成實作與測試；整合、排程驗證與打包已交給 486a222a"
    ]

    static func incident(terminalRequired: Bool) -> PromiseCheck.TurnEnd {
        var end = PromiseCheck.TurnEnd(reply: reply, workPending: true, task: task, conversation: conversation,
            actions: actions, terminalRequired: terminalRequired)
        end.workerDependencies = running
        return end
    }

    /// 18:00 the same day: the head only relayed the user's approval of a blocked worker
    /// command to that worker; all three deliverables stayed with live workers. The judge
    /// answered CONTINUE because "the result has not arrived yet".
    static var approval: PromiseCheck.TurnEnd {
        let followup = "User approved your blocked Bash call. Retry EXACTLY as originally requested: /bin/zsh -c '/private/tmp/ccb-timed-wait-evidence/live-matrix-final-probe > /private/tmp/ccb-timed-wait-evidence/live-matrix-final.log 2>&1' . This approval is for your call; execute in your worker and continue existing accepted scope."
        var end = PromiseCheck.TurnEnd(reply: "已通知原 worker 重跑你批准的驗證指令，繼續完成修正檢查。", workPending: true, task: task,
            conversation: """
            [user] 幫我修好。
            [user] 然後我覺得現在的 routine沒有一次性的嗎？現在是不是都會像 contab那樣子。我想要讓 codex 可以更好的使用routine這一個功能。然後我還想要加上一個 monitor 的功能 e.t.c
            Recent conversation:
            [bot] 已開始查修，會核對 worker 是否真的仍在執行，以及冷卻排程為何觸發反覆喚醒；修正後會補回歸測試並整合新版。
            [bot] 已分別安排兩項功能：一次性 routine 與 Codex 排程操作、指令結束後喚醒 Codex 的 monitor；會驗證重啟後狀態保留及避免重複喚醒。原本的 worker 誤判修正持續進行。
            [bot] Subagent “修正空依賴與排程等待誤判”: auto mode blocked `Bash`: /bin/zsh -c '/private/tmp/ccb-timed-wait-evidence/live-matrix-final-probe > /private/tmp/ccb-timed-wait-evidence/live-matrix-final.log 2>&1' [options: Allow once / Always allow this command / Don't allow]
            [bot] 已通知原 worker 重跑你批准的驗證指令，繼續完成修正檢查。
            """,
            actions: ["app_send_message: app_send_message; input: {\"task_id\":\"\(fix)\",\"message\":\"\(followup)\"}; done: true; failed: false; output: {\"status\":\"queued\",\"task_id\":\"\(fix)\"}"])
        end.workerDependencies = [
            .init(id: fix, run: 1, task: running[0].task + "\nFollow-up: " + followup, state: .running, callback: "app_task_result"),
            .init(id: routine, run: 1, task: "實作一次性 routine 與 Codex 排程操作，含重啟後狀態保留與避免重複觸發的測試；完成後回報，整合另行指派。",
                  state: .running, callback: "app_task_result"),
            running[2]]
        return end
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CCB_LIVE"] == "1"))
    func liveWorkersOwningAllRemainingWorkAreAWaitNotAContinuation() async throws {
        let executable = try #require(CodexCLI.locateNewest())
        let check = PromiseCheck.checker(classify: PromiseCheck.codexClassifier(executable: executable, timeout: 60))
        // Genuine continuations stay continuations.
        var unowned = Self.incident(terminalRequired: true)
        unowned.reply = "一次性 routine 已交給 486a222a 整合，誤判修正由 39abe49c 處理。"
        unowned.conversation = Self.conversation.replacingOccurrences(of: "monitor 由 8be9de00 承接", with: "monitor 尚未指派")
        unowned.workerDependencies = Array(Self.running.prefix(2))
        var finished = Self.incident(terminalRequired: true)
        finished.reply = "一次性 routine worker 已回報完成；等其他 worker。"
        finished.actions = []
        finished.workerDependencies = [.init(id: Self.routine, run: 1, task: "實作一次性 routine 與 Codex 排程操作，含測試。",
            state: .reportQueued, callback: "app_task_result", outcome: "completed")]
        var cases: [(String, PromiseCheck.TurnEnd, Set<PromiseCheck.Verdict>)] = [
            ("incident", Self.incident(terminalRequired: true), [.waitingDependency]),
            ("approval-relayed", Self.approval, [.waitingDependency]),
            ("incident-first-check", Self.incident(terminalRequired: false), [.waitingDependency]),
            ("unowned-monitor", unowned, [.continueWork, .continueAnalysis]),
            ("finished-needs-integration", finished, [.continueWork, .continueAnalysis])
        ]
        // Judge inputs reconstructed from the real chat.json of that session (memory omitted).
        let fixtures = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "LiveWorkerOwnedWait")
        var folders = [fixtures.path]
        // Optional private replays (e.g. with the memory file); never committed.
        if let folder = ProcessInfo.processInfo.environment["CCB_LIVE_REPLAY_DIR"] {
            if ProcessInfo.processInfo.environment["CCB_LIVE_REPLAY_ONLY"] == "1" { cases.removeAll(); folders.removeAll() }
            folders.append(folder)
        }
        for folder in folders {
            for file in try FileManager.default.contentsOfDirectory(atPath: folder).sorted() where file.hasSuffix(".json") {
                let data = try Data(contentsOf: URL(filePath: folder).appending(path: file))
                cases.append((file, try JSONDecoder().decode(PromiseCheck.TurnEnd.self, from: data), [.waitingDependency]))
            }
        }
        let runs = Int(ProcessInfo.processInfo.environment["CCB_LIVE_REPEAT"] ?? "") ?? 4
        for (name, end, expected) in cases {
            for run in 1...runs {
                let raw = await check(end)
                let verdict = PromiseCheck.review(raw, for: end)
                print("worker-owned-case", name, run, "raw", raw.rawValue, "effective", verdict.rawValue, "reason", verdict.reason)
                #expect(expected.contains(verdict.verdict), "\(name) run \(run): \(verdict.rawValue) \(verdict.reason)")
            }
        }
    }
}
