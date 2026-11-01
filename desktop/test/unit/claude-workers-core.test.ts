// Claude app workers end to end, through the built core and the fake CLI: the bot's head starts with the app's tools and
// without the native Agent tool, app_handoff starts a worker process of its own (own session, the bot's folder), its
// report comes back to the bot as the app's message, the bot's Stop leaves a running worker alone, and quitting ends it.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { alive, tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
const core = (dataDir: string, env: Record<string, string> = {}) => {
  const harness = new CoreHarness(dataDir, { FAKE_CLAUDE_LOG: join(dataDir, "starts.log"), ...env });
  harnesses.push(harness);
  return harness;
};
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const starts = (dir: string): { pid: number; args: string[]; resume: boolean; session: string; cwd: string }[] =>
  existsSync(join(dir, "starts.log")) ? readFileSync(join(dir, "starts.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function turn(c: CoreHarness, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `the end of "${text}"` });
  return { turnId, event: finished.event as { status: string; text: string } };
}
const subagentUpdates = (c: CoreHarness) => c.of("subagent.updated").map((e) => (e.event as { subagent: any }).subagent);

describe("Claude's app-managed workers", () => {
  it("a report turn that ends with nothing leaves no blank bubble in the chat", async () => {
    const dir = tempDir("claude-workers");
    const c = core(dir, { FAKE_CLAUDE_REPORT_REPLY: "" });
    const { turnId: handOff, event } = await turn(c, "/worker Look up the API");
    const taskId = /^Handed off: ([0-9a-f-]{36})$/.exec(event.text)?.[1];
    expect(taskId, event.text).toBeTruthy();
    const ended = await until(() => c.of("turn.finished").map((e) => e.event as { turnId: string; text: string; status: string }).find((e) => e.turnId !== handOff), { what: "the report turn" });
    expect(ended).toMatchObject({ status: "done", text: "" });
    const bots = (await c.chat()).messages.filter((m: { role: string }) => m.role === "bot");
    expect(bots.map((m: { text: string }) => m.text)).toEqual([event.text]);
    const saved = JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8"));
    expect(saved.filter((m: { role: string; text: string }) => m.role === "bot" && !m.text.trim())).toEqual([]);
  });

  it("app_handoff starts a worker process of its own whose report comes back to the bot as the app's message", async () => {
    const dir = tempDir("claude-workers");
    const c = core(dir);
    const { event } = await turn(c, "/worker Look up the API");
    expect(event.status).toBe("done");
    const taskId = /^Handed off: ([0-9a-f-]{36})$/.exec(event.text)?.[1];
    expect(taskId, event.text).toBeTruthy();
    const [head, worker] = await until(() => { const s = starts(dir); return s.length >= 2 ? s : null; }, { what: "the worker's start" });
    // The coordinator: the app's tools on the control channel, no native Agent/Task.
    expect(JSON.parse(flag(head!.args, "--mcp-config")!)).toEqual({ mcpServers: { botling: { type: "sdk", name: "botling" } } });
    expect(flag(head!.args, "--disallowedTools")!.split(",")).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(flag(head!.args, "--allowedTools")!.split(",")).toContain("mcp__botling__app_handoff");
    expect(flag(head!.args, "--append-system-prompt")).toContain("app_handoff");
    // The worker: its own session in the bot's folder, no app tools, no subagents.
    expect(worker!.session).not.toBe(head!.session);
    expect(worker!.cwd).toBe(head!.cwd);
    expect(worker!.args).not.toContain("--mcp-config");
    expect(flag(worker!.args, "--disallowedTools")!.split(",")).toEqual(expect.arrayContaining(["Agent", "Task", "SendMessage"]));
    expect(flag(worker!.args, "--append-system-prompt")).toContain("app-managed worker");
    // Its report: the app's message to the bot, which answers it in a turn of its own.
    const report = await until(() => c.of("turn.finished").map((e) => e.event as { text: string }).find((e) => e.text.includes("app_task_result")), { what: "the report turn" });
    expect(report.text).toContain(`task_id="${taskId}"`);
    expect(report.text).toContain("You said: Look up the API");
    const row = await until(() => subagentUpdates(c).filter((s) => s.id === taskId).at(-1)?.status === "completed" ? subagentUpdates(c).filter((s) => s.id === taskId).at(-1) : null, { what: "the worker's row completed" });
    expect(row).toMatchObject({ id: taskId, status: "completed" });
    // The member's worker ledger is its record (claude-workers.json is no longer written).
    const ledger = JSON.parse(readFileSync(join(dir, "main", "worker-ledger.json"), "utf8"));
    expect(ledger.records[0]).toMatchObject({ id: taskId, run: 1, status: "done", report: { state: "acknowledged", status: "done" } });
    expect(existsSync(join(dir, "main", "claude-workers.json"))).toBe(false);
  });

  it("the bot's Stop leaves a running worker alone; quitting the app ends it and marks it interrupted", async () => {
    const dir = tempDir("claude-workers-stop");
    const c = core(dir);
    const { event } = await turn(c, "/worker /slow");
    const taskId = /^Handed off: ([0-9a-f-]{36})$/.exec(event.text)?.[1]!;
    const worker = await until(() => starts(dir)[1] ?? null, { what: "the worker's start" });
    await until(() => subagentUpdates(c).some((s) => s.id === taskId && s.status === "running"), { what: "the worker at work" });
    // The bot works on something else and the user stops that turn.
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    await until(() => c.of("turn.delta").some((e) => (e.event as { turnId: string }).turnId === turnId), { what: "the bot's own slow turn" });
    await c.call({ type: "turn.stop", botId: MAIN, turnId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(worker.pid)).toBe(true);
    expect(subagentUpdates(c).filter((s) => s.id === taskId).at(-1)?.status).toBe("running");
    await c.kill("SIGTERM");
    await until(() => !alive(worker.pid), { what: "the worker ended with the app" });
    const ledger = JSON.parse(readFileSync(join(dir, "main", "worker-ledger.json"), "utf8"));
    expect(ledger.records[0]).toMatchObject({ id: taskId, status: "interrupted", interruptedBy: "quit", recovery: "required" });
  });

  it("the hidden settings.json claudeWorkers: native gives the head its Agent tool back and no app tools", async () => {
    const dir = tempDir("claude-workers-native");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ claudeWorkers: "native" }));
    const c = core(dir);
    const { event } = await turn(c, "hello");
    expect(event.text).toBe("You said: hello");
    const head = starts(dir)[0]!;
    expect(head.args).not.toContain("--mcp-config");
    expect(flag(head.args, "--disallowedTools")?.split(",") ?? []).not.toContain("Agent");
    expect(flag(head.args, "--append-system-prompt")).not.toContain("app_handoff tool");
  });
});
