---- MODULE Callin ----
\* @ routing and call-ins between bots (desktop/src/core/conversations.ts, bot.groupTurn).
\* A user line or a bot's reply in chat c names one bot with @. The @ is routed (receiveBotMention):
\* delivered once as a call-in, covered by the same one still pending, or dropped with a notice.
\* Call-ins of one chat run one at a time (startCallIn/runCallIn): the callee waits until it is free
\* (or gives up: busy), then answers or fails (timeout). The pending list is what the chat shows.
\* A bot that asked with @ below the depth limit is handed a turn when the call-in ends, answered or not:
\* the answer, or word that it was not answered (appMessage), so it is never left waiting on it.
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Top,       \* bots with a chat others can be called into (members)
          Sub,       \* sub bots, each under a Top bot
          Parent,    \* [Sub -> Top]
          Bodies,    \* the words an @ can carry
          MaxDepth,  \* MAX_FOLLOW_DEPTH
          Cap,       \* BOT_MENTIONS_PER_USER_LINE
          MaxAts,    \* bound: @s in one behaviour
          MaxOwn,    \* bound: user lines waiting in one bot
          BUG        \* "none"; "silent": before 78bf1640; "sub": before 9d7c0bda; "nowake": a failed bot @ handed nothing back

None == "none"
Bots == Top \cup Sub
Open == {"queued", "answering"}
Done == {"answered", "unheard"}
Delivered == Open \cup Done
\* Before 78bf1640 the app dropped some @s without a word.
Silent == BUG \in {"silent", "sub"}

VARIABLES
  ev,        \* every @ routed, in order: [chat, to, by, body, depth, msg, st, told, woke]
  pending,   \* [Top -> Seq([ev, st])]: the call-ins a chat lists (Conversations.pending)
  cur,       \* [Top -> event being answered there, 0 = none]
  phase,     \* [Top -> {"idle", "wait", "turn"}]: its callee waiting to be free, or answering
  followUp,  \* [Top -> depth of the hand-back waiting for the chat bot's next reply, 0 = none]
  recent,    \* [Top -> {<<to, body>>}]: bot @s delivered since the chat's last user line
  own,       \* [Bots -> own turns running or waiting]
  guest,     \* [Bots -> answering a call-in now]
  gone       \* sub bots removed

vars == <<ev, pending, cur, phase, followUp, recent, own, guest, gone>>

Callable(c) ==
  IF c \in Top
  THEN ((Top \ {c}) \cup (IF BUG = "sub" THEN {} ELSE {s \in Sub : Parent[s] = c})) \ gone
  ELSE {}

Settle(c, k) == pending' = [pending EXCEPT ![c] = SelectSeq(@, LAMBDA p : p.ev # k)]
\* Call-in k ends as st; `wake`: the bot that asked is handed a turn on it (woke counts the hand-backs).
Mark(k, st, told, wake) == ev' = [ev EXCEPT ![k].st = st, ![k].told = told, ![k].woke = @ + (IF wake THEN 1 ELSE 0)]
\* A bot asked it, below the depth limit: its end is handed back to the chat's bot.
Asks(k) == ev[k].by = "bot" /\ ev[k].depth < MaxDepth
\* ... also when it was not answered (before: only an answer was).
FailWakes(k) == Asks(k) /\ BUG # "nowake"
HandBack(c, k, wake) ==
  IF wake THEN followUp' = [followUp EXCEPT ![c] = ev[k].depth] /\ own' = [own EXCEPT ![c] = @ + 1]
  ELSE UNCHANGED <<followUp, own>>

TypeOK ==
  /\ \A k \in DOMAIN ev : ev[k].chat \in Top /\ ev[k].to \in Bots /\ ev[k].by \in {"user", "bot"}
       /\ ev[k].body \in Bodies \cup {0} /\ ev[k].depth \in 0..MaxDepth /\ ev[k].msg \in 0..MaxAts
       /\ ev[k].st \in Delivered \cup {"unreachable", "dropped", "merged", "seen"} /\ ev[k].told \in BOOLEAN /\ ev[k].woke \in Nat
  /\ pending \in [Top -> Seq([ev : 1..MaxAts, st : Open])]
  /\ cur \in [Top -> 0..MaxAts] /\ phase \in [Top -> {"idle", "wait", "turn"}]
  /\ followUp \in [Top -> 0..MaxDepth] /\ recent \in [Top -> SUBSET (Bots \X Bodies)]
  /\ own \in [Bots -> Nat] /\ guest \in [Bots -> BOOLEAN] /\ gone \subseteq Sub

Init ==
  /\ ev = <<>> /\ pending = [c \in Top |-> <<>>] /\ cur = [c \in Top |-> 0]
  /\ phase = [c \in Top |-> "idle"] /\ followUp = [c \in Top |-> 0] /\ recent = [c \in Top |-> {}]
  /\ own = [b \in Bots |-> 0] /\ guest = [b \in Bots |-> FALSE] /\ gone = {}

\* Your line in c's chat goes to its bot; a bot it names with @ is called in (sendWith, startCallIn).
UserLine(c, t) ==
  /\ c \notin gone /\ own[c] < MaxOwn /\ t \in Callable(c) \cup {None} /\ (t # None => Len(ev) < MaxAts)
  /\ own' = [own EXCEPT ![c] = @ + 1]
  /\ recent' = [d \in Top |-> IF d = c THEN {} ELSE recent[d]]
  /\ IF t = None THEN UNCHANGED <<ev, pending>>
     ELSE /\ ev' = Append(ev, [chat |-> c, to |-> t, by |-> "user", body |-> 0, depth |-> 0, msg |-> 0, st |-> "queued", told |-> FALSE, woke |-> 0])
          /\ pending' = [pending EXCEPT ![c] = Append(@, [ev |-> Len(ev) + 1, st |-> "queued"])]
  /\ UNCHANGED <<cur, phase, followUp, guest, gone>>

\* The chat bot's reply `m` names t with body b (receiveBotMention); its follow-up depth is used up.
Route(c, t, b, m) ==
  LET d == followUp[c]
      new(st, told, depth) == [chat |-> c, to |-> t, by |-> "bot", body |-> b, depth |-> depth, msg |-> m, st |-> st, told |-> told, woke |-> 0]
      Drop(told) == ev' = Append(ev, new("dropped", told, d)) /\ UNCHANGED <<pending, recent>>
  IN /\ followUp' = [followUp EXCEPT ![c] = 0]
     /\ CASE t \notin Callable(c) -> ev' = Append(ev, new("unreachable", ~Silent, d)) /\ UNCHANGED <<pending, recent>>
          [] \E j \in DOMAIN ev : ev[j].msg = m /\ ev[j].st \in Delivered ->
               ev' = Append(ev, new("seen", FALSE, d)) /\ UNCHANGED <<pending, recent>>
          [] d >= MaxDepth -> Drop(~Silent)
          [] <<t, b>> \in recent[c] ->
               IF \E i \in 1..Len(pending[c]) : ev[pending[c][i].ev].to = t /\ ev[pending[c][i].ev].body = b
               THEN ev' = Append(ev, new("merged", FALSE, d)) /\ UNCHANGED <<pending, recent>>
               ELSE Drop(~Silent)
          [] Cardinality(recent[c]) >= Cap -> Drop(TRUE)
          [] OTHER -> /\ ev' = Append(ev, new("queued", FALSE, d + 1))
                      /\ recent' = [recent EXCEPT ![c] = @ \cup {<<t, b>>}]
                      /\ pending' = [pending EXCEPT ![c] = Append(@, [ev |-> Len(ev) + 1, st |-> "queued"])]

\* c's bot ends an own turn with a reply that names t (or nobody).
BotReply(c, t, b) ==
  /\ c \in Top /\ own[c] > 0 /\ ~guest[c]
  /\ t \in (Bots \ (gone \cup {c})) \cup {None}
  /\ own' = [own EXCEPT ![c] = @ - 1]
  /\ IF t = None THEN followUp' = [followUp EXCEPT ![c] = 0] /\ UNCHANGED <<ev, pending, recent>>
     ELSE Len(ev) < MaxAts /\ Route(c, t, b, Len(ev) + 1)
  /\ UNCHANGED <<cur, phase, guest, gone>>

\* The same reply is heard again (bot-mentions.json keeps what was delivered).
Rehear(k) ==
  /\ ev[k].by = "bot" /\ ev[k].to \notin gone /\ Len(ev) < MaxAts
  /\ Route(ev[k].chat, ev[k].to, ev[k].body, ev[k].msg)
  /\ UNCHANGED <<cur, phase, own, guest, gone>>

\* An own turn ends with nothing for other bots.
OwnEnd(b) ==
  /\ own[b] > 0 /\ ~guest[b] /\ own' = [own EXCEPT ![b] = @ - 1]
  /\ UNCHANGED <<ev, pending, cur, phase, followUp, recent, guest, gone>>

\* A sub bot is removed while idle.
Remove(s) ==
  /\ s \notin gone /\ own[s] = 0 /\ ~guest[s] /\ gone' = gone \cup {s}
  /\ UNCHANGED <<ev, pending, cur, phase, followUp, recent, own, guest>>

\* c's next call-in has its turn (runCallIn); a callee that can no longer be called is told of (and a bot that asked woken).
Start(c) ==
  /\ cur[c] = 0
  /\ \E k \in DOMAIN ev :
       /\ ev[k].chat = c /\ ev[k].st = "queued"
       /\ \A j \in DOMAIN ev : (ev[j].chat = c /\ ev[j].st = "queued") => k <= j
       /\ IF ev[k].to \in Callable(c)
          THEN /\ Mark(k, "answering", FALSE, FALSE)
               /\ pending' = [pending EXCEPT ![c] = [i \in DOMAIN @ |-> IF @[i].ev = k THEN [ev |-> k, st |-> "answering"] ELSE @[i]]]
               /\ cur' = [cur EXCEPT ![c] = k] /\ phase' = [phase EXCEPT ![c] = "wait"]
               /\ UNCHANGED <<followUp, own>>
          ELSE Mark(k, "unheard", ~Silent, FailWakes(k)) /\ Settle(c, k) /\ HandBack(c, k, FailWakes(k)) /\ UNCHANGED <<cur, phase>>
  /\ UNCHANGED <<recent, guest, gone>>

Callee(c) == ev[cur[c]].to

\* bot.groupTurn: the callee is free, so its turn begins.
Take(c) ==
  /\ phase[c] = "wait" /\ own[Callee(c)] = 0 /\ ~guest[Callee(c)] /\ Callee(c) \notin gone
  /\ guest' = [guest EXCEPT ![Callee(c)] = TRUE] /\ phase' = [phase EXCEPT ![c] = "turn"]
  /\ UNCHANGED <<ev, pending, cur, followUp, recent, own, gone>>

\* The call-in being answered in c ends as st; `wake`: its asking bot is handed a turn on it.
Finish(c, st, told, wake) ==
  /\ Mark(cur[c], st, told, wake) /\ Settle(c, cur[c]) /\ HandBack(c, cur[c], wake)
  /\ cur' = [cur EXCEPT ![c] = 0] /\ phase' = [phase EXCEPT ![c] = "idle"]

\* bot.groupTurn: still busy (or gone) after waitForMs; a bot that asked is told so with a turn.
GiveUp(c) ==
  /\ phase[c] = "wait" /\ (own[Callee(c)] > 0 \/ guest[Callee(c)] \/ Callee(c) \in gone)
  /\ Finish(c, "unheard", TRUE, FailWakes(cur[c]))
  /\ UNCHANGED <<recent, guest, gone>>

\* Its reply is posted; a bot that asked is handed the answer once, below MaxDepth (appMessage).
Answer(c) ==
  LET k == cur[c] IN
  /\ phase[c] = "turn" /\ Finish(c, "answered", FALSE, Asks(k))
  /\ guest' = [guest EXCEPT ![Callee(c)] = FALSE]
  /\ UNCHANGED <<recent, gone>>

\* No answer within answerWithinMs, its turn failed, or (asked by a bot) it answered nothing; a bot that asked is told so with a turn.
NoAnswer(c) ==
  /\ phase[c] = "turn" /\ Finish(c, "unheard", TRUE, FailWakes(cur[c]))
  /\ guest' = [guest EXCEPT ![Callee(c)] = FALSE]
  /\ UNCHANGED <<recent, gone>>

Next ==
  \/ \E c \in Bots, t \in Bots \cup {None} : UserLine(c, t)
  \/ \E c \in Top, t \in Bots \cup {None}, b \in Bodies : BotReply(c, t, b)
  \/ \E k \in DOMAIN ev : Rehear(k)
  \/ \E b \in Bots : OwnEnd(b)
  \/ \E s \in Sub : Remove(s)
  \/ \E c \in Top : Start(c) \/ Take(c) \/ GiveUp(c) \/ Answer(c) \/ NoAnswer(c)

Fairness == \A c \in Top : WF_vars(Start(c)) /\ WF_vars(Take(c) \/ GiveUp(c)) /\ WF_vars(Answer(c) \/ NoAnswer(c))

Spec == Init /\ [][Next]_vars /\ Fairness

\* ---- Safety
\* In one chat only one called-in bot answers at a time.
OneSpeaker == \A c \in Top : Cardinality({k \in DOMAIN ev : ev[k].chat = c /\ ev[k].st = "answering"}) <= 1
\* A bot answers in at most one chat at a time, and only while its turn there runs.
OneTurnEach == \A b \in Bots : Cardinality({c \in Top : phase[c] = "turn" /\ Callee(c) = b}) = IF guest[b] THEN 1 ELSE 0
\* An @ the app does not answer always leaves a notice.
NoSilentDrop == \A k \in DOMAIN ev : ev[k].st \in {"unreachable", "dropped", "unheard"} => ev[k].told
\* A reply is delivered at most once, and a quiet repeat is covered by one delivered.
DeliveredOnce ==
  \A j, k \in DOMAIN ev :
    /\ (j # k /\ ev[j].msg # 0 /\ ev[j].msg = ev[k].msg) => ~(ev[j].st \in Delivered /\ ev[k].st \in Delivered)
    /\ (ev[k].st = "seen") => \E i \in 1..(k - 1) : ev[i].msg = ev[k].msg /\ ev[i].st \in Delivered
    /\ (ev[k].st = "merged") => \E i \in 1..(k - 1) : ev[i].st \in Delivered /\ ev[i].by = "bot"
         /\ ev[i].chat = ev[k].chat /\ ev[i].to = ev[k].to /\ ev[i].body = ev[k].body
HopBound == \A k \in DOMAIN ev : ev[k].depth <= MaxDepth
\* No wake loop: a call-in hands back at most one turn, only once it ended, only to a bot that asked below the depth
\* limit; the reply to that turn routes its @s one level deeper (Route), so a chain of wakes stops at MaxDepth.
WakeOnce == \A k \in DOMAIN ev : ev[k].woke <= 1
WakeBelowDepth == \A k \in DOMAIN ev : ev[k].woke > 0 => Asks(k) /\ ev[k].st \in Done
\* A sub bot is reachable in its parent's chat, and only there.
SubReachable == \A k \in DOMAIN ev : ev[k].st = "unreachable" => ~(ev[k].to \in Sub /\ Parent[ev[k].to] = ev[k].chat)
SubOnlyInParent == \A k \in DOMAIN ev : (ev[k].st \in Delivered /\ ev[k].to \in Sub) => Parent[ev[k].to] = ev[k].chat
CapPerUserLine == \A c \in Top : Cardinality(recent[c]) <= Cap
\* The pending list shows exactly the call-ins not answered yet, in turn order, with their state.
PendingExact ==
  \A c \in Top :
    /\ {pending[c][i].ev : i \in DOMAIN pending[c]} = {k \in DOMAIN ev : ev[k].chat = c /\ ev[k].st \in Open}
    /\ \A i \in DOMAIN pending[c] : pending[c][i].st = ev[pending[c][i].ev].st
    /\ \A i, j \in DOMAIN pending[c] : i < j => pending[c][i].ev < pending[c][j].ev

\* ---- Liveness
\* Every call-in is eventually answered, or not, with a notice.
CallInEnds == \A k \in 1..MaxAts : (k \in DOMAIN ev /\ ev[k].st \in Open) ~> (k \in DOMAIN ev /\ ev[k].st \in Done)
PendingEmpties == \A c \in Top : pending[c] # <<>> ~> pending[c] = <<>>
\* A bot's @ below the depth limit, delivered, always ends with that bot handed a turn: answered or not.
CallerHearsBack == \A k \in 1..MaxAts : (k \in DOMAIN ev /\ ev[k].st \in Delivered /\ Asks(k)) ~> (k \in DOMAIN ev /\ ev[k].woke > 0)

\* For the cfgs: the sub bot S is C's.
ParentMC == [s \in Sub |-> "C"]
====
