---------------------------- MODULE RelayedCard ----------------------------
(* An option card a called-in bot asks, and the user's answer on it (desktop/src/core/server.ts calledInPick,
   calledInAnswer, answerRelayedCopy, settleRelayedOriginal, closeRelayedCopies, ignoreQuestion;
   conversations.ts answerCallIn, callInFollowUp). P is a bot with a chat; S is its sub bot, which P calls in with @.
   S asks in one of two ways:
     - "guest": during the call-in its reply, with the card, is a guest line in P's chat. An answer there goes back
       to S as a call-in in P's chat (answerCallIn): S, the bot that asked, answers there.
     - "relayed": S started a worker for P's @; its reply on the worker's report is in S's own chat (the original)
       and the app relays a copy into P's chat (callInFollowUp, the copy names the original). An answer on the copy
       is the user's message to P, the bot of the chat it was given in, who carries the work on (505457a0); the
       original shows it, S is not woken. An answer on the original goes to S in its own chat; the copy shows it.
   Either way one answer hands exactly one turn to exactly one bot, and a card (the original and its copy) is
   answered at most once. Ignoring either line ignores the card (the original, whose copies follow it).

   S's turns: its own (a message in its own chat, or an answer there), queued behind one under way, and its call-ins
   in P's chat, which run one at a time and wait for S to be free; one that finds S busy with its own turn gives up
   and tells P's chat ("Did not answer this time"). The real app waits 20 s for it (GROUP_TIMING.busy); here the
   wait is 0 (the adapter's groupTiming), so it gives up at once. When a call-in ends, S's queued own turn begins
   before the next call-in (Bot.groupTurn's `next()`). A turn handed to P is the end of the answer's way here (the
   Turns model covers a bot's queue).

   Action names match spec/reference/relayed-card.ts and the driver (spec/driver/relayed-card-driver.ts). *)
EXTENDS Naturals, Sequences

CONSTANTS
  MaxCards,   \* cards S asks in one behaviour
  Bug         \* "none"; "callee": before 505457a0, an answer on a relayed copy went to S as a call-in in P's chat
              \* (the bot that asked, not the bot of the chat); "open": an answer on the copy leaves the original open
              \* (no settleRelayedOriginal); "ignoregone": ignoring a copy whose bot was removed is refused (the app
              \* looked its original up in a bot that is gone; before this model's fix)

ASSUME MaxCards \in Nat /\ Bug \in {"none", "callee", "open", "ignoregone"}

Kinds == {"guest", "relayed"}
Lines == {"open", "settled", "none"}   \* "none": the card has no line there (a guest card in S's chat)
Card == 1..MaxCards

VARIABLES
  kind,     \* Seq(Kinds): the cards S asked, in order
  line,     \* Seq([P: Lines, S: Lines]): each card's line in P's chat and in S's own chat
  at,       \* Seq({"none", "P", "S"}): the chat where the user's answer was accepted
  answers,  \* Seq(Nat): answers accepted on the card
  woke,     \* Seq([P: Nat, S: Nat]): turns handed to each bot with the card's answer
  told,     \* Seq(BOOLEAN): the answer's call-in gave up, with a notice in P's chat
  s,        \* S: "idle", "own" (a turn of its own), "guest" (a call-in in P's chat)
  queued,   \* S's own turns waiting
  calls,    \* Seq(Card): call-ins in P's chat waiting for S, the answers they carry
  gone,     \* S was removed
  refused   \* an ignore the app refused

vars == <<kind, line, at, answers, woke, told, s, queued, calls, gone, refused>>

TypeOK ==
  /\ kind \in Seq(Kinds) /\ Len(kind) <= MaxCards
  /\ DOMAIN line = DOMAIN kind /\ \A k \in DOMAIN line : line[k] \in [P : Lines, S : Lines]
  /\ DOMAIN at = DOMAIN kind /\ \A k \in DOMAIN at : at[k] \in {"none", "P", "S"}
  /\ DOMAIN answers = DOMAIN kind /\ \A k \in DOMAIN answers : answers[k] \in Nat
  /\ DOMAIN woke = DOMAIN kind /\ \A k \in DOMAIN woke : woke[k] \in [P : Nat, S : Nat]
  /\ DOMAIN told = DOMAIN kind /\ \A k \in DOMAIN told : told[k] \in BOOLEAN
  /\ s \in {"idle", "own", "guest"} /\ queued \in Nat /\ calls \in Seq(Card)
  /\ gone \in BOOLEAN /\ refused \in BOOLEAN

Init ==
  /\ kind = <<>> /\ line = <<>> /\ at = <<>> /\ answers = <<>> /\ woke = <<>> /\ told = <<>>
  /\ s = "idle" /\ queued = 0 /\ calls = <<>> /\ gone = FALSE /\ refused = FALSE

-----------------------------------------------------------------------------

(* S asks: P called it in, both idle (the call-in, the worker and the hand-backs to P run to their end here). *)
Ask(kd) ==
  /\ ~gone /\ s = "idle" /\ queued = 0 /\ calls = <<>> /\ Len(kind) < MaxCards
  /\ kind' = Append(kind, kd)
  /\ line' = Append(line, [P |-> "open", S |-> IF kd = "relayed" THEN "open" ELSE "none"])
  /\ at' = Append(at, "none") /\ answers' = Append(answers, 0) /\ woke' = Append(woke, [P |-> 0, S |-> 0])
  /\ told' = Append(told, FALSE)
  /\ UNCHANGED <<s, queued, calls, gone, refused>>

Wake(k, b) == woke' = [woke EXCEPT ![k][b] = @ + 1]

(* The answer is a call-in for S in P's chat (answerCallIn): it runs now, waits behind the one under way, or finds S
   busy with its own turn and gives up with a notice. *)
CallIn(k) ==
  CASE s = "idle" -> s' = "guest" /\ Wake(k, "S") /\ UNCHANGED <<calls, told, queued>>
    [] s = "guest" -> calls' = Append(calls, k) /\ UNCHANGED <<s, woke, told, queued>>
    [] s = "own" -> told' = [told EXCEPT ![k] = TRUE] /\ UNCHANGED <<s, woke, calls, queued>>

(* The answer is the user's message to S in its own chat: a turn now, or queued behind the one under way. *)
OwnTurn(k) ==
  /\ Wake(k, "S")
  /\ IF s = "idle" THEN s' = "own" /\ UNCHANGED queued ELSE queued' = queued + 1 /\ UNCHANGED s
  /\ UNCHANGED <<calls, told>>

Settle(k, c) == [line EXCEPT ![k][c] = "settled"]
Accept(k, c) == at' = [at EXCEPT ![k] = c] /\ answers' = [answers EXCEPT ![k] = @ + 1]

(* The user answers card k on its line in chat c (a pick, words, or a question group's picks). *)
Answer(k, c) ==
  /\ k \in DOMAIN kind /\ line[k][c] = "open" /\ (c = "S" => ~gone)
  /\ CASE c = "S" ->
            \* The original, in S's chat: S's own question; the copy in P's chat shows the answer.
            /\ line' = [Settle(k, "S") EXCEPT ![k].P = "settled"] /\ Accept(k, "S") /\ OwnTurn(k)
       [] kind[k] = "relayed" /\ Bug # "callee" ->
            \* The copy, in P's chat: the user's message to P; the original shows it (unless S is gone).
            /\ line' = IF Bug = "open" \/ gone THEN Settle(k, "P") ELSE [Settle(k, "P") EXCEPT ![k].S = "settled"]
            /\ Accept(k, "P") /\ Wake(k, "P")
            /\ UNCHANGED <<s, queued, calls, told>>
       [] OTHER ->
            \* A guest's line (or, with bug "callee", a copy): back to S as a call-in; refused when S is gone.
            IF gone
            THEN line' = Settle(k, "P") /\ UNCHANGED <<at, answers, woke, s, queued, calls, told>>
            ELSE /\ line' = IF kind[k] = "relayed" THEN [Settle(k, "P") EXCEPT ![k].S = "settled"] ELSE Settle(k, "P")
                 /\ Accept(k, "P") /\ CallIn(k)
  /\ UNCHANGED <<kind, gone, refused>>

(* The user ignores card k on its line in chat c: the original is ignored and its copies follow; a guest line on its
   own. Wakes nobody. *)
Ignore(k, c) ==
  /\ k \in DOMAIN kind /\ line[k][c] = "open" /\ (c = "S" => ~gone)
  /\ IF kind[k] = "relayed" /\ c = "P" /\ gone /\ Bug = "ignoregone"
     THEN refused' = TRUE /\ UNCHANGED line
     ELSE /\ line' = IF kind[k] = "relayed" /\ ~gone THEN [Settle(k, "P") EXCEPT ![k].S = "settled"] ELSE Settle(k, c)
          /\ UNCHANGED refused
  /\ UNCHANGED <<kind, at, answers, woke, told, s, queued, calls, gone>>

(* A user line in S's own chat: a turn of its own. *)
Work ==
  /\ ~gone /\ s = "idle" /\ queued = 0 /\ calls = <<>> /\ s' = "own"
  /\ UNCHANGED <<kind, line, at, answers, woke, told, queued, calls, gone, refused>>

(* S's turn ends. Its queued own turn begins first; call-ins waiting then find it busy and give up. Without one, the
   next call-in in P's chat begins. *)
EndTurn ==
  /\ s # "idle"
  /\ IF queued > 0
     THEN /\ s' = "own" /\ queued' = queued - 1
          /\ told' = [k \in DOMAIN told |-> told[k] \/ \E i \in DOMAIN calls : calls[i] = k]
          /\ calls' = <<>> /\ UNCHANGED woke
     ELSE IF calls # <<>>
     THEN /\ s' = "guest" /\ Wake(Head(calls), "S") /\ calls' = Tail(calls)
          /\ UNCHANGED <<queued, told>>
     ELSE s' = "idle" /\ UNCHANGED <<queued, calls, woke, told>>
  /\ UNCHANGED <<kind, line, at, answers, gone, refused>>

(* S is removed while idle. Its chat goes; the lines in P's chat stay. *)
Remove ==
  /\ ~gone /\ s = "idle" /\ queued = 0 /\ calls = <<>> /\ gone' = TRUE
  /\ UNCHANGED <<kind, line, at, answers, woke, told, s, queued, calls, refused>>

Next ==
  \/ \E kd \in Kinds : Ask(kd)
  \/ \E k \in Card, c \in {"P", "S"} : Answer(k, c) \/ Ignore(k, c)
  \/ Work \/ EndTurn \/ Remove

(* S's turns end. *)
Fairness == WF_vars(EndTurn)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* The bot an answer on card k is for: the bot that asked a guest line; on a relayed card, the bot of the chat where
   it was given. *)
For(k) == IF kind[k] = "guest" THEN "S" ELSE at[k]

(* A card (the original and its copy) is answered at most once. *)
AnsweredOnce == \A k \in DOMAIN kind : answers[k] <= 1
(* One answer hands at most one turn, to one bot, or is told as not heard; none without an answer. *)
OneWakePerAnswer == \A k \in DOMAIN kind : woke[k].P + woke[k].S + (IF told[k] THEN 1 ELSE 0) <= answers[k]
(* ... and that bot is the one it is for: on a relayed card, the bot of the chat it was given in. *)
WakesItsBot == \A k \in DOMAIN kind : \A b \in {"P", "S"} : woke[k][b] > 0 => b = For(k)
(* The original and its copy show the same: both open, or both settled (while S's chat is there). *)
BothShowIt == \A k \in DOMAIN kind : kind[k] = "relayed" /\ ~gone => line[k].P = line[k].S
(* An answered card is settled where it was answered. *)
AnsweredIsSettled == \A k \in DOMAIN kind : at[k] # "none" => line[k][at[k]] = "settled"
(* Every open line can be ignored. *)
IgnoreNeverRefused == ~refused
(* Call-ins wait only behind one under way. *)
CallsWait == calls # <<>> => s = "guest"

(* Liveness *)

(* Every accepted answer reaches the bot it is for, or the chat is told it did not. *)
AnswerReaches == \A k \in Card : (k \in DOMAIN kind /\ answers[k] = 1) ~> (k \in DOMAIN kind /\ (woke[k].P + woke[k].S = 1 \/ told[k]))
=============================================================================
