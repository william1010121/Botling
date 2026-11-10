---------------------------- MODULE RelayedCard ----------------------------
(* An option card a called-in bot asks, and the user's answer on it (desktop/src/core/server.ts calledInPick,
   calledInAnswer, answerGuestLine, answerRelayedCopy, settleRelayedOriginal, ignoreQuestion, removeBot;
   conversations.ts answerCallIn, callInFollowUp; bot.ts send's onDelivery, holdCardAnswer, releaseCardAnswer).
   P is a bot with a chat; S is its sub bot, which P calls in with @. S asks in one of two ways:
     - "guest": during the call-in its reply, with the card, is a guest line in P's chat. An answer there goes back
       to S, the bot that asked: when S is free, as a call-in in P's chat (answerCallIn), which begins at once; when
       S is at work, as the user's message in S's own chat, read into the turn under way (steered) or queued behind
       it. Until it reaches S the card shows the user's choice as queued ("pending") and cannot be answered again;
       it shows as chosen once S has it. If it never reaches S (the message is taken back, S is removed) the card
       opens again with a note that the answer did not arrive, and can be answered again.
     - "relayed": S started a worker for P's @; its reply on the worker's report is in S's own chat (the original)
       and the app relays a copy into P's chat (callInFollowUp, the copy names the original). An answer on the copy
       is the user's message to P, the bot of the chat it was given in, who carries the work on (505457a0); the
       original shows it, S is not woken. An answer on the original goes to S in its own chat; the copy shows it.
   Either way an answer is handed to exactly one bot at most once, and is never lost unseen: it reaches that bot, or
   the card says it did not.

   S's turns: its own (a message in its own chat, or an answer there) and its call-ins in P's chat. Messages for S
   wait in its queue behind the turn under way; when a turn ends, the queue's head begins (Bot.groupTurn's `next()`).
   A turn handed to P is the end of the answer's way here (the Turns model covers a bot's queue). An answer counts
   as handed to S when its turn begins or it is read into the one under way (`woke`), not when it is queued.

   Before this model's second fix, an answer on a guest line always went as a call-in, which waited for S to be free
   and gave up with a notice ("Did not answer this time") if S was at work (GROUP_TIMING.busyNamed, 5 min in the app,
   0 in the adapter); the card showed it as chosen from the start (Bug "giveup").

   Action names match spec/reference/relayed-card.ts and the driver (spec/driver/relayed-card-driver.ts). The
   reference is the instance Steers = FALSE: the adapter runs bots without an agent, so nothing is steered there. *)
EXTENDS Naturals, Sequences

CONSTANTS
  MaxCards,   \* cards S asks in one behaviour
  MaxTries,   \* answers given on one card (again only after one did not arrive): bounds the state space
  Steers,     \* an answer for S at work may be read into its own turn under way (claude, codex), not only queued
  Bug         \* "none"; "callee": before 505457a0, an answer on a relayed copy went to S as a call-in in P's chat
              \* (the bot that asked, not the bot of the chat); "open": an answer on the copy leaves the original open
              \* (no settleRelayedOriginal); "keepcopy": removing S leaves its relayed copies open in P's chat
              \* (removeBot settled only the main bot's copies); "ignoregone": that, and ignoring such a copy is refused
              \* (the app looked its original up in a bot that is gone; before 3a2d13fa); "giveup": an answer on a
              \* guest line is always a call-in that gives up when S is at work, and the card shows it at once

ASSUME MaxCards \in Nat /\ MaxTries \in Nat /\ Steers \in BOOLEAN
ASSUME Bug \in {"none", "callee", "open", "keepcopy", "ignoregone", "giveup"}

Kinds == {"guest", "relayed"}
\* "pending": answered, the answer on its way to S; "none": the card has no line there (a guest card in S's chat)
Lines == {"open", "pending", "settled", "none"}
Card == 1..MaxCards

VARIABLES
  kind,     \* Seq(Kinds): the cards S asked, in order
  line,     \* Seq([P: Lines, S: Lines]): each card's line in P's chat and in S's own chat
  at,       \* Seq({"none", "P", "S"}): the chat where the user's answer was accepted
  answers,  \* Seq(Nat): answers accepted on the card
  woke,     \* Seq([P: Nat, S: Nat]): turns handed to each bot with the card's answer
  told,     \* Seq(BOOLEAN): the answer's call-in gave up, with a notice in P's chat (Bug "giveup", "callee")
  fails,    \* Seq(Nat): answers that never reached S (taken back, S removed)
  noted,    \* Seq(BOOLEAN): the guest line says its last answer did not arrive
  shows,    \* Seq(BOOLEAN): the guest line shows the user's answer as chosen
  s,        \* S: "idle", "own" (a turn of its own), "guest" (a call-in in P's chat)
  queue,    \* Seq(Card): S's messages waiting behind its turn, the answers they carry
  calls,    \* Seq(Card): call-ins in P's chat waiting for S (Bug "giveup", "callee")
  gone,     \* S was removed
  refused   \* an ignore the app refused

vars == <<kind, line, at, answers, woke, told, fails, noted, shows, s, queue, calls, gone, refused>>

TypeOK ==
  /\ kind \in Seq(Kinds) /\ Len(kind) <= MaxCards
  /\ DOMAIN line = DOMAIN kind /\ \A k \in DOMAIN line : line[k] \in [P : Lines, S : Lines]
  /\ DOMAIN at = DOMAIN kind /\ \A k \in DOMAIN at : at[k] \in {"none", "P", "S"}
  /\ DOMAIN answers = DOMAIN kind /\ \A k \in DOMAIN answers : answers[k] \in Nat
  /\ DOMAIN woke = DOMAIN kind /\ \A k \in DOMAIN woke : woke[k] \in [P : Nat, S : Nat]
  /\ DOMAIN told = DOMAIN kind /\ \A k \in DOMAIN told : told[k] \in BOOLEAN
  /\ DOMAIN fails = DOMAIN kind /\ \A k \in DOMAIN fails : fails[k] \in Nat
  /\ DOMAIN noted = DOMAIN kind /\ \A k \in DOMAIN noted : noted[k] \in BOOLEAN
  /\ DOMAIN shows = DOMAIN kind /\ \A k \in DOMAIN shows : shows[k] \in BOOLEAN
  /\ s \in {"idle", "own", "guest"} /\ queue \in Seq(Card) /\ calls \in Seq(Card)
  /\ gone \in BOOLEAN /\ refused \in BOOLEAN

Init ==
  /\ kind = <<>> /\ line = <<>> /\ at = <<>> /\ answers = <<>> /\ woke = <<>> /\ told = <<>>
  /\ fails = <<>> /\ noted = <<>> /\ shows = <<>>
  /\ s = "idle" /\ queue = <<>> /\ calls = <<>> /\ gone = FALSE /\ refused = FALSE

-----------------------------------------------------------------------------

Quiet == s = "idle" /\ queue = <<>> /\ calls = <<>>

(* S asks: P called it in, both idle (the call-in, the worker and the hand-backs to P run to their end here). *)
Ask(kd) ==
  /\ ~gone /\ Quiet /\ Len(kind) < MaxCards
  /\ kind' = Append(kind, kd)
  /\ line' = Append(line, [P |-> "open", S |-> IF kd = "relayed" THEN "open" ELSE "none"])
  /\ at' = Append(at, "none") /\ answers' = Append(answers, 0) /\ woke' = Append(woke, [P |-> 0, S |-> 0])
  /\ told' = Append(told, FALSE) /\ fails' = Append(fails, 0) /\ noted' = Append(noted, FALSE)
  /\ shows' = Append(shows, FALSE)
  /\ UNCHANGED <<s, queue, calls, gone, refused>>

Wake(k, b) == woke' = [woke EXCEPT ![k][b] = @ + 1]

(* Before the fix (Bug "giveup", "callee"): the answer is a call-in for S in P's chat (answerCallIn): it runs now,
   waits behind the one under way, or finds S busy with its own turn and gives up with a notice. *)
OldCallIn(k) ==
  /\ CASE s = "idle" -> s' = "guest" /\ Wake(k, "S") /\ UNCHANGED <<calls, told>>
       [] s = "guest" -> calls' = Append(calls, k) /\ UNCHANGED <<s, woke, told>>
       [] s = "own" -> told' = [told EXCEPT ![k] = TRUE] /\ UNCHANGED <<s, woke, calls>>
  /\ UNCHANGED queue

(* A message for S in its own chat carrying card k's answer: a turn now; at work, read into its own turn under way
   (when Steers) or queued behind it. *)
ToS(k) ==
  \/ s = "idle" /\ s' = "own" /\ Wake(k, "S") /\ UNCHANGED queue
  \/ s = "own" /\ Steers /\ Wake(k, "S") /\ UNCHANGED <<s, queue>>
  \/ s # "idle" /\ queue' = Append(queue, k) /\ UNCHANGED <<s, woke>>

Settle(k, c) == [line EXCEPT ![k][c] = "settled"]
Accept(k, c) == at' = [at EXCEPT ![k] = c] /\ answers' = [answers EXCEPT ![k] = @ + 1]

(* The user answers card k on its guest line in P's chat, S still there (answerGuestLine): free, a call-in that
   begins now; at work, its own chat. Shown as chosen once S has it, queued until then. *)
GuestAnswer(k) ==
  /\ Accept(k, "P") /\ noted' = [noted EXCEPT ![k] = FALSE]
  /\ IF s = "idle" /\ calls = <<>>
     THEN s' = "guest" /\ Wake(k, "S") /\ line' = Settle(k, "P") /\ shows' = [shows EXCEPT ![k] = TRUE]
          /\ UNCHANGED queue
     ELSE /\ ToS(k)
          /\ IF woke'[k].S > woke[k].S
             THEN line' = Settle(k, "P") /\ shows' = [shows EXCEPT ![k] = TRUE]
             ELSE line' = [line EXCEPT ![k].P = "pending"] /\ UNCHANGED shows
  /\ UNCHANGED <<calls, told, fails>>

Old == Bug \in {"giveup", "callee"}

(* The user answers card k on its line in chat c (a pick, words, or a question group's picks). *)
Answer(k, c) ==
  /\ k \in DOMAIN kind /\ line[k][c] = "open" /\ (c = "S" => ~gone) /\ answers[k] < MaxTries
  /\ CASE c = "S" ->
            \* The original, in S's chat: S's own question; the copy in P's chat shows the answer.
            /\ line' = [Settle(k, "S") EXCEPT ![k].P = "settled"] /\ Accept(k, "S") /\ ToS(k)
            /\ UNCHANGED <<calls, told, fails, noted, shows>>
       [] kind[k] = "relayed" /\ Bug # "callee" ->
            \* The copy, in P's chat: the user's message to P; the original shows it (unless S is gone).
            /\ line' = IF Bug = "open" \/ gone THEN Settle(k, "P") ELSE [Settle(k, "P") EXCEPT ![k].S = "settled"]
            /\ Accept(k, "P") /\ Wake(k, "P")
            /\ UNCHANGED <<s, queue, calls, told, fails, noted, shows>>
       [] gone ->
            \* A guest's line (or, with bug "callee", a copy) of a removed bot: no longer needed, nothing accepted.
            /\ line' = Settle(k, "P")
            /\ UNCHANGED <<at, answers, woke, s, queue, calls, told, fails, noted, shows>>
       [] Old ->
            \* Before the fix: back to S as a call-in, shown as chosen at once.
            /\ line' = IF kind[k] = "relayed" THEN [Settle(k, "P") EXCEPT ![k].S = "settled"] ELSE Settle(k, "P")
            /\ shows' = [shows EXCEPT ![k] = kind[k] = "guest"]
            /\ Accept(k, "P") /\ OldCallIn(k) /\ UNCHANGED <<fails, noted>>
       [] OTHER -> GuestAnswer(k)
  /\ UNCHANGED <<kind, gone, refused>>

(* The user ignores card k on its line in chat c: the original is ignored and its copies follow; a guest line on its
   own. Wakes nobody. *)
Ignore(k, c) ==
  /\ k \in DOMAIN kind /\ line[k][c] = "open" /\ (c = "S" => ~gone)
  /\ IF kind[k] = "relayed" /\ c = "P" /\ gone /\ Bug = "ignoregone"
     THEN refused' = TRUE /\ UNCHANGED line
     ELSE /\ line' = IF kind[k] = "relayed" /\ ~gone THEN [Settle(k, "P") EXCEPT ![k].S = "settled"] ELSE Settle(k, c)
          /\ UNCHANGED refused
  /\ UNCHANGED <<kind, at, answers, woke, told, fails, noted, shows, s, queue, calls, gone>>

(* A user line in S's own chat: a turn of its own. *)
Work ==
  /\ ~gone /\ Quiet /\ s' = "own"
  /\ UNCHANGED <<kind, line, at, answers, woke, told, fails, noted, shows, queue, calls, gone, refused>>

(* An answer that never reached S: a guest line opens again and says so. *)
Failed(k) ==
  /\ fails' = [fails EXCEPT ![k] = @ + 1]
  /\ IF kind[k] = "guest"
     THEN line' = [line EXCEPT ![k].P = "open"] /\ noted' = [noted EXCEPT ![k] = TRUE]
     ELSE UNCHANGED <<line, noted>>

(* The user takes back the i-th message waiting in S's queue, one carrying a guest line's answer. *)
Drop(i) ==
  /\ i \in DOMAIN queue /\ kind[queue[i]] = "guest"
  /\ Failed(queue[i])
  /\ queue' = SubSeq(queue, 1, i - 1) \o SubSeq(queue, i + 1, Len(queue))
  /\ UNCHANGED <<kind, at, answers, woke, told, shows, s, calls, gone, refused>>

(* S's turn ends. The head of its queue begins (with a guest line's answer, the line shows it chosen); call-ins
   waiting then find it busy and give up. Without one, the next call-in in P's chat begins. *)
EndTurn ==
  /\ s # "idle"
  /\ IF queue # <<>>
     THEN LET k == Head(queue) IN
          /\ s' = "own" /\ queue' = Tail(queue) /\ Wake(k, "S")
          /\ IF kind[k] = "guest"
             THEN line' = Settle(k, "P") /\ shows' = [shows EXCEPT ![k] = TRUE]
             ELSE UNCHANGED <<line, shows>>
          /\ told' = [j \in DOMAIN told |-> told[j] \/ \E i \in DOMAIN calls : calls[i] = j]
          /\ calls' = <<>>
     ELSE IF calls # <<>>
     THEN /\ s' = "guest" /\ Wake(Head(calls), "S") /\ calls' = Tail(calls)
          /\ UNCHANGED <<queue, told, line, shows>>
     ELSE s' = "idle" /\ UNCHANGED <<queue, calls, woke, told, line, shows>>
  /\ UNCHANGED <<kind, at, answers, fails, noted, gone, refused>>

(* S is removed (not during a call-in in P's chat). Its turn stops and its queue is dropped: the answers waiting
   there never reach it, a guest line opens again and says so. Its chat goes; its cards relayed into P's chat can no
   longer be answered there: they are settled ("No longer needed", removeBot). Its guest lines stay; an answer on
   one finds it gone. *)
KeepsCopies == Bug \in {"keepcopy", "ignoregone"}
Remove ==
  /\ ~gone /\ s # "guest" /\ calls = <<>> /\ gone' = TRUE /\ s' = "idle" /\ queue' = <<>>
  /\ fails' = [k \in DOMAIN fails |-> fails[k] + Len(SelectSeq(queue, LAMBDA j : j = k))]
  /\ noted' = [k \in DOMAIN noted |-> noted[k] \/ (kind[k] = "guest" /\ \E i \in DOMAIN queue : queue[i] = k)]
  /\ line' = [k \in DOMAIN line |->
                IF kind[k] = "guest" /\ \E i \in DOMAIN queue : queue[i] = k THEN [line[k] EXCEPT !.P = "open"]
                ELSE IF kind[k] = "relayed" /\ line[k].P = "open" /\ ~KeepsCopies THEN [line[k] EXCEPT !.P = "settled"]
                ELSE line[k]]
  /\ UNCHANGED <<kind, at, answers, woke, told, shows, calls, refused>>

Next ==
  \/ \E kd \in Kinds : Ask(kd)
  \/ \E k \in Card, c \in {"P", "S"} : Answer(k, c) \/ Ignore(k, c)
  \/ \E i \in 1..MaxCards : Drop(i)
  \/ Work \/ EndTurn \/ Remove

(* S's turns end. *)
Fairness == WF_vars(EndTurn)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* The bot an answer on card k is for: the bot that asked a guest line; on a relayed card, the bot of the chat where
   it was given. *)
For(k) == IF kind[k] = "guest" THEN "S" ELSE at[k]
Waiting(k) == Len(SelectSeq(queue, LAMBDA j : j = k)) + Len(SelectSeq(calls, LAMBDA j : j = k))

(* A card (the original and its copy) is answered at most once, again only after the last answer did not arrive. *)
AnsweredOnce == \A k \in DOMAIN kind : answers[k] <= 1 + fails[k]
(* An answer reaches a bot at most once. *)
DeliveredOnce == \A k \in DOMAIN kind : woke[k].P + woke[k].S <= 1
(* No answer is lost unseen: each one accepted has reached a bot, waits for S, was told as not heard, or did not
   arrive (and the card says so). *)
Accounted == \A k \in DOMAIN kind :
  answers[k] = woke[k].P + woke[k].S + Waiting(k) + (IF told[k] THEN 1 ELSE 0) + fails[k]
(* ... and the bot it reached is the one it is for: on a relayed card, the bot of the chat it was given in. *)
WakesItsBot == \A k \in DOMAIN kind : \A b \in {"P", "S"} : woke[k][b] > 0 => b = For(k)
(* A guest line shows the user's answer as chosen exactly when S has it. *)
ChosenIsDelivered == \A k \in DOMAIN kind : kind[k] = "guest" => (shows[k] <=> woke[k].S = 1)
(* A guest line is queued exactly while its answer waits for S. *)
PendingIsQueued == \A k \in DOMAIN kind : (line[k].P = "pending") <=> (kind[k] = "guest" /\ Waiting(k) = 1)
(* The original and its copy show the same: both open, or both settled (while S's chat is there). *)
BothShowIt == \A k \in DOMAIN kind : kind[k] = "relayed" /\ ~gone => line[k].P = line[k].S
(* An answer still standing (not one that did not arrive) leaves its line answered where it was given. *)
AnsweredIsSettled == \A k \in DOMAIN kind : answers[k] > fails[k] => line[k][at[k]] \in {"pending", "settled"}
(* Every open line can be ignored. *)
IgnoreNeverRefused == ~refused
(* A card of a removed bot is not left open as a copy in another chat. *)
NoCopyOfGone == gone => \A k \in DOMAIN kind : kind[k] = "relayed" => line[k].P # "open"
(* Call-ins wait only behind one under way; messages only behind a turn. *)
CallsWait == calls # <<>> => s = "guest"
QueueWaits == queue # <<>> => s # "idle"

(* An answer that did not arrive opens its guest line again, with the note. *)
FailReopens == [][\A k \in DOMAIN kind :
  fails'[k] > fails[k] /\ kind[k] = "guest" => line'[k].P = "open" /\ noted'[k]]_vars

(* Liveness *)

(* Every answer waiting for S stops waiting: it reaches S, or the card says it did not (Accounted). *)
AnswerReaches == \A k \in Card : (k \in DOMAIN kind /\ Waiting(k) > 0) ~> (k \in DOMAIN kind /\ Waiting(k) = 0)
=============================================================================
