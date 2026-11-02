------------------------------- MODULE DataLock -------------------------------
(* One core per data folder (desktop/src/core/store/data-dir-lock.ts, its use in desktop/src/core/main.ts).
   Cores are processes: each starts once, claims the folder at the data path (core.lock inside it), writes
   while it holds it, checks every few seconds that it still does, and lets go on exit; any of them may be
   killed at any step and its pid handed to a later process. The folder at the path may be renamed aside and
   replaced (a copy that carries the lock with it, or a fresh one) while cores run.
   One step is one file-system operation:
     Try    put a whole record in place as core.lock (a directory renamed in: refused when one is there)
     Look   read the holder; it may be this core, someone alive (wait), or stale/none (break it)
     Break  remove the holder judged stale by its record's own name (nobody else's record can go)
     Ident  note which folder was claimed (its dev:ino)
     Check  the self-check: same folder, and the holder is still this core (none: claim it back)
     Leave  on exit, remove this core's own record *)
EXTENDS Naturals

CONSTANTS Cores,    \* the processes that ever run a core on this folder (each starts once; a restart is another one)
          None,     \* no holder (core.lock absent, or empty)
          MaxSwap,  \* how many times the folder at the path is replaced
          Bug       \* "none": the design; "naive": check, then write the lock over whatever is there;
                    \* "restore": 7be956c7, move the lock aside to break it and put it back when it was not the stale one

Folders == 0..MaxSwap
Pcs == {"idle", "try", "look", "break", "verify", "wait", "ident", "writing", "exit", "dead"}

VARIABLES
  pc,       \* where each core is
  lock,     \* per folder: whose record core.lock holds
  gen,      \* the folder at the data path now
  home,     \* the folder each core last put its record into (where it really is; the core does not know this)
  mine,     \* the folder each core believes it claimed (Ident's dev:ino)
  again,    \* the claim is the self-check claiming back a lock that went missing (refused: exit, do not wait)
  judged,   \* the holder each core found stale (or None) and is breaking
  aside,    \* Bug "restore": the record a core moved aside to check it
  reused    \* a dead core's pid now belongs to a process started later

vars == <<pc, lock, gen, home, mine, again, judged, aside, reused>>

TypeOK ==
  /\ pc \in [Cores -> Pcs]
  /\ lock \in [Folders -> Cores \cup {None}]
  /\ gen \in Folders
  /\ home \in [Cores -> Folders \cup {None}] /\ mine \in [Cores -> Folders \cup {None}]
  /\ again \in [Cores -> BOOLEAN]
  /\ judged \in [Cores -> Cores \cup {None}] /\ aside \in [Cores -> Cores \cup {None}]
  /\ reused \in [Cores -> BOOLEAN]

Init ==
  /\ pc = [c \in Cores |-> "idle"]
  /\ lock = [f \in Folders |-> None] /\ gen = 0
  /\ home = [c \in Cores |-> None] /\ mine = [c \in Cores |-> None]
  /\ again = [c \in Cores |-> FALSE] /\ judged = [c \in Cores |-> None] /\ aside = [c \in Cores |-> None]
  /\ reused = [c \in Cores |-> FALSE]

\* What the stale check sees of a holder: its pid is running (perhaps as someone else), and that process
\* started after the lock was written. A holder from before this machine started counts as a reused pid.
PidAlive(h) == pc[h] # "dead" \/ reused[h]
StartedAfter(h) == reused[h]
Stale(h) == ~PidAlive(h) \/ StartedAfter(h)

Go(c, p) == pc' = [pc EXCEPT ![c] = p]

\* A process that is gone: what it knew goes with it (only its record, if any, stays behind).
Gone(c) ==
  /\ pc' = [pc EXCEPT ![c] = "dead"]
  /\ home' = [home EXCEPT ![c] = None] /\ mine' = [mine EXCEPT ![c] = None] /\ again' = [again EXCEPT ![c] = FALSE]
  /\ judged' = [judged EXCEPT ![c] = None] /\ aside' = [aside EXCEPT ![c] = None]

-----------------------------------------------------------------------------
(* A core. *)

Start(c) ==
  /\ pc[c] = "idle" /\ Go(c, "try")
  /\ UNCHANGED <<lock, gen, home, mine, again, judged, aside, reused>>

Try(c) ==
  /\ pc[c] = "try"
  /\ IF lock[gen] = None
       THEN /\ lock' = [lock EXCEPT ![gen] = c] /\ home' = [home EXCEPT ![c] = gen] /\ Go(c, "ident")
       ELSE /\ Go(c, "look") /\ UNCHANGED <<lock, home>>
  /\ UNCHANGED <<gen, mine, again, judged, aside, reused>>

Look(c) ==
  /\ pc[c] = "look"
  /\ LET h == lock[gen] IN
       CASE h = c ->
              \* The holder claiming again: it keeps the folder it claimed first.
              /\ Go(c, "writing") /\ again' = [again EXCEPT ![c] = FALSE]
              /\ mine' = [mine EXCEPT ![c] = IF @ = None THEN gen ELSE @]
              /\ UNCHANGED judged
         [] h # None /\ ~Stale(h) ->
              /\ Go(c, IF again[c] THEN "exit" ELSE "wait") /\ UNCHANGED <<again, mine, judged>>
         [] OTHER ->
              /\ Go(c, "break") /\ judged' = [judged EXCEPT ![c] = h] /\ UNCHANGED <<again, mine>>
  /\ UNCHANGED <<lock, gen, home, aside, reused>>

Break(c) ==
  /\ pc[c] = "break"
  /\ CASE Bug = "naive" ->
            /\ lock' = [lock EXCEPT ![gen] = c] /\ home' = [home EXCEPT ![c] = gen] /\ Go(c, "ident")
            /\ judged' = [judged EXCEPT ![c] = None] /\ UNCHANGED aside
       [] Bug = "restore" ->
            IF lock[gen] = None
              THEN Go(c, "try") /\ judged' = [judged EXCEPT ![c] = None] /\ UNCHANGED <<lock, home, aside>>
              ELSE /\ aside' = [aside EXCEPT ![c] = lock[gen]] /\ lock' = [lock EXCEPT ![gen] = None]
                   /\ Go(c, "verify") /\ UNCHANGED <<home, judged>>
       [] OTHER ->
            /\ lock' = IF judged[c] # None /\ lock[gen] = judged[c] THEN [lock EXCEPT ![gen] = None] ELSE lock
            /\ Go(c, "try") /\ judged' = [judged EXCEPT ![c] = None] /\ UNCHANGED <<home, aside>>
  /\ UNCHANGED <<gen, mine, again, reused>>

\* Bug "restore" only: the record moved aside was not the one judged stale: link it back (refused when taken).
Verify(c) ==
  /\ pc[c] = "verify"
  /\ lock' = IF aside[c] # judged[c] /\ lock[gen] = None THEN [lock EXCEPT ![gen] = aside[c]] ELSE lock
  /\ aside' = [aside EXCEPT ![c] = None] /\ judged' = [judged EXCEPT ![c] = None] /\ Go(c, "try")
  /\ UNCHANGED <<gen, home, mine, again, reused>>

Ident(c) ==
  /\ pc[c] = "ident"
  /\ mine' = [mine EXCEPT ![c] = gen] /\ again' = [again EXCEPT ![c] = FALSE] /\ Go(c, "writing")
  /\ UNCHANGED <<lock, gen, home, judged, aside, reused>>

\* The claim was refused (another core owns the folder): poll again, or give up (exit 75; main shows the notice).
Retry(c) == pc[c] = "wait" /\ Go(c, "try") /\ UNCHANGED <<lock, gen, home, mine, again, judged, aside, reused>>
GiveUp(c) == pc[c] = "wait" /\ Go(c, "exit") /\ UNCHANGED <<lock, gen, home, mine, again, judged, aside, reused>>

Check(c) ==
  /\ pc[c] = "writing"
  /\ CASE mine[c] # gen \/ lock[gen] \notin {c, None} -> Go(c, "exit") /\ UNCHANGED again
       [] lock[gen] = None -> Go(c, "try") /\ again' = [again EXCEPT ![c] = TRUE]
       [] OTHER -> UNCHANGED <<pc, again>>
  /\ UNCHANGED <<lock, gen, home, mine, judged, aside, reused>>

\* The core is done (quit, restart, install). Until then it may take as long as it likes: the slow exit.
Quit(c) == pc[c] = "writing" /\ Go(c, "exit") /\ UNCHANGED <<lock, gen, home, mine, again, judged, aside, reused>>

\* Process exit: the record at the path is removed if it is this core's own.
Leave(c) ==
  /\ pc[c] = "exit" /\ Gone(c)
  /\ lock' = IF lock[gen] = c THEN [lock EXCEPT ![gen] = None] ELSE lock
  /\ UNCHANGED <<gen, reused>>

\* Crash or SIGKILL at any step: nothing is let go; a record moved aside stays aside.
Crash(c) ==
  /\ pc[c] \notin {"idle", "dead"} /\ Gone(c)
  /\ UNCHANGED <<lock, gen, reused>>

Reuse(c) ==
  /\ pc[c] = "dead" /\ ~reused[c] /\ reused' = [reused EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<pc, lock, gen, home, mine, again, judged, aside>>

-----------------------------------------------------------------------------
(* The world. *)

\* The folder at the path is renamed aside and another put in its place: a copy (with the lock as it was) or a fresh one.
Swap ==
  /\ gen < MaxSwap
  /\ \E copy \in {lock[gen], None} : lock' = [lock EXCEPT ![gen + 1] = copy]
  /\ gen' = gen + 1
  /\ UNCHANGED <<pc, home, mine, again, judged, aside, reused>>

Step(c) == Try(c) \/ Look(c) \/ Break(c) \/ Verify(c) \/ Ident(c) \/ Retry(c) \/ Check(c) \/ Leave(c)

Next ==
  \/ \E c \in Cores : Start(c) \/ Step(c) \/ GiveUp(c) \/ Quit(c) \/ Crash(c) \/ Reuse(c)
  \/ Swap

\* A core that has begun goes on (its claim, its self-check, its exit); starting, giving up, quitting, crashing,
\* pid reuse and swaps are never forced.
Fairness == \A c \in Cores : WF_vars(Step(c))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety. *)

Writing(c) == pc[c] = "writing"

\* Never two cores writing the folder at the path, except one whose own folder was swapped out from under it
\* (it writes by path into the new one until its next self-check: no lock inside a folder can stop that).
OneWriter == \A c, d \in Cores : c # d /\ Writing(c) /\ Writing(d) => home[c] # gen \/ home[d] # gen

\* A core writes only while the lock it put in place still names it, unless that folder was swapped out.
HoldsLock == \A c \in Cores : Writing(c) /\ home[c] = gen => lock[gen] = c

(* Liveness. *)

\* A core whose folder was swapped, or whose lock names another core, stops writing.
SwappedStops == \A c \in Cores : (Writing(c) /\ (mine[c] # gen \/ lock[gen] # c)) ~> ~Writing(c)

\* No lost lock: once its holder is gone (whatever its pid now shows), a core that is claiming gets the folder
\* (or it dies).
Lost == lock[gen] = None \/ pc[lock[gen]] = "dead"
Owned == lock[gen] # None /\ pc[lock[gen]] # "dead"
Recovers == \A c \in Cores : (pc[c] \in {"try", "look", "break", "verify"} /\ Lost) ~> (Owned \/ pc[c] = "dead")
=============================================================================
