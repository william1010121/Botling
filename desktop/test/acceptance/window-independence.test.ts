// Acceptance check 3 (M1 brief §5), the headless stand-in for "close the window during a turn": Botling 3's window
// main (main-v3 ServerClient + renderer adapter, fake renderer port, durable fe-link storage in the window's profile
// folder) sends a chat.send through the built botlingd (fake engine, no window); while the reply streams the client is
// stopped (the window closes: `bye`, socket closed). `botlingd status` must show the turn running; the turn must finish
// without any window; a new window main on the same profile folder (its saved cursor) must show the finished reply
// once, with no duplicate line, and receive only entries after its cursor, each once.
//
//   V3_ACCEPT_RUNS (3), V3_ACCEPT_WORDS (400), V3_ACCEPT_RUNTIME=electron, V3_ACCEPT_REPORT_DIR
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteFeStorage } from "../../src/fe-link/sqlite-storage";
import type { StreamId } from "../../src/protocol";
import { until } from "../helpers";
import { cli, Daemon, openLink, killPids, LoadSampler, MAIN, openWindow, removeTree, runtimeOf, scriptedWords, sleep, testRoot, writeReport } from "./m1-accept";

const RUNS = Number(process.env.V3_ACCEPT_RUNS || 3);
const WORDS = Number(process.env.V3_ACCEPT_WORDS || 400);
const stream = `bot:${MAIN}` as StreamId;

interface Line { id: string; role: string; text: string }

async function oneRun(run: number, root: string) {
  const dir = join(root, `run-${run}`);
  const dataDir = join(dir, "data");
  const appData = join(dir, "app");
  const inputLog = join(dir, "engine-input.jsonl");
  const pidFile = join(dir, "engine.pids");
  const daemon = new Daemon(dataDir, { FAKE_CLAUDE_INPUT: inputLog, FAKE_CLAUDE_PIDS: pidFile });
  await daemon.ready();
  const reply = scriptedWords(WORDS, `r${run}w`);
  const text = `/say ${reply}`;

  // Window 1: send, watch the reply stream, close mid-turn.
  const first = await openWindow(dataDir, appData);
  const snap1 = await first.client.request({ type: "chat.snapshot", botId: MAIN });
  expect(snap1.ok, first.audit.join("\n")).toBe(true);
  const sentAt = Date.now();
  const send = await first.client.request({ type: "chat.send", botId: MAIN, text });
  expect(send.ok).toBe(true);
  const link1 = first.client.linkForTests!;
  await until(() => (link1.live(stream)?.view.text.length ?? 0) > reply.length * 0.15 || null, { timeout: 60_000, every: 10, what: "the reply streaming" });
  const liveAtClose = link1.live(stream)!.view.text;
  const cursorAtClose = link1.cursor(stream);
  const closedAt = Date.now();
  await first.client.stop();

  // No window: status shows the turn running.
  const status = JSON.parse(cli(dataDir, ["status", "--json"]).stdout) as { running: boolean; turns: Array<{ botId: string; turnId: string; state: string; liveChars: number }> };
  const runningTurn = status.turns.find((turn) => turn.botId === MAIN);
  // The turn finishes by itself.
  await until(() => {
    const now = JSON.parse(cli(dataDir, ["status", "--json"]).stdout) as { turns: unknown[] };
    return now.turns.length === 0 || null;
  }, { timeout: 120_000, every: 250, what: "the turn finishing with no window" });
  const finishedAt = Date.now();

  // The saved cursor (the window's own storage file). First a front end on the real fe-link resumes from it (the
  // window's link, without the adapter): only entries after the cursor, each once, the finished reply among them.
  const saved = new SqliteFeStorage(join(appData, "electron", "fe-link.sqlite"));
  const savedState = await saved.load();
  await saved.close();
  const savedCursor = savedState.cursors[stream] ?? null;
  const resumed = await openLink(dataDir, join(appData, "electron", "fe-link.sqlite"), { deviceId: "desktop" });
  const batches: number[] = [];
  let snapOnResume = false;
  let finishedText: string | null = null;
  resumed.link.on((event) => {
    if (event.type === "entries" && event.stream === stream) {
      for (const entry of event.entries) {
        batches.push(entry.seq);
        if (entry.kind === "turn.finished") finishedText = (entry.body as { text: string }).text;
      }
    }
    if (event.type === "snap" && event.snap.stream === stream) snapOnResume = true;
  });
  resumed.link.subscribe(stream);
  resumed.link.start();
  await until(() => finishedText !== null || snapOnResume || null, { timeout: 30_000, what: "catch-up from the saved cursor" });
  await sleep(500);
  await resumed.link.close();

  // Then window 2 (main-v3 adapter, which keeps no cache across processes, so it takes the bot stream's snap) on the
  // same profile folder: what the renderer is shown.
  const second = await openWindow(dataDir, appData);
  const link2 = second.client.linkForTests!;
  const snap2 = await second.client.request({ type: "chat.snapshot", botId: MAIN });
  expect(snap2.ok, second.audit.join("\n")).toBe(true);
  await sleep(1_000);
  const lines = ((snap2 as { result: { chat: { messages: Line[] } } }).result.chat.messages);
  const userLines = lines.filter((line) => line.role === "user" && line.text === text);
  const replies = lines.filter((line) => line.role !== "user" && line.text.includes(`r${run}w0001`));
  const ids = lines.map((line) => line.id);
  // What the renderer was fed by window 2: the same reply once (snapshot lines + events after it).
  const pendingLeft = link2.pending(stream).filter((item) => item.state !== "delivered");
  await second.client.stop();
  const engineReads = readFileSync(inputLog, "utf8").split("\n").filter((l) => l.includes(`r${run}w0001`)).length;
  const stopped = await daemon.stop();
  killPids(pidFile);

  const gapless = batches.every((seq, i) => i === 0 ? seq === (savedCursor?.seq ?? 0) + 1 : seq === batches[i - 1] + 1);
  return {
    run, words: WORDS, msSendToClose: closedAt - sentAt, liveCharsAtClose: liveAtClose.length, replyChars: reply.length, cursorAtClose,
    statusWhileClosed: { running: status.running, turn: runningTurn ?? null }, msClosedToFinished: finishedAt - closedAt,
    savedCursor, resumeFromCursor: {
      snapInsteadOfCatchUp: snapOnResume, finishedReplyExact: finishedText === reply, entriesAfterCursor: batches.length, firstSeq: batches[0] ?? null, lastSeq: batches.at(-1) ?? null,
      duplicateSeqs: batches.length - new Set(batches).size, gapless,
    },
    shown: { lines: lines.length, duplicateIds: ids.length - new Set(ids).size, userLines: userLines.length, replies: replies.length, replyExact: replies.length === 1 && replies[0].text === reply },
    pendingLeft: pendingLeft.length, engineReads, stopCode: stopped.code,
  };
}

describe("acceptance check 3: closing the window does not stop the turn", () => {
  it("a window main closed mid-turn; status shows it running; reopened from its cursor: the finished reply once", async () => {
    const root = testRoot("v3-accept-window");
    const load = new LoadSampler().start();
    const runs: Array<Awaited<ReturnType<typeof oneRun>>> = [];
    try {
      for (let run = 1; run <= RUNS; run++) runs.push(await oneRun(run, root));
    } finally {
      console.log(`report: ${writeReport(`window-independence-${runtimeOf()}`, { runtime: runtimeOf(), load: load.stop(), runs })}`);
      removeTree(root);
    }
    for (const r of runs) {
      expect(r.statusWhileClosed.running).toBe(true);
      expect(r.statusWhileClosed.turn?.state).toBe("started");
      expect(r.liveCharsAtClose).toBeLessThan(r.replyChars);
      expect(r.resumeFromCursor.snapInsteadOfCatchUp).toBe(false);
      expect(r.resumeFromCursor.finishedReplyExact).toBe(true);
      expect(r.resumeFromCursor.firstSeq).toBe((r.savedCursor?.seq ?? -1) + 1);
      expect(r.resumeFromCursor.duplicateSeqs).toBe(0);
      expect(r.resumeFromCursor.gapless).toBe(true);
      expect(r.shown.duplicateIds).toBe(0);
      expect(r.shown.userLines).toBe(1);
      expect(r.shown.replies).toBe(1);
      expect(r.shown.replyExact).toBe(true);
      expect(r.engineReads).toBe(1);
      expect(r.pendingLeft).toBe(0);
      expect(r.stopCode).toBe(0);
    }
  });
});
