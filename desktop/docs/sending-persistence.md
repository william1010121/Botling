# Worker history persistence and Sending

Worker history used to serialize and synchronously rewrite the entire `subagents.json` on the core event loop. A bounded replay of 96,245,933 bytes measured 800–1,895 ms of blocking per write. This is an identified latency mechanism, not proof of the whole historical 16/22-second checkpoint delay.

## Durable acceptance

`BotStore.commitWorkerHistory` commits an atomic, fully written, fsynced transaction under `subagents.json.journal/` before returning. Parent-directory durability is included on POSIX; Windows follows the existing platform limitation for directory fsync. An error throws before the bot publishes a worker update. Existing chat/task saves still commit synchronously before message acceptance. No tool, approval, steer, stop, or grace-period policy changes.

Transactions contain absolute field assignments/deletions, explicit array lengths, and complete row order. The bot marks affected workers and parents; nested Agent results mark the child as well. Unchanged historical report strings are neither encoded nor transferred to a worker on each event. Newly added or genuinely changed data is journaled; a single exceptionally large new field can still cost time. Cold recovery still reads/parses history synchronously.

A shared worker thread reads the checkpoint plus committed transactions, serializes the full list, writes/fsyncs a temporary file, renames/fsyncs the directory, then prunes the covered journal entries. Only filenames and sequence numbers cross the thread boundary. One worker serializes checkpoint work; progress bursts coalesce. Errors retain journal entries and retry with bounded backoff; explicit flush/close propagates errors. Unacknowledged temporary files are never replayed.

## Recovery and lifetime

The authoritative read is `readHistory` / `BotStore.loadList("subagents.json")`, **not the checkpoint file alone**. A read fences the checkpoint inode/mtime/size to retry a concurrent compaction. Absolute patches are idempotent, so a crash after checkpoint rename but before journal pruning does not replay an append/increment twice. A partially pruned suffix is safe. Malformed checkpoint/journal data fails closed.

The legacy array file is a materialized view and may lag while the core runs. Both heads and all bots flush before successful core handover. Shutdown flushes before lock release, preserves chat persistence and releases locks even on failure, and surfaces the error. Opening a store does not schedule writes, so read-only profiles do not trigger checkpoint mutation.

External backup/read tooling must include `subagents.json.journal/` or await a successful flush. An older binary that reads only the array is not safe to downgrade to after an unclean exit until journal recovery/checkpointing completes.

## Integration boundaries

Base: `9024ad5e9338c2e0e2bfdd8a3a46b281f5b7f613`. No TokenFlow or task-card changes are incorporated.

Shared `bot.ts` call sites: `settleSubagent`, `saveSubagents`/`flushSubagents`, `onSubagentItem`'s `toolResult` case, `subagentChanged`, `flushForSwap`, and `shutdown`. The TokenFlow candidate's `onItem` measurement/usage hooks, `recordMeasurement`, `linkSubagent` dispatch binding, and post-`tasks.replied` ledger linkage are unchanged. Parsed-item dispatch is still synchronous, and worker journal acceptance precedes publication; there is no asynchronous reordering of ledger events.

`token-flow-history.ts:savedRows` is unchanged by the TokenFlow candidate. This persistence change adds only a pending-journal guard: inactive-head history is explicitly unknown while a committed journal exists, including when the array cache is warm or the first checkpoint is absent. It does not read journal content or alter accounting/attribution, and preserves the 8 MiB/metadata-only bound. Sequential integration must retain this guard along with TokenFlow hooks.

Focused checks cover durable acceptance, in-flight commits, errors/retry, crash-window recovery, nested workers, prior-run retention, both-head shutdown/handover, production-format CJS worker execution, and a bounded 91.79 MiB responsiveness fixture. No full suite, packaging, live-provider interruption, or native UI acceptance is implied.
