------------------------------- MODULE LanPair -------------------------------
(* QR pairing for the phone bridge on the home network (desktop/src/mobile-bridge/pairing.ts PairingStore). *)
(* The offers (pairing-offers.json: secret hashes with a TTL) and the paired phones (paired-clients.json)   *)
(* are files shared by every process that opens the pairing folder: the core (two for a moment during a    *)
(* hand-over), the local `pair` command (pair-cli.ts). Each change reads a file and writes it back whole   *)
(* (writeFileAtomic) under that file's lock (withFileLock); redeem holds the offers lock and takes the     *)
(* paired lock inside it. One step is one file read or write:                                              *)
(*   BeginCreate/Create    createOffer: read the offers, write them back with the new one                  *)
(*   BeginTake/Take        redeem: read the offers, write them back without the matched (or expired) ones  *)
(*   BeginIssue/Issue      redeem: read the paired phones, write them back with this phone (one per device)*)
(*   Answer                redeem: let go of the offers lock and answer the phone with its token           *)
(*   BeginRevoke/Revoke    revoke: read the paired phones, write them back without this one                *)
(* The bridge reads paired-clients.json on every request, so a phone is served exactly while it is listed. *)
(* A process may die at any step; its lock stays until another breaks it (its pid is gone). The answer may *)
(* be lost on the way to the phone. The lock is assumed to be held only by a live process for less than    *)
(* staleMs (10 s), so breaking only ever removes a dead holder's lock.                                     *)
(* Bug = "nolock": the files are read and written without the locks: two redeems both take one code.       *)
EXTENDS Naturals, FiniteSets

CONSTANTS Procs,   \* processes that open the pairing folder
          Phones,  \* phones (their device ids)
          Codes,   \* pairing secrets
          None,
          Bug      \* "none" or "nolock"

Sts == {"idle", "create", "take", "issue", "issuing", "answer", "revoke", "dead"}

VARIABLES
  offers,   \* pairing-offers.json: the codes listed
  made,     \* codes created so far
  exp,      \* codes whose TTL has passed
  clients,  \* paired-clients.json: the phones listed
  lockO,    \* who holds pairing-offers.json.lock
  lockP,    \* who holds paired-clients.json.lock
  st,       \* each process: what it is doing
  who,      \* the phone it is redeeming or revoking for
  sc,       \* the code it is creating or redeeming
  snap,     \* what it read from the file it is changing
  got,      \* each phone: "none", "asking", "token", "invalid" or "lost"
  issued,   \* per code, the phones given a token for it (ghost)
  taken,    \* per code, the phone whose redeem took it off the list (None: not taken) (ghost)
  rv        \* phones revoked since they were last paired (ghost)

vars == <<offers, made, exp, clients, lockO, lockP, st, who, sc, snap, got, issued, taken, rv>>

TypeOK ==
  /\ offers \subseteq Codes /\ made \subseteq Codes /\ exp \subseteq Codes /\ clients \subseteq Phones
  /\ lockO \in Procs \cup {None} /\ lockP \in Procs \cup {None}
  /\ st \in [Procs -> Sts] /\ who \in [Procs -> Phones \cup {None}] /\ sc \in [Procs -> Codes \cup {None}]
  /\ snap \in [Procs -> SUBSET (Codes \cup Phones)]
  /\ got \in [Phones -> {"none", "asking", "token", "invalid", "lost"}]
  /\ issued \in [Codes -> SUBSET Phones] /\ taken \in [Codes -> Phones \cup {None}] /\ rv \subseteq Phones

Init ==
  /\ offers = {} /\ made = {} /\ exp = {} /\ clients = {}
  /\ lockO = None /\ lockP = None
  /\ st = [q \in Procs |-> "idle"] /\ who = [q \in Procs |-> None] /\ sc = [q \in Procs |-> None]
  /\ snap = [q \in Procs |-> {}]
  /\ got = [f \in Phones |-> "none"] /\ issued = [c \in Codes |-> {}] /\ taken = [c \in Codes |-> None] /\ rv = {}

Free(l) == Bug = "nolock" \/ l = None
Hold(q) == IF Bug = "nolock" THEN None ELSE q
Go(q, s) == st' = [st EXCEPT ![q] = s]

-----------------------------------------------------------------------------

\* createOffer (the `pair` command, or Settings › Phone through the core).
BeginCreate(q, c) ==
  /\ st[q] = "idle" /\ c \notin made /\ Free(lockO)
  /\ lockO' = Hold(q) /\ snap' = [snap EXCEPT ![q] = offers] /\ sc' = [sc EXCEPT ![q] = c] /\ Go(q, "create")
  /\ UNCHANGED <<offers, made, exp, clients, lockP, who, got, issued, taken, rv>>

Create(q) ==
  /\ st[q] = "create"
  /\ offers' = (snap[q] \ exp) \cup {sc[q]} /\ made' = made \cup {sc[q]}
  /\ lockO' = (IF lockO = q THEN None ELSE lockO) /\ Go(q, "idle") /\ sc' = [sc EXCEPT ![q] = None]
  /\ UNCHANGED <<exp, clients, lockP, who, snap, got, issued, taken, rv>>

\* A phone posts the secret from the QR code (a code it scanned, still listed or not) to a core.
BeginTake(q, f, c) ==
  /\ st[q] = "idle" /\ got[f] = "none" /\ c \in made /\ Free(lockO)
  /\ lockO' = Hold(q) /\ snap' = [snap EXCEPT ![q] = offers]
  /\ who' = [who EXCEPT ![q] = f] /\ sc' = [sc EXCEPT ![q] = c] /\ got' = [got EXCEPT ![f] = "asking"]
  /\ Go(q, "take")
  /\ UNCHANGED <<offers, made, exp, clients, lockP, issued, taken, rv>>

\* The matched code and expired ones leave the list (written only when something left); no match: invalid.
Take(q) ==
  /\ st[q] = "take"
  /\ LET match == sc[q] \in snap[q] /\ sc[q] \notin exp
         live == {c \in snap[q] : c \notin exp /\ ~(match /\ c = sc[q])}
     IN /\ offers' = (IF live # snap[q] THEN live ELSE offers)
        /\ IF match
             THEN Go(q, "issue") /\ taken' = [taken EXCEPT ![sc[q]] = who[q]] /\ UNCHANGED <<lockO, got, who, sc>>
             ELSE /\ Go(q, "idle") /\ lockO' = (IF lockO = q THEN None ELSE lockO) /\ UNCHANGED taken
                  /\ got' = [got EXCEPT ![who[q]] = "invalid"]
                  /\ who' = [who EXCEPT ![q] = None] /\ sc' = [sc EXCEPT ![q] = None]
  /\ UNCHANGED <<made, exp, clients, lockP, snap, issued, rv>>

BeginIssue(q) ==
  /\ st[q] = "issue" /\ Free(lockP)
  /\ lockP' = Hold(q) /\ snap' = [snap EXCEPT ![q] = clients] /\ Go(q, "issuing")
  /\ UNCHANGED <<offers, made, exp, clients, lockO, who, sc, got, issued, taken, rv>>

Issue(q) ==
  /\ st[q] = "issuing"
  /\ clients' = snap[q] \cup {who[q]} /\ issued' = [issued EXCEPT ![sc[q]] = @ \cup {who[q]}]
  /\ rv' = rv \ {who[q]}
  /\ lockP' = (IF lockP = q THEN None ELSE lockP) /\ Go(q, "answer")
  /\ UNCHANGED <<offers, made, exp, lockO, who, sc, snap, got, taken>>

\* The offers lock is let go and the token sent: it reaches the phone, or the answer is lost.
Answer(q) ==
  /\ st[q] = "answer"
  /\ \E r \in {"token", "lost"} : got' = [got EXCEPT ![who[q]] = r]
  /\ lockO' = (IF lockO = q THEN None ELSE lockO) /\ Go(q, "idle")
  /\ who' = [who EXCEPT ![q] = None] /\ sc' = [sc EXCEPT ![q] = None]
  /\ UNCHANGED <<offers, made, exp, clients, lockP, snap, issued, taken, rv>>

\* revoke (the `pair` command, or Settings › Phone).
BeginRevoke(q, f) ==
  /\ st[q] = "idle" /\ Free(lockP)
  /\ lockP' = Hold(q) /\ snap' = [snap EXCEPT ![q] = clients] /\ who' = [who EXCEPT ![q] = f] /\ Go(q, "revoke")
  /\ UNCHANGED <<offers, made, exp, clients, lockO, sc, got, issued, taken, rv>>

\* Written only when the phone was listed.
Revoke(q) ==
  /\ st[q] = "revoke"
  /\ IF who[q] \in snap[q]
       THEN clients' = snap[q] \ {who[q]} /\ rv' = rv \cup {who[q]}
       ELSE UNCHANGED <<clients, rv>>
  /\ lockP' = (IF lockP = q THEN None ELSE lockP) /\ Go(q, "idle") /\ who' = [who EXCEPT ![q] = None]
  /\ UNCHANGED <<offers, made, exp, lockO, sc, snap, got, issued, taken>>

\* A process dies at any step (its phone sees the request fail); its locks stay behind.
Crash(q) ==
  /\ st[q] \notin {"idle", "dead"} /\ Go(q, "dead")
  /\ got' = (IF st[q] \in {"take", "issue", "issuing", "answer"} THEN [got EXCEPT ![who[q]] = "lost"] ELSE got)
  /\ UNCHANGED <<offers, made, exp, clients, lockO, lockP, who, sc, snap, issued, taken, rv>>

\* Another process finds a lock whose holder is gone and removes it.
BreakO == lockO \in Procs /\ st[lockO] = "dead" /\ lockO' = None /\ UNCHANGED <<offers, made, exp, clients, lockP, st, who, sc, snap, got, issued, taken, rv>>
BreakP == lockP \in Procs /\ st[lockP] = "dead" /\ lockP' = None /\ UNCHANGED <<offers, made, exp, clients, lockO, st, who, sc, snap, got, issued, taken, rv>>

Expire(c) == c \in made /\ c \notin exp /\ exp' = exp \cup {c} /\ UNCHANGED <<offers, made, clients, lockO, lockP, st, who, sc, snap, got, issued, taken, rv>>

Step(q) == Create(q) \/ Take(q) \/ BeginIssue(q) \/ Issue(q) \/ Answer(q) \/ Revoke(q)

Next ==
  \/ \E q \in Procs : \/ Step(q) \/ Crash(q)
                      \/ \E c \in Codes : BeginCreate(q, c)
                      \/ \E f \in Phones : BeginRevoke(q, f) \/ \E c \in Codes : BeginTake(q, f, c)
  \/ BreakO \/ BreakP
  \/ \E c \in Codes : Expire(c)

\* A process that began goes on; a dead holder's lock is broken. Asking, revoking, crashing, expiry are not forced.
\* withFileLock polls until the lock is free, so a redeem waiting for paired-clients.json gets it even while other
\* changes keep taking it in between (strong fairness: the poll is not starved forever).
Fairness == /\ \A q \in Procs : WF_vars(Step(q)) /\ SF_vars(BeginIssue(q))
            /\ WF_vars(BreakO) /\ WF_vars(BreakP)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety. *)

\* A code gives at most one token.
SingleUse == \A c \in Codes : Cardinality(issued[c]) <= 1

\* A revoked phone stays off the list (and so is not served) until it pairs again.
RevokeSticks == rv \cap clients = {}

\* Known limitation (LanPair_lost.cfg): a code taken off the list reached its phone as a token, or the redeem is
\* still running.
CodeReachesPhone ==
  \A c \in Codes : taken[c] # None =>
    got[taken[c]] = "token" \/ \E q \in Procs : st[q] \in {"issue", "issuing", "answer"} /\ sc[q] = c /\ who[q] = taken[c]

(* Liveness. *)

\* A phone that posted a code is answered: a token, invalid, or the request failed (no lock is held forever).
Answered == \A f \in Phones : got[f] = "asking" ~> got[f] \in {"token", "invalid", "lost"}
=============================================================================
