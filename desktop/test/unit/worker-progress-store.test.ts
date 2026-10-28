// Temporary synthetic stores only; child processes transpile source in memory, no app build.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BotStore } from "../../src/core/store/bot-store";
import { SubagentBook, readSubagent } from "../../src/core/subagents";
import { JobStore } from "../../src/core/durable/jobs";

const roots: string[] = [];
const stores: BotStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) { try { store.loadList("subagents.json"); } catch { /* corrupt-base fixture; load still releases cache */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "worker-progress-")); roots.push(root); const store = new BotStore(root); stores.push(store); return { root, store }; };
const worker = (id = "worker") => ({ id, status: "running", description: "Worker", prompt: "Keep prompt", startedAt: 1, background: false,
  execution: { run: 1, ownerSessionId: "owner", threadId: "thread", turnId: "turn" },
  steps: [] as { id: string; kind: string; title: string; done: boolean; failed: boolean }[],
  previousRuns: [{ prompt: "Earlier", status: "completed", startedAt: 0, result: "complete historical report", steps: [] }], unknownField: { keep: true } });
const step = (title: string) => ({ id: title, kind: "text", title, done: true, failed: false });

it("recovers every worker's progress and history, in the compatible checkpoint without modifying task/queue files", () => {
  const { root, store } = fixture(); const list = [worker("a"), worker("b")];
  store.saveList("subagents.json", list); store.saveList("tasks.json", [{ id: "task", subagentIDs: ["a", "b"] }]);
  const jobs = new JobStore(join(root, "jobs.json")); const job = jobs.create("request", "Task");
  const base = readFileSync(join(root, "subagents.json")); const tasks = readFileSync(join(root, "tasks.json")); const queue = readFileSync(join(root, "jobs.json"));
  list[0].steps.push(step("first")); store.saveWorkerProgress(list);
  list[1].steps.push(step("second")); store.saveWorkerProgress(list);
  expect(new BotStore(root).loadList("subagents.json")).toEqual(list);
  expect(readFileSync(join(root, "subagents.json"))).not.toEqual(base);
  expect(JSON.parse(readFileSync(join(root, "subagents.json"), "utf8"))).toEqual(list);
  expect(readFileSync(join(root, "tasks.json"))).toEqual(tasks);
  expect(readFileSync(join(root, "jobs.json"))).toEqual(queue);
  expect(jobs.create("request", "Task").id).toBe(job.id); expect(jobs.list()).toHaveLength(1);
  expect(statSync(join(root, "subagents.json")).mode & 0o777).toBe(0o600);
});

it.each(["completed", "failed", "stopped"])("a %s checkpoint retains concurrent progress, including for other running workers", status => {
  const { root, store } = fixture(); const list = [worker("a"), worker("b")];
  store.saveList("subagents.json", list); list[0].steps.push(step("old")); store.saveWorkerProgress(list);
  const stale = "{malformed stale overlay";
  writeFileSync(join(root, "subagents-progress.json"), stale);
  list[0].status = status; list[0].steps.push(step("final")); list[1].steps.push(step("other"));
  store.saveList("subagents.json", list);
  // Leftover sidecar bytes never participate in authoritative checkpoint recovery.
  expect(readFileSync(join(root, "subagents-progress.json"))).toEqual(Buffer.from(stale));
  expect(new BotStore(root).loadList("subagents.json")).toEqual(list);
  list[1].steps.push(step("new")); store.saveWorkerProgress(list);
  expect(new BotStore(root).loadList("subagents.json")).toEqual(list);
});

it.each(["{malformed", JSON.stringify({ version: 1, rows: null }), JSON.stringify({ version: 1, rows: [{ status: "running" }] })])("ignores corrupt/non-authoritative sidecar %s and preserves terminal history", sidecar => {
  const { root, store } = fixture(); const list = [worker()]; list[0].status = "completed";
  store.saveList("subagents.json", list);
  const path = join(root, "subagents-progress.json"); writeFileSync(path, sidecar);
  const recovered = new BotStore(root).loadList("subagents.json"); expect(recovered).toEqual(list);
  store.saveList("subagents.json", recovered);
  expect(JSON.parse(readFileSync(join(root, "subagents.json"), "utf8"))).toEqual(list);
  expect(readFileSync(path, "utf8")).toBe(sidecar);
});

it("reports a corrupt authoritative base without replacing it or trusting a sidecar", () => {
  const { root, store } = fixture(); const base = join(root, "subagents.json");
  writeFileSync(base, "{corrupt base"); writeFileSync(join(root, "subagents-progress.json"), "{corrupt sidecar");
  expect(() => store.loadList("subagents.json")).toThrow("not valid JSON");
  expect(readFileSync(base, "utf8")).toBe("{corrupt base");
});

it("invalidates cached history for explicit edits and preserves base-only copies used by legacy readers/importers", () => {
  const { root, store } = fixture(); const list = [worker()]; list[0].status = "completed";
  store.saveList("subagents.json", list);
  list[0].previousRuns[0].result = "edited complete report";
  store.saveList("subagents.json", list); store.saveWorkerProgress(list);
  const copied = fixture(); copyFileSync(join(root, "subagents.json"), join(copied.root, "subagents.json"));
  expect(new BotStore(copied.root).loadList("subagents.json")).toEqual(list);
  expect(existsSync(join(root, "subagents-progress.json"))).toBe(false);
});

it.each(["progress", "terminal", "interrupted-progress", "interrupted-terminal"])("survives SIGKILL at %s", boundary => {
  const terminal = boundary === "terminal";
  const { root } = fixture();
  const script = `
    const fs = require('node:fs'); const ts = require('typescript');
    require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true }
    }).outputText, file);
    const { BotStore } = require(${JSON.stringify(resolve("src/core/store/bot-store.ts"))});
    const store = new BotStore(${JSON.stringify(root)}); const list = ${JSON.stringify([worker()])};
    store.saveList('subagents.json', list);
    list[0].steps.push(${JSON.stringify(step("durable evidence"))}); list[0].outputTokenCounters = { run: 123 }; store.saveWorkerProgress(list);
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
  if (boundary === "progress") {
    // Exact released .8 BotStore source, not a hand-written approximation. Restart the
    // old writer after the crash, stopRunning/full-save, then reupgrade below.
    const downgrade = spawnSync(process.execPath, ["-e", `
      const fs = require('node:fs'); const ts = require('typescript');
      require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true }
      }).outputText, file);
      const file = ${JSON.stringify(resolve("src/core/store/bot-store.ts"))};
      const source = require('node:child_process').execFileSync('git', ['show', '30b8d78eef42da4677cf1111016ffbd9fb80e3b6:desktop/src/core/store/bot-store.ts'], { encoding: 'utf8' });
      const legacy = new (require('node:module').Module)(file, module); legacy.filename = file; legacy.paths = module.paths;
      legacy._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true } }).outputText, file);
      const { SubagentBook, readSubagent } = require(${JSON.stringify(resolve("src/core/subagents.ts"))});
      const store = new legacy.exports.BotStore(${JSON.stringify(root)});
      const book = new SubagentBook(store.loadList('subagents.json').map(readSubagent));
      require('node:assert/strict').equal(book.list[0].steps[0].title, 'durable evidence');
      require('node:assert/strict').equal(book.list[0].outputTokenCounters.run, 123);
      book.stopRunning(); store.saveList('subagents.json', book.list);
    `], { encoding: "utf8", timeout: 10_000 });
    expect(downgrade.stderr).toBe(""); expect(downgrade.status).toBe(0);
  }
  const jobs = new JobStore(join(root, "jobs.json"));
  expect(jobs.recover()).toHaveLength(terminal ? 0 : 1);
  expect(jobs.list()[0].state).toBe(terminal ? "delivered" : "delivery_uncertain");
  expect(jobs.claimNext()).toBeNull();
  expect(jobs.create("request", "Task").id).toBe(jobs.list()[0].id); expect(jobs.list()).toHaveLength(1);
  const store = new BotStore(root); const recovered = new SubagentBook(store.loadList("subagents.json").map(value => readSubagent(value)!));
  expect(recovered.list[0].steps).toEqual([step("durable evidence")]);
  expect(recovered.list[0].previousRuns).toEqual(worker().previousRuns);
  expect(recovered.list[0].outputTokenCounters).toEqual({ run: 123 });
  expect(recovered.stopRunning()).toBe(!terminal && boundary !== "progress");
  store.saveList("subagents.json", recovered.list);
  expect(new BotStore(root).loadList("subagents.json")[0]).toMatchObject({ status: terminal ? "completed" : "stopped", ...(terminal ? { result: "full final report" } : {}) });
});

it("bounds aggregate cache across stores, evicts older stores, and writes exact history after eviction", () => {
  expect(BotStore.workerHistoryCacheUsage().characters).toBe(0);
  const blob = "h".repeat(24 * 1024 * 1024);
  const active = Array.from({ length: 3 }, (_, i) => {
    const f = fixture(); const history = worker(`history-${i}`); history.status = "completed";
    history.previousRuns[0].result = blob;
    return { ...f, list: [worker(`running-${i}`), history] };
  });
  const perStore = JSON.stringify(active[0].list[1]).length;
  for (const f of active) {
    f.store.saveList("subagents.json", f.list);
    expect(BotStore.workerHistoryCacheUsage().characters).toBeLessThanOrEqual(BotStore.workerHistoryCacheUsage().limitCharacters);
  }
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 2, items: 2, characters: 2 * perStore });
  // First store has been evicted. Its next progress write must reconstruct all its history.
  active[0].list[0].steps.push(step("after eviction")); active[0].store.saveWorkerProgress(active[0].list);
  expect(readFileSync(join(active[0].root, "subagents.json"), "utf8")).toBe(JSON.stringify(active[0].list));
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 2, items: 2, characters: 2 * perStore });
  // Reload explicitly releases exactly this store's reservation, not other live stores.
  active[0].store.loadList("subagents.json");
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 1, items: 1, characters: perStore });
});

it("releases terminal and idle stores, including failed terminal writes, and accounts replacement/duplicates", () => {
  const f = fixture(); const history = worker("history"); history.status = "completed";
  const list = [worker(), history, history];
  f.store.saveList("subagents.json", list);
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 1, items: 1, characters: JSON.stringify(history).length });
  history.previousRuns[0].result = "replacement report".repeat(100);
  f.store.saveList("subagents.json", list);
  expect(BotStore.workerHistoryCacheUsage().characters).toBe(JSON.stringify(history).length);
  list[0].status = "completed"; f.store.saveList("subagents.json", list);
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 0, items: 0, characters: 0 });
  f.store.saveWorkerProgress(list);
  expect(BotStore.workerHistoryCacheUsage().characters).toBe(0);
  // The six retained idle stores in the review must not acquire a cache at all.
  for (let i = 0; i < 6; i++) {
    const idle = fixture(); idle.store.saveList("subagents.json", Array.from({ length: 12 }, (_, n) => ({ ...history, id: `idle-${n}`, result: "x".repeat(262_144) })));
  }
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 0, items: 0, characters: 0 });
  list[0].status = "running"; f.store.saveList("subagents.json", list);
  expect(BotStore.workerHistoryCacheUsage().stores).toBe(1);
  list[0].status = "stopped";
  // Serialize failure is before disk commit, but idle memory must still be released.
  const stringify = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new Error("serialization failed"); });
  expect(() => f.store.saveList("subagents.json", list)).toThrow("serialization failed");
  stringify.mockRestore();
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 0, items: 0, characters: 0 });
  f.store.saveList("subagents.json", list);
  expect(readFileSync(join(f.root, "subagents.json"), "utf8")).toBe(JSON.stringify(list));
});

it("bounds registry metadata for many tiny active stores and clearing an evicted store is harmless", () => {
  const count = BotStore.workerHistoryCacheUsage().limitStores;
  const active = Array.from({ length: count + 1 }, (_, i) => {
    const f = fixture(); const history = worker(`old-${i}`); history.status = "completed";
    f.store.saveList("subagents.json", [worker(`active-${i}`), history]); return f;
  });
  const before = BotStore.workerHistoryCacheUsage(); expect(before.stores).toBe(count);
  active[0].store.loadList("subagents.json"); expect(BotStore.workerHistoryCacheUsage()).toEqual(before);
  active.at(-1)!.store.saveList("subagents.json", []);
  expect(BotStore.workerHistoryCacheUsage().stores).toBe(count - 1);
});

it("does not keep abandoned stores alive even when their source records remain live", () => {
  const { root } = fixture();
  const script = `
    const fs = require('node:fs'); const ts = require('typescript'); const assert = require('node:assert/strict');
    require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true }
    }).outputText, file);
    const { BotStore } = require(${JSON.stringify(resolve("src/core/store/bot-store.ts"))});
    (async () => {
      let store = new BotStore(${JSON.stringify(root)});
      const records = ${JSON.stringify([worker("active"), { ...worker("history"), status: "completed" }])};
      store.saveList('subagents.json', records);
      assert.equal(BotStore.workerHistoryCacheUsage().stores, 1);
      const reference = new WeakRef(store); store = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setImmediate(resolve)); global.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (!reference.deref()) break;
      }
      assert.equal(reference.deref(), undefined, 'global cache must not retain its store');
      assert.equal(BotStore.workerHistoryCacheUsage().characters, 0);
      assert.equal(BotStore.workerHistoryCacheUsage().stores, 0);
      assert.equal(records[1].previousRuns[0].result, 'complete historical report');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "-e", script], { encoding: "utf8", timeout: 10_000 });
  expect(child.stderr).toBe(""); expect(child.status).toBe(0);
});

it("bounds row metadata as well as strings and stores without dropping persisted rows", () => {
  const f = fixture(); const count = BotStore.workerHistoryCacheUsage().limitItems;
  const list = [worker(), ...Array.from({ length: count + 1 }, (_, i) => ({ ...worker(`history-${i}`), status: "completed" }))];
  f.store.saveList("subagents.json", list);
  expect(BotStore.workerHistoryCacheUsage().items).toBe(count);
  const other = fixture(); other.store.saveList("subagents.json", [worker(), { ...worker("other-history"), status: "completed" }]);
  expect(BotStore.workerHistoryCacheUsage()).toMatchObject({ stores: 1, items: 1 });
  list[0].steps.push(step("progress with uncached history")); f.store.saveWorkerProgress(list);
  expect(BotStore.workerHistoryCacheUsage().items).toBe(count);
  expect(readFileSync(join(f.root, "subagents.json"), "utf8")).toBe(JSON.stringify(list));
});
