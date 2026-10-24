// A bot's long-lived head, through the built core with the fake CLI in its long-lived mode:
// one process across turns, approvals (allow once, always, deny, no answer), Stop by interrupt,
// a crash and its restart, sleeping when idle, and resuming the session after a core restart.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alive, sleep, tempDir, until } from "../helpers";
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

async function turn(c: CoreHarness, text: string) {
  const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text });
  const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `the end of "${text}"` });
  return { turnId, messageId, event: finished.event as { status: string; text: string } };
}

/** Waits for the approval card the turn asks with, and returns its message. */
async function approval(c: CoreHarness) {
  const added = await until(() => c.of("message.added").map((e) => (e.event as { message: any }).message).find((m) => m.approval && m.chosen === null && m.answer === null), { what: "an approval" });
  return added;
}

describe("a bot's head", () => {
  it("is one process across turns, run in the bot's folder with the session started then resumed", async () => {
    const dir = tempDir("head");
    const c = core(dir);
    expect((await turn(c, "one")).event).toMatchObject({ status: "done", text: "You said: one" });
    expect((await turn(c, "two")).event).toMatchObject({ status: "done", text: "You said: two" });
    const log = starts(dir);
    expect(log).toHaveLength(1);
    expect(log[0]!.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--session-id"]));
    expect(log[0]!.args.join(" ")).toMatch(/--allowedTools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent,Task,SendMessage(?!,Bash)/);
    expect(log[0]!.cwd).toBe(join(dir, "main"));
    const head = JSON.parse(readFileSync(join(dir, "main", "head.json"), "utf8"));
    expect(head).toEqual({ sessionId: log[0]!.session, started: true });
    expect(alive(log[0]!.pid)).toBe(true);
  });

  it("asks before a tool: Allow once runs it, and the reply has the step", async () => {
    const c = core(tempDir("head"));
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/tool echo hi" });
    const question = await approval(c);
    expect(question.text).toBe("Wants to use `Bash`:\n\n~~~\necho hi\n~~~");
    // Bash is never "always": only once or not.
    expect(question.choices.map((choice: { action: string }) => choice.action)).toEqual(["allowOnce", "deny"]);
    expect((await c.call({ type: "chat.snapshot" })).bots[0].approvals).toBe(1);
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 0 })).toEqual({ accepted: true });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
    expect(finished.event).toMatchObject({ status: "done", text: "Let me run that. \n\nAllowed: ran echo hi" });
    const chat = await c.chat();
    expect(chat.messages.find((m: { id: string }) => m.id === question.id)).toMatchObject({ chosen: 0, answer: null });
    const reply = chat.messages.find((m: { turnId?: string }) => m.turnId === turnId);
    expect(reply.steps).toEqual([expect.objectContaining({ tool: "Bash", title: "Run echo hi", done: true, failed: false, output: "ran: echo hi" })]);
    // Picking again does nothing.
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 1 })).toEqual({ accepted: false });
  });

  it("Don't allow refuses it; claude hears why", async () => {
    const c = core(tempDir("head"));
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/tool rm -rf build" });
    const question = await approval(c);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 1 });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
    expect(finished.event).toMatchObject({ status: "done", text: "Let me run that. \n\nDenied: The user did not allow it." });
    const reply = (await c.chat()).messages.find((m: { turnId?: string }) => m.turnId === turnId);
    expect(reply.steps[0]).toMatchObject({ failed: true, done: true });
  });

  it("no answer in time counts as no", async () => {
    const c = core(tempDir("head"), { BOTLING_APPROVAL_TIMEOUT_MS: "400" });
    const { event } = await turn(c, "/tool echo late");
    expect(event.text).toMatch(/Denied: The user did not answer in time/);
    const question = (await c.chat()).messages.find((m: { approval?: unknown }) => m.approval);
    expect(question).toMatchObject({ answer: "No answer in time", chosen: null });
    expect((await c.call({ type: "chat.snapshot" })).bots[0].approvals).toBe(0);
  });

  it("Always allow is kept in bot.json (as 1.x keeps it) and the next ask is answered by itself", async () => {
    const dir = tempDir("head");
    const c = core(dir);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/tool:WebFetch https://example.com" });
    const question = await approval(c);
    expect(question.choices.map((choice: { action: string }) => choice.action)).toEqual(["allowOnce", "alwaysAllow", "deny"]);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 1 });
    await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).alwaysAllowed).toEqual(["WebFetch"]);
    const before = c.of("message.added").length;
    const { event } = await turn(c, "/tool:WebFetch https://example.org");
    expect(event.text).toMatch(/Allowed: ran https:\/\/example.org/);
    expect(c.of("message.added").slice(before).some((e) => (e.event as { message: { approval?: unknown } }).message.approval)).toBe(false);
  });

  it("Stop interrupts the turn; the head lives on for the next message and the tool it ran is ended", async () => {
    const dir = tempDir("head");
    const pidsFile = join(dir, "pids");
    const c = core(dir, { FAKE_CLAUDE_PIDS: pidsFile });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    await until(() => c.of("turn.delta").length >= 3);
    const [head, helper] = await until(() => { const pids = readFileSync(pidsFile, "utf8").trim().split("\n").map(Number); return pids.length >= 2 ? pids : null; });
    const stopped = await c.call({ type: "turn.stop", botId: MAIN, turnId });
    expect(stopped).toEqual({ stopped: true, killed: [], forced: false });
    expect(c.of("turn.finished").at(-1)!.event).toMatchObject({ status: "stopped" });
    await until(() => !alive(helper!), { what: "the turn's tool ended" });
    expect(alive(head!)).toBe(true);
    expect((await turn(c, "after")).event).toMatchObject({ status: "done", text: "You said: after" });
    expect(starts(dir)).toHaveLength(1);
    const reply = (await c.chat()).messages.find((m: { turnId?: string }) => m.turnId === turnId);
    expect(reply).toMatchObject({ state: "stopped", interrupted: true });
  });

  it("a head that crashes fails its turn and is started again, resuming the session", async () => {
    const dir = tempDir("head");
    const c = core(dir);
    expect((await turn(c, "first")).event.status).toBe("done");
    const { event } = await turn(c, "/crash");
    expect(event).toMatchObject({ status: "failed" });
    expect(event.text).toBe("partial ");
    await until(() => starts(dir).length === 2, { what: "the restart" });
    expect(starts(dir)[1]).toMatchObject({ resume: true, session: starts(dir)[0]!.session });
    expect(c.stderr).toMatch(/exited \(3\) unexpectedly/);
    expect((await turn(c, "/resume")).event.text).toBe(`session ${starts(dir)[0]!.session} resumed=true`);
    expect(starts(dir)).toHaveLength(2); // The message went to the restarted head.
  });

  it("an idle head goes to sleep; the next message wakes it with the same session", async () => {
    const dir = tempDir("head");
    const c = core(dir, { BOTLING_IDLE_MS: "300" });
    await turn(c, "hello");
    const pid = starts(dir)[0]!.pid;
    await until(() => !alive(pid), { what: "the head to sleep" });
    const asleep = (await c.call({ type: "chat.snapshot" })).bots[0];
    expect(asleep).toMatchObject({ phase: "asleep", working: false });
    expect(c.stderr).not.toMatch(/unexpectedly/);
    expect((await turn(c, "/resume")).event.text).toBe(`session ${starts(dir)[0]!.session} resumed=true`);
  });

  it("after a core restart the chat is there and the head resumes its session; a lost session starts anew", async () => {
    const dir = tempDir("head");
    const first = core(dir);
    await turn(first, "remember me");
    await first.kill("SIGTERM");
    const session = starts(dir)[0]!.session;

    const second = core(dir);
    const chat = await second.chat();
    expect(chat.messages.map((m: { text: string }) => m.text).slice(-2)).toEqual(["remember me", "You said: remember me"]);
    expect((await turn(second, "/resume")).event.text).toBe(`session ${session} resumed=true`);
    await second.kill("SIGTERM");

    // claude no longer has the session (FAKE_CLAUDE_FORGET): the message goes to a new one, once.
    const third = core(dir, { FAKE_CLAUDE_FORGET: "1" });
    const { event } = await turn(third, "/resume");
    expect(event.text).toMatch(/resumed=false/);
    expect(event.text).not.toContain(session);
    expect(third.stderr).toMatch(/resuming session .* failed/);
    expect(JSON.parse(readFileSync(join(dir, "main", "head.json"), "utf8")).sessionId).not.toBe(session);
  });

  it("an approval left open when the core quits is closed, never answered later", async () => {
    const dir = tempDir("head");
    const first = core(dir, { BOTLING_APPROVAL_TIMEOUT_MS: "60000" });
    await first.call({ type: "chat.send", botId: MAIN, text: "/tool echo later" });
    const question = await approval(first);
    await first.kill("SIGKILL");
    await sleep(100);
    const second = core(dir);
    const chat = await second.chat();
    expect(chat.messages.find((m: { id: string }) => m.id === question.id)).toMatchObject({ answer: "No longer needed" });
    expect(await second.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 0 })).toEqual({ accepted: false });
  });
});
