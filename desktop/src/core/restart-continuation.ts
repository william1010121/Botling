// Explicit restart is a one-shot execution handover, not a process resurrection.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./durable/atomic";
import { specTrace } from "./spec-trace";
import type { SwapEntry, SwapQueued } from "./hot-swap";
import type { WorkerRecord } from "./agent/codex";

export const RESTART_FILE = "restart-continuation.json";
/** A ready journal older than this is stale (an old quit the user may have meant to be final): not resumed. */
export const RESTART_MAX_AGE_MS = 15 * 60_000;
export const RESTART_NOTE = "(App: The user explicitly approved restarting Botling while work was in progress. Resume only the unfinished authorized work in this same conversation. Preserve the original task scope, research-only boundaries, permissions and cancellations. Do not repeat completed actions or retry any command whose outcome is uncertain. Reconcile existing results first; if evidence is insufficient, report the exact blocker.)";

export interface RestartQueued extends SwapQueued {
  turnId: string;
  messageId: string;
  handoffId: string | null;
  conducted: boolean;
}
export interface RestartEntry extends SwapEntry {
  nativeChildren?: import("./claude-restart").NativeRestartChild[];
  nativeCwd?: string;
  nativeConfigDir?: string;
  sessionStarted?: boolean;
  providerTurnId?: string;
  queued: RestartQueued[];
  turnId?: string;
  messageId?: string;
  userId?: string | null;
  handoffId?: string | null;
  blocked?: string;
  /** Read for one version: written by cores before the worker ledger (its workers now say what they need there). */
  workers?: WorkerRecord[];
  /** Read for one version: Claude app workers that were at work (the ledger now names them: interruptedBy "restart"). */
  claudeWorkers?: string[];
  /** When the restart was prepared: the workers it interrupted are the ledger's records interrupted by a restart since. */
  restartedAt?: number;
  state?: "pending" | "claimed" | "dispatched" | "blocked";
}
interface RestartIntent { v: 1; id: string; phase: "preparing" | "ready"; entries: RestartEntry[]; at?: number }

/**
 * The chat notice for an entry that was not continued. Its queued messages never reached the provider, and nothing sends
 * them now (the entry is blocked as a whole), so the notice names them: the user's words and workers' reports are not
 * lost without a word.
 */
export function restartPausedNotice(entry: RestartEntry, reason: string): string {
  const head = `Restart continuation paused (${entry.engine}, ${entry.botId}): ${reason}`;
  const waiting = entry.queued ?? [];
  if (!waiting.length) return head;
  const shown = waiting.slice(0, 5).map((q) => {
    const words = q.words.replace(/\s+/g, " ").trim();
    const task = /^<app_task_result\b[^>]*\btask_id="([^"]+)"/.exec(words)?.[1];
    const what = /^<app_task_result\b/.test(words) ? `a worker's report${task ? ` (task ${task})` : ""}`
      : `${q.origin === "user" ? "your message" : "an app message"} "${words.length > 80 ? `${words.slice(0, 80)}…` : words}"`;
    return `- ${what}`;
  });
  if (waiting.length > shown.length) shown.push(`- and ${waiting.length - shown.length} more`);
  return `${head}\n${waiting.length === 1 ? "This message was" : `These ${waiting.length} messages were`} waiting and were not sent; send again what is still needed:\n${shown.join("\n")}`;
}

function validEntry(e: RestartEntry): boolean {
  return !!e && typeof e.botId === "string" && ["claude", "codex", "agy"].includes(e.engine)
    && typeof e.sessionId === "string" && e.sessionId.length > 0 && typeof e.continue === "boolean"
    && ["pending", "claimed", "dispatched", "blocked"].includes(e.state ?? "")
    && (e.blocked === undefined || typeof e.blocked === "string")
    && Array.isArray(e.queued) && e.queued.every(q => q && typeof q.words === "string"
      && ["user", "app", "background"].includes(q.origin) && typeof q.turnId === "string"
      && typeof q.messageId === "string" && (q.userId === null || typeof q.userId === "string"))
    && (e.claudeWorkers === undefined || Array.isArray(e.claudeWorkers) && e.claudeWorkers.every(id => typeof id === "string"))
    && (e.restartedAt === undefined || Number.isFinite(e.restartedAt))
    && (e.workers === undefined || Array.isArray(e.workers) && e.workers.every(w => w
      && typeof w.id === "string" && typeof w.name === "string" && typeof w.instructions === "string"
      && Number.isSafeInteger(w.run) && w.run >= 1 && typeof w.wasActive === "boolean" && typeof w.reportPending === "boolean"));
}

/** One step of the restart spec (spec/models/restart): the journal as written, and the step's own details. */
function traced(action: string, value: RestartIntent | null, details: Record<string, unknown> = {}) {
  specTrace("restart", action, { ...details, phase: value?.phase ?? "none",
    entries: value?.entries.map(e => ({ bot: e.botId, state: e.state, blocked: e.blocked ?? null })) ?? [] });
}

/** A claim is durable before provider I/O. A crash after claim requires reconciliation, never retry. */
export class RestartJournal {
  private readonly file: string;
  constructor(dataDir: string) { this.file = join(dataDir, RESTART_FILE); }

  private read(): RestartIntent | null {
    if (!existsSync(this.file)) return null;
    const value = JSON.parse(readFileSync(this.file, "utf8")) as RestartIntent;
    if (!value || value.v !== 1 || typeof value.id !== "string" || !Array.isArray(value.entries)
      || !["preparing", "ready"].includes(value.phase) || !value.entries.every(validEntry)
      || new Set(value.entries.map(e => `${e.botId}:${e.engine}`)).size !== value.entries.length) {
      throw Error("Restart continuation is unreadable; preserved for reconciliation.");
    }
    return value;
  }

  private save(value: RestartIntent) { writeFileAtomic(this.file, JSON.stringify(value)); }

  prepare(entries: RestartEntry[]) {
    const prior = this.read();
    if (prior?.entries.some(e => e.state === "pending" || e.state === "claimed")) {
      throw Error("An earlier restart requires reconciliation.");
    }
    const value: RestartIntent = { v: 1, id: randomUUID(), phase: "preparing", at: Date.now(), entries: entries.map(e => ({ ...e, state: "pending" })) };
    this.save(value);
    traced("Prepare", value);
  }

  cancel() { rmSync(this.file, { force: true }); traced("Cancel", null); }

  checkpoint(entries: RestartEntry[]) {
    const value = this.read();
    if (!value || value.phase !== "preparing") throw Error("Missing restart preparation");
    value.entries = entries.map(e => ({ ...e, state: "pending" }));
    this.save(value);
    traced("BeginShutdown", value);
  }

  /** Shutdown is over. `failed`: bots whose own shutdown failed (by id, with why); their entries are held back, the rest resume. */
  ready(failed: ReadonlyMap<string, string> = new Map()) {
    const value = this.read();
    if (!value) throw Error("Missing restart intent");
    for (const entry of value.entries) {
      const reason = failed.get(entry.botId);
      if (reason !== undefined && !entry.blocked) entry.blocked = `This bot's shutdown did not finish (${reason}); nothing was restarted.`;
    }
    value.phase = "ready";
    value.at = Date.now();
    this.save(value);
    traced("Ready", value);
  }

  recover(deliver: (entry: RestartEntry) => void, notice: (entry: RestartEntry, reason: string) => void, now = Date.now()) {
    const value = this.read();
    traced("Boot", value);
    if (!value) return;
    const stale = typeof value.at === "number" && now - value.at > RESTART_MAX_AGE_MS;
    for (const entry of value.entries) {
      if (entry.state === "dispatched" || entry.state === "blocked") continue;
      const reason = entry.blocked || (stale ? "The restart checkpoint is too old to resume safely; nothing was restarted." : value.phase !== "ready" ? "Shutdown did not confirm the restart checkpoint."
        : entry.state === "claimed" ? "Continuation delivery is uncertain after a crash." : null);
      // Told before it is marked: a crash in between tells it again, never not at all.
      if (reason) {
        notice(entry, reason);
        traced("Notice", value, { bot: entry.botId, reason });
        entry.state = "blocked";
        this.save(value);
        traced("Block", value, { bot: entry.botId });
        continue;
      }
      entry.state = "claimed";
      this.save(value);
      traced("Claim", value, { bot: entry.botId });
      try {
        deliver(entry);
        traced("Deliver", value, { bot: entry.botId, ok: true });
        entry.state = "dispatched";
        this.save(value);
        traced("Dispatch", value, { bot: entry.botId });
      } catch (error) {
        traced("Deliver", value, { bot: entry.botId, ok: false });
        entry.blocked = String(error);
        notice(entry, entry.blocked);
        traced("Notice", value, { bot: entry.botId, reason: entry.blocked });
        entry.state = "blocked";
        this.save(value);
        traced("Block", value, { bot: entry.botId });
      }
    }
  }
}
