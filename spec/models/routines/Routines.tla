------------------------------ MODULE Routines ------------------------------
(* Botling's routines scheduling (desktop/src/core/routines.ts; the clock is bot.ts checkRoutines).  *)
(* Each bot (a project bot, or a sub bot with its own .bot/sub-bots/<id>/) keeps two files:          *)
(*  - routines.cron, "legacy" jobs the bot edits itself, run when their latest time has passed and    *)
(*    they have not run since (bot.json routineRuns); a job seen for the first time starts from now;  *)
(*  - scheduled-routines.json, app-owned "once"/"recurring" jobs, created with a request id; a job is *)
(*    written claimed before it is dispatched and fired/pending after, so a crash in between leaves   *)
(*    it claimed (delivery_uncertain), never sent again. A broken file is told, never read as empty.  *)
(* Time is a small discrete clock (one step a minute). The app may be down while time passes; the   *)
(* clock's next look runs an overdue once job and the latest occurrence of a recurring one.          *)
(* The clock looks every few seconds (15 s); Check may happen any number of times within a minute,   *)
(* so "once per matching minute" holds whatever the interval.                                        *)
(* One-shot lines, "@once Name: what to do" in routines.cron (a script the bot started appends one): *)
(* the check takes the line out of the file (RoutineFile.takeOnce) and only then dispatches it, so a *)
(* line runs at most once; a line appended again is a new line and runs again. A "#@once" line is    *)
(* paused and never runs. Each app rewrite of routines.cron (takeOnce, create, add, pause/resume/     *)
(* cancel) reads the file through a handle it keeps, renames a new file over it, then reads the old *)
(* file again through the handle and appends back what other programs wrote into it meanwhile; the  *)
(* lines it read are never put back, so the line it took or changed stays taken or changed          *)
(* (TakeRead/EditRead, Append in between, then Rewrite). What is left: a write through a handle a   *)
(* script opened on the old file and wrote after the app's second read lands in a file that is no   *)
(* longer routines.cron (AppendToReplaced), the only way a line is lost.                            *)
EXTENDS Integers, FiniteSets

CONSTANTS Jobs, Bots, Requests, MaxTime, Cron, Bug  \* Cron: the minutes a recurring/legacy job runs at
CONSTANTS Lines, OnceBug  \* Lines: one-shot line instances (each appended at most once)
\* OnceBug: "none"; "dispatch-first" (a line dispatched before it is taken out); "resurrect" (the repair appends back
\* what the old file has and the new one lacks, the taken line too).

None == -1
Time == 0..MaxTime
States == {"none", "pending", "paused", "claimed", "fired", "cancelled"}
Kinds == {"once", "recurring", "legacy"}
\* A one-shot line: not written yet, in the file, in it paused (#), taken and run, taken but the app died
\* before dispatching it, or lost (rewritten away by an app write it raced with).
LineStates == {"none", "in", "paused", "run", "taken", "lost"}

VARIABLES
  now, up,            \* the clock; whether the app runs
  st, kind, owner,    \* each job slot: its state, kind and bot ("none" until made)
  at,                 \* a once job's instant
  since,              \* scheduled: created/resumed (baseline); legacy: first seen (None until then)
  last,               \* scheduled: the occurrence last claimed; legacy: when it last ran
  req,                \* a scheduled job's request id
  fires,              \* how often each (job, occurrence) was dispatched (capped at 2)
  file,               \* each bot's scheduled-routines.json: "ok" or "broken"
  told,               \* the app's own memory that it has told this bot's broken file (gone on restart)
  said,               \* a notice of the broken file is in the bot's chat since the clock last saw it ok
  looked,             \* the clock has looked at this bot's file while broken since it last saw it ok
  ln, lowner,         \* each one-shot line: its state and the bot whose routines.cron holds it
  lfires,             \* how often each one-shot line was dispatched (capped at 2)
  tk                  \* an app rewrite of a bot's routines.cron in flight: the line it takes, "edit", or "none"

lineVars == <<ln, lowner, lfires, tk>>
vars == <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked, ln, lowner, lfires, tk>>

Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b
Made(j) == st[j] # "none"
Scheduled(j) == kind[j] \in {"once", "recurring"}

\* The occurrence a job would run for now: a once job's instant once passed, else the latest Cron minute.
Latest(t) == LET past == {c \in Cron : c <= t} IN IF past = {} THEN None ELSE CHOOSE c \in past : \A d \in past : d <= c
Occ(j) == IF kind[j] = "once" THEN (IF at[j] <= now THEN at[j] ELSE None) ELSE Latest(now)
\* Its store can be read: legacy jobs live in routines.cron, the others in scheduled-routines.json.
Readable(j) == kind[j] = "legacy" \/ file[owner[j]] = "ok"
\* A once job runs at its instant however late (even resumed after it); a recurring or legacy job runs
\* for an occurrence after it was made, resumed, seen first or last ran.
Due(j) == st[j] = "pending" /\ Readable(j) /\ Occ(j) # None /\ (kind[j] = "once" \/ (since[j] # None /\ Occ(j) > Max(since[j], last[j])))
\* What a dispatch records: the occurrence claimed (scheduled) or the time it ran (legacy).
Mark(j) == IF kind[j] = "legacy" THEN now ELSE Occ(j)
\* The core runs one thing at a time: nothing else of it happens while it rewrites a routines.cron.
Idle == \A b \in Bots : tk[b] = "none"
InFile(o) == ln[o] \in {"in", "paused"}

TypeOK ==
  /\ now \in Time /\ up \in BOOLEAN
  /\ st \in [Jobs -> States] /\ kind \in [Jobs -> Kinds \cup {"none"}] /\ owner \in [Jobs -> Bots \cup {"none"}]
  /\ at \in [Jobs -> Time \cup {None}] /\ since \in [Jobs -> Time \cup {None}] /\ last \in [Jobs -> Time \cup {None}]
  /\ req \in [Jobs -> Requests \cup {"none"}] /\ fires \in [Jobs \X Time -> 0..2]
  /\ file \in [Bots -> {"ok", "broken"}] /\ told \in [Bots -> BOOLEAN] /\ said \in [Bots -> BOOLEAN] /\ looked \in [Bots -> BOOLEAN]
  /\ ln \in [Lines -> LineStates] /\ lowner \in [Lines -> Bots \cup {"none"}] /\ lfires \in [Lines -> 0..2]
  /\ tk \in [Bots -> Lines \cup {"none", "edit"}]

Init ==
  /\ now = 0 /\ up = FALSE
  /\ st = [j \in Jobs |-> "none"] /\ kind = [j \in Jobs |-> "none"] /\ owner = [j \in Jobs |-> "none"]
  /\ at = [j \in Jobs |-> None] /\ since = [j \in Jobs |-> None] /\ last = [j \in Jobs |-> None]
  /\ req = [j \in Jobs |-> "none"] /\ fires = [p \in Jobs \X Time |-> 0]
  /\ file = [b \in Bots |-> "ok"] /\ told = [b \in Bots |-> FALSE] /\ said = [b \in Bots |-> FALSE] /\ looked = [b \in Bots |-> FALSE]
  /\ ln = [o \in Lines |-> "none"] /\ lowner = [o \in Lines |-> "none"] /\ lfires = [o \in Lines |-> 0]
  /\ tk = [b \in Bots |-> "none"]

-----------------------------------------------------------------------------
\* The environment: time passes, the app stops and starts, a file breaks or is mended.

Tick == now < MaxTime /\ now' = now + 1 /\ UNCHANGED <<up, st, kind, owner, at, since, last, req, fires, file, told, said, looked>> /\ UNCHANGED lineVars

\* A rewrite in flight dies with the app: the file keeps what it held.
Crash ==
  /\ up /\ up' = FALSE /\ tk' = [b \in Bots |-> "none"]
  /\ UNCHANGED <<now, st, kind, owner, at, since, last, req, fires, file, told, said, looked, ln, lowner, lfires>>

\* Startup reads each bot's routines; that read is not a notice (c0154c79: with Bug it counted as one).
Boot ==
  /\ ~up /\ up' = TRUE
  /\ told' = [b \in Bots |-> Bug /\ file[b] = "broken"]
  /\ UNCHANGED <<now, st, kind, owner, at, since, last, req, fires, file, said, looked>> /\ UNCHANGED lineVars

Break(b) == file[b] = "ok" /\ file' = [file EXCEPT ![b] = "broken"] /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, told, said, looked>> /\ UNCHANGED lineVars
Mend(b) == file[b] = "broken" /\ file' = [file EXCEPT ![b] = "ok"] /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, told, said, looked>> /\ UNCHANGED lineVars

\* A look at a bot's routines (the chat snapshot, routines.list) changes nothing.
View(b) == up /\ Idle /\ UNCHANGED vars

-----------------------------------------------------------------------------
\* The clock's look at one bot: a broken file is told once, a new legacy job starts from now, and
\* every due job is claimed and dispatched in its own bot's chat. Each one-shot line in the file (not
\* paused) is taken out of it, then dispatched (no other process writes the file meanwhile here; the
\* race is TakeRead/Rewrite below).

Check(b) ==
  /\ up /\ Idle
  /\ LET broken == file[b] = "broken"
         mine == {j \in Jobs : owner[j] = b}
         due == {j \in mine : Due(j)}
         fresh == {j \in mine : kind[j] = "legacy" /\ st[j] = "pending" /\ since[j] = None}
     IN /\ said' = [said EXCEPT ![b] = IF broken THEN @ \/ ~told[b] ELSE FALSE]
        /\ told' = [told EXCEPT ![b] = broken]
        /\ looked' = [looked EXCEPT ![b] = broken]
        /\ since' = [j \in Jobs |-> IF j \in fresh THEN now ELSE since[j]]
        /\ last' = [j \in Jobs |-> IF j \in due THEN Mark(j) ELSE last[j]]
        /\ st' = [j \in Jobs |-> IF j \in due /\ kind[j] = "once" THEN "fired" ELSE st[j]]
        /\ fires' = [p \in Jobs \X Time |-> IF p[1] \in due /\ p[2] = Occ(p[1]) THEN Min(fires[p] + 1, 2) ELSE fires[p]]
        /\ LET taken == {o \in Lines : lowner[o] = b /\ ln[o] = "in"}
           IN /\ ln' = [o \in Lines |-> IF o \in taken THEN "run" ELSE ln[o]]
              /\ lfires' = [o \in Lines |-> IF o \in taken THEN Min(lfires[o] + 1, 2) ELSE lfires[o]]
  /\ UNCHANGED <<now, up, kind, owner, at, req, file, lowner, tk>>

\* The claim is written, then the app dies before dispatching: the job stays claimed.
ClaimThenCrash(j) ==
  /\ up /\ Idle /\ Scheduled(j) /\ Due(j)
  /\ st' = [st EXCEPT ![j] = "claimed"] /\ last' = [last EXCEPT ![j] = Occ(j)] /\ up' = FALSE
  /\ UNCHANGED <<now, kind, owner, at, since, req, fires, file, told, said, looked>> /\ UNCHANGED lineVars

-----------------------------------------------------------------------------
\* Changes (app_routines and the app's UI). Each is a transaction on scheduled-routines.json, so
\* nothing changes while it is broken; a refused change changes nothing.

\* create: a request id this bot already has returns that schedule (or is refused); a once job is in the future.
Create(j, r, k, b, a) ==
  /\ up /\ Idle /\ file[b] = "ok"
  /\ IF \E i \in Jobs : Made(i) /\ owner[i] = b /\ req[i] = r
     THEN UNCHANGED vars
     ELSE /\ st[j] = "none"
          /\ st' = [st EXCEPT ![j] = "pending"] /\ kind' = [kind EXCEPT ![j] = k] /\ owner' = [owner EXCEPT ![j] = b]
          /\ at' = [at EXCEPT ![j] = a] /\ since' = [since EXCEPT ![j] = now] /\ req' = [req EXCEPT ![j] = r]
          /\ UNCHANGED <<now, up, last, fires, file, told, said, looked>> /\ UNCHANGED lineVars

\* The bot (or a plugin) writes a new line into its routines.cron (another process: it may land while
\* the app rewrites the file, and be lost).
AddLegacy(j, b) ==
  /\ up /\ st[j] = "none"
  /\ st' = [st EXCEPT ![j] = "pending"] /\ kind' = [kind EXCEPT ![j] = "legacy"] /\ owner' = [owner EXCEPT ![j] = b]
  /\ UNCHANGED <<now, up, at, since, last, req, fires, file, told, said, looked>> /\ UNCHANGED lineVars

Change(j) == up /\ Idle /\ Made(j) /\ file[owner[j]] = "ok"

Pause(j) ==
  /\ Change(j)
  /\ st' = [st EXCEPT ![j] = IF @ \in {"pending", "paused"} THEN "paused" ELSE @]
  /\ UNCHANGED <<now, up, kind, owner, at, since, last, req, fires, file, told, said, looked>> /\ UNCHANGED lineVars

\* Resuming starts a scheduled job from now; routines.cron keeps no such baseline, only when it last ran.
Resume(j) ==
  /\ Change(j)
  /\ st' = [st EXCEPT ![j] = IF @ = "paused" THEN "pending" ELSE @]
  /\ since' = [since EXCEPT ![j] = IF st[j] = "paused" /\ Scheduled(j) THEN now ELSE @]
  /\ UNCHANGED <<now, up, kind, owner, at, last, req, fires, file, told, said, looked>> /\ UNCHANGED lineVars

\* Cancelling stops future runs only: a claimed job is refused, a fired one stays fired.
Cancel(j) ==
  /\ Change(j)
  /\ st' = [st EXCEPT ![j] = IF @ \in {"pending", "paused"} THEN "cancelled" ELSE @]
  /\ UNCHANGED <<now, up, kind, owner, at, since, last, req, fires, file, told, said, looked>> /\ UNCHANGED lineVars

-----------------------------------------------------------------------------
\* One-shot lines. A script appends a line (or a paused "#@once" one) to a bot's routines.cron,
\* whether or not the app runs.
Append(o, b, s) ==
  /\ ln[o] = "none"
  /\ ln' = [ln EXCEPT ![o] = s] /\ lowner' = [lowner EXCEPT ![o] = b]
  /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked, lfires, tk>>

\* A write through a handle a script opened on routines.cron before an app rewrite renamed a new file
\* over it, made after the app read the old file back: it lands in the replaced file and is lost.
AppendToReplaced(o, b) ==
  /\ ln[o] = "none"
  /\ ln' = [ln EXCEPT ![o] = "lost"] /\ lowner' = [lowner EXCEPT ![o] = b]
  /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked, lfires, tk>>

\* A check's takeOnce of line o has read the file (through the handle it keeps).
TakeRead(b, o) ==
  /\ up /\ Idle /\ lowner[o] = b /\ ln[o] = "in"
  /\ tk' = [tk EXCEPT ![b] = o]
  /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked, ln, lowner, lfires>>

\* Any other app rewrite of routines.cron (create, add, pause, resume, cancel) has read it; its own change is
\* the atomic action of that name, this is only the window it leaves.
EditRead(b) ==
  /\ up /\ Idle
  /\ tk' = [tk EXCEPT ![b] = "edit"]
  /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked, ln, lowner, lfires>>

\* The new file is renamed over the old one, the old one is read again and what was written into it since
\* the first read is appended back: every line in the file stays (one-shot or legacy) but the taken one,
\* which is then dispatched. With "resurrect" the taken line is appended back too.
Rewrite(b) ==
  /\ tk[b] # "none"
  /\ LET o == tk[b]
     IN /\ ln' = [i \in Lines |-> IF i = o /\ OnceBug # "resurrect" THEN "run" ELSE ln[i]]
        /\ lfires' = [i \in Lines |-> IF i = o THEN Min(lfires[i] + 1, 2) ELSE lfires[i]]
  /\ tk' = [tk EXCEPT ![b] = "none"]
  /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked, lowner>>

\* A check takes line o and the app dies before dispatching it: the line is gone, never run (at most
\* once). With "dispatch-first" the order is reversed: dispatched, then the app dies before taking it out.
TakeThenCrash(b, o) ==
  /\ up /\ Idle /\ lowner[o] = b /\ ln[o] = "in" /\ up' = FALSE
  /\ IF OnceBug = "dispatch-first"
     THEN lfires' = [lfires EXCEPT ![o] = Min(@ + 1, 2)] /\ UNCHANGED ln
     ELSE ln' = [ln EXCEPT ![o] = "taken"] /\ UNCHANGED lfires
  /\ UNCHANGED <<now, st, kind, owner, at, since, last, req, fires, file, told, said, looked, lowner, tk>>

-----------------------------------------------------------------------------

Next ==
  \/ Tick \/ Crash \/ Boot
  \/ \E b \in Bots : Break(b) \/ Mend(b) \/ View(b) \/ Check(b)
  \/ \E j \in Jobs : ClaimThenCrash(j) \/ Pause(j) \/ Resume(j) \/ Cancel(j) \/ \E b \in Bots : AddLegacy(j, b)
  \/ \E j \in Jobs, r \in Requests, b \in Bots :
       \/ Create(j, r, "recurring", b, None)
       \/ \E a \in (now + 1)..MaxTime : Create(j, r, "once", b, a)
  \/ \E b \in Bots : EditRead(b) \/ Rewrite(b)
  \/ \E o \in Lines, b \in Bots : Append(o, b, "in") \/ Append(o, b, "paused") \/ AppendToReplaced(o, b)
       \/ TakeRead(b, o) \/ TakeThenCrash(b, o)

\* While the app runs, the clock keeps looking at every bot (it gets its turn between the app's other
\* rewrites of routines.cron, so strong fairness), and a rewrite the app started finishes.
Fairness == \A b \in Bots : SF_vars(Check(b)) /\ WF_vars(Rewrite(b))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* Safety

\* No (job, occurrence) is dispatched twice: not across a restart, not when catching up.
AtMostOncePerDue == \A p \in Jobs \X Time : fires[p] <= 1

\* A once job that ran is fired for good: never rearmed, never run again.
OnceFiresOnce == \A j \in Jobs : kind[j] = "once" /\ at[j] # None /\ fires[<<j, at[j]>>] > 0 => st[j] = "fired"

\* create with the same request id is idempotent: one schedule per request id in a bot's store.
OneSchedulePerRequest == \A i, k \in Jobs : i # k /\ Made(i) /\ Made(k) /\ Scheduled(i) /\ Scheduled(k) /\ owner[i] = owner[k] => req[i] # req[k]

\* A one-shot line is dispatched at most once, and only after it is out of the file.
OnceLineRunsOnce == \A o \in Lines : lfires[o] <= 1
RemovedBeforeRun == \A o \in Lines : lfires[o] > 0 => ln[o] = "run"
\* A line out of the file unrun was taken by a check that died (NoLineInFileIsLost).
RunMeansDispatched == \A o \in Lines : ln[o] = "run" => lfires[o] = 1

\* Once the clock has looked at a broken file, the chat says so.
BrokenIsTold == \A b \in Bots : looked[b] => said[b]

\* A paused, cancelled, claimed (delivery_uncertain) or fired job is never dispatched; nor is a
\* one-shot line that is paused or out of the file.
InactiveNeverFires ==
  [][/\ \A j \in Jobs : st[j] \in {"none", "paused", "cancelled", "claimed", "fired"} => \A t \in Time : fires'[<<j, t>>] = fires[<<j, t>>]
     /\ \A o \in Lines : ln[o] # "in" => lfires'[o] = lfires[o]]_vars

\* No line in routines.cron is lost: it leaves the file only taken by a check (run, or the app died before
\* dispatching it), however a script's append and an app rewrite interleave. A lost line never reached it.
NoLineInFileIsLost == [][\A o \in Lines : InFile(o) /\ ~InFile(o)' => ln'[o] \in {"run", "taken"}]_vars
LostOnlyToReplacedFile == [][\A o \in Lines : ln'[o] = "lost" /\ ln[o] # "lost" => ln[o] = "none"]_vars

\* A broken file's jobs are kept as they were: never changed, dispatched or read as empty.
BrokenKeepsJobs == [][\A j \in Jobs : Scheduled(j) /\ file[owner[j]] = "broken" => UNCHANGED <<st[j], since[j], last[j], req[j]>> /\ \A t \in Time : fires'[<<j, t>>] = fires[<<j, t>>]]_vars

\* Liveness: while the app runs, a due active job is dispatched or left delivery_uncertain, and a
\* broken file is told, unless it is mended first.
DueIsHandled == \A j \in Jobs : Due(j) ~> (~Due(j) \/ ~up)
\* A one-shot line in the file is taken (run, or lost to a crash or a rewrite) while the app runs.
OnceLineIsTaken == \A o \in Lines : ln[o] = "in" ~> (ln[o] # "in" \/ ~up)
BrokenIsToldEventually == \A b \in Bots : (up /\ file[b] = "broken") ~> (said[b] \/ ~up \/ file[b] = "ok")
=============================================================================
