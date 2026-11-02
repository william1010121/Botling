------------------------ MODULE BotSessionLifecycle ------------------------
(* Bot Session & Warm Cache Lifecycle Protocol Specification               *)
(* Formally verifies:                                                      *)
(* 1. Single-writer safety across data locks (`core.lock`).                *)
(* 2. Cache consistency between in-memory cache and durable disk storage.   *)
(* 3. Zero data loss during cache eviction under memory pressure.          *)
(* 4. Prohibition of execution without warm cache and active lock.         *)
(* 5. Memory budget bound on concurrently warmed sessions.                 *)

EXTENDS Naturals, FiniteSets

CONSTANTS Sessions,         \* Set of bot session identifiers, e.g. {"s1", "s2"}
          MaxWarmSessions,  \* Max sessions resident in cache simultaneously
          MaxTurns          \* Max turns per session to bound state exploration

SessionStates == {"closed", "idle", "busy", "waiting_approval", "checkpointing"}
CacheStatuses == {"cold", "warming", "warm", "evicting"}

VARIABLES
  sessionState,   \* [s \in Sessions -> SessionStates]
  cacheStatus,    \* [s \in Sessions -> CacheStatuses]
  cacheDirty,     \* [s \in Sessions -> BOOLEAN]
  cacheMem,       \* [s \in Sessions -> Nat] (in-memory memory.md version)
  diskMem,        \* [s \in Sessions -> Nat] (durable memory.md version on disk)
  diskLock,       \* [s \in Sessions -> BOOLEAN] (whether core.lock is held)
  turnCount       \* [s \in Sessions -> Nat] (number of completed turns)

vars == <<sessionState, cacheStatus, cacheDirty, cacheMem, diskMem, diskLock, turnCount>>

TypeOK ==
  /\ sessionState \in [Sessions -> SessionStates]
  /\ cacheStatus \in [Sessions -> CacheStatuses]
  /\ cacheDirty \in [Sessions -> BOOLEAN]
  /\ cacheMem \in [Sessions -> Nat]
  /\ diskMem \in [Sessions -> Nat]
  /\ diskLock \in [Sessions -> BOOLEAN]
  /\ turnCount \in [Sessions -> Nat]

\* Active cached sessions count
WarmedCount ==
  Cardinality({s \in Sessions : cacheStatus[s] \in {"warming", "warm", "evicting"}})

Init ==
  /\ sessionState = [s \in Sessions |-> "closed"]
  /\ cacheStatus = [s \in Sessions |-> "cold"]
  /\ cacheDirty = [s \in Sessions |-> FALSE]
  /\ cacheMem = [s \in Sessions |-> 0]
  /\ diskMem = [s \in Sessions |-> 0]
  /\ diskLock = [s \in Sessions |-> FALSE]
  /\ turnCount = [s \in Sessions |-> 0]

-----------------------------------------------------------------------------
(* State Transition Actions *)

\* Session acquires workspace lock (core.lock)
AcquireLock(s) ==
  /\ ~diskLock[s]
  /\ diskLock' = [diskLock EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<sessionState, cacheStatus, cacheDirty, cacheMem, diskMem, turnCount>>

\* Warm cache begins: reading disk state into memory
WarmCache(s) ==
  /\ diskLock[s]
  /\ cacheStatus[s] = "cold"
  /\ WarmedCount < MaxWarmSessions
  /\ cacheStatus' = [cacheStatus EXCEPT ![s] = "warming"]
  /\ cacheMem' = [cacheMem EXCEPT ![s] = diskMem[s]]
  /\ cacheDirty' = [cacheDirty EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<sessionState, diskMem, diskLock, turnCount>>

\* Warm cache completed: session enters idle state ready for commands
WarmComplete(s) ==
  /\ cacheStatus[s] = "warming"
  /\ cacheStatus' = [cacheStatus EXCEPT ![s] = "warm"]
  /\ sessionState' = [sessionState EXCEPT ![s] = "idle"]
  /\ UNCHANGED <<cacheDirty, cacheMem, diskMem, diskLock, turnCount>>

\* User message arrives: bot starts turn execution
StartTurn(s) ==
  /\ cacheStatus[s] = "warm"
  /\ sessionState[s] = "idle"
  /\ turnCount[s] < MaxTurns
  /\ sessionState' = [sessionState EXCEPT ![s] = "busy"]
  /\ UNCHANGED <<cacheStatus, cacheDirty, cacheMem, diskMem, diskLock, turnCount>>

\* Turn encounters high-risk tool call: asks human approval via ApprovalSheet
RequestApproval(s) ==
  /\ sessionState[s] = "busy"
  /\ sessionState' = [sessionState EXCEPT ![s] = "waiting_approval"]
  /\ UNCHANGED <<cacheStatus, cacheDirty, cacheMem, diskMem, diskLock, turnCount>>

\* Human approves or rejects permission
ResolveApproval(s, approved) ==
  /\ sessionState[s] = "waiting_approval"
  /\ sessionState' = [sessionState EXCEPT ![s] = IF approved THEN "busy" ELSE "idle"]
  /\ UNCHANGED <<cacheStatus, cacheDirty, cacheMem, diskMem, diskLock, turnCount>>

\* Engine completes turn: updates in-memory memory notes and transitions to checkpointing
FinishTurn(s) ==
  /\ sessionState[s] = "busy"
  /\ sessionState' = [sessionState EXCEPT ![s] = "checkpointing"]
  /\ cacheMem' = [cacheMem EXCEPT ![s] = cacheMem[s] + 1]
  /\ cacheDirty' = [cacheDirty EXCEPT ![s] = TRUE]
  /\ turnCount' = [turnCount EXCEPT ![s] = turnCount[s] + 1]
  /\ UNCHANGED <<cacheStatus, diskMem, diskLock>>

\* Checkpoint commits to disk: atomic write updates disk storage and clears dirty bit
CheckpointCommit(s) ==
  /\ sessionState[s] = "checkpointing"
  /\ diskLock[s]
  /\ diskMem' = [diskMem EXCEPT ![s] = cacheMem[s]]
  /\ cacheDirty' = [cacheDirty EXCEPT ![s] = FALSE]
  /\ sessionState' = [sessionState EXCEPT ![s] = "idle"]
  /\ UNCHANGED <<cacheStatus, cacheMem, diskLock, turnCount>>

\* Memory pressure or idle timeout triggers eviction of an idle session
BeginEviction(s) ==
  /\ cacheStatus[s] = "warm"
  /\ sessionState[s] = "idle"
  /\ cacheStatus' = [cacheStatus EXCEPT ![s] = "evicting"]
  /\ UNCHANGED <<sessionState, cacheDirty, cacheMem, diskMem, diskLock, turnCount>>

\* Eviction completes: flushes dirty state if any, resets cache to cold, closes session
FlushEvict(s) ==
  /\ cacheStatus[s] = "evicting"
  /\ diskLock[s]
  /\ diskMem' = [diskMem EXCEPT ![s] = IF cacheDirty[s] THEN cacheMem[s] ELSE diskMem[s]]
  /\ cacheDirty' = [cacheDirty EXCEPT ![s] = FALSE]
  /\ cacheStatus' = [cacheStatus EXCEPT ![s] = "cold"]
  /\ sessionState' = [sessionState EXCEPT ![s] = "closed"]
  /\ UNCHANGED <<cacheMem, diskLock, turnCount>>

\* Workspace lock released when session is cold and closed
ReleaseLock(s) ==
  /\ diskLock[s]
  /\ cacheStatus[s] = "cold"
  /\ sessionState[s] = "closed"
  /\ diskLock' = [diskLock EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<sessionState, cacheStatus, cacheDirty, cacheMem, diskMem, turnCount>>

-----------------------------------------------------------------------------
(* Next-State Relation & Invariants *)

Next ==
  \E s \in Sessions :
    \/ AcquireLock(s)
    \/ WarmCache(s)
    \/ WarmComplete(s)
    \/ StartTurn(s)
    \/ RequestApproval(s)
    \/ ResolveApproval(s, TRUE)
    \/ ResolveApproval(s, FALSE)
    \/ FinishTurn(s)
    \/ CheckpointCommit(s)
    \/ BeginEviction(s)
    \/ FlushEvict(s)
    \/ ReleaseLock(s)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Verification Invariants *)

\* 1. Single Writer Safety: session writes and dirty state require holding diskLock
SingleWriterIntegrity ==
  \A s \in Sessions :
    (cacheDirty[s] \/ sessionState[s] \in {"busy", "waiting_approval", "checkpointing"}) => diskLock[s]

\* 2. Cache Consistency: clean warm cache exactly matches durable disk memory
CacheConsistency ==
  \A s \in Sessions :
    (cacheStatus[s] = "warm" /\ ~cacheDirty[s]) => (cacheMem[s] = diskMem[s])

\* 3. No Execution While Cold: turns can only execute within warm, resident cache
NoExecutionWhileCold ==
  \A s \in Sessions :
    sessionState[s] \in {"busy", "waiting_approval", "checkpointing"} => (cacheStatus[s] = "warm")

\* 4. No Dirty Data Lost: a cold session never has uncommitted dirty data
NoDirtyDataLost ==
  \A s \in Sessions :
    (cacheStatus[s] = "cold") => (~cacheDirty[s] /\ sessionState[s] = "closed")

\* 5. Memory Budget Bound: warm cache resident sessions never exceed capacity
MemoryBudgetBound ==
  WarmedCount <= MaxWarmSessions

=============================================================================
