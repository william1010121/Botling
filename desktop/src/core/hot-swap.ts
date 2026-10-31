// The core side of draining and handing over running heads. Since 2.1.0 only the restart continuation (restart-continuation.ts) uses it; there is no core hot swap.
//
// Draining: no turn begins any more (what arrives waits in the bot's queue and is handed over);
// turns under way finish on their own, within `timeoutMs`. One still running then is stopped at a
// tool-call boundary (no tool call in flight, or `boundaryMs` later at the latest) and the new core
// tells it to carry on. What is handed over is written to `<core data>/swap-handover.json`: each
// head's session (claude `--resume`, Codex `thread/resume` by the same session's thread file), whether
// it was cut off, and the turns that waited. The new core reads it once at its start.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./durable/atomic";
import type { Engine } from "./heads";

export const SWAP_FILE = "swap-handover.json";
/** A handover older than this is stale (the swap went wrong long ago): not applied. */
export const SWAP_MAX_AGE_MS = 15 * 60_000;

/** What a cut-off head is told when the new core starts it again in the same conversation. */
export const CONTINUE_NOTE = "(App: Botling replaced its core process while you were working, so your last turn was stopped between tool calls. This is the same conversation and your context is intact. Continue exactly where you stopped; do not repeat steps that already finished.)";

export interface SwapQueued { words: string; userId: string | null; origin: string }

export interface SwapEntry {
  /** The bot whose chat it is (the primary's id for a partner head). */
  botId: string;
  engine: Engine;
  /** The session the head resumes; null: it had none (only its waiting turns are handed over). */
  sessionId: string | null;
  /** Its turn was cut off: told to carry on after the swap. */
  continue: boolean;
  /** Turns that waited (messages, routines, hand-offs), delivered after the swap in order. */
  queued: SwapQueued[];
}

export interface SwapHandover { v: 1; at: number; entries: SwapEntry[] }

/** One bot as draining sees it (core/bot.ts implements it; tests give fakes). */
export interface Drainable {
  readonly id: string;
  /** Hold: no new turn begins (they wait in its queue). */
  holdForSwap(hold: boolean): void;
  /** A turn (or a tidy, a subagent, a Codex worker) is under way. */
  readonly swapBusy: boolean;
  /** A tool call has been made and has not returned yet. */
  readonly swapToolInFlight: boolean;
  /** Stops what is under way (the conversation goes on). */
  swapInterrupt(): Promise<void>;
  /** Its heads' sessions and waiting turns. */
  swapEntries(cutOff: boolean): SwapEntry[];
  /** Writes its files out now. */
  flushForSwap(): void | Promise<void>;
}

export interface DrainOptions {
  timeoutMs: number;
  boundaryMs: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export interface DrainResult { entries: SwapEntry[]; interrupted: string[] }

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the bots to be quiet, stops the ones that are not in time, and says what to hand over. */
export async function drainBots(bots: Drainable[], options: DrainOptions): Promise<DrainResult> {
  const poll = options.pollMs ?? 100;
  for (const bot of bots) bot.holdForSwap(true);
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  while (bots.some((bot) => bot.swapBusy) && Date.now() < deadline) await pause(poll);
  const late = bots.filter((bot) => bot.swapBusy);
  const interrupted: string[] = [];
  await Promise.all(late.map(async (bot) => {
    // At a tool-call boundary: not while a call is out (its result would be lost to the conversation).
    const boundary = Date.now() + Math.max(0, options.boundaryMs);
    while (bot.swapBusy && bot.swapToolInFlight && Date.now() < boundary) await pause(poll);
    if (!bot.swapBusy) return;
    options.log?.(`core swap: ${bot.id} did not finish in time; stopping it${bot.swapToolInFlight ? " with a tool call still out" : " between tool calls"}`);
    interrupted.push(bot.id);
    await bot.swapInterrupt().catch((error) => options.log?.(`core swap: stopping ${bot.id}: ${(error as Error).message}`));
  }));
  const entries = bots.flatMap((bot) => bot.swapEntries(interrupted.includes(bot.id)));
  const saved = await Promise.allSettled(bots.map(bot => Promise.resolve().then(() => bot.flushForSwap())));
  const failure = saved.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return { entries, interrupted };
}

export function writeHandover(dataDir: string, entries: SwapEntry[], now = Date.now()) {
  const handover: SwapHandover = { v: 1, at: now, entries };
  writeFileAtomic(join(dataDir, SWAP_FILE), JSON.stringify(handover, null, 2));
}

export function discardHandover(dataDir: string) {
  rmSync(join(dataDir, SWAP_FILE), { force: true });
}

const ENGINES = new Set(["claude", "codex", "agy"]);
const SESSION = /^[0-9A-Za-z-]{1,64}$/;

/** The handover for this start, once (the file is removed); null when there is none, it is stale or unreadable. */
export function takeHandover(dataDir: string, now = Date.now(), maxAgeMs = SWAP_MAX_AGE_MS): SwapHandover | null {
  const file = join(dataDir, SWAP_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { raw = null; }
  rmSync(file, { force: true });
  const value = raw as Partial<SwapHandover> | null;
  if (!value || value.v !== 1 || typeof value.at !== "number" || !Array.isArray(value.entries)) return null;
  if (now - value.at > maxAgeMs || value.at - now > 60_000) return null;
  const entries: SwapEntry[] = [];
  for (const item of value.entries.slice(0, 500) as Partial<SwapEntry>[]) {
    if (!item || typeof item.botId !== "string" || !ENGINES.has(item.engine as string)) continue;
    const sessionId = typeof item.sessionId === "string" && SESSION.test(item.sessionId) ? item.sessionId : null;
    const queued = Array.isArray(item.queued) ? item.queued.slice(0, 50).flatMap((turn: Partial<SwapQueued>) =>
      turn && typeof turn.words === "string" && typeof turn.origin === "string"
        ? [{ words: turn.words.slice(0, 200_000), userId: typeof turn.userId === "string" ? turn.userId : null, origin: turn.origin }] : []) : [];
    entries.push({ botId: item.botId, engine: item.engine as Engine, sessionId, continue: item.continue === true, queued });
  }
  return { v: 1, at: value.at, entries };
}
