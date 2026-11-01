// A core with one project bot hosting two workers through a fake WorkerHost (any engine), for the owner-routing tests.
import { vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../src/core/server";
import { Bot } from "../src/core/bot";
import { saveProjectRow } from "../src/core/projects";
import { Layout } from "../src/core/store/workspace";
import { INDEX_FORMAT } from "../src/core/store/subagent-store";
import type { AgentRegistry } from "../src/core/agent-registry";
import type { WorkerHost, WorkerInfo, WorkerOwner } from "../src/core/agent/workers";
import { tempDir } from "./helpers";

export const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
export const OTHER = "C0FFEE00-0000-4000-8000-000000000009";
export const W1 = "task-worker-1", W2 = "task-worker-2";

export type Engine = "codex" | "agy" | "claude";
export interface FakeHost extends WorkerHost { owners: Map<string, WorkerOwner | null>; sent: { id: string; text: string }[]; stopped: string[]; states: Map<string, WorkerInfo["state"]>; refuseOwner: Set<string> }

export function fakeHost(engine: Engine, ids: string[]): FakeHost {
  const host: FakeHost = {
    workerHostKind: engine === "codex" ? "codex-thread" : engine === "agy" ? "agy-acp" : "claude-process",
    steersRunning: engine !== "agy",
    owners: new Map(), sent: [], stopped: [], states: new Map(ids.map((id) => [id, "running" as const])), refuseOwner: new Set(),
    listWorkers: () => ids.map((id) => ({ id, engine, name: id, run: 1, state: host.states.get(id)!, conversationId: null, processes: [], owner: host.owners.get(id) ?? null })),
    sendToWorker(id, text) {
      if (!ids.includes(id)) return { ok: false, reason: "No such worker." };
      const running = host.states.get(id) === "running";
      if (running && !host.steersRunning) return { ok: false, busy: true, reason: "It takes no words while it works." };
      host.sent.push({ id, text });
      if (!running) host.states.set(id, "running");
      return { ok: true, how: running ? "steered" : "newRun", run: running ? 1 : 2 };
    },
    async stopWorker(id) { if (host.states.get(id) !== "running") return false; host.states.set(id, "stopped"); host.stopped.push(id); return true; },
    setWorkerOwner(id, owner) {
      if (host.refuseOwner.has(id)) return { ok: false, reason: "its report is being handed over right now" };
      host.owners.set(id, owner); return { ok: true };
    },
    answer: () => false,
    close: async () => undefined,
  };
  return host;
}

export function fixture(engine: Engine) {
  const dir = tempDir(`agent-owner-${engine}`);
  const folder = tempDir(`agent-owner-${engine}-project`);
  mkdirSync(join(folder, ".bot"), { recursive: true });
  writeFileSync(Layout.settings(dir), JSON.stringify({ agentMoves: true }));
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: OTHER, name: "Helper", folder, avatar: "square", job: "helps" });
  const store = Layout.bot(dir, PROJECT);
  mkdirSync(join(store, "subagents"), { recursive: true });
  writeFileSync(join(store, "bot.json"), JSON.stringify({ engine, heads: { engines: [engine] } }));
  const record = (id: string, description: string) => ({ id, description, prompt: `Do ${description}`, status: "running", background: true, startedAt: 800_000_000, type: `${engine}-worker`,
    execution: { run: 1, ownerSessionId: "coord", threadId: null, turnId: null }, stepCount: 0, toolCount: 0 });
  writeFileSync(join(store, "subagents.json"), JSON.stringify({ format: INDEX_FORMAT, subagents: [record(W1, "Research the API"), record(W2, "Write the client")] }));
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const host = fakeHost(engine, [W1, W2]);
  vi.spyOn(bots.get(PROJECT)!, "workerHostFor").mockImplementation((id: string) => (host.listWorkers().some((w) => w.id === id) ? host : null));
  return { dir, folder, core, bots, host, registry: (core as any).agents as AgentRegistry };
}

export const messages: { id: string; text: string }[] = [];
export const relays: { id: string; text: string }[] = [];
export let turns = 0;
export function stubTurns() {
  messages.length = 0; relays.length = 0;
  vi.spyOn(Bot.prototype, "appMessage").mockImplementation(function (this: Bot, text: string) { messages.push({ id: this.id, text }); return `turn-${++turns}`; });
  vi.spyOn(Bot.prototype, "relay").mockImplementation(function (this: Bot, text: string) { relays.push({ id: this.id, text }); return { messageId: "m", turnId: "t" } as any; });
}
export const notices = (bots: Map<string, Bot>, id: string, pattern: RegExp) => ((bots.get(id) as any).records as { role: string; text: string }[]).filter((r) => r.role === "notice" && pattern.test(r.text));
export const rows = (core: Core, id: string) => core.snapshot().bots.find((bot) => bot.id === id)?.subagentRows ?? [];

