// Routines and command monitors through the built core (fake claude, fake Codex app-server):
// routines.cron runs at its time once, an app-owned schedule is claimed before it is dispatched
// (and a claim nobody confirmed stays delivery_uncertain), Codex's app_routines changes the same
// file, and a monitored command waits for its Allow once card, runs, and wakes Codex once.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until, sleep } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), FAKE_CODEX_INPUT: join(dir, "codex-input.log"), BOTLING_ROUTINE_TICK_MS: "150", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const claudeInputs = (dir: string): string[] => lines(join(dir, "claude-input.log")).map((entry) => entry.text);
const codexLog = (dir: string, kind: string) => lines(join(dir, "codex-input.log")).filter((entry) => entry.kind === kind);
const swiftNow = (offsetMs = 0) => (Date.now() + offsetMs - Date.UTC(2001, 0, 1)) / 1000;

function codexOnly(dir: string) {
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
}

describe("routines", () => {
  it("the main bot starts with the daily summary; a routines.cron job runs at its time, once", async () => {
    const dir = tempDir("routines");
    const c = core(dir);
    const list = await until(async () => { const r = await c.call({ type: "routines.list", botId: MAIN }); return r.routines.length && r; });
    expect(list.routines).toEqual([expect.objectContaining({ id: expect.stringMatching(/^cron:15 8 \* \* \* Daily summary: /), kind: "legacy", title: "Daily summary", schedule: "Every day 08:15", status: "enabled", timezone: "system_local" })]);
    expect(readFileSync(join(dir, "main", "routines.cron"), "utf8")).toMatch(/^# Routines: one job per line, crontab format\.\n/);
    await c.kill();
    // A job every minute that last ran yesterday: due now.
    writeFileSync(join(dir, "main", "routines.cron"), "* * * * * Ping: say hi to the user\n");
    const bot = JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8"));
    bot.routineRuns = { "* * * * * Ping: say hi to the user": swiftNow(-86_400_000) };
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify(bot));
    const again = core(dir);
    const divider = await until(async () => (await again.chat()).messages.find((m: any) => m.role === "divider" && /^Ping · \d\d:\d\d$/.test(m.text)));
    expect(divider).toBeTruthy();
    const prompt = await until(() => claudeInputs(dir).find((text) => text.includes("Time for the routine")));
    expect(prompt).toContain(`(App: Time for the routine "Ping". say hi to the user)\n(App: Project list. To check progress, read the memory file and do not wake the manager; to hand off work, append a line to the end of the inbox file.)\n(No projects yet.)\n- Maintainer (plugin-library extensions and in-chat components only): memory file ${join(dir, "plugins", ".bot", "memory.md")}; inbox file ${join(dir, "plugins", ".bot", "inbox.md")}`);
    await sleep(600);
    expect((await again.chat()).messages.filter((m: any) => m.role === "divider" && m.text.startsWith("Ping"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).routineRuns["* * * * * Ping: say hi to the user"]).toBeGreaterThan(swiftNow(-60_000));
  });

  it("an app-owned schedule is claimed, dispatched once and marked fired; a claim nobody confirmed stays delivery_uncertain", async () => {
    const dir = tempDir("routines");
    const c = core(dir);
    const at = new Date(Date.now() + 1_500).toISOString().replace(/\.\d+Z$/, "Z");
    const made = await c.call({ type: "routines.change", botId: MAIN, operation: "create", kind: "once", at, timezone: "Asia/Taipei", task: "Check: look at the build", requestId: "check-1" });
    const routine = made.routines.find((r: any) => r.kind === "once");
    expect(routine).toMatchObject({ title: "Check", status: "pending", timezone: "Asia/Taipei" });
    await until(async () => (await c.chat()).messages.find((m: any) => m.role === "divider" && m.text.startsWith("Check · ")), { timeout: 8_000 });
    const updated = await until(() => c.of("routines.updated").map((e) => e.event as any).find((e) => e.routines.some((r: any) => r.id === routine.id && r.status === "fired")));
    expect(updated).toBeTruthy();
    const saved = JSON.parse(readFileSync(join(dir, "main", "scheduled-routines.json"), "utf8")).routines[0];
    expect(saved).toMatchObject({ id: routine.id, state: "fired", requestID: "check-1", kind: "once" });
    expect(saved.dispatchedAt).toBeGreaterThan(saved.createdAt);
    // The same request id again is the same schedule; resuming a fired one is refused.
    await expect(c.call({ type: "routines.change", botId: MAIN, operation: "resume", id: routine.id })).rejects.toThrow(/Only pending or paused/);
    await c.kill();
    // A claim written by a core that died before dispatching: never sent again.
    const file = join(dir, "main", "scheduled-routines.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.routines.push({ ...doc.routines[0], id: "claimed-1", requestID: "claimed-1", state: "claimed", at: swiftNow(-60_000), lastClaim: swiftNow(-60_000) });
    delete doc.routines[1].dispatchedAt;
    writeFileSync(file, JSON.stringify(doc));
    const again = core(dir);
    const list = await again.call({ type: "routines.list", botId: MAIN });
    expect(list.routines.find((r: any) => r.id === "claimed-1")).toMatchObject({ status: "delivery_uncertain", next: null });
    await sleep(500);
    expect((await again.chat()).messages.filter((m: any) => m.role === "divider" && m.text.startsWith("Check · "))).toHaveLength(1);
    await expect(again.call({ type: "routines.change", botId: MAIN, operation: "cancel", id: "claimed-1" })).rejects.toThrow(/already claimed/);
  });

  it("a broken schedule file is said in the chat and nothing is dispatched or written over", async () => {
    const dir = tempDir("routines");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "scheduled-routines.json"), "{oops");
    const c = core(dir);
    const notice = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "notice" && m.text.startsWith("Routines: Cannot read routine state")));
    expect(notice).toBeTruthy();
    expect((await c.call({ type: "routines.list", botId: MAIN })).error).toMatch(/Cannot read routine state/);
    await sleep(400);
    expect((await c.chat()).messages.filter((m: any) => m.role === "notice" && m.text.startsWith("Routines:"))).toHaveLength(1);
    expect(readFileSync(join(dir, "main", "scheduled-routines.json"), "utf8")).toBe("{oops");
  });

  it("Codex's app_routines changes the same schedules the app shows", async () => {
    const dir = tempDir("routines");
    codexOnly(dir);
    const c = core(dir);
    const args = { operation: "create", kind: "recurring", cron: "0 9 * * 1-5", timezone: "Asia/Taipei", task: "Standup: check the board", request_id: "standup" };
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: `/routine ${JSON.stringify(args)}` });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
    expect((finished.event as any).text).toMatch(/^Routines: \{\n  "id": "[0-9a-f-]{36}",\n  "kind": "recurring",/);
    const list = await c.call({ type: "routines.list", botId: MAIN });
    expect(list.routines.find((r: any) => r.kind === "recurring")).toMatchObject({ title: "Standup", schedule: "Weekdays 09:00", timezone: "Asia/Taipei", status: "pending", next: expect.any(String) });
    expect(c.of("routines.updated").length).toBeGreaterThan(0);
    const step = (await c.chat()).messages.findLast((m: any) => m.role === "bot").steps.find((s: any) => s.tool === "app_routines");
    expect(step).toMatchObject({ title: "Routines: create", done: true });
    // A bad request: the tool says why, nothing changes.
    await c.call({ type: "chat.send", botId: MAIN, text: `/routine ${JSON.stringify({ operation: "create", kind: "once", task: "x", request_id: "bad" })}` });
    const refused = await until(async () => (await c.chat()).messages.findLast((m: any) => m.role === "bot" && m.text.startsWith("Routines failed")));
    expect(refused.text).toContain("once requires at");
  });
});

describe("command monitors", () => {
  it("asks with an Allow once card that outlives the turn, runs the command, and wakes Codex once with its result", async () => {
    const dir = tempDir("monitor");
    codexOnly(dir);
    const c = core(dir);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/monitor echo monitored; exit 3" });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
    expect((finished.event as any).text).toBe("Watching it (awaitingApproval).");
    // The card stays after the turn ended: Codex finishes its turn without waiting.
    const card = await until(async () => (await c.chat()).messages.find((m: any) => m.approval?.tool === "Monitored command"));
    expect(card.choices.map((choice: any) => choice.label)).toEqual(["Allow once", "Don't allow"]);
    expect(card.text).toContain("echo monitored; exit 3");
    expect(card.text).toContain("Workspace sandbox; network disabled. Completion wakes this Codex bot once.");
    await sleep(300);
    expect((await c.chat()).messages.find((m: any) => m.id === card.id).answer).toBeNull();
    expect((await c.call({ type: "chat.snapshot", botId: MAIN })).bots[0].approvals).toBe(1);
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: card.id, index: 0 })).toEqual({ accepted: true });
    const woke = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "bot" && m.text.startsWith("Monitor failed")), { timeout: 10_000 });
    expect(woke.text).toBe("Monitor failed, exit 3: monitored");
    // It ran in the bot's folder, sandboxed, network off; the result went back as app_monitor_result.
    const exec = JSON.parse(codexLog(dir, "exec")[0].text);
    expect(exec).toMatchObject({ cwd: join(dir, "main"), sandboxPolicy: { type: "workspaceWrite", writableRoots: [join(dir, "main")], networkAccess: false }, outputBytesCap: 8192 });
    const result = JSON.parse(codexLog(dir, "monitor-result")[0].text);
    expect(result).toMatchObject({ status: "failed", exit_code: 3, stdout: "monitored\n", wake: "dispatching", output_bytes_cap_per_stream: 8192 });
    // Its step under the reply that started it is done, failed.
    const started = (await c.chat()).messages.find((m: any) => m.steps?.some((s: any) => s.tool === "Monitor"));
    expect(started.steps.find((s: any) => s.tool === "Monitor")).toMatchObject({ title: "Monitor echo monitored; exit 3", done: true, failed: true });
    // Saved in 1.x's file: delivered once.
    const file = readdirSync(join(dir, "codex-threads")).find((name) => name.endsWith(".monitors.json"))!;
    expect(JSON.parse(readFileSync(join(dir, "codex-threads", file), "utf8"))).toMatchObject([{ command: "echo monitored; exit 3", state: "failed", exitCode: 3, wake: "delivered" }]);
    await sleep(300);
    expect(codexLog(dir, "monitor-result")).toHaveLength(1);
  });

  it("Don't allow cancels it: nothing runs and nothing wakes", async () => {
    const dir = tempDir("monitor");
    codexOnly(dir);
    const c = core(dir);
    await c.call({ type: "chat.send", botId: MAIN, text: "/monitor touch should-not-exist" });
    const card = await until(async () => (await c.chat()).messages.find((m: any) => m.approval?.tool === "Monitored command"));
    await c.call({ type: "chat.choose", botId: MAIN, messageId: card.id, index: 1 });
    await sleep(500);
    expect(existsSync(join(dir, "main", "should-not-exist"))).toBe(false);
    expect(codexLog(dir, "exec")).toHaveLength(0);
    expect(codexLog(dir, "monitor-result")).toHaveLength(0);
    const file = readdirSync(join(dir, "codex-threads")).find((name) => name.endsWith(".monitors.json"))!;
    expect(JSON.parse(readFileSync(join(dir, "codex-threads", file), "utf8"))).toMatchObject([{ state: "cancelled", wake: "suppressed" }]);
  });
});
