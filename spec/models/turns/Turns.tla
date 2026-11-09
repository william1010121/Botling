-------------------------------- MODULE Turns --------------------------------
(* A bot's turn schedule (desktop/src/core/bot.ts): every wake-up comes in through `route` / `routeTurn` -- your    *)
(* message, a routine, a worker's report, a call-in, the continue note, a follow-up -- and becomes a turn now, joins  *)
(* the turn under way, or waits. What waits: the queue (`queue`), a message to both heads kept for the lead          *)
(* (`claimHold`), the queue held for this head's own work before a restart it owes (`settingsHold`), everything      *)
(* while the core is swapped (`swapHold`), a sent turn set aside while claude answers something else first          *)
(* (`deferred`), work paused for your message (`paused`, carried on with the resume note), an idle bot's tidy        *)
(* before it sleeps (`tidying`). Your message joins the turn under way: claude's steering (a line on its stdin,      *)
(* priority "now"), pausing work you did not start, or Antigravity's insert (the line rides on its next tool         *)
(* result). Esc twice stops the turn under way (`stop`, then `draining` until claude ends it, else its tree ends).  *)
(* Its working folder can move (a plugin's `sessions.folder`, spec/models/folders): the restart it then owes waits   *)
(* for its own work (subagents, background tasks, workers whose reports are still to come).                         *)
(*                                                                                                                  *)
(* The head is part of the model: claude reads its stdin in order; it begins the next line when it has no turn      *)
(* (`command_lifecycle` "started"), or reads one into the turn under way ("started" or not, then "completed",       *)
(* before that turn's result: 3353d2d9); a turn ends with its result, then the "completed" of the line it began     *)
(* with. Its own news (a subagent or worker that finished) gets a turn it starts itself.                            *)
(*                                                                                                                  *)
(* The protocol: a message is read by the head at most once, and is read unless taken back or stopped; what waits   *)
(* is sent in the end and every turn ends; a stopped message never becomes a turn; work paused for you is never     *)
(* your turn; after a move nothing is sent to the process still in the old folder (a tidy before sleep aside).      *)
(*                                                                                                                  *)
(* Bug = "silentsteer": steeredStarted took the "started" of your line read into a turn that had shown nothing yet  *)
(* for a turn of its own, and set the turn under way aside: one of your lines that claude began after its turn       *)
(* ended came back after the result, and its "completed" had come already (TurnEnds violated).                       *)
(* Bug = "apphold": a routine, report or call-in follow-up went to the old process while its own work ran, and so   *)
(* did the resume note (StaleSend violated). Bug = "steerold": your line was steered into the old process after a   *)
(* move (StaleSend). Bug = "reportgate": an Antigravity report waited for an empty queue, and the queue waited for   *)
(* that report (HoldEnds violated). Bug = "gracesend": see Grace. Bug = "drainnext": see DoNext (TurnEnds).          *)
(* Bug = "tidysteer": your line joined the head's own report turn while it tidied, and the process then ended with   *)
(* it unread (EveryMessageRead violated).                                                                            *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  Users,      \* lines typed by the user (a call-in's relay counts: origin "user")
  Apps,       \* the app's own wake-ups: a routine, a worker's report, the continue note, a follow-up (origin "app")
  Conducted,  \* the app wake-ups that are handed-over work (paused for you, then resumed)
  Engine,     \* "claude" (steers, pauses) or "agy" (inserts; its reports wait for the app)
  MaxMoves, MaxWork, MaxSwaps,
  Bug

Msgs == Users \cup Apps
R == "resume"   \* the resume note's line
T == "tidy"     \* the tidy's line
Lines == Msgs \cup {R, T}
NoLine == "none"
Kinds == {"user", "app", "bg", "tidy"}

\* `cid`: the line whose "completed" ends it while set aside (its userId: your line steered into it, from then on).
Turn(l, k, c, cond) == [line |-> l, cid |-> l, kind |-> k, carries |-> c, unread |-> {}, shown |-> FALSE, conducted |-> cond, sent |-> FALSE, open |-> TRUE]
NoTurn == [line |-> NoLine, cid |-> NoLine, kind |-> "bg", carries |-> {}, unread |-> {}, shown |-> FALSE, conducted |-> FALSE, sent |-> FALSE, open |-> FALSE]
Kind(l) == IF l \in Users THEN "user" ELSE "app"
\* The turn that carries line l (the resume note carries the work it resumes).
LTurn(l) == Turn(l, Kind(l), {l} \cap Msgs, l \in Conducted \/ l = R)

VARIABLE s
vars == <<s>>

Init == s = [
  fresh |-> Msgs, claim |-> NoLine, queue |-> <<>>, offered |-> {},
  turn |-> NoTurn, deferred |-> NoTurn, loose |-> {}, ignore |-> 0, draining |-> FALSE,
  paused |-> FALSE, hold |-> FALSE, swap |-> FALSE, swaps |-> 0, tidying |-> FALSE, gate |-> FALSE,
  folder |-> 0, moves |-> 0, awake |-> FALSE, headAt |-> -1, pending |-> FALSE,
  work |-> FALSE, works |-> 0, rep |-> FALSE,
  inbox |-> <<>>, cturn |-> FALSE, cline |-> NoLine,
  read |-> [m \in Msgs |-> 0], stopped |-> {}, stale |-> FALSE]

Has(t) == t.open
\* Its own work: what a restart or sleep would end -- subagents, background tasks, workers whose news is still to be
\* told, and your lines steered into a turn that ended before claude read them (claude still owes them a turn).
OwnWork(x) == x.work \/ x.rep \/ x.loose # {}
Steered(x) == x.loose \cup x.turn.unread
InQueue(x, m) == \E i \in 1..Len(x.queue) : x.queue[i] = m
Remove(q, m) == SelectSeq(q, LAMBDA e : e # m)

-----------------------------------------------------------------------------
\* The app (bot.ts). Each operator is a function of the whole state, so that bot.ts's call chains compose.

\* A turn must wait for this head's own work before the restart it owes (deliver / routeTurn: holdForSettings).
\* The folder: every turn waits; with Bug = "apphold" only yours do.
Holds(x, k) == x.awake /\ x.pending /\ OwnWork(x) /\ (k = "user" \/ Bug # "apphold")
\* A held line waits (releaseSettingsHold's `waiting`).
Waiting(x) == \E i \in 1..Len(x.queue) : Kind(x.queue[i]) = "user" \/ Bug # "apphold"
ReleaseOK(x) == ~(Waiting(x) /\ x.pending /\ x.awake /\ OwnWork(x))

\* The head's process ends (restart, Esc's tree kill, sleep): what it had read and its own work go with it (onExit).
Gone(x) == [x EXCEPT !.awake = FALSE, !.headAt = -1, !.pending = FALSE, !.inbox = <<>>, !.cturn = FALSE, !.cline = NoLine,
                     !.loose = {}, !.ignore = 0, !.paused = FALSE, !.work = FALSE, !.rep = FALSE, !.offered = {}, !.gate = FALSE]

\* The line of the turn under way goes to the head (deliver's send). A line sent to a process not in the current
\* folder is stale (a tidy aside: the bot sleeps after it, and wakes where the core answers then).
SendLine(x, l) == [x EXCEPT !.inbox = Append(x.inbox, l), !.turn.sent = TRUE,
                            !.stale = x.stale \/ (l # T /\ x.headAt # x.folder)]

\* deliver(turn, given): the hold re-check, the restart owed (with no own work), the wake, the send.
Deliver(x, given) ==
  IF ~given /\ Holds(x, x.turn.kind)
  THEN [x EXCEPT !.turn = NoTurn, !.queue = <<x.turn.line>> \o x.queue, !.hold = TRUE]
  ELSE LET x1 == IF ~given /\ x.awake /\ x.pending /\ ~OwnWork(x)
                 THEN [Gone(x) EXCEPT !.awake = TRUE, !.headAt = x.folder, !.turn = x.turn, !.deferred = x.deferred]
                 ELSE x
           x2 == IF ~x1.awake THEN [x1 EXCEPT !.awake = TRUE, !.headAt = x1.folder, !.pending = FALSE] ELSE x1
       IN SendLine(x2, x2.turn.line)

\* begin(turn, given): it is the turn under way; deliver waits while a stopped turn drains.
Begin(x, t, given) ==
  LET x1 == [x EXCEPT !.turn = t] IN
  IF x.draining THEN x1 ELSE Deliver(x1, given)

\* next(): the deferred turn, the paused work (resumePaused), the hold, the queue; else idle.
Resume(x) ==
  LET x1 == [x EXCEPT !.paused = FALSE] IN
  Begin(x1, LTurn(R), Bug = "apphold")

AfterDeferred(x) ==
  IF x.swap THEN x
  ELSE IF x.paused /\ x.awake THEN Resume(x)
  ELSE LET x1 == [x EXCEPT !.paused = FALSE] IN
       IF x1.hold /\ ~ReleaseOK(x1) THEN x1
       ELSE LET x2 == [x1 EXCEPT !.hold = FALSE] IN
            IF x2.queue = <<>> THEN x2
            ELSE LET m == Head(x2.queue)
                     x3 == [x2 EXCEPT !.queue = Tail(x2.queue), !.offered = x2.offered \ {m}]
                 IN Begin(x3, LTurn(m), FALSE)

\* Nothing goes while a stopped turn drains: stop goes on (next) once claude ended it. With Bug = "drainnext" the turn
\* set aside came back meanwhile (a swap called off, own work done): it took the stopped turn's tail for its own.
DoNext(x) ==
  IF Has(x.turn) \/ x.tidying \/ (x.draining /\ Bug # "drainnext") THEN x
  ELSE LET d == x.deferred IN
    IF Has(d) /\ x.awake THEN [x EXCEPT !.deferred = NoTurn, !.turn = d]
    ELSE LET x1 == IF d.sent /\ ~d.open /\ d.line # NoLine /\ x.awake
                   THEN [x EXCEPT !.deferred = NoTurn, !.ignore = x.ignore + 1]
                   ELSE [x EXCEPT !.deferred = NoTurn]
         IN AfterDeferred(x1)

\* checkSettingsHold: the held line goes once its own work is done.
CheckHold(x) ==
  IF ~x.hold \/ ~ReleaseOK(x) THEN x
  ELSE LET x1 == [x EXCEPT !.hold = FALSE] IN
       IF ~Has(x1.turn) /\ ~x1.tidying THEN DoNext(x1) ELSE x1

\* The turn under way ends (finishTurn): your lines steered into it and not read yet stay with the head.
Finish(x) ==
  LET t == x.turn
      x1 == [x EXCEPT !.turn = NoTurn, !.loose = x.loose \cup t.unread, !.gate = FALSE]
  IN IF t.kind = "tidy" THEN x1 ELSE DoNext(x1)

-----------------------------------------------------------------------------
\* routeTurn and its ways of joining the turn under way.

CanPause(x, m) ==
  /\ Engine = "claude" /\ Kind(m) = "user" /\ x.turn.kind \notin {"user", "tidy"} /\ ~x.paused
  /\ x.turn.sent /\ x.queue = <<>> /\ ~x.draining /\ x.ignore = 0 /\ ~x.gate

CanSteer(x, m) ==
  /\ Engine = "claude" /\ Kind(m) = "user" /\ x.turn.kind # "tidy" /\ ~x.turn.conducted /\ x.turn.sent
  /\ ~x.draining /\ x.ignore = 0 /\ x.queue = <<>> /\ (x.turn.kind = "user" \/ ~x.gate)

CanOffer(x, m) ==
  /\ Engine = "agy" /\ Kind(m) = "user" /\ x.turn.kind # "tidy" /\ ~x.turn.conducted /\ x.turn.sent
  /\ ~x.draining /\ x.ignore = 0 /\ (\A i \in 1..Len(x.queue) : x.queue[i] \in x.offered)
  /\ (x.turn.kind = "user" \/ ~x.gate)

\* steerInto: the line goes on claude's stdin (priority "now"); the turn is yours from now on (joinTurn).
Steer(x, m) ==
  [x EXCEPT !.inbox = Append(x.inbox, m), !.turn.kind = "user", !.turn.conducted = FALSE, !.turn.cid = m,
            !.turn.unread = x.turn.unread \cup {m}, !.stale = x.stale \/ x.headAt # x.folder]

Pause(x, m) == [Steer(x, m) EXCEPT !.paused = TRUE]

\* offerInsert: queued ("Queued") until Antigravity reads it with a tool result.
Offer(x, m) == [x EXCEPT !.queue = Append(x.queue, m), !.offered = x.offered \cup {m}, !.stale = x.stale \/ x.headAt # x.folder]

Enq(x, m) == [x EXCEPT !.queue = Append(x.queue, m)]

Route(x, m) ==
  LET k == Kind(m) IN
  IF x.swap THEN Enq(x, m)
  ELSE IF x.hold THEN CheckHold(Enq(x, m))
  ELSE IF ~Has(x.turn) /\ ~x.tidying /\ Holds(x, k) THEN [x EXCEPT !.queue = <<m>> \o x.queue, !.hold = TRUE]
  ELSE IF ~Has(x.turn) /\ ~x.tidying THEN Begin(x, LTurn(m), FALSE)
  \* While it tidies before sleep, nothing joins a turn of the head's own (a report): its process is about to end.
  ELSE IF ~Has(x.turn) \/ (x.tidying /\ Bug # "tidysteer") THEN Enq(x, m)
  \* A restart owed belongs to a new turn, never to steering the old process (as for a model change).
  ELSE IF x.pending /\ Bug # "steerold" THEN Enq(x, m)
  ELSE IF CanPause(x, m) THEN Pause(x, m)
  ELSE IF CanSteer(x, m) THEN Steer(x, m)
  ELSE IF CanOffer(x, m) THEN Offer(x, m)
  ELSE Enq(x, m)

-----------------------------------------------------------------------------
\* The head's events, with what bot.ts does on each.

\* claude says it began line l ("started"); `mid`: its turn under way had not ended (no result since it began one), so
\* l was read into that turn. One of your steered lines: steeredStarted. Only a "started" with no turn under way is a
\* turn of its own (with Bug = "silentsteer" the app guessed from what the turn under way had shown).
SteeredStarted(x, l, mid) ==
  LET w == x.turn
      x0 == [x EXCEPT !.loose = x.loose \ {l}, !.turn.unread = x.turn.unread \ {l}]
  IN
  IF x.draining \/ x.ignore > 0 THEN x0
  ELSE IF mid /\ Bug # "silentsteer" THEN x0
  ELSE IF Has(w) /\ (~w.sent \/ w.shown \/ Has(x.deferred)) THEN x0
  ELSE [x0 EXCEPT !.deferred = IF Has(w) THEN x0.turn ELSE x0.deferred,
                  !.turn = [Turn(l, "user", {l}, FALSE) EXCEPT !.sent = TRUE]]

Started(x, l, mid) == IF l \in Steered(x) THEN SteeredStarted(x, l, mid) ELSE x

\* claude is done with line l ("completed"): commandEnded. A deferred turn it took into the turn under way ends.
Completed(x, l) ==
  LET x0 == [x EXCEPT !.loose = x.loose \ {l}, !.turn.unread = x.turn.unread \ {l}] IN
  IF Has(x0.deferred) /\ x0.deferred.cid = l THEN [x0 EXCEPT !.deferred = NoTurn] ELSE x0

\* A stopped turn has drained: the turn begun meanwhile is delivered (deliver's wait), then stop goes on (next).
DrainEnd(x) == DoNext(IF Has(x.turn) /\ ~x.turn.sent THEN Deliver(x, FALSE) ELSE x)

\* claude's result: the tail of a cut-off turn (ignore), the end of a stopped one (draining: the turn waiting to be
\* sent goes now), or the end of the turn under way.
Result(x) ==
  IF x.ignore > 0 THEN [x EXCEPT !.ignore = x.ignore - 1]
  ELSE IF x.draining THEN DrainEnd([x EXCEPT !.draining = FALSE])
  ELSE IF Has(x.turn) /\ x.turn.sent THEN Finish(x)
  ELSE x

Read(x, l) == IF l \in Msgs THEN [x EXCEPT !.read[l] = x.read[l] + 1] ELSE x

\* claude begins the next line on its stdin as a turn of its own.
CBegin ==
  /\ s.awake /\ ~s.cturn /\ s.inbox # <<>>
  /\ LET l == Head(s.inbox)
         x == Read([s EXCEPT !.inbox = Tail(s.inbox), !.cturn = TRUE, !.cline = l], l)
     IN s' = Started(x, l, FALSE)

\* claude reads the next line into the turn under way (an Antigravity prompt cannot), saying "started" or not.
CRead(said) ==
  /\ Engine = "claude" /\ s.awake /\ s.cturn /\ s.inbox # <<>>
  /\ LET l == Head(s.inbox)
         x == Read([s EXCEPT !.inbox = Tail(s.inbox)], l)
     IN s' = Completed(IF said THEN Started(x, l, TRUE) ELSE x, l)

\* The turn under way shows its first words or step.
CShow ==
  /\ s.awake /\ s.cturn /\ Has(s.turn) /\ s.turn.sent /\ ~s.turn.shown /\ ~s.draining /\ s.ignore = 0
  /\ s' = [s EXCEPT !.turn.shown = TRUE]

\* claude's turn ends: its result, then the "completed" of the line it began with. Antigravity drops its offers.
CEnd ==
  /\ s.awake /\ s.cturn
  /\ LET x == [s EXCEPT !.cturn = FALSE, !.cline = NoLine, !.offered = {}]
     IN s' = IF s.cline = NoLine THEN Result(x) ELSE Completed(Result(x), s.cline)

\* Antigravity reads your offered line with a tool result: it joins that turn (insertDelivered).
AgyInsert(m) ==
  /\ Engine = "agy" /\ s.awake /\ s.cturn /\ m \in s.offered /\ InQueue(s, m) /\ Has(s.turn) /\ s.turn.sent
  /\ s' = Read([s EXCEPT !.queue = Remove(s.queue, m), !.offered = s.offered \ {m}, !.turn.kind = "user",
                         !.turn.carries = s.turn.carries \cup {m}], m)

\* Its own work's news (a subagent or worker that finished) gets a turn the head starts itself. Antigravity starts
\* a report only when the app lets it (canStartReport): no turn, nothing stopping, nothing queued but a held line.
CanReport(x) ==
  Engine # "agy" \/ (~Has(x.turn) /\ ~x.draining /\ (x.queue = <<>> \/ (x.hold /\ Bug # "reportgate")))

CReport ==
  /\ s.awake /\ s.rep /\ ~s.cturn /\ s.inbox = <<>> /\ CanReport(s)
  /\ LET x == [s EXCEPT !.rep = FALSE, !.cturn = TRUE, !.cline = NoLine] IN
     s' = IF ~Has(x.turn) /\ x.ignore = 0 THEN [x EXCEPT !.turn = [Turn(NoLine, "bg", {}, FALSE) EXCEPT !.sent = TRUE]] ELSE x

\* Its own work starts in a turn, and ends; its news is then still to be told.
StartWork ==
  /\ Has(s.turn) /\ s.turn.sent /\ s.awake /\ ~s.work /\ s.works < MaxWork
  /\ s' = [s EXCEPT !.work = TRUE, !.works = s.works + 1]

EndWork ==
  /\ s.work
  /\ s' = CheckHold([s EXCEPT !.work = FALSE, !.rep = TRUE])

\* An approval opens, or a foreground subagent works, in the turn under way; and it is answered.
GateOn == Has(s.turn) /\ s.turn.sent /\ ~s.gate /\ s' = [s EXCEPT !.gate = TRUE]
GateOff == s.gate /\ s' = [s EXCEPT !.gate = FALSE]

-----------------------------------------------------------------------------
\* The world.

Arrive(m) == m \in s.fresh /\ s' = Route([s EXCEPT !.fresh = s.fresh \ {m}], m)

\* A message to both heads: this head waits for what the lead takes on (claimHold), then gets it.
Claim(m) == m \in s.fresh /\ Kind(m) = "user" /\ s.claim = NoLine /\ s' = [s EXCEPT !.fresh = s.fresh \ {m}, !.claim = m]
ReleaseClaim == s.claim # NoLine /\ s' = Route([s EXCEPT !.claim = NoLine], s.claim)

\* Esc twice: the turn under way is closed (the lines it carries are stopped) and claude is interrupted. Your lines
\* steered into it that claude has not read yet are on its stdin still: it answers them in a turn of their own.
Stop ==
  /\ Has(s.turn) /\ s.turn.kind # "tidy"
  /\ LET t == s.turn
         x == [s EXCEPT !.paused = FALSE, !.stopped = s.stopped \cup t.carries, !.turn = NoTurn,
                        !.loose = s.loose \cup t.unread, !.gate = FALSE]
     IN s' = IF t.sent /\ s.awake THEN [x EXCEPT !.draining = TRUE] ELSE DoNext(x)

\* ... a line waiting is taken back; the turn set aside; the line kept for the lead.
StopQueued(m) ==
  /\ InQueue(s, m)
  /\ s' = CheckHold([s EXCEPT !.queue = Remove(s.queue, m), !.offered = s.offered \ {m}, !.stopped = s.stopped \cup {m}])
StopDeferred ==
  /\ Has(s.deferred)
  /\ s' = [s EXCEPT !.deferred.open = FALSE, !.stopped = s.stopped \cup s.deferred.carries]
StopClaim ==
  /\ s.claim # NoLine
  /\ s' = [s EXCEPT !.claim = NoLine, !.stopped = s.stopped \cup {s.claim}]

\* claude did not end the stopped turn in time: its whole tree is ended, then what waited goes. claude answers an
\* interrupt with a result whenever it has a turn to end (or a line to begin); it stays silent only with nothing.
\* With Bug = "gracesend" the wait was let go before the tree was ended: the turn begun meanwhile went to the process
\* being ended and failed with it, never read (EveryMessageRead violated).
Grace ==
  /\ s.draining /\ ~s.cturn /\ s.inbox = <<>>
  /\ LET x0 == [s EXCEPT !.draining = FALSE]
         x1 == IF Bug = "gracesend" /\ Has(x0.turn) /\ ~x0.turn.sent THEN Deliver(x0, FALSE) ELSE x0
         x2 == [Gone(x1) EXCEPT !.deferred = NoTurn, !.turn = IF x1.turn.sent THEN NoTurn ELSE x1.turn]
     IN s' = DrainEnd(x2)

\* The working folder moves: an awake head owes a restart before its next line (restartFor).
Move ==
  /\ s.moves < MaxMoves
  /\ s' = [s EXCEPT !.folder = s.folder + 1, !.moves = s.moves + 1, !.pending = s.awake]

\* The core is to be swapped; or the swap is called off (holdForSwap).
SwapOn == ~s.swap /\ s.swaps < MaxSwaps /\ s' = [s EXCEPT !.swap = TRUE, !.swaps = s.swaps + 1]
SwapOff == s.swap /\ s' = DoNext([s EXCEPT !.swap = FALSE])

\* The 15 s look at a held line (checkSettingsHold's timer), when it would let it go.
ReleaseHold == s.hold /\ ReleaseOK(s) /\ s' = CheckHold(s)

\* Idle with nothing of its own at work: it tidies (an app turn on its own head), then its process ends.
Tidy ==
  /\ s.awake /\ ~Has(s.turn) /\ s.queue = <<>> /\ ~s.tidying /\ ~OwnWork(s) /\ ~s.draining /\ ~s.hold /\ ~s.swap
  /\ s' = Begin([s EXCEPT !.tidying = TRUE], Turn(T, "tidy", {}, FALSE), TRUE)

\* The tidy did not end in time: its result belongs to nobody.
TidyLate ==
  /\ s.tidying /\ Has(s.turn) /\ s.turn.kind = "tidy"
  /\ s' = [s EXCEPT !.turn = NoTurn, !.ignore = s.ignore + 1]

Sleep ==
  /\ s.tidying /\ ~Has(s.turn)
  /\ s' = DoNext([Gone(s) EXCEPT !.tidying = FALSE, !.deferred = NoTurn, !.draining = FALSE])

-----------------------------------------------------------------------------

Next ==
  \/ \E m \in Msgs : Arrive(m) \/ Claim(m) \/ StopQueued(m) \/ AgyInsert(m)
  \/ ReleaseClaim \/ Stop \/ StopDeferred \/ StopClaim \/ Grace
  \/ CBegin \/ \E said \in BOOLEAN : CRead(said)
  \/ CShow \/ CEnd \/ CReport
  \/ StartWork \/ EndWork \/ GateOn \/ GateOff
  \/ Move \/ SwapOn \/ SwapOff \/ ReleaseHold \/ Tidy \/ TidyLate \/ Sleep

\* The head goes on (it begins what waits on its stdin, ends its turns, starts its reports), own work ends,
\* approvals are answered, the lead says what it takes on, a swap is done or called off, a held line is looked at,
\* a stopped turn's tree is ended in time, the tidy ends or runs late and the process exits.
\* Nobody has to type, stop anything, move a folder, or let Antigravity read an offered line.
Fairness ==
  /\ WF_vars(CBegin) /\ WF_vars(CEnd) /\ WF_vars(CReport)
  /\ WF_vars(EndWork) /\ WF_vars(GateOff) /\ WF_vars(ReleaseClaim) /\ WF_vars(SwapOff)
  /\ WF_vars(ReleaseHold) /\ WF_vars(Grace) /\ WF_vars(TidyLate) /\ WF_vars(Sleep)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* Safety.

TypeOK ==
  /\ s.fresh \subseteq Msgs /\ s.claim \in Msgs \cup {NoLine} /\ s.offered \subseteq Msgs
  /\ \A i \in 1..Len(s.queue) : s.queue[i] \in Msgs \cup {R}
  /\ s.turn.kind \in Kinds /\ s.turn.carries \subseteq Msgs /\ s.turn.unread \subseteq Msgs
  /\ s.loose \subseteq Msgs /\ s.ignore \in 0..3 /\ s.folder \in 0..MaxMoves /\ s.headAt \in -1..MaxMoves
  /\ \A i \in 1..Len(s.inbox) : s.inbox[i] \in Lines /\ s.cline \in Lines \cup {NoLine}
  /\ s.read \in [Msgs -> 0..3] /\ s.stopped \subseteq Msgs

\* A message is read by the head at most once.
ReadOnce == \A m \in Msgs : s.read[m] <= 1

\* After a move nothing is sent to the process still in the old folder (no turn, no steered line, no insert).
StaleSend == ~s.stale

\* Work paused for you is never your turn: your turn carries no handed-over work (it goes on in an app turn of its
\* own, the resume note's, once you were answered).
PausedNotYours == (Has(s.turn) /\ s.turn.kind = "user") => ~s.turn.conducted

\* A queue waits only behind something: a turn, a hold, a swap, the tidy, a stopped turn draining.
QueueWaits == s.queue # <<>> => (Has(s.turn) \/ s.hold \/ s.swap \/ s.tidying \/ s.draining)

\* A turn is set aside only behind another (or a stopped one still draining).
DeferredBehind == Has(s.deferred) => (Has(s.turn) \/ s.draining)

\* A stopped message never becomes a turn.
StoppedNeverStarts == [][\A m \in s.stopped : (m \in s'.turn.carries /\ Has(s'.turn)) => (m \in s.turn.carries /\ Has(s.turn))]_vars

-----------------------------------------------------------------------------
\* Liveness.

\* Every turn ends.
TurnEnds == Has(s.turn) ~> ~Has(s.turn)

\* What waits is sent in the end, and the hold lets go.
QueueDrains == s.queue # <<>> ~> s.queue = <<>>
HoldEnds == s.hold ~> ~s.hold

\* A message that came in is read, unless it was stopped (or taken back).
EveryMessageRead == \A m \in Msgs : (m \notin s.fresh) ~> (s.read[m] >= 1 \/ m \in s.stopped)
=============================================================================
