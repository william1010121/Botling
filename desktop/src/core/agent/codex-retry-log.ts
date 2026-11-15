// When Codex will try a refused request again. codex app-server's `error` notification
// (willRetry: true, "Reconnecting... 1/5") says which attempt it waits for but not how long; its own
// log does: CODEX_HOME/logs_2.sqlite, target codex_core::responses_retry, "stream disconnected -
// retrying sampling request (1/5 in 40.2s)... last status: 429 Too Many Requests" (codex-cli 0.163.0).
// Read only when such a notification came: one indexed query (thread_id, ts) through node:sqlite,
// opened read-only (no busy wait, so codex's own writes are never held up); nothing is ever written.
// Not the sqlite3 CLI: Linux installs often have none (Debian's test host did not), and the wait
// then never showed there. No file, a locked or changed log: unknown (null), and the bubble just
// says it is retrying.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Codex's log database for this environment (`CODEX_HOME`, else ~/.codex). */
export function codexLogsFile(env: Record<string, string | undefined> = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "logs_2.sqlite");
}

/** The attempt, the limit and the wait in a responses_retry line (Rust's `Duration` Debug: 40.2s, 850ms, 12µs). */
export function parseRetryLine(body: string): { attempt: number; max: number; delayMs: number } | null {
  const match = /retrying sampling request \((\d+)\/(\d+) in ([\d.]+)(s|ms|µs|us|ns)\)/.exec(body);
  if (!match) return null;
  const value = Number(match[3]);
  if (!Number.isFinite(value)) return null;
  const scale = match[4] === "s" ? 1000 : match[4] === "ms" ? 1 : match[4] === "ns" ? 1e-6 : 1e-3;
  return { attempt: Number(match[1]), max: Number(match[2]), delayMs: Math.round(value * scale) };
}

/**
 * When (ms since 1970) `thread`'s attempt `attempt` goes again, from Codex's log rows written since
 * `since` (ms); null when unknown.
 */
export async function codexRetryAt({ file, thread, attempt, since }: {
  file: string; thread: string; attempt: number; since: number;
}): Promise<number | null> {
  // Thread ids are UUIDs; anything else never reaches the query.
  if (!/^[0-9a-f-]{1,64}$/i.test(thread) || !Number.isFinite(since) || !existsSync(file)) return null;
  const from = Math.floor(since / 1000) - 5;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    const row = db.prepare("SELECT ts, ts_nanos, substr(feedback_log_body, instr(feedback_log_body, 'retrying sampling request ('), 80) AS body FROM logs"
      + " WHERE thread_id = ? AND ts >= ? AND target = 'codex_core::responses_retry'"
      + " ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1").get(thread, from) as { ts: unknown; ts_nanos: unknown; body: unknown } | undefined;
    if (!row || typeof row.body !== "string") return null;
    const line = parseRetryLine(row.body);
    const seconds = Number(row.ts), ns = Number(row.ts_nanos);
    if (!line || line.attempt !== attempt || !Number.isFinite(seconds) || !Number.isFinite(ns)) return null;
    return seconds * 1000 + Math.floor(ns / 1e6) + line.delayMs;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
