------------------------------ MODULE Workspace ------------------------------
(* Plugins' workspace change watch (`api.workspace.onChange`; desktop/src/core/workspace.ts,         *)
(* core/plugins/index.ts, Web/host/src/api.ts). The core keeps a digest of the workspace only while   *)
(* some plugin listens, and tells the host each time it differs from the last digest told. The host   *)
(* and the core talk over two ordered pipes. A plugin listens, then reads what is there (its first    *)
(* read); each change it is told makes it read again. The host says who listens in a "registered"    *)
(* line: the core starts watching (its first digest: what is there when that line arrives) or stops.  *)
(* The protocol: a listener's last read is eventually what is there, so no change goes untold. It     *)
(* holds because the host says someone listens before the listener's first read is sent: that read  *)
(* is answered after the watch began, so anything later differs from the watch's digest. With Bug    *)
(* the host says it a moment later (queueMicrotask, as before plan W1 shipped): the first read can    *)
(* overtake it and a change in between is lost (TLC must find Converges violated).                    *)
(* The world is abstracted to a version that only grows; a read answers it.                          *)
EXTENDS Integers, Sequences

CONSTANTS Plugins, MaxVer, MaxListens, Bug

None == -1
Vers == 0..MaxVer
ToCore == {<<"reg", b>> : b \in BOOLEAN} \cup {<<"read", p>> : p \in Plugins}
ToHost == {<<"change">>} \cup {<<"answer", p, v>> : p \in Plugins, v \in Vers}

VARIABLES
  ver,        \* the workspace (what every method would answer), as a version
  sub,        \* each plugin has an onChange listener
  listens,    \* how often each plugin began listening (bounded for TLC)
  known,      \* what each plugin's last answered read gave (None: nothing yet)
  reading,    \* each plugin has a read on its way
  dirty,      \* each plugin was told of a change and has not read since
  toCore,     \* host -> core lines, in order
  toHost,     \* core -> host lines, in order
  watching,   \* the core keeps a digest (it heard someone listens)
  seen,       \* the digest last told, or taken when the watch began (None while not watching)
  told        \* how many changes the core told (its stamp)

vars == <<ver, sub, listens, known, reading, dirty, toCore, toHost, watching, seen, told>>

AnySub(s) == \E p \in Plugins : s[p]

TypeOK ==
  /\ ver \in Vers
  /\ sub \in [Plugins -> BOOLEAN] /\ listens \in [Plugins -> 0..MaxListens]
  /\ known \in [Plugins -> Vers \cup {None}] /\ reading \in [Plugins -> BOOLEAN] /\ dirty \in [Plugins -> BOOLEAN]
  /\ toCore \in Seq(ToCore) /\ toHost \in Seq(ToHost)
  /\ watching \in BOOLEAN /\ seen \in Vers \cup {None} /\ told \in Nat

Init ==
  /\ ver = 0
  /\ sub = [p \in Plugins |-> FALSE] /\ listens = [p \in Plugins |-> 0]
  /\ known = [p \in Plugins |-> None] /\ reading = [p \in Plugins |-> FALSE] /\ dirty = [p \in Plugins |-> FALSE]
  /\ toCore = <<>> /\ toHost = <<>>
  /\ watching = FALSE /\ seen = None /\ told = 0

-----------------------------------------------------------------------------
\* The world.

Change == ver < MaxVer /\ ver' = ver + 1 /\ UNCHANGED <<sub, listens, known, reading, dirty, toCore, toHost, watching, seen, told>>

-----------------------------------------------------------------------------
\* A plugin (in the host).

\* onChange, then its first read in the same breath. The host says someone listens at once (announceNow),
\* before the read; with Bug, after it.
Listen(p) ==
  /\ ~sub[p] /\ ~reading[p] /\ listens[p] < MaxListens
  /\ sub' = [sub EXCEPT ![p] = TRUE] /\ listens' = [listens EXCEPT ![p] = @ + 1]
  /\ reading' = [reading EXCEPT ![p] = TRUE] /\ dirty' = [dirty EXCEPT ![p] = FALSE]
  /\ toCore' = toCore \o (IF Bug THEN <<<<"read", p>>, <<"reg", TRUE>>>> ELSE <<<<"reg", TRUE>>, <<"read", p>>>>)
  /\ UNCHANGED <<ver, known, toHost, watching, seen, told>>

\* The listener disposed; the host says who listens still (queueMicrotask: before anything else happens).
Unlisten(p) ==
  /\ sub[p]
  /\ sub' = [sub EXCEPT ![p] = FALSE] /\ dirty' = [dirty EXCEPT ![p] = FALSE]
  /\ toCore' = Append(toCore, <<"reg", AnySub(sub')>>)
  /\ UNCHANGED <<ver, listens, known, reading, toHost, watching, seen, told>>

\* Told of a change, it reads again (one read at a time).
Read(p) ==
  /\ sub[p] /\ dirty[p] /\ ~reading[p]
  /\ reading' = [reading EXCEPT ![p] = TRUE] /\ dirty' = [dirty EXCEPT ![p] = FALSE]
  /\ toCore' = Append(toCore, <<"read", p>>)
  /\ UNCHANGED <<ver, sub, listens, known, toHost, watching, seen, told>>

\* The host takes the core's next line: an answer goes to its plugin, a change to every listener.
HostRecv ==
  /\ toHost # <<>>
  /\ LET m == Head(toHost) IN
       IF m[1] = "answer"
       THEN /\ known' = [known EXCEPT ![m[2]] = m[3]] /\ reading' = [reading EXCEPT ![m[2]] = FALSE] /\ UNCHANGED dirty
       ELSE /\ dirty' = [p \in Plugins |-> dirty[p] \/ sub[p]] /\ UNCHANGED <<known, reading>>
  /\ toHost' = Tail(toHost)
  /\ UNCHANGED <<ver, sub, listens, toCore, watching, seen, told>>

-----------------------------------------------------------------------------
\* The core.

\* The core takes the host's next line: who listens (Plugins.followWorkspace -> server watchWorkspace:
\* a watch already on keeps its digest), or a read, answered with what is there.
CoreRecv ==
  /\ toCore # <<>>
  /\ LET m == Head(toCore) IN
       IF m[1] = "reg"
       THEN /\ watching' = m[2]
            /\ seen' = IF ~m[2] THEN None ELSE IF watching THEN seen ELSE ver
            /\ UNCHANGED toHost
       ELSE /\ toHost' = Append(toHost, <<"answer", m[2], ver>>) /\ UNCHANGED <<watching, seen>>
  /\ toCore' = Tail(toCore)
  /\ UNCHANGED <<ver, sub, listens, known, reading, dirty, told>>

\* The core looks (soon after an event, and every 5 s): a digest unlike the last told is told.
Check ==
  /\ watching /\ seen # ver
  /\ seen' = ver /\ told' = told + 1
  /\ toHost' = Append(toHost, <<"change">>)
  /\ UNCHANGED <<ver, sub, listens, known, reading, dirty, toCore, watching>>

-----------------------------------------------------------------------------

Next ==
  \/ Change
  \/ \E p \in Plugins : Listen(p) \/ Unlisten(p) \/ Read(p)
  \/ HostRecv \/ CoreRecv \/ Check

\* The pipes deliver, the core looks, and a plugin told of a change reads. Nobody has to listen,
\* stop listening, or change anything.
Fairness == WF_vars(HostRecv) /\ WF_vars(CoreRecv) /\ WF_vars(Check) /\ \A p \in Plugins : WF_vars(Read(p))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* Safety.

\* The core keeps no digest while nobody listens (nothing is computed for nobody).
NoDigestUnwatched == ~watching => seen = None

\* The watch's digest is never newer than the world.
SeenNotAhead == seen # None => seen <= ver

\* What a plugin read is never newer than the world.
KnownNotAhead == \A p \in Plugins : known[p] # None => known[p] <= ver

\* The stamp moves exactly when what is told changed, and only while someone is watched for.
StampMovesOnChange == [][told' # told => (told' = told + 1 /\ watching /\ seen' # seen)]_vars

\* A change is told only while the core watches.
QuietUnwatched == [][Len(toHost') > Len(toHost) /\ toHost'[Len(toHost')] = <<"change">> => watching]_vars

-----------------------------------------------------------------------------
\* Liveness.

\* A plugin that keeps listening ends up knowing what is there: no change goes untold.
Converges == \A p \in Plugins : <>[]sub[p] => <>[](known[p] = ver)

\* Nobody listening for good: the core ends up keeping no digest.
StopsWhenNobodyListens == (<>[]~AnySub(sub)) => <>[]~watching
=============================================================================
