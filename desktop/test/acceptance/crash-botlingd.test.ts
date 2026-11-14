// Acceptance check 2 (M1 brief §5): nothing lost, nothing doubled. Each run starts the built botlingd (fake engine,
// no window) on a fresh data folder; a front end on the real fe-link (durable node:sqlite outbox, Unix socket) sends
// 200 scripted commands (chat.send, and chat.react on lines it has seen) at a random pace while botlingd is killed
// with SIGKILL 1–3 times at random points and restarted after a random pause. The front end keeps sending into its
// outbox while the server is down and resumes on its own (re-attach, resend). In odd runs the front end is also
// closed at the first kill and reopened from its storage file (a window restart). After the run settles, botlingd is
// stopped and server.db is read:
//
// - lost: commands the front end got an `applied` outcome for (acknowledged) without their entries in the log;
// - applied twice: a slot with two entries of one kind, or a chat.send whose user line is there twice (by slot or text);
// - shown as failed when delivered: an item the outbox ever showed as "not sent" although its outcome was `applied`,
//   or any "not sent" at all (none is expected: nothing here is refusable);
// - never answered: a durably submitted command without an outcome when the run ended.
//
//   V3_ACCEPT_RUNS (20), V3_ACCEPT_COMMANDS (200), V3_ACCEPT_RUNTIME=electron, V3_ACCEPT_REPORT_DIR
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { FeLink, FeLinkEvent } from "../../src/fe-link";
import type { SqliteFeStorage } from "../../src/fe-link/sqlite-storage";
import { slotKey, type Outcome, type Slot, type StreamId } from "../../src/protocol";
import { until } from "../helpers";
import { Daemon, killPids, LoadSampler, MAIN, openLink, readDb, removeTree, sleep, strays, testRoot, writeReport, runtimeOf } from "./m1-accept";

const RUNS = Number(process.env.V3_ACCEPT_RUNS || 20);
const COMMANDS = Number(process.env.V3_ACCEPT_COMMANDS || 200);
const stream = `bot:${MAIN}` as StreamId;

interface Sent { i: number; cmd: Command; durableAt: number; outcome?: string; outcomeAt?: number; why?: string }
interface RunReport {
  run: number; kills: Array<{ atCommand: number; msAfterStart: number; ackedBefore: number; restartMs: number; pauseMs: number }>;
  clientRestart: boolean; submitted: number; sends: number; reacts: number; acked: number; lost: string[]; appliedTwice: string[];
  shownFailed: string[]; notSent: string[]; missingInCoreChat: string[]; twiceInCoreChat: string[]; coreUserLines: number; kept?: string; neverAnswered: string[]; ackedNoReceipt: string[]; userLines: number; distinctUserTexts: number;
  entries: number; integrity: string; durationMs: number; strays: number;
}

const whyOf = (outcome: Outcome) => outcome.kind === "refused" ? `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}` : undefined;
const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

async function oneRun(run: number, root: string): Promise<RunReport> {
  const dir = join(root, `run-${run}`);
  const dataDir = join(dir, "data");
  const storageFile = join(dir, "fe-link.sqlite");
  const pidFile = join(dir, "engine.pids");
  const extra = { FAKE_CLAUDE_PIDS: pidFile };
  const started = Date.now();
  let daemon = new Daemon(dataDir, extra);
  await daemon.ready();

  const sent = new Map<string, Sent>();
  const failedSeen = new Set<string>();
  const early = new Map<string, Outcome>();
  const userLines: string[] = [];
  let link!: FeLink;
  let storage!: SqliteFeStorage;
  const onEvent = (event: FeLinkEvent) => {
    if (event.type === "outcome") {
      const key = slotKey(event.item.slot);
      const s = sent.get(key);
      if (s && !s.outcome && event.item.outcome) { s.outcome = event.item.outcome.kind; s.outcomeAt = Date.now(); s.why = whyOf(event.item.outcome); }
      if (!s && event.item.outcome) early.set(key, event.item.outcome);
    }
    if (event.type === "pending" || event.type === "outcome") {
      for (const item of link.pending()) if (item.state === "not sent") failedSeen.add(item.key);
    }
    if (event.type === "entries" && event.stream === stream) {
      for (const entry of event.entries) {
        const message = (entry.body as { message?: { id: string; role: string } }).message;
        if (entry.kind === "message.added" && message?.role === "user" && !message.id.startsWith("pending")) userLines.push(message.id);
      }
    }
  };
  const attach = async () => {
    ({ link, storage } = await openLink(dataDir, storageFile));
    link.on(onEvent);
    link.subscribe(stream);
    link.start();
  };
  await attach();

  const killCount = rand(1, 3);
  const killAt = new Set<number>();
  while (killAt.size < killCount) killAt.add(rand(5, COMMANDS - 5));
  const clientRestart = run % 2 === 1;
  const kills: RunReport["kills"] = [];
  let restarting: Promise<void> | null = null;
  let reacts = 0;
  let sends = 0;

  for (let i = 0; i < COMMANDS; i++) {
    if (killAt.has(i)) {
      if (restarting) await restarting;
      const ackedBefore = [...sent.values()].filter((s) => s.outcome === "applied").length;
      daemon.kill();
      await daemon.exited();
      const pauseMs = rand(0, 1_500);
      const record = { atCommand: i, msAfterStart: Date.now() - started, ackedBefore, restartMs: 0, pauseMs };
      kills.push(record);
      const windowRestart = clientRestart && kills.length === 1;
      if (windowRestart) { await link.stop(); await storage.close(); }
      restarting = (async () => {
        await sleep(pauseMs);
        daemon = new Daemon(dataDir, extra);
        record.restartMs = await daemon.ready();
        if (windowRestart) await attach();
      })();
      if (windowRestart) { await restarting; restarting = null; }
    }
    const known = userLines.length ? userLines[rand(0, userLines.length - 1)] : null;
    const cmd: Command = known && Math.random() < 0.2
      ? { type: "chat.react", botId: MAIN, messageId: known, emoji: "👍", present: Math.random() < 0.5 } as Command
      : { type: "chat.send", botId: MAIN, text: `/say ok r${run} c${i}` } as Command;
    if (cmd.type === "chat.react") reacts++; else sends++;
    const item = await link.submit(stream, cmd);
    const key = slotKey(item.slot);
    const outcome = early.get(key);
    sent.set(key, { i, cmd, durableAt: Date.now(), ...(outcome ? { outcome: outcome.kind, outcomeAt: Date.now(), why: whyOf(outcome) } : {}) });
    await sleep(rand(5, 45));
  }
  if (restarting) await restarting;
  await until(() => [...sent.values()].every((s) => s.outcome) || null, { timeout: 240_000, every: 50, what: `run ${run}: every command answered` }).catch(() => undefined);
  // Let the turns drain so the log holds every user line's turn too (not needed for the counts, keeps the kill clean).
  await sleep(500);
  await link.stop();
  await storage.close();
  const stopped = await daemon.stop();
  if (stopped.code !== 0) throw new Error(`run ${run}: botlingd stop exited ${stopped.code ?? stopped.signal}\n${daemon.stderr}`);

  const db = readDb(dataDir, (db) => ({
    entries: db.prepare("SELECT seq, kind, body, slot FROM entries WHERE stream = ? ORDER BY seq").all(stream) as Array<{ seq: number; kind: string; body: string; slot: string | null }>,
    receipts: db.prepare("SELECT origin, originEpoch, target, n, outcome FROM receipts").all() as Array<{ origin: string; originEpoch: string; target: string; n: number; outcome: string }>,
    chatRows: db.prepare("SELECT key, body, deleted FROM rows WHERE stream = ?").all(`chat:${MAIN}`) as Array<{ key: string; body: string | null; deleted: number }>,
    integrity: String((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check),
  }));
  const bySlot = new Map<string, string[]>();
  const userTexts = new Map<string, number>();
  let userCount = 0;
  for (const entry of db.entries) {
    if (entry.slot) {
      const key = slotKey(JSON.parse(entry.slot) as Slot);
      bySlot.set(key, [...(bySlot.get(key) ?? []), entry.kind]);
    }
    if (entry.kind === "message.added") {
      const message = (JSON.parse(entry.body) as { message?: { role: string; text: string } }).message;
      if (message?.role === "user") { userCount++; userTexts.set(message.text, (userTexts.get(message.text) ?? 0) + 1); }
    }
  }
  // The core's own copy of the chat (DbBotStore rows, what chat.snapshot, chat.json and the core's commands read).
  const coreTexts = new Map<string, number>();
  for (const row of db.chatRows) {
    if (row.deleted || !row.body) continue;
    const record = (JSON.parse(row.body) as { record?: { role?: string; text?: string } }).record;
    if (record?.role === "user" && record.text) coreTexts.set(record.text, (coreTexts.get(record.text) ?? 0) + 1);
  }
  const missingInCoreChat: string[] = [];
  const twiceInCoreChat: string[] = [];
  for (const [key, s] of sent) {
    if (s.cmd.type !== "chat.send" || s.outcome !== "applied") continue;
    const text = (s.cmd as { text: string }).text;
    const n = coreTexts.get(text) ?? 0;
    if (n === 0) missingInCoreChat.push(`#${s.i} ${key.split("\u0000").pop()}: "${text}"`);
    if (n > 1) twiceInCoreChat.push(`#${s.i}: "${text}" ×${n}`);
  }
  const receiptKeys = new Set(db.receipts.map((r) => slotKey({ origin: r.origin, originEpoch: r.originEpoch, target: r.target, n: r.n } as Slot)));
  const lost: string[] = [];
  const twice: string[] = [];
  const neverAnswered: string[] = [];
  const ackedNoReceipt: string[] = [];
  for (const [key, s] of sent) {
    const kinds = bySlot.get(key) ?? [];
    if (!s.outcome) neverAnswered.push(`${key} (#${s.i} ${s.cmd.type})`);
    if (s.outcome === "applied" && !receiptKeys.has(key)) ackedNoReceipt.push(key);
    const dup = kinds.find((kind, index) => kinds.indexOf(kind) !== index);
    if (dup) twice.push(`${key}: ${dup} ×${kinds.filter((k) => k === dup).length}`);
    if (s.cmd.type === "chat.send") {
      const text = (s.cmd as { text: string }).text;
      const n = userTexts.get(text) ?? 0;
      if (s.outcome === "applied" && (n === 0 || !kinds.includes("message.added"))) lost.push(`${key} (#${s.i}: "${text}" lines=${n})`);
      if (n > 1) twice.push(`${key}: "${text}" ×${n}`);
    } else if (s.outcome === "applied" && kinds.length === 0) lost.push(`${key} (#${s.i} chat.react: no entry)`);
  }
  const notSent = [...sent].filter(([, s]) => s.outcome && s.outcome !== "applied").map(([key, s]) => `#${s.i} ${s.cmd.type} ${JSON.stringify(s.cmd).slice(0, 160)}: ${s.outcome} ${s.why ?? ""}`);
  const shownFailed = [...failedSeen].filter((key) => sent.get(key)?.outcome === "applied");
  const left = killPids(pidFile);
  return {
    run, kills, clientRestart, submitted: sent.size, sends, reacts, acked: [...sent.values()].filter((s) => s.outcome === "applied").length,
    lost, appliedTwice: twice, shownFailed, notSent: [...notSent, ...[...failedSeen].filter((k) => !shownFailed.includes(k)).map((k) => `${k}: shown not sent`)],
    neverAnswered, ackedNoReceipt, missingInCoreChat, twiceInCoreChat, coreUserLines: [...coreTexts.values()].reduce((a, b) => a + b, 0), userLines: userCount, distinctUserTexts: userTexts.size, entries: db.entries.length, integrity: db.integrity,
    durationMs: Date.now() - started, strays: left,
  };
}

describe("acceptance check 2: SIGKILL botlingd under a scripted front end", () => {
  it(`${RUNS} runs × ${COMMANDS} commands: 0 lost, 0 applied twice, 0 shown failed`, async () => {
    const root = testRoot("v3-accept-crash");
    const load = new LoadSampler().start();
    const runs: RunReport[] = [];
    try {
      for (let run = 1; run <= RUNS; run++) {
        const report = await oneRun(run, root);
        runs.push(report);
        console.log(`run ${run}: coreMissing ${report.missingInCoreChat.length} coreTwice ${report.twiceInCoreChat.length} kills ${report.kills.map((k) => `#${k.atCommand}`).join(",")} acked ${report.acked}/${report.submitted} lost ${report.lost.length} twice ${report.appliedTwice.length} failed ${report.shownFailed.length} notSent ${report.notSent.length} unanswered ${report.neverAnswered.length} ${report.durationMs} ms`);
        const anomaly = report.lost.length + report.appliedTwice.length + report.notSent.length + report.missingInCoreChat.length + report.twiceInCoreChat.length > 0;
        if (anomaly && process.env.V3_ACCEPT_KEEP) report.kept = join(root, `run-${run}`);
        else removeTree(join(root, `run-${run}`));
      }
    } finally {
      const file = writeReport(`crash-botlingd-${runtimeOf()}`, { runtime: runtimeOf(), runs: runs.length, commands: COMMANDS, load: load.stop(), strays: strays(), results: runs });
      console.log(`report: ${file}`);
      if (!runs.some((r) => r.kept)) { removeTree(root); expect(existsSync(root)).toBe(false); }
    }
    const sum = (f: (r: RunReport) => number) => runs.reduce((a, r) => a + f(r), 0);
    expect(runs.length).toBe(RUNS);
    expect(sum((r) => r.lost.length)).toBe(0);
    expect(sum((r) => r.appliedTwice.length)).toBe(0);
    expect(sum((r) => r.shownFailed.length)).toBe(0);
    expect(sum((r) => r.notSent.length)).toBe(0);
    expect(sum((r) => r.neverAnswered.length)).toBe(0);
    expect(sum((r) => r.ackedNoReceipt.length)).toBe(0);
    expect(sum((r) => r.missingInCoreChat.length)).toBe(0);
    expect(sum((r) => r.twiceInCoreChat.length)).toBe(0);
    for (const r of runs) expect(r.integrity).toBe("ok");
  });
});
