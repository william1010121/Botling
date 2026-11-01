import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maintainerEditorBinding, type ComponentEditorAction, type ComponentEditorRoute } from "../../src/core/agent/component-editor";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { headArguments, type HeadConfig } from "../../src/core/agent/head";
import { maintainerProfile } from "../../src/core/maintainer";
import { NO_REPORT } from "../../src/core/worker-core";
import { tempDir } from "../helpers";

function binding() {
  const root = tempDir("editor-binding");
  const owner = maintainerProfile(root, "maintain");
  const file = join(owner.folder, "ccb-core/claude/agents/component-editor.md");
  mkdirSync(join(file, ".."), { recursive: true });
  const definition = (model = "haiku", tools = "Read, Write, Edit, Bash") => `---\nname: component-editor\nmodel: ${model}\ntools: ${tools}\n---\nExisting editor instructions.\n`;
  writeFileSync(file, definition());
  const session = { sessionId: "parent", resume: true, systemPrompt: "coordinator" };
  const parent: HeadConfig = { command: "claude", cwd: owner.folder, sessionId: "parent", resume: true,
    model: "opus", allowedTools: ["Read", "Agent", "Bash"], addDirs: ["/already/approved"],
    autoMode: false, allowRules: ["Bash(echo ok)"], pluginDirs: ["/must/not/inherit/plugins"], effort: "high" };
  const create = vi.fn(() => parent);
  return { root, owner, file, definition, session, parent, create, bind: maintainerEditorBinding(owner, root, create) };
}

class Out {
  constructor(readonly all: CodexOutput[]) {}
  get writes(): any[] { return this.all.filter(o => o.kind === "write").map(o => o.value); }
  get items(): any[] { return this.all.filter(o => o.kind === "item").map(o => o.item); }
  get actions(): ComponentEditorAction[] { return this.all.filter(o => o.kind === "componentEditor").map(o => o.action); }
  get receipt(): any { return JSON.parse(this.writes.find(w => w.result?.contentItems)?.result.contentItems[0].text); }
}
let rpc = 100;
const call = (session: CodexSession, tool: string, args: unknown, threadId = "coordinator") => new Out(session.receive(JSON.stringify({ id: ++rpc, method: "item/tool/call", params: { tool, arguments: args, threadId, turnId: "t1" } })));
const notify = (session: CodexSession, method: string, params: unknown) => new Out(session.receive(JSON.stringify({ method, params })));
function ready(route?: ComponentEditorRoute | null, restoredWorkers: CodexConfig["restoredWorkers"] = []) {
  const session = new CodexSession({ cwd: "/library", instructions: "maintain", workerInstructions: "generic worker", model: null,
    workerModel: null, effort: null, resumeThread: null, restoredWorkers, componentEditor: route, ownerSession: "owner" });
  session.start();
  session.receive(JSON.stringify({ id: 1, result: {} }));
  session.receive(JSON.stringify({ id: 2, result: { thread: { id: "coordinator" } } }));
  session.send("authorized task");
  session.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
  return session;
}
function setup() {
  const b = binding();
  const route = b.bind(b.owner, b.session)!;
  const session = ready(route);
  const out = call(session, "app_handoff", { role: "component-editor", instructions: "authorized edit", name: "Editor" });
  const action = out.actions[0];
  if (action?.kind !== "start") throw new Error("Editor did not start");
  return { ...b, route, session, out, action, task: out.receipt.task_id as string };
}
const done = { kind: "result", ok: true, text: "Changed and checked.", error: "", subtype: "success" } as const;

describe("app-created Maintainer editor binding", () => {
  it("accepts the Core-owned identity and keeps the definition's configured model/tools and existing permissions", () => {
    const b = binding();
    const route = b.bind(b.owner, b.session)!;
    expect(route.launch).toMatchObject({ monitorWorker: true, model: "haiku", tools: ["Read", "Write", "Edit", "Bash"], systemPrompt: "Existing editor instructions.",
      addDirs: b.parent.addDirs, autoMode: false, allowRules: b.parent.allowRules, effort: "high", resume: false });
    expect(route.launch?.pluginDirs).toBeUndefined();
    const args = headArguments(route.launch!);
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read,Write,Edit,Bash", "--model", "haiku", "--permission-mode", "acceptEdits"]));
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion,Agent,Task,SendMessage");
    expect(headArguments(b.parent)).not.toContain("--tools");
    b.parent.harmless = true;
    b.parent.harmlessTools = ["Read", "WebFetch", "Agent"];
    const harmless = headArguments(b.bind(b.owner, b.session)!.launch!);
    expect(harmless[harmless.indexOf("--tools") + 1]).toBe("Read");
  });

  it.each([false, true])("propagates Claude bypass=%s through the app-managed editor without widening tools", (bypassPermissions) => {
    const b = binding();
    b.parent.bypassPermissions = bypassPermissions;
    const route = b.bind(b.owner, b.session)!;
    const session = ready(route);
    const action = call(session, "app_handoff", { role: "component-editor", instructions: "Edit" }).actions[0];
    expect(action?.kind).toBe("start");
    if (action?.kind !== "start") throw new Error("Missing editor");
    const args = headArguments(action.config);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(bypassPermissions ? "bypassPermissions" : "acceptEdits");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Write,Edit,Bash");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Agent,Task,SendMessage");
  });

  it("passes Claude low/medium policy to a component worker even under a Codex coordinator", () => {
    const b = binding();
    b.parent.autoMode = true;
    const route = b.bind(b.owner, b.session)!;
    const session = ready(route);
    const action = call(session, "app_handoff", { role: "component-editor", instructions: "Edit" }).actions[0];
    if (action?.kind !== "start") throw new Error("Missing editor");
    const args = headArguments(action.config);
    const policy = JSON.parse(args[args.indexOf("--settings") + 1]).autoMode;
    expect(policy.allow.some((rule: string) => rule.startsWith("Botling medium risk (allow)"))).toBe(true);
    expect(policy.soft_deny.some((rule: string) => rule.startsWith("Botling high risk (ask)"))).toBe(true);
  });

  it("rejects a copied fixed ID, same name/folder, ordinary bot, and a different app's Maintainer before loading config", () => {
    const b = binding();
    for (const fake of [{ ...b.owner }, { ...b.owner, id: "foreign" }, { ...b.owner, role: "bot" as const }, maintainerProfile(tempDir("other-app"), "maintain")]) {
      expect(b.bind(fake, b.session)).toBeNull();
    }
    expect(b.create).not.toHaveBeenCalled();
    b.owner.folder = join(b.root, "wrong-library");
    expect(b.bind(b.owner, b.session)).toBeNull();
  });

  it.each([ ["unsupported", "Read, Write", "explicit Claude model"], ["sonnet", "Read, Agent", "tools outside"], ["sonnet", "", "tools outside"] ])("refuses invalid definition (%s / %s) without rewriting it", (model, tools, reason) => {
    const b = binding();
    const text = b.definition(model, tools);
    writeFileSync(b.file, text);
    expect(b.bind(b.owner, b.session)?.error).toContain(reason);
    expect(readFileSync(b.file, "utf8")).toBe(text);
  });

  it("fails closed for missing definition and mismatched launch folder", () => {
    const b = binding();
    rmSync(b.file);
    expect(b.bind(b.owner, b.session)?.error).toContain(b.file);
    b.parent.cwd = "/foreign";
    expect(b.bind(b.owner, b.session)?.error).toContain("working folder");
  });
});

describe("Maintainer editor task lifecycle", () => {
  it("dispatches Claude, retains task ownership/role, and wakes the coordinator with its report", () => {
    const { session, out, action, task } = setup();
    expect(action.config).toMatchObject({ model: "haiku", resume: false });
    expect(out.writes.some(w => w.method === "thread/start")).toBe(false);
    expect(out.items).toContainEqual(expect.objectContaining({ kind: "subagentRuntime", id: task, runtime: expect.objectContaining({ engine: "claude" }), model: "haiku" }));
    expect(session.workerRecords[0]).toMatchObject({ id: task, role: "component-editor", thread: action.config.sessionId, wasActive: true });
    notify(session, "turn/completed", { threadId: "coordinator", turn: { id: "t1", status: "completed" } });
    const ended = new Out(session.componentEditorItem(task, 1, done));
    expect(ended.items).toContainEqual({ kind: "subagentEnded", id: task, status: "completed", summary: done.text });
    expect(ended.items).toContainEqual({ kind: "backgroundTurn", taskId: task });
    const report = ended.writes.find(w => w.method === "turn/start").params.toolOutput;
    expect(report.name).toBe("app_task_result");
    expect(JSON.parse(report.output)).toMatchObject({ task_id: task, status: "completed", report: done.text });
    expect(session.workerRecords[0]).toMatchObject({ id: task, reportPending: true, wasActive: false });
  });

  it("shows the Claude editor's message as one step, not one step per streamed chunk", () => {
    const { session, task } = setup();
    const said = (item: Parameters<typeof session.componentEditorItem>[2]) => new Out(session.componentEditorItem(task, 1, item)).items.filter(i => i.kind === "subagentText");
    const chunks = ["Edited `05B44", "DD6-73BB.md` (1) (", "1).\n\n**Integrity check", " (SHA-256)**: ok"];
    expect(chunks.flatMap(text => said({ kind: "delta", text }))).toEqual([]);
    expect(said({ kind: "assistantText", text: chunks.join("") })).toEqual([{ kind: "subagentText", parent: task, text: chunks.join("") }]);
  });

  it("refuses ordinary coordinators, unknown roles, and calls from foreign/child threads without launching anything", () => {
    const plain = ready();
    const rejected = call(plain, "app_handoff", { role: "component-editor", instructions: "edit" });
    expect(rejected.receipt.error).toContain("Only the app-created Maintainer");
    expect(plain.workerRecords).toEqual([]);
    const { session, task, action } = setup();
    for (const foreign of ["foreign-bot", action.config.sessionId]) {
      const denied = call(session, "app_handoff", { role: "component-editor", instructions: "nested" }, foreign);
      expect(denied.receipt.error).toContain("active coordinator");
      expect(denied.actions).toEqual([]);
      expect(notify(session, "turn/completed", { threadId: foreign, turn: { id: "fake", status: "completed" } }).all).toEqual([]);
    }
    expect(call(session, "app_handoff", { role: "arbitrary", instructions: "edit" }).receipt.error).toContain("unavailable");
    expect(session.runningWorkers).toEqual([task]);
  });

  it("forwards corrections and resumes the same Claude session/role, ignoring old-run results", () => {
    const { session, task, action } = setup();
    expect(call(session, "app_send_message", { task_id: task, message: "correction" }).actions).toEqual([{ kind: "send", task, run: 1, text: "correction" }]);
    session.componentEditorItem(task, 1, done);
    const follow = call(session, "app_send_message", { task_id: task, message: "follow up" });
    expect(follow.actions).toContainEqual(expect.objectContaining({ kind: "start", task, run: 2, config: expect.objectContaining({ sessionId: action.config.sessionId, resume: true }) }));
    expect(session.componentEditorItem(task, 1, done)).toEqual([]);
    expect(session.runningWorkers).toEqual([task]);
    const restored = ready(session.config.componentEditor, session.workerRecords);
    expect(call(restored, "app_send_message", { task_id: task, message: "after restart" }).actions).toContainEqual(expect.objectContaining({ kind: "start", task, run: 3, config: expect.objectContaining({ sessionId: action.config.sessionId, resume: true }) }));
  });

  it("losing the capability never resumes an editor as a generic Codex worker", () => {
    const { session, task } = setup();
    const restored = ready(null, session.workerRecords);
    const out = call(restored, "app_send_message", { task_id: task, message: "resume" });
    expect(out.writes.some(w => w.method === "thread/start" || w.method === "thread/resume")).toBe(false);
    expect(out.items).toContainEqual(expect.objectContaining({ kind: "subagentEnded", status: "failed", summary: expect.stringContaining("No generic worker") }));
    expect(restored.runningWorkers).toEqual([]);
  });

  it.each([true, false])("forwards only the actual child's permission input and decision (%s)", allow => {
    const { session, task } = setup();
    const input = { command: "echo test" };
    const asked = new Out(session.componentEditorItem(task, 1, { kind: "permission", requestId: "req", tool: "Bash", summary: "echo test", input }));
    const permission = asked.items[0];
    expect(permission.workerId).toBe(task);
    expect(new Out(session.answer(permission.requestId, allow, "why")).actions).toEqual([{ kind: "answer", task, run: 1, requestId: "req", input, allow, message: "why" }]);
    expect(session.answer(permission.requestId, true)).toEqual([]);
  });

  it("cancel clears approvals, stops the child, suppresses late events and preserves role for explicit resumption", () => {
    const { session, task } = setup();
    const asked = new Out(session.componentEditorItem(task, 1, { kind: "permission", requestId: "req", tool: "Bash", summary: "echo test", input: {} })).items[0];
    const stop = new Out(session.cancelWorkers(new Set([task])));
    expect(stop.actions).toEqual([{ kind: "stop", task }]);
    expect(stop.items).toContainEqual({ kind: "permissionCancelled", requestId: asked.requestId });
    expect(session.answer(asked.requestId, true)).toEqual([]);
    expect(session.componentEditorItem(task, 1, done)).toEqual([]);
    expect(call(session, "app_send_message", { task_id: task, message: "authorized retry" }).actions).toContainEqual(expect.objectContaining({ kind: "start", task, run: 2 }));
    expect(session.componentEditorFailed(task, 1, "stale")).toEqual([]);
    session.stop();
    expect(session.componentEditorItem(task, 2, done)).toEqual([]);
  });

  it("reports launch/exit failures and empty evidence without a fallback worker", () => {
    const { session, task } = setup();
    const failed = new Out(session.componentEditorFailed(task, 1, "Claude missing", true));
    expect(failed.items).toContainEqual(expect.objectContaining({ kind: "subagentEnded", status: "failed", summary: expect.stringContaining("Claude missing") }));
    expect(session.workerRecords[0].thread).toBeUndefined();
    const retry = call(session, "app_send_message", { task_id: task, message: "retry" });
    expect(retry.actions).toContainEqual(expect.objectContaining({ kind: "start", config: expect.objectContaining({ resume: false }) }));
    const empty = new Out(session.componentEditorItem(task, 2, { ...done, text: " " }));
    expect(empty.items).toContainEqual(expect.objectContaining({ kind: "subagentEnded", status: "failed", summary: NO_REPORT }));
    expect(session.componentEditorFailed(task, 2, "exit after result")).toEqual([]);
  });
});

describe('component-editor restart reconciliation',()=>{
 function checkpoint(){
  const b=setup(),id=b.action.config.sessionId;
  b.session.componentEditorItem(b.task,1,{kind:'init',sessionId:id});
  b.session.componentEditorItem(b.task,1,{kind:'toolUse',id:'read-checkpoint',tool:'Read',title:'Read',detail:'evidence',parent:null,input:{}});
  b.session.componentEditorItem(b.task,1,{kind:'toolResult',id:'read-checkpoint',output:'evidence',failed:false,parent:null,launch:null});
  return {...b,records:b.session.restartWorkers};
 }
 function reboot(b:ReturnType<typeof checkpoint>){
  const s=new CodexSession({...b.session.config,restoredWorkers:[],restartWorkers:b.records});
  s.start();s.receive(JSON.stringify({id:1,result:{}}));
  const out=new Out(s.receive(JSON.stringify({id:2,result:{thread:{id:'coordinator'}}})));
  expect(out.all).toContainEqual({kind:'recoverEditor',task:b.task,run:1,session:b.action.config.sessionId,checkpoint:'read-checkpoint'});
  expect(out.actions).toEqual([]);return s;
 }
 it('resumes the same Claude child/task with the original role and permissions, only after reconciliation (its next run)',()=>{
  const b=checkpoint();expect(b.records[0].restartSafe).toBe(true);const s=reboot(b);
  const out=new Out(s.recoverEditor(b.task,1,{state:'continue'})),a=out.actions[0];
  expect(a).toMatchObject({kind:'start',task:b.task,run:2,config:{...b.action.config,resume:true}});
  if(a.kind!=='start')throw Error('not a start');
  expect(a.text).toContain('authorized edit');expect(a.text).toContain('Do not repeat completed actions');
  expect(s.workerRecords[0]).toMatchObject({id:b.task,run:2,thread:b.action.config.sessionId,role:'component-editor',instructions:'authorized edit'});
 });
 it('uses completion-before-crash evidence without another Claude prompt or duplicate callback',()=>{
  const b=checkpoint(),s=reboot(b),out=new Out(s.recoverEditor(b.task,1,{state:'completed',report:'Already changed and checked'}));
  expect(out.actions).toEqual([]);expect(out.items).toContainEqual(expect.objectContaining({kind:'subagentEnded',id:b.task,status:'completed',summary:'Already changed and checked'}));
  expect(new Out(s.recoverEditor(b.task,1,{state:'completed',report:'late duplicate'})).writes).toEqual([]);
 });
 it('pending approval, unresolved calls and cancellation prevent automatic restart',()=>{
  const b=checkpoint();b.session.componentEditorItem(b.task,1,{kind:'permission',requestId:'ask',tool:'Bash',summary:'May I?',input:{}});
  expect(b.session.restartWorkers[0].restartSafe).toBe(false);
  b.session.componentEditorItem(b.task,1,{kind:'permissionCancelled',requestId:'ask'});
  b.session.componentEditorItem(b.task,1,{kind:'toolUse',id:'pending',tool:'Bash',title:'Bash',detail:'unknown outcome',parent:null,input:{}});
  expect(b.session.restartWorkers[0].restartSafe).toBe(false);
  const s=reboot(b);s.cancelWorkers(new Set([b.task]));expect(new Out(s.recoverEditor(b.task,1,{state:'continue'})).actions).toEqual([]);
 });
 it('missing role or ambiguous transcript never substitutes a generic worker',()=>{
  const b=checkpoint(),s=reboot(b);const out=new Out(s.recoverEditor(b.task,1,{state:'blocked',reason:'Unknown completion'}));
  expect(out.actions).toEqual([]);expect(out.items).toContainEqual(expect.objectContaining({kind:'subagentEnded',status:'interrupted'}));
  const missing=new CodexSession({...b.session.config,componentEditor:null,restartWorkers:b.records});
  const failed=new Out(missing.recoverEditor(b.task,1,{state:'continue'}));expect(failed.actions).toEqual([]);expect(failed.items).toContainEqual(expect.objectContaining({kind:'subagentEnded',status:'failed'}));
 });
});
