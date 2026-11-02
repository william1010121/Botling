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
EXTENDS Integers, FiniteSets

CONSTANTS Jobs, Bots, Requests, MaxTime, Cron, Bug  \* Cron: the minutes a recurring/legacy job runs at

None == -1
Time == 0..MaxTime
States == {"none", "pending", "paused", "claimed", "fired", "cancelled"}
Kinds == {"once", "recurring", "legacy"}

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
  looked              \* the clock has looked at this bot's file while broken since it last saw it ok

vars == <<now, up, st, kind, owner, at, since, last, req, fires, file, told, said, looked>>

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

TypeOK ==
  /\ now \in Time /\ up \in BOOLEAN
  /\ st \in [Jobs -> States] /\ kind \in [Jobs -> Kinds \cup {"none"}] /\ owner \in [Jobs -> Bots \cup {"none"}]
  /\ at \in [Jobs -> Time \cup {None}] /\ since \in [Jobs -> Time \cup {None}] /\ last \in [Jobs -> Time \cup {None}]
  /\ req \in [Jobs -> Requests \cup {"none"}] /\ fires \in [Jobs \X Time -> 0..2]
  /\ file \in [Bots -> {"ok", "broken"}] /\ told \in [Bots -> BOOLEAN] /\ said \in [Bots -> BOOLEAN] /\ looked \in [Bots -> BOOLEAN]

Init ==
  /\ now = 0 /\ up = FALSE
  /\ st = [j \in Jobs |-> "none"] /\ kind = [j \in Jobs |-> "none"] /\ owner = [j \in Jobs |-> "none"]
  /\ at = [j \in Jobs |-> None] /\ since = [j \in Jobs |-> None] /\ last = [j \in Jobs |-> None]
  /\ req = [j \in Jobs |-> "none"] /\ fires = [p \in Jobs \X Time |-> 0]
  /\ file = [b \in Bots |-> "ok"] /\ told = [b \in Bots |-> FALSE] /\ said = [b \in Bots |-> FALSE] /\ looked = [b \in Bots |-> FALSE]

-----------------------------------------------------------------------------
\* The environment: time passes, the app stops and starts, a file breaks or is mended.

Tick == now < MaxTime /\ now' = now + 1 /\ UNCHANGED <<up, st, kind, owner, at, since, last, req, fires, file, told, said, looked>>

Crash == up /\ up' = FALSE /\ UNCHANGED <<now, st, kind, owner, at, since, last, req, fires, file, told, said, looked>>

\* Startup reads each bot's routines; that read is not a notice (c0154c79: with Bug it counted as one).
Boot ==
  /\ ~up /\ up' = TRUE
  /\ told' = [b \in Bots |-> Bug /\ file[b] = "broken"]
  /\ UNCHANGED <<now, st, kind, owner, at, since, last, req, fires, file, said, looked>>

Break(b) == file[b] = "ok" /\ file' = [file EXCEPT ![b] = "broken"] /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, told, said, looked>>
Mend(b) == file[b] = "broken" /\ file' = [file EXCEPT ![b] = "ok"] /\ UNCHANGED <<now, up, st, kind, owner, at, since, last, req, fires, told, said, looked>>

\* A look at a bot's routines (the chat snapshot, routines.list) changes nothing.
View(b) == up /\ UNCHANGED vars

-----------------------------------------------------------------------------
\* The clock's look at one bot: a broken file is told once, a new legacy job starts from now, and
\* every due job is claimed and dispatched in its own bot's chat.

Check(b) ==
  /\ up
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
  /\ UNCHANGED <<now, up, kind, owner, at, req, file>>

\* The claim is written, then the app dies before dispatching: the job stays claimed.
ClaimThenCrash(j) ==
  /\ up /\ Scheduled(j) /\ Due(j)
  /\ st' = [st EXCEPT ![j] = "claimed"] /\ last' = [last EXCEPT ![j] = Occ(j)] /\ up' = FALSE
  /\ UNCHANGED <<now, kind, owner, at, since, req, fires, file, told, said, looked>>

-----------------------------------------------------------------------------
\* Changes (app_routines and the app's UI). Each is a transaction on scheduled-routines.json, so
\* nothing changes while it is broken; a refused change changes nothing.

\* create: a request id this bot already has returns that schedule (or is refused); a once job is in the future.
Create(j, r, k, b, a) ==
  /\ up /\ file[b] = "ok"
  /\ IF \E i \in Jobs : Made(i) /\ owner[i] = b /\ req[i] = r
     THEN UNCHANGED vars
     ELSE /\ st[j] = "none"
          /\ st' = [st EXCEPT ![j] = "pending"] /\ kind' = [kind EXCEPT ![j] = k] /\ owner' = [owner EXCEPT ![j] = b]
          /\ at' = [at EXCEPT ![j] = a] /\ since' = [since EXCEPT ![j] = now] /\ req' = [req EXCEPT ![j] = r]
          /\ UNCHANGED <<now, up, last, fires, file, told, said, looked>>

\* The bot (or a plugin) writes a new line into its routines.cron.
AddLegacy(j, b) ==
  /\ up /\ st[j] = "none"
  /\ st' = [st EXCEPT ![j] = "pending"] /\ kind' = [kind EXCEPT ![j] = "legacy"] /\ owner' = [owner EXCEPT ![j] = b]
  /\ UNCHANGED <<now, up, at, since, last, req, fires, file, told, said, looked>>

Change(j) == up /\ Made(j) /\ file[owner[j]] = "ok"

Pause(j) ==
  /\ Change(j)
  /\ st' = [st EXCEPT ![j] = IF @ \in {"pending", "paused"} THEN "paused" ELSE @]
  /\ UNCHANGED <<now, up, kind, owner, at, since, last, req, fires, file, told, said, looked>>

\* Resuming starts a scheduled job from now; routines.cron keeps no such baseline, only when it last ran.
Resume(j) ==
  /\ Change(j)
  /\ st' = [st EXCEPT ![j] = IF @ = "paused" THEN "pending" ELSE @]
  /\ since' = [since EXCEPT ![j] = IF st[j] = "paused" /\ Scheduled(j) THEN now ELSE @]
  /\ UNCHANGED <<now, up, kind, owner, at, last, req, fires, file, told, said, looked>>

\* Cancelling stops future runs only: a claimed job is refused, a fired one stays fired.
Cancel(j) ==
  /\ Change(j)
  /\ st' = [st EXCEPT ![j] = IF @ \in {"pending", "paused"} THEN "cancelled" ELSE @]
  /\ UNCHANGED <<now, up, kind, owner, at, since, last, req, fires, file, told, said, looked>>

-----------------------------------------------------------------------------

Next ==
  \/ Tick \/ Crash \/ Boot
  \/ \E b \in Bots : Break(b) \/ Mend(b) \/ View(b) \/ Check(b)
  \/ \E j \in Jobs : ClaimThenCrash(j) \/ Pause(j) \/ Resume(j) \/ Cancel(j) \/ \E b \in Bots : AddLegacy(j, b)
  \/ \E j \in Jobs, r \in Requests, b \in Bots :
       \/ Create(j, r, "recurring", b, None)
       \/ \E a \in (now + 1)..MaxTime : Create(j, r, "once", b, a)

\* While the app runs, the clock keeps looking at every bot.
Fairness == \A b \in Bots : WF_vars(Check(b))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* Safety

\* No (job, occurrence) is dispatched twice: not across a restart, not when catching up.
AtMostOncePerDue == \A p \in Jobs \X Time : fires[p] <= 1

\* A once job that ran is fired for good: never rearmed, never run again.
OnceFiresOnce == \A j \in Jobs : kind[j] = "once" /\ at[j] # None /\ fires[<<j, at[j]>>] > 0 => st[j] = "fired"

\* create with the same request id is idempotent: one schedule per request id in a bot's store.
OneSchedulePerRequest == \A i, k \in Jobs : i # k /\ Made(i) /\ Made(k) /\ Scheduled(i) /\ Scheduled(k) /\ owner[i] = owner[k] => req[i] # req[k]

\* Once the clock has looked at a broken file, the chat says so.
BrokenIsTold == \A b \in Bots : looked[b] => said[b]

\* A paused, cancelled, claimed (delivery_uncertain) or fired job is never dispatched.
InactiveNeverFires == [][\A j \in Jobs : st[j] \in {"none", "paused", "cancelled", "claimed", "fired"} => \A t \in Time : fires'[<<j, t>>] = fires[<<j, t>>]]_vars

\* A broken file's jobs are kept as they were: never changed, dispatched or read as empty.
BrokenKeepsJobs == [][\A j \in Jobs : Scheduled(j) /\ file[owner[j]] = "broken" => UNCHANGED <<st[j], since[j], last[j], req[j]>> /\ \A t \in Time : fires'[<<j, t>>] = fires[<<j, t>>]]_vars

\* Liveness: while the app runs, a due active job is dispatched or left delivery_uncertain, and a
\* broken file is told, unless it is mended first.
DueIsHandled == \A j \in Jobs : Due(j) ~> (~Due(j) \/ ~up)
BrokenIsToldEventually == \A b \in Bots : (up /\ file[b] = "broken") ~> (said[b] \/ ~up \/ file[b] = "ok")
=============================================================================
