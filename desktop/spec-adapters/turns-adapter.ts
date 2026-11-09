// spec/driver/turns-driver.ts against the real code: a Bot (core/bot.ts) whose claude head is ClaudeHead with its
// process taken out. Its methods that would spawn, write or end a process keep the lines it was sent here instead, and
// what claude does with them (begin, read into the turn under way, show, end) comes in through the head's own stream
// handler as claude's items would. Lines carry their model name in their words ("[[u1]]"); the resume note is told by
// its words. A turn is named by the line it was made for (the first time it is seen: steering a line into a turn
// changes its words), its kind by its origin.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnsDriver } from "../../spec/driver/turns-driver";
import { NoLine, R, type Kind, type TurnsView } from "../../spec/reference/turns";
import { ClaudeHead } from "../src/core/agent/head";
import { Bot } from "../src/core/bot";
import { botPrompts, RESUME_NOTE } from "../src/core/prompts";
import { mainProfile } from "../src/core/store/workspace";

/** Lets the promise chains the last action started run to their end. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

const MOVED = { told: "your working folder changed", shown: "Working folder changed." };
const words = (line: string) => `[[${line}]]`;
/** A line's model name: its own words come last (a wake's briefing quotes the chat before them). */
const lineOf = (text: string): string => [...text.matchAll(/\[\[(\w+)\]\]/g)].at(-1)?.[1] ?? (text.includes(RESUME_NOTE) ? R : NoLine);
const kindOf = (origin: string): Kind => (origin === "user" ? "user" : origin === "app" ? "app" : origin === "tidy" ? "tidy" : "bg");

interface Stand {
  inbox: { line: string; id: string }[];
  cline: { line: string; id: string } | null;
}

type Patched = "start" | "send" | "interrupt" | "finish" | "terminate";

export async function createTurnsDriver({ dataDir }: { dataDir: string }): Promise<TurnsDriver> {
  const stands = new WeakMap<ClaudeHead, Stand>();
  const proto = ClaudeHead.prototype as unknown as Record<Patched, unknown>;
  const saved = { start: proto.start, send: proto.send, interrupt: proto.interrupt, finish: proto.finish, terminate: proto.terminate };
  const handlersOf = (head: ClaudeHead) => (head as unknown as { handlers: { onItem(item: unknown): void; onExit(exit: unknown): void } }).handlers;
  proto.start = function (this: ClaudeHead) {
    stands.set(this, { inbox: [], cline: null });
    this.running = true;
    queueMicrotask(() => handlersOf(this).onItem({ kind: "init", sessionId: this.config.sessionId }));
  };
  proto.send = function (this: ClaudeHead, text: string, id: string) { stands.get(this)?.inbox.push({ line: lineOf(text), id }); };
  proto.interrupt = function () { return "interrupt"; };
  proto.finish = function (this: ClaudeHead) {
    if (!this.running) return;
    this.running = false;
    (this as unknown as { exitedResolve(): void }).exitedResolve();
    handlersOf(this).onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false });
  };
  proto.terminate = async function (this: ClaudeHead) { (proto.finish as () => void).call(this); return { killed: [], forced: false }; };

  const folder = join(dataDir, "project");
  const profile = mainProfile(folder);
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", model: "opus", heads: { engines: ["claude"], answerWith: "claude" } }));
  let moves = 0;
  const where = { tree: null as null | { cwd: string; addDirs: string[] } };
  const bot = new Bot({
    profile, deferStartup: true, ledger: { record() {}, forget() {} } as never,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (engine, heads) => botPrompts({ profile, engine, heads }), emit() {}, log() {},
    // Nothing happens by the clock: no sleep, no tree kill of a stopped turn (the model's Tidy and Grace are not driven).
    idleMs: 1e9, approvalTimeoutMs: 1e9, interruptGraceMs: 1e9,
    worktree: () => where.tree,
  });
  const inner = bot as unknown as {
    head: ClaudeHead | null; turn: TurnLike | null; deferred: TurnLike | null; queue: TurnLike[]; paused: unknown; settingsHold: unknown;
    draining: unknown; folderPending: boolean; steered: Map<string, TurnLike>;
    deliverTo(engine: string, words: string, userId: string | null, extra: object): TurnLike; checkSettingsHold(): void;
  };
  interface TurnLike { id: string; words: string; origin: string; open: boolean; sent: boolean }
  /** The line each turn was made for, the first time it was seen. */
  const names = new Map<string, string>();
  const name = (turn: TurnLike) => { if (!names.has(turn.id)) names.set(turn.id, lineOf(turn.words)); return names.get(turn.id)!; };
  const stand = () => (inner.head?.running ? stands.get(inner.head) ?? null : null);
  const item = (value: unknown) => { if (inner.head) handlersOf(inner.head).onItem(value); };
  const command = (id: string, state: string) => item({ kind: "command", id: id.toLowerCase(), state });
  const pending: Promise<unknown>[] = [];
  const view = (): TurnsView => {
    for (const turn of [inner.turn, inner.deferred, ...inner.queue]) if (turn) name(turn);
    const turn = inner.turn?.open ? inner.turn : null;
    const head = stand();
    const cwd = inner.head?.running ? inner.head.config.cwd : null;
    return {
      queue: inner.queue.filter((t) => t.open).map(name),
      turn: turn ? { line: name(turn), kind: kindOf(turn.origin), sent: turn.sent } : null,
      deferred: inner.deferred?.open ? name(inner.deferred) : null,
      steered: [...inner.steered.values()].map((t) => lineOf(t.words)).sort(),
      paused: !!inner.paused, hold: !!inner.settingsHold, draining: !!inner.draining,
      awake: !!inner.head?.running, headAt: cwd === null ? -1 : cwd === folder ? 0 : Number(cwd.slice(cwd.lastIndexOf("f") + 1)),
      pending: inner.folderPending,
      inbox: head ? head.inbox.map((l) => l.line) : [],
    };
  };
  const idOf = (line: string, turns: (TurnLike | null)[]) => turns.find((t) => t?.open && name(t) === line)?.id;

  return {
    async arrive(line, from) {
      if (from.user) bot.send(words(line));
      else inner.deliverTo("claude", words(line), null, { origin: "app", conducted: from.conducted });
      await flush();
    },
    async stop() { if (inner.turn) pending.push(bot.stop(inner.turn.id)); await flush(); },
    async stopQueued(line) { const id = idOf(line, inner.queue); if (id) await bot.stop(id); await flush(); },
    async stopDeferred() { if (inner.deferred) await bot.stop(inner.deferred.id); await flush(); },
    async begin() {
      const head = stand()!;
      const line = head.inbox.shift()!;
      head.cline = line;
      command(line.id, "started");
      await flush();
    },
    async read(said) {
      const line = stand()!.inbox.shift()!;
      if (said) command(line.id, "started");
      command(line.id, "completed");
      await flush();
    },
    async show() { item({ kind: "delta", text: "Working on it." }); await flush(); },
    async end() {
      const head = stand()!;
      const line = head.cline;
      head.cline = null;
      item({ kind: "result", ok: true, text: "Done.", subtype: "end_turn" });
      if (line) command(line.id, "completed");
      await flush();
    },
    async startWork() { item({ kind: "managedPending", pending: true }); await flush(); },
    async move() {
      moves += 1;
      where.tree = { cwd: `/turns/f${moves}`, addDirs: [] };
      bot.folderMoved(MOVED);
      await flush();
    },
    async swap(on) { bot.holdForSwap(on); await flush(); },
    async releaseHold() { inner.checkSettingsHold(); await flush(); },
    view,
    async close() {
      await bot.shutdown({ tidy: false });
      Object.assign(proto, saved);
    },
  };
}
