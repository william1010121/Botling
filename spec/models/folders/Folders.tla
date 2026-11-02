------------------------------- MODULE Folders -------------------------------
(* Where a bot's session starts: the `sessions.folder` seam (desktop/src/core/plugins/session-folders.ts,   *)
(* core/plugins/index.ts sessionFolder / foldersChanged, server.ts worktree / sessionMoved, bot.ts          *)
(* restartFor / route / deliver). A built-in plugin (botling.git) decides a bot's folder (a worktree, or the *)
(* project folder P) and tells the core over the host's pipe: `set` when it changes, its whole picture       *)
(* (`sync`) when it loads. The core never asks the host when a turn starts: it answers from its cache, which *)
(* it writes to plugin-session-folders.json (the write may fail; the next change writes it again) and reads  *)
(* back when Botling starts. A plugin turned off, or failed (the third crash), decides nothing: its bots are *)
(* in P. Each time what the core answers changes, an awake bot is owed one restart before its next message  *)
(* (its process keeps the folder it started in); an asleep one starts in the new folder anyway.              *)
(* The protocol: a turn starts in the folder the core answers then; a folder whose plugin is off or failed  *)
(* is never used; a move costs at most one restart, and a restart is only for a move; the cache is only ever *)
(* what the plugin said; and once the plugin runs for good the cache becomes the plugin's truth.            *)
(* Bug = "nohold": your message goes to the old process while its own work (subagents) runs, as bot.ts did  *)
(* before this model: the restart is skipped and the turn starts in the old folder (TLC must find           *)
(* TurnStartsCurrent violated). Bug = "noinvalidate": the core keeps answering a failed plugin's folders     *)
(* (folderProviders without its enabled check; TLC must find TurnNotDisabled violated).                     *)
(* One bot: bots do not interact here (`sync` is the per-bot `replace`).                                    *)
EXTENDS Integers, Sequences

CONSTANTS Folders, P, None, MaxUses, MaxBoots, MaxEnables, Bug

Places == Folders \cup {P}
PStates == {"loading", "running", "crashed", "failed", "disabled"}
Msgs == {<<k, f>> : k \in {"set", "sync"}, f \in Places}

VARIABLES
  pstate,     \* the plugin as the core's registry and host have it
  crashes,    \* its crashes since it last failed (the registry's count; the third fails it)
  truth,      \* where the plugin says the bot works (its own state on disk)
  everSet,    \* every folder the plugin ever assigned (history, for the safety properties)
  uses,       \* how often the plugin changed its mind (bounded for TLC)
  chan,       \* plugin -> core lines on the host's pipe, in order
  cache,      \* the core's answer for the bot (SessionFolders in memory; P: nothing assigned)
  disk,       \* plugin-session-folders.json
  told,       \* what the bot's session was last told it has (Plugins.foldersTold)
  boots,      \* Botling restarts (bounded)
  enables,    \* the user turned the plugin on again (bounded)
  awake,      \* the bot's process runs
  headFolder, \* the folder its process started in (None while asleep)
  turn,       \* a turn is under way
  turnFolder, \* the folder of the turn under way (None: none)
  work,       \* its own work (subagents, background tasks) runs in its process
  pending,    \* a restart is owed before its next message (restartPending for a move)
  held,       \* your message waits for its own work before that restart (settingsHold)
  restarted   \* the last step restarted its process

vars == <<pstate, crashes, truth, everSet, uses, chan, cache, disk, told, boots, enables,
          awake, headFolder, turn, turnFolder, work, pending, held, restarted>>
plugin == <<pstate, crashes, truth, everSet, uses, enables>>
bot == <<awake, headFolder, turn, turnFolder, work, pending, held>>

\* What the core answers for the bot given its cache and the plugin's state (sessionFolder: folderProviders
\* are the plugins on and not failed). With Bug = "noinvalidate" a failed plugin still answers.
Res(c, ps) == IF ps # "disabled" /\ (ps # "failed" \/ Bug = "noinvalidate") THEN c ELSE P
Resolved == Res(cache, pstate)

TypeOK ==
  /\ pstate \in PStates /\ crashes \in 0..2 /\ truth \in Places /\ everSet \subseteq Places /\ uses \in 0..MaxUses
  /\ chan \in Seq(Msgs) /\ cache \in Places /\ disk \in Places /\ told \in Places
  /\ boots \in 0..MaxBoots /\ enables \in 0..MaxEnables
  /\ awake \in BOOLEAN /\ headFolder \in Places \cup {None} /\ turn \in BOOLEAN /\ turnFolder \in Places \cup {None}
  /\ work \in BOOLEAN /\ pending \in BOOLEAN /\ held \in BOOLEAN /\ restarted \in BOOLEAN

Init ==
  /\ pstate = "loading" /\ crashes = 0 /\ truth = P /\ everSet = {} /\ uses = 0
  /\ chan = <<>> /\ cache = P /\ disk = P /\ told = P /\ boots = 0 /\ enables = 0
  /\ awake = FALSE /\ headFolder = None /\ turn = FALSE /\ turnFolder = None
  /\ work = FALSE /\ pending = FALSE /\ held = FALSE /\ restarted = FALSE

\* foldersChanged -> sessionMoved -> restartBeforeNextMessage: when what the core answers (r) is not what the
\* session was told, it is told, and an awake bot owes a restart (asleep: nothing; the next wake has it).
Tell(r) == IF r # told THEN told' = r /\ pending' = awake ELSE UNCHANGED <<told, pending>>

-----------------------------------------------------------------------------
\* The plugin (in the host).

\* It changes its mind (a worktree made, used, discarded; its setting turned off) and pushes `set`.
Use(f) ==
  /\ pstate = "running" /\ f # truth /\ uses < MaxUses
  /\ truth' = f /\ everSet' = everSet \cup {f} /\ uses' = uses + 1
  /\ chan' = Append(chan, <<"set", f>>)
  /\ UNCHANGED <<pstate, crashes, enables, cache, disk, told, boots>> /\ UNCHANGED bot /\ restarted' = FALSE

\* It loads (activate) and pushes its whole picture.
Load ==
  /\ pstate = "loading"
  /\ pstate' = "running" /\ chan' = Append(chan, <<"sync", truth>>)
  /\ UNCHANGED <<crashes, truth, everSet, uses, enables, cache, disk, told, boots>> /\ UNCHANGED bot /\ restarted' = FALSE

\* Its host dies with it (or it throws): the lines the host had written still arrive, the rest are lost.
\* The third time it is failed (recordHostFailure -> markFailed -> sync -> foldersChanged).
Crash ==
  /\ pstate \in {"loading", "running"}
  /\ pstate' = IF crashes + 1 >= 3 THEN "failed" ELSE "crashed"
  /\ crashes' = IF crashes + 1 >= 3 THEN 0 ELSE crashes + 1
  /\ \E k \in 0..Len(chan) : chan' = SubSeq(chan, 1, k)
  /\ Tell(Res(cache, pstate'))
  /\ UNCHANGED <<truth, everSet, uses, enables, cache, disk, boots>>
  /\ UNCHANGED <<awake, headFolder, turn, turnFolder, work, held>> /\ restarted' = FALSE

\* The host client starts the host again; the plugin loads again.
HostRestart ==
  /\ pstate = "crashed" /\ pstate' = "loading"
  /\ UNCHANGED <<crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>> /\ UNCHANGED bot /\ restarted' = FALSE

\* The user turns it off (Settings -> Plugins), or on again (which also clears a failure).
Disable ==
  /\ pstate # "disabled" /\ pstate' = "disabled"
  /\ Tell(Res(cache, pstate'))
  /\ UNCHANGED <<crashes, truth, everSet, uses, enables, chan, cache, disk, boots>>
  /\ UNCHANGED <<awake, headFolder, turn, turnFolder, work, held>> /\ restarted' = FALSE

Enable ==
  /\ pstate \in {"disabled", "failed"} /\ enables < MaxEnables
  /\ pstate' = "loading" /\ enables' = enables + 1
  /\ crashes' = IF pstate = "failed" THEN 0 ELSE crashes
  /\ Tell(Res(cache, pstate'))
  /\ UNCHANGED <<truth, everSet, uses, chan, cache, disk, boots>>
  /\ UNCHANGED <<awake, headFolder, turn, turnFolder, work, held>> /\ restarted' = FALSE

-----------------------------------------------------------------------------
\* The core.

\* The core takes the pipe's next line (with dup, it takes it and the same line comes again). A line from a
\* plugin not running (off or failed: Plugins.asked) is refused. A change is kept in memory and written to
\* disk (the write may fail: the file keeps what it had); the session is told.
CoreRecv(dup) ==
  /\ chan # <<>>
  /\ LET m == Head(chan)
         c == IF pstate \in {"disabled", "failed"} THEN cache ELSE m[2]
     IN /\ cache' = c
        /\ IF c = cache THEN UNCHANGED disk ELSE disk' \in {c, disk}
        /\ Tell(Res(c, pstate))
  /\ chan' = IF dup THEN chan ELSE Tail(chan)
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, boots>>
  /\ UNCHANGED <<awake, headFolder, turn, turnFolder, work, held>> /\ restarted' = FALSE

\* Botling starts again: the core reads its cache from disk and tells the session what it has then (Plugins'
\* constructor); every process, turn and line on the pipe is gone. Off and failed stay so (plugins.json);
\* the crash count does not survive. The plugin's own state does.
AppRestart ==
  /\ boots < MaxBoots /\ boots' = boots + 1
  /\ pstate' = IF pstate \in {"disabled", "failed"} THEN pstate ELSE "loading"
  /\ crashes' = 0 /\ chan' = <<>> /\ cache' = disk /\ told' = Res(disk, pstate')
  /\ awake' = FALSE /\ headFolder' = None /\ turn' = FALSE /\ turnFolder' = None
  /\ work' = FALSE /\ pending' = FALSE /\ held' = FALSE /\ restarted' = FALSE
  /\ UNCHANGED <<truth, everSet, uses, enables, disk>>

-----------------------------------------------------------------------------
\* The bot.

\* A turn begins (deliver): asleep, it wakes where the core answers now (ensureHead); awake and owed a restart
\* with no own work running, its process starts again there first; otherwise it stays where it is.
Begin ==
  /\ turn' = TRUE /\ held' = FALSE
  /\ IF ~awake
     THEN awake' = TRUE /\ headFolder' = Resolved /\ turnFolder' = Resolved /\ pending' = FALSE /\ restarted' = FALSE
     ELSE IF pending /\ ~work
     THEN headFolder' = Resolved /\ turnFolder' = Resolved /\ pending' = FALSE /\ restarted' = TRUE /\ UNCHANGED awake
     ELSE turnFolder' = headFolder /\ restarted' = FALSE /\ UNCHANGED <<awake, headFolder, pending>>
  /\ UNCHANGED work

\* Your message, when no turn is under way and none waits (route). Owed a restart while its own work runs,
\* it waits for that work (holdForSettings, now also for a folder); with Bug = "nohold" it goes at once.
Msg ==
  /\ ~turn /\ ~held
  /\ IF awake /\ pending /\ work /\ Bug # "nohold"
     THEN held' = TRUE /\ restarted' = FALSE /\ UNCHANGED <<awake, headFolder, turn, turnFolder, work, pending>>
     ELSE Begin
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>>

\* The held message goes once that work is done (releaseSettingsHold).
Release ==
  /\ held /\ ~work
  /\ Begin
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>>

EndTurn ==
  /\ turn /\ turn' = FALSE /\ turnFolder' = None
  /\ UNCHANGED <<awake, headFolder, work, pending, held>> /\ restarted' = FALSE
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>>

\* Its turn starts subagents (or background tasks) that outlive it; they end.
StartWork ==
  /\ turn /\ ~work /\ work' = TRUE
  /\ UNCHANGED <<awake, headFolder, turn, turnFolder, pending, held>> /\ restarted' = FALSE
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>>

EndWork ==
  /\ work /\ work' = FALSE
  /\ UNCHANGED <<awake, headFolder, turn, turnFolder, pending, held>> /\ restarted' = FALSE
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>>

\* Idle, it falls asleep: its process ends (a restart owed is not needed any more).
Sleep ==
  /\ awake /\ ~turn /\ ~work /\ ~held
  /\ awake' = FALSE /\ headFolder' = None /\ pending' = FALSE
  /\ UNCHANGED <<turn, turnFolder, work, held>> /\ restarted' = FALSE
  /\ UNCHANGED <<pstate, crashes, truth, everSet, uses, enables, chan, cache, disk, told, boots>>

-----------------------------------------------------------------------------

Next ==
  \/ \E f \in Places : Use(f)
  \/ Load \/ Crash \/ HostRestart \/ Disable \/ Enable
  \/ \E dup \in BOOLEAN : CoreRecv(dup)
  \/ AppRestart
  \/ Msg \/ Release \/ EndTurn \/ StartWork \/ EndWork \/ Sleep

\* The pipe delivers, the host comes back and the plugin loads, own work ends and a held message then goes.
\* Nobody has to write, crash, turn anything off or on, or restart Botling.
Fairness ==
  /\ WF_vars(CoreRecv(FALSE)) /\ WF_vars(Load) /\ WF_vars(HostRestart)
  /\ WF_vars(EndWork) /\ WF_vars(Release)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* Safety.

\* The cache and the file only ever hold what the plugin said (or nothing): the file never makes a bot
\* start in a folder the plugin did not set.
CacheFromPlugin == cache \in everSet \cup {P}
DiskFromPlugin == disk \in everSet \cup {P}

\* The session was told what the core answers, always (no change goes untold).
ToldIsAnswer == told = Resolved

\* A restart is owed only by an awake bot; a message waits only for that restart and its own work.
PendingOnlyAwake == pending => awake
HeldOnlyForRestart == held => (awake /\ pending /\ ~turn)
AsleepIsQuiet == ~awake => (headFolder = None /\ ~turn /\ ~work /\ ~pending /\ ~held)

\* A restart happens only right before a turn begins.
RestartBeforeTurn == restarted => turn

\* A turn starts in the folder the core answers then: never a stale one once it knows a newer one.
TurnStartsCurrent == [][(~turn /\ turn') => turnFolder' = Res(cache', pstate')]_vars

\* A turn never starts in a folder whose plugin is off or failed.
TurnNotDisabled == [][(~turn /\ turn' /\ turnFolder' # P) => pstate' \notin {"disabled", "failed"}]_vars

\* ... nor in one the plugin never assigned.
TurnFromPlugin == [][(~turn /\ turn') => turnFolder' \in everSet \cup {P}]_vars

\* No restart loop: a restart pays what a move owed (and pays it off); a restart is owed only by a move.
RestartOnlyOwed == [][restarted' => (pending /\ ~pending')]_vars
OwedOnlyOnMove == [][(~pending /\ pending') => told' # told]_vars

-----------------------------------------------------------------------------
\* Liveness.

\* Once the plugin runs for good, the core ends up answering what the plugin holds.
Converges == <>[](pstate = "running") => <>[](cache = truth)

\* A message waiting for its own work is sent.
HeldGoes == held ~> ~held
=============================================================================
