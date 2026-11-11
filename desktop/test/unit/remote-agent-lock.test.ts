// botling-agent's session lock across agent processes (the ssh path: one process per connection). An older process
// whose connection was not noticed yet still runs claude; the newer connection's attach ends that claude before
// anything else happens there, and from then on the older process logs and applies nothing (OneProc, OpenNotApplied).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HeadConfig, HeadHandlers } from "../../src/core/agent/head";
import { AgentServer } from "../../src/remote/agent/server";
import type { UpFrame } from "../../src/remote/protocol";

const S = "worker-1";
const config: HeadConfig = { command: "claude", cwd: "/p", sessionId: "s", resume: false, allowedTools: [] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function agentOn(home: string, id: number, killed: number[], alive: Set<number>) {
  const claudes: { pid: number; handlers: HeadHandlers; answers: unknown[] }[] = [];
  const server = new AgentServer({
    home, version: "1", sha: "", id,
    spawn: (_c, handlers, { run }) => {
      const claude = { pid: id * 100 + run, handlers, answers: [] as unknown[], start() {}, send() {}, finish() {},
        answer(...a: unknown[]) { claude.answers.push(a); },
        async terminate() { alive.delete(claude.pid); return {}; } };
      alive.add(claude.pid);
      claudes.push(claude);
      return claude;
    },
    alive: (pid) => alive.has(pid),
    killTree: async (pid) => { killed.push(pid); alive.delete(pid); },
  });
  const up: UpFrame[] = [];
  const link = server.connect((f) => up.push(f));
  return { server, link, up, claudes };
}

describe("botling-agent session lock", () => {
  it("the newer connection ends the older process's claude; the older process then applies and logs nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "botling-agent-lock-"));
    dirs.push(home);
    const killed: number[] = [], alive = new Set<number>();
    const a = agentOn(home, 1, killed, alive);
    await a.link.recv({ t: "hello", s: S, g: 1, p: 1 });
    await a.link.recv({ t: "start", s: S, g: 1, v: "1", run: { config, cwd: "/p", words: "go", uuid: "u" } });
    a.claudes[0]!.handlers.onItem({ kind: "permission", requestId: "n1", tool: "Bash", summary: "ls", input: { command: "ls" } } as never);
    expect(a.up.filter((f) => f.t === "ev").map((f) => (f as { e: { t: string } }).e.t)).toEqual(["ask"]);
    expect(alive).toEqual(new Set([101]));

    // Connection 1 dropped; process 1 has not noticed. Connection 2 is a new process.
    const b = agentOn(home, 2, killed, alive);
    await b.link.recv({ t: "hello", s: S, g: 2, p: 1 });
    expect(b.up.at(-1)).toMatchObject({ t: "hi", g: 2, v: "1" });
    await b.link.recv({ t: "attach", s: S, g: 2, from: 0 });
    expect(killed).toEqual([101]);
    expect(alive.size).toBe(0);
    expect(b.up.map((f) => f.t)).toEqual(["hi", "ev", "attached"]);

    // The old answer reaching process 1 now is refused: it no longer holds the session.
    await a.link.recv({ t: "answer", s: S, g: 1, k: "q1", allow: true, input: { command: "ls" } });
    expect(a.up.at(-1)).toMatchObject({ t: "refused", k: "q1" });
    expect(a.claudes[0]!.answers).toEqual([]);
    // What process 1's claude says late is not logged.
    a.claudes[0]!.handlers.onItem({ kind: "assistantText", text: "late" });
    expect(b.server.logOf(S).length).toBe(1);

    // The resumed run asks the same thing again: the same request, answered once, from the connection that holds it.
    await b.link.recv({ t: "start", s: S, g: 2, v: "1", run: { config: { ...config, resume: true }, cwd: "/p", words: "go on", uuid: "u2" } });
    b.claudes[0]!.handlers.onItem({ kind: "permission", requestId: "n2", tool: "Bash", summary: "ls", input: { command: "ls" } } as never);
    expect(b.up.at(-1)).toMatchObject({ t: "ev", n: 2, e: { t: "ask", k: "q1" } });
    await b.link.recv({ t: "answer", s: S, g: 2, k: "q1", allow: true, input: { command: "ls" } });
    expect(b.claudes[0]!.answers).toEqual([["n2", true, { command: "ls" }, undefined]]);
    await b.link.recv({ t: "answer", s: S, g: 2, k: "q1", allow: true, input: { command: "ls" } });
    expect(b.up.at(-1)).toMatchObject({ t: "refused", k: "q1" });
    expect(b.claudes[0]!.answers.length).toBe(1);
    await a.server.close(); await b.server.close();
  });
});
