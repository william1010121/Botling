// A bot's long-lived head, through the built core with the fake CLI in its long-lived mode:
// one process across turns, approvals (allow once, always, deny, no answer), Stop by interrupt,
// a crash (the bot sleeps, as in 1.x), sleeping when idle, and resuming the session after a core restart.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
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
    // 1.x's toolbox, Artifact included (switched on with CLAUDE_CODE_ARTIFACT, as `launchEnvironment` does).
    expect(log[0]!.args.join(" ")).toMatch(/--allowedTools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent,Task,SendMessage,Artifact(?!,Bash)/);
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

  it("a head that crashes fails its turn and the bot sleeps; the next message wakes a new session (1.x)", async () => {
    const dir = tempDir("head");
    const c = core(dir);
    expect((await turn(c, "first")).event.status).toBe("done");
    const { event } = await turn(c, "/crash");
    expect(event).toMatchObject({ status: "failed" });
    expect(event.text).toBe("partial");
    expect(c.stderr).toMatch(/exited \(3\) unexpectedly/);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(starts(dir)).toHaveLength(1); // Not started again by itself.
    const next = (await turn(c, "/resume")).event.text;
    expect(next).toMatch(/resumed=false/);
    expect(starts(dir)).toHaveLength(2);
    expect(starts(dir)[1]!.session).not.toBe(starts(dir)[0]!.session);
  });

  it("plugins' Claude parts that change restart an awake head in its session before its next message (1.x)", async () => {
    const dir = tempDir("head");
    const c = core(dir, { BOTLING_COMPONENT_SCAN_MS: "100" });
    expect((await turn(c, "first")).event.status).toBe("done");
    const folder = join(dir, "plugins", "skills-pack");
    mkdirSync(join(folder, "claude", "skills"), { recursive: true });
    mkdirSync(join(folder, "claude", ".claude-plugin"), { recursive: true });
    writeFileSync(join(folder, "claude", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "skills-pack", version: "1.0.0" }));
    writeFileSync(join(folder, "claude", "skills", "a.md"), "a skill");
    // package.json last: it is what makes the folder a plugin, so a 100 ms scan never sees a half-written one.
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "skills-pack", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { claude: "claude" } }));
    await until(async () => (await c.call({ type: "plugins.list" })).plugins.some((p: { name: string }) => p.name === "skills-pack"), { what: "the plugin" });
    expect(starts(dir)).toHaveLength(1); // An idle bot is not restarted until it has something to do.
    expect((await turn(c, "second")).event.status).toBe("done");
    expect(starts(dir)).toHaveLength(2);
    expect(starts(dir)[1]).toMatchObject({ resume: true, session: starts(dir)[0]!.session });
    expect(starts(dir)[1]!.args.join(" ")).toContain(`--plugin-dir ${join(folder, "claude")}`);
    expect((await c.chat()).messages.map((m: { text: string }) => m.text)).toContain("Restarted → loading new plugins");
    // Nothing changed since: no more restarts.
    expect((await turn(c, "third")).event.status).toBe("done");
    expect(starts(dir)).toHaveLength(2);
  });

  it("a turn that shows no new step for the reminder's time gets one reminder in its chat (1.x's checkStall)", async () => {
    const dir = tempDir("head");
    const c = core(dir, { BOTLING_WATCH_MS: "100", BOTLING_STALL_MINUTE_MS: "400", FAKE_CLAUDE_LINGER_MS: "1500" });
    await c.call({ type: "settings.set", change: { key: "stallReminderMinutes", value: 1 } });
    expect((await turn(c, "/linger quiet")).event.status).toBe("done");
    const notices = (await c.chat()).messages.filter((m: { role: string; text: string }) => m.role === "notice" && m.text.includes("分鐘")).map((m: { text: string }) => m.text);
    expect(notices).toEqual(["Main bot 已經 1 分鐘沒有新的步驟了。\n可能卡住了：可以再等等，或傳訊息問它在做什麼。"]);
    // Never: no reminder.
    await c.call({ type: "settings.set", change: { key: "stallReminderMinutes", value: 0 } });
    expect((await turn(c, "/linger again")).event.status).toBe("done");
    expect((await c.chat()).messages.filter((m: { role: string; text: string }) => m.role === "notice" && m.text.includes("分鐘"))).toHaveLength(1);
  });

  it("a turn cut off by the network waits for it (no sleep), then carries on in the same session (1.x's NetworkResume)", async () => {
    const dir = tempDir("head");
    let online = false;
    const probe = createServer((request, response) => { if (online) response.end("ok"); else request.socket.destroy(); });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    try {
      const port = (probe.address() as { port: number }).port;
      const c = core(dir, { BOTLING_WATCH_MS: "100", BOTLING_IDLE_MS: "300", BOTLING_NETWORK_PROBE_URL: `http://127.0.0.1:${port}/`, FAKE_CLAUDE_INPUT: join(dir, "input.log") });
      const { event, messageId } = await turn(c, "/netloss");
      expect(event.status).toBe("failed");
      const line = (await c.chat()).messages.find((m: { id: string }) => m.id === messageId);
      expect(line.text).toBe("網路中斷：連不上 Claude（API Error: Connection error.）。網路恢復後會自動接著做。");
      await sleep(800);
      expect(alive(starts(dir)[0]!.pid)).toBe(true); // It did not go to sleep.
      expect(c.stderr).not.toMatch(/tidying/);
      online = true;
      await until(async () => (await c.chat()).messages.some((m: { role: string; text: string }) => m.role === "divider" && m.text === "網路恢復 · 中斷約 1 分鐘 · 接著原本的工作"), { what: "the network back" });
      await until(() => readFileSync(join(dir, "input.log"), "utf8").includes("is back now."), { what: "the resume note" });
      const told = JSON.parse(readFileSync(join(dir, "input.log"), "utf8").trim().split("\n").at(-1)!).text as string;
      expect(told).toBe("(App: 網路中斷: the network connection was lost about 1 minute ago and is back now.)\nCarry on with what you were doing when it dropped, from where you left off; do not start over or redo finished steps.");
      expect(starts(dir)).toHaveLength(1);
    } finally {
      probe.close();
    }
  });

  it("an idle head tidies its notes, then sleeps; the next message wakes a new session, briefed", async () => {
    const dir = tempDir("head");
    const c = core(dir, { BOTLING_IDLE_MS: "300", FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    await turn(c, "hello");
    const pid = starts(dir)[0]!.pid;
    await until(() => c.events.some((e) => e.event.type === "bot.updated" && (e.event as any).bot.phase === "tidying"), { what: "the tidy" });
    await until(() => !alive(pid), { what: "the head to sleep" });
    const asleep = (await c.call({ type: "chat.snapshot" })).bots[0];
    expect(asleep).toMatchObject({ phase: "asleep", working: false });
    expect(c.stderr).not.toMatch(/unexpectedly/);
    // The tidy went to claude (and wrote the memory file it names), and nothing of it shows in the chat.
    const inputs = readFileSync(join(dir, "input.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(inputs.at(-1).text).toBe("(App: You have been idle for a while and are about to fall asleep. Update memory.md with whatever in this conversation is worth remembering, keeping the four-section format and under 150 lines. Reply only OK when done.)");
    expect(readFileSync(join(dir, "main", "memory.md"), "utf8")).toMatch(/Tidied by the fake CLI/);
    expect((await c.chat()).messages.map((m: { text: string }) => m.text)).not.toContain("OK");
    // Waking: a new session, whose first message is the wake briefing, the last lines, then the words.
    const { event } = await turn(c, "/resume");
    expect(event.text).toMatch(/resumed=false/);
    expect(starts(dir)[1]!.session).not.toBe(starts(dir)[0]!.session);
    const woke = JSON.parse(readFileSync(join(dir, "input.log"), "utf8").trim().split("\n").at(-1)!).text as string;
    // The main bot's wake note (its project list) follows the wake line, as in 1.x.
    expect(woke.startsWith("(App: You were just woken up. Read memory.md before answering; if the file does not exist, treat this as our first meeting.)\n\n(App: Project list. To check progress, read the memory file and do not wake the manager; to hand off work, append a line to the end of the inbox file.)\n(No projects yet.)\n- Maintainer (")).toBe(true);
    // The project list, then the chat.
    expect(woke).toContain(".bot/inbox.md\n(App: Temporary teams you can start, with <team name=\"name\">task</team>.)\n- prototype (Prototype team): Builds a small working prototype or tool in its own folder, hands back a preview page.\n- research (Research team): Looks things up, compares options, hands back a one-page report.");
    // …then its components (the app's own preview card, as 1.x gives every bot the built-ins), then the chat.
    expect(woke).toContain("hands back a one-page report.\n\n(App: Components in the chat: 1 / 20 yours,");
    expect(woke).toContain("不需要使用者回答，不會呼叫 `ccb.answer`。\n\n(App: The last messages in this chat, oldest first.");
    expect(woke).toMatch(/\] User: hello\n\[[^\]]+\] You: You said: hello/);
    expect(woke).toMatch(/\(App: message_id of this message: [0-9A-F-]{36}\)\n\n\/resume$/);
  });

  it("after a core restart the chat is there and the bot wakes a new session briefed from the chat", async () => {
    const dir = tempDir("head");
    const first = core(dir, { FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    await turn(first, "remember me");
    await first.kill("SIGTERM");
    const session = starts(dir)[0]!.session;
    // Quitting tidied first (1.x): the tidy is the last thing the first head read.
    expect(readFileSync(join(dir, "input.log"), "utf8")).toMatch(/You have been idle for a while/);

    const second = core(dir, { FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    const chat = await second.chat();
    expect(chat.messages.map((m: { text: string }) => m.text).slice(-2)).toEqual(["remember me", "You said: remember me"]);
    const { event } = await turn(second, "/resume");
    expect(event.text).toMatch(/resumed=false/);
    expect(event.text).not.toContain(session);
    const woke = JSON.parse(readFileSync(join(dir, "input.log"), "utf8").trim().split("\n").at(-1)!).text as string;
    expect(woke).toMatch(/User: remember me/);
  });

  it("a resume claude no longer has falls back to a new session, briefed, and the message goes once", async () => {
    const dir = tempDir("head");
    const c = core(dir, { FAKE_CLAUDE_FORGET: "1" });
    expect((await turn(c, "first")).event.status).toBe("done");
    // A crash: the bot sleeps; the next message gets a new session.
    expect((await turn(c, "/crash")).event.status).toBe("failed");
    const { event } = await turn(c, "/resume");
    expect(event.text).toMatch(/resumed=false/);
    const chat = await c.chat();
    expect(chat.messages.filter((m: { role: string }) => m.role === "divider").length).toBeLessThanOrEqual(1);
    expect(chat.messages.filter((m: { text: string }) => m.text === "/resume")).toHaveLength(1);
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
