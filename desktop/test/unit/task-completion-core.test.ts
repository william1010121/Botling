// Real core transport and atomic tasks.json persistence; fake engines only, no installed data.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";

const clients: CoreHarness[] = [];
const core = (dir: string, env: Record<string, string> = {}) => {
  const c = new CoreHarness(dir, env); clients.push(c); return c;
};
afterEach(async () => { for (const c of clients.splice(0)) await c.kill("SIGKILL"); });
const seed = (dir: string, state = "pending", folder = "main", taskId = "task") => {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "chat.json"), JSON.stringify([{ id: "user", role: "user", text: "helo", date: 1 }]));
  writeFileSync(join(dir, folder, "tasks.json"), JSON.stringify([{ id: taskId, name: "helo", state, createdAt: 1, updatedAt: 1, messageIDs: ["user"], kept: false, declared: true }]));
};
const complete = (c: CoreHarness, taskId = "task", botId = MAIN) => c.call({ type: "task.complete", botId, taskId });

describe("task.complete over the core transport", () => {
  it.each(["pending", "waiting"])("immediately publishes and persists manual closure of stale %s through a core restart", async (state) => {
    const dir = tempDir("task-completion"); seed(dir, state);
    const c = core(dir);
    expect((await c.chat()).tasks[0].state).toBe(state);
    expect(await complete(c)).toEqual({ changed: true });
    const updated = (c.of("tasks.updated").at(-1)!.event as any).tasks[0];
    expect(updated).toMatchObject({ id: "task", state: "done", manuallyCompletedAt: expect.any(String), owner: null });
    expect((await c.chat()).tasks[0]).toEqual(updated);
    const saved = JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8"))[0];
    expect(saved).toMatchObject({ state: "done", kept: true, manuallyCompletedAt: expect.any(Number) });
    expect(await complete(c)).toEqual({ changed: false });
    await c.kill();
    expect((await core(dir).chat()).tasks[0]).toEqual(updated);
  });

  it("keeps an active app-managed Codex worker running and delivers its actual result after card closure", async () => {
    const dir = tempDir("task-completion-worker");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
    const c = core(dir, { FAKE_CODEX_WORKER_MS: "1800" });
    const sent = await c.call({ type: "chat.send", botId: MAIN, text: "/worker Build the parser" });
    await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === sent.turnId));
    const chat = await c.chat();
    const worker = chat.messages.find((m: any) => m.id === sent.messageId).steps.find((s: any) => s.kind === "subagent").id;
    const task = chat.tasks.find((t: any) => t.atWork);
    expect(task).toBeDefined();
    expect(await complete(c, task.id)).toEqual({ changed: true });
    expect((await c.call({ type: "subagent.view", botId: MAIN, subagentId: worker })).subagent.status).toBe("running");
    expect((await c.chat()).tasks.find((t: any) => t.id === task.id)).toMatchObject({ state: "done", atWork: true });
    const report = await until(async () => (await c.chat()).messages.find((m: any) => m.text === "The worker finished: Worker did: Build the parser"));
    expect(report.state).toBe("done");
    expect((await c.call({ type: "subagent.view", botId: MAIN, subagentId: worker })).subagent).toMatchObject({ status: "completed", result: "Worker did: Build the parser" });
    const after = (await c.chat()).tasks.find((t: any) => t.id === task.id);
    expect(after).toMatchObject({ state: "done", atWork: false, manuallyCompletedAt: expect.any(String) });
    expect(after.messageIds).toContain(report.id);
  });

  it("rejects missing tasks and rolls back memory without publishing on a persistence failure", async () => {
    const dir = tempDir("task-completion-write"); seed(dir);
    const c = core(dir); await c.chat();
    await expect(complete(c, "missing")).rejects.toThrow(/not_found/);
    const file = join(dir, "main", "tasks.json");
    renameSync(file, `${file}.backup`); mkdirSync(file);
    await expect(complete(c)).rejects.toThrow(/internal/);
    expect(c.of("tasks.updated")).toHaveLength(0);
    expect((await c.chat()).tasks[0]).toMatchObject({ state: "pending" });
    rmdirSync(file); renameSync(`${file}.backup`, file);
    expect(await complete(c)).toEqual({ changed: true });
  });

  it("allows manual closure under an advisory project lock without changing the holder's tasks or lock", async () => {
    const dir = tempDir("task-completion-lock");
    const project = "44444444-4444-4444-8444-444444444444";
    const folder = join(dir, "project"); mkdirSync(folder);
    for (const name of ["a", "b"]) {
      const profile = join(dir, name);
      seed(profile, "pending", join("projects", project), `${name}-task`);
      writeFileSync(join(profile, "projects.json"), JSON.stringify([{ id: project, name: "Project", folder: pathToFileURL(folder).href + "/", avatar: "hexagon" }]));
    }
    const first = core(join(dir, "a"));
    const firstTask = (await first.chat(project)).tasks.find((t: any) => t.id === "a-task");
    expect(firstTask).toMatchObject({ state: "pending" });
    const lockFile = join(folder, ".bot", "botling.lock");
    const lock = readFileSync(lockFile, "utf8");
    expect(JSON.parse(lock)).toMatchObject({ app: "Botling 2.0", pid: first.child.pid, dataDir: join(dir, "a") });
    const firstFile = join(dir, "a", "projects", project, "tasks.json");
    const firstSaved = readFileSync(firstFile, "utf8");
    const second = core(join(dir, "b"));
    const snapshot = await second.call({ type: "chat.snapshot", botId: project });
    expect(snapshot.bots.find((b: any) => b.id === project).problem).toBeNull();
    expect(snapshot.chat.messages.some((m: any) => m.text.includes(`Another Botling (Botling 2.0, pid ${first.child.pid}) has this project open. Both may write`))).toBe(true);
    expect(snapshot.chat.tasks.find((t: any) => t.id === "b-task")).toMatchObject({ state: "pending" });
    // Task IDs belong to the profile, even when both bots work in the same project folder.
    await expect(complete(second, "a-task", project)).rejects.toThrow(/not_found/);
    expect(second.of("tasks.updated")).toHaveLength(0);
    expect(await complete(second, "b-task", project)).toEqual({ changed: true });
    const updated = (second.of("tasks.updated").at(-1)!.event as any).tasks.find((t: any) => t.id === "b-task");
    expect(updated).toMatchObject({ state: "done", manuallyCompletedAt: expect.any(String) });
    expect((await second.chat(project)).tasks.find((t: any) => t.id === "b-task")).toEqual(updated);
    const saved = JSON.parse(readFileSync(join(dir, "b", "projects", project, "tasks.json"), "utf8"));
    expect(saved.find((t: any) => t.id === "b-task")).toMatchObject({ state: "done", kept: true, manuallyCompletedAt: expect.any(Number) });
    expect((await first.chat(project)).tasks.find((t: any) => t.id === "a-task")).toEqual(firstTask);
    expect(first.of("tasks.updated")).toHaveLength(0);
    expect(readFileSync(firstFile, "utf8")).toBe(firstSaved);
    expect(readFileSync(lockFile, "utf8")).toBe(lock);
    await second.kill();
    // A nonholder must not remove the live holder's lock on shutdown either.
    expect(readFileSync(lockFile, "utf8")).toBe(lock);
  });

  it("refuses manual closure when unreadable chat makes the bot genuinely read-only", async () => {
    const dir = tempDir("task-completion-readonly"); seed(dir);
    const chatFile = join(dir, "main", "chat.json");
    writeFileSync(chatFile, "{invalid json");
    const tasksFile = join(dir, "main", "tasks.json");
    const before = readFileSync(tasksFile, "utf8");
    const c = core(dir);
    const snapshot = await c.call({ type: "chat.snapshot", botId: MAIN });
    expect(snapshot.bots.find((b: any) => b.id === MAIN).problem).toMatch(/chat file cannot be read/);
    expect(snapshot.chat.tasks.find((t: any) => t.id === "task")).toMatchObject({ state: "pending" });
    await expect(complete(c)).rejects.toThrow(/conflict/);
    expect(c.of("tasks.updated")).toHaveLength(0);
    expect((await c.chat()).tasks.find((t: any) => t.id === "task")).toMatchObject({ state: "pending" });
    expect(readFileSync(tasksFile, "utf8")).toBe(before);
    expect(readFileSync(chatFile, "utf8")).toBe("{invalid json");
  });
});
