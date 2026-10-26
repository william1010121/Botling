// The task cards a real core publishes (fake engines only): plain chat leaves none, a failed turn
// leaves no "Claiming…" card, a <task> line makes one.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";

const clients: CoreHarness[] = [];
const core = (dir: string, env: Record<string, string> = {}) => { const c = new CoreHarness(dir, env); clients.push(c); return c; };
afterEach(async () => { for (const c of clients.splice(0)) await c.kill("SIGKILL"); });

const send = async (c: CoreHarness, text: string) => {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  return until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
};

describe("task cards over the core transport", () => {
  it("plain replies publish no task cards; a <task> line publishes one, named", async () => {
    const c = core(tempDir("task-panel"));
    await send(c, "helo");
    await send(c, "什麼意思。我允許");
    expect((await c.chat()).tasks).toEqual([]);
    expect((c.of("tasks.updated").at(-1)!.event as any).tasks).toEqual([]);
    await send(c, "/task");
    expect((await c.chat()).tasks.map((task: any) => [task.name, task.state])).toEqual([["Docs", "running"]]);
  });

  it("a turn that fails leaves no pending card behind", async () => {
    const c = core(tempDir("task-panel-crash"), { FAKE_CLAUDE_MODE: "crash" });
    const finished = await send(c, "go");
    expect(finished.event).toMatchObject({ status: "failed" });
    expect((await c.chat()).tasks).toEqual([]);
  });

  it("stuck provisional cards 1.x saved are not shown after a restart", async () => {
    const dir = tempDir("task-panel-legacy");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "chat.json"), JSON.stringify([{ id: "u1", role: "user", text: "helo", date: 1 }, { id: "u2", role: "user", text: "docs", date: 2 }]));
    writeFileSync(join(dir, "main", "tasks.json"), JSON.stringify([
      { id: "A", name: "helo", state: "pending", createdAt: 1, updatedAt: 1, messageIDs: ["u1"], kept: false },
      { id: "B", name: "Docs", state: "running", now: "writing", createdAt: 2, updatedAt: 2, messageIDs: ["u2"], kept: true },
    ]));
    const c = core(dir);
    expect((await c.chat()).tasks.map((task: any) => task.id)).toEqual(["B"]);
  });
});
