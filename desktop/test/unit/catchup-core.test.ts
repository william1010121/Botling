// Catch-up summaries through the built core, with the fake Codex CLI's `exec`: unread replies fold
// into a summary on your return (once per range, cached across restarts), a failure says why and
// can be retried, and intervals between your messages are summarized by themselves when that is on.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CODEX_EXEC_LOG: join(dir, "exec.log"), BOTLING_ROUTINE_TICK_MS: "0", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const execs = (dir: string): { args: string[] }[] => (existsSync(join(dir, "exec.log")) ? readFileSync(join(dir, "exec.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
async function reply(c: CoreHarness, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
}
const settings = (dir: string, value: Record<string, unknown>) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "settings.json"), JSON.stringify(value)); };

describe("Catch-up", () => {
  it("folds more than 3 unread replies into a summary on your return, citing them; the same range is not summarized twice", async () => {
    const dir = tempDir("catchup");
    const c = core(dir);
    for (const text of ["one", "two", "three", "four"]) await reply(c, text);
    expect((await c.call({ type: "chat.snapshot", botId: MAIN })).bots[0].unread).toBeGreaterThanOrEqual(4);
    await c.call({ type: "chat.read", botId: MAIN });
    const ready = await until(async () => { const chat = await c.chat(); return chat.catchUp?.state === "ready" && chat.catchUp; });
    const replies = (await c.chat()).messages.filter((m: any) => m.role === "bot").map((m: any) => m.id);
    expect(ready.count).toBe(4);
    expect(ready.ids).toEqual(expect.arrayContaining(replies.slice(-4)));
    expect(ready.ids[0]).toBe(replies.at(-4));
    expect(ready.bullets.length).toBeGreaterThan(0);
    expect(ready.bullets[0]).toMatch(/\[\[source:[0-9A-F-]{36}\]\]$/);
    expect(ready).toMatchObject({ manual: false, model: "gpt-6-luna", requestedBy: null, latest: "Claude: You said: four" });
    expect(c.of("catchup.updated").map((e) => (e.event as any).catchUp?.state)).toEqual(expect.arrayContaining(["loading", "ready"]));
    // The isolated, read-only call 1.x makes.
    const [call] = execs(dir);
    expect(call!.args.slice(0, 6)).toEqual(["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check"]);
    expect(call!.args).toEqual(expect.arrayContaining(["--model", "gpt-6-luna", "--json", "shell_tool", "plugins", `model_reasoning_effort="medium"`]));
    expect(call!.args.at(-1)).toMatch(/^Summarize these messages\. Do not use any tools\.\nSummary writing preferences \(JSON string\):\n"Write short bullets/);
    expect(JSON.parse(readFileSync(join(dir, "catchup-summaries.json"), "utf8"))[ready.key]).toMatchObject({ bullets: ready.bullets, model: "gpt-6-luna" });
    // After a restart the cached summary shows at once; no second call.
    await c.kill();
    const again = core(dir);
    const bot = JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8"));
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ ...bot, unread: 4 }));
    await again.call({ type: "chat.read", botId: MAIN });
    const cached = (await again.chat()).catchUp;
    expect(cached).toMatchObject({ key: ready.key, state: "ready", bullets: ready.bullets });
    expect(execs(dir)).toHaveLength(1);
  });

  it("at or below the threshold, or turned off, nothing folds", async () => {
    const dir = tempDir("catchup");
    const c = core(dir);
    for (const text of ["one", "two", "three"]) await reply(c, text);
    await c.call({ type: "chat.read", botId: MAIN });
    expect((await c.chat()).catchUp).toBeNull();
    await c.kill();
    settings(dir, { catchUpEnabledChoice: false });
    const off = core(dir);
    for (const text of ["four", "five", "six", "seven"]) await reply(off, text);
    await off.call({ type: "chat.read", botId: MAIN });
    expect((await off.chat()).catchUp).toBeNull();
    expect(execs(dir)).toHaveLength(0);
  });

  it("a failed summary says why; Retry runs it again", async () => {
    const dir = tempDir("catchup");
    const c = core(dir, { FAKE_CODEX_EXEC_FAIL: "1" });
    for (const text of ["one", "two", "three", "four"]) await reply(c, text);
    await c.call({ type: "chat.read", botId: MAIN });
    const failed = await until(async () => { const chat = await c.chat(); return chat.catchUp?.state === "failed" && chat.catchUp; });
    expect(failed.error).toBe("The model call failed; check your Codex login and model access.");
    expect(await c.call({ type: "catchup.retry", botId: MAIN })).toEqual({ started: true });
    await until(async () => (await c.chat()).catchUp?.requestedBy === "user" && (await c.chat()).catchUp?.state === "failed");
    expect(execs(dir)).toHaveLength(2);
    expect(await c.call({ type: "catchup.retry", botId: MAIN, key: "nope" })).toEqual({ started: false });
  });

  it("summarizes an interval by itself when that is on, and any interval from the footer's button", async () => {
    const dir = tempDir("catchup");
    settings(dir, { intervalSummaryEnabledChoice: true, intervalSummaryThresholdChoice: 1 });
    const c = core(dir);
    await reply(c, "first");
    await reply(c, "second");
    const first = (await c.chat()).messages.find((m: any) => m.role === "user" && m.text === "first");
    const interval = await until(async () => { const chat = await c.chat(); return chat.intervalSummaries[0]?.state === "ready" && chat.intervalSummaries[0]; });
    expect(interval).toMatchObject({ automatic: true, manual: true, count: 1, speakerCounts: { claude: 1 } });
    expect(interval.ids).toHaveLength(1);
    expect((await c.chat()).messages.find((m: any) => m.id === interval.ids[0]).text).toBe("You said: first");
    // The footer's button for the same range: already there, no new call.
    expect(await c.call({ type: "catchup.interval", botId: MAIN, userMessageId: first.id })).toEqual({ started: true });
    expect(execs(dir)).toHaveLength(1);
    const second = (await c.chat()).messages.find((m: any) => m.role === "user" && m.text === "second");
    expect(await c.call({ type: "catchup.interval", botId: MAIN, userMessageId: second.id })).toEqual({ started: true });
    await until(async () => (await c.chat()).intervalSummaries.length === 2 && (await c.chat()).intervalSummaries.every((s: any) => s.state === "ready"));
    expect((await c.chat()).intervalSummaries[1]).toMatchObject({ automatic: false, requestedBy: "user" });
  });
});
