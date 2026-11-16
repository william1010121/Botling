------------------------------- MODULE Routing -------------------------------
(* Botling 3 (nothing built yet): routing a front end's commands to a bot's single, fixed owner; exactly-once
   intent per slot; truthful delivery states. Protocol: .bot/artifacts/architecture-v3/protocol-v1.md sections 7.2,
   11 and 13 (change ids D1, D2, D4, D5, D11-D18, D30-D32); brief: tla-brief-v2.md section 1.

   One bot, owned by `Owner` for its whole life (D5: no move, no takeover). A front end (an origin) numbers its
   commands per origin epoch: slot = <<o, e, n>> (D11). Its outbox is durable (C4/D2); it sends every unresolved
   command, in slot order, with `floor` (the lowest n it still waits on, D12), `basis` (the bot version it saw, D15)
   and `inc` (the owner's logId as it knows it, D49), to the one server it is attached to (D18), and again after a
   loss or a switch. A server that does not own the bot commits the command into its forward queue, then replies
   `held`, and forwards it until the owner's `cmd.result` comes back (11.2). The owner applies v1 11.3 in one
   transaction (D1): another `inc` -> `cmd.retry` (no receipt); floor skip; duplicate; slot conflict; wait for the
   gap; cancelled; refused (origin revoked); changed (basis); applied; receipt; next++; then sends `cmd.result`
   carrying its logId. The FE drops a result of a logId below the one it knows (D50: retired).

   The owner's receipts and `next` are read from its log (one record per slot), so they cannot disagree with it.
   `OwnerRewind` puts the log back to an earlier prefix (a backup restored, 7.6): new logId, cancels ahead lost.
   `FeStorageLoss` wipes an FE's outbox and counter: the next command uses a new origin epoch (D32).

   Network: a set of messages; a receiver consumes one (or, with the Dup budget, leaves a copy); any may be lost
   (bounded). A crash loses what was not committed (C4: messages to the server and its volatile flags), never a
   committed record. A command's content `h` stands for its hash (two commands may have the same text); `u` is a
   ghost id telling commands apart.

   What v1 leaves implicit and the model needs (say so in the protocol text):
     P1  One session is a FIFO stream (WebSocket over TCP or the relay): the accepting server takes one session's
         commands in the order sent, and a lost frame breaks the session, so the frames after it are lost too. With
         unordered delivery (Bug "unordered") the FE's slot 2 can be held at a server while slot 1 is lost; after a
         storage wipe nobody re-sends slot 1, and slot 2 waits at the owner for ever (QueueDrains, Settles fail).
         The owner cannot close the old epoch instead: epochs are random, so it cannot tell which is older.
     P2  `cancel` gets an answer: the stored outcome if too late, otherwise "noted" after the commit, so the
         forwarding server can delete its forward-queue row for the cancel (11.3 says only "add n to cancels").

   Routing.cfg is the CI size (two slots, a switch). Longer checks, minutes each, run by hand with
   `spec/tools/tlc.sh Routing.tla -config Routing_case_<x>.cfg`: loss (a lost frame and a switch), cancel, crash (and
   a partition), restore (a rewind with two slots), wipe (a storage loss with an old-epoch slot queued), revoke (and a
   version change). RoutingRestoreSwitch.cfg (a rewind and a switch) is small and runs in CI.

   Plugin hot swap (P7; brief tla-brief-plugin-kernel.md section 3; D53, v1 13.2). The commands come from one
   plugin's web part on each FE; `inst[o]` is its live instance there. An outbox item keeps `via` = <<plugin, hash>>
   (one plugin here, so it is left implicit), never the instance. `PluginSwap(o)` starts a new instance: the old
   one's memory is gone and it has not subscribed yet, the outbox stays. An outcome the FE takes waits in `note[o]`
   and is delivered (`Deliver`) to the live instance if it subscribed to the plugin's outcomes, else to the shell's
   outbox view. With MaxSwap = 0 the outcome is delivered at once (no extra states for the other configs).
   Routing_swap.cfg is Routing.cfg with one swap anywhere, checking every Routing property and OutcomeShown and
   IntentAppliedOnce. Bugs:
   Bug = "instanceowned":    items belong to the instance and go with it on a swap (OutcomeShown fails).
   Bug = "resendonswap":     the new instance re-creates its predecessor's unresolved items under new slots
                             (IntentAppliedOnce fails).

   Bug = "nodedupe":         the owner applies a slot again (AppliedOncePerIncarnation fails).
   Bug = "nonatomic":        effect appended, receipt (next) written in a second step a crash can skip, as 2.x's
                             mutation journal (AppliedOncePerIncarnation fails).
   Bug = "timeout":          the FE shows "not sent" after a timeout without an outcome (TruthfulUI fails).
   Bug = "cancelrace":       a cancel only takes the command out of the FE's outbox (TruthfulUI fails).
   Bug = "noepoch":          after a storage wipe the FE numbers from 1 in the same epoch (NoSilentDuplicate fails).
   Bug = "nofloor":          the owner ignores `floor` (QueueDrains / Settles fail after a rewind).
   Bug = "nobasis":          the owner ignores `basis` (NoActOnChanged fails).
   Bug = "ackbeforecommit":  `held` is sent before the forward-queue write; a crash between them (TruthfulUI fails).
   Bug = "noinc":            the owner ignores `inc` (D49 reversed): a copy of a seen slot left in a forward queue
                             runs again after a restore (SeenNeverReapplied fails).
   Bug = "retiredresult":    the FE takes a `cmd.result` of a retired logId (D50 reversed) (SeenNeverReapplied).
   Bug = "unordered":        P1 reversed (QueueDrains / Settles fail). *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Servers, Owner, Origins,
  MaxN,         \* slots per origin epoch
  MaxEp,        \* origin epochs per origin (1 + storage losses)
  MaxIssue,     \* commands an origin issues in all
  Contents,     \* command texts (hash stand-ins)
  MaxVer,       \* bot versions (1 + Bump budget)
  MaxCrash, MaxRewind, MaxLoss, MaxDup, MaxSwitch, MaxPart, MaxCancel, MaxRevoke,
  MaxSwap,      \* plugin hot swaps on the FE (P7)
  Bug

ASSUME Owner \in Servers
ASSUME Bug \in {"none", "nodedupe", "nonatomic", "timeout", "cancelrace", "noepoch", "nofloor", "nobasis",
                "ackbeforecommit", "noinc", "retiredresult", "unordered", "instanceowned", "resendonswap"}

Others == Servers \ {Owner}
Ns == 1..MaxN
Eps == 1..MaxEp
Uids == Origins \X (1..MaxIssue)
UidsZ == Origins \X (0..MaxIssue)   \* <<o, 0>>: no command (a skipped slot)
Outs == {"applied", "cancelled", "refused", "changed", "skipped"}
NotSentOuts == {"cancelled", "refused", "changed", "skipped"}
Shows == {"none", "waiting", "held", "delivered", "notSent"}
Logs == 1..(MaxRewind + 1)
None == "none"
Insts == 1..(MaxSwap + 1)
Shell == 0                 \* the shell's outbox view, as a destination
Dests == {Shell} \cup Insts

\* A log record: one per slot, q = its seq in the log. u = <<o, 0>> for skipped slots (no command behind them).
MaxLen == Cardinality(Origins) * MaxEp * MaxN + MaxIssue * Cardinality(Origins)
Recs == [q : 1..MaxLen, o : Origins, e : Eps, n : Ns, h : Contents \cup {0}, u : UidsZ, k : Outs,
         b : 0..MaxVer]
\* A command as the FE holds it.
Items == [e : Eps, n : Ns, h : Contents, u : Uids, b : 1..MaxVer]
\* Forward-queue item: a command or a cancel, for slot <<o, e, n>>.
Fwds == [t : {"cmd", "cxl"}, o : Origins, e : Eps, n : Ns, h : Contents \cup {0}, u : UidsZ,
         b : 0..MaxVer, f : 1..(MaxN + 1), l : Logs]
\* Messages. `from` is the server a command or cancel was handed to the owner by (Owner = straight from the FE).
CmdMsgs == [t : {"cmd", "cxl"}, o : Origins, e : Eps, n : Ns, h : Contents \cup {0}, u : UidsZ,
            b : 0..MaxVer, f : 1..(MaxN + 1), l : Logs, to : Servers, from : Servers \cup {None}]
ResMsgs == [t : {"res"}, o : Origins, e : Eps, n : Ns, k : Outs \cup {"conflict", "retry", "noted"}, u : UidsZ,
            l : Logs, to : Servers \cup Origins, via : Servers]
Sents == {"cmd", "cxl"} \X Eps \X Ns
Seens == [e : Eps, n : Ns, k : Outs, ru : UidsZ, iu : Uids]
HeldMsgs == [t : {"held"}, o : Origins, e : Eps, n : Ns, l : Logs, to : Origins, via : Servers]

VARIABLES
  \* owner, committed
  log,      \* SUBSET Recs (one record per slot, numbered by q)
  cxl,      \* SUBSET (Origins \X Eps \X Ns): cancels ahead of next
  ver,      \* the bot's visible version
  logId,
  norc,     \* Bug "nonatomic": slots whose effect is committed and receipt not (durable)
  half,     \* Bug "nonatomic": receipts still to write in this run (volatile)
  \* forwarding servers
  fwd,      \* [Servers -> SUBSET Fwds], committed
  pend,     \* Bug "ackbeforecommit": [Servers -> SUBSET Fwds] acknowledged, not yet committed (volatile)
  told,     \* [Servers -> SUBSET Fwds]: `held` already sent in this run (volatile)
  fsent,    \* [Servers -> SUBSET Fwds]: forwarded on the current session with the owner (volatile)
  down,     \* crashed servers
  cut,      \* forwarders whose link to the owner is down
  know,     \* [Servers -> SUBSET Origins]: revocations each server has heard of
  revoked,  \* revocations written
  net,
  \* front ends
  att,      \* [Origins -> Servers]
  ep,       \* [Origins -> Eps]
  fl,       \* [Origins -> Logs]: the owner's logId as this FE knows it (sent as `inc`, D49; results of a lower one
            \* are dropped, D50)
  ctr,      \* [Origins -> 1..MaxN+1]: next n
  nIss,     \* [Origins -> 0..MaxIssue]
  box,      \* [Origins -> SUBSET Items]: outbox
  sent,     \* [Origins -> SUBSET Sents]: sent on the current session (volatile)
  cx,       \* [Origins -> SUBSET Ns]: cancels asked (current epoch)
  shown,    \* [Origins -> [Eps \X Ns -> Shows]]
  seen,     \* [Origins -> SUBSET Seens]: outcomes seen: slot, outcome, the command it answered, the one meant
  \* ghosts
  everApp,  \* commands (u) ever applied, in any log incarnation
  everNot,  \* commands (u) ever cancelled / refused / changed
  seenEver, \* slots whose outcome some FE saw
  reapp,    \* a seen slot was applied again later
  \* budgets
  nCrash, nRewind, nLoss, nDup, nSwitch, nPart, nCancel, nRevoke, nBump, nWipe,
  \* plugin hot swap (P7)
  inst,     \* [Origins -> 1..MaxSwap+1]: the plugin's live instance on the FE
  subd,     \* [Origins -> BOOLEAN]: the live instance subscribed to the plugin's outcomes
  note,     \* [Origins -> SUBSET (Eps \X Ns)]: outcomes taken, not yet delivered to an instance or the shell
  toldTo,   \* ghost: [Origins -> SUBSET ((Eps \X Ns) \X Dests)]: where each outcome went
  nSwap

owner == <<log, cxl, ver, logId, norc, half>>
servers == <<fwd, pend, told, fsent, down, cut, know, revoked>>
fes == <<att, ep, fl, ctr, nIss, box, sent, cx, shown, seen>>
ghosts == <<everApp, everNot, seenEver, reapp>>
budget == <<nCrash, nRewind, nLoss, nDup, nSwitch, nPart, nCancel, nRevoke, nBump, nWipe>>
plug == <<inst, subd, note, toldTo, nSwap>>
bvars == <<owner, servers, net, fes, ghosts, budget>>   \* fairness on the base steps (they leave plug unchanged)
vars == <<bvars, plug>>

-----------------------------------------------------------------------------
(* Reading the owner's log *)

Min(S) == CHOOSE x \in S : \A y \in S : x <= y
RecOf(o, e, n) == {r \in log : r.o = o /\ r.e = e /\ r.n = n}
Has(o, e, n) == RecOf(o, e, n) # {}
Rcpt(o, e, n) == CHOOSE r \in RecOf(o, e, n) : TRUE
\* next per <<o, e>>: one past the highest slot with a record (records are gapless per <<o, e>> when FIFO holds).
NextN(o, e) == IF Bug = "nonatomic"
              THEN 1 + Cardinality({n \in Ns : Has(o, e, n) /\ <<o, e, n>> \notin norc})
              ELSE 1 + Cardinality({n \in Ns : Has(o, e, n)})
Up(s) == s \notin down
\* A frame on a session with s (to it, or sent by it and not yet received).
Touches(m, s) == m.to = s \/ (m.t \in {"res", "held"} /\ m.via = s) \/ (m.t \in {"cmd", "cxl"} /\ m.from = s)
\* The link between a forwarder and the owner.
Link(s) == Up(s) /\ Up(Owner) /\ s \notin cut

Floor(o) == IF box[o] = {} THEN ctr[o] ELSE Min({i.n : i \in box[o]})

Send1(m) == net' = net \cup {m}
\* Consume m (or keep a copy, spending the Dup budget).
Take(m) == \/ net' = net \ {m} /\ UNCHANGED nDup
           \/ nDup < MaxDup /\ net' = net /\ nDup' = nDup + 1

TypeOK ==
  /\ log \subseteq Recs /\ cxl \subseteq (Origins \X Eps \X Ns) /\ ver \in 1..MaxVer /\ logId \in Logs
  /\ norc \subseteq (Origins \X Eps \X Ns) /\ half \subseteq (Origins \X Eps \X Ns)
  /\ fwd \in [Servers -> SUBSET Fwds] /\ pend \in [Servers -> SUBSET Fwds] /\ told \in [Servers -> SUBSET Fwds]
  /\ fsent \in [Servers -> SUBSET Fwds] /\ sent \in [Origins -> SUBSET Sents]
  /\ down \subseteq Servers /\ cut \subseteq Others /\ know \in [Servers -> SUBSET Origins] /\ revoked \subseteq Origins
  /\ net \subseteq (CmdMsgs \cup ResMsgs \cup HeldMsgs)
  /\ att \in [Origins -> Servers] /\ ep \in [Origins -> Eps] /\ fl \in [Origins -> Logs] /\ ctr \in [Origins -> 1..(MaxN + 1)]
  /\ nIss \in [Origins -> 0..MaxIssue] /\ box \in [Origins -> SUBSET Items] /\ cx \in [Origins -> SUBSET Ns]
  /\ shown \in [Origins -> [Eps \X Ns -> Shows]]
  /\ seen \in [Origins -> SUBSET Seens]
  /\ everApp \subseteq Uids /\ everNot \subseteq Uids /\ seenEver \subseteq (Origins \X Eps \X Ns)
  /\ reapp \in BOOLEAN
  /\ inst \in [Origins -> Insts] /\ subd \in [Origins -> BOOLEAN] /\ note \in [Origins -> SUBSET (Eps \X Ns)]
  /\ toldTo \in [Origins -> SUBSET ((Eps \X Ns) \X Dests)] /\ nSwap \in 0..MaxSwap

Init ==
  /\ log = {} /\ cxl = {} /\ ver = 1 /\ logId = 1 /\ norc = {} /\ half = {}
  /\ fwd = [s \in Servers |-> {}] /\ pend = [s \in Servers |-> {}] /\ told = [s \in Servers |-> {}]
  /\ fsent = [s \in Servers |-> {}] /\ sent = [o \in Origins |-> {}]
  /\ down = {} /\ cut = {} /\ know = [s \in Servers |-> {}] /\ revoked = {}
  /\ net = {}
  /\ att \in [Origins -> Servers]
  /\ ep = [o \in Origins |-> 1] /\ fl = [o \in Origins |-> 1] /\ ctr = [o \in Origins |-> 1] /\ nIss = [o \in Origins |-> 0]
  /\ box = [o \in Origins |-> {}] /\ cx = [o \in Origins |-> {}]
  /\ shown = [o \in Origins |-> [sl \in Eps \X Ns |-> "none"]]
  /\ seen = [o \in Origins |-> {}]
  /\ everApp = {} /\ everNot = {} /\ seenEver = {} /\ reapp = FALSE
  /\ nCrash = 0 /\ nRewind = 0 /\ nLoss = 0 /\ nDup = 0 /\ nSwitch = 0 /\ nPart = 0 /\ nCancel = 0
  /\ nRevoke = 0 /\ nBump = 0 /\ nWipe = 0
  /\ inst = [o \in Origins |-> 1] /\ subd = [o \in Origins |-> TRUE] /\ note = [o \in Origins |-> {}]
  /\ toldTo = [o \in Origins |-> {}] /\ nSwap = 0

-----------------------------------------------------------------------------
(* Front end *)

\* The user acts: the command goes into the durable outbox (the step), shown waiting. basis = the version it sees.
Issue(o, h) ==
  /\ ctr[o] <= MaxN /\ nIss[o] < MaxIssue
  /\ LET it == [e |-> ep[o], n |-> ctr[o], h |-> h, u |-> <<o, nIss[o] + 1>>, b |-> ver] IN
       /\ box' = [box EXCEPT ![o] = @ \cup {it}]
       /\ shown' = [shown EXCEPT ![o][<<ep[o], ctr[o]>>] = "waiting"]
  /\ ctr' = [ctr EXCEPT ![o] = @ + 1] /\ nIss' = [nIss EXCEPT ![o] = @ + 1]
  /\ UNCHANGED <<owner, servers, net, att, ep, fl, sent, cx, seen, ghosts, budget>>

CmdOf(o, it) == [t |-> "cmd", o |-> o, e |-> it.e, n |-> it.n, h |-> it.h, u |-> it.u, b |-> it.b,
                 f |-> Floor(o), l |-> fl[o], to |-> att[o], from |-> None]
CxlOf(o, n) == [t |-> "cxl", o |-> o, e |-> ep[o], n |-> n, h |-> 0, u |-> <<o, 0>>, b |-> 0, f |-> Floor(o),
                l |-> fl[o], to |-> att[o], from |-> None]

\* (Re)send an unresolved command (or a cancel asked) to the attached server, when no copy is in flight.
Send(o, it) ==
  /\ it \in box[o] /\ Up(att[o]) /\ o \notin know[att[o]]
  /\ Bug # "unordered" => \A j \in box[o] : (j.e = it.e /\ j.n < it.n) => <<"cmd", j.e, j.n>> \in sent[o]   \* P1
  /\ <<"cmd", it.e, it.n>> \notin sent[o] /\ sent' = [sent EXCEPT ![o] = @ \cup {<<"cmd", it.e, it.n>>}]
  /\ Send1(CmdOf(o, it))
  /\ UNCHANGED <<owner, servers, att, ep, fl, ctr, nIss, box, cx, shown, seen, ghosts, budget>>
SendCancel(o, n) ==
  /\ n \in cx[o] /\ Up(att[o]) /\ o \notin know[att[o]]
  /\ <<"cxl", ep[o], n>> \notin sent[o] /\ sent' = [sent EXCEPT ![o] = @ \cup {<<"cxl", ep[o], n>>}]
  /\ Send1(CxlOf(o, n))
  /\ UNCHANGED <<owner, servers, att, ep, fl, ctr, nIss, box, cx, shown, seen, ghosts, budget>>

\* The user cancels a waiting command (Bug "cancelrace": the FE drops it and says "not sent" by itself).
Cancel(o, it) ==
  /\ it \in box[o] /\ it.n \notin cx[o] /\ nCancel < MaxCancel /\ nCancel' = nCancel + 1
  /\ IF Bug = "cancelrace"
       THEN /\ box' = [box EXCEPT ![o] = @ \ {it}]
            /\ shown' = [shown EXCEPT ![o][<<it.e, it.n>>] = "notSent"]
            /\ UNCHANGED cx
       ELSE cx' = [cx EXCEPT ![o] = @ \cup {it.n}] /\ UNCHANGED <<box, shown>>
  /\ UNCHANGED <<owner, servers, net, att, ep, fl, ctr, nIss, sent, seen, ghosts, nCrash, nRewind, nLoss, nDup, nSwitch,
                 nPart, nRevoke, nBump, nWipe>>

\* Bug "timeout" only: the FE gives up and shows "not sent" without an outcome.
Timeout(o, it) ==
  /\ Bug = "timeout" /\ it \in box[o]
  /\ box' = [box EXCEPT ![o] = @ \ {it}] /\ shown' = [shown EXCEPT ![o][<<it.e, it.n>>] = "notSent"]
  /\ UNCHANGED <<owner, servers, net, att, ep, fl, ctr, nIss, sent, cx, seen, ghosts, budget>>

ShowOf(k) == IF k = "applied" THEN "delivered" ELSE "notSent"

\* The attached server's `cmd.result` reaches the FE: it records the outcome and drops the outbox item.
SeeOutcome(o, m) ==
  /\ m \in net /\ m.t = "res" /\ m.to = o /\ m.via = att[o] /\ m.k \notin {"conflict", "retry", "noted"}
  /\ Bug = "retiredresult" \/ m.l >= fl[o]              \* D50: a result of a retired logId is dropped
  /\ fl' = [fl EXCEPT ![o] = IF m.l > @ THEN m.l ELSE @]
  /\ sent' = IF m.l > fl[o] THEN [sent EXCEPT ![o] = {}] ELSE sent
  /\ \E it \in box[o] :
       /\ it.e = m.e /\ it.n = m.n
       /\ box' = [box EXCEPT ![o] = @ \ {it}]
       /\ cx' = [cx EXCEPT ![o] = @ \ {it.n}]
       /\ shown' = [shown EXCEPT ![o] = [sl \in Eps \X Ns |->
                      IF sl = <<m.e, m.n>> THEN ShowOf(m.k)
                      ELSE IF m.l > fl[o] /\ @[sl] = "held" THEN "waiting" ELSE @[sl]]]
       /\ seen' = [seen EXCEPT ![o] = @ \cup {[e |-> m.e, n |-> m.n, k |-> m.k, ru |-> m.u, iu |-> it.u]}]
  /\ seenEver' = seenEver \cup {<<o, m.e, m.n>>}
  /\ net' = net \ {m}
  /\ UNCHANGED <<owner, servers, att, ep, ctr, nIss, everApp, everNot, reapp, budget>>

\* `cmd.retry{slot, inc}` (D49): the owner was restored; the FE takes the new logId (in the protocol it comes with the
\* owner's `reset` on the srv: stream, which the FE catches up before it re-sends) and sends its outbox again with
\* the new `inc` and a fresh floor. The same happens when it learns a newer logId from a result (SeeOutcome): items
\* shown held under the old logId show waiting until held again.
SeeReset(o, m) ==
  /\ m \in net /\ m.t = "res" /\ m.to = o /\ m.via = att[o] /\ m.k = "retry"
  /\ fl' = [fl EXCEPT ![o] = IF m.l > @ THEN m.l ELSE @]
  /\ shown' = [shown EXCEPT ![o] = [sl \in Eps \X Ns |-> IF @[sl] = "held" THEN "waiting" ELSE @[sl]]]
  /\ sent' = [sent EXCEPT ![o] = {}]
  /\ net' = net \ {m}
  /\ UNCHANGED <<owner, servers, att, ep, ctr, nIss, box, cx, seen, ghosts, budget>>

\* A result for something the FE no longer waits on (a duplicate, an older epoch, a conflict): dropped.
DropResult(o, m) ==
  /\ m \in net /\ m.t \in {"res", "held"} /\ m.to = o
  /\ m.t = "res" => (m.k \in {"conflict", "noted"} \/ (Bug # "retiredresult" /\ m.l < fl[o]) \/ ~\E it \in box[o] : it.e = m.e /\ it.n = m.n)
  /\ m.t = "res" => m.k # "retry"
  /\ m.t = "held" => (m.l < fl[o] \/ shown[o][<<m.e, m.n>>] # "waiting" \/ ~\E it \in box[o] : it.e = m.e /\ it.n = m.n)
  /\ net' = net \ {m}
  /\ UNCHANGED <<owner, servers, fes, ghosts, budget>>

SeeHeld(o, m) ==
  /\ m \in net /\ m.t = "held" /\ m.to = o /\ m.via = att[o]
  /\ \E it \in box[o] : it.e = m.e /\ it.n = m.n
  /\ shown[o][<<m.e, m.n>>] = "waiting"
  /\ m.l >= fl[o]     \* frames on one session are in order: a held sent before a reset is not read after it
  /\ shown' = [shown EXCEPT ![o][<<m.e, m.n>>] = "held"]
  /\ net' = net \ {m}
  /\ UNCHANGED <<owner, servers, att, ep, fl, ctr, nIss, sent, box, cx, seen, ghosts, budget>>

\* Detach (at any time, mid-request) and attach to s: the old session's frames to the FE are gone; the outbox is
\* sent again by Send.
Switch(o, s) ==
  /\ s # att[o] /\ nSwitch < MaxSwitch /\ nSwitch' = nSwitch + 1
  /\ att' = [att EXCEPT ![o] = s] /\ sent' = [sent EXCEPT ![o] = {}]
  /\ net' = {m \in net : ~(m.t \in {"res", "held"} /\ m.to = o)}
  /\ UNCHANGED <<owner, servers, ep, fl, ctr, nIss, box, cx, shown, seen, ghosts, nCrash, nRewind, nLoss, nDup,
                 nPart, nCancel, nRevoke, nBump, nWipe>>

\* Browser storage cleared: outbox, counter and seen outcomes gone; the next start makes a new origin epoch
\* (Bug "noepoch": the same epoch, numbering again from 1).
FeStorageLoss(o) ==
  /\ nWipe < MaxEp - 1 /\ nIss[o] > 0 /\ nWipe' = nWipe + 1
  /\ ep' = [ep EXCEPT ![o] = IF Bug = "noepoch" THEN @ ELSE @ + 1]
  /\ ctr' = [ctr EXCEPT ![o] = 1]
  /\ box' = [box EXCEPT ![o] = {}] /\ cx' = [cx EXCEPT ![o] = {}] /\ sent' = [sent EXCEPT ![o] = {}]
  /\ shown' = [shown EXCEPT ![o] = [sl \in Eps \X Ns |-> "none"]]
  /\ seen' = [seen EXCEPT ![o] = {}]
  /\ UNCHANGED <<owner, servers, net, att, fl, nIss, ghosts, nCrash, nRewind, nLoss, nDup, nSwitch, nPart, nCancel,
                 nRevoke, nBump>>

-----------------------------------------------------------------------------
(* Forwarding servers *)

FwdOf(m) == [t |-> m.t, o |-> m.o, e |-> m.e, n |-> m.n, h |-> m.h, u |-> m.u, b |-> m.b, f |-> m.f, l |-> m.l]
HeldOf(s, x) == [t |-> "held", o |-> x.o, e |-> x.e, n |-> x.n, l |-> x.l, to |-> x.o, via |-> s]

\* A non-owner takes a command or cancel from its FE: commits it into the forward queue (the reply comes after,
\* HeldReply). Bug "ackbeforecommit": replies at once and commits in a later step.
Hold(s, m) ==
  /\ s # Owner /\ Up(s) /\ m \in net /\ m.t \in {"cmd", "cxl"} /\ m.to = s /\ m.from = None
  /\ m.o \notin know[s]
  /\ (Bug # "unordered" /\ m.t = "cmd") =>     \* P1: one session's commands are taken in the order sent
       ~\E m2 \in net : m2.t = "cmd" /\ m2.to = s /\ m2.from = None /\ m2.o = m.o /\ m2.e = m.e /\ m2.n < m.n
  /\ IF Bug = "ackbeforecommit" /\ m.t = "cmd"
       THEN /\ pend' = [pend EXCEPT ![s] = @ \cup {FwdOf(m)}]
            /\ told' = [told EXCEPT ![s] = @ \cup {FwdOf(m)}]
            /\ net' = (net \ {m}) \cup {HeldOf(s, FwdOf(m))}
            /\ UNCHANGED <<fwd, nDup>>
       ELSE /\ fwd' = [fwd EXCEPT ![s] = @ \cup {FwdOf(m)}] /\ Take(m) /\ UNCHANGED <<pend, told>>
  /\ UNCHANGED <<owner, fsent, down, cut, know, revoked, fes, ghosts, nCrash, nRewind, nLoss, nSwitch, nPart, nCancel,
                 nRevoke, nBump, nWipe>>

CommitHold(s, x) ==
  /\ Up(s) /\ x \in pend[s]
  /\ fwd' = [fwd EXCEPT ![s] = @ \cup {x}] /\ pend' = [pend EXCEPT ![s] = @ \ {x}]
  /\ UNCHANGED <<owner, told, fsent, down, cut, know, revoked, net, fes, ghosts, budget>>

\* `held` goes out only for a committed queue item, once per run.
HeldReply(s, x) ==
  /\ Up(s) /\ x \in fwd[s] /\ x.t = "cmd" /\ x \notin told[s] /\ att[x.o] = s
  /\ told' = [told EXCEPT ![s] = @ \cup {x}] /\ Send1(HeldOf(s, x))
  /\ UNCHANGED <<owner, fwd, pend, fsent, down, cut, know, revoked, fes, ghosts, budget>>

ToOwner(s, x) == [t |-> x.t, o |-> x.o, e |-> x.e, n |-> x.n, h |-> x.h, u |-> x.u, b |-> x.b, f |-> x.f,
                  l |-> x.l, to |-> Owner, from |-> s]
Forward(s, x) ==
  /\ x \in fwd[s] /\ Link(s) /\ x.o \notin know[s]
  /\ x \notin fsent[s] /\ fsent' = [fsent EXCEPT ![s] = @ \cup {x}]
  /\ Send1(ToOwner(s, x))
  /\ UNCHANGED <<owner, fwd, pend, told, down, cut, know, revoked, fes, ghosts, budget>>

\* The owner's `cmd.result` reaches the forwarder: its queue items for the slot go; the result goes on to the FE
\* if it is attached here.
Relay(s, m) ==
  /\ s # Owner /\ Up(s) /\ m \in net /\ m.t = "res" /\ m.to = s
  /\ fwd' = [fwd EXCEPT ![s] = {x \in @ : ~(x.o = m.o /\ x.e = m.e /\ x.n = m.n
                                              /\ (m.k = "retry" => x.l < m.l) /\ (m.k = "noted" => x.t = "cxl"))}]
  /\ fsent' = [fsent EXCEPT ![s] = @ \cap fwd'[s]] /\ told' = [told EXCEPT ![s] = @ \cap fwd'[s]]
  /\ net' = (net \ {m}) \cup
            (IF att[m.o] = s /\ m.k # "noted" THEN {[m EXCEPT !.to = m.o, !.via = s]} ELSE {})
  /\ UNCHANGED <<owner, pend, down, cut, know, revoked, fes, ghosts, budget>>

\* A server that knows an origin is revoked drops its queue items (the session with it is closed: nothing to tell).
DropRevoked(s, x) ==
  /\ Up(s) /\ x \in fwd[s] /\ x.o \in know[s]
  /\ fwd' = [fwd EXCEPT ![s] = @ \ {x}] /\ fsent' = [fsent EXCEPT ![s] = @ \ {x}] /\ told' = [told EXCEPT ![s] = @ \ {x}]
  /\ UNCHANGED <<owner, pend, down, cut, know, revoked, net, fes, ghosts, budget>>

-----------------------------------------------------------------------------
(* Owner: v1 11.3, one transaction per command *)

ResTo(m, k, u) == [t |-> "res", o |-> m.o, e |-> m.e, n |-> m.n, k |-> k, u |-> u, l |-> logId,
                   to |-> IF m.from = None THEN m.o ELSE m.from, via |-> Owner]
SkipRecs(o, e, lo, hi) ==
  {[q |-> Cardinality(log) + i - lo + 1, o |-> o, e |-> e, n |-> i, h |-> 0, u |-> <<o, 0>>, k |-> "skipped", b |-> 0] :
     i \in lo..hi}

Apply(m) ==
  /\ Up(Owner) /\ m \in net /\ m.t = "cmd" /\ m.to = Owner
  /\ m.from = None => m.o \notin know[Owner]           \* a revoked device's session is closed
  /\ IF Bug # "noinc" /\ m.l # logId
     THEN \* D49: sent to an earlier incarnation of this owner: cmd.retry{slot, inc: logId}; no receipt, no outcome
          /\ net' = (net \ {m}) \cup {ResTo(m, "retry", <<m.o, 0>>)}
          /\ UNCHANGED <<log, norc, half, everApp, everNot, reapp>>
     ELSE
     LET o == m.o
         e == m.e
         nx0 == NextN(o, e)
         doSkip == Bug # "nofloor" /\ m.f > nx0
         nx == IF doSkip THEN m.f ELSE nx0
         log1 == log \cup (IF doSkip THEN SkipRecs(o, e, nx0, m.f - 1) ELSE {})
     IN
       \/ /\ m.n < nx /\ Bug # "nodedupe"              \* duplicate (same hash) or slot conflict
          /\ LET r == CHOOSE x \in log1 : x.o = o /\ x.e = e /\ x.n = m.n IN
               net' = (net \ {m}) \cup {IF r.k = "skipped" \/ r.h = m.h THEN ResTo(m, r.k, r.u)
                                         ELSE ResTo(m, "conflict", <<o, 0>>)}
          /\ log' = log1
          /\ UNCHANGED <<norc, half, everApp, everNot, reapp>>
       \/ /\ m.n = nx \/ (Bug = "nodedupe" /\ m.n < nx)
          /\ LET k == IF <<o, e, m.n>> \in cxl THEN "cancelled"
                      ELSE IF o \in know[Owner] THEN "refused"
                      ELSE IF Bug # "nobasis" /\ m.b # ver THEN "changed"
                      ELSE "applied"
                 r == [q |-> Cardinality(log1) + 1, o |-> o, e |-> e, n |-> m.n, h |-> m.h, u |-> m.u, k |-> k,
                       b |-> m.b]
                 split == Bug = "nonatomic" /\ k = "applied"
             IN /\ log' = log1 \cup {r}
                /\ norc' = IF split THEN norc \cup {<<o, e, m.n>>} ELSE norc
                /\ half' = IF split THEN half \cup {<<o, e, m.n>>} ELSE half
                /\ net' = (net \ {m}) \cup (IF split THEN {} ELSE {ResTo(m, k, m.u)})
                /\ everApp' = IF k = "applied" THEN everApp \cup {m.u} ELSE everApp
                /\ everNot' = IF k = "applied" THEN everNot ELSE everNot \cup {m.u}
                /\ reapp' = (reapp \/ (k = "applied" /\ <<o, e, m.n>> \in seenEver))
       \/ /\ m.n > nx /\ doSkip                    \* the gap: skip below floor, the slot waits
          /\ log' = log1 /\ UNCHANGED <<net, norc, half, everApp, everNot, reapp>>
  /\ UNCHANGED <<cxl, ver, logId, servers, fes, seenEver, budget>>

\* Bug "nonatomic" only: the second transaction writes the receipt (next) and answers.
WriteReceipt(sl) ==
  /\ Up(Owner) /\ sl \in half
  /\ half' = half \ {sl} /\ norc' = norc \ {sl}
  /\ UNCHANGED <<log, cxl, ver, logId, servers, net, fes, ghosts, budget>>

\* A cancel at the owner: too late -> the stored outcome; otherwise remembered (committed) for when the slot comes.
ApplyCancel(m) ==
  /\ Up(Owner) /\ m \in net /\ m.t = "cxl" /\ m.to = Owner
  /\ m.from = None => m.o \notin know[Owner]
  /\ IF m.n < NextN(m.o, m.e)
       THEN LET r == Rcpt(m.o, m.e, m.n) IN net' = (net \ {m}) \cup {ResTo(m, r.k, r.u)}
       ELSE net' = (net \ {m}) \cup {ResTo(m, "noted", <<m.o, 0>>)}   \* committed, then acknowledged (P2)
  /\ cxl' = IF m.n < NextN(m.o, m.e) THEN cxl ELSE cxl \cup {<<m.o, m.e, m.n>>}
  /\ UNCHANGED <<log, ver, logId, norc, half, servers, fes, ghosts, budget>>

\* The bot's visible version changes (a turn ends, a card is replaced).
Bump ==
  /\ Up(Owner) /\ ver < MaxVer /\ ver' = ver + 1 /\ nBump' = nBump + 1
  /\ UNCHANGED <<log, cxl, logId, norc, half, servers, net, fes, ghosts, nCrash, nRewind, nLoss, nDup, nSwitch, nPart,
                 nCancel, nRevoke, nWipe>>

\* The owner's data folder goes back to an earlier committed state (a backup restored, or copied back by hand and
\* detected, 7.6): the log to a prefix per origin epoch (records with the highest slots go), new logId; volatile state
\* and messages to the owner lost.
OwnerRewind ==
  /\ nRewind < MaxRewind /\ nRewind' = nRewind + 1
  /\ \E len \in 0..(Cardinality(log) - 1) : log' = {r \in log : r.q <= len}
  /\ norc' = {sl \in norc : \E r \in log' : <<r.o, r.e, r.n>> = sl}
  /\ cxl' = {} /\ half' = {} /\ logId' = logId + 1
  /\ net' = {m \in net : ~Touches(m, Owner)}
  /\ fsent' = [t \in Servers |-> {}]
  /\ sent' = [o \in Origins |-> IF att[o] = Owner THEN {} ELSE sent[o]]
  /\ UNCHANGED <<ver, fwd, pend, told, down, cut, know, revoked, att, ep, fl, ctr, nIss, box, cx, shown, seen, ghosts, nCrash, nLoss, nDup, nSwitch, nPart, nCancel, nRevoke, nBump, nWipe>>

-----------------------------------------------------------------------------
(* Failures *)

Crash(s) ==
  /\ Up(s) /\ nCrash < MaxCrash /\ nCrash' = nCrash + 1
  /\ down' = down \cup {s}
  /\ pend' = [pend EXCEPT ![s] = {}] /\ told' = [told EXCEPT ![s] = {}]
  /\ fsent' = IF s = Owner THEN [t \in Servers |-> {}] ELSE [fsent EXCEPT ![s] = {}]
  /\ sent' = [o \in Origins |-> IF att[o] = s THEN {} ELSE sent[o]]
  /\ half' = IF s = Owner THEN {} ELSE half    \* norc stays: those receipts are never written
  /\ net' = {m \in net : ~Touches(m, s)}
  /\ UNCHANGED <<log, cxl, ver, logId, norc, fwd, cut, know, revoked, att, ep, fl, ctr, nIss, box, cx, shown, seen,
                 ghosts, nRewind, nLoss, nDup, nSwitch, nPart,
                 nCancel, nRevoke, nBump, nWipe>>
Restart(s) ==
  /\ s \in down /\ down' = down \ {s}
  /\ UNCHANGED <<owner, fwd, pend, told, fsent, cut, know, revoked, net, fes, ghosts, budget>>

Partition(s) ==
  /\ s \in Others /\ s \notin cut /\ nPart < MaxPart /\ nPart' = nPart + 1 /\ cut' = cut \cup {s}
  /\ fsent' = [fsent EXCEPT ![s] = {}]
  /\ net' = {m \in net : ~(Touches(m, s) /\ Touches(m, Owner))}
  /\ UNCHANGED <<owner, fwd, pend, told, down, know, revoked, fes, ghosts, nCrash, nRewind, nLoss, nDup,
                 nSwitch, nCancel, nRevoke, nBump, nWipe>>
Heal(s) ==
  /\ s \in cut /\ cut' = cut \ {s}
  /\ UNCHANGED <<owner, fwd, pend, told, fsent, down, know, revoked, net, fes, ghosts, budget>>

\* A frame is lost: its session breaks, and both ends send again what they had sent on it.
Lose(m) ==
  /\ m \in net /\ nLoss < MaxLoss /\ nLoss' = nLoss + 1
  /\ LET fe == IF m.t \in {"cmd", "cxl"} THEN m.from = None ELSE m.to \in Origins
          srv == IF m.t \in {"cmd", "cxl"} THEN m.from ELSE m.to
          \* P1: the FE's frames to that server after m went on the same broken session
          later == IF fe /\ m.t \in {"cmd", "cxl"} /\ Bug # "unordered"
                   THEN {x \in net : x.t \in {"cmd", "cxl"} /\ x.from = None /\ x.o = m.o /\ x.to = m.to}
                   ELSE {}
      IN /\ net' = net \ ({m} \cup later)
         /\ sent' = IF fe THEN [sent EXCEPT ![m.o] = {}] ELSE sent
         /\ fsent' = IF ~fe /\ srv \in Others THEN [fsent EXCEPT ![srv] = {}] ELSE fsent
  /\ UNCHANGED <<owner, fwd, pend, told, down, cut, know, revoked, att, ep, fl, ctr, nIss, box, cx, shown, seen,
                 ghosts, nCrash, nRewind, nDup, nSwitch, nPart, nCancel, nRevoke, nBump, nWipe>>

\* A device is revoked at some server; others hear of it later (Learn).
Revoke(o, s) ==
  /\ nRevoke < MaxRevoke /\ o \notin revoked /\ nRevoke' = nRevoke + 1
  /\ revoked' = revoked \cup {o} /\ know' = [know EXCEPT ![s] = @ \cup {o}]
  /\ UNCHANGED <<owner, fwd, pend, told, fsent, down, cut, net, fes, ghosts, nCrash, nRewind, nLoss, nDup, nSwitch, nPart,
                 nCancel, nBump, nWipe>>
Learn(s, o) ==
  /\ o \in revoked /\ o \notin know[s] /\ know' = [know EXCEPT ![s] = @ \cup {o}]
  /\ UNCHANGED <<owner, fwd, pend, told, fsent, down, cut, revoked, net, fes, ghosts, budget>>

-----------------------------------------------------------------------------
(* Plugin hot swap on the FE (P7) *)

Dest(o) == IF subd[o] THEN inst[o] ELSE Shell

\* SeeOutcome, plus the hand-off of the outcome to the plugin's instance or the shell.
SeeOutcomeP(o, m) ==
  /\ SeeOutcome(o, m)
  /\ IF MaxSwap = 0
       THEN toldTo' = [toldTo EXCEPT ![o] = @ \cup {<<<<m.e, m.n>>, Dest(o)>>}] /\ UNCHANGED note
       ELSE note' = [note EXCEPT ![o] = @ \cup {<<m.e, m.n>>}] /\ UNCHANGED toldTo
  /\ UNCHANGED <<inst, subd, nSwap>>

Deliver(o, sl) ==
  /\ sl \in note[o] /\ note' = [note EXCEPT ![o] = @ \ {sl}]
  /\ toldTo' = [toldTo EXCEPT ![o] = @ \cup {<<sl, Dest(o)>>}]
  /\ UNCHANGED <<owner, servers, net, fes, ghosts, budget, inst, subd, nSwap>>

\* New code for the plugin: a new instance; the outbox stays (Bug "instanceowned": the items go with the old
\* instance; Bug "resendonswap": the new instance issues an unresolved item of its predecessor again in a new slot).
PluginSwap(o) ==
  /\ nSwap < MaxSwap /\ nSwap' = nSwap + 1
  /\ inst' = [inst EXCEPT ![o] = @ + 1] /\ subd' = [subd EXCEPT ![o] = FALSE]
  /\ IF Bug = "instanceowned"
       THEN box' = [box EXCEPT ![o] = {}] /\ cx' = [cx EXCEPT ![o] = {}] /\ UNCHANGED <<ctr, shown>>
       ELSE IF Bug = "resendonswap" /\ box[o] # {} /\ ctr[o] <= MaxN
         THEN \E it \in box[o] :
                /\ box' = [box EXCEPT ![o] = @ \cup {[it EXCEPT !.n = ctr[o], !.b = ver]}]
                /\ shown' = [shown EXCEPT ![o][<<it.e, ctr[o]>>] = "waiting"]
                /\ ctr' = [ctr EXCEPT ![o] = @ + 1] /\ UNCHANGED cx
         ELSE UNCHANGED <<box, cx, ctr, shown>>
  /\ UNCHANGED <<owner, servers, net, att, ep, fl, nIss, sent, seen, ghosts, budget, note, toldTo>>

\* The new instance subscribes to the plugin's outcomes (it may never).
Subscribe(o) ==
  /\ ~subd[o] /\ subd' = [subd EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<owner, servers, net, fes, ghosts, budget, inst, note, toldTo, nSwap>>

-----------------------------------------------------------------------------

BaseNext ==
  \/ \E o \in Origins :
       \/ \E h \in Contents : Issue(o, h)
       \/ \E it \in box[o] : Send(o, it) \/ Cancel(o, it) \/ Timeout(o, it)
       \/ \E n \in cx[o] : SendCancel(o, n)
       \/ \E m \in net : SeeHeld(o, m) \/ SeeReset(o, m) \/ DropResult(o, m)
       \/ \E s \in Servers : Switch(o, s) \/ Revoke(o, s) \/ Learn(s, o)
       \/ FeStorageLoss(o)
  \/ \E s \in Servers :
       \/ \E m \in net : Hold(s, m) \/ Relay(s, m)
       \/ \E x \in pend[s] : CommitHold(s, x)
       \/ \E x \in fwd[s] : HeldReply(s, x) \/ Forward(s, x) \/ DropRevoked(s, x)
       \/ Crash(s) \/ Restart(s) \/ Partition(s) \/ Heal(s)
  \/ \E m \in net : Apply(m) \/ ApplyCancel(m) \/ Lose(m)
  \/ \E sl \in half : WriteReceipt(sl)
  \/ Bump \/ OwnerRewind

Next ==
  \/ BaseNext /\ UNCHANGED plug
  \/ \E o \in Origins :
       \/ \E m \in net : SeeOutcomeP(o, m)
       \/ PluginSwap(o) \/ Subscribe(o) \/ \E sl \in note[o] : Deliver(o, sl)

\* Fairness: the protocol's own steps; none on Lose, Dup, Crash, Partition, Switch, Cancel, Revoke, Bump,
\* OwnerRewind, FeStorageLoss, Issue, PluginSwap, Subscribe. Partitions heal and crashed servers restart (WF on Heal, Restart).
Fairness ==
  /\ \A o \in Origins :
       /\ WF_bvars(\E it \in box[o] : Send(o, it)) /\ WF_bvars(\E n \in cx[o] : SendCancel(o, n))
       /\ WF_bvars(\E m \in net : SeeOutcomeP(o, m)) /\ WF_bvars(\E m \in net : SeeHeld(o, m))
       /\ WF_vars(\E sl \in note[o] : Deliver(o, sl))
       /\ WF_bvars(\E m \in net : SeeReset(o, m)) /\ WF_bvars(\E m \in net : DropResult(o, m))
  /\ \A s \in Servers :
       /\ WF_bvars(\E m \in net : Hold(s, m)) /\ WF_bvars(\E m \in net : Relay(s, m))
       /\ WF_bvars(\E x \in pend[s] : CommitHold(s, x))
       /\ WF_bvars(\E x \in fwd[s] : HeldReply(s, x)) /\ WF_bvars(\E x \in fwd[s] : Forward(s, x))
       /\ WF_bvars(\E x \in fwd[s] : DropRevoked(s, x))
       /\ WF_bvars(Restart(s)) /\ WF_bvars(Heal(s))
       /\ \A o \in Origins : WF_bvars(Learn(s, o))
  /\ WF_bvars(\E m \in net : Apply(m)) /\ WF_bvars(\E m \in net : ApplyCancel(m))
  /\ WF_bvars(\E sl \in half : WriteReceipt(sl))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* Within the current log incarnation (checked in every state, so in every incarnation while it is current).
AppliedOncePerIncarnation ==
  \A o \in Origins, e \in Eps, n \in Ns : Cardinality({r \in log : r.o = o /\ r.e = e /\ r.n = n /\ r.k = "applied"}) <= 1
OneOutcome == \A o \in Origins, e \in Eps, n \in Ns : Cardinality(RecOf(o, e, n)) <= 1
FifoPerOrigin == \A r \in log : r.n > 1 => Has(r.o, r.e, r.n - 1)
\* A slot whose outcome an FE saw is never applied again (floor and receipts across OwnerRewind).
SeenNeverReapplied == ~reapp
\* P7: one intent (the ghost id u of the user's act) is applied at most once, whatever slots carry it.
IntentAppliedOnce == \A u \in Uids : Cardinality({r \in log : r.u = u /\ r.k = "applied"}) <= 1
\* The outcome an FE takes for a slot answers the command it issued in that slot.
NoSilentDuplicate == \A o \in Origins : \A x \in seen[o] : x.ru = x.iu
\* Delivery states the UI shows are facts: held = a server holds it (or it has an outcome); delivered = applied;
\* not sent = cancelled, refused, changed or skipped (in the incarnation the FE heard from).
\* (After OwnerRewind "it has an outcome" may hold only of an earlier incarnation: the history-restored banner.)
HeldTrue(o, e, n) ==
  \/ \E s \in Servers : \E x \in fwd[s] : x.t = "cmd" /\ x.o = o /\ x.e = e /\ x.n = n
  \/ \E it \in box[o] : it.e = e /\ it.n = n /\ it.u \in everApp \cup everNot
SeenOf(o, sl) == {x \in seen[o] : x.e = sl[1] /\ x.n = sl[2]}
TruthfulUI ==
  \A o \in Origins : \A sl \in Eps \X Ns :
    /\ shown[o][sl] = "held" => HeldTrue(o, sl[1], sl[2]) \/ fl[o] < logId   \* or a restore it has not heard of
                                    \/ o \in revoked   \* v1 4.5: its rows are dropped; the page is closed
    /\ shown[o][sl] = "delivered" => \E x \in SeenOf(o, sl) : x.k = "applied" /\ x.iu \in everApp
    /\ shown[o][sl] = "notSent" => \E x \in SeenOf(o, sl) : x.k \in NotSentOuts /\ (x.iu \in everNot \/ x.k = "skipped")
\* Action properties (they talk about the step that appends a record):
NewApplied == {r \in log' : r.k = "applied"} \ {r \in log : r.k = "applied"}
\* An owner that knows a device is revoked applies nothing new of it.
NoApplyAfterRevoke == [][\A r \in NewApplied : r.o \notin know[Owner]]_vars
\* An applied act on a visible thing ran against the version the user saw (D15).
NoActOnChanged == [][\A r \in NewApplied : r.b = ver]_vars
\* shown never moves back from delivered / not sent (until the FE storage itself is lost).
ShownFinal == [][\A o \in Origins : \A sl \in Eps \X Ns :
                  (shown[o][sl] \in {"delivered", "notSent"} /\ ep'[o] = ep[o] /\ ctr'[o] >= ctr[o])
                    => shown'[o][sl] = shown[o][sl]]_vars

\* Liveness
InBox(o, e, n) == \E it \in box[o] : it.e = e /\ it.n = n
Outcome == \A o \in Origins, e \in Eps, n \in Ns : InBox(o, e, n) ~> (~InBox(o, e, n) \/ o \in revoked)
InFwd(s, o, e, n) == \E x \in fwd[s] : x.o = o /\ x.e = e /\ x.n = n
\* Every forward-queue item leaves, also one of an older origin epoch (its storage was wiped: 11.4, not fenced).
QueueDrains == \A s \in Others, o \in Origins, e \in Eps, n \in Ns : InFwd(s, o, e, n) ~> (~InFwd(s, o, e, n) \/ o \in revoked)
\* Every behavior settles: no command left waiting in a browser, no queue item left at a server, except for a revoked
\* device.
Quiet == \A o \in Origins : o \in revoked \/ (box[o] = {} /\ \A s \in Others : \A x \in fwd[s] : x.o # o)
Settles == <>[]Quiet
\* P7: every outbox item's outcome reaches the plugin's live instance or the shell (unless the device is revoked or
\* the browser storage, and with it the item, is gone: a new origin epoch).
Told(o, sl) == \E d \in Dests : <<sl, d>> \in toldTo[o]
OutcomeShown == \A o \in Origins, e \in Eps, n \in Ns :
                  InBox(o, e, n) ~> (Told(o, <<e, n>>) \/ o \in revoked \/ ep[o] # e)
=============================================================================
