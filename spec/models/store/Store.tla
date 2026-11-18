-------------------------------- MODULE Store --------------------------------
(* server.db durability (protocol v1 §7.2 as narrowed by D75, 2026-11-18; desktop/src/server/store/connection.ts,
   writer.ts, index.ts; botlingd.ts `onLostTail`).
   The writer commits with synchronous = NORMAL in WAL: a commit is in the OS at once (a crash of the process loses
   nothing) and on the disk only once flushed. A power loss or an OS crash keeps a prefix of the commits that is at
   least as long as the flushed part (WAL recovery stops at the first frame whose running checksum fails).
   - An acknowledgement (`held`, `cmd.result`, a roster statement, a pairing, a forwarded command, an effect that ran)
     comes from a commit that wrote a durable table; the writer flushes such a batch before it settles, so the
     acknowledgement leaves only once its commit, and every commit before it, is on the disk.
   - Everything else (log entries, read models) is not flushed, and readers (a front end or a peer on another
     machine) get it at once: after a power loss they may hold entries the store lost. The store marks on the disk
     that it is open (`store.open`) and in which boot of the machine (`store.boot`); a start that finds the mark of a
     run that did not close, from another boot, gives the own stream a new logId (a rewind, §7.6), so those readers
     get `reset` + `snap` instead of following a log that went another way. A reader that shows more than the store
     holds is the existing rewind detection (LogReader.sub).
   One step is one thing the server, the machine or the reader does:
     Start      open the store: the boot check, then the marks, in one flushed commit
     Commit     the writer commits a command (a batch); one that wrote a durable table owes an acknowledgement
     Flush      the writer's flush of a marked batch (or a checkpoint): every commit so far is on the disk
     Ack        an owed acknowledgement leaves, once its commit is on the disk
     Reject     the flush of a marked batch fails: its commands are rejected (no acknowledgement), the commit stays
                in the OS, and the writer owes a flush (`debt`): every later batch is flushed before it settles until
                one flush succeeds
     Resend     the sender sends a command again that is already committed; the writer answers it from the stored
                receipt in a batch that writes nothing, flushed only when the writer owes a flush
     Push       the reader gets the next entry (read from committed state, never waiting for a flush)
     Sub        the reader (re)subscribes with its cursor: follow, rewind (it holds more than the store), or reset
     Disconnect the reader's session ends
     Close      a clean close: the writer drains, then a flushed commit clears the open mark
     Crash      the server process dies: what was committed stays in the OS
     PowerLoss  the machine loses power (or the OS crashes): a prefix at least as long as the flushed part stays *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Acks,      \* commands whose commit writes a durable table (an acknowledgement goes out once it is stored)
          Events,    \* commands that write only the log and read models (engine output)
          MaxFault,  \* crashes and power losses, together
          Bug        \* "none": the design; "noflush": acknowledge after COMMIT without the flush;
                     \* "norotate": no boot check (a run that lost its tail keeps its logId);
                     \* "nodebt": a failed flush owes nothing (a re-send is answered from an unflushed receipt)

Cmds == Acks \cup Events

VARIABLES
  up,        \* the server process runs with the store open
  log,       \* the commits as this machine shows them (in the OS), oldest first: each is its command
  synced,    \* how many of them are on the disk
  owed,      \* acknowledgements committed and not sent yet (they wait for the flush)
  acked,     \* commands whose acknowledgement left the process
  logId,     \* the own stream's logId (a number: each new one is the next)
  openMark,  \* on the disk: the last run opened the store and did not close it
  bootMark,  \* on the disk: the boot of the machine that run started in
  boot,      \* the machine's boot now
  rOn,       \* the reader is subscribed to this run
  rLog,      \* what the reader holds of the stream
  rId,       \* the logId it holds them under
  faults,    \* crashes and power losses so far
  debt       \* a flush failed in this run and none succeeded since

vars == <<up, log, synced, owed, acked, logId, openMark, bootMark, boot, rOn, rLog, rId, faults, debt>>

Range(s) == {s[i] : i \in 1..Len(s)}
IsPrefix(a, b) == Len(a) <= Len(b) /\ SubSeq(b, 1, Len(a)) = a
\* Where command c sits in the log (it is there at most once).
Pos(c) == CHOOSE i \in 1..Len(log) : log[i] = c

TypeOK ==
  /\ up \in BOOLEAN /\ log \in Seq(Cmds) /\ synced \in 0..Len(log)
  /\ owed \subseteq Acks /\ acked \subseteq Acks
  /\ logId \in Nat /\ openMark \in BOOLEAN /\ bootMark \in 0..MaxFault /\ boot \in 0..MaxFault
  /\ rOn \in BOOLEAN /\ rLog \in Seq(Cmds) /\ rId \in Nat /\ faults \in 0..MaxFault /\ debt \in BOOLEAN

Init ==
  /\ up = FALSE /\ log = <<>> /\ synced = 0 /\ owed = {} /\ acked = {}
  /\ logId = 0 /\ openMark = FALSE /\ bootMark = 0 /\ boot = 0
  /\ rOn = FALSE /\ rLog = <<>> /\ rId = 0 /\ faults = 0 /\ debt = FALSE

-----------------------------------------------------------------------------
(* The server. *)

\* The boot check and this run's marks, in one flushed commit (it flushes every earlier frame too).
Start ==
  /\ ~up /\ up' = TRUE
  /\ logId' = IF openMark /\ bootMark # boot /\ Bug # "norotate" THEN logId + 1 ELSE logId
  /\ openMark' = TRUE /\ bootMark' = boot /\ synced' = Len(log) /\ debt' = FALSE
  /\ UNCHANGED <<log, owed, acked, boot, rOn, rLog, rId, faults>>

\* A command commits (it may be a re-send of one a power loss took).
Commit(c) ==
  /\ up /\ c \notin Range(log)
  /\ log' = Append(log, c)
  /\ owed' = IF c \in Acks THEN owed \cup {c} ELSE owed
  /\ UNCHANGED <<up, synced, acked, logId, openMark, bootMark, boot, rOn, rLog, rId, faults, debt>>

Flush ==
  /\ up /\ synced < Len(log) /\ synced' = Len(log) /\ debt' = FALSE
  /\ UNCHANGED <<up, log, owed, acked, logId, openMark, bootMark, boot, rOn, rLog, rId, faults>>

Ack(c) ==
  /\ up /\ c \in owed
  /\ Bug = "noflush" \/ Pos(c) <= synced
  /\ acked' = acked \cup {c} /\ owed' = owed \ {c}
  /\ UNCHANGED <<up, log, synced, logId, openMark, bootMark, boot, rOn, rLog, rId, faults, debt>>

\* The flush after c's commit fails (writer.ts: every command of the batch is rejected; connection.ts: the gate owes).
Reject(c) ==
  /\ up /\ c \in owed /\ Pos(c) > synced
  /\ owed' = owed \ {c} /\ debt' = (Bug # "nodebt")
  /\ UNCHANGED <<up, log, synced, acked, logId, openMark, bootMark, boot, rOn, rLog, rId, faults>>

\* A copy of a committed command (a re-send after a rejection, a lost reply or a restart): admit() finds its receipt
\* and the answer leaves when the batch settles; that batch is flushed only when the writer owes a flush.
Resend(c) ==
  /\ up /\ c \in Acks /\ c \in Range(log) /\ c \notin owed
  /\ synced' = IF debt THEN Len(log) ELSE synced /\ debt' = FALSE
  /\ acked' = acked \cup {c}
  /\ UNCHANGED <<up, log, owed, logId, openMark, bootMark, boot, rOn, rLog, rId, faults>>

\* writer.close() waits until every command settled; the flushed commit of the mark covers every commit.
Close ==
  /\ up /\ owed = {}
  /\ up' = FALSE /\ rOn' = FALSE /\ openMark' = FALSE /\ synced' = Len(log) /\ debt' = FALSE
  /\ UNCHANGED <<log, owed, acked, logId, bootMark, boot, rLog, rId, faults>>

Crash ==
  /\ up /\ faults < MaxFault
  /\ up' = FALSE /\ rOn' = FALSE /\ owed' = {} /\ faults' = faults + 1 /\ debt' = FALSE
  /\ UNCHANGED <<log, synced, acked, logId, openMark, bootMark, boot, rLog, rId>>

\* Also while the server is down (a crash left commits that were never flushed).
PowerLoss ==
  /\ faults < MaxFault
  /\ \E k \in synced..Len(log) : log' = SubSeq(log, 1, k) /\ synced' = k
  /\ up' = FALSE /\ rOn' = FALSE /\ owed' = {} /\ boot' = boot + 1 /\ faults' = faults + 1 /\ debt' = FALSE
  /\ UNCHANGED <<acked, logId, openMark, bootMark, rLog, rId>>

-----------------------------------------------------------------------------
(* The reader. *)

Push ==
  /\ up /\ rOn /\ rId = logId /\ Len(rLog) < Len(log)
  /\ rLog' = Append(rLog, log[Len(rLog) + 1])
  /\ UNCHANGED <<up, log, synced, owed, acked, logId, openMark, bootMark, boot, rOn, rId, faults, debt>>

\* LogReader.sub: beyond the head of the same logId → a rewind (a new logId, written and flushed), then reset + snap;
\* another logId → reset + snap; else follow from the cursor.
Sub ==
  /\ up /\ ~rOn /\ rOn' = TRUE
  /\ CASE rId = logId /\ Len(rLog) > Len(log) ->
            logId' = logId + 1 /\ rId' = logId + 1 /\ rLog' = log /\ synced' = Len(log) /\ debt' = FALSE
       [] rId # logId -> rId' = logId /\ rLog' = log /\ UNCHANGED <<logId, synced, debt>>
       [] OTHER -> UNCHANGED <<logId, rId, rLog, synced, debt>>
  /\ UNCHANGED <<up, log, owed, acked, openMark, bootMark, boot, faults>>

Disconnect ==
  /\ rOn /\ rOn' = FALSE
  /\ UNCHANGED <<up, log, synced, owed, acked, logId, openMark, bootMark, boot, rLog, rId, faults, debt>>

Next ==
  \/ Start \/ Flush \/ Close \/ Crash \/ PowerLoss \/ Push \/ Sub \/ Disconnect
  \/ \E c \in Cmds : Commit(c) \/ Ack(c) \/ Reject(c) \/ Resend(c)

\* The writer flushes and sends what it owes, and the hub pushes to a subscribed reader; commands, crashes, power
\* losses, closes, starts and the reader's comings and goings are never forced.
Fairness == WF_vars(Flush) /\ WF_vars(Push) /\ \A c \in Acks : WF_vars(Ack(c))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety. *)

\* Nothing acknowledged is ever lost: not by a crash, not by a power loss.
AckedKept == \A c \in acked : c \in Range(log)

\* A subscribed reader that holds the current logId holds a prefix of the log: it never follows a log that went
\* another way after a power loss (entries it saw replaced by others under the same seq).
NoFork == rOn /\ rId = logId => IsPrefix(rLog, log)

\* The flushed part is never more than what the OS shows.
SyncedInLog == synced <= Len(log)

\* The writer owes a flush only while something is unflushed.
DebtUnsynced == debt => synced < Len(log)

(* Liveness. *)

\* An owed acknowledgement goes out, unless the process stops or its flush fails first (the sender re-sends; the
\* receipt answers it).
AckSent == \A c \in Acks : (c \in owed) ~> (c \in acked \/ ~up \/ debt)

\* A subscribed reader catches up with the whole log, unless the server or its session stops.
CatchesUp == (up /\ rOn) ~> ((rId = logId /\ rLog = log) \/ ~up \/ ~rOn)
=============================================================================
