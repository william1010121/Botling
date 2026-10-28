# Worker history persistence and Sending

Worker history used to serialize and synchronously rewrite the entire `subagents.json` on the core event loop. A bounded replay of 96,245,933 bytes measured 800–1,895 ms of blocking per write. This is an identified latency mechanism, not proof of the whole historical 16/22-second checkpoint delay.

## Durable acceptance

`BotStore.commitWorkerHistory` commits an atomic, fully written, fsynced transaction under `subagents.json.journal/` before returning. Parent-directory durability is included on POSIX; Windows follows the existing platform limitation for directory fsync. An error throws before the bot publishes a worker update. Existing chat/task saves still commit synchronously before message acceptance. No tool, approval, steer, stop, or grace-period policy changes.

Transactions contain absolute field assignments/deletions, explicit array lengths, and complete row order. The bot marks affected workers and parents; nested Agent results mark the child as well. Unchanged historical report strings are neither encoded nor transferred to a worker on each event. Newly added or genuinely changed data is journaled; a single exceptionally large new field can still cost time. Cold recovery still reads/parses history synchronously.

A shared worker thread reads the checkpoint plus committed transactions, serializes the full checkpoint, writes/fsyncs a temporary file, renames/fsyncs the directory, then prunes the covered journal entries. Only filenames and sequence numbers cross the thread boundary. One worker serializes checkpoint work; progress bursts coalesce. Errors retain journal entries and retry with bounded backoff; explicit flush/close propagates errors. Unacknowledged temporary files are never replayed.

## Recovery and lifetime

The authoritative read is `readHistory` / `BotStore.loadList("subagents.json")`, **not the checkpoint file alone**. A read fences the checkpoint inode/mtime/size to retry a concurrent compaction. Each checkpoint atomically stores `{format: "botling-history-v1", sequence, rows}` in one fsynced/renamed file. Recovery applies only receipts newer than its sequence, and requires a contiguous sequence thereafter. Receipts at or below the watermark are ignored, including any subset left by interrupted pruning. Sequence numbering continues from the checkpoint after restart even when no journal entries remain. Absolute patches alone are not sufficient: replaying covered transactions across trimming/readdition can lose rows. The watermark is inseparable from the rows; no sidecar ordering assumption is needed. Malformed checkpoints and uncovered journal data fail closed. Covered receipts need not be parsed.

Legacy arrays are accepted as sequence zero and migrate on the next checkpoint. The versioned checkpoint may lag while the core runs. Both heads and all bots flush before successful core handover. Shutdown flushes before lock release, preserves chat persistence and releases locks even on failure, and surfaces the error. Core shutdown settles every bot, plugin and team participant even when another fails; SIGINT, SIGTERM and stdin-close share one exit path, with exit code 1 and a diagnostic on failure, 0 only on success. Opening a store does not schedule writes, so read-only profiles do not trigger checkpoint mutation.

Backup requires either a consistent filesystem snapshot including both `subagents.json` and `subagents.json.journal/`, or paused writes plus a successful flush **with writes remaining quiescent throughout copying**. Copying the checkpoint and journals concurrently with compaction is not safe: copying an older checkpoint before pruning and the journal after pruning can omit accepted changes. A successful flush followed by resumed writes is not a backup barrier. Old array-only readers cannot read the versioned checkpoint even after a clean flush; downgrade requires a deliberate offline export of recovered rows to the legacy format, with writes quiescent and journals excluded from the exported profile. No automatic downgrade/export is provided.

## Integration boundaries

Base: `9024ad5e9338c2e0e2bfdd8a3a46b281f5b7f613`. No TokenFlow or task-card changes are incorporated.

Shared `bot.ts` call sites: `settleSubagent`, `saveSubagents`/`flushSubagents`, `onSubagentItem`'s `toolResult` case, `subagentChanged`, `flushForSwap`, and `shutdown`. The TokenFlow candidate's `onItem` measurement/usage hooks, `recordMeasurement`, `linkSubagent` dispatch binding, and post-`tasks.replied` ledger linkage are unchanged. Parsed-item dispatch is still synchronous, and worker journal acceptance precedes publication; there is no asynchronous reordering of ledger events.

`token-flow-history.ts:savedRows` accepts both legacy arrays and versioned checkpoints using the shared decoder, within the existing byte limit. Its pending-journal guard remains: inactive-head history is explicitly unknown while a committed journal exists, including when the array cache is warm or the first checkpoint is absent. It does not read journal content or alter accounting/attribution, and preserves the 8 MiB/metadata-only bound. Sequential integration must retain this guard along with TokenFlow hooks.

Focused checks cover durable acceptance, in-flight commits, errors/retry, crash-window recovery, nested workers, prior-run retention, both-head shutdown/handover, production-format CJS worker execution, and a bounded 91.79 MiB responsiveness fixture. No full suite, packaging, live-provider interruption, or native UI acceptance is implied.
