// Each engine's head takes a model/effort change in place where it can (a "hot switch"), and says no
// (so the bot restarts it) where it cannot.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const flags = vi.hoisted(() => ({ claudeEffort: false, agy: false }));
vi.mock("../../src/core/agent/hot-settings", async (original) => ({
  ...await original<any>(),
  claudeHotEffortEnabled: () => flags.claudeEffort,
  agyHotSettingsEnabled: () => flags.agy,
}));
import { ClaudeHead } from "../../src/core/agent/head";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { AgyAcpHead, AgyAcpProtocol } from "../../src/core/agent/agy-acp";

afterEach(() => { flags.claudeEffort = false; flags.agy = false; });

function claude(config: Record<string, unknown> = {}) {
  const writes: any[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); });
  const head = new ClaudeHead({ command: "/test/claude", cwd: "/tmp", sessionId: "s", resume: false, allowedTools: [], harmless: true, model: "opus", effort: "high", ...config },
    { onItem() {}, onExit() {} }, { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
  head.start();
  const receive = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  const answer = (subtype: "success" | "error") => receive({ type: "control_response", response: { subtype, request_id: writes.at(-1).request_id, ...(subtype === "error" ? { error: "nope" } : { response: {} }) } });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { head, writes, receive, answer, tick, child };
}

describe("Claude: set_model in the running process", () => {
  it("sends set_model and takes the new model when claude answers success", async () => {
    const t = claude();
    const done = t.head.applySettings({ model: "sonnet", effort: "high" });
    await t.tick();
    expect(t.writes.at(-1)).toMatchObject({ type: "control_request", request: { subtype: "set_model", model: "sonnet" } });
    expect(t.writes.at(-1).request_id).toMatch(/^set-model-/);
    t.answer("success");
    expect(await done).toBe(true);
    expect(t.head.config.model).toBe("sonnet");
  });

  it("asks for claude's default model with no model, and reports a refusal as not applied", async () => {
    const t = claude();
    const done = t.head.applySettings({ model: null });
    await t.tick();
    expect(t.writes.at(-1).request).toEqual({ subtype: "set_model" });
    t.answer("error");
    expect(await done).toBe(false);
    expect(t.head.config.model).toBe("opus");
  });

  it("does not take an effort change in place while that is off, and writes nothing for it", async () => {
    const t = claude();
    expect(t.head.canApplySettings({ effort: "low" })).toBe(false);
    expect(await t.head.applySettings({ model: "sonnet", effort: "low" })).toBe(false);
    expect(t.writes).toHaveLength(0);
    expect(t.head.canApplySettings({ model: "sonnet", effort: "high" })).toBe(true);
  });

  it("with effort on, sends it as apply_flag_settings effortLevel", async () => {
    flags.claudeEffort = true;
    const t = claude();
    const done = t.head.applySettings({ effort: "low" });
    await t.tick();
    expect(t.writes.at(-1).request).toEqual({ subtype: "apply_flag_settings", settings: { effortLevel: "low" } });
    t.answer("success");
    expect(await done).toBe(true);
    expect(t.head.config.effort).toBe("low");
  });

  it("a request nobody answers, or a process that exits, is not applied", async () => {
    const t = claude();
    expect(await t.head.applySettings({ model: "sonnet" }, 20)).toBe(false);
    const pending = t.head.applySettings({ model: "haiku" });
    await t.tick();
    t.child.emit("close", 0, null);
    expect(await pending).toBe(false);
    expect(t.head.config.model).toBe("opus");
  });

  it("before the monitor hook is registered, set_model waits behind it", async () => {
    const t = claude({ harmless: false });
    const done = t.head.applySettings({ model: "sonnet" });
    await t.tick();
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].request.subtype).toBe("initialize");
    t.receive({ type: "control_response", response: { subtype: "success", request_id: t.writes[0].request_id, response: {} } });
    await t.tick();
    expect(t.writes[1].request).toMatchObject({ subtype: "set_model", model: "sonnet" });
    t.answer("success");
    expect(await done).toBe(true);
  });
});

const codexWrites = (out: CodexOutput[]) => out.filter((o) => o.kind === "write").map((o) => o.value as any);
function codex(overrides: Partial<CodexConfig> = {}) {
  const s = new CodexSession({ cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: null, resumeThread: null, model: "gpt-old", workerModel: null, effort: "medium", restoredWorkers: [], ...overrides });
  const started = codexWrites([...s.start(), ...s.receive(JSON.stringify({ id: 1, result: {} }))]);
  const thread = started.find((w) => w.method === "thread/start");
  s.receive(JSON.stringify({ id: thread.id, result: { thread: { id: "coordinator" } } }));
  return s;
}

describe("Codex: the next turn/start overrides model and effort", () => {
  it("carries the switched model and effort on the next turns", () => {
    const s = codex();
    const before = codexWrites(s.send("first")).find((w) => w.method === "turn/start");
    expect(before.params.model).toBeUndefined();
    expect(before.params.effort).toBe("medium");
    s.receive(JSON.stringify({ id: before.id, result: { turn: { id: "t1" } } }));
    s.receive(JSON.stringify({ method: "turn/completed", params: { threadId: "coordinator", turn: { id: "t1", status: "completed" } } }));
    expect(s.applySettings({ model: "gpt-new", effort: "high" })).toBe(true);
    const after = codexWrites(s.send("second")).find((w) => w.method === "turn/start");
    expect(after.params).toMatchObject({ model: "gpt-new", effort: "high" });
    // New workers start on it too (workerModel ?? model).
    expect(s.config.model).toBe("gpt-new");
  });

  it("cannot go back to the default with an override: that needs a restart", () => {
    const s = codex();
    expect(s.canApplySettings({ model: null })).toBe(false);
    expect(s.applySettings({ model: null, effort: "high" })).toBe(false);
    expect(s.applySettings({ effort: null })).toBe(false);
    expect(s.config).toMatchObject({ model: "gpt-old", effort: "medium" });
    // Unchanged values are no change at all.
    expect(s.applySettings({ model: "gpt-old", effort: "medium" })).toBe(true);
  });
});

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function agy() {
  const frames: any[] = [], errors: Error[] = [];
  const config: any = { command: "never-launched", cwd: "/owned", sessionId: "old", resume: false, model: "m1", effort: "low" };
  const client = new AgyAcpProtocol(config, (m) => frames.push(m), () => {}, (e) => errors.push(e));
  const reply = (result: any) => client.receive({ jsonrpc: "2.0", id: frames.findLast((f) => f.method && f.id).id, result });
  const policy = () => reply({ configOptions: [{ id: "mode", currentValue: "default" }] });
  const init = async () => {
    const started = client.start();
    reply({ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.4.3" }, agentCapabilities: { loadSession: true } }); await tick();
    reply({ sessionId: "new", models: { availableModels: [{ modelId: "m1" }, { modelId: "m2" }] } }); await tick();
    policy(); await tick();
    reply({}); await tick(); // set_model m1
    reply({ configOptions: [{ id: "thinking_level", currentValue: "low" }] }); await tick();
    policy(); await started;
  };
  return { client, frames, errors, reply, init, config };
}

describe("Antigravity: session/set_model and thinking_level between turns", () => {
  it("sets an advertised model and a confirmed effort in the same conversation", async () => {
    const a = agy(); await a.init();
    const done = a.client.applySettings({ model: "m2", effort: "high" }); await tick();
    expect(a.frames.at(-1)).toMatchObject({ method: "session/set_model", params: { sessionId: "new", modelId: "m2" } });
    a.reply({}); await tick();
    expect(a.frames.at(-1)).toMatchObject({ method: "session/set_config_option", params: { configId: "thinking_level", value: "high" } });
    a.reply({ configOptions: [{ id: "thinking_level", currentValue: "high" }] });
    expect(await done).toBe(true);
    expect(a.config).toMatchObject({ model: "m2", effort: "high" });
  });

  it("refuses what it cannot set and an effort the server does not confirm", async () => {
    const a = agy(); await a.init();
    const count = a.frames.length;
    expect(await a.client.applySettings({ model: "unadvertised" })).toBe(false);
    expect(await a.client.applySettings({ model: null })).toBe(false);
    expect(await a.client.applySettings({ effort: "max" })).toBe(false);
    expect(a.frames.length).toBe(count);
    const done = a.client.applySettings({ effort: "medium" }); await tick();
    a.reply({ configOptions: [{ id: "thinking_level", currentValue: "low" }] });
    expect(await done).toBe(false);
    expect(a.config.effort).toBe("low");
  });

  it("is not tried before the conversation is ready", async () => {
    const a = agy();
    expect(await a.client.applySettings({ model: "m2" })).toBe(false);
    expect(a.frames).toHaveLength(0);
  });

  it("the head keeps the restart path while the mid-conversation switch is unverified", () => {
    const head = new AgyAcpHead({ command: "never", cwd: "/owned", sessionId: "s", resume: false } as any, { onItem() {}, onExit() {} });
    expect(head.canApplySettings({ model: "m2" })).toBe(false);
  });
});
