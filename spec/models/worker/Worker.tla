------------------------------- MODULE Worker -------------------------------
(* Botling's worker lifecycle and report delivery: desktop/src/core/worker-core/core.ts.

   One record per worker is the truth (worker-ledger.json): status, run, report state and attempts, cleanup and
   recovery. Beside it the core keeps in memory the one operation that holds the worker (an asynchronous start, stop
   or recovery), at most one stop or cancel waiting for it, and the reports its coordinator port queued (`queued`) or
   is showing (`active`). The engine side is the run's process: `stale` says a process of a run the app ended
   (stopped, or at work when the app went away) may still be alive; only a confirmed exit (ManagedProcess.gone /
   endTree) clears it.

     new --Handoff--> running --End--> done | failed (report pending)
                         |  --StopWorker | Cancel--> stopped (no report; cleanup until its process is gone)
                         |  --Crash--> interrupted (recovery required)
     ended --Send (recovered, cleanup not pending)--> running (next run)

     report: pending --Deliver taken--> delivered (Ack "none": acknowledged)   owned: routed at once
             pending --Deliver queued, BeginReport--> dispatching --FinishReport(completed)--> pending | unresolved
             dispatching (uncertain) --RetryUncertain--> pending | unresolved;  shown --Checkpoint--> acknowledged

   A step is everything the app does in one synchronous chain: the stop or cancel waiting for a worker runs in the
   step that frees it (Free), and the report of a worker another bot owns is routed in the step that makes it due
   (Offer). Action names match spec/reference/worker.ts and the app's trace lines (desktop/src/core/spec-trace.ts). *)
EXTENDS Naturals

CONSTANTS
  Workers,         \* worker slots (task ids)
  MaxRun,          \* runs per worker (handoff is run 1)
  MaxCrash,        \* app crashes / restarts in one behaviour
  Ack,             \* the coordinator's policy: "none" (Claude) or "checkpoint" (Codex, Antigravity)
  StaleQueuedOps   \* bug switch: TRUE puts back the race 3910341f fixed (a waiting stop/cancel ignores its run)

ASSUME Ack \in {"none", "checkpoint"} /\ StaleQueuedOps \in BOOLEAN /\ MaxRun \in Nat /\ MaxCrash \in Nat

VARIABLES wk, crashes
vars == <<wk, crashes>>

Statuses == {"new", "running", "done", "failed", "stopped", "interrupted"}
Ended == {"done", "failed", "stopped", "interrupted"}
Reports == {"none", "pending", "dispatching", "delivered", "acknowledged", "unresolved", "routed"}
NoPend == [kind |-> "none", target |-> 0]
MaxShows == IF Ack = "none" THEN 1 ELSE 2

TypeOK ==
  /\ crashes \in 0..MaxCrash
  /\ wk \in [Workers -> [status: Statuses, run: 0..MaxRun, rep: Reports, tries: 0..2, queued: BOOLEAN,
                         active: BOOLEAN, cleanup: {"none", "pending", "failed"}, recovery: BOOLEAN, stale: BOOLEAN,
                         op: {"idle", "start", "stop", "recoverSend", "recoverCancel"},
                         pend: [kind: {"none", "stop", "cancel"}, target: 0..MaxRun], owned: BOOLEAN]]

(* The chat chip (status.ts chipStatus): a failed cleanup or an unresolved report shows failed. *)
Chip(r) ==
  IF r.cleanup = "failed" \/ (r.rep = "unresolved" /\ r.status \in {"done", "failed"}) THEN "failed"
  ELSE CASE r.status = "running" -> "running" [] r.status = "done" -> "completed" [] r.status = "failed" -> "failed"
         [] r.status = "interrupted" -> "interrupted" [] OTHER -> "killed"

-----------------------------------------------------------------------------
(* What a step does to one record. *)

Launch(r) == [r EXCEPT !.run = @ + 1, !.status = "running", !.rep = "none", !.tries = 0, !.queued = FALSE,
                       !.active = FALSE, !.op = "start"]

DoStop(r) == [r EXCEPT !.status = "stopped", !.rep = "none", !.tries = 0, !.cleanup = "pending", !.stale = TRUE,
                       !.op = "stop"]

(* app_cancel_task of a worker not at work: an unsettled report is dropped, the adapter ends what it keeps. *)
CancelClean(r) == [r EXCEPT !.rep = IF @ \in {"pending", "delivered"} THEN "none" ELSE @, !.queued = FALSE,
                            !.active = FALSE, !.cleanup = "pending", !.op = "stop"]

(* A stop or cancel asked for run `target`, now holding the worker. Refused (nothing changes) once that run has been
   followed by another, and, for a cancel (the coordinator's tool), once the worker moved to another bot. *)
Body(r, kind, target) ==
  IF ~StaleQueuedOps /\ (r.run # target \/ (kind = "cancel" /\ r.owned)) THEN r
  ELSE IF r.status = "running" THEN DoStop(r)
  ELSE IF kind = "stop" THEN r
  ELSE IF r.recovery THEN [r EXCEPT !.op = "recoverCancel"]
  ELSE CancelClean(r)

(* The operation ends: the stop or cancel waiting for the worker, if any, takes it. *)
Free(r) == IF r.pend.kind = "none" THEN [r EXCEPT !.op = "idle"]
           ELSE Body([r EXCEPT !.op = "idle", !.pend = NoPend], r.pend.kind, r.pend.target)

(* A report that falls due goes to the bot that owns the worker, never to this coordinator. *)
Offer(r) == IF r.owned /\ r.rep = "pending" THEN [r EXCEPT !.rep = "routed"] ELSE r

(* A delivery attempt without the coordinator's decision: shown once more, then unresolved. *)
Undecided(r) == [r EXCEPT !.tries = @ + 1, !.rep = IF r.tries < 1 THEN "pending" ELSE "unresolved"]

(* The app went away and came back: a run at work is interrupted, a cleanup under way needs recovery. *)
Load(r) ==
  LET b == [r EXCEPT !.op = "idle", !.pend = NoPend, !.queued = FALSE, !.active = FALSE] IN
  IF r.status = "running" THEN [b EXCEPT !.status = "interrupted", !.recovery = TRUE, !.stale = TRUE, !.rep = "none", !.tries = 0]
  ELSE IF r.cleanup = "pending" THEN [b EXCEPT !.cleanup = "none", !.recovery = TRUE]
  ELSE b

-----------------------------------------------------------------------------

Upd(x, r) == wk' = [wk EXCEPT ![x] = r] /\ UNCHANGED crashes

Handoff(x) == wk[x].status = "new" /\ Upd(x, Launch(wk[x]))

StartDone(x) == wk[x].op = "start" /\ Upd(x, Free(wk[x]))

Send(x) == LET r == wk[x] IN
  /\ r.status \in Ended /\ r.op = "idle" /\ r.cleanup # "pending" /\ r.run < MaxRun
  /\ Upd(x, IF r.recovery THEN [r EXCEPT !.op = "recoverSend"] ELSE Launch(r))

Steer(x) == wk[x].status = "running" /\ wk[x].op = "idle" /\ UNCHANGED vars

(* The adapter answers: clean only once the old process is confirmed gone; blocked frees the worker. *)
RecoverDone(x) == LET r == wk[x] IN
  /\ r.op \in {"recoverSend", "recoverCancel"}
  /\ Upd(x, IF r.stale THEN Free(r)
            ELSE LET c == [r EXCEPT !.recovery = FALSE, !.cleanup = "none"] IN
                 IF r.op = "recoverSend" THEN Launch(c) ELSE CancelClean(c))

(* A stop or cancel is asked for the run of now: it acts at once, or waits for the operation under way. *)
Ask(x, kind) == LET r == wk[x] IN
  /\ r.status # "new" /\ r.pend.kind = "none"
  /\ Upd(x, IF r.op = "idle" THEN Body(r, kind, r.run) ELSE [r EXCEPT !.pend = [kind |-> kind, target |-> r.run]])

StopWorker(x) == Ask(x, "stop")
Cancel(x) == ~wk[x].owned /\ Ask(x, "cancel")

(* The adapter's stop ends; not clean (the tree outlived SIGKILL): cleanup failed, recovery required. *)
StopDone(x, ok) == LET r == wk[x] IN
  /\ r.op = "stop" /\ (ok \/ r.stale)
  /\ Upd(x, Free(IF ok THEN [r EXCEPT !.cleanup = "none", !.stale = FALSE]
                 ELSE [r EXCEPT !.cleanup = "failed", !.recovery = TRUE]))

(* The engine ends the run: a reply ("done") or an error or process exit ("failed"). *)
End(x, v) == v \in {"done", "failed"} /\ wk[x].status = "running" /\ wk[x].op = "idle"
  /\ Upd(x, Offer([wk[x] EXCEPT !.status = v, !.rep = "pending", !.tries = 0]))

(* A process the app ended exits on its own; the core does not see it. *)
Exit(x) == wk[x].stale /\ Upd(x, [wk[x] EXCEPT !.stale = FALSE])

(* The core offers a pending report again (redeliver) and the port takes it or queues it; "busy" changes nothing. *)
Deliver(x, how) == LET r == wk[x] IN
  /\ how \in IF Ack = "checkpoint" THEN {"taken", "queued"} ELSE {"taken"}
  /\ r.rep = "pending" /\ ~r.owned /\ ~r.queued /\ r.cleanup # "pending"
  /\ Upd(x, IF how = "queued" THEN [r EXCEPT !.queued = TRUE]
            ELSE [r EXCEPT !.tries = @ + 1, !.rep = IF Ack = "none" THEN "acknowledged" ELSE "delivered"])

BeginReport(x) == LET r == wk[x] IN
  /\ r.queued /\ r.rep = "pending" /\ ~r.owned /\ r.tries < 2 /\ r.cleanup # "pending"
  /\ Upd(x, [r EXCEPT !.queued = FALSE, !.rep = "dispatching", !.active = TRUE])

FinishReport(x, completed) == wk[x].active
  /\ LET a == [wk[x] EXCEPT !.active = FALSE] IN Upd(x, IF completed /\ a.rep = "dispatching" THEN Undecided(a) ELSE a)

RetryUncertain(x) == wk[x].rep = "dispatching" /\ ~wk[x].active /\ Upd(x, Undecided(wk[x]))

Checkpoint(x) == LET r == wk[x] IN
  /\ ~r.owned /\ r.status \in Ended /\ r.cleanup # "pending"
  /\ (r.active \/ r.rep \in {"delivered", "unresolved"} \/ (r.rep = "pending" /\ r.tries > 0))
  /\ Upd(x, [r EXCEPT !.rep = "acknowledged", !.active = FALSE, !.queued = FALSE])

SetOwner(x) == LET r == wk[x] IN
  /\ ~r.owned /\ r.status # "new" /\ r.rep # "dispatching" /\ ~r.active
  /\ LET moves == r.status # "running" /\ r.cleanup # "pending" /\ r.rep \in {"pending", "delivered", "unresolved"} IN
     Upd(x, Offer([r EXCEPT !.owned = TRUE, !.rep = IF moves THEN "pending" ELSE @, !.queued = IF moves THEN FALSE ELSE @]))

Crash == crashes < MaxCrash /\ crashes' = crashes + 1 /\ wk' = [x \in Workers |-> Load(wk[x])]

-----------------------------------------------------------------------------

Init ==
  /\ crashes = 0
  /\ wk = [x \in Workers |-> [status |-> "new", run |-> 0, rep |-> "none", tries |-> 0, queued |-> FALSE,
                              active |-> FALSE, cleanup |-> "none", recovery |-> FALSE, stale |-> FALSE,
                              op |-> "idle", pend |-> NoPend, owned |-> FALSE]]

Next ==
  \/ Crash
  \/ \E x \in Workers :
       \/ Handoff(x) \/ StartDone(x) \/ Send(x) \/ Steer(x) \/ RecoverDone(x) \/ StopWorker(x) \/ Cancel(x)
       \/ (\E ok \in BOOLEAN : StopDone(x, ok)) \/ (\E v \in {"done", "failed"} : End(x, v)) \/ Exit(x)
       \/ (\E how \in {"taken", "queued"} : Deliver(x, how)) \/ BeginReport(x)
       \/ (\E c \in BOOLEAN : FinishReport(x, c)) \/ RetryUncertain(x) \/ Checkpoint(x) \/ SetOwner(x)

(* The adapter answers every start, stop and recovery; the engine ends every run; the port keeps offering a
   pending report and ends every report turn; an uncertain hand-over is retried. *)
Fairness == \A x \in Workers :
  /\ WF_vars(StartDone(x)) /\ WF_vars(RecoverDone(x)) /\ WF_vars(\E ok \in BOOLEAN : StopDone(x, ok))
  /\ WF_vars(\E v \in {"done", "failed"} : End(x, v)) /\ WF_vars(\E how \in {"taken", "queued"} : Deliver(x, how))
  /\ WF_vars(BeginReport(x)) /\ WF_vars(\E c \in BOOLEAN : FinishReport(x, c)) /\ WF_vars(RetryUncertain(x))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* No run starts while a process of a run the app ended may still be alive. *)
OneLiveRun == \A x \in Workers : wk[x].status = "running" => ~wk[x].stale
(* A process that may be alive always blocks the next run: a cleanup under way or a required recovery. *)
StaleIsGuarded == \A x \in Workers : wk[x].stale => wk[x].recovery \/ wk[x].cleanup = "pending"
(* Only an ended run owes a report. *)
OwedOnlyEnded == \A x \in Workers :
  wk[x].rep \in {"pending", "dispatching", "delivered"} => wk[x].status \in {"done", "failed"}
(* A run the engine ended with a reply shows completed, unless its cleanup failed or its coordinator never decided. *)
NoFalseFailed == \A x \in Workers :
  wk[x].status = "done" /\ Chip(wk[x]) # "completed" => wk[x].cleanup = "failed" \/ wk[x].rep = "unresolved"

(* One terminal status per run: an ended run's status never changes until the next run. *)
OneTerminal == [][\A x \in Workers : wk[x].status \in Ended /\ wk'[x].run = wk[x].run => wk'[x].status = wk[x].status]_vars
(* A stop or cancel that waited for the worker never stops, or drops the report of, a run started after it was asked. *)
NoStaleOp == [][\A x \in Workers :
  (wk[x].pend.kind # "none" /\ wk'[x].pend.kind = "none" /\ crashes' = crashes /\ wk[x].pend.target # wk'[x].run)
    => wk'[x].status = wk[x].status /\ wk'[x].rep = wk[x].rep]_vars
(* The coordinator is shown a report (taken, or a report turn begins) once per attempt, within the attempts its
   policy allows, and never once another bot owns the worker. *)
Shown(x) == wk[x].rep = "pending" /\ wk'[x].rep \in {"delivered", "acknowledged", "dispatching"}
ReportAtMostOnce == [][\A x \in Workers : Shown(x) => wk[x].tries < MaxShows /\ ~wk[x].owned /\ wk'[x].run = wk[x].run]_vars

(* Liveness *)

RunEnds == \A x \in Workers : wk[x].status = "running" ~> wk[x].status \in Ended
ReportSettles == \A x \in Workers :
  wk[x].rep = "pending" ~> wk[x].rep \in {"delivered", "acknowledged", "unresolved", "routed", "none"}
(* A stop or cancel waiting for the worker gets it: the operation under way always ends. *)
QueueDrains == \A x \in Workers : wk[x].pend.kind # "none" ~> wk[x].pend.kind = "none"
=============================================================================
