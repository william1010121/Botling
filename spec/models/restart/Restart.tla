------------------------------- MODULE Restart -------------------------------
(* Restart continuation (desktop/src/core/restart-continuation.ts, Core.prepareRestart/shutdown and its
   recovery at activate). The old app writes a journal (preparing, then ready once every participant's
   shutdown has settled); the new app reads it and, bot by bot, continues the interrupted work at most once
   or holds it back and tells the bot why. Deliveries are at most once (claimed before they are sent);
   notices at least once (sent before the entry is marked blocked). Any process may crash between steps. *)
EXTENDS Naturals

CONSTANTS Bots,        \* bot ids
          Plugins,     \* the plugin host: a shutdown participant that has no work of its own
          MaxCrashes,  \* crashes are finite (otherwise nothing is ever guaranteed)
          BUG          \* TRUE: the design before d678d161 (one failed shutdown leaves the journal preparing)

Parts == Bots \cup {Plugins}
Reasons == {"own", "shutdown", "deliver", "stale", "unconfirmed", "uncertain"}

VARIABLES
  mode,         \* "running" | "prepared" | "stopping" (old app), "down", "recovering" (new app)
  busy, own,    \* old app: the bot has work in flight; that work has its own blocker (a pending permission ...)
  stop,         \* each participant's shutdown: "idle" | "running" | "ok" | "failed"
  phase,        \* journal: "none" | "preparing" | "ready"
  entry,        \* journal, per bot: "absent" | "pending" | "claimed" | "dispatched" | "blocked"
  blk,          \* journal, per bot: entry.blocked as "none" | "own" | "shutdown" | "deliver"
  stale,        \* journal: older than RESTART_MAX_AGE_MS
  mine, try, noted, \* new process memory (lost on a crash): claimed here; delivery "none"|"sent"|"failed"; told here
  sent, told,   \* effects: continuations delivered to the bot; the last reason the bot was told
  crashes, oldCrashed \* crashes so far; the old app crashed after preparing (ghost)

vars == <<mode, busy, own, stop, phase, entry, blk, stale, mine, try, noted, sent, told, crashes, oldCrashed>>
volatile == <<mine, try, noted>>
effects == <<sent, told>>

TypeOK ==
  /\ mode \in {"running", "prepared", "stopping", "down", "recovering"}
  /\ busy \in [Bots -> BOOLEAN] /\ own \in [Bots -> BOOLEAN]
  /\ stop \in [Parts -> {"idle", "running", "ok", "failed"}]
  /\ phase \in {"none", "preparing", "ready"}
  /\ entry \in [Bots -> {"absent", "pending", "claimed", "dispatched", "blocked"}]
  /\ blk \in [Bots -> {"none", "own", "shutdown", "deliver"}]
  /\ stale \in BOOLEAN
  /\ mine \in [Bots -> BOOLEAN] /\ try \in [Bots -> {"none", "sent", "failed"}] /\ noted \in [Bots -> BOOLEAN]
  /\ sent \in [Bots -> Nat] /\ told \in [Bots -> Reasons \cup {"none"}]
  /\ crashes \in 0..MaxCrashes /\ oldCrashed \in BOOLEAN

Init ==
  /\ mode = "running" /\ busy = [b \in Bots |-> FALSE] /\ own = [b \in Bots |-> FALSE]
  /\ stop = [p \in Parts |-> "idle"]
  /\ phase = "none" /\ entry = [b \in Bots |-> "absent"] /\ blk = [b \in Bots |-> "none"] /\ stale = FALSE
  /\ mine = [b \in Bots |-> FALSE] /\ try = [b \in Bots |-> "none"] /\ noted = [b \in Bots |-> FALSE]
  /\ sent = [b \in Bots |-> 0] /\ told = [b \in Bots |-> "none"]
  /\ crashes = 0 /\ oldCrashed = FALSE

\* The journal's entries are the bots with work in flight now (restartEntries), each with its own blocker if any.
Snapshot ==
  /\ entry' = [b \in Bots |-> IF busy[b] THEN "pending" ELSE "absent"]
  /\ blk' = [b \in Bots |-> IF busy[b] /\ own[b] THEN "own" ELSE "none"]

-----------------------------------------------------------------------------
(* The old app. *)

Start(b) ==
  /\ mode = "running" /\ ~busy[b]
  /\ busy' = [busy EXCEPT ![b] = TRUE] /\ own' \in {[own EXCEPT ![b] = o] : o \in BOOLEAN}
  /\ UNCHANGED <<mode, stop, phase, entry, blk, stale, volatile, effects, crashes, oldCrashed>>

\* Work may still end (complete or be cancelled) after the restart was confirmed, until shutdown re-snapshots.
Finish(b) ==
  /\ mode \in {"running", "prepared"} /\ busy[b]
  /\ busy' = [busy EXCEPT ![b] = FALSE] /\ own' = [own EXCEPT ![b] = FALSE]
  /\ UNCHANGED <<mode, stop, phase, entry, blk, stale, volatile, effects, crashes, oldCrashed>>

Prepare ==
  /\ mode = "running" /\ mode' = "prepared" /\ phase' = "preparing" /\ Snapshot
  /\ UNCHANGED <<busy, own, stop, stale, volatile, effects, crashes, oldCrashed>>

Cancel ==
  /\ mode = "prepared" /\ mode' = "running" /\ phase' = "none"
  /\ entry' = [b \in Bots |-> "absent"] /\ blk' = [b \in Bots |-> "none"]
  /\ UNCHANGED <<busy, own, stop, stale, volatile, effects, crashes, oldCrashed>>

BeginShutdown ==
  /\ mode = "prepared" /\ mode' = "stopping" /\ Snapshot /\ stop' = [p \in Parts |-> "running"]
  /\ UNCHANGED <<busy, own, phase, stale, volatile, effects, crashes, oldCrashed>>

Settle(p) ==
  /\ mode = "stopping" /\ stop[p] = "running" /\ stop' \in {[stop EXCEPT ![p] = r] : r \in {"ok", "failed"}}
  /\ UNCHANGED <<mode, busy, own, phase, entry, blk, stale, volatile, effects, crashes, oldCrashed>>

\* Every participant has settled: the journal is confirmed; a bot whose own shutdown failed is held back.
Ready ==
  /\ mode = "stopping" /\ \A p \in Parts : stop[p] \in {"ok", "failed"}
  /\ mode' = "down"
  /\ IF BUG
       THEN /\ phase' = IF \A p \in Parts : stop[p] = "ok" THEN "ready" ELSE "preparing"
            /\ UNCHANGED blk
       ELSE /\ phase' = "ready"
            /\ blk' = [b \in Bots |-> IF entry[b] # "absent" /\ stop[b] = "failed" /\ blk[b] = "none"
                                       THEN "shutdown" ELSE blk[b]]
  /\ UNCHANGED <<busy, own, stop, entry, stale, volatile, effects, crashes, oldCrashed>>

-----------------------------------------------------------------------------
(* Between the two processes, and the new one. *)

Crash ==
  /\ mode # "down" /\ crashes < MaxCrashes
  /\ mode' = "down" /\ crashes' = crashes + 1
  /\ oldCrashed' = (oldCrashed \/ mode \in {"prepared", "stopping"})
  /\ mine' = [b \in Bots |-> FALSE] /\ try' = [b \in Bots |-> "none"] /\ noted' = [b \in Bots |-> FALSE]
  /\ UNCHANGED <<busy, own, stop, phase, entry, blk, stale, effects>>

Expire ==
  /\ mode = "down" /\ phase # "none" /\ ~stale /\ stale' = TRUE
  /\ UNCHANGED <<mode, busy, own, stop, phase, entry, blk, volatile, effects, crashes, oldCrashed>>

Boot ==
  /\ mode = "down" /\ mode' = "recovering"
  /\ UNCHANGED <<busy, own, stop, phase, entry, blk, stale, volatile, effects, crashes, oldCrashed>>

Open(b) == entry[b] \in {"pending", "claimed"}

\* Why this entry must not be continued ("none": it may).
Reason(b) ==
  IF try[b] = "failed" THEN "deliver"
  ELSE IF blk[b] # "none" THEN blk[b]
  ELSE IF stale THEN "stale"
  ELSE IF phase # "ready" THEN "unconfirmed"
  ELSE IF entry[b] = "claimed" /\ ~mine[b] THEN "uncertain"
  ELSE "none"

Notice(b) ==
  /\ mode = "recovering" /\ Open(b) /\ ~noted[b] /\ Reason(b) # "none"
  /\ told' = [told EXCEPT ![b] = Reason(b)] /\ noted' = [noted EXCEPT ![b] = TRUE]
  /\ UNCHANGED <<mode, busy, own, stop, phase, entry, blk, stale, mine, try, sent, crashes, oldCrashed>>

Block(b) ==
  /\ mode = "recovering" /\ Open(b) /\ noted[b]
  /\ entry' = [entry EXCEPT ![b] = "blocked"]
  /\ blk' = [blk EXCEPT ![b] = IF try[b] = "failed" THEN "deliver" ELSE @]
  /\ UNCHANGED <<mode, busy, own, stop, phase, stale, volatile, effects, crashes, oldCrashed>>

Claim(b) ==
  /\ mode = "recovering" /\ entry[b] = "pending" /\ Reason(b) = "none"
  /\ entry' = [entry EXCEPT ![b] = "claimed"] /\ mine' = [mine EXCEPT ![b] = TRUE]
  /\ UNCHANGED <<mode, busy, own, stop, phase, blk, stale, try, noted, effects, crashes, oldCrashed>>

Deliver(b) ==
  /\ mode = "recovering" /\ entry[b] = "claimed" /\ mine[b] /\ try[b] = "none"
  /\ \E ok \in BOOLEAN :
       /\ try' = [try EXCEPT ![b] = IF ok THEN "sent" ELSE "failed"]
       /\ sent' = [sent EXCEPT ![b] = @ + (IF ok THEN 1 ELSE 0)]
  /\ UNCHANGED <<mode, busy, own, stop, phase, entry, blk, stale, mine, noted, told, crashes, oldCrashed>>

Dispatch(b) ==
  /\ mode = "recovering" /\ entry[b] = "claimed" /\ try[b] = "sent"
  /\ entry' = [entry EXCEPT ![b] = "dispatched"]
  /\ UNCHANGED <<mode, busy, own, stop, phase, blk, stale, volatile, effects, crashes, oldCrashed>>

Recover(b) == Notice(b) \/ Block(b) \/ Claim(b) \/ Deliver(b) \/ Dispatch(b)

Next ==
  \/ \E b \in Bots : Start(b) \/ Finish(b) \/ Recover(b)
  \/ Prepare \/ Cancel \/ BeginShutdown \/ (\E p \in Parts : Settle(p)) \/ Ready
  \/ Crash \/ Expire \/ Boot

\* Crashes, expiry and the old app's own choices are never forced; shutdown and recovery always go on.
Fairness ==
  /\ \A p \in Parts : WF_vars(Settle(p))
  /\ WF_vars(Ready) /\ WF_vars(Boot)
  /\ \A b \in Bots : WF_vars(Recover(b))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety. *)

\* Nothing is continued twice.
AtMostOnce == \A b \in Bots : sent[b] <= 1

\* A bot continues only work it really had in flight at shutdown, free of its own blocker, after its own clean shutdown.
OnlyRealWork == \A b \in Bots : sent[b] > 0 => busy[b] /\ ~own[b] /\ stop[b] = "ok"

\* Nothing is continued from an unconfirmed journal.
ConfirmedOnly == \A b \in Bots : entry[b] \in {"claimed", "dispatched"} => phase = "ready"

\* A bot is held back only for a cause of its own (or a crash, or age): never for another participant's failure.
Cause(b, r) ==
  CASE r = "own" -> blk[b] = "own"
    [] r = "shutdown" -> stop[b] = "failed"
    [] r = "unconfirmed" -> oldCrashed
    [] r = "stale" -> stale
    [] r = "uncertain" -> crashes > 0
    [] r = "deliver" -> TRUE
OthersNeverBlock == \A b \in Bots : told[b] # "none" => Cause(b, told[b])

\* A bot held back has been told why.
BlockedIsTold == \A b \in Bots : entry[b] = "blocked" => told[b] # "none"

(* Liveness. *)

\* Every journal entry is eventually continued or held back (and told, by BlockedIsTold).
Settles == \A b \in Bots : (mode \in {"down", "recovering"} /\ Open(b)) ~> entry[b] \in {"dispatched", "blocked"}

\* A bot that shut down cleanly with work in flight is continued, unless the cause is its own, a crash or age.
Excused(b) == told[b] \in {"own", "deliver", "uncertain", "stale"} \/ (told[b] = "unconfirmed" /\ oldCrashed)
Continues == \A b \in Bots :
  (stop[b] = "ok" /\ entry[b] = "pending") ~> (entry[b] = "dispatched" \/ (entry[b] = "blocked" /\ Excused(b)))
=============================================================================
