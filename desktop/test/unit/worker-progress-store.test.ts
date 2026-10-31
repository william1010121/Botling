// Real journal and checkpoint files: no app/profile, live CLI, or mocked worker.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { tempDir } from "../helpers";
import { join } from "node:path";
import { BotStore } from "../../src/core/store/bot-store";
import { decodeHistoryCheckpoint, readHistory } from "../../src/core/durable/history-journal";

const fixtures: { root: string; store: BotStore }[] = [];
afterEach(async () => {
  for (const { root, store } of fixtures.splice(0)) {
    await store.closeWorkerHistory();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(seed: unknown[] = []) {
  const root = tempDir("worker-history");
  const file = join(root, "subagents.json"); writeFileSync(file, JSON.stringify(seed));
  const store = new BotStore(root); store.loadList("subagents.json");
  fixtures.push({ root, store });
  return { root, store, file, journal: file + ".journal", disk: () => readHistory(file) };
}
function worker(id = "worker") {
  return { id, status: "running", prompt: "Keep", steps: [] as any[], previousRuns: [{ status: "completed", result: "keep history", steps: [] }], unknown: { retained: true } };
}
it("durably commits before returning; a fresh reader recovers every record before checkpoint, then the checkpoint catches up", async () => {
  const f = fixture(), list = [worker("a"), worker("b")];
  writeFileSync(join(f.root, "tasks.json"), '[{"id":"unrelated"}]');
  f.store.saveList("subagents.json", list);
  list[0].steps.push({ id: "step", done: false, detail: "first" }); f.store.saveWorkerProgress(list);
  list[0].steps[0].done = true; list[0].steps[0].detail = "final";
  list[1].status = "completed"; f.store.saveList("subagents.json", list);
  expect(f.disk()).toEqual(list);
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual([]);
  await f.store.flushWorkerHistory();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(list);
  expect(readdirSync(f.journal)).toEqual([]);
  if (process.platform !== "win32") expect(statSync(f.file).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
  expect(readFileSync(join(f.root, "tasks.json"), "utf8")).toBe('[{"id":"unrelated"}]');
});
it("orders commits from competing stores and includes writes arriving during checkpoint in the next flush", async () => {
  const f = fixture(), a = worker("a"), b = worker("b"), list = [a,b];
  f.store.saveList("subagents.json", list);
  const other = new BotStore(f.root); other.loadList("subagents.json");
  const checkpoint = f.store.flushWorkerHistory();
  a.steps.push({ id: "first", detail: "one" }); other.saveWorkerProgress(list);
  a.status = "completed"; b.steps.push({ id: "second", detail: "two" }); f.store.saveList("subagents.json", list);
  await checkpoint; await other.flushWorkerHistory();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(list);
  expect(f.disk()).toEqual(list);
});
it("failed journal commits throw and do not advance accepted state; retry preserves pending and later progress", async () => {
  const f = fixture(), list = [worker()]; f.store.saveList("subagents.json", list); await f.store.flushWorkerHistory();
  rmSync(f.journal, {recursive:true}); writeFileSync(f.journal, "not a directory");
  list[0].status = "completed";
  expect(() => f.store.saveList("subagents.json", list)).toThrow();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows[0].status).toBe("running");
  rmSync(f.journal); mkdirSync(f.journal);
  list[0].steps.push({id:"late",detail:"retained"}); f.store.saveWorkerProgress(list);
  await f.store.flushWorkerHistory(); expect(f.disk()).toEqual(list);
});
it("checkpoint failure does not discard an accepted journal; explicit flush rejects and retry recovers", async () => {
  const f = fixture(), list=[worker()]; f.store.saveList("subagents.json",list);
  renameSync(f.file,f.file+'.saved'); mkdirSync(f.file);
  await expect(f.store.flushWorkerHistory()).rejects.toThrow();
  expect(readdirSync(f.journal).filter(n=>n.endsWith('.json'))).toHaveLength(1);
  rmSync(f.file,{recursive:true}); renameSync(f.file+'.saved',f.file);
  await f.store.flushWorkerHistory(); expect(f.disk()).toEqual(list);
});
it("crash after checkpoint rename but before partial journal pruning replays idempotently", async () => {
  const f=fixture(), a=worker('a'), b=worker('b'), list=[a,b];
  f.store.saveList('subagents.json',list);
  a.steps.push({id:'x',text:'old'},{id:'y',text:'keep'}); f.store.saveWorkerProgress(list);
  a.steps[1].text='new'; a.steps.splice(0,1); f.store.saveWorkerProgress(list);
  a.previousRuns.push({status:'completed',result:'next',steps:[]}); list.reverse(); f.store.saveList('subagents.json',list);
  const saved=readdirSync(f.journal).sort().map(name=>({name,text:readFileSync(join(f.journal,name))}));
  await f.store.flushWorkerHistory();
  // A committed checkpoint plus an unpruned suffix is an allowed crash image.
  for(const item of saved.slice(1))writeFileSync(join(f.journal,item.name),item.text);
  expect(readHistory(f.file)).toEqual(list);
  for(const item of saved.slice(1))rmSync(join(f.journal,item.name));
});
it("retains unknown fields and run history, removes fields/rows, and safely handles JSON property names", async () => {
  const a=worker('a') as any, b=worker('b'); a.extra=JSON.parse('{"__proto__":{"safe":1}}');
  const f=fixture([a,b]); a.extra.__proto__.safe=2; delete a.prompt; a.steps.push({id:'x'});
  f.store.commitWorkerHistory([a],new Set(['a'])); expect(f.disk()).toEqual([a]);
  await f.store.flushWorkerHistory(); expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual([a]);
  expect(({} as any).safe).toBeUndefined();
});
it("corrupt authoritative files fail closed rather than overwriting history", () => {
  const f=fixture(); writeFileSync(f.file,'{broken');
  expect(()=>new BotStore(f.root).loadList('subagents.json')).toThrow();
  expect(readFileSync(f.file,'utf8')).toBe('{broken');
  writeFileSync(f.file,'[]');
  mkdirSync(f.journal); writeFileSync(join(f.journal,'0000000000000001.json'),'{broken');
  expect(()=>new BotStore(f.root).loadList('subagents.json')).toThrow();
  rmSync(join(f.journal,'0000000000000001.json'));
});

it("the production CJS/node22 bundle runs its self-contained checkpoint worker and recovers on reopen", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const { desktop } = await import("../helpers");
  const bundled = await build({ entryPoints:[join(desktop,"src/core/store/bot-store.ts")], bundle:true, platform:"node", format:"cjs", target:"node22", write:false });
  const module = { exports:{} as any };
  new Function("require","module","exports",bundled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const f=fixture(), store=new module.exports.BotStore(f.root), list=[worker()];
  store.loadList("subagents.json"); store.saveList("subagents.json",list);
  await store.closeWorkerHistory();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(list);
  const reopened=new module.exports.BotStore(f.root); expect(reopened.loadList("subagents.json")).toEqual(list);
  list[0].status="completed"; reopened.saveList("subagents.json",list); await reopened.closeWorkerHistory();
  expect(readHistory(f.file)).toEqual(list);
});

it("a new run retains prior reports and steps without replaying append operations",async()=>{
  const original=worker();original.steps.push({id:"old",output:"old output"});
  const f=fixture([original]);const row=JSON.parse(JSON.stringify(original));
  row.previousRuns.push({status:"completed",result:"final",steps:row.steps});row.steps=[];
  row.status="running";row.execution={run:2,threadId:"same-thread",turnId:"new-turn"};
  f.store.commitWorkerHistory([row],new Set([row.id]));
  row.steps.push({id:"new",output:"new output"});f.store.saveWorkerProgress([row]);
  expect(f.disk()).toEqual([row]);await f.store.flushWorkerHistory();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual([row]);
});

it("read-only recovery does not start a checkpoint or mutate a crash journal",async()=>{
  const root=tempDir("history-read-only"),file=join(root,"subagents.json"),row=worker();
  writeFileSync(file,"[]");mkdirSync(file+".journal");
  const transaction=JSON.stringify({order:[row.id],changes:[{id:row.id,patches:[{path:[],value:row}]}]});
  const entry=join(file+".journal","0000000000000001.json");writeFileSync(entry,transaction);
  const store=new BotStore(root);fixtures.push({root,store});
  expect(store.loadList("subagents.json")).toEqual([row]);
  await new Promise(resolve=>setTimeout(resolve,550));
  expect(readFileSync(file,"utf8")).toBe("[]");expect(readFileSync(entry,"utf8")).toBe(transaction);
});
