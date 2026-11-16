-------------------------- MODULE OrchestrationRules --------------------------
(***************************************************************************)
(* The orchestration rules a plugin gives, and core's own rules when it    *)
(* cannot (M7-O04; plan .bot/artifacts/v3-orch/M7-O01-plan.md P-O3, P-O9;  *)
(* tla-brief-plugin-kernel.md P6). Code: desktop/src/core/orchestration/   *)
(* plugin-rules.ts (`OrchestrationRulesBook`) and its caller               *)
(* desktop/src/core/server/send.ts (`sendWith`: `void refresh()`, then the *)
(* turn starts with `current()`).                                          *)
(*                                                                         *)
(* The plugin (the built-in one, pinned by sha256, or the one the user     *)
(* chose with its sha256 in settings.json) is "good" (the pinned bytes),   *)
(* "edited" (a bot changed rules.json after the user pinned it), "throws"  *)
(* (off, missing, not format 1) or "hangs" (never answers). It can change  *)
(* at any time (Break). A turn never waits for it: it starts with the set  *)
(* the last ask left; an ask that fails or runs out of time puts core's    *)
(* rules back at once and tells the user once per failure period.          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxTurns,  \* turns the user starts (each starts one ask, unless one is under way)
          MaxBreaks, \* times the plugin changes state
          Start,     \* the plugin's state at the start
          Bug        \* "none" | "nopin" | "keeplast" | "notimeout" | "await" | "noticeeach" | "silent"

States == {"good", "edited", "throws", "hangs"}
ASSUME Start \in States
ASSUME Bug \in {"none", "nopin", "keeplast", "notimeout", "await", "noticeeach", "silent"}

VARIABLES src,     \* the plugin's state now
          rules,   \* `current()`: "core", "plugin" (the pinned text) or "edited" (an unpinned text)
          flight,  \* an ask under way: "none" or the state the plugin was in when asked
          say,     \* a `say` was given to the ask under way
          told,    \* `told`: the user was told in this failure period
          said,    \* notices given since the last answer
          last,    \* the last ask: "none" | "ok" | "failed"
          turns,   \* turns started
          waiting, \* turns waiting for an ask (only with Bug = "await")
          used,    \* the set the last turn started with
          breaks

vars == <<src, rules, flight, say, told, said, last, turns, waiting, used, breaks>>

TypeOK == /\ src \in States /\ rules \in {"core", "plugin", "edited"} /\ flight \in {"none"} \cup States
          /\ say \in BOOLEAN /\ told \in BOOLEAN /\ said \in 0..MaxTurns /\ last \in {"none", "ok", "failed"}
          /\ turns \in 0..MaxTurns /\ waiting \in 0..MaxTurns /\ used \in {"none", "core", "plugin", "edited"}
          /\ breaks \in 0..MaxBreaks

Init == /\ src = Start /\ rules = "core" /\ flight = "none" /\ say = FALSE /\ told = FALSE /\ said = 0 /\ last = "none"
        /\ turns = 0 /\ waiting = 0 /\ used = "none" /\ breaks = 0

(* `sendWith`: `refresh(say)` (a new ask unless one is under way), then the turn starts with `current()`, which the ask
   has not changed yet. With Bug = "await" the turn waits for the ask instead. *)
Send(withSay) ==
  /\ turns < MaxTurns
  /\ turns' = turns + 1
  /\ say' = (say \/ withSay)
  /\ flight' = IF flight = "none" THEN src ELSE flight
  /\ IF Bug = "await" THEN waiting' = waiting + 1 /\ UNCHANGED used ELSE used' = rules /\ UNCHANGED waiting
  /\ UNCHANGED <<src, rules, told, said, last, breaks>>

(* The end of an ask: `finally` clears `flight` and `say`. *)
Done == flight' = "none" /\ say' = FALSE

(* The source answers: the pinned bytes are taken; other bytes (unless Bug = "nopin") or a throw is a failure. *)
Take(text) == /\ rules' = text /\ last' = "ok" /\ said' = 0
              /\ told' = FALSE
Fail == /\ rules' = IF Bug = "keeplast" THEN rules ELSE "core"
        /\ last' = "failed"
        /\ IF Bug = "noticeeach" THEN told' = told /\ said' = IF say THEN said + 1 ELSE said
           ELSE IF ~told /\ say /\ Bug # "silent" THEN told' = TRUE /\ said' = said + 1
           ELSE UNCHANGED <<told, said>>

Answer ==
  /\ flight \in {"good", "edited", "throws"}
  /\ IF flight = "good" THEN Take("plugin")
     ELSE IF flight = "edited" /\ Bug = "nopin" THEN Take("edited")
     ELSE Fail
  /\ Done
  /\ UNCHANGED <<src, turns, waiting, used, breaks>>

(* RULES_TIME_LIMIT_MS ran out (a slow answer counts as none). *)
Timeout ==
  /\ flight # "none" /\ Bug # "notimeout"
  /\ Fail /\ Done
  /\ UNCHANGED <<src, turns, waiting, used, breaks>>

(* Bug = "await": a waiting turn starts once no ask is under way. *)
StartWaiting ==
  /\ waiting > 0 /\ flight = "none"
  /\ waiting' = waiting - 1 /\ used' = rules
  /\ UNCHANGED <<src, rules, flight, say, told, said, last, turns, breaks>>

(* The plugin changes: a bot edits rules.json, the user turns it off, it hangs, it is put right. *)
Break(s) ==
  /\ breaks < MaxBreaks /\ s # src
  /\ src' = s /\ breaks' = breaks + 1
  /\ UNCHANGED <<rules, flight, say, told, said, last, turns, waiting, used>>

Next == \/ \E b \in BOOLEAN : Send(b)
        \/ Answer \/ Timeout \/ StartWaiting
        \/ \E s \in States : Break(s)

Spec == Init /\ [][Next]_vars /\ WF_vars(Answer) /\ WF_vars(Timeout) /\ WF_vars(StartWaiting)

-----------------------------------------------------------------------------
(* Safety. *)

(* P-O9: only the pinned text is ever used: a bot that edits the chosen plugin's file gets core's rules. *)
OnlyPinned == rules \in {"core", "plugin"} /\ used \in {"none", "core", "plugin"}

(* P-O3 / P6: after a failed ask the set is core's own until the next answer. *)
CoreAfterFailure == last = "failed" => rules = "core"

(* A turn never waits for a plugin. *)
NeverWaits == waiting = 0

(* The user is told at most once per failure period. *)
ToldOnce == said <= 1

(* ... and is told: a failed ask that has a `say` while the user has not been told in this period tells them. *)
SaysIt == [][(flight # "none" /\ flight' = "none" /\ last' = "failed" /\ say /\ ~told) => said' = said + 1]_vars

(* Liveness (WF on Answer, Timeout). *)

(* Every ask ends, whatever the plugin does. *)
AskEnds == flight # "none" ~> flight = "none"

(* A plugin that stays broken leaves core's rules in place: the next ask after the break fails. *)
BrokenGivesCore == (src \in {"edited", "throws", "hangs"} /\ breaks = MaxBreaks /\ flight = src) ~> rules = "core"
=============================================================================
