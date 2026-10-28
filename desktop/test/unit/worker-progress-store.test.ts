// Temporary synthetic stores only; child processes transpile source in memory, no app build.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BotStore } from "../../src/core/store/bot-store";
import { SubagentBook, readSubagent } from "../../src/core/subagents";
import { JobStore } from "../../src/core/durable/jobs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "worker-progress-")); roots.push(root); return { root, store: new BotStore(root) }; };
const worker = (id = "worker") => ({ id, status: "running", description: "Worker", prompt: "Keep prompt", startedAt: 1, background: false,
  execution: { run: 1, ownerSessionId: "owner", threadId: "thread", turnId: "turn" },
  steps: [] as { id: string; kind: string; title: string; done: boolean; failed: boolean }[],
  previousRuns: [{ prompt: "Earlier", status: "completed", startedAt: 0, result: "complete historical report", steps: [] }], unknownField: { keep: true } });
const step = (title: string) => ({ id: title, kind: "text", title, done: true, failed: false });

it("recovers every worker's progress and history, without modifying the checkpoint or task/queue files", () => {
  const { root, store } = fixture(); const list = [worker("a"), worker("b")];
  store.saveList("subagents.json", list); store.saveList("tasks.json", [{ id: "task", subagentIDs: ["a", "b"] }]);
  const jobs = new JobStore(join(root, "jobs.json")); const job = jobs.create("request", "Task");
  const base = readFileSync(join(root, "subagents.json")); const tasks = readFileSync(join(root, "tasks.json")); const queue = readFileSync(join(root, "jobs.json"));
  list[0].steps.push(step("first")); store.saveWorkerProgress(list);
  list[1].steps.push(step("second")); store.saveWorkerProgress(list);
  expect(new BotStore(root).loadList("subagents.json")).toEqual(list);
  expect(readFileSync(join(root, "subagents.json"))).toEqual(base);
  expect(readFileSync(join(root, "tasks.json"))).toEqual(tasks);
  expect(readFileSync(join(root, "jobs.json"))).toEqual(queue);
  expect(jobs.create("request", "Task").id).toBe(job.id); expect(jobs.list()).toHaveLength(1);
  expect(statSync(join(root, "subagents-progress.json")).mode & 0o777).toBe(0o600);
});

it.each(["completed", "failed", "stopped"])("a %s checkpoint invalidates old progress, including for other running workers", status => {
  const { root, store } = fixture(); const list = [worker("a"), worker("b")];
  store.saveList("subagents.json", list); list[0].steps.push(step("old")); store.saveWorkerProgress(list);
  const stale = readFileSync(join(root, "subagents-progress.json"));
  list[0].status = status; list[0].steps.push(step("final")); list[1].steps.push(step("other"));
  store.saveList("subagents.json", list);
  // Models death between checkpoint replacement and any possible overlay cleanup.
  expect(readFileSync(join(root, "subagents-progress.json"))).toEqual(stale);
  expect(new BotStore(root).loadList("subagents.json")).toEqual(list);
  list[1].steps.push(step("new")); store.saveWorkerProgress(list);
  expect(new BotStore(root).loadList("subagents.json")).toEqual(list);
});

it("never overlays status, execution, ownership or history from the progress document", () => {
  const { root, store } = fixture(); const list = [worker()]; store.saveList("subagents.json", list); store.saveWorkerProgress(list);
  const path = join(root, "subagents-progress.json"); const progress = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(progress.rows[0], { status: "completed", execution: {}, previousRuns: [], owner: "other" });
  writeFileSync(path, JSON.stringify(progress));
  expect(store.loadList("subagents.json")).toEqual(list);
});

it.each(["progress", "terminal", "interrupted-progress", "interrupted-terminal"])("survives SIGKILL at %s", boundary => {
  const terminal = boundary === "terminal";
  const { root } = fixture();
  const script = `
    const fs = require('node:fs'); const ts = require('typescript');
    require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
    }).outputText, file);
    const { BotStore } = require(${JSON.stringify(resolve("src/core/store/bot-store.ts"))});
    const store = new BotStore(${JSON.stringify(root)}); const list = ${JSON.stringify([worker()])};
    store.saveList('subagents.json', list);
    list[0].steps.push(${JSON.stringify(step("durable evidence"))}); store.saveWorkerProgress(list);
    const { JobStore } = require(${JSON.stringify(resolve("src/core/durable/jobs.ts"))});
    const jobs = new JobStore(${JSON.stringify(join(root, "jobs.json"))});
    jobs.create('request', 'Task'); const claimed = jobs.claimNext();
    if (${terminal}) jobs.markDelivered(claimed.id);
    if (${boundary.startsWith("interrupted")}) {
      // Temp contents are written and fsynced; die before the atomic rename.
      fs.renameSync = () => process.kill(process.pid, 'SIGKILL');
      if (${boundary === "interrupted-progress"}) { list[0].steps.push(${JSON.stringify(step("uncommitted"))}); store.saveWorkerProgress(list); }
      else { list[0].status = 'completed'; store.saveList('subagents.json', list); }
    }
    if (${terminal}) { list[0].status = 'completed'; list[0].result = 'full final report'; store.saveList('subagents.json', list); }
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
  expect(child.stderr).toBe(""); expect(child.signal).toBe("SIGKILL");
  const jobs = new JobStore(join(root, "jobs.json"));
  expect(jobs.recover()).toHaveLength(terminal ? 0 : 1);
  expect(jobs.list()[0].state).toBe(terminal ? "delivered" : "delivery_uncertain");
  expect(jobs.claimNext()).toBeNull();
  expect(jobs.create("request", "Task").id).toBe(jobs.list()[0].id); expect(jobs.list()).toHaveLength(1);
  const store = new BotStore(root); const recovered = new SubagentBook(store.loadList("subagents.json").map(value => readSubagent(value)!));
  expect(recovered.list[0].steps).toEqual([step("durable evidence")]);
  expect(recovered.list[0].previousRuns).toEqual(worker().previousRuns);
  expect(recovered.stopRunning()).toBe(!terminal);
  store.saveList("subagents.json", recovered.list);
  expect(new BotStore(root).loadList("subagents.json")[0]).toMatchObject({ status: terminal ? "completed" : "stopped", ...(terminal ? { result: "full final report" } : {}) });
});
