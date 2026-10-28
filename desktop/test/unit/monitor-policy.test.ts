import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeHead } from "../../src/core/agent/head";

function transport() {
  const writes: any[] = [], items: any[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on("data", chunk => writes.push(JSON.parse(String(chunk))));
  const head = new ClaudeHead({ command: "/test/claude", cwd: "/tmp", sessionId: "owner", resume: false, allowedTools: ["Monitor"], bypassPermissions: true, monitorWorker: false },
    { onItem: i => items.push(i), onExit() {} }, { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
  head.start();
  const receive = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  return { head, writes, items, receive };
}

describe("coordinator-only Claude monitors", () => {
  it("registers the pre-execution hook before delivering user input, including bypass mode", () => {
    const t = transport();
    t.head.send("authorized work", "u1");
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].request).toMatchObject({ subtype: "initialize", hooks: { PreToolUse: [{ matcher: "^Monitor$", hookCallbackIds: ["botling-monitor-owner"] }] } });
    t.receive({ type: "control_response", response: { subtype: "success", request_id: t.writes[0].request_id, response: {} } });
    expect(t.writes[1]).toMatchObject({ type: "user", uuid: "u1" });
  });
  it("denies child execution with original intent and leaves coordinator permissions undecided", () => {
    const t = transport();
    const hook = (input: any, id: string) => {
      t.receive({ type: "control_request", request_id: id, request: { subtype: "hook_callback", callback_id: "botling-monitor-owner", input: { hook_event_name: "PreToolUse", tool_name: "Monitor", tool_input: { command: "echo intent", timeout: 600 }, ...input } } });
      return t.writes.at(-1).response;
    };
    const denied = hook({ agent_id: "child-7" }, "h1");
    expect(denied).toMatchObject({ request_id: "h1", response: { hookSpecificOutput: { permissionDecision: "deny" } } });
    expect(denied.response.hookSpecificOutput.permissionDecisionReason).toContain("echo intent");
    expect(denied.response.hookSpecificOutput.permissionDecisionReason).toContain("existing approval");
    expect(hook({}, "h2").response).toEqual({});
    expect(t.items).toEqual([]);
  });
});

import { monitorTask } from "../../src/core/agent/monitors";
import { backgroundTaskView } from "../../src/core/background-work";

it("projects execution and callback separately only for proven coordinator ownership", () => {
  const record: any = { id: "m", owner: "OWNER", ownerRole: "coordinator", threadId: "th", turnId: "t", command: "echo ok", cwd: "/tmp", state: "succeeded", wake: "pending", stdout: "ok", stderr: "", detail: "", createdAt: 1, endedAt: 2 };
  const task = monitorTask(record)!;
  expect(task.status).toBe("completed");
  expect(task.title).toContain("Coordinator");
  expect(backgroundTaskView(task)).toMatchObject({ monitor: { ownerSession: "owner", execution: "succeeded", callback: "pending", threadId: "th", turnId: "t" } });
  expect(monitorTask({ ...record, ownerRole: undefined })).toBeNull();
  expect(monitorTask({ ...record, ownerRole: "worker" })).toBeNull();
});

it("does not release queued work after initialization failure or a late success", () => {
  const t = transport();
  t.head.send("must stay queued", "u1");
  const id = t.writes[0].request_id;
  t.receive({ type: "control_response", response: { subtype: "error", request_id: id, error: "unsupported hooks" } });
  t.receive({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
  t.head.send("also blocked", "u2");
  expect(t.writes.some(w => w.type === "user")).toBe(false);
});

it("does not show an interrupted owner's cached execution as running", () => {
  const view = backgroundTaskView({ id: "m", kind: "monitor", title: "Coordinator monitor", status: "interrupted", startedAt: 1,
    monitor: { ownerSession: "owner", threadId: "th", turnId: "t", execution: "running", callback: "none" } });
  expect(view?.monitor).toMatchObject({ execution: "interrupted", callback: "uncertain" });
});

import { claudeMonitorDecision } from "../../src/core/agent/monitor-policy";
it("blocks an app-managed Claude child even without a nested-agent ID, but leaves other tools alone", () => {
  expect(claudeMonitorDecision({ hook_event_name: "PreToolUse", tool_name: "Monitor", tool_input: { command: "echo child" } }, true)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(claudeMonitorDecision({ hook_event_name: "PreToolUse", tool_name: "Read", agent_id: "child" }, true)).toEqual({});
});

it("Stop before hook acknowledgement never releases that turn's queued command", () => {
  const t = transport();
  t.head.send("stopped intent", "u1");
  const id = t.writes[0].request_id;
  t.head.interrupt();
  t.receive({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
  expect(t.writes.some(w => w.type === "user")).toBe(false);
  t.head.send("next turn", "u2");
  expect(t.writes.at(-1)).toMatchObject({ type: "user", uuid: "u2" });
});

import { Bot } from "../../src/core/bot";
it("updates only the originating coordinator reply, never a foreign owner or descendant's historical step", () => {
  const record: any = { id: "m", owner: "OWNER", ownerRole: "coordinator", command: "echo ok", cwd: "/tmp", state: "running", wake: "none", stdout: "", stderr: "", detail: "", createdAt: 1 };
  const original = { engine: "codex", steps: [{ id: "m", tool: "Monitor" }] };
  const child = { engine: "codex", steps: [{ id: "child", tool: "Agent", subagent: { steps: [{ id: "child-m", tool: "Monitor" }] } }] };
  const changed: unknown[] = [];
  const target = { session: { sessionId: "owner" }, records: [original, child], turn: null, changed: (r: unknown) => changed.push(r) };
  const feed = (m: any) => (Bot.prototype as any).monitorState.call(target, m);
  feed({ ...record, owner: "foreign" });
  feed({ ...record, id: "child-m" });
  feed({ ...record, ownerRole: undefined });
  expect(changed).toEqual([]);
  feed(record);
  expect(changed).toEqual([original]);
  expect(original).toMatchObject({ backgroundTasks: [{ id: "m", monitor: { ownerSession: "owner", execution: "running" } }] });
  expect(child).not.toHaveProperty("backgroundTasks");
});

import { endTask } from "../../src/core/background-tasks";
it("keeps Claude callback delivery unknown when the native watch ends", () => {
  const task: any = { id: "native", kind: "monitor", title: "Coordinator monitor", status: "running", startedAt: 1,
    monitor: { ownerSession: "owner", threadId: null, turnId: "t", execution: "running", callback: "unknown" } };
  endTask(task, "completed", "watch expired", 2);
  expect(backgroundTaskView(task)).toMatchObject({ status: "completed", monitor: { execution: "ended", callback: "unknown" } });
});

it("a native background event requires a coordinator step before acquiring coordinator ownership", () => {
  const target: any = { session: { sessionId: "OWNER" }, turn: { id: "turn", open: true, steps: [{ id: "m", tool: "Monitor", title: "Watch", detail: "echo ok" }] } };
  const add = (id: string) => (Bot.prototype as any).addBackgroundTask.call(target, id, "monitor", "Watch");
  add("child-m");
  expect(target.turn.tasks).toBeUndefined();
  add("m"); add("m");
  expect(target.turn.tasks).toHaveLength(1);
  expect(target.turn.tasks[0]).toMatchObject({ title: "Coordinator monitor: Watch", monitor: { ownerSession: "owner", execution: "running", callback: "unknown" } });
});
