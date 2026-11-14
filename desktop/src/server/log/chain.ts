// The hash chain of a log stream (protocol v1 §8.1): hash = SHA-256(prevHash ‖ canonical entry without `hash`).
// The chain runs on across incarnations: after a restore the first entry of the new logId chains to the last kept
// entry of the old one (its own logId is inside what it hashes), so one check covers a whole stream.
import { createHash } from "node:crypto";
import { entryHashInput, GENESIS_HASH, type Entry, type EntryContent } from "../../protocol";

export function hashEntry(prevHash: string, content: EntryContent | Entry): string {
  return createHash("sha256").update(entryHashInput(prevHash, content), "utf8").digest("hex");
}

export type ChainCheck = { ok: true; lastHash: string } | { ok: false; seq: number; reason: "hash" | "gap" };

/**
 * Checks consecutive entries against the hash before the first (GENESIS_HASH for seq 1). Entries must be in seq order
 * with no gap; their logIds may change (a restore) but their seqs never restart.
 */
export function verifyChain(prevHash: string, entries: readonly Entry[]): ChainCheck {
  let hash = prevHash;
  let seq = entries.length ? entries[0].seq - 1 : 0;
  for (const entry of entries) {
    if (entry.seq !== seq + 1) return { ok: false, seq: entry.seq, reason: "gap" };
    if (hashEntry(hash, entry) !== entry.hash) return { ok: false, seq: entry.seq, reason: "hash" };
    hash = entry.hash;
    seq = entry.seq;
  }
  return { ok: true, lastHash: hash };
}

export { GENESIS_HASH };
