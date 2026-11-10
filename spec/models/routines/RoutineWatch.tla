---------------------------- MODULE RoutineWatch ----------------------------
(* A watch routine (desktop/src/core/routine-watch.ts, bot.ts startWatch): a routine whose instruction is "Name: !command".
   At its time the app runs the command itself, in the bot's folder, and wakes nobody; a failure wakes the bot. The
   storm rule (nextWatchState): the first failure of a streak wakes the bot; while it keeps failing it is woken again
   only once Rewake (6 hours) has passed since the last wake; a pass re-arms it (the next failure wakes at once) and
   wakes nobody. What the app keeps of the watch (bot.json routineWatches) is saved in the step that takes a result,
   so it is the same after a restart. A run still going when the watch's next time comes is not started twice.

   The command runs in a process group of its own. When the app dies, the run's result is lost; its command lives on
   (`orphan`) until it ends by itself, or the next start ends the groups an earlier core left (the process ledger,
   server.ts endLeftovers): the watch's command is recorded there (this model's fix), so the next run never starts
   beside it.

   Routines.tla says when a routine's time comes (an occurrence claimed once); here each tick is one occurrence.
   Action names match spec/reference/routine-watch.ts and the driver (spec/driver/routine-watch-driver.ts). *)
EXTENDS Integers

CONSTANTS
  MaxTime,    \* ticks of the clock (each one an occurrence of the watch's schedule)
  Rewake,     \* the cooldown (6 hours) in ticks
  MaxCrash,   \* app deaths in one behaviour
  Bug         \* "none"; "storm": every failure wakes the bot (no storm rule); "rearm": a pass does not re-arm (the
              \* cooldown counts from the last wake whatever passed since); "orphan": before the fix, a watch's
              \* command is not in the process ledger, so it outlives the app and the next start leaves it running

ASSUME MaxTime \in Nat /\ Rewake \in Nat \ {0} /\ MaxCrash \in Nat /\ Bug \in {"none", "storm", "rearm", "orphan"}

None == -1
Time == 0..MaxTime
Kept == [state: {"never", "ok", "failing"}, wokeAt: Time \cup {None}]
Never == [state |-> "never", wokeAt |-> None]

VARIABLES
  now, up, crashes,
  running,    \* the app's run of the watch is under way (watchesRunning)
  orphan,     \* a command an earlier app life started is still running
  ranAt,      \* the occurrence last taken (its time came: started, or skipped while a run was under way)
  disk, mem,  \* what bot.json routineWatches keeps of the watch; what the app has of it in memory
  last, nres, woken, lastWake   \* history: the last result the app took and how many; wakes; the last wake's time

vars == <<now, up, crashes, running, orphan, ranAt, disk, mem, last, nres, woken, lastWake>>

TypeOK ==
  /\ now \in Time /\ up \in BOOLEAN /\ crashes \in 0..MaxCrash
  /\ running \in BOOLEAN /\ orphan \in BOOLEAN /\ ranAt \in Time \cup {None}
  /\ disk \in Kept /\ mem \in Kept
  /\ last \in {"none", "pass", "fail"} /\ nres \in 0..MaxTime + 1 /\ woken \in 0..MaxTime + 1 /\ lastWake \in Time \cup {None}

Init ==
  /\ now = 0 /\ up = TRUE /\ crashes = 0 /\ running = FALSE /\ orphan = FALSE /\ ranAt = None
  /\ disk = Never /\ mem = Never /\ last = "none" /\ nres = 0 /\ woken = 0 /\ lastWake = None

-----------------------------------------------------------------------------

Tick == now < MaxTime /\ now' = now + 1 /\ UNCHANGED <<up, crashes, running, orphan, ranAt, disk, mem, last, nres, woken, lastWake>>

(* The watch's time comes (the clock's check): its command starts, unless the app's run of it is still under way. *)
Due ==
  /\ up /\ ranAt # now /\ ranAt' = now
  /\ running' = TRUE
  /\ UNCHANGED <<now, up, crashes, orphan, disk, mem, last, nres, woken, lastWake>>

(* The command ends and the app takes its result (nextWatchState), saves it and wakes the bot or not, in one step. *)
Finish(r) ==
  /\ up /\ running /\ running' = FALSE
  /\ LET streak == mem.state = "failing"
         before == IF streak \/ Bug = "rearm" THEN mem.wokeAt ELSE None
         wake == r = "fail" /\ (before = None \/ now - before >= Rewake \/ Bug = "storm")
         kept == IF r = "pass" THEN [state |-> "ok", wokeAt |-> IF Bug = "rearm" THEN mem.wokeAt ELSE None]
                 ELSE [state |-> "failing", wokeAt |-> IF wake THEN now ELSE before]
     IN /\ mem' = kept /\ disk' = kept
        /\ woken' = woken + (IF wake THEN 1 ELSE 0) /\ lastWake' = IF wake THEN now ELSE lastWake
  /\ last' = r /\ nres' = nres + 1
  /\ UNCHANGED <<now, up, crashes, orphan, ranAt>>

(* A command an earlier app life started ends by itself; nobody takes its result. *)
OrphanEnds == orphan /\ orphan' = FALSE /\ UNCHANGED <<now, up, crashes, running, ranAt, disk, mem, last, nres, woken, lastWake>>

(* The app dies: the run under way is lost to it, its command lives on. *)
Crash ==
  /\ up /\ crashes < MaxCrash /\ crashes' = crashes + 1 /\ up' = FALSE
  /\ running' = FALSE /\ orphan' = (orphan \/ running)
  /\ UNCHANGED <<now, ranAt, disk, mem, last, nres, woken, lastWake>>

(* The app starts: it ends the process groups an earlier core left (not a watch's command before the fix) and reads
   what bot.json keeps of the watch. *)
Boot ==
  /\ ~up /\ up' = TRUE /\ mem' = disk
  /\ orphan' = (orphan /\ Bug = "orphan")
  /\ UNCHANGED <<now, crashes, running, ranAt, disk, last, nres, woken, lastWake>>

Next == Tick \/ Due \/ (\E r \in {"pass", "fail"} : Finish(r)) \/ OrphanEnds \/ Crash \/ Boot

(* A command ends (the app stops it after 120 s at the latest); the app comes back. *)
Fairness == WF_vars(\E r \in {"pass", "fail"} : Finish(r)) /\ WF_vars(Boot)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* The same watch never runs twice at once: not two runs of the app's, nor one beside a command an earlier app life
   left running. *)
NoOverlap == ~(running /\ orphan)
(* What the app has of the watch is what bot.json keeps: the same after a restart. *)
MemIsDisk == up => mem = disk
(* A failing streak's last wake is kept; a passing watch keeps none. *)
KeptIsHistory == /\ (disk.state = "failing") <=> (last = "fail")
                 /\ disk.state = "failing" => disk.wokeAt = lastWake
                 /\ disk.state # "failing" => disk.wokeAt = None

Took(r) == nres' = nres + 1 /\ last' = r
Woke == woken' = woken + 1
(* The first failure (none before, or a pass before it) wakes the bot at once. *)
FirstFailureWakes == [][Took("fail") /\ last # "fail" => Woke]_vars
(* While it keeps failing, the bot is not woken again within the cooldown ... *)
QuietInCooldown == [][Took("fail") /\ last = "fail" /\ now - lastWake < Rewake => ~Woke]_vars
(* ... and is woken again once it has passed. *)
RewakeAfterCooldown == [][Took("fail") /\ last = "fail" /\ now - lastWake >= Rewake => Woke]_vars
(* A pass wakes nobody. *)
PassWakesNobody == [][Took("pass") => ~Woke]_vars
(* Only a result the app took wakes the bot. *)
WakeOnlyOnResult == [][Woke => nres' = nres + 1]_vars

(* Liveness *)

(* Every run the app started ends, its result taken, or the app died. *)
RunEnds == running ~> ~running
(* A command left behind by an earlier app life does not run on forever beside the app. *)
OrphanGone == orphan ~> (~orphan \/ ~up)
=============================================================================
