// Codex heads and two-head bots through the built core with the fake claude and the fake Codex
// app-server: a Codex reply, its approvals, an app-managed worker and its report, Stop, the tidy;
// then Claude and Codex in one chat — who reads a message first and what the other hears
// (claim, hold, release on words or on the wait), <no-reply/> from the head with nothing to add,
// a message for one head, hand-offs and their budget card, a shared decision answered once.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), FAKE_CODEX_INPUT: join(dir, "codex-input.log"), FAKE_CODEX_LOG: join(dir, "codex-start.log"), ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const claudeInputs = (dir: string): string[] => lines(join(dir, "claude-input.log")).filter((entry) => !entry.midTurn).map((entry) => entry.text);
const codexInputs = (dir: string, kind = "turn"): string[] => lines(join(dir, "codex-input.log")).filter((entry) => entry.kind === kind).map((entry) => entry.text);

/** A main bot whose head is Codex (bot.json as 1.x writes it). */
function codexOnly(dir: string) {
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
}

const finishedFor = (c: CoreHarness, turnId: string) => until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `turn ${turnId} to end` });
async function turn(c: CoreHarness, text: string, extra: Record<string, unknown> = {}) {
  const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text, ...extra });
  const finished = await finishedFor(c, turnId);
  return { turnId, messageId, event: finished.event as { status: string; text: string } };
}
const bots = async (c: CoreHarness) => (await c.call({ type: "chat.snapshot", botId: MAIN })).bots;
const lastBy = async (c: CoreHarness, engine: string) => (await c.chat()).messages.findLast((m: any) => m.role === "bot" && m.engine === engine);

describe("a Codex head", () => {
  it("answers through codex app-server, with the app's own thread settings and the coordinator's tools", async () => {
    const dir = tempDir("codex");
    codexOnly(dir);
    const c = core(dir);
    const { event, messageId } = await turn(c, "hello");
    expect(event).toMatchObject({ status: "done", text: "Codex says: hello" });
    const chat = await c.chat();
    expect(chat.messages.find((m: any) => m.id === messageId)).toMatchObject({ engine: "codex", text: "Codex says: hello" });
    expect(chat.heads).toBeNull();
    expect((await bots(c))[0]).toMatchObject({ heads: ["codex"], phase: "awake" });
    // The coordinator: workspace-write, asks first, no shell or native subagents, the app's tools.
    const start = JSON.parse(lines(join(dir, "codex-input.log")).find((entry) => entry.kind === "coordinator-start").text);
    expect(start).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request", config: { "features.multi_agent": false, "agents.enabled": false, "features.shell_tool": false, web_search: "disabled",
        // Its other folders are writable roots, as in 1.x: the main bot's are every bot's notes (here Maintainer's).
        sandbox_workspace_write: { writable_roots: [join(dir, "plugins", ".bot")] } },
      tools: ["app_routines", "app_monitor_start", "app_monitor_status", "app_monitor_cancel", "app_handoff", "app_send_message", "app_task_checkpoint"] });
    // Its first message is the Codex wake briefing: the memory snapshot inlined, then the words.
    const first = codexInputs(dir)[0]!;
    expect(first).toMatch(/^\(App: You were just woken up\. The app supplies your saved memory snapshot below as context\./);
    expect(first).toContain("(No saved memory.)");
    expect(first.endsWith("hello")).toBe(true);
    // Which thread the session is (1.x's codex-threads layout).
    const sessions = readFileSync(join(dir, "main", "chat.json"), "utf8");
    expect(JSON.parse(sessions).find((m: any) => m.id === messageId).engine).toBe("codex");
    expect(existsSync(join(dir, "codex-threads"))).toBe(true);
  });

  it("asks before a command and runs it only when allowed; Stop interrupts a turn", async () => {
    const dir = tempDir("codex");
    codexOnly(dir);
    const c = core(dir);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/tool ls -la" });
    const asked = await until(async () => (await c.chat()).messages.find((m: any) => m.approval?.tool === "Bash"));
    expect(asked).toMatchObject({ engine: "codex", choices: [{ label: "Allow once", action: "allowOnce" }, { label: "Don't allow", action: "deny" }] });
    expect(asked.text).toContain("/bin/zsh -lc 'ls -la'");
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: asked.id, index: 0 })).toEqual({ accepted: true });
    expect((await finishedFor(c, turnId)).event).toMatchObject({ status: "done", text: "Allowed: ran ls -la" });
    const steps = (await c.chat()).messages.findLast((m: any) => m.engine === "codex").steps;
    expect(steps.map((s: any) => [s.kind, s.title])).toEqual([["text", "Let me run that."], ["tool", "Run ls -la"]]);
    const slow = await c.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    await until(async () => (await c.chat()).running?.turnId === slow.turnId);
    await until(() => c.of("turn.steps").some((e) => (e.event as any).turnId === slow.turnId));
    expect(await c.call({ type: "turn.stop", botId: MAIN, turnId: slow.turnId })).toMatchObject({ stopped: true, forced: false });
    expect((await finishedFor(c, slow.turnId)).event).toMatchObject({ status: "stopped" });
    // The head is still there for the next message.
    expect((await turn(c, "again")).event.text).toBe("Codex says: again");
  });

  it("hands work to an app-managed worker; its report wakes the coordinator, which says what came of it", async () => {
    const dir = tempDir("codex");
    codexOnly(dir);
    const c = core(dir, { FAKE_CODEX_WORKER_MS: "400" });
    const { event, messageId } = await turn(c, "/worker Build the parser");
    expect(event.text).toBe("A worker has it.");
    const handed = (await c.chat()).messages.find((m: any) => m.id === messageId);
    const step = handed.steps.find((s: any) => s.kind === "subagent");
    expect(step).toMatchObject({ title: "Build the parser", status: "running" });
    expect((await bots(c))[0].subagents).toBe(1);
    // The worker's own conversation, as a subagent's.
    const running = (await c.call({ type: "subagent.view", botId: MAIN, subagentId: step.id })).subagent;
    expect(running).toMatchObject({ type: "codex-worker", status: "running", prompt: "Build the parser" });
    // Its report: the app's own turn on the coordinator, shown as Codex's reply.
    const report = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "bot" && m.text.startsWith("The worker finished")), { timeout: 10_000 });
    expect(report.text).toBe("The worker finished: Worker did: Build the parser");
    expect(report.steps.map((s: any) => s.title)).toContain("Task checkpoint: complete");
    const ended = (await c.call({ type: "subagent.view", botId: MAIN, subagentId: step.id })).subagent;
    expect(ended).toMatchObject({ status: "completed", result: "Worker did: Build the parser" });
    expect(ended.steps.map((s: any) => s.title)).toEqual(["Run ls", "Looking into it.", "Worker did: Build the parser"]);
    // The report reached the coordinator correlated by task_id; the worker's record is kept (1.x's file).
    const payload = JSON.parse(codexInputs(dir, "report")[0]!);
    expect(payload).toMatchObject({ task_id: step.id, name: "Build the parser", status: "completed", report: "Worker did: Build the parser", completion_scope: "worker_turn" });
    const workers = readFileSync(join(dir, "codex-threads", (await until(() => {
      const files = existsSync(join(dir, "codex-threads")) ? require("node:fs").readdirSync(join(dir, "codex-threads")) as string[] : [];
      return files.find((file) => file.endsWith(".workers.json"));
    }))), "utf8");
    expect(JSON.parse(workers)).toMatchObject([{ id: step.id, name: "Build the parser", run: 1, wasActive: false, reportPending: false }]);
    expect(JSON.parse(readFileSync(join(dir, "main", "subagents.json"), "utf8"))).toMatchObject([{ id: step.id, status: "completed", type: "codex-worker" }]);
  });

  it("tidies through a worker before it sleeps, and nothing of it shows", async () => {
    const dir = tempDir("codex");
    codexOnly(dir);
    const c = core(dir, { BOTLING_IDLE_MS: "300", FAKE_CODEX_WORKER_MS: "50" });
    await turn(c, "remember this");
    const before = (await c.chat()).messages.length;
    await until(async () => (await bots(c))[0].phase === "asleep", { timeout: 10_000 });
    expect(readFileSync(join(dir, "main", "memory.md"), "utf8")).toContain("Tidied by the fake Codex worker");
    expect(codexInputs(dir).at(-1)).toMatch(/^\(App: You have been idle for a while and are preparing to sleep\. Use app_handoff/);
    expect((await c.chat()).messages.length).toBe(before);
  });
});

describe("timing as 1.x", () => {
  it("a message to a Codex head at work joins its turn (turn/steer): one reply, after your new line", async () => {
    const dir = tempDir("codex");
    codexOnly(dir);
    const c = core(dir, { FAKE_CODEX_TURN_MS: "900" });
    const first = await c.call({ type: "chat.send", botId: MAIN, text: "first" });
    await until(() => codexInputs(dir).some((text) => text.endsWith("first")), { timeout: 5_000 });
    const second = await c.call({ type: "chat.send", botId: MAIN, text: "second" });
    // It is the turn under way that answers it.
    expect(second.turnId).toBe(first.turnId);
    expect(second.messageId).toBe(first.messageId);
    expect((await finishedFor(c, first.turnId)).event).toMatchObject({ status: "done", text: "Codex says: first (also heard: second)" });
    expect(codexInputs(dir, "steer")).toEqual([expect.stringMatching(/^second/)]);
    // (Not a turn of its own: no input ends with it. Its components note says "every 2 seconds".)
    expect(codexInputs(dir).filter((text) => /(^|\n)second$/.test(text))).toEqual([]);
    const shown = (await c.chat()).messages.filter((m: any) => m.role !== "divider" && m.role !== "notice").map((m: any) => [m.role, m.text]);
    expect(shown).toEqual([["user", "first"], ["user", "second"], ["bot", "Codex says: first (also heard: second)"]]);
  });
});

describe("two heads in one chat", () => {
  async function twoHeads(dir: string, env: Record<string, string> = {}) {
    const c = core(dir, env);
    expect(await c.call({ type: "heads.set", botId: MAIN, engines: ["claude", "codex"] })).toEqual({ engines: ["claude", "codex"] });
    return c;
  }

  it("a message to both: one head reads it first, the other gets it with the first one's reply; the lead takes turns", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    const chat = await c.chat();
    expect(chat.heads).toMatchObject({ engines: ["claude", "codex"], answerWith: "both", handoffsOn: true, rounds: null, handoffs: [] });
    const { messageId: userId } = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    const claude = await until(async () => (await lastBy(c, "claude"))?.state === "done" && lastBy(c, "claude"), { timeout: 10_000 });
    const codex = await until(async () => (await lastBy(c, "codex"))?.state === "done" && lastBy(c, "codex"), { timeout: 10_000 });
    expect(claude.text).toBe("You said: hello");
    expect(codex.text).toBe("Codex says: hello");
    // Codex heard Claude's reply with the message (Claude led: it was free and first).
    const heard = codexInputs(dir)[0]!;
    expect(heard).toContain("(App: Claude, this bot's other head, replied in this chat:)\nYou said: hello\n\nhello");
    // Each head's instructions say it has a partner (the heads rule).
    expect(claudeInputs(dir)[0]).not.toContain("this bot's other head");
    // Seen marks: the message reached both; each reply its own head (and Claude's reply reached Codex).
    const after = (await c.chat()).messages;
    expect(after.find((m: any) => m.id === userId).seenBy).toEqual(["claude", "codex"]);
    expect(after.find((m: any) => m.id === claude.id).seenBy).toEqual(["claude", "codex"]);
    expect(after.find((m: any) => m.id === codex.id).seenBy).toEqual(["codex"]);
    // The next message to both is led by Codex.
    await c.call({ type: "chat.send", botId: MAIN, text: "second" });
    await until(() => claudeInputs(dir).length >= 2, { timeout: 10_000 });
    // What it heard meanwhile (Codex's first reply), then what the lead said about this one, then the words.
    expect(claudeInputs(dir)[1]).toMatch(/^\(App: Codex, this bot's other head, replied in this chat:\)\nCodex says: hello\n\n\(App: Codex, this bot's other head, replied in this chat:\)\nCodex says: second\n\nsecond/);
    // Both files: the shared chat (both heads' lines) and the partner's own (1.x's partner-codex/).
    const shared = JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8"));
    expect(shared.filter((m: any) => m.engine === "codex").length).toBeGreaterThanOrEqual(1);
    const partner = JSON.parse(readFileSync(join(dir, "main", "partner-codex", "chat.json"), "utf8"));
    expect(partner.every((m: any) => m.engine === "codex")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).heads).toMatchObject({ engines: ["claude", "codex"], answerWith: "both", limits: { discussion: 3, review: 2, handoffs: 6 } });
  });

  it("Claude hears the other head mid-turn (1.x's context-only delivery), and only once", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir, { FAKE_CLAUDE_LINGER_MS: "1500" });
    const { messageId: userId } = await c.call({ type: "chat.send", botId: MAIN, text: "/linger plan it" });
    // Claude leads; its first words go to Codex with the message; Codex answers while Claude still works.
    const codex = await until(async () => (await lastBy(c, "codex"))?.state === "done" && lastBy(c, "codex"), { timeout: 10_000 });
    expect(codexInputs(dir)[0]).toContain("(App: Claude, working on this too, says: Thinking it over.)\n\n/linger plan it");
    const midTurn = await until(() => lines(join(dir, "claude-input.log")).find((entry) => entry.midTurn), { timeout: 5_000 });
    expect(midTurn.text).toBe(`(App: Codex, this bot's other head, replied in this chat:)\n${codex.text}`);
    const claude = await until(async () => (await lastBy(c, "claude"))?.state === "done" && lastBy(c, "claude"), { timeout: 10_000 });
    expect(claude.text).toBe("Thinking it over.\n\nYou said: plan it (heard mid-turn: 1)");
    expect((await c.chat()).messages.find((m: any) => m.id === codex.id).seenBy).toEqual(["claude", "codex"]);
    expect((await c.chat()).messages.find((m: any) => m.id === userId).seenBy).toEqual(["claude", "codex"]);
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    // Not again with its next message.
    await turn(c, "and now?", { to: "claude" });
    expect(claudeInputs(dir).at(-1)).not.toContain("replied in this chat");
    expect(claudeInputs(dir).at(-1)).toMatch(/and now\?/);
  });

  it("words claude reads only after its turn ended get a turn of their own, the app's: <no-reply/> shows nothing", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir, { FAKE_CLAUDE_LINGER_MS: "800", FAKE_CLAUDE_NO_ABSORB: "1", FAKE_CLAUDE_NOTE_MS: "300" });
    await c.call({ type: "chat.send", botId: MAIN, text: "/linger plan it" });
    await until(async () => (await lastBy(c, "claude"))?.state === "done", { timeout: 10_000 });
    // The note's own turn starts (command_lifecycle "started"): the bot works, then shows nothing.
    await until(() => claudeInputs(dir).some((text) => text.startsWith("(App: Codex, this bot's other head, replied")), { timeout: 5_000 });
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    const replies = (await c.chat()).messages.filter((m: any) => m.role === "bot");
    expect(replies.map((m: any) => [m.engine, m.text])).toEqual([["claude", "Thinking it over.\n\nYou said: plan it"], ["codex", "Codex says: /linger plan it"]]);
    // A message after it goes as usual.
    expect((await turn(c, "after", { to: "claude" })).event.text).toBe("You said: after");
  });

  it("a lead that says nothing: the other head gets the message after the wait; the lead's first words release it (headWords)", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir, { BOTLING_CLAIM_WAIT_MS: "400" });
    // Claude leads and only streams: after the wait Codex gets the message anyway, plain.
    await c.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    const plain = await until(() => codexInputs(dir)[0], { timeout: 5_000 });
    expect(plain).toMatch(/\n\n\/slow$/);
    expect(plain).not.toContain("working on this too");
    const runs = await until(async () => { const r = (await c.chat()).runs; return r.length === 2 && r; });
    expect(runs.map((run: any) => run.head).sort()).toEqual(["claude", "codex"]);
    for (const run of runs) await c.call({ type: "turn.stop", botId: MAIN, turnId: run.turnId });
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    // Codex leads the next one and says what it does before its tool call: Claude starts with those words.
    await c.call({ type: "chat.send", botId: MAIN, text: "/tool echo a" });
    const codexAsks = await until(async () => (await c.chat()).messages.find((m: any) => m.approval && m.engine === "codex"));
    const heard = await until(() => claudeInputs(dir)[1], { timeout: 5_000 });
    expect(heard).toContain("(App: Codex, working on this too, says: Let me run that.)\n\n/tool echo a");
    const claudeAsks = await until(async () => (await c.chat()).messages.find((m: any) => m.approval && m.engine === "claude"));
    expect((await bots(c))[0].approvals).toBe(2);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: claudeAsks.id, index: 1 });
    await c.call({ type: "chat.choose", botId: MAIN, messageId: codexAsks.id, index: 1 });
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    const replies = (await c.chat()).messages.filter((m: any) => m.role === "bot" && !m.approval && m.state === "done").map((m: any) => [m.engine, m.text]);
    expect(replies).toEqual(expect.arrayContaining([["codex", "Denied: not run."], ["claude", "Let me run that. \n\nDenied: The user did not allow it."]]));
  });

  it("the head with nothing to add says <no-reply/> and shows nothing; a message for one head reaches the other as a note", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    await c.call({ type: "chat.send", botId: MAIN, text: "/solo fix the bug" });
    await until(() => codexInputs(dir).length >= 1, { timeout: 5_000 });
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    const replies = (await c.chat()).messages.filter((m: any) => m.role === "bot" && m.engine);
    expect(replies.map((m: any) => [m.engine, m.text])).toEqual([["claude", "I take it: fix the bug"]]);
    // To Codex only: Claude hears of it with its next message.
    await turn(c, "only you", { to: "codex" });
    expect((await c.chat()).messages.find((m: any) => m.role === "user" && m.text === "only you")).toMatchObject({ to: "codex", seenBy: ["codex"] });
    await until(async () => (await lastBy(c, "codex"))?.text === "Codex says: only you", { timeout: 10_000 });
    expect(claudeInputs(dir).length).toBe(1);
    await turn(c, "and you?", { to: "claude" });
    expect(claudeInputs(dir)[1]).toMatch(/^\(App: The user wrote this to Codex only; you need not answer it:\)\nonly you\n\n\(App: Codex, this bot's other head, replied in this chat:\)\nCodex says: only you\n\nand you\?/);
  });

  it("a hand-off goes to the other head and its reply comes back; the composer's default is saved", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    expect(await c.call({ type: "heads.answerWith", botId: MAIN, to: "claude" })).toEqual({ answerWith: "claude" });
    await c.call({ type: "chat.send", botId: MAIN, text: `/say Made it faster. <handoff to="codex" kind="review">Check the diff</handoff>` });
    const back = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "claude" && m.state === "done" && m.text.startsWith("Done:")), { timeout: 10_000 });
    expect(back.text).toBe("Done: Did it: Check the diff");
    const messages = (await c.chat()).messages;
    const shown = messages.filter((m: any) => m.role === "bot" || m.role === "divider").map((m: any) => [m.role, m.engine ?? null, m.text]);
    expect(shown.slice(-4)).toEqual([
      ["bot", "claude", "Made it faster."],
      ["divider", null, "Claude → Codex: Check the diff"],
      ["bot", "codex", "Did it: Check the diff"],
      ["bot", "claude", "Done: Did it: Check the diff"],
    ]);
    expect(codexInputs(dir).at(-1)).toContain("(App: Claude, this bot's other head, asks you to review this (hand-off 1 of 6 for the user's latest message):\nCheck the diff\n\nDo it, then reply with the result; the app gives your reply back to Claude.)");
    const heads = (await c.chat()).heads;
    expect(heads).toMatchObject({ answerWith: "claude", rounds: null });
    expect(heads.handoffs).toMatchObject([{ from: "claude", to: "codex", kind: "review", task: "Check the diff", round: 1, limit: 2, state: "done", lines: [{ who: "claude" }, { who: "codex" }, { who: "claude" }] }]);
    expect(c.of("heads.updated").some((e) => (e.event as any).heads?.rounds?.text === "Review round 1 of 2")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).heads.answerWith).toBe("claude");
  });

  it("a bot with one head hands work to the other CLI too: that head is made for it and its reply comes back (1.x)", async () => {
    const dir = tempDir("heads");
    const c = core(dir);
    await c.call({ type: "chat.send", botId: MAIN, text: `/say Made it faster. <handoff to="codex" kind="review">Check the diff</handoff>` });
    const back = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "claude" && m.state === "done" && m.text.startsWith("Done:")), { timeout: 10_000 });
    expect(back.text).toBe("Done: Did it: Check the diff");
    const shown = (await c.chat()).messages.filter((m: any) => m.role === "bot" || m.role === "divider" || m.role === "notice").map((m: any) => [m.role, m.engine ?? null, m.text]);
    expect(shown.slice(-4)).toEqual([
      ["bot", "claude", "Made it faster."],
      ["divider", null, "Claude → Codex: Check the diff"],
      ["bot", "codex", "Did it: Check the diff"],
      ["bot", "claude", "Done: Did it: Check the diff"],
    ]);
    // It still has one head: Settings and the composer are as they were.
    expect((await bots(c))[0]).toMatchObject({ heads: ["claude"] });
  });

  it("a hand-off helps the task its head was on: the card says \"Codex helping: …\" (1.x's noteTaskHandoffs)", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    await c.call({ type: "heads.answerWith", botId: MAIN, to: "claude" });
    await c.call({ type: "chat.send", botId: MAIN, text: `/say Profiling now.\n<task name="Faster parser" now="Profiling" next="Review"/>\n<handoff to="codex" kind="review">Check the diff\nand the tests</handoff>` });
    const card = await until(async () => (await c.chat()).tasks?.find((task: any) => task.helps), { timeout: 10_000, what: "a card with a help line" });
    expect(card).toMatchObject({ name: "Faster parser", helps: [{ head: "codex", text: "Check the diff" }] });
    const saved = await until(() => (JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8")) as any[]).find((task) => task.helps));
    expect(saved.helps).toMatchObject([{ head: "codex", text: "Check the diff" }]);
  });

  it("work handed to Codex that it gives a worker goes back with the worker's report, not with the turn that accepted it (worker return routes)", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    await c.call({ type: "heads.answerWith", botId: MAIN, to: "claude" });
    await c.call({ type: "chat.send", botId: MAIN, text: `/say Handing it over. <handoff to="codex">/worker build the parser</handoff>` });
    const back = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "claude" && m.state === "done" && m.text.startsWith("Done:")), { timeout: 15_000, what: "the hand-back" });
    expect(back.text).toBe("Done: The worker finished: Worker did: build the parser");
    const codex = (await c.chat()).messages.filter((m: any) => m.engine === "codex").map((m: any) => m.text);
    expect(codex[0]).toBe("A worker has it.");
    // Only one hand-back: the accepting turn did not go back.
    expect((await c.chat()).messages.filter((m: any) => m.engine === "claude" && m.text.startsWith("Done:"))).toHaveLength(1);
  });

  it("your message pauses claude's handed-over work (1.x's pausing): answered first, then it carries on and the hand-back goes on", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    await c.call({ type: "heads.answerWith", botId: MAIN, to: "codex" });
    await c.call({ type: "chat.send", botId: MAIN, text: `/say On it. <handoff to="claude">/slow build the parser</handoff>` });
    // Claude is at work on the handed-over task (it streams until interrupted).
    await until(async () => (await c.chat()).messages.some((m: any) => m.engine === "claude" && m.text.includes("step1")), { timeout: 10_000 });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "what is the time?", to: "claude" });
    expect((await finishedFor(c, turnId)).event).toMatchObject({ status: "done", text: "You said: what is the time?" });
    // It heard the pause note with your words; the handed work's words so far stay, cut off.
    expect(claudeInputs(dir).find((text) => text.includes("what is the time?"))).toMatch(/^\(App: I stopped what you were doing to ask you this\. Answer me first; you will be told to carry on with it after\.\)\n\nwhat is the time\?/);
    const cut = (await c.chat()).messages.find((m: any) => m.engine === "claude" && m.text.includes("step1"));
    expect(cut).toMatchObject({ state: "stopped", interrupted: true });
    // Then it carries on (1.x's resume note); its reply is the hand-back, which Codex answers.
    const back = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "codex" && m.state === "done" && m.text.startsWith("Done: Carried on")), { timeout: 10_000 });
    expect(back.text).toBe("Done: Carried on: finished the handed work.");
    expect(claudeInputs(dir).at(-1)).toBe("(App: Now carry on with what you were doing before the user's message, where you left off.)");
    expect((await c.chat()).heads.handoffs).toMatchObject([{ from: "codex", to: "claude", state: "done" }]);
    const order = (await c.chat()).messages.filter((m: any) => m.role !== "divider").map((m: any) => [m.role, m.engine ?? null, m.text.replace(/step\d+\s*/g, "").trim()]);
    expect(order.slice(-5)).toEqual([
      ["bot", "claude", ""],
      ["user", null, "what is the time?"],
      ["bot", "claude", "You said: what is the time?"],
      ["bot", "claude", "Carried on: finished the handed work."],
      ["bot", "codex", "Done: Carried on: finished the handed work."],
    ]);
  });

  it("your message pauses Codex's handed-over work: it joins the turn (turn/steer), then Codex carries on with the hand-off", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    await c.call({ type: "heads.answerWith", botId: MAIN, to: "claude" });
    await c.call({ type: "chat.send", botId: MAIN, text: `/say On it. <handoff to="codex">/slow check the tests</handoff>` });
    await until(() => c.of("turn.steps").some((e) => JSON.stringify(e.event).includes("working on it 1")), { timeout: 10_000 });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "are you there?", to: "codex" });
    const answered = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "codex" && m.state === "done" && m.text.startsWith("Answered you:")), { timeout: 10_000 });
    expect(answered.text).toBe("Answered you: are you there?");
    expect(codexInputs(dir, "steer").at(-1)).toMatch(/^\(App: I stopped what you were doing to ask you this\. Answer me first; you will be told to carry on with it after\.\)\n\nare you there\?/);
    expect(turnId).toBeTruthy();
    const back = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "claude" && m.state === "done" && m.text.startsWith("Done: Carried on")), { timeout: 10_000 });
    expect(back.text).toBe("Done: Carried on: finished the handed work.");
    expect(codexInputs(dir).at(-1)).toContain("(App: Now carry on with what you were doing before the user's message, where you left off.)");
  });

  it("at the hand-off budget a card asks; One more round lets it go on", async () => {
    const dir = tempDir("heads");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "claude", heads: { engines: ["claude", "codex"], answerWith: "claude", limits: { handoffs: 1 } } }));
    const c = core(dir);
    await c.call({ type: "chat.send", botId: MAIN, text: `/say Part one. <handoff to="codex">/handoff:claude part three</handoff>` });
    const card = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "notice" && m.choices), { timeout: 10_000 });
    expect(card.text).toBe("1 hand-offs for this message: the limit.\n\nClaude: Part one.\nCodex: Over to you.");
    expect(card.choices.map((choice: any) => choice.label)).toEqual(["Go with Claude's", "Go with Codex's", "One more round"]);
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: card.id, index: 2 })).toEqual({ accepted: true });
    const done = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "claude" && m.text === "Did it: part three"), { timeout: 10_000 });
    expect(done).toBeTruthy();
    expect((await c.chat()).heads.handoffs.map((h: any) => [h.from, h.to, h.round, h.limit])).toEqual([["claude", "codex", 1, 1], ["codex", "claude", 2, 2]]);
  });

  it("a question handed over with decision= shows as the same decision; a pick on either copy goes once, to the head that asked", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    const { messageId: questionTurn } = await turn(c, "/choices", { to: "claude" });
    const question = (await c.chat()).messages.find((m: any) => m.id === questionTurn);
    expect(question).toMatchObject({ engine: "claude", choices: [{ label: "Fast" }, { label: "Slow" }] });
    await c.call({ type: "chat.send", botId: MAIN, to: "claude", text: `/say Codex, your view? <handoff to="codex" kind="discuss" decision="${question.id}">/say <decision-ref id="${question.id}"/></handoff>` });
    const view = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "codex" && m.decisionId), { timeout: 10_000 });
    // The handed note carried the decision's context.
    expect(codexInputs(dir).at(-1)).toContain(`(App: Shared handoff decisions.`);
    expect(codexInputs(dir).at(-1)).toContain(`Decision ${question.id}: Which way?; options: Fast / Slow; answer: unanswered`);
    expect(view).toMatchObject({ decisionId: question.id, choices: [{ label: "Fast" }, { label: "Slow" }], chosen: null });
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    const claudeBefore = claudeInputs(dir).length;
    const codexBefore = codexInputs(dir).length;
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: view.id, index: 1 })).toEqual({ accepted: true });
    await until(() => claudeInputs(dir).length > claudeBefore, { timeout: 10_000 });
    const after = (await c.chat()).messages;
    expect(after.find((m: any) => m.id === question.id)).toMatchObject({ chosen: 1, decisionId: question.id });
    expect(after.find((m: any) => m.id === view.id)).toMatchObject({ chosen: 1 });
    expect(claudeInputs(dir).at(-1)).toMatch(new RegExp(`^\\(App: Decision ${question.id} resolved once\\. You own applying this answer;`));
    expect(claudeInputs(dir).at(-1)).toContain("Slow");
    // Answered once: the other copy cannot answer it again, and Codex was not sent the pick.
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 0 })).toEqual({ accepted: false });
    await until(async () => !(await bots(c))[0].working, { timeout: 10_000 });
    expect(codexInputs(dir).slice(codexBefore).some((text) => text.includes("resolved once"))).toBe(false);
  });

  it("keeps both heads' lines and the heads across a restart", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir);
    await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(async () => (await lastBy(c, "codex"))?.state === "done", { timeout: 10_000 });
    const before = (await c.chat()).messages.map((m: any) => [m.engine ?? null, m.text]);
    await c.kill();
    const again = core(dir);
    const chat = await again.chat();
    expect(chat.messages.map((m: any) => [m.engine ?? null, m.text])).toEqual(before);
    expect(chat.heads).toMatchObject({ engines: ["claude", "codex"] });
    expect((await bots(again))[0].heads).toEqual(["claude", "codex"]);
  });
});
