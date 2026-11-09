------------------------------- MODULE LanPair -------------------------------
(* QR pairing for the phone bridge on the home network (desktop/src/mobile-bridge/pairing.ts PairingStore). *)
(* The offers (pairing-offers.json: secret hashes with a TTL) and the paired phones (paired-clients.json)   *)
(* are files shared by every process that opens the pairing folder: the core (two for a moment during a    *)
(* hand-over), the local `pair` command (pair-cli.ts). Each change reads a file and writes it back whole   *)
(* (writeFileAtomic) under that file's lock (withFileLock); redeem holds the offers lock and takes the     *)
(* paired lock inside it. One step is one file read or write:                                              *)
(*   BeginCreate/Create    createOffer: read the offers, write them back with the new one                  *)
(*   BeginTake             redeem: read the offers                                                         *)
(*   BeginSweep/Sweep      redeem, when a held code's ack deadline has passed: read the paired phones,     *)
(*                         write them back without those codes' phones                                     *)
(*   Take                  redeem: write the offers back with those codes listed again and the matched one *)
(*                         held for this phone (its token's hash and the ack deadline, PAIR_ACK_MS)        *)
(*   BeginIssue/Issue      redeem: read the paired phones, write them back with this phone                 *)
(*   Answer                redeem: let go of the offers lock and answer the phone with its token           *)
(*   BeginAck/Ack          the phone's ack (POST /api/mobile/pair/ack with its token): under the offers     *)
(*                         lock, a hold for it before its deadline leaves the list: the pairing is final    *)
(*   BeginRevoke/Revoke    revoke: read the paired phones, write them back without this one                *)
(* The pairing is final exactly when its hold is gone: one write of one file. Until then the phone's record *)
(* is served before the deadline and skipped after it (the bridge reads pairing-offers.json, then           *)
(* paired-clients.json, on every request). A deadline passing (Due) writes nothing; the next redeem gives   *)
(* the code back, after removing the phone's record. A process may die at any step; its lock stays until   *)
(* another breaks it (its pid is gone). An answer may be lost on the way to the phone. The lock is assumed  *)
(* to be held only by a live process for less than staleMs (10 s), so breaking only removes a dead          *)
(* holder's lock.                                                                                           *)
(* Bug = "nolock": the files are read and written without the locks: two redeems both take one code.       *)
(* Bug = "noAck":  redeem as it was before the ack (and as it still is for a phone that does not ask for    *)
(*   it): Take removes the code, so a core that dies before answering or a lost answer spends the code and  *)
(*   the phone holds no token (CodeReachesPhone fails).                                                     *)
EXTENDS Naturals, FiniteSets

CONSTANTS Procs,   \* processes that open the pairing folder
          Phones,  \* phones (their device ids); each scans once
          Codes,   \* pairing secrets
          None,
          Bug      \* "none", "nolock" or "noAck"

Sts == {"idle", "create", "sweep", "sweeping", "take", "issue", "issuing", "answer", "ack", "revoke", "dead"}
Gots == {"none", "asking", "token", "acking", "paired", "late", "invalid", "lost"}
\* What pairing-offers.json says of a code: not listed, listed, or held for a phone (taken by its redeem).
Marks == {"no", "live"} \cup Phones

VARIABLES
  ofile,    \* pairing-offers.json
  made,     \* codes created so far
  exp,      \* codes whose TTL has passed
  clients,  \* paired-clients.json: the phones listed
  due,      \* phones whose ack deadline has passed (time)
  lockO,    \* who holds pairing-offers.json.lock
  lockP,    \* who holds paired-clients.json.lock
  st,       \* each process: what it is doing
  who,      \* the phone it is redeeming, acking or revoking for
  sc,       \* the code it is creating or redeeming
  so,       \* the offers as it read them
  sp,       \* the paired phones as it read them
  sw,       \* the phones whose holds it is giving back (their deadline passed)
  got,      \* each phone: where its pairing is ("token": holds a token, its ack not answered yet)
  via,      \* each phone: the code its redeem took (ghost)
  bound,    \* per code, the phones whose pairing became final (ghost)
  rv        \* phones revoked since they were last paired (ghost)

vars == <<ofile, made, exp, clients, due, lockO, lockP, st, who, sc, so, sp, sw, got, via, bound, rv>>

NoAck == Bug = "noAck"

TypeOK ==
  /\ ofile \in [Codes -> Marks] /\ made \subseteq Codes /\ exp \subseteq Codes
  /\ clients \subseteq Phones /\ due \subseteq Phones
  /\ lockO \in Procs \cup {None} /\ lockP \in Procs \cup {None}
  /\ st \in [Procs -> Sts] /\ who \in [Procs -> Phones \cup {None}] /\ sc \in [Procs -> Codes \cup {None}]
  /\ so \in [Procs -> [Codes -> Marks]] /\ sp \in [Procs -> SUBSET Phones] /\ sw \in [Procs -> SUBSET Phones]
  /\ got \in [Phones -> Gots] /\ via \in [Phones -> Codes \cup {None}]
  /\ bound \in [Codes -> SUBSET Phones] /\ rv \subseteq Phones

Init ==
  /\ ofile = [c \in Codes |-> "no"] /\ made = {} /\ exp = {} /\ clients = {} /\ due = {}
  /\ lockO = None /\ lockP = None
  /\ st = [q \in Procs |-> "idle"] /\ who = [q \in Procs |-> None] /\ sc = [q \in Procs |-> None]
  /\ so = [q \in Procs |-> [c \in Codes |-> "no"]] /\ sp = [q \in Procs |-> {}] /\ sw = [q \in Procs |-> {}]
  /\ got = [f \in Phones |-> "none"] /\ via = [f \in Phones |-> None]
  /\ bound = [c \in Codes |-> {}] /\ rv = {}

Free(l) == Bug = "nolock" \/ l = None
Hold(q) == IF Bug = "nolock" THEN None ELSE q
Let(l, q) == IF l = q THEN None ELSE l
Go(q, s) == st' = [st EXCEPT ![q] = s]
\* A code is held for this phone (in the offers as `m` says).
Held(m, f) == \E c \in Codes : m[c] = f
\* The bridge serves the phone: listed, and not held past its deadline.
Served(f) == f \in clients /\ ~(Held(ofile, f) /\ f \in due)

-----------------------------------------------------------------------------

\* createOffer (the `pair` command, or Settings › Phone through the core). Held codes stay listed.
BeginCreate(q, c) ==
  /\ st[q] = "idle" /\ c \notin made /\ Free(lockO)
  /\ lockO' = Hold(q) /\ so' = [so EXCEPT ![q] = ofile] /\ sc' = [sc EXCEPT ![q] = c] /\ Go(q, "create")
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockP, who, sp, sw, got, via, bound, rv>>

Create(q) ==
  /\ st[q] = "create"
  /\ ofile' = [so[q] EXCEPT ![sc[q]] = "live"] /\ made' = made \cup {sc[q]}
  /\ lockO' = Let(lockO, q) /\ Go(q, "idle") /\ sc' = [sc EXCEPT ![q] = None]
  /\ UNCHANGED <<exp, clients, due, lockP, who, so, sp, sw, got, via, bound, rv>>

\* A phone posts the secret from the QR code (a code it scanned, still listed or not) to a core. Held codes
\* past their deadline are given back first (Sweep, then Take).
BeginTake(q, f, c) ==
  /\ st[q] = "idle" /\ got[f] = "none" /\ c \in made /\ Free(lockO)
  /\ LET late == {g \in Phones : Held(ofile, g) /\ g \in due} IN
       /\ sw' = [sw EXCEPT ![q] = late] /\ Go(q, IF late = {} THEN "take" ELSE "sweep")
  /\ lockO' = Hold(q) /\ so' = [so EXCEPT ![q] = ofile]
  /\ who' = [who EXCEPT ![q] = f] /\ sc' = [sc EXCEPT ![q] = c] /\ got' = [got EXCEPT ![f] = "asking"]
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockP, sp, via, bound, rv>>

BeginSweep(q) ==
  /\ st[q] = "sweep" /\ Free(lockP)
  /\ lockP' = Hold(q) /\ sp' = [sp EXCEPT ![q] = clients] /\ Go(q, "sweeping")
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockO, who, sc, so, sw, got, via, bound, rv>>

\* The records of phones whose ack did not come in time leave paired-clients.json (before their codes are
\* listed again, so a crash in between never leaves such a record served).
Sweep(q) ==
  /\ st[q] = "sweeping"
  /\ clients' = (IF sp[q] \cap sw[q] # {} THEN sp[q] \ sw[q] ELSE clients)
  /\ lockP' = Let(lockP, q) /\ Go(q, "take")
  /\ UNCHANGED <<ofile, made, exp, due, lockO, who, sc, so, sp, sw, got, via, bound, rv>>

\* Swept holds are listed again; the matched code is held for this phone ("noAck": leaves the list); written
\* only when something changed. No match (unknown, held, expired): invalid.
Take(q) ==
  /\ st[q] = "take"
  /\ LET c == sc[q]
         back == [x \in Codes |-> IF so[q][x] \in sw[q] THEN "live" ELSE so[q][x]]
         match == back[c] = "live" /\ c \notin exp
         next == IF match THEN [back EXCEPT ![c] = IF NoAck THEN "no" ELSE who[q]] ELSE back
     IN /\ ofile' = (IF next # so[q] THEN next ELSE ofile)
        /\ IF match
             THEN Go(q, "issue") /\ via' = [via EXCEPT ![who[q]] = c] /\ UNCHANGED <<lockO, got, who, sc>>
             ELSE /\ Go(q, "idle") /\ lockO' = Let(lockO, q) /\ UNCHANGED via
                  /\ got' = [got EXCEPT ![who[q]] = "invalid"]
                  /\ who' = [who EXCEPT ![q] = None] /\ sc' = [sc EXCEPT ![q] = None]
  /\ UNCHANGED <<made, exp, clients, due, lockP, so, sp, sw, bound, rv>>

BeginIssue(q) ==
  /\ st[q] = "issue" /\ Free(lockP)
  /\ lockP' = Hold(q) /\ sp' = [sp EXCEPT ![q] = clients] /\ Go(q, "issuing")
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockO, who, sc, so, sw, got, via, bound, rv>>

\* This phone's record (one per device); "noAck": the pairing is final here.
Issue(q) ==
  /\ st[q] = "issuing"
  /\ clients' = sp[q] \cup {who[q]}
  /\ bound' = IF NoAck THEN [bound EXCEPT ![sc[q]] = @ \cup {who[q]}] ELSE bound
  /\ rv' = rv \ {who[q]}
  /\ lockP' = Let(lockP, q) /\ Go(q, "answer")
  /\ UNCHANGED <<ofile, made, exp, due, lockO, who, sc, so, sp, sw, got, via>>

\* The offers lock is let go and the token sent: it reaches the phone, or the answer is lost.
Answer(q) ==
  /\ st[q] = "answer"
  /\ \E r \in {IF NoAck THEN "paired" ELSE "token", "lost"} : got' = [got EXCEPT ![who[q]] = r]
  /\ lockO' = Let(lockO, q) /\ Go(q, "idle")
  /\ who' = [who EXCEPT ![q] = None] /\ sc' = [sc EXCEPT ![q] = None]
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockP, so, sp, sw, via, bound, rv>>

\* The phone acknowledges its token (to any process); it asks again if the answer does not come.
BeginAck(q, f) ==
  /\ st[q] = "idle" /\ got[f] = "token" /\ Free(lockO)
  /\ lockO' = Hold(q) /\ so' = [so EXCEPT ![q] = ofile]
  /\ who' = [who EXCEPT ![q] = f] /\ got' = [got EXCEPT ![f] = "acking"] /\ Go(q, "ack")
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockP, sc, sp, sw, via, bound, rv>>

\* Its hold, before the deadline and with its record listed (read without the paired lock): leaves the list,
\* and the pairing is final. No hold but listed: final already (an answer that was lost). Else too late: the
\* phone scans the code again (the next redeem gives it back).
Ack(q) ==
  /\ st[q] = "ack"
  /\ LET f == who[q] IN
       IF Held(so[q], f) /\ f \notin due /\ f \in clients
         THEN /\ ofile' = [c \in Codes |-> IF so[q][c] = f THEN "no" ELSE so[q][c]]
              /\ bound' = [bound EXCEPT ![via[f]] = @ \cup {f}] /\ got' = [got EXCEPT ![f] = "paired"]
         ELSE /\ got' = [got EXCEPT ![f] = IF ~Held(so[q], f) /\ f \in clients THEN "paired" ELSE "late"]
              /\ UNCHANGED <<ofile, bound>>
  /\ lockO' = Let(lockO, q) /\ Go(q, "idle") /\ who' = [who EXCEPT ![q] = None]
  /\ UNCHANGED <<made, exp, clients, due, lockP, sc, so, sp, sw, via, rv>>

\* revoke (the `pair` command, or Settings › Phone) of a phone they list.
BeginRevoke(q, f) ==
  /\ st[q] = "idle" /\ f \in clients /\ Free(lockP)
  /\ lockP' = Hold(q) /\ sp' = [sp EXCEPT ![q] = clients] /\ who' = [who EXCEPT ![q] = f] /\ Go(q, "revoke")
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockO, sc, so, sw, got, via, bound, rv>>

\* Written only when the phone was listed.
Revoke(q) ==
  /\ st[q] = "revoke"
  /\ IF who[q] \in sp[q]
       THEN clients' = sp[q] \ {who[q]} /\ rv' = rv \cup {who[q]}
       ELSE UNCHANGED <<clients, rv>>
  /\ lockP' = Let(lockP, q) /\ Go(q, "idle") /\ who' = [who EXCEPT ![q] = None]
  /\ UNCHANGED <<ofile, made, exp, due, lockO, sc, so, sp, sw, got, via, bound>>

\* A process dies at any step (its phone sees the request fail; an ack is asked again); its locks stay behind.
Crash(q) ==
  /\ st[q] \notin {"idle", "dead"} /\ Go(q, "dead")
  /\ got' = CASE st[q] \in {"sweep", "sweeping", "take", "issue", "issuing", "answer"} -> [got EXCEPT ![who[q]] = "lost"]
              [] st[q] = "ack" -> [got EXCEPT ![who[q]] = "token"]
              [] OTHER -> got
  /\ UNCHANGED <<ofile, made, exp, clients, due, lockO, lockP, who, sc, so, sp, sw, via, bound, rv>>

\* Another process finds a lock whose holder is gone and removes it.
BreakO == lockO \in Procs /\ st[lockO] = "dead" /\ lockO' = None
          /\ UNCHANGED <<ofile, made, exp, clients, due, lockP, st, who, sc, so, sp, sw, got, via, bound, rv>>
BreakP == lockP \in Procs /\ st[lockP] = "dead" /\ lockP' = None
          /\ UNCHANGED <<ofile, made, exp, clients, due, lockO, st, who, sc, so, sp, sw, got, via, bound, rv>>

Expire(c) == c \in made /\ c \notin exp /\ exp' = exp \cup {c}
             /\ UNCHANGED <<ofile, made, clients, due, lockO, lockP, st, who, sc, so, sp, sw, got, via, bound, rv>>

\* The ack deadline of a phone whose redeem took a code passes.
Due(f) == ~NoAck /\ via[f] # None /\ f \notin due /\ due' = due \cup {f}
          /\ UNCHANGED <<ofile, made, exp, clients, lockO, lockP, st, who, sc, so, sp, sw, got, via, bound, rv>>

Step(q) == Create(q) \/ BeginSweep(q) \/ Sweep(q) \/ Take(q) \/ BeginIssue(q) \/ Issue(q) \/ Answer(q) \/ Ack(q) \/ Revoke(q)

Next ==
  \/ \E q \in Procs : \/ Step(q) \/ Crash(q)
                      \/ \E c \in Codes : BeginCreate(q, c)
                      \/ \E f \in Phones : \/ BeginRevoke(q, f) \/ BeginAck(q, f)
                                           \/ \E c \in Codes : BeginTake(q, f, c)
  \/ BreakO \/ BreakP
  \/ \E c \in Codes : Expire(c)
  \/ \E f \in Phones : Due(f)

\* A process that began goes on; a dead holder's lock is broken. Asking, acking, revoking, crashing, expiry and
\* deadlines are not forced. withFileLock polls until the lock is free, so a redeem waiting for
\* paired-clients.json gets it even while other changes keep taking it in between (strong fairness).
Fairness == /\ \A q \in Procs : WF_vars(Step(q)) /\ SF_vars(BeginSweep(q)) /\ SF_vars(BeginIssue(q))
            /\ WF_vars(BreakO) /\ WF_vars(BreakP)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety. *)

\* A code makes at most one pairing final, and the bridge serves at most one phone paired with it.
SingleUse == \A c \in Codes : /\ Cardinality(bound[c]) <= 1
                              /\ Cardinality({f \in Phones : via[f] = c /\ Served(f)}) <= 1

\* A revoked phone stays off the list (and so is not served) until it pairs again.
RevokeSticks == rv \cap clients = {}

\* The phone holds its token (or is asking whether its ack arrived).
Holding == {"token", "acking", "paired"}
\* A code made and not expired is listed, is held (before its deadline, or given back by the next redeem), is
\* being redeemed ("noAck"), or went to a phone that holds the token (or was revoked since).
\* LanPair_noack.cfg: without the ack it fails.
CodeReachesPhone ==
  \A c \in made :
    \/ c \in exp \/ ofile[c] = "live" \/ ofile[c] \in Phones
    \/ \E q \in Procs : st[q] \in {"issue", "issuing", "answer"} /\ sc[q] = c
    \/ \E f \in bound[c] : got[f] \in Holding \/ f \in rv

\* A phone told its pairing is final is served, until it is revoked.
PairedServed == \A f \in Phones : got[f] = "paired" /\ f \notin rv => Served(f)

(* Liveness. *)

\* A phone that posted a code is answered: a token, invalid, or the request failed (no lock is held forever).
Answered == \A f \in Phones : got[f] = "asking" ~> got[f] \in {"token", "paired", "invalid", "lost"}

\* An ack is answered: final, too late, or failed (and asked again).
AckAnswered == \A f \in Phones : got[f] = "acking" ~> got[f] \in {"paired", "late", "token"}
=============================================================================
