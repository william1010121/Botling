// When Codex will try a refused request again. codex app-server's `error` notification
// (willRetry: true, "Reconnecting... 1/5") says which attempt it waits for but not how long; its own
// log does: CODEX_HOME/logs_2.sqlite, target codex_core::responses_retry, "stream disconnected -
// retrying sampling request (1/5 in 40.2s)... last status: 429 Too Many Requests" (codex-cli 0.163.0).
// Read only when such a notification came: one indexed query (thread_id, ts) through the sqlite3
// CLI, opened read-only (`-readonly`, `mode=ro`); nothing is ever written. No sqlite3, no file, a
// locked or changed log: unknown (null), and the bubble just says it is retrying.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** A file: URI sqlite opens read-only (the characters a URI path cannot hold, escaped). */
function readOnlyURI(file: string): string {
  return `file:${file.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23")}?mode=ro`;
}

/**
 * When (ms since 1970) `thread`'s attempt `attempt` goes again, from Codex's log rows written since
 * `since` (ms); null when unknown.
 */
export function codexRetryAt({ file, thread, attempt, since, sqlite = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3", timeoutMs = 3_000 }: {
  file: string; thread: string; attempt: number; since: number; sqlite?: string; timeoutMs?: number;
}): Promise<number | null> {
  // Thread ids are UUIDs; anything else never reaches the query.
  if (!/^[0-9a-f-]{1,64}$/i.test(thread) || !Number.isFinite(since) || !existsSync(file)) return Promise.resolve(null);
  const from = Math.floor(since / 1000) - 5;
  const query = "SELECT ts, ts_nanos, substr(feedback_log_body, instr(feedback_log_body, 'retrying sampling request ('), 80) FROM logs"
    + ` WHERE thread_id = '${thread}' AND ts >= ${from} AND target = 'codex_core::responses_retry'`
    + " ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1;";
  return new Promise((resolve) => {
    try {
      execFile(sqlite, ["-readonly", "-batch", readOnlyURI(file), query], { timeout: timeoutMs, encoding: "utf8", windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        const [ts, nanos, ...rest] = String(stdout).trim().split("|");
        const line = parseRetryLine(rest.join("|"));
        const seconds = Number(ts), ns = Number(nanos);
        if (!line || line.attempt !== attempt || !Number.isFinite(seconds) || !Number.isFinite(ns)) return resolve(null);
        resolve(seconds * 1000 + Math.floor(ns / 1e6) + line.delayMs);
      });
    } catch {
      resolve(null);
    }
  });
}
