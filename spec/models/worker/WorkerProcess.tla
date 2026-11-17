---------------------------- MODULE WorkerProcess ----------------------------
(* A Claude worker's process and the words sent to it: desktop/src/core/agent/claude-workers.ts
   (ClaudeWorkerAdapter). Worker.tla is the core's record; this is the engine side under one worker's runs.

   One `claude` process at a time carries a worker's session. After a run's result it stays a while for a quick
   follow-up (the keep-alive), then the app closes its input (`finish`): it ends once what it left running in the
   background is done. Words written into a closed input are lost. So (95fcab3a):
     - the keep-alive does not close the input while background work started less than 6 hours ago runs;
     - a run sent to a process whose input is closed waits (`held`), takes the words steered meanwhile, and goes into
       a new process (`--resume` of the same session) once the old one has ended and its tree is confirmed gone;
       if the tree outlived its kill, the run ends with an error (said, never silent);
     - only the tree check of the process the session is on acts on a held run: an earlier process's check that
       answers late (its process exited, a new one took the session, that one is closing now) leaves it alone.

   A worker may use Monitor (2026-11-18). A turn's report is kept back while a Monitor of its process lives (started
   less than the 50-minute background cap and a minute ago): the run stays at work, its row says "Monitor running".
     - each event of a Monitor wakes the model: that turn (a wake turn) goes on in the same run; its result is held
       again while a Monitor lives, else it ends the run with the words of every turn, once;
     - once no Monitor lives, the report waits a grace for the wake turn; none starts: the report goes out as it is;
     - the timer on the oldest live Monitor's cap lets the report go when it runs out (a turn under way: the grace);
     - a timer never cuts off a turn under way: its own result ends the run (0ea2a290);
     - a failed turn is never held; the process's end sends the held report; a stop or the app's close drop it
       (the core marks the run stopped or interrupted).

     proc: none --Start (spawn)--> open --KeepAliveFires (idle, no fresh background)--> closed
           open | closed --ProcExit | Stop | AppClose--> exited --TreeChecked--> none (leftovers may stay: `tree`)
     run:  idle --Start--> working --Result--> idle            (ProcExit: the run ends with an error)
           idle --Start (proc closed)--> held --TreeChecked--> working (new process) | idle (error)
     hold: none --Result (ok, a Monitor lives)--> cap --MonEnd | MonExpire (turn)--> grace --GraceFires--> none
           cap | grace --Result--> cap (a Monitor lives) | none (the run's report: all its turns)

   Words are counted by where they went: `read` (an open input), `lost` (a closed input), `held` (waiting),
   `failed` (their run ended with an error before they were read), `stopped` (their run was stopped, or cut off by
   the app's close). A turn's report words are counted the same way: `said` (a turn's result), `kept` (held for a
   Monitor), `told` (in the run's report), `dropped` (their run ended with an error, was stopped or cut off).
   Action names match spec/reference/worker-process.ts and the driver (spec/driver/worker-process-driver.ts). *)
EXTENDS Naturals

CONSTANTS
  MaxWords,   \* bound: words sent in one behaviour (a run's first words and its steers); every process is started
              \* by words, so this bounds processes and runs too
  MaxBg,      \* bound: background tasks at once (commands, agents, Monitors)
  MaxWakes,   \* bound: wake turns in one behaviour (a Monitor's event or a steer wakes the model while its report waits)
  Bug         \* "none"; "sleep": before 95fcab3a (the keep-alive closes the input whatever runs in the background,
              \* and words go into whatever process is there); "bg": only the background rule left out;
              \* "stale": before ebfa0da4 (any exit's tree check, however late, acts on a held run);
              \* "cutoff": before 0ea2a290 (the hold's timer lets the report go while a wake turn is under way);
              \* "monexit": the process's end does not send the held report (the run ends "exited")

ASSUME MaxWords \in Nat /\ MaxBg \in Nat /\ MaxWakes \in Nat /\ Bug \in {"none", "sleep", "bg", "stale", "cutoff", "monexit"}

VARIABLES proc, tree, run, keep, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped,
          hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed
vars == <<proc, tree, run, keep, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped,
          hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

Outcomes == {"none", "report", "error", "exited", "stopped", "interrupted"}

TypeOK ==
  /\ proc \in {"none", "open", "closed", "exited"}
  /\ tree \in BOOLEAN           \* the last exited process's tree is still alive (children outlived its leader)
  /\ run \in {"idle", "working", "held"}
  /\ keep \in BOOLEAN           \* the keep-alive timer is armed
  /\ bg \in 0..MaxBg            \* background commands and agents started less than 6 hours ago
  /\ mon \in 0..MaxBg           \* live Monitors: started less than the cap and a minute ago (they hold a report)
  /\ old \in 0..MaxBg           \* Monitors past that, started less than 6 hours ago (background work, no hold)
  /\ checking \in BOOLEAN       \* the tree check (endTree) of the process the session is on has not answered yet
  /\ older \in 0..MaxWords      \* tree checks of earlier processes not answered yet
  /\ sent \in 0..MaxWords /\ read \in 0..MaxWords /\ held \in 0..MaxWords /\ lost \in 0..MaxWords
  /\ failed \in 0..MaxWords /\ stopped \in 0..MaxWords
  /\ hold \in {"none", "cap", "grace"}  \* a turn's report is kept back, and what its timer waits for: the oldest live
                                        \* Monitor's cap, or the grace for the wake turn
  /\ turn \in BOOLEAN           \* a turn is under way since the report was kept back (its result, not a timer, ends the run)
  /\ wakes \in 0..MaxWakes
  /\ kept \in 0..(MaxWakes + 1) /\ said \in Nat /\ told \in Nat /\ dropped \in Nat
  /\ runs \in 0..MaxWords /\ reports \in 0..MaxWords
  /\ outcome \in Outcomes       \* how the last run that ended ended
  /\ closed \in BOOLEAN         \* the app closed

Live == proc \in {"open", "closed"}
\* Background work that keeps a process awake: started less than 6 hours ago.
Bg == bg + mon + old
\* A new process may take the session: no process of it is alive (spawn's live `gone()` check of the last tree).
CanSpawn == ~Live /\ ~tree
\* A new process takes the session: a check still under way is now an earlier process's.
Spawned == proc' = "open" /\ bg' = 0 /\ mon' = 0 /\ old' = 0 /\ checking' = FALSE /\ older' = older + (IF checking THEN 1 ELSE 0)
\* The run ends with its report: the turns' words kept for a Monitor and `extra` more.
SendKept(extra) ==
  /\ run' = "idle" /\ hold' = "none" /\ turn' = FALSE /\ kept' = 0 /\ told' = told + kept + extra
  /\ reports' = reports + 1 /\ outcome' = "report"
\* The run under way ends without its report: what was kept for a Monitor is dropped.
Drop(how) ==
  /\ run' = "idle" /\ hold' = "none" /\ turn' = FALSE /\ kept' = 0 /\ dropped' = dropped + kept
  /\ reports' = reports + 1 /\ outcome' = how
\* What a held report's timer waits for once its Monitors are `m` (monitorChanged): the oldest live one's cap, or the grace.
Aim(m) == IF hold = "none" THEN "none" ELSE IF m > 0 THEN "cap" ELSE "grace"

-----------------------------------------------------------------------------

(* The core sends a run's first words. Into the open process; else a new one; a closed input holds them (a new
   process takes them once this one has ended). A spawn refused (an earlier tree is still alive) fails the run. *)
Start ==
  /\ run = "idle" /\ ~closed /\ sent < MaxWords /\ sent' = sent + 1 /\ runs' = runs + 1 /\ keep' = FALSE
  /\ IF proc = "open" \/ (proc = "closed" /\ Bug = "sleep") THEN
       /\ run' = "working"
       /\ IF proc = "open" THEN read' = read + 1 /\ lost' = lost ELSE lost' = lost + 1 /\ read' = read
       /\ UNCHANGED <<proc, bg, mon, old, checking, older, held, failed, reports, outcome>>
     ELSE IF proc = "closed" THEN
       /\ run' = "held" /\ held' = 1 /\ UNCHANGED <<proc, bg, mon, old, checking, older, read, lost, failed, reports, outcome>>
     ELSE IF CanSpawn THEN
       /\ run' = "working" /\ Spawned /\ read' = read + 1 /\ UNCHANGED <<held, lost, failed, reports, outcome>>
     ELSE
       /\ failed' = failed + 1 /\ reports' = reports + 1 /\ outcome' = "error"
       /\ UNCHANGED <<proc, run, bg, mon, old, checking, older, read, held, lost>>
  /\ UNCHANGED <<tree, stopped, hold, turn, wakes, kept, said, told, dropped, closed>>

(* Words for the run under way: into its process, or with the held words. *)
Steer ==
  /\ run \in {"working", "held"} /\ sent < MaxWords /\ sent' = sent + 1
  /\ IF run = "held" THEN held' = held + 1 /\ UNCHANGED <<read, lost>>
     ELSE IF proc = "open" THEN read' = read + 1 /\ UNCHANGED <<held, lost>>
     ELSE lost' = lost + 1 /\ UNCHANGED <<read, held>>
  /\ UNCHANGED <<proc, tree, run, keep, bg, mon, old, checking, older, failed, stopped,
                 hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

(* A turn ends with its result (`ok`: a report; else an error). While a Monitor lives a report is kept back and the
   run stays at work; else the run ends, its report carrying every turn's words kept for it. The process stays, its
   keep-alive armed. While a report is kept back, a result ends a turn under way (a wake turn). *)
Result(ok) ==
  /\ run = "working" /\ Live /\ (hold # "none" => turn)
  /\ said' = said + (IF ok THEN 1 ELSE 0)
  /\ IF ok /\ mon > 0 THEN
       /\ hold' = "cap" /\ turn' = FALSE /\ kept' = kept + 1
       /\ UNCHANGED <<run, keep, told, dropped, reports, outcome>>
     ELSE IF ok THEN keep' = TRUE /\ SendKept(1) /\ UNCHANGED dropped
     ELSE keep' = TRUE /\ Drop("error") /\ UNCHANGED told
  /\ UNCHANGED <<proc, tree, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped, wakes, runs, closed>>

(* While its report waits, a turn begins in the same run: a Monitor's event or steered words wake the model. *)
WakeTurn ==
  /\ hold # "none" /\ ~turn /\ wakes < MaxWakes
  /\ turn' = TRUE /\ wakes' = wakes + 1
  /\ UNCHANGED <<proc, tree, run, keep, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped,
                 hold, kept, said, told, dropped, runs, reports, outcome, closed>>

(* The keep-alive runs out: the input of an idle process is closed, unless fresh background work runs (then the
   timer is armed again). *)
KeepAliveFires ==
  /\ keep /\ keep' = (Bg > 0 /\ proc = "open" /\ run = "idle" /\ Bug \notin {"sleep", "bg"})
  /\ proc' = IF proc = "open" /\ run = "idle" /\ (Bg = 0 \/ Bug \in {"sleep", "bg"}) THEN "closed" ELSE proc
  /\ UNCHANGED <<tree, run, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped,
                 hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

(* The process leaves a command or an agent running in the background; it ends; or 6 hours pass (Age: background
   work then keeps the process no longer; every Monitor is past its cap before that). *)
BgStart == Live /\ Bg < MaxBg /\ bg' = bg + 1
  /\ UNCHANGED <<proc, tree, run, keep, mon, old, checking, older, sent, read, held, lost, failed, stopped,
                 hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>
BgEnd == bg > 0 /\ bg' = bg - 1
  /\ UNCHANGED <<proc, tree, run, keep, mon, old, checking, older, sent, read, held, lost, failed, stopped,
                 hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>
Age == mon = 0 /\ bg + old > 0 /\ bg' = 0 /\ old' = 0
  /\ UNCHANGED <<proc, tree, run, keep, mon, checking, older, sent, read, held, lost, failed, stopped,
                 hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

(* The process starts a Monitor (a Monitor tool call, or one on a socket or MCP server). While a report waits, only
   a turn under way starts one; the report's timer then waits on the oldest live Monitor's cap. *)
MonStart ==
  /\ Live /\ Bg < MaxBg /\ (hold = "none" \/ turn)
  /\ mon' = mon + 1 /\ hold' = Aim(1)
  /\ UNCHANGED <<proc, tree, run, keep, bg, old, checking, older, sent, read, held, lost, failed, stopped,
                 turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

(* A live Monitor ends; or a Monitor past its cap ends. Either aims the report's timer again (monitorChanged): at the
   oldest live Monitor's cap, else at the grace for the wake turn. *)
MonEnd == mon > 0 /\ mon' = mon - 1 /\ hold' = Aim(mon - 1)
  /\ UNCHANGED <<proc, tree, run, keep, bg, old, checking, older, sent, read, held, lost, failed, stopped,
                 turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>
OldEnd == old > 0 /\ old' = old - 1 /\ hold' = Aim(mon)
  /\ UNCHANGED <<proc, tree, run, keep, bg, mon, checking, older, sent, read, held, lost, failed, stopped,
                 turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

(* The oldest live Monitor runs past the cap and a minute: it holds no report any more. If the report's timer waits
   on it, the report goes out; a turn under way gets the grace instead (before 0ea2a290, "cutoff": it went out). *)
MonExpire ==
  /\ mon > 0 /\ mon' = mon - 1 /\ old' = old + 1
  /\ IF hold = "cap" /\ ~(turn /\ Bug # "cutoff") THEN keep' = TRUE /\ SendKept(0) /\ UNCHANGED dropped
     ELSE /\ hold' = (IF hold = "cap" THEN "grace" ELSE hold)
          /\ UNCHANGED <<run, keep, turn, kept, told, dropped, reports, outcome>>
  /\ UNCHANGED <<proc, tree, bg, checking, older, sent, read, held, lost, failed, stopped, wakes, said, runs, closed>>

(* The grace for the wake turn runs out: no turn began, the report goes out as it is. A turn under way: the timer is
   armed again (a stutter), its result ends the run (before 0ea2a290, "cutoff": the report went out). *)
GraceFires ==
  /\ hold = "grace"
  /\ IF turn /\ Bug # "cutoff" THEN UNCHANGED vars
     ELSE /\ keep' = TRUE /\ SendKept(0)
          /\ UNCHANGED <<proc, tree, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped,
                         wakes, said, dropped, runs, closed>>

(* The process's leader exits (its input closed and its background done, a crash, a kill): a run at work ends, with
   its kept report if a Monitor held one, else with an error; its tree may outlive it; its tree check starts. *)
ProcExit ==
  /\ Live
  /\ proc' = "exited" /\ checking' = TRUE /\ bg' = 0 /\ mon' = 0 /\ old' = 0 /\ keep' = FALSE /\ tree' \in BOOLEAN
  /\ IF run = "working" /\ hold # "none" /\ Bug # "monexit" THEN SendKept(0) /\ UNCHANGED dropped
     ELSE IF run = "working" THEN Drop("exited") /\ UNCHANGED told
     ELSE UNCHANGED <<run, hold, turn, kept, told, dropped, reports, outcome>>
  /\ UNCHANGED <<older, sent, read, held, lost, failed, stopped, wakes, said, runs, closed>>

(* The tree check of the process the session is on answers (endTree: killed and confirmed gone, or it outlived the
   kill). A held run then goes into a new process, or ends with an error. *)
TreeChecked(ok) ==
  /\ checking /\ (ok \/ tree)
  /\ tree' = (tree /\ ~ok) /\ checking' = FALSE
  /\ UNCHANGED <<keep, mon, old, older, sent, lost, stopped, hold, turn, wakes, kept, said, told, dropped, runs, closed>>
  /\ IF run = "held" /\ ~(tree /\ ~ok)
     THEN run' = "working" /\ proc' = "open" /\ bg' = 0 /\ read' = read + held /\ held' = 0 /\ UNCHANGED <<failed, reports, outcome>>
     ELSE /\ proc' = "none" /\ run' = (IF run = "held" THEN "idle" ELSE run) /\ failed' = failed + held /\ held' = 0
          /\ reports' = reports + (IF run = "held" THEN 1 ELSE 0) /\ outcome' = (IF run = "held" THEN "error" ELSE outcome)
          /\ UNCHANGED <<bg, read>>

(* An earlier process's tree check answers late. It changes nothing; before the fix ("stale") it took a held run as
   if it were the check of the process that run waits for. *)
OlderChecked ==
  /\ older > 0
  /\ UNCHANGED <<tree, keep, mon, old, sent, lost, stopped, hold, turn, wakes, kept, said, told, dropped, runs, closed>>
  /\ IF Bug = "stale" /\ run = "held"
     THEN /\ IF ~Live /\ ~tree
             THEN run' = "working" /\ proc' = "open" /\ bg' = 0 /\ checking' = FALSE /\ older' = older - 1 + (IF checking THEN 1 ELSE 0)
                  /\ read' = read + held /\ held' = 0 /\ UNCHANGED <<failed, reports, outcome>>
             ELSE /\ run' = "idle" /\ failed' = failed + held /\ held' = 0 /\ older' = older - 1 /\ reports' = reports + 1
                  /\ outcome' = "error" /\ UNCHANGED <<proc, bg, checking, read>>
     ELSE older' = older - 1 /\ UNCHANGED <<proc, run, bg, checking, read, held, failed, reports, outcome>>

(* What an exited process left behind ends on its own. *)
TreeGone == tree /\ ~Live /\ tree' = FALSE
  /\ UNCHANGED <<proc, run, keep, bg, mon, old, checking, older, sent, read, held, lost, failed, stopped,
                 hold, turn, wakes, kept, said, told, dropped, runs, reports, outcome, closed>>

(* The run under way and its held words are dropped (so is a report kept for a Monitor), its process is killed. *)
CutOff(how) ==
  /\ run' = "idle" /\ held' = 0 /\ stopped' = stopped + held /\ keep' = FALSE
  /\ hold' = "none" /\ turn' = FALSE /\ kept' = 0 /\ dropped' = dropped + kept
  /\ reports' = reports + (IF run # "idle" THEN 1 ELSE 0) /\ outcome' = (IF run # "idle" THEN how ELSE outcome)
  /\ IF Live THEN proc' = "exited" /\ checking' = TRUE /\ bg' = 0 /\ mon' = 0 /\ old' = 0 /\ tree' \in BOOLEAN
     ELSE UNCHANGED <<proc, checking, bg, mon, old, tree>>
  /\ UNCHANGED <<older, sent, read, lost, failed, wakes, said, told, runs>>

(* The core stops the worker (app_cancel_task, the row's Stop). *)
Stop == (run # "idle" \/ Live) /\ CutOff("stopped") /\ UNCHANGED closed

(* The app closes (quit, restart): a run under way is cut off, the core marks it interrupted; nothing starts again. *)
AppClose == ~closed /\ closed' = TRUE /\ CutOff("interrupted")

-----------------------------------------------------------------------------

Init ==
  /\ proc = "none" /\ tree = FALSE /\ run = "idle" /\ keep = FALSE /\ bg = 0 /\ mon = 0 /\ old = 0
  /\ checking = FALSE /\ older = 0
  /\ sent = 0 /\ read = 0 /\ held = 0 /\ lost = 0 /\ failed = 0 /\ stopped = 0
  /\ hold = "none" /\ turn = FALSE /\ wakes = 0 /\ kept = 0 /\ said = 0 /\ told = 0 /\ dropped = 0
  /\ runs = 0 /\ reports = 0 /\ outcome = "none" /\ closed = FALSE

Next ==
  \/ Start \/ Steer \/ (\E ok \in BOOLEAN : Result(ok)) \/ WakeTurn \/ KeepAliveFires \/ BgStart \/ BgEnd \/ Age
  \/ MonStart \/ MonEnd \/ OldEnd \/ MonExpire \/ GraceFires \/ ProcExit
  \/ (\E ok \in BOOLEAN : TreeChecked(ok)) \/ OlderChecked \/ TreeGone \/ Stop \/ AppClose

(* Timers fire; time passes (background work turns old or ends, a Monitor runs past its cap); a process whose input
   is closed ends; every tree check answers; a wake turn ends with its result. *)
Fairness ==
  /\ WF_vars(KeepAliveFires) /\ WF_vars(Age) /\ WF_vars(\E ok \in BOOLEAN : TreeChecked(ok)) /\ WF_vars(OlderChecked)
  /\ WF_vars(proc = "closed" /\ ProcExit)
  /\ WF_vars(MonExpire) /\ WF_vars(GraceFires) /\ WF_vars(hold # "none" /\ turn /\ \E ok \in BOOLEAN : Result(ok))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* Every word sent is somewhere: read, waiting, or dropped for a stated reason (lost is the bug). *)
WordsAccounted == sent = read + held + lost + failed + stopped
(* No word is written into an input the app closed. *)
NoWordLost == lost = 0
(* A held run has words waiting, and waits only for a process that is ending (input closed, or exited and its
   tree check under way). *)
HeldHasWords == (run = "held") <=> held > 0
HeldOnlyWhileEnding == run = "held" => proc \in {"closed", "exited"}
(* An exited process's tree check is the one under way. *)
ExitedIsChecked == (proc = "exited") <=> checking
(* A run at work is in a live process whose input is open. *)
WorkingIsOpen == run = "working" => proc = "open"
(* An idle open process always has its keep-alive armed: it never stays awake forever by mistake. *)
IdleHasTimer == proc = "open" /\ run = "idle" => keep
(* Never two processes on one session: a live one is the only one alive. *)
OneProcess == Live => ~tree
(* Background work is a live process's. *)
BackgroundIsLive == ~Live => Bg = 0

(* Every run ends exactly once: with its report, an error, its process's end, a stop or the app's close. *)
OneReportPerRun == runs = reports + (IF run = "idle" THEN 0 ELSE 1)
(* Every turn's report words are somewhere: kept for a Monitor, in the run's report, or dropped with their run. *)
TextsAccounted == said = told + kept + dropped
(* A kept report belongs to a run at work in an open process, and has words. *)
KeptIsAtWork == hold # "none" => run = "working" /\ proc = "open" /\ kept > 0
NothingKept == hold = "none" => kept = 0 /\ ~turn
(* The timer on a cap waits on a live Monitor. *)
CapIsLive == hold = "cap" => mon > 0
(* After the app's close no run is at work and no process lives. *)
ClosedIsQuiet == closed => run = "idle" /\ ~Live

(* The input is never closed while background work started less than 6 hours ago runs. *)
NoSleepWithBackground == [][proc = "open" /\ proc' = "closed" => Bg = 0]_vars
(* A held run fails only when the tree of the process it waited for outlived the kill (the spawn refused for a
   reason the run's error says). *)
HeldFailsOnlyForLeftovers == [][run = "held" /\ run' = "idle" /\ failed' > failed => tree']_vars
(* A report is kept back only for a turn that ended well, while a live Monitor runs. *)
HoldOnlyForMonitor == [][hold = "none" /\ hold' # "none" => mon > 0 /\ said' = said + 1]_vars
(* A timer never ends a run while a turn is under way: only that turn's result does (or the process's end, a stop,
   the app's close). *)
TurnNotCutOff == [][hold # "none" /\ turn /\ run' = "idle" /\ proc' = "open" /\ ~closed' => said' > said \/ outcome' = "error"]_vars
(* A run whose report is kept ends with it (every turn's words), unless a later turn fails or the run is stopped or
   cut off by the app's close: never "exited before its report". *)
KeptIsReported == [][hold # "none" /\ run' = "idle" =>
                      \/ outcome' = "report" /\ told' = told + kept + (said' - said)
                      \/ outcome' \in {"error", "stopped", "interrupted"}]_vars

(* Liveness *)

(* Words that wait are taken: read by a new process, or their run ends with an error or is stopped. *)
HeldIsTaken == run = "held" ~> run # "held"
WordsSettle == held > 0 ~> held = 0
(* A kept report goes out (or its run ends otherwise): no run stays at work forever for a Monitor. *)
KeptIsSent == hold # "none" ~> hold = "none"
=============================================================================
