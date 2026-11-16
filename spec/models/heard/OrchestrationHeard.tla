-------------------------- MODULE OrchestrationHeard --------------------------
(***************************************************************************)
(* F6 (M7-O04): a worker the bot starts for a plugin's message is checked  *)
(* as that plugin's (P8 NoOverreach, P9 NoAmplification of                 *)
(* tla-brief-plugin-kernel.md; plan .bot/artifacts/v3-orch/M7-O01-plan.md  *)
(* P-O5, P-O6). Code: desktop/src/core/plugins/requests.ts (`bots.send`,   *)
(* `bots.wake` call `heard`), desktop/src/core/plugins/index.ts            *)
(* (`Plugins.origins`, `admitWorker`), desktop/src/core/server/send.ts     *)
(* (`sendWith` clears the mark), desktop/src/core/worker-core/core.ts      *)
(* (`handoff` asks `admit`; `message` does not),                           *)
(* desktop/src/core/orchestration/plugin-workers.ts (`admitHeard`).        *)
(*                                                                         *)
(* One bot. Messages reach it from the user, a shipped plugin (a deputy    *)
(* the user installed with the app), plugins that are not shipped, and its *)
(* workers' reports; it answers them one turn at a time, in order. In a    *)
(* turn it may start a worker (app_handoff) or give its idle worker a new  *)
(* run (app_send_message). A worker started for a plugin gets fewer rights *)
(* and carries the plugin's name.                                          *)
(*                                                                         *)
(* What a turn really stems from (`turn.cause`): the message's sender; for *)
(* a report, what the worker's run stemmed from. What the code checks      *)
(* (`Ctx`):                                                                *)
(*   Mark = "bot": `origins` for the bot at the moment of the check (the   *)
(*     code at c1b17be2: set when a plugin sends, cleared when the user    *)
(*     writes, whatever turn is running then);                             *)
(*   Mark = "turn": the plugin fixed when the turn starts and inherited by *)
(*     a report's turn from the run (the fix).                             *)
(* GateMessage: app_send_message is checked as app_handoff is (the fix);   *)
(* FALSE is the code at c1b17be2.                                          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Plugins,     \* plugins that are not shipped
          Shipped,     \* shipped plugins (deputies: never marked)
          Workers,
          MaxMsgs,     \* messages the user and the plugins send
          MaxRuns,     \* runs in all
          MaxChanges,  \* grant changes
          Granted0,    \* plugins granted `orchestrate` at the start
          Mark, GateMessage,
          Bug          \* "none" | "nogrant" | "noinherit" | "notag"

None == "none"
Senders == {"user"} \cup Shipped \cup Plugins
Free == {"user"} \cup Shipped
ASSUME Mark \in {"bot", "turn"} /\ GateMessage \in BOOLEAN /\ Granted0 \subseteq Plugins
ASSUME Bug \in {"none", "nogrant", "noinherit", "notag"}

Msg == [from : Senders \cup {"report"}, w : Workers \cup {None}]
NoWk == [st |-> None, rights |-> None, by |-> None, cause |-> None, ctx |-> None]
NoTurn == [on |-> FALSE, cause |-> None, ctx |-> None]

VARIABLES queue, mark, turn, wk, granted, msgs, runs, changes, refused

vars == <<queue, mark, turn, wk, granted, msgs, runs, changes, refused>>

TypeOK ==
  /\ queue \in Seq(Msg) /\ mark \in {None} \cup Plugins
  /\ turn \in [on : BOOLEAN, cause : {None} \cup Senders, ctx : {None} \cup Plugins]
  /\ wk \in [Workers -> [st : {None, "idle", "running"}, rights : {None, "full", "fewer"}, by : {None} \cup Plugins,
                        cause : {None} \cup Senders, ctx : {None} \cup Plugins]]
  /\ granted \subseteq Plugins /\ msgs \in 0..MaxMsgs /\ runs \in 0..MaxRuns /\ changes \in 0..MaxChanges
  /\ refused \subseteq Senders

Init == /\ queue = <<>> /\ mark = None /\ turn = NoTurn /\ wk = [w \in Workers |-> NoWk] /\ granted = Granted0
        /\ msgs = 0 /\ runs = 0 /\ changes = 0 /\ refused = {}

(* The user writes (`sendWith`: the mark goes). *)
UserSends ==
  /\ msgs < MaxMsgs /\ msgs' = msgs + 1
  /\ queue' = Append(queue, [from |-> "user", w |-> None])
  /\ mark' = IF Mark = "bot" THEN None ELSE mark
  /\ UNCHANGED <<turn, wk, granted, runs, changes, refused>>

(* A plugin's `bots.send` / `bots.wake` (`heard`: a plugin that is not shipped is remembered). *)
PluginSends(p) ==
  /\ msgs < MaxMsgs /\ msgs' = msgs + 1
  /\ queue' = Append(queue, [from |-> p, w |-> None])
  /\ mark' = IF Mark = "bot" /\ p \in Plugins THEN p ELSE mark
  /\ UNCHANGED <<turn, wk, granted, runs, changes, refused>>

(* The bot answers the next message. *)
TurnStarts ==
  /\ ~turn.on /\ queue # <<>>
  /\ LET m == Head(queue)
         cause == IF m.from = "report" THEN wk[m.w].cause ELSE m.from
         ctx == IF m.from = "report" THEN (IF Bug = "noinherit" THEN None ELSE wk[m.w].ctx)
                ELSE IF m.from \in Plugins THEN m.from ELSE None
     IN turn' = [on |-> TRUE, cause |-> cause, ctx |-> ctx]
  /\ queue' = Tail(queue)
  /\ UNCHANGED <<mark, wk, granted, msgs, runs, changes, refused>>

TurnEnds == turn.on /\ turn' = NoTurn /\ UNCHANGED <<queue, mark, wk, granted, msgs, runs, changes, refused>>

(* The plugin the code checks the turn's worker against. *)
Ctx == IF Mark = "bot" THEN mark ELSE turn.ctx
May(p) == p \in granted \/ Bug = "nogrant"

Refuse == refused' = refused \cup {turn.cause} /\ UNCHANGED <<queue, mark, turn, wk, granted, msgs, runs, changes>>

(* app_handoff: `admit`. No mark: a worker with the bot's rights. A mark: `admitHeard` (the plugin's grant, fewer
   rights, the plugin's name), or refused. *)
Handoff(w) ==
  /\ turn.on /\ wk[w].st = None /\ runs < MaxRuns
  /\ IF Ctx = None
     THEN /\ wk' = [wk EXCEPT ![w] = [st |-> "running", rights |-> "full", by |-> None, cause |-> turn.cause, ctx |-> None]]
          /\ runs' = runs + 1 /\ UNCHANGED <<queue, mark, turn, granted, msgs, changes, refused>>
     ELSE IF May(Ctx)
     THEN /\ wk' = [wk EXCEPT ![w] = [st |-> "running", rights |-> "fewer", by |-> IF Bug = "notag" THEN None ELSE Ctx,
                                      cause |-> turn.cause, ctx |-> Ctx]]
          /\ runs' = runs + 1 /\ UNCHANGED <<queue, mark, turn, granted, msgs, changes, refused>>
     ELSE Refuse

(* app_send_message to the bot's idle worker: a new run with the worker's rights. GateMessage: under a mark only the
   plugin's own worker, while the plugin is granted. *)
Message(w) ==
  /\ turn.on /\ wk[w].st = "idle" /\ runs < MaxRuns
  /\ IF ~GateMessage \/ Ctx = None \/ (May(Ctx) /\ wk[w].by = Ctx)
     THEN /\ wk' = [wk EXCEPT ![w].st = "running", ![w].cause = turn.cause, ![w].ctx = Ctx]
          /\ runs' = runs + 1 /\ UNCHANGED <<queue, mark, turn, granted, msgs, changes, refused>>
     ELSE Refuse

(* A run ends; its report comes to the bot as a message. *)
RunEnds(w) ==
  /\ wk[w].st = "running"
  /\ wk' = [wk EXCEPT ![w].st = "idle"]
  /\ queue' = Append(queue, [from |-> "report", w |-> w])
  /\ UNCHANGED <<mark, turn, granted, msgs, runs, changes, refused>>

Revoke(p) == changes < MaxChanges /\ p \in granted /\ granted' = granted \ {p} /\ changes' = changes + 1
             /\ UNCHANGED <<queue, mark, turn, wk, msgs, runs, refused>>
Grant(p) == changes < MaxChanges /\ p \notin granted /\ granted' = granted \cup {p} /\ changes' = changes + 1
            /\ UNCHANGED <<queue, mark, turn, wk, msgs, runs, refused>>

Next == \/ UserSends \/ \E p \in Shipped \cup Plugins : PluginSends(p)
        \/ TurnStarts \/ TurnEnds
        \/ \E w \in Workers : Handoff(w) \/ Message(w) \/ RunEnds(w)
        \/ \E p \in Plugins : Revoke(p) \/ Grant(p)

Spec == Init /\ [][Next]_vars /\ WF_vars(TurnStarts) /\ WF_vars(TurnEnds) /\ \A w \in Workers : WF_vars(RunEnds(w))

-----------------------------------------------------------------------------
Starts(w) == wk[w].st # "running" /\ wk'[w].st = "running"

(* P9 NoAmplification: a run with the bot's own rights stems from the user or a shipped plugin, never from a plugin
   that is not shipped (directly, or through a worker's report). *)
NoAmplification == [][\A w \in Workers : Starts(w) /\ wk'[w].rights = "full" => turn.cause \in Free]_vars

(* P8 NoOverreach: a run that stems from a plugin is that plugin's (fewer rights, its name) while it is granted. *)
NoOverreach == [][\A w \in Workers : Starts(w) /\ turn.cause \in Plugins =>
                    turn.cause \in granted /\ wk'[w].rights = "fewer" /\ wk'[w].by = turn.cause]_vars

(* A turn of the user's (or a shipped plugin's) is never checked as a plugin's. *)
UserTurnsFree == refused \cap Free = {}

(* Liveness (WF on TurnStarts, TurnEnds, RunEnds): every message is answered. *)
Answered == queue # <<>> ~> queue = <<>>
=============================================================================
