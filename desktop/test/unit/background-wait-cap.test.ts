// No background wait of a Botling-run Claude session (bot head or app-managed worker) outlasts 50 minutes: the
// 1-hour prompt cache would be cold when the notification wakes the model (session dd51206a, 2026-11-17: Bash
// run_in_background with timeout 3 700 000 ms, next model call 1.01 h later). A PreToolUse hook rewrites the
// timeout (`updatedInput`) and tells the model, so it re-arms the wait if it is still needed.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CAP_HOOK, BACKGROUND_WAIT_CAP_MS, backgroundCapDecision } from "../../src/core/agent/background-cap";
import { ClaudeHead, type HeadConfig } from "../../src/core/agent/head";

const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name, tool_input });
const out = (decision: any) => decision.hookSpecificOutput;

describe("backgroundCapDecision", () => {
  it("is 50 minutes", () => expect(BACKGROUND_WAIT_CAP_MS).toBe(3_000_000));
  it("caps a background Bash wait of 3 700 000 ms (the real case) and keeps every other field", () => {
    const input = { command: "until [ -z \"$(lsof | grep x)\" ]; do sleep 30; done", description: "wait", timeout: 3_700_000, run_in_background: true };
    const o = out(backgroundCapDecision(pre("Bash", input)));
    expect(o.hookEventName).toBe("PreToolUse");
    expect(o.updatedInput).toEqual({ ...input, timeout: 3_000_000 });
    expect(o.permissionDecision).toBeUndefined(); // the normal permission flow still decides
    expect(o.additionalContext).toMatch(/50 minutes/);
    expect(o.additionalContext).toMatch(/3700000/);
    expect(o.additionalContext).toMatch(/again|re-?arm/i);
  });
  it("caps a Monitor deadline, but not a persistent monitor, which has none", () => {
    expect(out(backgroundCapDecision(pre("Monitor", { command: "tail -f x", timeout_ms: 3_600_000 }))).updatedInput).toMatchObject({ command: "tail -f x", timeout_ms: 3_000_000 });
    expect(backgroundCapDecision(pre("Monitor", { command: "tail -f x", timeout_ms: 3_600_000, persistent: true }))).toEqual({});
  });
  it("leaves alone what is already within 50 minutes, a foreground Bash call, a missing or odd timeout, and other tools", () => {
    expect(backgroundCapDecision(pre("Bash", { command: "x", timeout: 3_000_000, run_in_background: true }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", { command: "x", timeout: 600_000, run_in_background: true }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", { command: "x", timeout: 9_000_000 }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", { command: "x", run_in_background: true }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", { command: "x", timeout: "soon", run_in_background: true }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", null as any))).toEqual({});
    expect(backgroundCapDecision(pre("Read", { timeout: 9_000_000, run_in_background: true }))).toEqual({});
    expect(backgroundCapDecision({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { timeout: 9_000_000, run_in_background: true } })).toEqual({});
    expect(backgroundCapDecision(undefined)).toEqual({});
  });
  it("caps the string forms the CLI's schemas also accept (\"true\", \"3700000\")", () => {
    expect(out(backgroundCapDecision(pre("Bash", { command: "x", timeout: "3700000", run_in_background: "true" }))).updatedInput).toEqual({ command: "x", timeout: 3_000_000, run_in_background: "true" });
    expect(out(backgroundCapDecision(pre("Bash", { command: "x", timeout: 3_700_000, run_in_background: "true" }))).updatedInput.timeout).toBe(3_000_000);
    expect(backgroundCapDecision(pre("Monitor", { command: "x", timeout_ms: "3700000", persistent: "true" }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", { command: "x", timeout: "600000", run_in_background: "true" }))).toEqual({});
    expect(backgroundCapDecision(pre("Bash", { command: "x", timeout: "3700000", run_in_background: "false" }))).toEqual({});
  });
  it("does not follow a prototype key as a value (own properties only)", () => {
    const input = Object.create({ timeout: 9_000_000, run_in_background: true });
    expect(backgroundCapDecision(pre("Bash", input))).toEqual({});
  });
});

describe("the hook on a Claude session", () => {
  const base: HeadConfig = { command: "claude", cwd: "/tmp", sessionId: "s", resume: false, allowedTools: ["Read", "Bash"] };
  function transport(config: Partial<HeadConfig>) {
    const writes: any[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); });
    const head = new ClaudeHead({ ...base, ...config }, { onItem() {}, onExit() {} },
      { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
    head.start();
    return { writes, receive: (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n"), settle: () => new Promise((r) => setTimeout(r, 10)) };
  }
  it("is registered for Bash and Monitor in the initialize of every non-harmless session, and answers with the capped input", async () => {
    for (const config of [{}, { specGuard: { writers: ["opus"] } }, { allowedTools: ["Read"] }]) {
      const t = transport(config);
      const hooks = t.writes[0].request.hooks.PreToolUse as any[];
      expect(hooks.find((h) => h.hookCallbackIds?.includes(BACKGROUND_CAP_HOOK))).toMatchObject({ matcher: "^(Bash|Monitor)$" });
      t.receive({ type: "control_request", request_id: "h1", request: { subtype: "hook_callback", callback_id: BACKGROUND_CAP_HOOK, input: pre("Bash", { command: "w", timeout: 3_700_000, run_in_background: true }) } });
      await t.settle();
      const answer = t.writes.find((w) => w.response?.request_id === "h1").response.response;
      expect(answer.hookSpecificOutput.updatedInput.timeout).toBe(3_000_000);
    }
  });
  it("is not registered for a harmless (test) session", () => {
    const t = transport({ harmless: true });
    expect(JSON.stringify(t.writes[0]?.request?.hooks ?? {})).not.toContain(BACKGROUND_CAP_HOOK);
  });
});
