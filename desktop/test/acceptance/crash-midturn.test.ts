// Acceptance check 4 (M1 brief §5): a crash mid-turn. Botling 3's window main (main-v3 ServerClient + renderer
// adapter, fake renderer port) sends a chat.send whose scripted reply streams for ~15–20 s through the built botlingd
// (fake engine, no window). After a random 5–10 s of streaming botlingd is killed with SIGKILL, then started again
// after a random pause. Measured:
//
// - the window: its link goes to "connecting" and the renderer is shown the "Connecting to the Botling server…" notice;
//   the chat.send item is never "not sent" (failed), it stays delivered (or settled) throughout;
// - after the restart: exactly one `turn.interrupted` for the turn and no `turn.finished`; its text is a prefix of the
//   scripted reply; the text missing = what the window had already seen live at the kill minus the interrupted text,
//   also as time (the kill time minus when the window first saw that much text);
// - not restarted: no second `turn.started` for the bot within 10 s of the restart, and the engine read the message once.
//
//   V3_ACCEPT_RUNS (5), V3_ACCEPT_WORDS (1200), V3_ACCEPT_RUNTIME=electron, V3_ACCEPT_REPORT_DIR
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { until } from "../helpers";
import { Daemon, killPids, LoadSampler, MAIN, openWindow, readDb, removeTree, runtimeOf, scriptedWords, sleep, testRoot, writeReport } from "./m1-accept";

const RUNS = Number(process.env.V3_ACCEPT_RUNS || 5);
const WORDS = Number(process.env.V3_ACCEPT_WORDS || 1200);
const stream = `bot:${MAIN}` as StreamId;
const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

async function oneRun(run: number, root: string) {
  const dir = join(root, `run-${run}`);
  const dataDir = join(dir, "data");
  const appData = join(dir, "app");
  const inputLog = join(dir, "engine-input.jsonl");
  const pidFile = join(dir, "engine.pids");
  const extra = { FAKE_CLAUDE_INPUT: inputLog, FAKE_CLAUDE_PIDS: pidFile };
  let daemon = new Daemon(dataDir, extra);
  await daemon.ready();
  const reply = scriptedWords(WORDS, `k${run}w`);
  const text = `/say ${reply}`;

  const window = await openWindow(dataDir, appData);
  expect((await window.client.request({ type: "chat.snapshot", botId: MAIN })).ok, window.audit.join("\n")).toBe(true);
  const link = window.client.linkForTests!;
  const live: Array<{ at: number; chars: number }> = [];
  const states: Array<{ at: number; state: string }> = [];
  const itemStates = new Map<string, string>();
  const everNotSent: string[] = [];
  const itemHistory: string[] = [];
  const t0 = Date.now();
  const watchItems = () => {
    for (const item of link.pending(stream)) {
      if (itemStates.get(item.key) !== item.state) { itemStates.set(item.key, item.state); itemHistory.push(`${Date.now() - t0}ms ${item.state}`); }
      if (item.state === "not sent") everNotSent.push(`${item.key}: ${item.reason ?? ""}`);
    }
  };
  link.on((event) => {
    if (event.type === "live" && event.stream === stream && event.view) live.push({ at: Date.now(), chars: event.view.text.length });
    if (event.type === "state") states.push({ at: Date.now(), state: event.status.state });
    if (event.type === "pending" || event.type === "outcome" || event.type === "state") watchItems();
  });
  const send = await window.client.request({ type: "chat.send", botId: MAIN, text });
  expect(send.ok).toBe(true);
  const sentAt = Date.now();
  await until(() => live.length > 0 || null, { timeout: 60_000, every: 10, what: "the reply streaming" });
  const streamStart = live[0].at;
  const streamFor = rand(5_000, 10_000);
  await until(() => Date.now() - streamStart >= streamFor || null, { timeout: 60_000, every: 10, what: "streaming long enough" });
  const seenAtKill = link.live(stream)?.view.text ?? "";
  const itemsAtKill = link.pending(stream).map((item) => item.state);
  const killAt = Date.now();
  daemon.kill();
  await daemon.exited();
  const pauseMs = rand(1_000, 3_000);
  await sleep(pauseMs);
  const statesWhileDown = states.filter((s) => s.at >= killAt).map((s) => s.state);
  const noticeShown = window.events.some((e) => e.at >= killAt && e.envelope.event.type === "message.updated" && (e.envelope.event as { message: { text: string } }).message.text.startsWith("Connecting to the Botling server"));
  const itemsWhileDown = link.pending(stream).map((item) => item.state);
  daemon = new Daemon(dataDir, extra);
  const restartMs = await daemon.ready();
  const restartedAt = Date.now();
  await until(() => link.status.state === "live" || null, { timeout: 60_000, what: "the window live again" });
  const liveAgainMs = Date.now() - restartedAt;
  await sleep(10_000);
  const noticeRemoved = window.events.some((e) => e.at >= restartedAt && e.envelope.event.type === "message.removed");
  const snap = await window.client.request({ type: "chat.snapshot", botId: MAIN });
  const shownReply = ((snap as { result: { chat: { messages: Array<{ role: string; text: string }> } } }).result.chat.messages).filter((m) => m.role !== "user" && m.text.startsWith(`k${run}w0001`));
  const shownUser = ((snap as { result: { chat: { messages: Array<{ role: string; text: string }> } } }).result.chat.messages).filter((m) => m.role === "user" && m.text === text);
  watchItems();
  const itemsAfter = link.pending(stream).map((item) => item.state);
  await window.client.stop();
  const stopped = await daemon.stop();
  killPids(pidFile);

  const entries = readDb(dataDir, (db) => db.prepare("SELECT seq, kind, body FROM entries WHERE stream = ? ORDER BY seq").all(stream) as Array<{ seq: number; kind: string; body: string }>);
  const parsed = entries.map((e) => ({ seq: e.seq, kind: e.kind, body: JSON.parse(e.body) as { turnId?: string; text?: string } }));
  const started = parsed.filter((e) => e.kind === "turn.started");
  const turnId = started[0]?.body.turnId;
  const interrupted = parsed.filter((e) => e.kind === "turn.interrupted" && e.body.turnId === turnId);
  const finished = parsed.filter((e) => e.kind === "turn.finished" && e.body.turnId === turnId);
  const itext = interrupted[0]?.body.text ?? "";
  const reached = live.find((sample) => sample.chars >= itext.length);
  const engineReads = readFileSync(inputLog, "utf8").split("\n").filter((l) => l.includes(`k${run}w0001`)).length;
  return {
    run, words: WORDS, replyChars: reply.length, msSendToStream: streamStart - sentAt, msStreamedBeforeKill: killAt - streamStart, pauseMs, restartMs, liveAgainMs,
    seenAtKillChars: seenAtKill.length, interruptedChars: itext.length, interruptedIsPrefix: reply.startsWith(itext), seenAtKillIsPrefix: reply.startsWith(seenAtKill),
    missingChars: Math.max(0, seenAtKill.length - itext.length), missingMs: itext.length >= seenAtKill.length ? 0 : reached ? killAt - reached.at : killAt - streamStart,
    turnsStarted: started.length, interrupted: interrupted.length, finished: finished.length, engineReads,
    window: {
      statesWhileDown: [...new Set(statesWhileDown)], noticeShown, noticeRemoved, itemsAtKill, itemsWhileDown, itemsAfter, itemHistory, killAtMs: killAt - t0, everNotSent,
      shownReplies: shownReply.length, shownReplyIsInterruptedText: shownReply.length === 1 && shownReply[0].text === itext, shownUserLines: shownUser.length,
    },
    stopCode: stopped.code,
  };
}

describe("acceptance check 4: SIGKILL botlingd mid-turn", () => {
  it("one interrupted, ≤ ~5 s of text missing, not restarted; the window shows connecting and never failed", async () => {
    const root = testRoot("v3-accept-midturn");
    const load = new LoadSampler().start();
    const runs: Array<Awaited<ReturnType<typeof oneRun>>> = [];
    try {
      for (let run = 1; run <= RUNS; run++) runs.push(await oneRun(run, root));
    } finally {
      console.log(`report: ${writeReport(`crash-midturn-${runtimeOf()}`, { runtime: runtimeOf(), load: load.stop(), runs })}`);
      removeTree(root);
    }
    for (const r of runs) {
      expect(r.turnsStarted).toBe(1);
      expect(r.interrupted).toBe(1);
      expect(r.finished).toBe(0);
      expect(r.interruptedIsPrefix).toBe(true);
      expect(r.missingMs).toBeLessThanOrEqual(5_500);
      expect(r.engineReads).toBe(1);
      expect(r.window.statesWhileDown).toContain("connecting");
      expect(r.window.statesWhileDown).not.toContain("offline");
      expect(r.window.noticeShown).toBe(true);
      expect(r.window.everNotSent).toEqual([]);
      expect(r.window.shownReplies).toBe(1);
      expect(r.window.shownUserLines).toBe(1);
      expect(r.stopCode).toBe(0);
    }
  });
});
