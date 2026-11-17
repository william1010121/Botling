---------------------------- MODULE Orchestration ----------------------------
(* Workers a plugin starts (M7-O03a/O03b/O04): desktop/src/core/orchestration/plugin-workers.ts (`PluginWorkers`), the
   core side in desktop/src/core/plugins/index.ts (`workersReconcile` in `sync`, `workersPickUp` on a host's
   registration, `workerEnded`) and the worker's ledger record (`startedBy`, worker-core/started-by.ts).

   The owner of every worker is the bot it runs for (plan M7-O01 Q1 A); the plugin holds a revocable route: the book
   (`<dataDir>/plugin-workers.json`, one entry per worker here) remembers which plugin and which hash started it, its
   place in the counts (at work, started in the day), whether the plugin may still send to it or cancel it (`handed`: given back to core), and the
   plugin's own copy of each run's end (`reported` is the cursor, `owed` the copies not taken by its host yet).

     workers.start: gate (on, granted; pickUp first) --written by a bot--> card --Allow + recheck--> reserved
                    reserved --PortStart (ledger: running, startedBy)--> --StartReturn (task id)--> live
     End: the bot is owed the report (rep pending, BotTake); the book owes the plugin a copy (cursor), told when its host
          listens and the plugin is still that hash with its grant
     Disable | Replace (another hash) | Revoke: reconcile hands every entry back (route gone, worker runs on, bot keeps
          its report) in the same step, before the new host
     Crash: running runs are interrupted (no report); cards, the host's listening, a cancel or send in flight are gone;
          a reservation whose task id was not written is a row that only counts for the day ("lost")

   The bot's own handling of a report (turns, checkpoint, routing to another bot) is spec/models/worker; here the bot
   just takes it (BotTake). A worker the bot starts after a plugin's message is OrchestrationHeard.tla.

   No cap (2026-11-17, the user: "不限定，告警就好"): a start or a send is never refused for how many a plugin has. The
   counts stay exact (a place is taken before the first await, freed when the worker is gone) and feed a warning: the
   step that takes a plugin past a threshold (AtOnce at work, PerDay started) tells the user, once per crossing.

   Code = "today" is the code at c1b17be2; Code = "fixed" adds the three fixes this model asks for (see the cfgs
   Orchestration_today_*.cfg for the counterexamples). Model only for now: a reference and conformance test follow
   the product fixes (.bot/artifacts/v3-orch/M7-O05.md). *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Plugins,     \* plugin names
  Hashes,      \* code identities (sha256 of the manifest in 2.x)
  Workers,     \* worker slots (task ids)
  MaxRun,      \* runs per worker (the start is run 1, each workers.send that starts a run adds one)
  AtOnce,      \* warning threshold: more than this many of a plugin's workers at work (settings orchestrateQuota.atOnce)
  PerDay,      \* warning threshold: more than this many started in 24 hours (no time passes here: the whole behaviour)
  MaxCrash,    \* app restarts in one behaviour
  MaxChanges,  \* plugin changes in one behaviour (disable, enable, replace, revoke, grant)
  Written,     \* the plugins a bot wrote (unknown counts as written): a card for every worker
  Code,        \* "today" (c1b17be2) or "fixed"
  Bug          \* "none" or one guard taken out (each must break a property; see Orchestration_bug_*.cfg)

ASSUME Written \subseteq Plugins /\ Code \in {"today", "fixed"}
ASSUME Bug \in {"none", "pluginowner", "nocursor", "nohash", "nohandback", "norecheck", "nogrant", "latereserve",
                "nopickup", "notag", "noday", "fullrights", "retell", "botskip", "earlyrearm"}

VARIABLES pl, wk, ent, told, crashes, changes,
  warned,      \* the book's flags (`warned`, in memory): this plugin was told it is past this threshold
  said         \* the warnings the last step gave (per plugin, a set of Kinds): what the user saw, for the properties
vars == <<pl, wk, ent, told, crashes, changes, warned, said>>

Runs == 1..MaxRun
Kinds == {"atOnce", "perDay"}
Idle == {"ended", "stopped", "interrupted"}
NoEnt == [st |-> "none", plugin |-> "none", hash |-> "none", open |-> FALSE, reported |-> 0, stopped |-> FALSE,
          stopping |-> FALSE, sending |-> "no", handed |-> FALSE, owed |-> {}]

TypeOK ==
  /\ pl \in [Plugins -> [on: BOOLEAN, hash: Hashes, granted: BOOLEAN, listen: BOOLEAN, card: Workers \cup {"none"}]]
  /\ wk \in [Workers -> [status: {"new", "running"} \cup Idle, run: 0..MaxRun, owner: {"none", "bot"} \cup Plugins,
                         rep: {"none", "pending", "taken"}, by: Plugins \cup {"none"}, hash: Hashes \cup {"none"},
                         fewer: BOOLEAN, evt: BOOLEAN]]
  /\ ent \in [Workers -> [st: {"none", "card", "reserved", "live", "lost"}, plugin: Plugins \cup {"none"},
                          hash: Hashes \cup {"none"}, open: BOOLEAN, reported: 0..MaxRun, stopped: BOOLEAN,
                          stopping: BOOLEAN, sending: {"no", "wasOpen", "wasClosed"}, handed: BOOLEAN,
                          owed: SUBSET Runs]]
  /\ told \in [Workers -> [bot: [Runs -> 0..3], plugin: [Runs -> 0..3]]]
  /\ crashes \in 0..MaxCrash /\ changes \in 0..MaxChanges
  /\ warned \in [Plugins -> [Kinds -> BOOLEAN]] /\ said \in [Plugins -> SUBSET Kinds]

-----------------------------------------------------------------------------
(* The book's rules, as operators on one entry. *)

(* `allowed()`: loaded and on, and the user's grant (the declared permissions are fixed for a hash: left out). *)
Authorized(p) == pl[p].on /\ (pl[p].granted \/ Bug = "nogrant")

(* `counts()`: an open entry is a place taken at work (a reservation too: the place is taken before the first await);
   every row of the plugin is a start of the day (a cut-off reservation, "lost", too: the book keeps it as a row). *)
Counted(e) == e.st \in {"reserved", "live"} /\ e.open /\ (Bug # "latereserve" \/ e.st = "live")
OpenIn(p, E) == Cardinality({w \in Workers : E[w].plugin = p /\ Counted(E[w])})
DayCounts(e) == e.st \in {"reserved", "live"} \/ (e.st = "lost" /\ Bug # "noday")
DayIn(p, E) == Cardinality({w \in Workers : E[w].plugin = p /\ DayCounts(E[w])})
Count(p, E, k) == IF k = "atOnce" THEN OpenIn(p, E) ELSE DayIn(p, E)
Limit(k) == IF k = "atOnce" THEN AtOnce ELSE PerDay

(* The warning, in the step that takes a place (E0 the book before it, E1 after it). `rearm()` first: a flag whose count
   is back under its threshold clears; then `warnIfPast()`: a count past its threshold with no flag tells the user and
   sets the flag. Nothing is refused. *)
Rearm(p, E) == [k \in Kinds |-> warned[p][k] /\ Count(p, E, k) > Limit(k)]
Notice(p, F, E1) == {k \in Kinds : Count(p, E1, k) > Limit(k) /\ ~F[k]}
WarnWith(p, F, E1) == /\ said' = [q \in Plugins |-> IF q = p THEN Notice(p, F, E1) ELSE {}]
                      /\ warned' = [warned EXCEPT ![p] = [k \in Kinds |-> F[k] \/ k \in Notice(p, F, E1)]]
Warn(p, E0, E1) == WarnWith(p, Rearm(p, E0), E1)
Quiet == said' = [p \in Plugins |-> {}]

(* An entry is closed (its place freed). Fixed: never while a workers.send for it is in flight (its run is coming). *)
Shut(e) == IF Code = "fixed" /\ e.sending # "no" THEN e ELSE [e EXCEPT !.open = FALSE]

(* `owe()`: the cursor and the copy are written, the place is freed; `flush()` then tells it. *)
Owe(e, r) == [Shut(e) EXCEPT !.reported = r, !.owed = @ \cup {r}]

(* `mayHear()`: told only to the plugin that started it, still that hash, still granted; not after a hand-back. *)
MayHear(e) == e.plugin \in Plugins /\ ~e.handed /\ pl[e.plugin].on /\ pl[e.plugin].granted
              /\ (pl[e.plugin].hash = e.hash \/ Bug = "nohash")
Hears(e) == e.owed # {} /\ MayHear(e) /\ pl[e.plugin].listen
FlushE(e) == IF Hears(e) THEN [e EXCEPT !.owed = {}] ELSE e
FlushT(e, t) == IF Hears(e) THEN [t EXCEPT !.plugin = [r \in Runs |-> t.plugin[r] + (IF r \in e.owed THEN 1 ELSE 0)]]
                ELSE t

(* `ended(task, run)`: the core says a run is not at work (any later non-running update too). Unknown task (no task id
   yet), or a cancel under way: nothing. Handed back: only the place is freed. *)
EndedE(e, r) ==
  IF e.st # "live" \/ e.stopped THEN e
  ELSE IF e.handed THEN (IF e.open /\ r >= e.reported THEN Shut(e) ELSE e)
  ELSE IF e.reported >= r /\ Bug # "nocursor" THEN e
  ELSE Owe(e, r)

(* `pickUp()` for one entry: the ledger says where the worker stands. *)
PickE(w, e) ==
  IF e.open /\ e.st = "live" /\ ~e.stopped /\ wk[w].status \in Idle
  THEN IF e.handed \/ wk[w].run <= e.reported THEN Shut(e) ELSE Owe(e, wk[w].run)
  ELSE e
PickEnt == [w \in Workers |-> FlushE(PickE(w, ent[w]))]
PickTold == [w \in Workers |-> FlushT(PickE(w, ent[w]), told[w])]

(* `reconcile()` with the plugins as they are after the step: an entry of a plugin that is off, another hash or no
   longer granted is handed back. *)
Reconcile(P) == IF Bug = "nohandback" THEN ent ELSE
  [w \in Workers |-> LET e == ent[w] IN
     IF e.st \in {"reserved", "live", "lost"} /\ ~e.handed
        /\ ~(P[e.plugin].on /\ (P[e.plugin].hash = e.hash \/ Bug = "nohash") /\ P[e.plugin].granted)
     THEN [e EXCEPT !.handed = TRUE, !.owed = {}] ELSE e]

(* `mine()`: the plugin's own worker, this very hash, not handed back (and the plugin is on). *)
Mine(p, w) == ent[w].st = "live" /\ ent[w].plugin = p /\ ~ent[w].handed /\ pl[p].on
           /\ (ent[w].hash = pl[p].hash \/ Bug = "nohash")

Reserved(p) == [NoEnt EXCEPT !.st = "reserved", !.plugin = p, !.hash = pl[p].hash, !.open = TRUE]

-----------------------------------------------------------------------------
(* The plugin's requests. *)

(* workers.start (and `gate()`): pickUp first, then the checks (no count among them); a plugin a bot wrote gets a card
   (one at a time), any other takes its place now. Bug earlyrearm: the warning is re-armed here, in the gate, and not
   again when the card's answer takes the place. *)
PluginStart(p, w) ==
  /\ wk[w].status = "new" /\ ent[w].st = "none"
  /\ Authorized(p)
  /\ (p \in Written => pl[p].card = "none")
  /\ LET E1 == [PickEnt EXCEPT ![w] = IF p \in Written THEN [NoEnt EXCEPT !.st = "card", !.plugin = p, !.hash = pl[p].hash]
                                      ELSE Reserved(p)] IN
     /\ ent' = E1
     /\ IF p \in Written
        THEN /\ Quiet
             /\ warned' = IF Bug = "earlyrearm" THEN [warned EXCEPT ![p] = Rearm(p, PickEnt)] ELSE warned
        ELSE Warn(p, PickEnt, E1)
  /\ told' = PickTold
  /\ pl' = IF p \in Written THEN [pl EXCEPT ![p].card = w] ELSE pl
  /\ UNCHANGED <<wk, crashes, changes>>

(* The card is answered (a timeout is a refusal). Allow: the facts are checked again (authority at use). *)
CardAnswer(p, allow) == LET w == pl[p].card IN
  /\ w # "none"
  /\ LET ok == allow /\ (Bug = "norecheck" \/ (Authorized(p) /\ pl[p].hash = ent[w].hash))
         E1 == [ent EXCEPT ![w] = IF ok THEN [Reserved(p) EXCEPT !.hash = ent[w].hash] ELSE NoEnt] IN
     /\ ent' = E1
     /\ pl' = [pl EXCEPT ![p].card = "none"]
     /\ IF ~ok THEN Quiet /\ UNCHANGED warned
        ELSE IF Bug = "earlyrearm" THEN WarnWith(p, warned[p], E1) ELSE Warn(p, ent, E1)
  /\ UNCHANGED <<wk, told, crashes, changes>>

(* `port.start`: the bot's worker host records the worker (startedBy) and starts run 1: the owner is the bot. *)
PortStart(w) == LET e == ent[w] IN
  /\ e.st = "reserved" /\ wk[w].status = "new"
  /\ wk' = [wk EXCEPT ![w].status = "running", ![w].run = 1, ![w].rep = "none", ![w].by = e.plugin, ![w].hash = e.hash,
                      ![w].fewer = (Bug # "fullrights"), ![w].owner = IF Bug = "pluginowner" THEN e.plugin ELSE "bot"]
  /\ Quiet /\ UNCHANGED <<pl, ent, told, crashes, changes, warned>>

(* The start failed: its place is given back (`forget`). *)
PortFail(w) == ent[w].st = "reserved" /\ wk[w].status = "new"
  /\ ent' = [ent EXCEPT ![w] = NoEnt] /\ Quiet /\ UNCHANGED <<pl, wk, told, crashes, changes, warned>>

(* The handoff returned its task id: written into the entry. *)
StartReturn(w) == ent[w].st = "reserved" /\ wk[w].status # "new"
  /\ ent' = [ent EXCEPT ![w].st = "live"] /\ Quiet /\ UNCHANGED <<pl, wk, told, crashes, changes, warned>>

(* workers.send to an idle worker: the place is taken again (not the day's count; never refused for the count, warned
   like a start when it was closed), then `port.send` is awaited. *)
SendAsk(p, w) == LET e == ent[w] IN
  /\ Mine(p, w) /\ Authorized(p) /\ e.sending = "no" /\ ~e.stopping
  /\ wk[w].status \in Idle /\ wk[w].run < MaxRun
  /\ Code = "fixed" => wk[w].rep # "pending"
  /\ LET E1 == [ent EXCEPT ![w].open = TRUE, ![w].stopped = FALSE, ![w].sending = IF e.open THEN "wasOpen" ELSE "wasClosed"] IN
     /\ ent' = E1
     /\ IF e.open THEN Quiet /\ UNCHANGED warned ELSE Warn(p, ent, E1)
  /\ UNCHANGED <<pl, wk, told, crashes, changes>>

(* `port.send` answers: a new run (a report the bot was not handed yet is dropped, as any next run drops it), or a
   refusal that puts the place back as it was. *)
SendDone(w, ok) == LET e == ent[w] IN
  /\ e.sending # "no"
  /\ IF ok /\ wk[w].status \in Idle /\ wk[w].run < MaxRun
     THEN /\ wk' = [wk EXCEPT ![w].status = "running", ![w].run = @ + 1, ![w].rep = "none", ![w].evt = FALSE]
          /\ ent' = [ent EXCEPT ![w].sending = "no"]
     ELSE /\ ent' = [ent EXCEPT ![w].sending = "no", ![w].open = (e.sending = "wasOpen")]
          /\ UNCHANGED wk
  /\ Quiet /\ UNCHANGED <<pl, told, crashes, changes, warned>>

(* workers.cancel: marked stopped before the stop is awaited. *)
CancelAsk(p, w) == Mine(p, w) /\ ~ent[w].stopping /\ ent[w].sending = "no"
  /\ ent' = [ent EXCEPT ![w].stopped = TRUE, ![w].stopping = TRUE] /\ Quiet /\ UNCHANGED <<pl, wk, told, crashes, changes, warned>>

(* The stop answers: it stopped the run (no report, the place freed), or the run had ended on its own first (that end
   is a report like any other: the mark is put back and pickUp looks). *)
CancelDone(w) ==
  /\ ent[w].stopping
  /\ IF wk[w].status = "running"
     THEN /\ wk' = [wk EXCEPT ![w].status = "stopped", ![w].rep = "none"]
          /\ ent' = [ent EXCEPT ![w].open = FALSE, ![w].stopping = FALSE] /\ UNCHANGED told
     ELSE LET e1 == [ent EXCEPT ![w].stopped = FALSE, ![w].stopping = FALSE] IN
          /\ ent' = [x \in Workers |-> FlushE(PickE(x, e1[x]))]
          /\ told' = [x \in Workers |-> FlushT(PickE(x, e1[x]), told[x])]
          /\ UNCHANGED wk
  /\ Quiet /\ UNCHANGED <<pl, crashes, changes, warned>>

-----------------------------------------------------------------------------
(* The worker and its owner. *)

(* The run ends (a reply or an error): the owner is owed its report; the book hears `ended` in the same chain. The
   handoff returns its task id before the run's process can say anything, so a run started here ends only once live. *)
End(w) == LET r == wk[w] IN
  /\ r.status = "running" /\ (ent[w].st = "reserved" => FALSE)
  /\ wk' = [wk EXCEPT ![w].status = "ended", ![w].evt = TRUE, ![w].rep = IF r.owner = "bot" THEN "pending" ELSE "none"]
  /\ ent' = [ent EXCEPT ![w] = FlushE(EndedE(ent[w], r.run))]
  /\ told' = [told EXCEPT ![w] = FlushT(EndedE(ent[w], r.run), told[w])]
  /\ Quiet /\ UNCHANGED <<pl, crashes, changes, warned>>

(* Another non-running `subagent.updated` for the same run (plugin-side.ts calls workerEnded on each one). *)
EndAgain(w) == wk[w].evt /\ wk[w].status \in Idle
  /\ ent' = [ent EXCEPT ![w] = FlushE(EndedE(ent[w], wk[w].run))]
  /\ told' = [told EXCEPT ![w] = FlushT(EndedE(ent[w], wk[w].run), told[w])]
  /\ Quiet /\ UNCHANGED <<pl, wk, crashes, changes, warned>>

(* The bot (the owner) is handed its report. *)
BotTake(w) == wk[w].rep = "pending" /\ (Bug # "botskip" \/ wk[w].by = "none")
  /\ wk' = [wk EXCEPT ![w].rep = IF Bug = "retell" THEN "pending" ELSE "taken"]
  /\ told' = [told EXCEPT ![w].bot[wk[w].run] = @ + 1]
  /\ Quiet /\ UNCHANGED <<pl, ent, crashes, changes, warned>>

-----------------------------------------------------------------------------
(* The plugin changes (the user, or a bot editing its code), and its host. *)

Change(p, P) == changes < MaxChanges /\ changes' = changes + 1 /\ pl' = P /\ ent' = Reconcile(P)
  /\ Quiet /\ UNCHANGED <<wk, told, crashes, warned>>

Disable(p) == pl[p].on /\ Change(p, [pl EXCEPT ![p].on = FALSE, ![p].listen = FALSE])
Enable(p) == ~pl[p].on /\ Change(p, [pl EXCEPT ![p].on = TRUE])
Replace(p, h) == pl[p].on /\ h # pl[p].hash /\ Change(p, [pl EXCEPT ![p].hash = h, ![p].listen = FALSE])
Revoke(p) == pl[p].granted /\ Change(p, [pl EXCEPT ![p].granted = FALSE])
Grant(p) == ~pl[p].granted /\ Change(p, [pl EXCEPT ![p].granted = TRUE])

(* The plugin's host comes up and registers `workerReport`: pickUp and redeliver over the whole book. *)
Register(p) == pl[p].on /\ ~pl[p].listen
  /\ LET P == [pl EXCEPT ![p].listen = TRUE] IN
     /\ pl' = P
     /\ ent' = [w \in Workers |-> LET e == IF Bug = "nopickup" THEN ent[w] ELSE PickE(w, ent[w]) IN
                  IF e.owed # {} /\ MayHear(e) /\ P[e.plugin].listen THEN [e EXCEPT !.owed = {}] ELSE e]
     /\ told' = [w \in Workers |-> LET e == IF Bug = "nopickup" THEN ent[w] ELSE PickE(w, ent[w]) IN
                  IF e.owed # {} /\ MayHear(e) /\ P[e.plugin].listen
                  THEN [told[w] EXCEPT !.plugin = [r \in Runs |-> told[w].plugin[r] + (IF r \in e.owed THEN 1 ELSE 0)]]
                  ELSE told[w]]
  /\ Quiet /\ UNCHANGED <<wk, crashes, changes, warned>>

(* The app goes away and comes back (the warning flags were in memory: gone). *)
Crash == crashes < MaxCrash /\ crashes' = crashes + 1
  /\ wk' = [w \in Workers |-> [wk[w] EXCEPT !.status = IF @ = "running" THEN "interrupted" ELSE @, !.evt = FALSE,
                                            !.by = IF Bug = "notag" THEN "none" ELSE @,
                                            !.hash = IF Bug = "notag" THEN "none" ELSE @]]
  /\ ent' = [w \in Workers |-> LET e == ent[w] IN
               CASE e.st = "card" -> NoEnt
                 [] e.st = "reserved" /\ wk[w].status = "new" -> NoEnt
                 [] e.st = "reserved" -> [NoEnt EXCEPT !.st = "lost", !.plugin = e.plugin, !.hash = e.hash, !.handed = e.handed]
                 [] OTHER -> [e EXCEPT !.stopping = FALSE, !.sending = "no",
                                       !.stopped = IF Code = "fixed" /\ e.open THEN FALSE ELSE @]]
  /\ pl' = [p \in Plugins |-> [pl[p] EXCEPT !.listen = FALSE, !.card = "none"]]
  /\ warned' = [p \in Plugins |-> [k \in Kinds |-> FALSE]] /\ Quiet
  /\ UNCHANGED <<told, changes>>

-----------------------------------------------------------------------------

Init ==
  /\ pl = [p \in Plugins |-> [on |-> TRUE, hash |-> CHOOSE h \in Hashes : TRUE, granted |-> TRUE, listen |-> FALSE,
                              card |-> "none"]]
  /\ wk = [w \in Workers |-> [status |-> "new", run |-> 0, owner |-> "none", rep |-> "none", by |-> "none",
                              hash |-> "none", fewer |-> FALSE, evt |-> FALSE]]
  /\ ent = [w \in Workers |-> NoEnt]
  /\ told = [w \in Workers |-> [bot |-> [r \in Runs |-> 0], plugin |-> [r \in Runs |-> 0]]]
  /\ crashes = 0 /\ changes = 0
  /\ warned = [p \in Plugins |-> [k \in Kinds |-> FALSE]] /\ said = [p \in Plugins |-> {}]

Next ==
  \/ Crash
  \/ \E p \in Plugins :
       \/ Disable(p) \/ Enable(p) \/ Revoke(p) \/ Grant(p) \/ Register(p) \/ (\E h \in Hashes : Replace(p, h))
       \/ (\E a \in BOOLEAN : CardAnswer(p, a))
       \/ \E w \in Workers : PluginStart(p, w) \/ SendAsk(p, w) \/ CancelAsk(p, w)
  \/ \E w \in Workers :
       \/ PortStart(w) \/ PortFail(w) \/ StartReturn(w) \/ (\E ok \in BOOLEAN : SendDone(w, ok)) \/ CancelDone(w)
       \/ End(w) \/ EndAgain(w) \/ BotTake(w)

(* The app answers every start, send and stop, a card is answered or times out, runs end, the bot takes its reports,
   a plugin that is on gets its host up. *)
Fairness ==
  /\ \A w \in Workers :
       /\ WF_vars(PortStart(w)) /\ WF_vars(StartReturn(w)) /\ WF_vars(\E ok \in BOOLEAN : SendDone(w, ok))
       /\ WF_vars(CancelDone(w)) /\ WF_vars(End(w)) /\ WF_vars(BotTake(w))
  /\ \A p \in Plugins : WF_vars(Register(p)) /\ WF_vars(\E a \in BOOLEAN : CardAnswer(p, a))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* P-O1: a worker has exactly one owner, the bot, from its start; never a plugin (so never an orphan when one goes). *)
OneOwner == \A w \in Workers : wk[w].status # "new" => wk[w].owner = "bot"
OwnerFixed == [][\A w \in Workers : wk[w].owner # "none" => wk'[w].owner = wk[w].owner]_vars
(* P-O8: every worker a plugin started names that plugin and its hash, across restarts. *)
Traceable == \A w \in Workers : wk[w].fewer => wk[w].by \in Plugins /\ wk[w].hash \in Hashes
(* P8: a worker a plugin started has fewer rights than the bot's own (no spec/, no skip-the-cards modes). *)
FewerRights == \A w \in Workers : wk[w].by # "none" => wk[w].fewer
(* P-O1: the owner is handed each run's report at most once; P-O2: the plugin is told each run at most once. *)
BotToldOnce == \A w \in Workers : \A r \in Runs : told[w].bot[r] <= 1
PluginToldOnce == \A w \in Workers : \A r \in Runs : told[w].plugin[r] <= 1
(* P-O1: a run that ended with a reply owes its owner the report. *)
EndOwesBot == \A w \in Workers : wk[w].status = "ended" => wk[w].rep # "none"
(* P-O1: what the owner is owed leaves only by being handed to it (a plugin never drops it). *)
BotNotSkipped == [][\A w \in Workers : wk[w].rep = "pending" => wk'[w].rep \in {"pending", "taken"}]_vars
(* P-O5 (no cap since 2026-11-17, so the counts, not a limit): every worker of a plugin at work holds a counted place
   (the warning's count is never short, a reservation included), and every worker a plugin started is one of its
   starts of the day, also after a restart cut it off. *)
RunningCounted == \A w \in Workers : wk[w].status = "running" /\ wk[w].by \in Plugins => Counted(ent[w])
DayCounted == \A w \in Workers : wk[w].by \in Plugins => ent[w].plugin = wk[w].by /\ DayCounts(ent[w])
(* The warning: the step that takes a plugin past a threshold tells the user (once per crossing: the flag stops a second
   notice until a place is taken with the count back under it, or a restart forgot it); a notice is never false. *)
WarnsEachCrossing == [][\A p \in Plugins, k \in Kinds :
  Count(p, ent, k) <= Limit(k) /\ Count(p, ent', k) > Limit(k) => k \in said'[p]]_vars
WarnsOnlyPast == \A p \in Plugins, k \in Kinds : k \in said[p] => Count(p, ent, k) > Limit(k)
(* P-O5 / P-O6: when a start counts the places (after its pickUp), every place still taken is a worker at work, one being
   started, or one with a send or a cancel under way: a worker that ended, was stopped, cut off by a restart or handed
   back never holds a place against the next start. *)
PlacesAreReal == \A w \in Workers :
  Counted(PickEnt[w]) => wk[w].status \in {"new", "running"} \/ ent[w].sending # "no" \/ ent[w].stopping
(* P8: a place is taken only with the plugin's authority of the moment: on, granted, the hash asked about, and for a
   plugin a bot wrote, through the user's card. A send likewise. *)
GrantBound == [][\A w \in Workers :
  /\ (ent[w].st \in {"none", "card"} /\ ent'[w].st = "reserved") =>
       LET p == ent'[w].plugin IN pl[p].on /\ pl[p].granted /\ pl[p].hash = ent'[w].hash /\ (p \in Written => ent[w].st = "card")
  /\ (ent[w].sending = "no" /\ ent'[w].sending # "no") =>
       LET p == ent[w].plugin IN pl[p].on /\ pl[p].granted /\ pl[p].hash = ent[w].hash]_vars
(* P7 (a plugin replaced while its worker is at work): a run's copy goes only to the plugin and hash that started the
   worker, granted, not handed back; the new hash hears nothing of the old one's workers. *)
HearsOnlyItsOwn == [][\A w \in Workers : told'[w].plugin # told[w].plugin =>
  LET e == ent[w] IN e.plugin \in Plugins /\ ~e.handed /\ pl'[e.plugin].on /\ pl'[e.plugin].granted
                     /\ pl'[e.plugin].hash = e.hash]_vars

(* Liveness *)

(* P-O1: the owner gets every report it is owed. *)
BotGetsReport == \A w \in Workers : wk[w].rep = "pending" ~> wk[w].rep = "taken"
(* P-O2 / P7: a run of a worker the plugin still holds that ended (with a reply or an error, or cut off by a restart;
   not one it cancelled itself) is told to it, or the plugin is no longer the one (handed back), unless the plugin sent
   it on (a new run) first. *)
Due(w) == LET e == ent[w] IN
  e.st = "live" /\ ~e.handed /\ ~e.stopped /\ wk[w].status \in {"ended", "interrupted"} /\ wk[w].run > e.reported
EndReachesPlugin == \A w \in Workers : Due(w) ~> ~Due(w)
(* P7: a copy owed is told or dropped by a hand-back: exactly one outcome. *)
OwedSettles == \A w \in Workers : ent[w].owed # {} ~> ent[w].owed = {}
=============================================================================
