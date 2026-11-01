import {mkdirSync,writeFileSync} from 'node:fs';
import {projectFolderName} from '../../src/core/claude-files';
// Deterministic transport lifetime races; no process spawning, timers, UI or credentials.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bot } from "../../src/core/bot";
import { maintainerProfile } from "../../src/core/maintainer";
import { botPrompts } from "../../src/core/prompts";
import { ProcessLedger } from "../../src/core/process/ledger";
import { CodexHead, CodexThreads } from "../../src/core/agent/codex";
import type { ProcessTreeAdapter, TerminateResult } from "../../src/core/process/tree";
import { tempDir } from "../helpers";

function transport() {
  let rpc = 100;
  const processes: { child: ChildProcessWithoutNullStreams; writes: any[]; args: string[]; release(): void; survive(): void; terminateCalls: number }[] = [];
  const adapter: ProcessTreeAdapter = { platform: "test", verified: true, spawn(_command, args) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
    const pid = 10_000 + processes.length;
    const writes: any[] = [];
    child.stdin.on("data", chunk => { for (const line of String(chunk).trim().split("\n")) writes.push(JSON.parse(line)); });
    let resolve!: (result: TerminateResult) => void;
    const ended = new Promise<TerminateResult>(r => { resolve = r; });
    const record = { child, writes, args, terminateCalls: 0, release() { child.emit("close", 0, null); resolve({ killed: [pid], forced: false }); },
      /** The terminate answers, but its tree is still alive (not confirmed gone). */
      survive() { resolve({ killed: [pid], forced: true, alive: true }); } };
    processes.push(record);
    return { pid, child, terminate() { record.terminateCalls++; return ended; } };
  } };
  const items: any[] = [];
  const root = tempDir("editor-transport");
  const head = new CodexHead({ command: "/test/codex", cwd: root, sessionId: "owner", resume: false, instructions: "coordinator", workerInstructions: "worker",
    threads: new CodexThreads(join(root, "threads")), componentEditor: { launch: { command: "/test/claude", cwd: root, env:{CLAUDE_CONFIG_DIR:join(root,"claude-config")}, sessionId: "unused", resume: false, model: "haiku", allowedTools: ["Read"], tools: ["Read"] } } },
    { onItem: item => items.push(item), onExit() {} }, adapter);
  head.start();
  const coordinator = processes[0];
  const receive = (value: unknown) => (coordinator.child.stdout as PassThrough).write(JSON.stringify(value) + "\n");
  const answer = (method: string, result: unknown) => receive({ id: coordinator.writes.findLast(w => w.method === method).id, result });
  answer("initialize", {});
  answer("thread/start", { thread: { id: "coordinator" } });
  head.send("authorized edit");
  answer("turn/start", { turn: { id: "t1" } });
  const call = (tool: string, args: unknown) => receive({ id: ++rpc, method: "item/tool/call", params: { threadId: "coordinator", turnId: "t1", tool, arguments: args } });
  call("app_handoff", { role: "component-editor", instructions: "initial edit" });
  const task = head.session.workerRecords[0].id;
  return { head, task, processes, items, call, adapter, root };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("Claude editor transport ownership", () => {
  it("waits for cancellation cleanup before resuming and retains corrections sent while starting", async () => {
    const { head, task, processes, call } = transport();
    const first = processes[1];
    head.cancelWorkers(new Set([task]));
    expect(first.terminateCalls).toBe(1);
    call("app_send_message", { task_id: task, message: "resume after cancel" });
    call("app_send_message", { task_id: task, message: "startup correction" });
    head.allow(["Bash(echo checked)"]); // A user-approved rule also reaches a pending child.
    expect(processes).toHaveLength(2); // Old transcript is still open.
    first.release();
    await tick();
    const resumed = processes[2];
    expect(resumed.args).toContain("--resume");
    expect(JSON.parse(resumed.args[resumed.args.indexOf("--settings") + 1])).toEqual({ permissions: { allow: ["Bash(echo checked)"] } });
    expect(resumed.writes.filter(w => w.type === "user").map(w => w.message.content)).toEqual(["resume after cancel", "startup correction"]);
    // Old process callbacks cannot complete or alter the replacement run.
    (first.child.stdout as PassThrough).write(JSON.stringify({ type: "result", subtype: "success", result: "late" }) + "\n");
    expect(head.session.runningWorkers).toEqual([task]);
    const ending = head.terminate();
    for (const process of processes) process.release();
    await ending;
  });

  it("round 4 #2 an old editor whose tree is not confirmed gone keeps its transcript closed: no relaunch, the run fails instead", async () => {
    const { head, task, processes, call, items } = transport();
    head.cancelWorkers(new Set([task]));
    call("app_send_message", { task_id: task, message: "resume after cancel" });
    processes[1]!.survive();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(processes).toHaveLength(2);
    expect(items).toContainEqual(expect.objectContaining({ kind: "subagentEnded", id: task, status: "failed", summary: expect.stringContaining("prior editor") }));
    const ending = head.terminate();
    for (const process of processes) process.release();
    await ending;
  });

  it("cancelling a queued replacement revokes launch without dropping the old transcript cleanup barrier", async () => {
    const { head, task, processes, call } = transport();
    head.cancelWorkers(new Set([task]));
    call("app_send_message", { task_id: task, message: "queued resume" });
    head.cancelWorkers(new Set([task]));
    call("app_send_message", { task_id: task, message: "authorized third run" });
    await tick();
    expect(processes).toHaveLength(2);
    processes[1].release();
    await tick();
    expect(processes).toHaveLength(3);
    expect(processes[2].writes.filter(w => w.type === "user").map(w => w.message.content)).toEqual(["authorized third run"]);
    expect(head.session.workerRecords[0]).toMatchObject({ run: 3, role: "component-editor" });
    const ending = head.terminate();
    for (const process of processes) process.release();
    await ending;
  });

  it.each([0, 2])("forwards an editor classifier rule only after the user's existing decision (choice %s)", async choice => {
    const { head, task, processes, items } = transport();
    const root = tempDir("editor-approved-rule");
    const profile = maintainerProfile(root, "maintain");
    const bot = new Bot({ profile, engine: "codex", deferStartup: true, welcome: false,
      approvalTimeoutMs: 60_000, idleMs: 60_000, interruptGraceMs: 10,
      headConfig() { throw new Error("No other CLI may launch"); }, prompts: () => botPrompts({ profile, engine: "codex" }),
      ledger: new ProcessLedger(join(root, "ledger.json")), emit() {}, log() {} });
    (bot as any).head = head;
    vi.spyOn(bot as any, "tellHead").mockImplementation(() => {});
    for (const item of items.filter(item => item.kind.startsWith("subagent"))) (bot as any).onItem(head, item);
    const feed = (item: Parameters<typeof head.session.componentEditorItem>[2]) => {
      for (const output of head.session.componentEditorItem(task, 1, item)) if (output.kind === "item") (bot as any).onItem(head, output.item);
    };
    try {
      feed({ kind: "toolUse", id: "call", tool: "Bash", title: "Run echo checked", detail: "echo checked", input: { command: "echo checked" }, parent: null });
      feed({ kind: "permissionDenied", toolUseId: "call", tool: "Bash", reason: "classifier blocked", confirmed: true });
      const card = (bot as any).records.findLast((record: any) => record.permissionTool);
      expect(card.choices.map((option: any) => option.action)).toEqual(["allowOnce", "alwaysAllow", "deny"]);
      expect(bot.choose(card.id, choice)).toEqual({ accepted: true });
      const applied = processes[1].writes.filter(w => w.request?.subtype === "apply_flag_settings");
      if (choice === 0) {
        expect(applied.map(w => w.request.settings)).toEqual([{ permissions: { allow: ["Bash(echo checked)"] } }]);
        expect(head.config.componentEditor?.launch?.allowRules).toEqual(["Bash(echo checked)"]);
      } else {
        expect(applied).toEqual([]);
        expect(head.config.componentEditor?.launch?.allowRules).toBeUndefined();
      }
      expect((bot as any).alwaysAllowed).toEqual([]); // Allow once never persists an always rule.
    } finally {
      const ending = head.terminate();
      for (const process of processes) process.release();
      (bot as any).head = null;
      await bot.shutdown({ tidy: false });
      await ending;
    }
  });

});

it.each(['continue','completed','uncertain'])('restart transport reconciles the original editor transcript before dispatch (%s)',async mode=>{
 const {head,task,processes,adapter,root}=transport();const first=processes[1];const session=head.session.workerRecords[0].thread!;
 const childItem=(v:unknown)=>(first.child.stdout as PassThrough).write(JSON.stringify(v)+'\n');
 childItem({type:'system',subtype:'init',session_id:session});
 childItem({type:'assistant',message:{content:[{type:'tool_use',id:'read-1',name:'Read',input:{}}]}});
 childItem({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'evidence'}]}});
 const saved=head.restartWorkers;expect(saved[0].restartSafe).toBe(true);
 const folder=join(root,'claude-config','projects',projectFolderName(root));mkdirSync(folder,{recursive:true});
 const rows:any[]=[{type:'user',message:{content:'initial edit'}},{type:'assistant',message:{content:[{type:'tool_use',id:'read-1'}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'evidence'}]}}];
 if(mode==='completed')rows.push({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Already verified'}]}});
 if(mode==='uncertain')rows.push({type:'assistant',message:{content:[{type:'tool_use',id:'late-write'}]}});
 writeFileSync(join(folder,session+'.jsonl'),rows.map(r=>JSON.stringify({...r,sessionId:session})).join('\n'));
 const ended=head.terminate();for(const p of processes)p.release();await ended;
 const events:any[]=[];const restored=new CodexHead({...head.config,resume:true,restartWorkers:saved},{onItem:i=>events.push(i),onExit(){}},adapter);restored.start();
 const coordinator=processes[2];const answer=(method:string,result:unknown)=>(coordinator.child.stdout as PassThrough).write(JSON.stringify({id:coordinator.writes.findLast(w=>w.method===method).id,result})+'\n');
 answer('initialize',{});answer('thread/resume',{thread:{id:'coordinator'}});answer('thread/inject_items',{});
 if(mode==='continue'){
  expect(processes).toHaveLength(4);const child=processes[3];expect(child.args[child.args.indexOf('--resume')+1]).toBe(session);
  expect(child.writes.find(w=>w.type==='user').message.content).toContain('Original assignment (unchanged scope):\ninitial edit');
  expect(restored.session.workerRecords[0]).toMatchObject({id:task,run:2,thread:session,role:'component-editor'}); // the continuation is its next run
 }else{
  expect(processes).toHaveLength(3);expect(events).toContainEqual(expect.objectContaining({kind:'subagentEnded',id:task,status:mode==='completed'?'completed':'interrupted'}));
 }
 const stopped=restored.terminate();for(const p of processes)p.release();await stopped;
});
