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

     proc: none --Start (spawn)--> open --KeepAliveFires (idle, no fresh background)--> closed
           open | closed --ProcExit | Stop--> exited --TreeChecked--> none (leftovers may stay: `tree`)
     run:  idle --Start--> working --Result--> idle            (ProcExit: the run ends with an error)
           idle --Start (proc closed)--> held --TreeChecked--> working (new process) | idle (error)

   Words are counted by where they went: `read` (an open input), `lost` (a closed input), `held` (waiting),
   `failed` (their run ended with an error before they were read), `stopped` (their run was stopped).
   Action names match spec/reference/worker-process.ts and the driver (spec/driver/worker-process-driver.ts). *)
EXTENDS Naturals

CONSTANTS
  MaxWords,   \* bound: words sent in one behaviour (a run's first words and its steers); every process is started
              \* by words, so this bounds processes too
  MaxBg,      \* bound: background tasks at once
  Bug         \* "none"; "sleep": before 95fcab3a (the keep-alive closes the input whatever runs in the background,
              \* and words go into whatever process is there); "bg": only the background rule left out;
              \* "stale": before this model's fix (any exit's tree check, however late, acts on a held run)

ASSUME MaxWords \in Nat /\ MaxBg \in Nat /\ Bug \in {"none", "sleep", "bg", "stale"}

VARIABLES proc, tree, run, keep, bg, checking, older, sent, read, held, lost, failed, stopped
vars == <<proc, tree, run, keep, bg, checking, older, sent, read, held, lost, failed, stopped>>

TypeOK ==
  /\ proc \in {"none", "open", "closed", "exited"}
  /\ tree \in BOOLEAN           \* the last exited process's tree is still alive (children outlived its leader)
  /\ run \in {"idle", "working", "held"}
  /\ keep \in BOOLEAN           \* the keep-alive timer is armed
  /\ bg \in 0..MaxBg            \* background tasks started less than 6 hours ago
  /\ checking \in BOOLEAN       \* the tree check (endTree) of the process the session is on has not answered yet
  /\ older \in 0..MaxWords      \* tree checks of earlier processes not answered yet
  /\ sent \in 0..MaxWords /\ read \in 0..MaxWords /\ held \in 0..MaxWords /\ lost \in 0..MaxWords
  /\ failed \in 0..MaxWords /\ stopped \in 0..MaxWords

Live == proc \in {"open", "closed"}
\* A new process may take the session: no process of it is alive (spawn's live `gone()` check of the last tree).
CanSpawn == ~Live /\ ~tree
\* A new process takes the session: a check still under way is now an earlier process's.
Spawned == proc' = "open" /\ bg' = 0 /\ checking' = FALSE /\ older' = older + (IF checking THEN 1 ELSE 0)

-----------------------------------------------------------------------------

(* The core sends a run's first words. Into the open process; else a new one; a closed input holds them (a new
   process takes them once this one has ended). A spawn refused (an earlier tree is still alive) fails the run. *)
Start ==
  /\ run = "idle" /\ sent < MaxWords /\ sent' = sent + 1 /\ keep' = FALSE
  /\ IF proc = "open" \/ (proc = "closed" /\ Bug = "sleep") THEN
       /\ run' = "working"
       /\ IF proc = "open" THEN read' = read + 1 /\ lost' = lost ELSE lost' = lost + 1 /\ read' = read
       /\ UNCHANGED <<proc, bg, checking, older, held, failed>>
     ELSE IF proc = "closed" THEN
       /\ run' = "held" /\ held' = 1 /\ UNCHANGED <<proc, bg, checking, older, read, lost, failed>>
     ELSE IF CanSpawn THEN
       /\ run' = "working" /\ Spawned /\ read' = read + 1 /\ UNCHANGED <<held, lost, failed>>
     ELSE
       /\ failed' = failed + 1 /\ UNCHANGED <<proc, run, bg, checking, older, read, held, lost>>
  /\ UNCHANGED <<tree, stopped>>

(* Words for the run under way: into its process, or with the held words. *)
Steer ==
  /\ run \in {"working", "held"} /\ sent < MaxWords /\ sent' = sent + 1
  /\ IF run = "held" THEN held' = held + 1 /\ UNCHANGED <<read, lost>>
     ELSE IF proc = "open" THEN read' = read + 1 /\ UNCHANGED <<held, lost>>
     ELSE lost' = lost + 1 /\ UNCHANGED <<read, held>>
  /\ UNCHANGED <<proc, tree, run, keep, bg, checking, older, failed, stopped>>

(* The run's turn ends: the process stays, its keep-alive armed. *)
Result ==
  /\ run = "working" /\ Live
  /\ run' = "idle" /\ keep' = TRUE
  /\ UNCHANGED <<proc, tree, bg, checking, older, sent, read, held, lost, failed, stopped>>

(* The keep-alive runs out: the input of an idle process is closed, unless fresh background work runs (then the
   timer is armed again). *)
KeepAliveFires ==
  /\ keep /\ keep' = (bg > 0 /\ proc = "open" /\ run = "idle" /\ Bug \notin {"sleep", "bg"})
  /\ proc' = IF proc = "open" /\ run = "idle" /\ (bg = 0 \/ Bug \in {"sleep", "bg"}) THEN "closed" ELSE proc
  /\ UNCHANGED <<tree, run, bg, checking, older, sent, read, held, lost, failed, stopped>>

(* The process leaves a command, a Monitor or an agent running in the background; it ends, or turns 6 hours old
   (Age: then it keeps the process no longer). *)
BgStart == Live /\ bg < MaxBg /\ bg' = bg + 1
  /\ UNCHANGED <<proc, tree, run, keep, checking, older, sent, read, held, lost, failed, stopped>>
BgEnd == bg > 0 /\ bg' = bg - 1
  /\ UNCHANGED <<proc, tree, run, keep, checking, older, sent, read, held, lost, failed, stopped>>
Age == bg > 0 /\ bg' = 0
  /\ UNCHANGED <<proc, tree, run, keep, checking, older, sent, read, held, lost, failed, stopped>>

(* The process's leader exits (its input closed and its background done, a crash, a kill): a run at work ends with
   an error; its tree may outlive it; its tree check starts. *)
ProcExit ==
  /\ Live
  /\ proc' = "exited" /\ checking' = TRUE /\ bg' = 0 /\ keep' = FALSE /\ tree' \in BOOLEAN
  /\ run' = IF run = "working" THEN "idle" ELSE run
  /\ UNCHANGED <<older, sent, read, held, lost, failed, stopped>>

(* The tree check of the process the session is on answers (endTree: killed and confirmed gone, or it outlived the
   kill). A held run then goes into a new process, or ends with an error. *)
TreeChecked(ok) ==
  /\ checking /\ (ok \/ tree)
  /\ tree' = (tree /\ ~ok) /\ checking' = FALSE /\ UNCHANGED <<keep, older, sent, lost, stopped>>
  /\ IF run = "held" /\ ~(tree /\ ~ok)
     THEN run' = "working" /\ proc' = "open" /\ bg' = 0 /\ read' = read + held /\ held' = 0 /\ UNCHANGED failed
     ELSE /\ proc' = "none" /\ run' = (IF run = "held" THEN "idle" ELSE run) /\ failed' = failed + held /\ held' = 0
          /\ UNCHANGED <<bg, read>>

(* An earlier process's tree check answers late. It changes nothing; before the fix ("stale") it took a held run as
   if it were the check of the process that run waits for. *)
OlderChecked ==
  /\ older > 0 /\ UNCHANGED <<tree, keep, sent, lost, stopped>>
  /\ IF Bug = "stale" /\ run = "held"
     THEN /\ IF ~Live /\ ~tree
             THEN run' = "working" /\ proc' = "open" /\ bg' = 0 /\ checking' = FALSE /\ older' = older - 1 + (IF checking THEN 1 ELSE 0)
                  /\ read' = read + held /\ held' = 0 /\ UNCHANGED failed
             ELSE run' = "idle" /\ failed' = failed + held /\ held' = 0 /\ older' = older - 1 /\ UNCHANGED <<proc, bg, checking, read>>
     ELSE older' = older - 1 /\ UNCHANGED <<proc, run, bg, checking, read, held, failed>>

(* What an exited process left behind ends on its own. *)
TreeGone == tree /\ ~Live /\ tree' = FALSE
  /\ UNCHANGED <<proc, run, keep, bg, checking, older, sent, read, held, lost, failed, stopped>>

(* The core stops the worker (app_cancel_task, the row's Stop): the run under way and its held words are dropped,
   its process is killed. *)
Stop ==
  /\ run # "idle" \/ Live
  /\ run' = "idle" /\ held' = 0 /\ stopped' = stopped + held /\ keep' = FALSE
  /\ IF Live THEN proc' = "exited" /\ checking' = TRUE /\ bg' = 0 /\ tree' \in BOOLEAN
     ELSE UNCHANGED <<proc, checking, bg, tree>>
  /\ UNCHANGED <<older, sent, read, lost, failed>>

-----------------------------------------------------------------------------

Init ==
  /\ proc = "none" /\ tree = FALSE /\ run = "idle" /\ keep = FALSE /\ bg = 0 /\ checking = FALSE /\ older = 0
  /\ sent = 0 /\ read = 0 /\ held = 0 /\ lost = 0 /\ failed = 0 /\ stopped = 0

Next ==
  \/ Start \/ Steer \/ Result \/ KeepAliveFires \/ BgStart \/ BgEnd \/ Age \/ ProcExit
  \/ (\E ok \in BOOLEAN : TreeChecked(ok)) \/ OlderChecked \/ TreeGone \/ Stop

(* Timers fire; time passes (background work turns old or ends); a process whose input is closed ends; every tree
   check answers. *)
Fairness ==
  /\ WF_vars(KeepAliveFires) /\ WF_vars(Age) /\ WF_vars(\E ok \in BOOLEAN : TreeChecked(ok)) /\ WF_vars(OlderChecked)
  /\ WF_vars(proc = "closed" /\ ProcExit)

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

(* The input is never closed while background work started less than 6 hours ago runs. *)
NoSleepWithBackground == [][proc = "open" /\ proc' = "closed" => bg = 0]_vars
(* A held run fails only when the tree of the process it waited for outlived the kill (the spawn refused for a
   reason the run's error says). *)
HeldFailsOnlyForLeftovers == [][run = "held" /\ run' = "idle" /\ failed' > failed => tree']_vars

(* Liveness *)

(* Words that wait are taken: read by a new process, or their run ends with an error or is stopped. *)
HeldIsTaken == run = "held" ~> run # "held"
WordsSettle == held > 0 ~> held = 0
=============================================================================
