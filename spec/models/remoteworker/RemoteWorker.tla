---------------------------- MODULE RemoteWorker ----------------------------
(* A Claude worker that runs on another machine (multi-machine phase 1; design: .bot/artifacts/multi-machine-design.html,
   seams desktop/src/core/agent/head.ts, claude-workers.ts, process/tree.ts, worker-core/events.ts). Not built yet:
   this model is the protocol the app and `botling-agent` must keep. Phase 1: Claude workers only; a lost connection
   marks the worker interrupted and it resumes later (`claude --resume` on the machine); every tool request of a
   remote worker is a card the user answers by hand.

   The machine is reached one of two ways, with the same guarantees (nothing below the pairing depends on which):
     - "ssh": a host from ~/.ssh/config. Botling runs the system ssh and talks to `botling-agent` over its stdio.
       Trust is the host key: Botling never accepts a new key by itself, the user does (Pair, then Approve).
       A missing or older agent is uploaded over ssh (Upgrade).
     - "relay": `botling-agent` on the machine dials out to the relay (relay.driseam.com, end-to-end encrypted as
       for the phone, docs/mobile-relay.md), so the machine needs no public address and no Tailscale. First time:
       a one-line install there prints a URL and a short code (Pair); the user approves the code in Botling
       (Approve) or lets it expire (Expire). An older agent replaces itself with the app's version (Upgrade).
     Either way the user can revoke the machine (Revoke): its connection ends at once and nothing more is taken
     from it or sent to it until it is approved again.

   A connection (one ssh process, or one relay session) is numbered `gen`; every frame belongs to one. Frames on one
   connection are delivered in order; a connection may end at any time (Drop, Revoke) and then only a prefix of what
   was sent to the agent still arrives there. Frames of an older connection may still reach the agent after a new
   connection began (a relay queue, an old ssh process): the agent and the app act only on the connection they are on.
     app -> agent:  hello, attach(from), start(app version), answer(request), cancel
     agent -> app:  hi(agent version), ev(seq), attached, refused(request)

   The agent (with ssh, a new agent process per connection; with the relay, one daemon) keeps the session's state on
   the machine's disk: the event log (`log`, every WorkerEvent with its sequence number 1, 2, ...), the session lock
   (`alive`: the claude processes running the session) and the tool requests (`req`). Handshake: `hello` -> `hi`
   with the agent's version; the app goes on only with its own version (else Upgrade and connect again). Then:
     - a new worker: `start`; the agent starts claude and streams the log as it grows;
     - a worker that was interrupted (or cancelled while away): `attach(from)` with the last sequence number the chat
       shows. The agent takes the session lock (stops any claude still running it), sends the events after `from`,
       then `attached`, and streams from there. Only then does the app send `start` (claude --resume).
   The chat shows event n only right after n - 1: anything else is a duplicate (dropped) or a gap (never happens).
   A tool request is an event `ask(k)` (k: claude's tool_use_id, the same when a resumed run asks again); its card
   opens. The user's answer is sent only while the run that asked is the one the app is attached to; else it is
   refused at once and the card stays open, saying so. The agent applies an answer only from the connection it is on,
   to a request still pending in a running claude, and logs `ans(k)` (the card settles when that event is shown);
   else it answers `refused(k)` and the card opens again. A card whose answer was in flight when the connection ended
   waits: the replay after `attach` shows `ans(k)` if the answer applied before the lock was taken, else, at
   `attached`, the card opens again with a note, to be answered when the resumed run asks again.
   The agent notices a lost connection (Notice) and, in phase 1, stops the claude it runs.

   Action names match spec/reference/remote-worker.ts.
   Bug = "nolock": attach and start do not take the session lock: a resumed claude runs beside the old one
     (OneProc fails).
   Bug = "stale": the agent applies an answer from any connection: the answer given before a disconnect lands on the
     resumed run's request while its card is open again (OpenNotApplied fails).
   Bug = "nogen": the app acts on `refused` frames of older connections (an old ssh process's output read late):
     a card whose answer applied opens again (OpenNotApplied fails).
   Bug = "revoke": revoking leaves the live connection up (RevokeEnds fails). *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Paths,      \* ways to reach the machine: a subset of {"ssh", "relay"}
  MaxConns,   \* connections in one behaviour (also bounds the claude processes: one start per connection)
  MaxReqs,    \* tool requests (k = 1..MaxReqs)
  MaxOut,     \* plain output events in one behaviour
  MaxTries,   \* answers the user gives on one card
  MaxPairs,   \* approvals of the machine in one behaviour
  Bug         \* "none", "nolock", "stale", "nogen" or "revoke"

ASSUME Paths \subseteq {"ssh", "relay"} /\ Paths # {}
ASSUME MaxConns \in Nat /\ MaxReqs \in Nat /\ MaxOut \in Nat /\ MaxTries \in Nat /\ MaxPairs \in Nat
ASSUME Bug \in {"none", "nolock", "stale", "nogen", "revoke"}

Gens == 1..MaxConns
Req == 1..MaxReqs
Runs == 1..MaxConns
M(t, n) == [t |-> t, n |-> n]
E(t, k) == [t |-> t, k |-> k]

VARIABLES
  \* the machine, as Botling's settings hold it
  via,      \* "none" or the path it was set up with
  trust,    \* "none", "asked" (host key shown / device code live), "trusted", "revoked"
  epoch,    \* the credential: each approval and each revoke makes a new one
  pairs,    \* approvals so far
  appv,     \* the app's version: 1, 2 after an update
  \* the agent and the session's state on the machine
  agv,      \* the agent's version there (0: not installed)
  aseen,    \* the newest connection the agent has seen
  agen,     \* the connection the agent is on (0: none; it noticed the last one end)
  astream,  \* that connection asked for the stream (attach or start)
  alive,    \* claude processes running the session (run numbers)
  runs,     \* claude processes started
  log,      \* the session's event log: Seq([t, k])
  req,      \* each tool request: "none", "pending", "applied"
  reqBy,    \* the run that asked it last
  applied,  \* answers applied to it (ghost)
  oldRun,   \* a claude was started by an app of another version than the agent's (ghost)
  \* the wire
  down,     \* each connection: frames on their way to the agent
  up,       \* each connection: frames on their way to the app
  \* the app
  gen,      \* its connection (0: none yet)
  conn,     \* "down", "hello", "upgrade", "attach", "up"
  cepoch,   \* the credential its connection was opened with
  w,        \* the worker: "none", "running", "interrupted", "cancelling", "done", "cancelled"
  sweep,    \* cancelled while away: the app still attaches once (fetch the tail, take the lock)
  got,      \* events the chat shows (the last sequence number)
  gap,      \* an event arrived beyond the next one (ghost)
  card,     \* each request's card: "none", "open", "sent", "settled", "closed"
  live,     \* the run the app is attached to has asked it
  noted,    \* the card says its last answer did not apply
  tries     \* answers the user gave on it

machine == <<via, trust, epoch, pairs, appv>>
agent == <<agv, aseen, agen, astream, alive, runs, log, req, reqBy, applied, oldRun>>
cards == <<card, live, noted, tries>>
vars == <<machine, agent, down, up, gen, conn, cepoch, w, sweep, got, gap, cards>>

TypeOK ==
  /\ via \in {"none"} \cup Paths /\ trust \in {"none", "asked", "trusted", "revoked"}
  /\ epoch \in Nat /\ pairs \in 0..MaxPairs /\ appv \in {1, 2}
  /\ agv \in {0, 1, 2} /\ aseen \in 0..MaxConns /\ agen \in 0..MaxConns /\ astream \in BOOLEAN
  /\ alive \subseteq Runs /\ runs \in 0..MaxConns
  /\ log \in Seq([t : {"out", "ask", "ans", "done", "cancelled"}, k : 0..MaxReqs])
  /\ req \in [Req -> {"none", "pending", "applied"}] /\ reqBy \in [Req -> 0..MaxConns]
  /\ applied \in [Req -> Nat] /\ oldRun \in BOOLEAN
  /\ down \in [Gens -> Seq([t : {"hello", "attach", "start", "answer", "cancel"}, n : Nat])]
  /\ up \in [Gens -> Seq([t : {"hi", "ev", "attached", "refused"}, n : Nat])]
  /\ gen \in 0..MaxConns /\ conn \in {"down", "hello", "upgrade", "attach", "up"} /\ cepoch \in Nat
  /\ w \in {"none", "running", "interrupted", "cancelling", "done", "cancelled"} /\ sweep \in BOOLEAN
  /\ got \in Nat /\ gap \in BOOLEAN
  /\ card \in [Req -> {"none", "open", "sent", "settled", "closed"}] /\ live \in [Req -> BOOLEAN]
  /\ noted \in [Req -> BOOLEAN] /\ tries \in [Req -> 0..MaxTries]

Init ==
  /\ via = "none" /\ trust = "none" /\ epoch = 0 /\ pairs = 0 /\ appv = 1
  /\ agv = 0 /\ aseen = 0 /\ agen = 0 /\ astream = FALSE /\ alive = {} /\ runs = 0 /\ log = <<>>
  /\ req = [k \in Req |-> "none"] /\ reqBy = [k \in Req |-> 0] /\ applied = [k \in Req |-> 0] /\ oldRun = FALSE
  /\ down = [g \in Gens |-> <<>>] /\ up = [g \in Gens |-> <<>>]
  /\ gen = 0 /\ conn = "down" /\ cepoch = 0 /\ w = "none" /\ sweep = FALSE /\ got = 0 /\ gap = FALSE
  /\ card = [k \in Req |-> "none"] /\ live = [k \in Req |-> FALSE] /\ noted = [k \in Req |-> FALSE]
  /\ tries = [k \in Req |-> 0]

-----------------------------------------------------------------------------
(* The machine: pairing, approval, revocation, the app's own update. *)

(* ssh: the user picks a host and Botling shows its host key; relay: the install line prints a URL and a code. *)
Pair(p) ==
  /\ trust \in {"none", "revoked"} /\ pairs < MaxPairs
  /\ via' = p /\ trust' = "asked"
  /\ UNCHANGED <<epoch, pairs, appv, agent, down, up, gen, conn, cepoch, w, sweep, got, gap, cards>>

(* The user accepts the host key / approves the code: a new credential. *)
Approve ==
  /\ trust = "asked" /\ trust' = "trusted" /\ epoch' = epoch + 1 /\ pairs' = pairs + 1
  /\ UNCHANGED <<via, appv, agent, down, up, gen, conn, cepoch, w, sweep, got, gap, cards>>

(* The user declines (a host key they do not know, a code they did not ask for). *)
Decline ==
  /\ trust = "asked" /\ trust' = "none"
  /\ UNCHANGED <<via, epoch, pairs, appv, agent, down, up, gen, conn, cepoch, w, sweep, got, gap, cards>>

(* A device code's time runs out. *)
Expire ==
  /\ trust = "asked" /\ via = "relay" /\ trust' = "none"
  /\ UNCHANGED <<via, epoch, pairs, appv, agent, down, up, gen, conn, cepoch, w, sweep, got, gap, cards>>

Close(c) == [k \in Req |-> IF c[k] \in {"open", "sent"} THEN "closed" ELSE c[k]]
Unlive == [k \in Req |-> FALSE]

(* The app's connection ends; the first i frames on their way to the agent still arrive there. *)
Cut(i) ==
  /\ conn' = "down" /\ down' = [down EXCEPT ![gen] = SubSeq(@, 1, i)]
  /\ w' = CASE w = "running" -> "interrupted" [] w = "cancelling" -> "cancelled" [] OTHER -> w
  /\ sweep' = (sweep \/ w = "cancelling")
  /\ card' = IF w = "cancelling" THEN Close(card) ELSE card
  /\ live' = Unlive

(* The user revokes the machine: its credential is void and its connection ends (Bug "revoke": stays up). *)
Revoke ==
  /\ trust = "trusted" /\ trust' = "revoked" /\ epoch' = epoch + 1
  /\ IF conn # "down" /\ Bug # "revoke"
     THEN \E i \in 0..Len(down[gen]) : Cut(i)
     ELSE UNCHANGED <<conn, down, w, sweep, card, live>>
  /\ UNCHANGED <<via, pairs, appv, agent, up, gen, cepoch, got, gap, noted, tries>>

(* Botling updates itself (it restarts, so it is not connected): the agent there is now older. *)
AppUpdate ==
  /\ appv = 1 /\ conn = "down" /\ appv' = 2
  /\ UNCHANGED <<via, trust, epoch, pairs, agent, down, up, gen, conn, cepoch, w, sweep, got, gap, cards>>

-----------------------------------------------------------------------------
(* The app's side of a connection. *)

(* Connect to a trusted machine: ssh to the host, or open a relay session to its agent. *)
Connect ==
  /\ trust = "trusted" /\ conn = "down" /\ gen < MaxConns
  /\ gen' = gen + 1 /\ conn' = "hello" /\ cepoch' = epoch
  /\ down' = [down EXCEPT ![gen + 1] = <<M("hello", 0)>>]
  /\ UNCHANGED <<machine, agent, up, w, sweep, got, gap, cards>>

(* The agent there is not the app's version: ssh uploads the app's agent; over the relay the agent replaces itself
   with the app's version. Either way the connection ends and the app connects again. *)
Upgrade ==
  /\ conn = "upgrade" /\ agv' = appv /\ conn' = "down"
  /\ UNCHANGED <<machine, aseen, agen, astream, alive, runs, log, req, reqBy, applied, oldRun, down, up, gen, cepoch,
                 w, sweep, got, gap, cards>>

(* The user hands the remote machine a new worker. *)
Start ==
  /\ conn = "up" /\ w = "none" /\ w' = "running"
  /\ down' = [down EXCEPT ![gen] = Append(@, M("start", appv))]
  /\ UNCHANGED <<machine, agent, up, gen, conn, cepoch, sweep, got, gap, cards>>

(* The user answers card k: sent when the run that asked is the one the app is attached to, else refused at once
   (the card stays open and says so). *)
Answer(k) ==
  /\ card[k] = "open" /\ tries[k] < MaxTries /\ tries' = [tries EXCEPT ![k] = @ + 1]
  /\ IF conn = "up" /\ w = "running" /\ live[k]
     THEN /\ card' = [card EXCEPT ![k] = "sent"] /\ noted' = [noted EXCEPT ![k] = FALSE]
          /\ down' = [down EXCEPT ![gen] = Append(@, M("answer", k))]
     ELSE /\ noted' = [noted EXCEPT ![k] = TRUE] /\ UNCHANGED <<card, down>>
  /\ UNCHANGED <<machine, agent, up, gen, conn, cepoch, w, sweep, got, gap, live>>

(* The user cancels the worker: connected, the agent stops claude and logs it; away, it is cancelled here at once
   (claude there stops when the agent notices, or at the next attach) and the app attaches once more. *)
Cancel ==
  /\ w \in {"running", "interrupted"}
  /\ IF w = "running"
     THEN /\ w' = "cancelling" /\ down' = [down EXCEPT ![gen] = Append(@, M("cancel", 0))]
          /\ UNCHANGED <<sweep, card, live>>
     ELSE /\ w' = "cancelled" /\ sweep' = TRUE /\ card' = Close(card) /\ live' = Unlive /\ UNCHANGED down
  /\ UNCHANGED <<machine, agent, up, gen, conn, cepoch, got, gap, noted, tries>>

(* The connection ends (network, sleep, the relay, the ssh process); the first i frames to the agent still arrive. *)
Drop ==
  /\ conn # "down" /\ \E i \in 0..Len(down[gen]) : Cut(i)
  /\ UNCHANGED <<machine, agent, up, gen, cepoch, got, gap, noted, tries>>

(* The app shows event e (the next one in sequence). *)
Show(e) ==
  CASE e.t = "ask" -> /\ card' = [card EXCEPT ![e.k] = IF @ = "none" THEN "open" ELSE @]
                      /\ live' = [live EXCEPT ![e.k] = TRUE] /\ UNCHANGED w
    [] e.t = "ans" -> /\ card' = [card EXCEPT ![e.k] = "settled"] /\ live' = [live EXCEPT ![e.k] = FALSE]
                      /\ UNCHANGED w
    [] e.t = "done" -> w' = (IF w = "cancelled" THEN w ELSE "done") /\ card' = Close(card) /\ live' = Unlive
    [] e.t = "cancelled" -> w' = "cancelled" /\ card' = Close(card) /\ live' = Unlive
    [] OTHER -> UNCHANGED <<w, card, live>>

(* The app reads only its own live connection (Bug "nogen": also `refused` frames of older ones). *)
Reads(g) ==
  \/ g = gen /\ conn # "down"
  \/ Bug = "nogen" /\ Head(up[g]).t = "refused"

(* The app takes the next frame from the agent on connection g. *)
AppRecv(g) ==
  /\ up[g] # <<>> /\ Reads(g)
  /\ up' = [up EXCEPT ![g] = Tail(@)]
  /\ LET m == Head(up[g]) IN
     CASE m.t = "hi" /\ conn = "hello" ->
            /\ IF m.n # appv THEN conn' = "upgrade" /\ UNCHANGED down
               ELSE IF w = "interrupted" \/ sweep
               THEN conn' = "attach" /\ down' = [down EXCEPT ![g] = Append(@, M("attach", got))]
               ELSE conn' = "up" /\ UNCHANGED down
            /\ UNCHANGED <<w, sweep, got, gap, cards>>
       [] m.t = "ev" /\ m.n = got + 1 ->
            /\ got' = m.n /\ Show(log[m.n])
            /\ UNCHANGED <<down, conn, sweep, gap, noted, tries>>
       [] m.t = "ev" /\ m.n # got + 1 ->
            \* a duplicate (n <= got) is dropped; a gap is never accepted
            /\ gap' = (gap \/ m.n > got + 1)
            /\ UNCHANGED <<down, conn, w, sweep, got, cards>>
       [] m.t = "attached" /\ conn = "attach" ->
            \* the replay is done: an answer still in flight did not apply; the card opens again and says so
            /\ conn' = "up" /\ sweep' = FALSE
            /\ card' = [k \in Req |-> IF card[k] = "sent" THEN "open" ELSE card[k]]
            /\ noted' = [k \in Req |-> noted[k] \/ card[k] = "sent"]
            /\ IF w = "interrupted"
               THEN w' = "running" /\ down' = [down EXCEPT ![g] = Append(@, M("start", appv))]
               ELSE UNCHANGED <<w, down>>
            /\ UNCHANGED <<got, gap, live, tries>>
       [] m.t = "refused" ->
            /\ card' = [card EXCEPT ![m.n] = IF @ = "sent" THEN "open" ELSE @]
            /\ noted' = [noted EXCEPT ![m.n] = @ \/ card[m.n] = "sent"]
            /\ UNCHANGED <<down, conn, w, sweep, got, gap, live, tries>>
       [] OTHER -> UNCHANGED <<down, conn, w, sweep, got, gap, cards>>
  /\ UNCHANGED <<machine, agent, gen, cepoch>>

-----------------------------------------------------------------------------
(* The agent and claude on the machine. *)

Send(g, m) == [up EXCEPT ![g] = Append(@, m)]
(* An event goes into the session's log, and onto the connection the agent is on once it asked for the stream. *)
Log(e) ==
  /\ log' = Append(log, e)
  /\ up' = IF agen # 0 /\ astream THEN Send(agen, M("ev", Len(log) + 1)) ELSE up
Ended == \E i \in DOMAIN log : log[i].t \in {"done", "cancelled"}
Asking(r) == \E k \in Req : req[k] = "pending" /\ reqBy[k] = r
Outs == Len(SelectSeq(log, LAMBDA e : e.t = "out"))
(* The session lock: a claude it starts stops any other running the session (Bug "nolock": not). *)
Locked(new) == IF Bug = "nolock" THEN alive \cup new ELSE new

(* An answer from connection g applies: the agent is on g (Bug "stale": any), a running claude waits for it. *)
Applies(g, k) == (g = agen \/ Bug = "stale") /\ req[k] = "pending" /\ reqBy[k] \in alive

(* The agent takes the next frame on connection g. *)
AgentRecv(g) ==
  /\ down[g] # <<>>
  /\ down' = [down EXCEPT ![g] = Tail(@)]
  /\ LET m == Head(down[g]) IN
     CASE m.t = "hello" /\ g > aseen ->
            /\ aseen' = g /\ agen' = g /\ astream' = FALSE /\ up' = Send(g, M("hi", agv))
            /\ UNCHANGED <<alive, runs, log, req, reqBy, applied, oldRun>>
       [] m.t = "attach" /\ g = agen ->
            /\ alive' = Locked({}) /\ astream' = TRUE
            /\ up' = [up EXCEPT ![g] = @ \o [i \in 1..(Len(log) - m.n) |-> M("ev", m.n + i)] \o <<M("attached", 0)>>]
            /\ UNCHANGED <<aseen, agen, runs, log, req, reqBy, applied, oldRun>>
       [] m.t = "start" /\ g = agen ->
            /\ runs' = runs + 1 /\ alive' = Locked({runs + 1}) /\ astream' = TRUE /\ oldRun' = (oldRun \/ m.n # agv)
            /\ UNCHANGED <<aseen, agen, up, log, req, reqBy, applied>>
       [] m.t = "answer" /\ Applies(g, m.n) ->
            /\ req' = [req EXCEPT ![m.n] = "applied"] /\ applied' = [applied EXCEPT ![m.n] = @ + 1]
            /\ Log(E("ans", m.n))
            /\ UNCHANGED <<aseen, agen, astream, alive, runs, reqBy, oldRun>>
       [] m.t = "answer" /\ ~Applies(g, m.n) ->
            \* not from the connection it is on, or no running claude waits for it
            /\ up' = Send(g, M("refused", m.n))
            /\ UNCHANGED <<aseen, agen, astream, alive, runs, log, req, reqBy, applied, oldRun>>
       [] m.t = "cancel" /\ g = agen ->
            /\ alive' = {}
            /\ IF Ended THEN UNCHANGED <<log, up>> ELSE Log(E("cancelled", 0))
            /\ UNCHANGED <<aseen, agen, astream, runs, req, reqBy, applied, oldRun>>
       [] OTHER ->
            \* a frame of a connection the agent is not on: dropped
            UNCHANGED <<aseen, agen, astream, up, alive, runs, log, req, reqBy, applied, oldRun>>
  /\ UNCHANGED <<machine, agv, gen, conn, cepoch, w, sweep, got, gap, cards>>

(* Claude run r writes output. *)
Out(r) ==
  /\ r \in alive /\ Outs < MaxOut /\ Log(E("out", 0))
  /\ UNCHANGED <<machine, agv, aseen, agen, astream, alive, runs, req, reqBy, applied, oldRun, down,
                 gen, conn, cepoch, w, sweep, got, gap, cards>>

(* Claude run r asks to use a tool (again, after a resume, if the run that asked first is gone). *)
Ask(r, k) ==
  /\ r \in alive /\ (req[k] = "none" \/ (req[k] = "pending" /\ reqBy[k] \notin alive))
  /\ req' = [req EXCEPT ![k] = "pending"] /\ reqBy' = [reqBy EXCEPT ![k] = r] /\ Log(E("ask", k))
  /\ UNCHANGED <<machine, agv, aseen, agen, astream, alive, runs, applied, oldRun, down,
                 gen, conn, cepoch, w, sweep, got, gap, cards>>

(* Claude run r finishes its work (its report is the last event). *)
Finish(r) ==
  /\ r \in alive /\ ~Asking(r) /\ ~Ended /\ alive' = alive \ {r} /\ Log(E("done", 0))
  /\ UNCHANGED <<machine, agv, aseen, agen, astream, runs, req, reqBy, applied, oldRun, down,
                 gen, conn, cepoch, w, sweep, got, gap, cards>>

(* The agent notices its connection ended (stdin closed, relay session gone) and stops claude (phase 1). *)
Notice ==
  /\ agen # 0 /\ (conn = "down" \/ gen # agen)
  /\ agen' = 0 /\ astream' = FALSE /\ alive' = {}
  /\ UNCHANGED <<machine, agv, aseen, runs, log, req, reqBy, applied, oldRun, down, up,
                 gen, conn, cepoch, w, sweep, got, gap, cards>>

-----------------------------------------------------------------------------

Next ==
  \/ \E p \in Paths : Pair(p)
  \/ Approve \/ Decline \/ Expire \/ Revoke \/ AppUpdate
  \/ Connect \/ Upgrade \/ Start \/ Cancel \/ Notice
  \/ \E k \in Req : Answer(k)
  \/ Drop
  \/ \E g \in Gens : AppRecv(g) \/ AgentRecv(g)
  \/ \E r \in Runs : Out(r) \/ Finish(r) \/ \E k \in Req : Ask(r, k)

(* The worker needs its machine: to resume, or to sweep up after a cancel while away. *)
Needed == w = "interrupted" \/ sweep

(* Frames are taken; the agent notices a lost connection; the app reconnects when the worker needs it and upgrades
   an older agent; a device code expires. The user, claude's own work and the network owe nothing. *)
Fairness ==
  /\ \A g \in Gens : WF_vars(AppRecv(g)) /\ WF_vars(AgentRecv(g))
  /\ WF_vars(Notice) /\ WF_vars(Needed /\ Connect) /\ WF_vars(Upgrade) /\ WF_vars(Expire)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

(* Never two claude processes on one session (the resume after a disconnect is where it would happen). *)
OneProc == Cardinality(alive) <= 1
(* An answer applies at most once. *)
AnsweredOnce == \A k \in Req : applied[k] <= 1
(* A card open to the user has not been answered behind its back (a stale answer never lands). *)
OpenNotApplied == \A k \in Req : card[k] = "open" => req[k] # "applied"
(* A card shows settled only when its answer applied. *)
SettledIsApplied == \A k \in Req : card[k] = "settled" => req[k] = "applied"
(* The chat shows events in sequence: never more than the log, never a gap (duplicates are dropped by number). *)
InSequence == got <= Len(log) /\ ~gap
(* Revoked means cut off: the app has no connection but one opened with the machine's current credential. *)
RevokeEnds == conn # "down" => trust = "trusted" /\ cepoch = epoch
(* Claude runs only under an agent of the app's version that started it. *)
SameVersion == ~oldRun
(* The app counts a worker as running only while it is connected and attached. *)
RunningIsUp == w \in {"running", "cancelling"} => conn = "up"

(* A card whose answer did not apply opens again with a note. *)
ReopenSaysSo == [][\A k \in Req : card[k] = "sent" /\ card'[k] = "open" => noted'[k]]_vars

(* Liveness *)

(* The machine is out of reach for good here: not trusted, or no connection left in this behaviour. *)
Blocked == trust # "trusted" \/ (conn = "down" /\ gen = MaxConns)
LogBound == MaxOut + MaxReqs * (MaxConns + 1) + 1

(* An interrupted worker resumes (or ends) once its machine can be reached. *)
Resumes == (w = "interrupted") ~> (w \in {"running", "done", "cancelled"} \/ Blocked)
(* A cancel stops claude on the machine, connected or not. *)
CancelStops == (w \in {"cancelling", "cancelled"}) ~> (alive = {})
(* Every event in the log reaches the chat once the machine can be reached. *)
EventsShown == \A n \in 1..LogBound : (Len(log) >= n) ~> (got >= n \/ Blocked)
(* A card whose answer is on its way settles or opens again. *)
CardResolves == \A k \in Req : (card[k] = "sent") ~> (card[k] # "sent" \/ Blocked)
(* A device code does not stay live. *)
CodeEnds == (trust = "asked" /\ via = "relay") ~> (trust # "asked" \/ via # "relay")
=============================================================================
