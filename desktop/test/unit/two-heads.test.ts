// Codex heads and two-head bots through the built core with the fake claude and the fake Codex
// app-server: a Codex reply, its approvals, an app-managed worker and its report, Stop, the tidy;
// then Claude and Codex in one chat — who reads a message first and what the other hears
// (claim, hold, release on words or on the wait), <no-reply/> from the head with nothing to add,
// a message for one head, hand-offs and their budget card, a shared decision answered once.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { readHistoryState } from "../../src/core/durable/history-journal";
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
    expect(start).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request", config: { "features.multi_agent": false, "agents.enabled": false, "features.shell_tool": false, web_search: "disabled", "auto_review.extra_policy": expect.any(String),
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
    // The report reached the coordinator correlated by task_id; the worker's record is kept in durable history.
    const payload = JSON.parse(codexInputs(dir, "report")[0]!);
    expect(payload).toMatchObject({ task_id: step.id, name: "Build the parser", status: "completed", report: "Worker did: Build the parser", completion_scope: "worker_turn" });
    const workers = readFileSync(join(dir, "codex-threads", (await until(() => {
      const files = existsSync(join(dir, "codex-threads")) ? require("node:fs").readdirSync(join(dir, "codex-threads")) as string[] : [];
      return files.find((file) => file.endsWith(".workers.json"));
    }))), "utf8");
    expect(JSON.parse(workers)).toMatchObject([{ id: step.id, name: "Build the parser", run: 1, wasActive: false, reportPending: false }]);
    const historyFile = join(dir, "main", "subagents.json");
    const saved = readHistoryState(historyFile).rows;
    expect(saved).toMatchObject([{ id: step.id, status: "completed", type: "codex-worker", result: "Worker did: Build the parser" }]);
    await c.kill(); // Graceful shutdown must retain the accepted report across checkpointing.
    expect(c.child.exitCode).toBe(0);
    // Codex may append its own tidy worker during shutdown; the accepted worker is unchanged.
    expect(readHistoryState(historyFile).rows.filter(row => row.id === step.id)).toEqual(saved);
    const reopened = core(dir);
    const retained = (await reopened.call({ type: "subagent.view", botId: MAIN, subagentId: step.id })).subagent;
    expect(retained).toMatchObject({ status: "completed", result: "Worker did: Build the parser" });
    expect(retained.steps).toEqual(ended.steps);
    await reopened.kill();
    expect(reopened.child.exitCode).toBe(0);
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

  it("sends once to the saved primary and never broadcasts legacy Both", async () => {
    const dir = tempDir("heads"), c = await twoHeads(dir);
    expect((await c.chat()).heads.answerWith).toBe("claude");
    await turn(c, "hello");
    expect(claudeInputs(dir)).toHaveLength(1);expect(codexInputs(dir)).toHaveLength(0);
    await c.call({type:"heads.answerWith",botId:MAIN,to:"codex"});
    await turn(c,"second",{to:"both"});
    expect(claudeInputs(dir)).toHaveLength(1);expect(codexInputs(dir)).toHaveLength(1);
    expect((await c.chat()).heads.answerWith).toBe("codex");
  });

  it("keeps independent concurrent turns isolated without context-only dispatch", async () => {
    const dir = tempDir("heads"), c = await twoHeads(dir, {FAKE_CLAUDE_LINGER_MS:"800"});
    await c.call({type:"chat.send",botId:MAIN,text:"/linger plan it",to:"claude"});
    await until(()=>claudeInputs(dir).length===1);
    await turn(c,"independent",{to:"codex"});
    await until(async()=>!(await bots(c))[0].working);
    expect(claudeInputs(dir)).toHaveLength(1);expect(codexInputs(dir)).toHaveLength(1);
    expect(lines(join(dir,"claude-input.log")).some(entry=>entry.midTurn)).toBe(false);
  });

  it("does not dispatch a second engine when the primary is slow or has nothing to add", async () => {
    const dir = tempDir("heads"), c = await twoHeads(dir,{BOTLING_CLAIM_WAIT_MS:"20"});
    const sent = await c.call({type:"chat.send",botId:MAIN,text:"/slow"});
    await until(()=>claudeInputs(dir).length===1);
    await new Promise(resolve=>setTimeout(resolve,80));
    expect(codexInputs(dir)).toHaveLength(0);
    expect((await c.chat()).runs).toHaveLength(1);
    await c.call({type:"turn.stop",botId:MAIN,turnId:sent.turnId});
    await turn(c,"/solo fix the bug");expect(codexInputs(dir)).toHaveLength(0);
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

  it("a second line to the Claude head while it answers you joins its turn: no interrupt, one reply after your line", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir, { FAKE_CLAUDE_INTERRUPTS: join(dir, "interrupts.log") });
    const first = await c.call({ type: "chat.send", botId: MAIN, text: "/slow", to: "claude" });
    await until(async () => (await c.chat()).messages.some((m: any) => m.engine === "claude" && m.text.includes("word2")), { timeout: 10_000 });
    const second = await c.call({ type: "chat.send", botId: MAIN, text: "and this", to: "claude" });
    expect(second.turnId).toBe(first.turnId);
    expect((await finishedFor(c, first.turnId)).event).toMatchObject({ status: "done", text: expect.stringMatching(/You said: and this$/) });
    expect(existsSync(join(dir, "interrupts.log"))).toBe(false);
    const shown = (await c.chat()).messages.filter((m: any) => m.role === "user" || m.role === "bot").map((m: any) => [m.role, m.text.replace(/word\d+ /g, "")]);
    expect(shown.slice(-3)).toEqual([["user", "/slow"], ["user", "and this"], ["bot", "You said: and this"]]);
  });

  it("your message pauses claude's handed-over work (1.x's pausing): answered first, then it carries on and the hand-back goes on", async () => {
    const dir = tempDir("heads");
    const c = await twoHeads(dir, { FAKE_CLAUDE_INTERRUPTS: join(dir, "interrupts.log") });
    await c.call({ type: "heads.answerWith", botId: MAIN, to: "codex" });
    await c.call({ type: "chat.send", botId: MAIN, text: `/say On it. <handoff to="claude">/slow build the parser</handoff>` });
    // Claude is at work on the handed-over task (it streams until interrupted).
    await until(async () => (await c.chat()).messages.some((m: any) => m.engine === "claude" && m.text.includes("step1")), { timeout: 10_000 });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "what is the time?", to: "claude" });
    expect((await finishedFor(c, turnId)).event).toMatchObject({ status: "done", text: expect.stringMatching(/You said: what is the time\?$/) });
    // It heard the pause note with your words in the turn under way (no interrupt): nothing is cut off.
    expect(lines(join(dir, "claude-input.log")).find((entry) => entry.text?.includes("what is the time?"))).toMatchObject({ midTurn: true, text: expect.stringMatching(/^\(App: I stopped what you were doing to ask you this\. Answer me first; you will be told to carry on with it after\.\)\n\nwhat is the time\?/) });
    expect(existsSync(join(dir, "interrupts.log"))).toBe(false);
    expect((await c.chat()).messages.some((m: any) => m.state === "stopped" || m.interrupted)).toBe(false);
    // Then it carries on (1.x's resume note); its reply is the hand-back, which Codex answers.
    const back = await until(async () => (await c.chat()).messages.find((m: any) => m.engine === "codex" && m.state === "done" && m.text.startsWith("Done: Carried on")), { timeout: 10_000 });
    expect(back.text).toBe("Done: Carried on: finished the handed work.");
    expect(claudeInputs(dir).at(-1)).toBe("(App: Now carry on with what you were doing before the user's message, where you left off.)");
    expect((await c.chat()).heads.handoffs).toMatchObject([{ from: "codex", to: "claude", state: "done" }]);
    const order = (await c.chat()).messages.filter((m: any) => m.role !== "divider").map((m: any) => [m.role, m.engine ?? null, m.text.replace(/step\d+\s*/g, "").trim()]);
    expect(order.slice(-4)).toEqual([
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
    await turn(c, "hello", {to:"claude"});
    await turn(c, "hello codex", {to:"codex"});
    const before = (await c.chat()).messages.map((m: any) => [m.engine ?? null, m.text]);
    await c.kill();
    const again = core(dir);
    const chat = await again.chat();
    expect(chat.messages.map((m: any) => [m.engine ?? null, m.text])).toEqual(before);
    expect(chat.heads).toMatchObject({ engines: ["claude", "codex"] });
    expect((await bots(again))[0].heads).toEqual(["claude", "codex"]);
  });
});
