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

   Words sent to a run at work (Steer) go into it; when the engine answers late that its turn had just ended, the
   words belong to the run that sent them (eae248aa): into that run's next turn, or, that run having ended, its next
   run; a run stopped or cancelled meanwhile, or followed by another, drops them (SteerBack).

   A run at work may send its owner a note (app_notify_owner, Note): to the coordinator, or to the bot that owns the
   worker now, never anyone else. A worker its coordinator started in a call-in turn for another bot's @ has a
   follow-up route (Link: callInWork in the coordinator's settings, kept across restarts, for 3 days: Expire): the
   coordinator's turns on that worker's notes and reports (`relays`, `nturns`) are posted in the asking bot's chat
   when they end (TurnEnd), each at most once; a turn on a report that fails or says nothing still tells the asking
   bot so. `due`: a run ended whose report the asking bot has not had yet.

   A step is everything the app does in one synchronous chain: the stop or cancel waiting for a worker runs in the
   step that frees it (Free), and the report of a worker another bot owns is routed in the step that makes it due
   (Offer). Action names match spec/reference/worker.ts and the app's trace lines (desktop/src/core/spec-trace.ts). *)
EXTENDS Naturals

CONSTANTS
  Workers,         \* worker slots (task ids)
  MaxRun,          \* runs per worker (handoff is run 1)
  MaxCrash,        \* app crashes / restarts in one behaviour
  Ack,             \* the coordinator's policy: "none" (Claude) or "checkpoint" (Codex, Antigravity)
  StaleQueuedOps,  \* bug switch: TRUE puts back the race 3910341f fixed (a waiting stop/cancel ignores its run)
  FollowUp,        \* TRUE: workers may be started for another bot's @ (Link); FALSE leaves the route out
  MaxNotes,        \* bound: notes (app_notify_owner) per worker in one behaviour
  Bug              \* "none"; "steer": before eae248aa (a late steer reply acts whatever run sent it);
                   \* "followup": before the fix (a turn on a report that failed or said nothing told the asker nothing)

ASSUME Ack \in {"none", "checkpoint"} /\ StaleQueuedOps \in BOOLEAN /\ MaxRun \in Nat /\ MaxCrash \in Nat
ASSUME FollowUp \in BOOLEAN /\ MaxNotes \in Nat /\ Bug \in {"none", "steer", "followup"}

VARIABLES wk, crashes
vars == <<wk, crashes>>

Statuses == {"new", "running", "done", "failed", "stopped", "interrupted"}
Ended == {"done", "failed", "stopped", "interrupted"}
Reports == {"none", "pending", "dispatching", "delivered", "acknowledged", "unresolved", "routed"}
NoPend == [kind |-> "none", target |-> 0]
MaxShows == IF Ack = "none" THEN 1 ELSE 2
\* News of one worker its coordinator can be handed in one behaviour: its notes and each run's report shows.
MaxNews == MaxNotes + MaxRun * MaxShows

TypeOK ==
  /\ crashes \in 0..MaxCrash
  /\ wk \in [Workers -> [status: Statuses, run: 0..MaxRun, rep: Reports, tries: 0..2, queued: BOOLEAN,
                         active: BOOLEAN, cleanup: {"none", "pending", "failed"}, recovery: BOOLEAN, stale: BOOLEAN,
                         op: {"idle", "start", "stop", "recoverSend", "recoverCancel"},
                         pend: [kind: {"none", "stop", "cancel"}, target: 0..MaxRun], owned: BOOLEAN,
                         steer: 0..MaxRun, nsent: 0..MaxNotes, noted: {"none", "coord", "other"},
                         link: {"none", "live", "expired"}, relays: 0..MaxNews, nturns: 0..MaxNotes,
                         handed: 0..MaxNews, posted: 0..MaxNews, due: BOOLEAN]]

(* The chat chip (status.ts chipStatus): a failed cleanup or an unresolved report shows failed. *)
Chip(r) ==
  IF r.cleanup = "failed" \/ (r.rep = "unresolved" /\ r.status \in {"done", "failed"}) THEN "failed"
  ELSE CASE r.status = "running" -> "running" [] r.status = "done" -> "completed" [] r.status = "failed" -> "failed"
         [] r.status = "interrupted" -> "interrupted" [] OTHER -> "killed"

-----------------------------------------------------------------------------
(* What a step does to one record. *)

(* The next run: a report not handed over yet is dropped (the coordinator moved on), so nothing is owed for it. *)
Launch(r) == [r EXCEPT !.run = @ + 1, !.status = "running", !.rep = "none", !.tries = 0, !.queued = FALSE,
                       !.active = FALSE, !.op = "start", !.due = FALSE]

(* A stopped or cancelled run's late steer reply is dropped (the adapter marks the run cancelled). *)
DoStop(r) == [r EXCEPT !.status = "stopped", !.rep = "none", !.tries = 0, !.cleanup = "pending", !.stale = TRUE,
                       !.op = "stop", !.steer = 0]

(* app_cancel_task of a worker not at work: an unsettled report is dropped, the adapter ends what it keeps. *)
CancelClean(r) == [r EXCEPT !.rep = IF @ \in {"pending", "delivered"} THEN "none" ELSE @, !.queued = FALSE,
                            !.active = FALSE, !.cleanup = "pending", !.op = "stop", !.steer = 0,
                            !.due = IF r.rep = "pending" THEN FALSE ELSE @]

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

(* The coordinator is handed a report (or a note) as its turn: with a live route, that turn's reply goes back to the
   asking bot (relayTo); the report is no longer owed, the turn is. *)
Relay(r) == IF r.link = "live" THEN [r EXCEPT !.relays = @ + 1, !.handed = @ + 1, !.due = FALSE] ELSE r

(* A delivery attempt without the coordinator's decision: shown once more, then unresolved. *)
Undecided(r) == [r EXCEPT !.tries = @ + 1, !.rep = IF r.tries < 1 THEN "pending" ELSE "unresolved"]

(* The app went away and came back: a run at work is interrupted, a cleanup under way needs recovery. The turns the
   owner had under way are gone (their replies with them) and no steer reply comes; the route is kept (settings). *)
Load(r) ==
  LET b == [r EXCEPT !.op = "idle", !.pend = NoPend, !.queued = FALSE, !.active = FALSE, !.steer = 0, !.relays = 0,
                     !.nturns = 0] IN
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

(* Words for the run at work go into it (one answer from the engine awaited at a time). *)
Steer(x) == wk[x].status = "running" /\ wk[x].op = "idle" /\ wk[x].steer = 0 /\ Upd(x, [wk[x] EXCEPT !.steer = wk[x].run])

(* The engine answers a steer. Taken: done. Missed (its turn had just ended): the words are the run's that sent them
   (still the latest, not stopped or cancelled): into its next turn while at work, else its next run (a Send); any
   other run's late words are dropped. *)
SteerBack(x, missed) == LET r == wk[x] IN
  LET c == [r EXCEPT !.steer = 0]
      acts == missed /\ (Bug = "steer" \/ r.steer = r.run) /\ r.status \in Ended /\ r.op = "idle" /\ r.cleanup # "pending" IN
  /\ r.steer # 0 /\ (acts => r.run < MaxRun)
  /\ Upd(x, IF ~acts THEN c ELSE IF r.recovery THEN [c EXCEPT !.op = "recoverSend"] ELSE Launch(c))

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
  /\ Upd(x, Offer([wk[x] EXCEPT !.status = v, !.rep = "pending", !.tries = 0, !.due = wk[x].link = "live" /\ ~wk[x].owned]))

(* A process the app ended exits on its own; the core does not see it. *)
Exit(x) == wk[x].stale /\ Upd(x, [wk[x] EXCEPT !.stale = FALSE])

(* The core offers a pending report again (redeliver) and the port takes it or queues it; "busy" changes nothing. *)
Deliver(x, how) == LET r == wk[x] IN
  /\ how \in IF Ack = "checkpoint" THEN {"taken", "queued"} ELSE {"taken"}
  /\ r.rep = "pending" /\ ~r.owned /\ ~r.queued /\ r.cleanup # "pending"
  /\ Upd(x, IF how = "queued" THEN [r EXCEPT !.queued = TRUE]
            ELSE Relay([r EXCEPT !.tries = @ + 1, !.rep = IF Ack = "none" THEN "acknowledged" ELSE "delivered"]))

BeginReport(x) == LET r == wk[x] IN
  /\ r.queued /\ r.rep = "pending" /\ ~r.owned /\ r.tries < 2 /\ r.cleanup # "pending"
  /\ Upd(x, Relay([r EXCEPT !.queued = FALSE, !.rep = "dispatching", !.active = TRUE]))

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
     Upd(x, Offer([r EXCEPT !.owned = TRUE, !.rep = IF moves THEN "pending" ELSE @, !.queued = IF moves THEN FALSE ELSE @,
                           !.due = FALSE]))

(* app_notify_owner from the run at work: to whoever owns the worker now; the coordinator's turn on it is relayed. *)
Note(x) == LET r == wk[x] IN
  /\ r.status = "running" /\ r.nsent < MaxNotes
  /\ Upd(x, LET n == [r EXCEPT !.nsent = @ + 1, !.noted = IF r.owned THEN "other" ELSE "coord"] IN
            IF ~r.owned /\ r.link = "live" THEN [n EXCEPT !.nturns = @ + 1, !.handed = @ + 1] ELSE n)

(* The coordinator starts this worker in a call-in turn for another bot's @ (linkCallInWork). *)
Link(x) == LET r == wk[x] IN
  /\ FollowUp /\ r.status = "running" /\ ~r.owned /\ r.link # "live"
  /\ Upd(x, [r EXCEPT !.link = "live"])

(* Three days pass: the route is gone. The turns under way keep the route they were handed (relayTo), now run out:
   they go back to nobody, even once the worker is linked again (perhaps for another bot). *)
Expire(x) == wk[x].link = "live" /\ Upd(x, [wk[x] EXCEPT !.link = "expired", !.due = FALSE, !.relays = 0, !.nturns = 0])

(* The coordinator's turn on this worker's report (or note) ends, with words to show or not (failed, stopped,
   nothing visible): its reply is posted in the asking bot's chat; a report turn without one still tells the asking
   bot that it ended without an answer. *)
TurnEnd(x, kind, said) == LET r == wk[x] IN
  /\ IF kind = "report" THEN r.relays > 0 ELSE r.nturns > 0
  /\ LET post == said \/ (kind = "report" /\ Bug # "followup")
         t == IF kind = "report" THEN [r EXCEPT !.relays = @ - 1] ELSE [r EXCEPT !.nturns = @ - 1] IN
     Upd(x, IF post THEN [t EXCEPT !.posted = @ + 1] ELSE t)

Crash == crashes < MaxCrash /\ crashes' = crashes + 1 /\ wk' = [x \in Workers |-> Load(wk[x])]

-----------------------------------------------------------------------------

Init ==
  /\ crashes = 0
  /\ wk = [x \in Workers |-> [status |-> "new", run |-> 0, rep |-> "none", tries |-> 0, queued |-> FALSE,
                              active |-> FALSE, cleanup |-> "none", recovery |-> FALSE, stale |-> FALSE,
                              op |-> "idle", pend |-> NoPend, owned |-> FALSE, steer |-> 0, nsent |-> 0,
                              noted |-> "none", link |-> "none", relays |-> 0, nturns |-> 0, handed |-> 0,
                              posted |-> 0, due |-> FALSE]]

Next ==
  \/ Crash
  \/ \E x \in Workers :
       \/ Handoff(x) \/ StartDone(x) \/ Send(x) \/ Steer(x) \/ RecoverDone(x) \/ StopWorker(x) \/ Cancel(x)
       \/ (\E ok \in BOOLEAN : StopDone(x, ok)) \/ (\E v \in {"done", "failed"} : End(x, v)) \/ Exit(x)
       \/ (\E how \in {"taken", "queued"} : Deliver(x, how)) \/ BeginReport(x)
       \/ (\E c \in BOOLEAN : FinishReport(x, c)) \/ RetryUncertain(x) \/ Checkpoint(x) \/ SetOwner(x)
       \/ (\E m \in BOOLEAN : SteerBack(x, m)) \/ Note(x) \/ Link(x) \/ Expire(x)
       \/ (\E k \in {"report", "note"}, s \in BOOLEAN : TurnEnd(x, k, s))

(* The adapter answers every start, stop and recovery; the engine ends every run; the port keeps offering a
   pending report and ends every report turn; an uncertain hand-over is retried; the owner's turns end. *)
Fairness == \A x \in Workers :
  /\ WF_vars(StartDone(x)) /\ WF_vars(RecoverDone(x)) /\ WF_vars(\E ok \in BOOLEAN : StopDone(x, ok))
  /\ WF_vars(\E v \in {"done", "failed"} : End(x, v)) /\ WF_vars(\E how \in {"taken", "queued"} : Deliver(x, how))
  /\ WF_vars(BeginReport(x)) /\ WF_vars(\E c \in BOOLEAN : FinishReport(x, c)) /\ WF_vars(RetryUncertain(x))
  /\ WF_vars(\E k \in {"report", "note"}, s \in BOOLEAN : TurnEnd(x, k, s))

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
(* A late steer reply of a run that is no longer the latest never starts a run nor drops a report. *)
NoStaleSteer == [][\A x \in Workers : (\E m \in BOOLEAN : SteerBack(x, m)) /\ wk[x].steer # wk[x].run
  => wk'[x].run = wk[x].run /\ wk'[x].rep = wk[x].rep]_vars
(* A note goes only to the worker's owner of the moment, and only from a run at work. *)
NoteToOwner == [][\A x \in Workers : wk'[x].nsent > wk[x].nsent =>
  wk[x].status = "running" /\ wk'[x].noted = IF wk[x].owned THEN "other" ELSE "coord"]_vars
(* Only a run's report not handed over yet is owed, while the route is live and the coordinator owns the worker. *)
DueIsPending == \A x \in Workers : wk[x].due => wk[x].rep = "pending" /\ wk[x].link = "live" /\ ~wk[x].owned
(* A turn that goes back to the asking bot does so on a live route. *)
TurnsOnLiveRoute == \A x \in Workers : wk[x].relays + wk[x].nturns > 0 => wk[x].link = "live"
(* Each follow-up record (one turn of the coordinator's) is posted in the asking bot's chat at most once, and only
   while the route is live. *)
FollowUpOnce == \A x \in Workers : wk[x].posted + wk[x].relays + wk[x].nturns <= wk[x].handed
PostOncePerTurn == [][\A x \in Workers : wk'[x].posted # wk[x].posted =>
  /\ wk'[x].posted = wk[x].posted + 1 /\ wk[x].link = "live"
  /\ wk'[x].relays + wk'[x].nturns = wk[x].relays + wk[x].nturns - 1]_vars
(* What the asking bot is owed of a run's end leaves only by a post, or for a stated reason: the route expired,
   the worker moved to another bot, the coordinator dropped the report (a cancel, the next run), or the app went away
   with the coordinator's turn on it under way. *)
Owed(x) == wk[x].link = "live" /\ (wk[x].due \/ wk[x].relays > 0)
OwedEndsByPost == [][\A x \in Workers : Owed(x) /\ ~(wk'[x].link = "live" /\ (wk'[x].due \/ wk'[x].relays > 0)) =>
  \/ wk'[x].posted > wk[x].posted \/ wk'[x].link # "live" \/ wk'[x].owned \/ crashes' > crashes
  \/ (wk[x].rep = "pending" /\ wk'[x].rep = "none")]_vars

(* Liveness *)

RunEnds == \A x \in Workers : wk[x].status = "running" ~> wk[x].status \in Ended
ReportSettles == \A x \in Workers :
  wk[x].rep = "pending" ~> wk[x].rep \in {"delivered", "acknowledged", "unresolved", "routed", "none"}
(* A stop or cancel waiting for the worker gets it: the operation under way always ends. *)
QueueDrains == \A x \in Workers : wk[x].pend.kind # "none" ~> wk[x].pend.kind = "none"
(* Within the route's three days, a run's end reaches the asking bot (or a stated reason ends what is owed). *)
FollowUpArrives == \A x \in Workers : Owed(x) ~> ~Owed(x)
=============================================================================
