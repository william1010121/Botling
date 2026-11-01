// Codex workers on the contract suite (test/unit/worker-core-contract.test.ts): the real CodexThreadAdapter
// (agent/codex.ts) on a recorded `codex app-server` (test/fixtures/worker-streams/codex). A recording is a whole
// app-server session, the coordinator's turns included: its lines go to the adapter as CodexSession routes them (a
// worker's thread → the adapter; anything else is not a worker's), and the adapter's JSON-RPC requests are answered
// by the recorded responses to the worker requests of the same method, in order.
import { CodexThreadAdapter, type CodexConfig } from "../../src/core/agent/codex";
import type { Fixture, ReplayRegistration, ReplaySource, ReplayProcess } from "./replay";

const config: CodexConfig = {
  cwd: "/WORK", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null,
  restoredWorkers: [], ownerSession: "00000000-0000-4000-8000-0000000000c0",
};

/**
 * The recorded worker requests (id → its method and place among that method's): every request but the handshake and
 * the coordinator's own thread. The app-server can answer them out of order (two workers' turn/start).
 */
function workerRequests(fixture: Fixture): { byId: Map<unknown, { method: string; index: number }>; perMethod: Map<string, number> } {
  const requests = fixture.lines.filter((line) => line.d === "in").map((line) => JSON.parse(line.l)).filter((m) => typeof m.method === "string" && m.id !== undefined);
  const firstStart = requests.find((m) => m.method === "thread/start");
  const response = firstStart ? fixture.lines.filter((line) => line.d === "out").map((line) => JSON.parse(line.l)).find((m) => m.id === firstStart.id && !m.method) : undefined;
  const coordinator = response?.result?.thread?.id;
  const byId = new Map<unknown, { method: string; index: number }>();
  const perMethod = new Map<string, number>();
  for (const m of requests.filter((r) => r !== firstStart && r.method !== "initialize" && r.params?.threadId !== coordinator)) {
    const index = perMethod.get(m.method) ?? 0;
    byId.set(m.id, { method: m.method, index });
    perMethod.set(m.method, index + 1);
  }
  return { byId, perMethod };
}

/** Every turn id the recording names (renamed when it plays again, so a follow-up's turn is a new one). */
function turnIds(fixture: Fixture): string[] {
  const ids = new Set<string>();
  for (const line of fixture.lines) {
    if (line.d !== "out") continue;
    const m = JSON.parse(line.l);
    for (const id of [m.result?.turn?.id, m.params?.turn?.id, m.params?.turnId]) if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

function codexOnRecording(source: ReplaySource): CodexThreadAdapter {
  let process: ReplayProcess | null = null;
  let clock = 0;
  /** The adapter's requests by method, in order (answered once each). */
  const sent = new Map<string, (((result: unknown, error: unknown) => void) | null)[]>();
  const adapter: CodexThreadAdapter = new CodexThreadAdapter({
    config, now: () => clock,
    wire: {
      request(method, params, reply) {
        const p = server();
        p.write(JSON.stringify({ jsonrpc: "2.0", id: p.written.length + 1, method, params }));
        sent.set(method, [...(sent.get(method) ?? []), reply]);
      },
      write: (value) => server().write(JSON.stringify(value)),
      item: () => undefined,
    },
  });
  /** The one app-server, started with the first worker's first request. */
  const server = (): ReplayProcess => {
    if (process) return process;
    const p = process = source.spawn();
    const requests = workerRequests(p.fixture);
    const turns = turnIds(p.fixture);
    const first = p.fixture.lines.find((line) => line.d === "out")?.l;
    let play = 0;
    p.onLine((raw, t) => {
      clock = t;
      if (raw === first) play += 1;
      const line = play > 1 ? turns.reduce((text, id) => text.split(id).join(`${id}#${play}`), raw) : raw;
      const m = JSON.parse(line);
      if (typeof m.method === "string") {
        const params = m.params && typeof m.params === "object" ? m.params : {};
        if (m.id !== undefined) adapter.serverRequest(m.method, m.id, params);
        else adapter.receive(m.method, params);
        return;
      }
      // The adapter's request in the same place among its requests of that method (a replay continues the count).
      const recorded = requests.byId.get(m.id);
      if (!recorded) return;
      const ours = sent.get(recorded.method) ?? [];
      const index = recorded.index + (requests.perMethod.get(recorded.method) ?? 0) * (play - 1);
      const reply = ours[index];
      if (!reply) return;
      ours[index] = null;
      reply(m.result ?? null, m.error ?? null);
    });
    p.onExit((exit, stderr) => adapter.exited([`The Codex app-server ended (${exit.signal ?? `exit ${exit.code}`}).`, stderr.trim().split("\n").slice(-3).join("\n")].filter(Boolean).join("\n")));
    return p;
  };
  return adapter;
}

export const registration: ReplayRegistration = {
  engine: "codex",
  kind: "codex-thread",
  ack: "checkpoint",
  create: codexOnRecording,
  skip: {
    C8: "a Codex worker's turns live in its coordinator's app-server, not in a process of its own: after a restart the coordinator reads the worker's thread (CodexSession's restart check, test/unit/codex-restart.test.ts), and process identities never hold it back",
    C10: "a Codex approval card carries no input (permission rules never match a Codex command), and a request naming a worker's thread cannot come before the recording has started that thread; worker-scoped ids are covered in test/unit/codex-workers-core.test.ts",
  },
};
