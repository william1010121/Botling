// A core hot swap through the built core with the fake CLI (docs/core-hot-swap.md): the old core drains
// (turns under way finish; late ones are stopped and told to carry on), hands its sessions over, and the
// next core resumes them with --resume; what waited is delivered there. No Electron, no windows.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { CONTINUE_NOTE, SWAP_FILE } from "../../src/core/hot-swap";

const harnesses: CoreHarness[] = [];
const core = (dir: string, env: Record<string, string> = {}) => {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "starts.log"), FAKE_CLAUDE_INPUT: join(dir, "input.log"), BOTLING_ROUTINE_TICK_MS: "0", ...env });
  harnesses.push(harness);
  return harness;
};
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const starts = (dir: string) => lines(join(dir, "starts.log")) as { pid: number; resume: boolean; session: string }[];
const inputs = (dir: string) => lines(join(dir, "input.log")) as { session: string; text: string }[];

let drains = 100;
/** Drains the core as main does (`{botling: "drain"}`) and waits for its answer. */
async function drain(c: CoreHarness, timeoutMs: number, boundaryMs = 1_000) {
  const id = ++drains;
  c.post({ botling: "drain", id, timeoutMs, boundaryMs });
  const answer = await until(() => c.responses.get(id as unknown as string), { timeout: timeoutMs + boundaryMs + 10_000, what: "the drain's answer" });
  return answer as unknown as { ok: boolean; entries: number; interrupted: string[]; error?: string };
}

const finished = (c: CoreHarness, turnId: string) =>
  until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `turn ${turnId}` }).then((e) => e.event as { status: string; text: string });

async function turn(c: CoreHarness, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  return finished(c, turnId);
}

describe("core hot swap", () => {
  it("hands an idle bot's session over without the tidy; the next core resumes it (--resume, same session)", async () => {
    const dir = tempDir("swap-idle");
    const a = core(dir);
    expect(await turn(a, "one")).toMatchObject({ status: "done", text: "You said: one" });
    const answer = await drain(a, 5_000);
    expect(answer).toMatchObject({ ok: true, entries: 1, interrupted: [] });
    const handover = JSON.parse(readFileSync(join(dir, SWAP_FILE), "utf8"));
    expect(handover.entries).toEqual([{ botId: MAIN, engine: "claude", sessionId: starts(dir)[0]!.session, continue: false, queued: [] }]);
    expect(a.of("core.swap").map((e) => (e.event as { phase: string }).phase)).toEqual(["draining", "updating"]);
    await a.kill("SIGTERM");
    // Quitting after a drain does not tidy (that would end the session): nothing but "one" was sent.
    expect(inputs(dir).map((input) => input.text).join("\n")).not.toMatch(/You have been idle/);

    const b = core(dir);
    const reply = await turn(b, "/resume");
    expect(reply.text).toBe(`session ${starts(dir)[0]!.session} resumed=true`);
    expect(starts(dir)).toHaveLength(2);
    expect(starts(dir)[1]).toMatchObject({ resume: true, session: starts(dir)[0]!.session });
    // The same conversation: no wake briefing with it.
    expect(inputs(dir).at(-1)!.text).not.toMatch(/memory\.md/);
    expect(existsSync(join(dir, SWAP_FILE))).toBe(false);
  });

  it("waits for a reply under way to finish before handing over", async () => {
    const dir = tempDir("swap-wait");
    const a = core(dir, { FAKE_CLAUDE_LINGER_MS: "800" });
    const { turnId } = await a.call({ type: "chat.send", botId: MAIN, text: "/linger slowly" });
    await until(() => a.of("turn.started").length > 0, { what: "the turn's start" });
    const answer = await drain(a, 10_000);
    expect(answer).toMatchObject({ ok: true, interrupted: [] });
    const done = await finished(a, turnId);
    expect(done.status).toBe("done");
    expect(done.text).toMatch(/You said: slowly$/);
    const handover = JSON.parse(readFileSync(join(dir, SWAP_FILE), "utf8"));
    expect(handover.entries[0]).toMatchObject({ continue: false });
  });

  it("stops a turn that does not finish in time, and the next core resumes it and tells it to carry on", async () => {
    const dir = tempDir("swap-late");
    const a = core(dir);
    expect((await turn(a, "first")).status).toBe("done");
    const { turnId } = await a.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    await until(() => a.of("turn.delta").some((e) => (e.event as { turnId: string }).turnId === turnId), { what: "the slow turn's words" });
    const answer = await drain(a, 300, 300);
    expect(answer).toMatchObject({ ok: true, interrupted: [MAIN] });
    expect(await finished(a, turnId)).toMatchObject({ status: "stopped" });
    const session = starts(dir)[0]!.session;
    expect(JSON.parse(readFileSync(join(dir, SWAP_FILE), "utf8")).entries).toEqual([{ botId: MAIN, engine: "claude", sessionId: session, continue: true, queued: [] }]);
    await a.kill("SIGTERM");

    const b = core(dir);
    // Nobody writes: the new core carries on by itself, in the same session.
    const told = await until(() => inputs(dir).find((input) => input.text.includes(CONTINUE_NOTE)), { what: "the carry-on note" });
    expect(told.session).toBe(session);
    expect(starts(dir).at(-1)).toMatchObject({ resume: true, session });
    await until(() => b.of("turn.finished").length > 0, { what: "the carried-on turn" });
  });

  it("keeps what arrives while draining and delivers it after the swap", async () => {
    const dir = tempDir("swap-queue");
    const a = core(dir, { FAKE_CLAUDE_LINGER_MS: "800" });
    await a.call({ type: "chat.send", botId: MAIN, text: "/linger first" });
    await until(() => a.of("turn.started").length > 0, { what: "the turn's start" });
    const answer = drain(a, 10_000);
    await until(() => a.of("core.swap").length > 0, { what: "draining" });
    // A message that reaches the core while it drains (main holds the renderers' own; this one came from inside).
    const { turnId: waiting } = await a.call({ type: "chat.send", botId: MAIN, text: "zebra-later" });
    expect(await answer).toMatchObject({ ok: true });
    expect(inputs(dir).map((input) => input.text).join("\n")).not.toMatch(/zebra-later/);
    const entry = JSON.parse(readFileSync(join(dir, SWAP_FILE), "utf8")).entries[0];
    expect(entry.queued).toEqual([expect.objectContaining({ words: "zebra-later", origin: "user" })]);
    void waiting;
    await a.kill("SIGTERM");

    const b = core(dir);
    const delivered = await until(() => b.of("turn.finished").find((e) => (e.event as { text: string }).text === "You said: zebra-later"), { what: "the waiting message's reply" });
    expect(delivered).toBeTruthy();
    expect(starts(dir).at(-1)).toMatchObject({ resume: true, session: starts(dir)[0]!.session });
  });

  it("a Codex head resumes its thread (thread/resume) after the swap", async () => {
    const dir = tempDir("swap-codex");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main/bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
    const env = { FAKE_CODEX_INPUT: join(dir, "codex.log") };
    const a = core(dir, env);
    expect((await turn(a, "one")).status).toBe("done");
    const started = await until(() => lines(join(dir, "codex.log")).find((line) => line.kind === "coordinator-start"), { what: "the coordinator thread" });
    expect(await drain(a, 5_000)).toMatchObject({ ok: true, entries: 1 });
    const entry = JSON.parse(readFileSync(join(dir, SWAP_FILE), "utf8")).entries[0];
    expect(entry).toMatchObject({ engine: "codex", continue: false });
    await a.kill("SIGTERM");

    const b = core(dir, env);
    expect((await turn(b, "two")).status).toBe("done");
    const resumed = lines(join(dir, "codex.log")).filter((line) => line.kind === "resume");
    expect(resumed.map((line) => line.thread)).toContain(started.thread);
  });

  it("a swap called off leaves the core as it was", async () => {
    const dir = tempDir("swap-off");
    const a = core(dir);
    expect((await turn(a, "one")).status).toBe("done");
    expect(await drain(a, 2_000)).toMatchObject({ ok: true });
    a.post({ botling: "undrain" });
    await until(() => a.of("core.swap").some((e) => (e.event as { phase: unknown }).phase === null), { what: "the swap called off" });
    expect(existsSync(join(dir, SWAP_FILE))).toBe(false);
    expect(await turn(a, "two")).toMatchObject({ status: "done", text: "You said: two" });
    expect(starts(dir)).toHaveLength(1);
  });
});
