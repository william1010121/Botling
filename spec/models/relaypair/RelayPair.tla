------------------------------ MODULE RelayPair ------------------------------
(* Pairing and connecting a phone through the relay (desktop/src/mobile-relay/connector.ts; the phone's side   *)
(* desktop/mobile/relay-client.ts). The desktop keeps one-time offers in memory (the QR secret, a TTL, a used   *)
(* flag) and paired devices in relay-devices.json. A phone connection is a peer the relay opened; its frames  *)
(* are handled one at a time, in order (peer.inbox). One step is what the connector does between two awaits:  *)
(*   Take      a frame's turn comes (fromPhone: a closed peer's frames are dropped here); then keyPair or     *)
(*             channel.open is awaited                                                                         *)
(*   HsCheck   the handshake's check: the offer (unused, unexpired, not claimed by another open peer) or the   *)
(*             stored device, else a clear nope; the offer is claimed for this peer                            *)
(*   HsKeys    after deviceIdOf/deriveChannel: only now is peer.deviceId set; the ack goes out                 *)
(*   Confirm   the first encrypted frame: pairing holds the offer (used, but only for this peer until the     *)
(*             phone acknowledges); reconnecting looks the device up again; else the peer is ended             *)
(*   Grant     `paired` / `ready` sealed and sent (dropped when the peer was closed meanwhile); a pairing peer  *)
(*             then waits for the phone's {t:'ack'} (stage 'held')                                             *)
(*   Commit    the phone's {t:'ack'}: the device is stored and the code spent for good                         *)
(*   Timeout   no ack in time (ACK_MS): the peer is ended                                                      *)
(* Ending a peer that holds an offer (granting or held: a close, a timeout) gives the code back: it may pair    *)
(* again within its TTL, and no device was stored. A phone that got `paired` but whose ack never arrived holds *)
(* a token the desktop does not know; connecting with it is refused and it scans the code again.               *)
(*   ReqCheck, ReqSend   one request: the stored device, then (after the core and the seal) its `res`         *)
(*   Revoke    revoke(): the record leaves the store and every peer whose deviceId is this device is ended    *)
(*             (a ready one told `revoked`), in one synchronous run; RevokeDone is its pushAllow and return    *)
(* A step that resumes after an await on a peer closed meanwhile does nothing.                                 *)
(* A pairing phone makes a new key each time, so a device is named by the connection that paired it.          *)
(* The relay is FIFO per connection. A connection may drop (network, relay, the desktop's socket): what the    *)
(* desktop sends is lost; what the relay already forwarded is still handled; the desktop hears of the drop    *)
(* later (DeskClose). A kick closes the phone after what was sent before it.                                   *)
(* Bug = "old": the connector before this model. No claim at the handshake: two phones with one code both     *)
(*   pass it and the second is kicked at Confirm without a nope (PairOrNope fails); and Confirm resumes on a  *)
(*   peer closed while its frame was opened, spending the code on nobody (NoUseByClosed fails).               *)
(* Bug = "noRecheck": Confirm of a reconnecting phone does not look the device up again: a revoke between      *)
(*   HsCheck and HsKeys (peer.deviceId not set yet, so revoke's filter misses the peer) is followed by        *)
(*   `ready` (RevokeEnds fails). The connector does look again; that closes the window.                       *)
(* Bug = "noAck": pairing as it was before the phone acknowledged `paired` (and as it still is for a phone app   *)
(*   that does not announce v2): Confirm spends the code and stores the device at once, so a connection that    *)
(*   drops before `paired` arrives leaves a spent code and a phone without a token (CodeReachesPhone fails).    *)
(*   "old" has no ack either.                                                                                   *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Conns,   \* phone connections (each opens once); a pairing one also names the device it pairs
          Offers,  \* one-time pairing codes
          None,
          Bug      \* "none", "old", "noRecheck" or "noAck"

Pcs == {"idle", "new", "hs", "keys", "granting", "held", "ready", "serving", "closed"}
\* Where the desktop has set peer.deviceId (revoke's filter sees the peer).
Known == {"keys", "granting", "held", "ready", "serving"}
\* peer.stage = 'ready' (revoke tells it).
Served == {"granting", "ready", "serving"}
Up == {"hs", "conf", "got", "req"}
Down == {"ack", "nope", "paired", "ready", "res", "revoked", "bye"}
Phs == {"off", "wait", "keys", "ready", "refused", "lost"}

VARIABLES
  offer,     \* each code: "unmade", "live", "held" (a peer waits for its phone's ack) or "used"
  exp,       \* its TTL has passed
  claim,     \* the peer whose handshake took it (None: nobody)
  by,        \* the devices each code paired (ghost)
  store,     \* the devices relay-devices.json holds
  pc,        \* each connection on the desktop
  busy,      \* its first frame in `up` is being handled (Take done)
  mode,      \* "pair" or "session" (None before it opens)
  code,      \* a pairing connection's code
  dev,       \* the device a connection is for (pairing: itself)
  up, down,  \* frames in flight, phone to desktop and back
  ph,        \* the phone on that connection
  sent,      \* the phone sent its one request
  cut,       \* the connection dropped
  kicked,    \* the desktop had the relay close it
  saved,     \* the devices whose phone holds a token (it got `paired`)
  rv,        \* each device: "no", "running" (revoke started) or "done" (revoke returned)
  late,      \* devices sent `ready` or `res` after their revoke started (ghost)
  wasted     \* a code was spent on a peer already closed (ghost)

vars == <<offer, exp, claim, by, store, pc, busy, mode, code, dev, up, down, ph, sent, cut, kicked, saved, rv, late, wasted>>

TypeOK ==
  /\ offer \in [Offers -> {"unmade", "live", "held", "used"}] /\ exp \in [Offers -> BOOLEAN]
  /\ claim \in [Offers -> Conns \cup {None}] /\ by \in [Offers -> SUBSET Conns]
  /\ store \subseteq Conns /\ saved \subseteq Conns /\ late \subseteq Conns /\ wasted \in BOOLEAN
  /\ pc \in [Conns -> Pcs] /\ busy \in [Conns -> BOOLEAN] /\ mode \in [Conns -> {"pair", "session", None}]
  /\ code \in [Conns -> Offers \cup {None}] /\ dev \in [Conns -> Conns \cup {None}]
  /\ \A p \in Conns : up[p] \in Seq(Up) /\ down[p] \in Seq(Down)
  /\ ph \in [Conns -> Phs] /\ sent \in [Conns -> BOOLEAN]
  /\ cut \in [Conns -> BOOLEAN] /\ kicked \in [Conns -> BOOLEAN]
  /\ rv \in [Conns -> {"no", "running", "done"}]

Init ==
  /\ offer = [o \in Offers |-> "unmade"] /\ exp = [o \in Offers |-> FALSE]
  /\ claim = [o \in Offers |-> None] /\ by = [o \in Offers |-> {}]
  /\ store = {} /\ saved = {} /\ late = {} /\ wasted = FALSE
  /\ pc = [p \in Conns |-> "idle"] /\ busy = [p \in Conns |-> FALSE] /\ mode = [p \in Conns |-> None]
  /\ code = [p \in Conns |-> None] /\ dev = [p \in Conns |-> None]
  /\ up = [p \in Conns |-> <<>>] /\ down = [p \in Conns |-> <<>>]
  /\ ph = [p \in Conns |-> "off"] /\ sent = [p \in Conns |-> FALSE]
  /\ cut = [p \in Conns |-> FALSE] /\ kicked = [p \in Conns |-> FALSE]
  /\ rv = [p \in Conns |-> "no"]

\* The phone does not acknowledge `paired`: the code is spent at Confirm.
NoAck == Bug \in {"old", "noAck"}
\* A peer that holds its offer is closed: the offer is live again (expireOffers drops it if its TTL passed).
Back(p) == offer' = IF mode[p] = "pair" /\ pc[p] \in {"granting", "held"} /\ ~NoAck
                      THEN [offer EXCEPT ![code[p]] = "live"] ELSE offer
\* The frame being handled.
Frame(p) == IF busy[p] THEN up[p][1] ELSE None
\* The desktop sends on a connection (nothing arrives once it dropped or was kicked).
Put(p, msgs) == IF cut[p] \/ kicked[p] THEN down[p] ELSE down[p] \o msgs
\* The peer is closed on the desktop (forget): frames not yet handled are dropped; one being handled stays.
\* `msgs` (a nope or `revoked`, then "bye": the kick) go out first.
Shut(p, msgs) ==
  /\ pc' = [pc EXCEPT ![p] = "closed"]
  /\ up' = [up EXCEPT ![p] = IF busy[p] THEN <<@[1]>> ELSE <<>>]
  /\ down' = [down EXCEPT ![p] = Put(p, msgs)]
  /\ kicked' = [kicked EXCEPT ![p] = @ \/ msgs # <<>>]
\* The handler of the current frame ends the peer.
End(p, msgs) ==
  /\ pc' = [pc EXCEPT ![p] = "closed"] /\ up' = [up EXCEPT ![p] = <<>>] /\ busy' = [busy EXCEPT ![p] = FALSE]
  /\ down' = [down EXCEPT ![p] = Put(p, msgs)] /\ kicked' = [kicked EXCEPT ![p] = TRUE]
\* The frame is done with.
Done(p) == /\ up' = [up EXCEPT ![p] = Tail(@)] /\ busy' = [busy EXCEPT ![p] = FALSE]
Go(p, s) == pc' = [pc EXCEPT ![p] = s]
Send(p, msgs) == down' = [down EXCEPT ![p] = Put(p, msgs)]
\* The offer is in the connector's map and may still pair (expireOffers drops it once its TTL passed).
Open(o) == offer[o] = "live" /\ ~exp[o]
Free(o, p) == Bug = "old" \/ claim[o] \in {None, p} \/ pc[claim[o]] = "closed"
\* `ready` or `res` to a device whose revoke has started (ghost).
Late(p) == late' = IF rv[dev[p]] # "no" THEN late \cup {dev[p]} ELSE late

-----------------------------------------------------------------------------
(* The world: codes, phones, the network. *)

\* pair(): a new code (its token is in the relay's allow list until it expires).
Make(o) ==
  /\ offer[o] = "unmade" /\ offer' = [offer EXCEPT ![o] = "live"]
  /\ UNCHANGED <<exp, claim, by, store, pc, busy, mode, code, dev, up, down, ph, sent, cut, kicked, saved, rv, late, wasted>>

Expire(o) ==
  /\ offer[o] # "unmade" /\ ~exp[o] /\ exp' = [exp EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<offer, claim, by, store, pc, busy, mode, code, dev, up, down, ph, sent, cut, kicked, saved, rv, late, wasted>>

\* A phone scans a code (the relay admits its token until the TTL passes) and sends {h:'pair'}.
JoinPair(p, o) ==
  /\ pc[p] = "idle" /\ offer[o] # "unmade" /\ ~exp[o]
  /\ mode' = [mode EXCEPT ![p] = "pair"] /\ code' = [code EXCEPT ![p] = o] /\ dev' = [dev EXCEPT ![p] = p]
  /\ Go(p, "new") /\ ph' = [ph EXCEPT ![p] = "wait"] /\ up' = [up EXCEPT ![p] = <<"hs">>]
  /\ UNCHANGED <<offer, exp, claim, by, store, busy, down, sent, cut, kicked, saved, rv, late, wasted>>

\* A paired phone connects again (its saved session) and sends {h:'hello'}.
JoinSession(p, d) ==
  /\ pc[p] = "idle" /\ d \in saved /\ d # p
  /\ mode' = [mode EXCEPT ![p] = "session"] /\ dev' = [dev EXCEPT ![p] = d]
  /\ Go(p, "new") /\ ph' = [ph EXCEPT ![p] = "wait"] /\ up' = [up EXCEPT ![p] = <<"hs">>]
  /\ UNCHANGED <<offer, exp, claim, by, store, busy, code, down, sent, cut, kicked, saved, rv, late, wasted>>

\* The connection drops: nothing more reaches the phone, which, without an answer yet, has lost it.
Drop(p) ==
  /\ ph[p] \in {"wait", "keys", "ready"} /\ ~cut[p] /\ ~kicked[p]
  /\ cut' = [cut EXCEPT ![p] = TRUE] /\ down' = [down EXCEPT ![p] = <<>>]
  /\ ph' = [ph EXCEPT ![p] = IF @ = "ready" THEN @ ELSE "lost"]
  /\ UNCHANGED <<offer, exp, claim, by, store, pc, busy, mode, code, dev, up, sent, kicked, saved, rv, late, wasted>>

\* The relay's {t:'close'} reaches the desktop: the peer is forgotten.
DeskClose(p) ==
  /\ cut[p] /\ pc[p] \notin {"idle", "closed"} /\ Shut(p, <<>>) /\ Back(p)
  /\ UNCHANGED <<exp, claim, by, store, busy, mode, code, dev, ph, sent, cut, saved, rv, late, wasted>>

-----------------------------------------------------------------------------
(* The phone. *)

Recv(p) ==
  /\ down[p] # <<>>
  /\ LET m == down[p][1] IN
       /\ down' = [down EXCEPT ![p] = Tail(@)]
       /\ CASE m = "ack" /\ ph[p] = "wait" ->
                 \* Derives the channel and sends its first encrypted frame ({t:'pair'} / {t:'hello'}).
                 ph' = [ph EXCEPT ![p] = "keys"] /\ up' = [up EXCEPT ![p] = @ \o <<"conf">>] /\ UNCHANGED saved
            [] m \in {"paired", "ready"} /\ ph[p] = "keys" ->
                 \* Keeps the session, then acknowledges `paired` with {t:'ack'} (before any request).
                 /\ ph' = [ph EXCEPT ![p] = "ready"]
                 /\ saved' = IF m = "paired" THEN saved \cup {p} ELSE saved
                 /\ up' = IF m = "paired" /\ ~NoAck THEN [up EXCEPT ![p] = @ \o <<"got">>] ELSE up
            [] m \in {"nope", "revoked"} /\ ph[p] \in {"wait", "keys", "ready"} ->
                 ph' = [ph EXCEPT ![p] = "refused"] /\ UNCHANGED <<up, saved>>
            [] m = "bye" ->
                 \* The relay closes the phone's socket: without an answer, it only sees the close.
                 ph' = [ph EXCEPT ![p] = IF @ \in {"wait", "keys"} THEN "lost" ELSE @] /\ UNCHANGED <<up, saved>>
            [] OTHER -> UNCHANGED <<ph, up, saved>>
  /\ UNCHANGED <<offer, exp, claim, by, store, pc, busy, mode, code, dev, sent, cut, kicked, rv, late, wasted>>

Request(p) ==
  /\ ph[p] = "ready" /\ ~sent[p] /\ ~cut[p] /\ ~kicked[p]
  /\ sent' = [sent EXCEPT ![p] = TRUE] /\ up' = [up EXCEPT ![p] = @ \o <<"req">>]
  /\ UNCHANGED <<offer, exp, claim, by, store, pc, busy, mode, code, dev, down, ph, cut, kicked, saved, rv, late, wasted>>

-----------------------------------------------------------------------------
(* The desktop's connector, one peer. *)

Take(p) ==
  /\ pc[p] \in {"new", "keys", "held", "ready"} /\ ~busy[p] /\ up[p] # <<>>
  /\ busy' = [busy EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<offer, exp, claim, by, store, pc, mode, code, dev, up, down, ph, sent, cut, kicked, saved, rv, late, wasted>>

\* A step resuming on a peer closed meanwhile.
Gone(p) == pc[p] = "closed"

HsCheck(p) ==
  /\ Frame(p) = "hs"
  /\ CASE Gone(p) -> Done(p) /\ UNCHANGED <<pc, down, kicked, claim>>
       [] mode[p] = "pair" /\ Open(code[p]) /\ Free(code[p], p) ->
            /\ Go(p, "hs") /\ Done(p) /\ UNCHANGED <<down, kicked>>
            /\ claim' = IF Bug = "old" THEN claim ELSE [claim EXCEPT ![code[p]] = p]
       [] mode[p] = "session" /\ dev[p] \in store -> Go(p, "hs") /\ Done(p) /\ UNCHANGED <<down, kicked, claim>>
       [] OTHER -> End(p, <<"nope", "bye">>) /\ UNCHANGED claim
  /\ UNCHANGED <<offer, exp, by, store, mode, code, dev, ph, sent, cut, saved, rv, late, wasted>>

HsKeys(p) ==
  /\ pc[p] = "hs" /\ Go(p, "keys") /\ Send(p, <<"ack">>)
  /\ UNCHANGED <<offer, exp, claim, by, store, busy, mode, code, dev, up, ph, sent, cut, kicked, saved, rv, late, wasted>>

\* Pairing: the code is spent and the device stored (the old connector does this on a closed peer too).
Spend(p) ==
  /\ offer' = [offer EXCEPT ![code[p]] = "used"] /\ by' = [by EXCEPT ![code[p]] = @ \cup {p}]
  /\ store' = store \cup {p}

Confirm(p) ==
  /\ Frame(p) = "conf"
  /\ CASE Gone(p) ->
            /\ Done(p) /\ UNCHANGED <<pc, down, kicked>>
            /\ IF Bug = "old" /\ mode[p] = "pair" /\ Open(code[p])
                 THEN Spend(p) /\ wasted' = TRUE
                 ELSE UNCHANGED <<offer, by, store, wasted>>
       [] mode[p] = "pair" /\ Open(code[p]) /\ NoAck ->
            Spend(p) /\ Go(p, "granting") /\ Done(p) /\ UNCHANGED <<down, kicked, wasted>>
       [] mode[p] = "pair" /\ Open(code[p]) ->
            /\ offer' = [offer EXCEPT ![code[p]] = "held"]
            /\ Go(p, "granting") /\ Done(p) /\ UNCHANGED <<by, store, down, kicked, wasted>>
       [] mode[p] = "session" /\ (dev[p] \in store \/ Bug = "noRecheck") ->
            Go(p, "granting") /\ Done(p) /\ UNCHANGED <<offer, by, store, down, kicked, wasted>>
       [] OTHER ->
            End(p, <<"bye">>) /\ UNCHANGED <<offer, by, store, wasted>>
  /\ UNCHANGED <<exp, claim, mode, code, dev, ph, sent, cut, saved, rv, late>>

Grant(p) ==
  /\ pc[p] = "granting" /\ Go(p, IF mode[p] = "pair" /\ ~NoAck THEN "held" ELSE "ready")
  /\ Send(p, IF mode[p] = "pair" THEN <<"paired">> ELSE <<"ready">>) /\ Late(p)
  /\ UNCHANGED <<offer, exp, claim, by, store, busy, mode, code, dev, up, ph, sent, cut, kicked, saved, rv, wasted>>

\* The phone's ack: the device is stored and the code spent (even if its TTL passed meanwhile).
Commit(p) ==
  /\ Frame(p) = "got"
  /\ CASE Gone(p) -> Done(p) /\ UNCHANGED <<pc, down, kicked, offer, by, store>>
       [] pc[p] = "held" -> Spend(p) /\ Go(p, "ready") /\ Done(p) /\ UNCHANGED <<down, kicked>>
       [] OTHER -> End(p, <<"bye">>) /\ UNCHANGED <<offer, by, store>>
  /\ UNCHANGED <<exp, claim, mode, code, dev, ph, sent, cut, saved, rv, late, wasted>>

\* The ack timer: the peer is ended (a frame being opened stays and finds it closed) and its code given back.
Timeout(p) ==
  /\ pc[p] = "held" /\ Shut(p, <<"bye">>) /\ Back(p)
  /\ UNCHANGED <<exp, claim, by, store, busy, mode, code, dev, ph, sent, cut, saved, rv, late, wasted>>

ReqCheck(p) ==
  /\ Frame(p) = "req"
  /\ CASE Gone(p) -> Done(p) /\ UNCHANGED <<pc, down, kicked>>
       [] dev[p] \in store -> Go(p, "serving") /\ Done(p) /\ UNCHANGED <<down, kicked>>
       [] OTHER -> End(p, <<"revoked", "bye">>)
  /\ UNCHANGED <<offer, exp, claim, by, store, mode, code, dev, ph, sent, cut, saved, rv, late, wasted>>

ReqSend(p) ==
  /\ pc[p] = "serving" /\ Go(p, "ready") /\ Send(p, <<"res">>) /\ Late(p)
  /\ UNCHANGED <<offer, exp, claim, by, store, busy, mode, code, dev, up, ph, sent, cut, kicked, saved, rv, wasted>>

\* revoke(d): the store, then every peer with this deviceId, without an await in between.
Revoke(d) ==
  /\ d \in store /\ rv[d] = "no"
  /\ store' = store \ {d} /\ rv' = [rv EXCEPT ![d] = "running"]
  /\ LET hit == {p \in Conns : dev[p] = d /\ pc[p] \in Known} IN
       /\ pc' = [p \in Conns |-> IF p \in hit THEN "closed" ELSE pc[p]]
       /\ up' = [p \in Conns |-> IF p \in hit THEN (IF busy[p] THEN <<up[p][1]>> ELSE <<>>) ELSE up[p]]
       /\ down' = [p \in Conns |-> IF p \in hit
                                     THEN Put(p, IF pc[p] \in Served THEN <<"revoked", "bye">> ELSE <<"bye">>)
                                     ELSE down[p]]
       /\ kicked' = [p \in Conns |-> kicked[p] \/ p \in hit]
  /\ UNCHANGED <<offer, exp, claim, by, busy, mode, code, dev, ph, sent, cut, saved, late, wasted>>

RevokeDone(d) ==
  /\ rv[d] = "running" /\ rv' = [rv EXCEPT ![d] = "done"]
  /\ UNCHANGED <<offer, exp, claim, by, store, pc, busy, mode, code, dev, up, down, ph, sent, cut, kicked, saved, late, wasted>>

-----------------------------------------------------------------------------

Desk(p) == Take(p) \/ HsCheck(p) \/ HsKeys(p) \/ Confirm(p) \/ Grant(p) \/ Commit(p) \/ ReqCheck(p) \/ ReqSend(p) \/ DeskClose(p)

Next ==
  \/ \E o \in Offers : Make(o) \/ Expire(o)
  \/ \E p \in Conns : \/ Desk(p) \/ Recv(p) \/ Request(p) \/ Drop(p) \/ Revoke(p) \/ RevokeDone(p) \/ Timeout(p)
                      \/ \E o \in Offers : JoinPair(p, o)
                      \/ \E d \in Conns : JoinSession(p, d)

\* The desktop handles what reached it and the phone reads what reached it; a revoke returns. Scanning,
\* connecting, requests, drops, expiry, revoking and the ack timer are never forced.
Fairness == \A p \in Conns : WF_vars(Desk(p)) /\ WF_vars(Recv(p)) /\ WF_vars(RevokeDone(p))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety. *)

\* A code pairs at most one device.
OneDevicePerCode == \A o \in Offers : Cardinality(by[o]) <= 1

\* Once a revoke has started (and so after it returned), the device is sent no `ready` and no `res`.
RevokeEnds == late = {}

\* A code is never spent on a connection the desktop already knows is closed.
NoUseByClosed == ~wasted

\* A spent code went to a phone that holds the token (or `paired` is on its way on a live connection, or the
\* device was revoked: what "noAck" can claim at best). RelayPair_noack.cfg: without the ack it fails.
CodeReachesPhone ==
  \A o \in Offers : \A p \in by[o] :
    \/ p \in saved \/ rv[p] # "no" \/ pc[p] = "granting"
    \/ (~cut[p] /\ \E i \in 1..Len(down[p]) : down[p][i] = "paired")

(* Liveness. *)

\* A code held for a peer is not held forever: the phone's ack spends it, or the peer's end gives it back.
HeldResolves == \A o \in Offers : offer[o] = "held" ~> offer[o] # "held"

\* A phone that scanned a code within its TTL, on a connection that stays up, ends ready (holding the token)
\* or is told no (nope: unknown, used or taken code).
PairOrNope == \A p \in Conns :
  (mode[p] = "pair" /\ ph[p] = "wait")
    ~> (ph[p] \in {"ready", "refused"} \/ cut[p] \/ (code[p] \in Offers /\ exp[code[p]]))

\* A paired phone connecting again, on a connection that stays up, ends ready or is told no, unless its
\* device is revoked meanwhile (a revoke during the handshake ends the peer; the phone's retry is refused).
SessionAnswered == \A p \in Conns :
  (mode[p] = "session" /\ ph[p] = "wait")
    ~> (ph[p] \in {"ready", "refused"} \/ cut[p] \/ (dev[p] \in Conns /\ rv[dev[p]] # "no"))
=============================================================================
