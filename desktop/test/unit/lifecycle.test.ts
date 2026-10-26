// Phase 2a through the built core and the fake CLI: the app's reply tags acted on (choices and
// their answers, task cards in tasks.json, reactions, requests 2.0 cannot do), a message while a
// reply runs (merged, or waiting behind an approval), subagents (subagents.json, step status, the
// subagent's view, a background one reporting in claude's own turn, <no-reply/>), the chat archive,
// and the project lock (another 2.0, or a running 1.x).
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { streamingText } from "../../src/core/bot";

const harnesses: CoreHarness[] = [];
const others: ChildProcess[] = [];
const core = (dataDir: string, env: Record<string, string> = {}) => {
  const harness = new CoreHarness(dataDir, { FAKE_CLAUDE_INPUT: join(dataDir, "input.log"), ...env });
  harnesses.push(harness);
  return harness;
};
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
  for (const child of others.splice(0)) child.kill("SIGKILL");
});

const inputs = (dir: string): string[] =>
  existsSync(join(dir, "input.log")) ? readFileSync(join(dir, "input.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).text) : [];

async function turn(c: CoreHarness, text: string, botId = MAIN) {
  const { turnId, messageId } = await c.call({ type: "chat.send", botId, text });
  const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `the end of "${text}"` });
  return { turnId, messageId, event: finished.event as { status: string; text: string } };
}

const PROJECT = "44444444-4444-4444-8444-444444444444";
/** A data folder with one project bot (a manager) working in `folder`. */
function withProject(dir: string, folder: string) {
  mkdirSync(folder, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: PROJECT, name: "garden", folder: pathToFileURL(folder).href + "/", avatar: "hexagon" }]));
}

describe("reply tags", () => {
  it("a <choices> block becomes buttons; a pick goes back as the user's answer to that question", async () => {
    const dir = tempDir("tags");
    const c = core(dir);
    const { messageId, event } = await turn(c, "/choices");
    expect(event.text).toBe("Which way?");
    const question = (await c.chat()).messages.find((m: { id: string }) => m.id === messageId);
    expect(question).toMatchObject({ choices: [{ label: "Fast", detail: "done today", recommended: true, action: null }, { label: "Slow", detail: "costs a week", recommended: false }], chosen: null, answer: null });
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId, index: 0 })).toEqual({ accepted: true });
    const answer = await until(() => c.of("turn.finished").at(-1)!.event as { text: string; turnId: string } | undefined);
    await until(() => c.of("turn.finished").length >= 2);
    const chat = await c.chat();
    const user = chat.messages.findLast((m: { role: string }) => m.role === "user");
    expect(user).toMatchObject({ text: "Fast", replyTo: messageId, replyPreview: "Which way?" });
    expect(chat.messages.find((m: { id: string }) => m.id === messageId)).toMatchObject({ chosen: 0 });
    expect(inputs(dir).at(-1)).toMatch(/^\(Replying to what you said earlier: "Which way\?"\)\n\nFast\n\n\(App: message_id of this message: /);
    void answer;
    // A question is answered once.
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId, index: 1 })).toEqual({ accepted: false });
    // In 1.x's chat.json: the choices and the pick.
    const saved = JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8"));
    expect(saved.find((m: { id: string }) => m.id === messageId)).toMatchObject({ chosen: 0, choices: [{ label: "Fast", detail: "done today", recommended: true }, { label: "Slow" }] });
  });

  it("an answer in the user's own words marks the question and goes as a reply to it", async () => {
    const dir = tempDir("tags");
    const c = core(dir);
    const { messageId } = await turn(c, "/choices");
    expect(await c.call({ type: "chat.answer", botId: MAIN, messageId, text: "Neither, wait a day" })).toEqual({ accepted: true });
    await until(() => c.of("turn.finished").length >= 2);
    const chat = await c.chat();
    expect(chat.messages.find((m: { id: string }) => m.id === messageId)).toMatchObject({ chosen: null, answer: "Neither, wait a day" });
    expect(chat.messages.at(-1).text).toBe("You said: Neither, wait a day");
  });

  it("a <task> line keeps the message's card current in tasks.json (1.20's format); a quick answer leaves none", async () => {
    const dir = tempDir("tags");
    const c = core(dir);
    const { messageId } = await turn(c, "/task");
    const saved = JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "Docs", owner: "claude", state: "running", now: "writing the intro", next: "examples", kept: true, stateFromTag: "running" });
    expect(saved[0].id).toMatch(/^[0-9A-F-]{36}$/);
    expect(typeof saved[0].createdAt).toBe("number");
    expect(saved[0].messageIDs).toEqual([expect.stringMatching(/^[0-9A-F-]{36}$/), messageId]);
    // The snapshot and events carry it; the line is gone from the reply.
    const chat = await c.chat();
    expect(chat.tasks).toEqual([expect.objectContaining({ name: "Docs", state: "running", now: "writing the intro", atWork: false })]);
    expect(chat.messages.at(-1).text).toBe("Working on the docs.");
    expect(c.of("tasks.updated").length).toBeGreaterThan(0);
    await turn(c, "thanks");
    expect(JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8"))).toHaveLength(1);
  });

  it("requests 2.0 cannot act on are taken out of the reply and a notice says so", async () => {
    const c = core(tempDir("tags"));
    // (Teams, new bots and <open-question> are done since Phase 4b, <need-folder> since 4c, <suggest-component> since 5a;
    // the developer project's <app-screenshot/> is still not.)
    const { event } = await turn(c, "/say Asked for it.\n<app-screenshot/>");
    expect(event.text).toBe("Asked for it.");
    const chat = await c.chat();
    expect(chat.messages.at(-1)).toMatchObject({ role: "notice", text: "Botling 2.0 cannot do this yet, so nothing happened: a screenshot of the app." });
  });

  it("a reaction-only reply shows no line and puts the bot's reaction on the line it names; the user can react too", async () => {
    const dir = tempDir("tags");
    const c = core(dir);
    const first = await turn(c, "hello");
    const userLine = (await c.chat()).messages.find((m: { role: string; text: string }) => m.role === "user" && m.text === "hello");
    const { messageId } = await turn(c, `/react ${userLine.id}`);
    const chat = await c.chat();
    expect(chat.messages.some((m: { id: string }) => m.id === messageId)).toBe(false);
    expect(chat.messages.find((m: { id: string }) => m.id === userLine.id).reactions).toEqual([{ emoji: "👍", actor: "head:claude" }]);
    expect(await c.call({ type: "chat.react", botId: MAIN, messageId: first.messageId, emoji: "🎉", present: true })).toEqual({ changed: true });
    await expect(c.call({ type: "chat.react", botId: MAIN, messageId: first.messageId, emoji: "💩", present: true })).rejects.toThrow(/bad_request/);
    // The next message tells claude only what changed since (its own 👍 is not news).
    await turn(c, "next");
    const told = inputs(dir).at(-1)!;
    expect(told).toMatch(/Reactions changed since your last message/);
    expect(told).toContain("🎉");
    expect(told).not.toMatch(/"head:claude"/);
  });
});

describe("a message while a reply is written", () => {
  it("joins it: the turn so far stays cut off, and claude gets both parts as one message", async () => {
    const dir = tempDir("steer");
    const c = core(dir);
    const first = await c.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    await until(() => c.of("turn.delta").length >= 3);
    const second = await turn(c, "and also this");
    expect(second.event).toMatchObject({ status: "done", text: "You said: /slow\n\nand also this" });
    expect(inputs(dir).at(-1)).toMatch(/^\(I sent this in parts before you answered; here is all of it:\)\n\n\/slow\n\nand also this\n\n\(App: message_id/);
    const chat = await c.chat();
    const cut = chat.messages.find((m: { id: string }) => m.id === first.messageId);
    expect(cut).toMatchObject({ state: "stopped", interrupted: true });
    expect(cut.text).toMatch(/^word0 word1/);
    // The order: first message, its cut-off words, the second message, the one reply.
    expect(chat.messages.slice(-4).map((m: { role: string }) => m.role)).toEqual(["user", "bot", "user", "bot"]);
    // One card for both parts.
    expect(JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8")).length).toBeLessThanOrEqual(1);
  });

  it("waits while an approval is open, and goes once the turn ends", async () => {
    const c = core(tempDir("steer"));
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/tool echo hi" });
    const question = await until(() => c.of("message.added").map((e) => (e.event as { message: any }).message).find((m) => m.approval));
    const later = await c.call({ type: "chat.send", botId: MAIN, text: "after that" });
    expect(c.of("turn.started").some((e) => (e.event as { turnId: string }).turnId === later.turnId)).toBe(false);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 0 });
    await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
    const done = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === later.turnId));
    expect(done.event).toMatchObject({ status: "done", text: "You said: after that" });
    expect(await c.call({ type: "turn.await", botId: MAIN, turnId: later.turnId })).toEqual({ status: "done" });
  });
});

describe("subagents", () => {
  it("follows an Agent call into subagents.json; its step shows its status and tool count; its view has its work", async () => {
    const dir = tempDir("sub");
    const c = core(dir);
    const { messageId, event } = await turn(c, "/agent");
    expect(event.text).toBe("Sending a subagent. \n\nThe subagent found 3 things.");
    const saved = JSON.parse(readFileSync(join(dir, "main", "subagents.json"), "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ description: "Research the API", type: "general-purpose", prompt: "Look up the API and report", status: "completed", background: false, result: "Found 3 things.", agentID: "a1b2" });
    expect(typeof saved[0].startedAt).toBe("number");
    expect(saved[0].steps.map((s: { kind: string; title: string }) => [s.kind, s.title])).toEqual([["tool", "Read notes.md"], ["text", "Found 3 things."]]);
    const reply = (await c.chat()).messages.find((m: { id: string }) => m.id === messageId);
    expect(reply.steps).toEqual([expect.objectContaining({ kind: "subagent", title: "Research the API", status: "completed", count: 1, done: true })]);
    const { subagent } = await c.call({ type: "subagent.view", botId: MAIN, subagentId: saved[0].id });
    expect(subagent).toMatchObject({ title: "Research the API", owner: "Main bot", status: "completed", prompt: "Look up the API and report", result: "Found 3 things." });
    await expect(c.call({ type: "subagent.view", botId: MAIN, subagentId: "nope" })).rejects.toThrow(/not_found/);
    // Linked to the message's card.
    expect(JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8"))[0].subagentIDs).toEqual([saved[0].id]);
  });

  it("a background one reports later in claude's own turn, which shows in the chat; the bot waits for it before sleeping", async () => {
    const dir = tempDir("sub");
    const c = core(dir, { BOTLING_IDLE_MS: "100", FAKE_CLAUDE_BG_DELAY_MS: "600" });
    const { messageId, event } = await turn(c, "/bgagent");
    expect(event.text).toBe("Sending one to the background. \n\nIt is at work.");
    let reply = (await c.chat()).messages.find((m: { id: string }) => m.id === messageId);
    expect(reply.steps[0]).toMatchObject({ kind: "subagent", status: "running", done: false });
    expect((await c.call({ type: "chat.snapshot" })).bots[0].subagents).toBe(1);
    // Not asleep while it works (idle is 100 ms).
    const news = await until(() => (c.of("message.added").map((e) => (e.event as { message: any }).message).find((m) => m.text === "The background research finished: Found 3 things.")), { what: "the background report" });
    expect(news.role).toBe("bot");
    reply = (await c.chat()).messages.find((m: { id: string }) => m.id === messageId);
    expect(reply.steps[0]).toMatchObject({ status: "completed", count: 1, done: true });
    expect(c.events.some((e) => e.event.type === "bot.updated" && (e.event as any).bot.phase === "tidying" && e.seq < c.of("message.added").find((m) => (m.event as any).message.id === news.id)!.seq)).toBe(false);
  });

  it("claude's own turn that says only <no-reply/> shows nothing; a finished subagent's news is then asked for once", async () => {
    const dir = tempDir("sub");
    const c = core(dir, { FAKE_CLAUDE_BG_DELAY_MS: "200" });
    await turn(c, "/bgagent:silent");
    const reported = await until(() => c.of("turn.finished").map((e) => e.event as { text: string; messageId: string }).find((e) => e.text === "Reported: the subagent finished."), { what: "the report" });
    expect((await c.chat()).messages.find((m: { id: string }) => m.id === reported.messageId).role).toBe("bot");
    expect(inputs(dir).at(-1)).toBe("(App: Your subagent \"Research the API\" (completed) has finished, and you answered with nothing for the user (<no-reply/>), so they have not heard what came of it. A finished subagent's result always goes to the user: tell them now what it did, in a sentence or two. If its report says little (\"pending\", empty), check its work yourself first.)");
    const texts = (await c.chat()).messages.map((m: { text: string }) => m.text);
    expect(texts.some((text: string) => text.includes("no-reply"))).toBe(false);
  });
});

describe("the chat archive", () => {
  it("keeps every line in a markdown file a month, as the prompt tells the bot", async () => {
    const dir = tempDir("archive");
    const c = core(dir);
    await turn(c, "keep this");
    const folder = join(dir, "main", "archive");
    const files = readdirSync(folder);
    expect(files).toEqual([expect.stringMatching(/^\d{4}-\d{2}\.md$/)]);
    const text = readFileSync(join(folder, files[0]!), "utf8");
    expect(text).toMatch(/\] User: keep this\n\n/);
    expect(text).toMatch(/\] You: You said: keep this\n\n/);
  });
});

describe("the project lock", () => {
  it("a second 2.0 on the same project keeps working and only gets a notice (1.x has no lock)", async () => {
    const root = tempDir("lock");
    const folder = join(root, "garden");
    const a = join(root, "a");
    const b = join(root, "b");
    withProject(a, folder);
    withProject(b, folder);
    const first = core(a);
    await turn(first, "mine now", PROJECT);
    expect(JSON.parse(readFileSync(join(folder, ".bot", "botling.lock"), "utf8"))).toMatchObject({ app: "Botling 2.0", pid: first.child.pid });
    const second = core(b);
    const snapshot = await second.call({ type: "chat.snapshot", botId: PROJECT });
    const bot = snapshot.bots.find((candidate: { id: string }) => candidate.id === PROJECT);
    expect(bot.problem).toBeNull();
    expect((await turn(second, "me too", PROJECT)).event.status).toBe("done");
    expect(JSON.stringify(await second.call({ type: "chat.snapshot", botId: PROJECT }))).toMatch(/Another Botling \(Botling 2\.0, pid \d+\) has this project open\. Both may write/);
    // The main bot is not affected.
    expect((await turn(second, "hi")).event.status).toBe("done");
    await first.kill("SIGTERM");
    expect(existsSync(join(folder, ".bot", "botling.lock"))).toBe(false);
    expect((await turn(second, "now me", PROJECT)).event.status).toBe("done");
    expect((await second.call({ type: "chat.snapshot", botId: PROJECT })).bots.find((x: { id: string }) => x.id === PROJECT).problem).toBeNull();
  });

  it("a lock left by a core that is gone is taken over", async () => {
    const root = tempDir("lock");
    const folder = join(root, "garden");
    const data = join(root, "a");
    withProject(data, folder);
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "botling.lock"), JSON.stringify({ app: "Botling 2.0", pid: 999_999, started: "x", host: (await import("node:os")).hostname(), dataDir: "/gone", at: "" }));
    const c = core(data);
    expect((await turn(c, "hello", PROJECT)).event.status).toBe("done");
  });

  it("a running 1.x that has the project does not stop the 2.0 bot (notice only)", async () => {
    const root = tempDir("lock");
    const folder = join(root, "garden");
    const data = join(root, "a");
    withProject(data, folder);
    const oneX = join(root, "claudecodebot");
    mkdirSync(oneX, { recursive: true });
    writeFileSync(join(oneX, "projects.json"), JSON.stringify([{ id: PROJECT, name: "garden", folder: pathToFileURL(folder).href + "/", avatar: "hexagon" }]));
    // A stand-in for the 1.x app: a process whose command line the check is told to look for.
    const standIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "botling-1x-stand-in"], { stdio: "ignore" });
    others.push(standIn);
    const c = core(data, { BOTLING_1X_DIR: oneX, BOTLING_1X_PROCESS: "botling-1x-stand-in" });
    const bot = (await c.call({ type: "chat.snapshot", botId: PROJECT })).bots.find((x: { id: string }) => x.id === PROJECT);
    expect(bot.problem).toBeNull();
    expect((await turn(c, "hi", PROJECT)).event.status).toBe("done");
    expect(JSON.stringify(await c.call({ type: "chat.snapshot", botId: PROJECT }))).toMatch(/Botling 1\.x is running and has this project open\. Both may write/);
    standIn.kill("SIGKILL");
    await until(() => standIn.exitCode !== null || standIn.signalCode !== null);
    expect((await turn(c, "1.x quit", PROJECT)).event.status).toBe("done");
  });
});

describe("streaming text", () => {
  it("never shows a tag the app takes out, not even half written", () => {
    expect(streamingText("Pick one.\n<cho")).toBe("Pick one.");
    expect(streamingText("Pick one.\n<choices>\n* A | x\n")).toBe("Pick one.");
    expect(streamingText("Pick one.\n<choices>\n* A | x\n</choices>")).toBe("Pick one.");
    expect(streamingText("On it.\n<task name=\"Docs\" now=\"wri")).toBe("On it.");
    expect(streamingText("On it.\n<task name=\"Docs\"/>\nMore")).toBe("On it.\n\nMore");
    expect(streamingText("a < b and 3 <4")).toBe("a < b and 3 <4");
    expect(streamingText("Use `<choices>` like this")).toBe("Use `<choices>` like this");
    expect(streamingText("```\n<choices>\n* example")).toBe("```\n<choices>\n* example");
  });
});
