// A Claude coordinator in app-worker mode (the default): the app's tools on the SDK control channel (--mcp-config "sdk"),
// the native Agent/Task tool removed, and the PreToolUse guard that denies any Agent/Task call that still comes,
// foreground or background.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AGENT_GUARD_HOOK, ClaudeHead, agentGuardDecision, headArguments, type HeadConfig } from "../../src/core/agent/head";
import { CLAUDE_AGENT_GUARD, CLAUDE_APP_SERVER, CLAUDE_APP_TOOLS } from "../../src/core/agent/claude-workers";
import { desktopPrompts, botPrompts, CLAUDE_WORKERS_RULE, NATIVE_SUBAGENT_LINE } from "../../src/core/prompts";
import { claudeWorkersMode, launchSettings } from "../../src/core/settings";

const base: HeadConfig = { command: "claude", cwd: "/tmp", sessionId: "s", resume: false, allowedTools: ["Read", "Bash"] };
const app = { appMcp: { server: CLAUDE_APP_SERVER, tools: CLAUDE_APP_TOOLS }, agentGuard: CLAUDE_AGENT_GUARD };
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

describe("headArguments", () => {
  it("passes the in-process app server and allows its tools only when the app's tools are on", () => {
    const on = headArguments({ ...base, ...app });
    expect(JSON.parse(flag(on, "--mcp-config")!)).toEqual({ mcpServers: { botling: { type: "sdk", name: "botling" } } });
    expect(flag(on, "--allowedTools")!.split(",")).toEqual(expect.arrayContaining(["Read", "Bash", "mcp__botling__app_handoff", "mcp__botling__app_send_message", "mcp__botling__app_cancel_task"]));
    const off = headArguments(base);
    expect(off).not.toContain("--mcp-config");
    expect(flag(off, "--allowedTools")).toBe("Read,Bash");
  });
  it("removes both names of the native subagent tool only with the guard", () => {
    expect(flag(headArguments({ ...base, ...app }), "--disallowedTools")!.split(",")).toEqual(["AskUserQuestion", "Agent", "Task"]);
    expect(flag(headArguments(base), "--disallowedTools")).toBe("AskUserQuestion");
  });
  it("gives a harmless (test) session neither", () => {
    const args = headArguments({ ...base, ...app, harmless: true });
    expect(args).not.toContain("--mcp-config");
    expect(args.join(" ")).not.toContain("Agent");
  });
});

function transport(config: Partial<HeadConfig>, onAppTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const writes: any[] = [], items: any[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); });
  const head = new ClaudeHead({ ...base, ...config }, { onItem: (i) => items.push(i), onExit() {}, ...(onAppTool ? { onAppTool } : {}) },
    { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
  head.start();
  const receive = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { head, writes, items, receive, settle };
}

describe("the coordinator's initialize", () => {
  it("registers the Agent guard next to the Monitor hook and names the in-process server, before any input", () => {
    const t = transport({ ...app, allowedTools: ["Monitor"] });
    t.head.send("work", "u1");
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].request).toMatchObject({ subtype: "initialize", sdkMcpServers: ["botling"],
      hooks: { PreToolUse: [{ matcher: "^Monitor$" }, { matcher: "^(Agent|Task)$", hookCallbackIds: [AGENT_GUARD_HOOK] }] } });
    t.receive({ type: "control_response", response: { subtype: "success", request_id: t.writes[0].request_id, response: {} } });
    expect(t.writes[1]).toMatchObject({ type: "user", uuid: "u1" });
  });
  it("has neither without the app's tools", () => {
    const t = transport({});
    expect(t.writes[0].request.sdkMcpServers).toBeUndefined();
    expect(JSON.stringify(t.writes[0].request.hooks)).not.toContain("Agent");
  });
});

describe("the guard", () => {
  const hook = (t: ReturnType<typeof transport>, input: Record<string, unknown>, id: string) => {
    t.receive({ type: "control_request", request_id: id, request: { subtype: "hook_callback", callback_id: AGENT_GUARD_HOOK, input: { hook_event_name: "PreToolUse", ...input } } });
  };
  it("denies a background and a foreground Agent call alike, and Task, with the app_handoff instruction", async () => {
    const t = transport(app);
    hook(t, { tool_name: "Agent", tool_input: { description: "d", prompt: "p", run_in_background: true } }, "h1");
    hook(t, { tool_name: "Agent", tool_input: { description: "d", prompt: "p" } }, "h2");
    hook(t, { tool_name: "Task", tool_input: { description: "d", prompt: "p" } }, "h3");
    await t.settle();
    for (const id of ["h1", "h2", "h3"]) {
      const answer = t.writes.find((w) => w.response?.request_id === id).response.response;
      expect(answer.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(answer.hookSpecificOutput.permissionDecisionReason).toContain("app_handoff");
    }
    expect(t.items).toEqual([]);
  });
  it("leaves other tools alone", () => {
    expect(agentGuardDecision({ hook_event_name: "PreToolUse", tool_name: "Bash" }, "x")).toEqual({});
  });
});

describe("the in-process app server", () => {
  it("answers initialize, tools/list and tools/call on the control channel", async () => {
    const calls: [string, unknown][] = [];
    const t = transport(app, async (name, args) => { calls.push([name, args]); return { accepted: true, task_id: "t-1", run: 1 }; });
    const mcp = (id: string, message: Record<string, unknown>) => t.receive({ type: "control_request", request_id: id, request: { subtype: "mcp_message", server_name: "botling", message: { jsonrpc: "2.0", ...message } } });
    const answer = (id: string) => t.writes.find((w) => w.response?.request_id === id)?.response;
    mcp("m1", { id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    mcp("m2", { method: "notifications/initialized" });
    mcp("m3", { id: 1, method: "tools/list" });
    mcp("m4", { id: 2, method: "tools/call", params: { name: "app_handoff", arguments: { name: "probe", instructions: "say hi" } } });
    await t.settle();
    expect(answer("m1").response.mcp_response).toMatchObject({ id: 0, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    expect(answer("m2").response.mcp_response).toEqual({ jsonrpc: "2.0", result: {} });
    expect(answer("m3").response.mcp_response.result.tools.map((tool: any) => tool.name)).toEqual(["app_handoff", "app_send_message", "app_cancel_task"]);
    expect(JSON.parse(answer("m4").response.mcp_response.result.content[0].text)).toEqual({ accepted: true, task_id: "t-1", run: 1 });
    expect(calls).toEqual([["app_handoff", { name: "probe", instructions: "say hi" }]]);
  });
  it("returns a tool's error as an MCP error result and refuses another server", async () => {
    const t = transport(app, async () => { throw new Error("Unknown task_id."); });
    t.receive({ type: "control_request", request_id: "e1", request: { subtype: "mcp_message", server_name: "botling", message: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "app_send_message", arguments: {} } } } });
    t.receive({ type: "control_request", request_id: "e2", request: { subtype: "mcp_message", server_name: "other", message: { jsonrpc: "2.0", id: 6, method: "tools/list" } } });
    await t.settle();
    const result = t.writes.find((w) => w.response?.request_id === "e1").response.response.mcp_response.result;
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Unknown task_id." }] });
    expect(t.writes.find((w) => w.response?.request_id === "e2").response.subtype).toBe("error");
  });
});

describe("the prompt and the hidden setting", () => {
  const manager = { name: "p", role: "manager" as const, folder: "/p", memoryPath: ".bot/memory.md", job: null, id: "x" };
  it("tells a Claude bot about app workers by default and keeps the native line for the hidden fallback", () => {
    const plain = botPrompts({ profile: manager });
    expect(plain.system).toContain(NATIVE_SUBAGENT_LINE);
    const workers = desktopPrompts(plain, manager).system;
    expect(workers).toContain(CLAUDE_WORKERS_RULE);
    expect(workers).not.toContain(NATIVE_SUBAGENT_LINE);
    const native = desktopPrompts(plain, manager, null, "claude", false).system;
    expect(native).toContain(NATIVE_SUBAGENT_LINE);
    expect(native).not.toContain("app_handoff tool");
  });
  it("is on unless settings.json says claudeWorkers: native", () => {
    expect(claudeWorkersMode({})).toBe("app");
    expect(claudeWorkersMode({ claudeWorkers: "anything" })).toBe("app");
    expect(claudeWorkersMode({ claudeWorkers: "native" })).toBe("native");
    expect(launchSettings({}).claudeWorkers).toBe("app");
  });
});
