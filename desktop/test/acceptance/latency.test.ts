// Acceptance check 6 (M1 brief §5): speed. The built botlingd (fake engine, no window) runs with server.db on the
// INTERNAL disk (a temp folder under the OS temp dir, deleted afterwards; never the external SSD, D43), with the
// test-only preload commit-timer.cjs timing every server.db write transaction at the node:sqlite boundary
// (BEGIN IMMEDIATE → COMMIT, and COMMIT alone, which is the WAL flush with synchronous = FULL, fullfsync = ON).
//
// Phase 1, command rates: a scripted front end sends chat.react commands (an intent each: entries + receipt + the
// core's rows in one transaction) at 20, 100, 250 and 500 commands/s for ~8 s each, and measures each command's ack
// delay (cmd sent → cmd.result). Reported per rate: commit p50/p95/p99/max (server side), ack delay percentiles, batch
// sizes, and the 1-minute load average during the phase.
// Phase 2, streaming: four bots stream long replies at once while the front end, subscribed to all four, keeps
// sending chat.react at 50/s. Reported: live frames per second on the connection (max in any 1 s window) and per
// stream, plus commit and ack delay under streaming.
//
//   V3_ACCEPT_RATES (20,100,250,500), V3_ACCEPT_PHASE_MS (8000), V3_ACCEPT_RUNTIME=electron, V3_ACCEPT_REPORT_DIR
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Message, MessageOf, Slot } from "../../src/protocol";
import { until } from "../helpers";
import { WRITER_PRAGMAS } from "../../src/server/store/connection";
import { DatabaseSync } from "node:sqlite";
import { Daemon, MAIN, percentiles, removeTree, runtimeOf, scriptedWords, ScriptClient, sleep, summarizeLoad, writeReport } from "./m1-accept";

const RATES = (process.env.V3_ACCEPT_RATES || "20,100,250,500").split(",").map(Number);
const PHASE_MS = Number(process.env.V3_ACCEPT_PHASE_MS || 8_000);
const preload = resolve(__dirname, "commit-timer.cjs");

interface Commit { at: number; txnMs: number; commitMs: number; size: number }

describe("acceptance check 6: commit latency on the internal disk, live frame rate", () => {
  it("commit p99 ≤ 20 ms at several rates; live frames ≤ 10/s per connection with four bots streaming", async () => {
    const root = mkdtempSync(join(tmpdir(), "v3-accept-latency-"));
    const dataDir = join(root, "data");
    const commitLog = join(root, "commits.jsonl");
    const disk = spawnSync("df", ["-h", tmpdir()], { encoding: "utf8" }).stdout.trim().split("\n").pop()!.split(/\s+/);
    const report: Record<string, unknown> = { runtime: runtimeOf(), dataOn: "OS temp folder (internal disk)", filesystem: disk[0], diskFree: disk[3], phaseMs: PHASE_MS };
    let daemon: Daemon | null = null;
    try {
      report.bareFlushBefore = bareFlush(join(root, "bare-before.db"));
      console.log(JSON.stringify({ bareFlushBefore: report.bareFlushBefore }));
      daemon = new Daemon(dataDir, { NODE_OPTIONS: `--require ${preload}`, V3_COMMIT_LOG: commitLog });
      await daemon.ready();
      const client = new ScriptClient("accept");
      const sentAt = new Map<number, number>();
      const ack: Array<{ at: number; ms: number }> = [];
      const live: Array<{ at: number; stream: string }> = [];
      const push = client.received.push.bind(client.received);
      client.received.push = (...messages: Message[]) => {
        const now = performance.now();
        for (const m of messages) {
          if (m.t === "cmd.result") { const t0 = sentAt.get(m.slot.n); if (t0 !== undefined) { ack.push({ at: Date.now(), ms: now - t0 }); sentAt.delete(m.slot.n); } }
          if (m.t === "live") live.push({ at: now, stream: (m as { stream: string }).stream });
        }
        // Keep memory flat: only what the waits below need.
        return push(...messages.filter((m) => m.t !== "cmd.result" && m.t !== "live" && m.t !== "ack"));
      };
      await client.connect(daemon.socket, daemon.token);
      await client.sub(client.srv);
      const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
      const inc = srvSnap.logId;
      const main = `bot:${MAIN}`;
      await client.sub(main);
      await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === main, "bot snap");
      let n = 0;
      const send = (target: string, cmd: unknown) => {
        const slot: Slot = { origin: "accept", originEpoch: client.originEpoch, target: target as Slot["target"], n: ++n };
        sentAt.set(slot.n, performance.now());
        client.cmd(slot, cmd, inc);
        return slot.n;
      };
      // A line to react to.
      send(main, { type: "chat.send", botId: MAIN, text: "/say seed" });
      const seed = await until(() => client.entriesOf(main).find((e) => e.kind === "message.added" && (e.body as { message: { role: string } }).message.role === "user") ?? null, { timeout: 60_000, what: "seed line" });
      const seedId = (seed.body as { message: { id: string } }).message.id;
      await until(() => client.entriesOf(main).some((e) => e.kind === "turn.finished") || null, { timeout: 60_000, what: "seed turn" });
      let present = false;
      const react = () => { present = !present; return send(main, { type: "chat.react", botId: MAIN, messageId: seedId, emoji: "👍", present }); };
      await sleep(1_000);

      const commits = (): Commit[] => existsSync(commitLog) ? readFileSync(commitLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Commit) : [];
      const phase = async (rate: number, ms: number) => {
        const loads: number[] = [loadavg()[0]];
        const loadTimer = setInterval(() => loads.push(loadavg()[0]), 1_000);
        const from = Date.now();
        const ackFrom = ack.length;
        const total = Math.round((rate * ms) / 1_000);
        const t0 = performance.now();
        for (let i = 0; i < total; i++) {
          const due = t0 + (i * 1_000) / rate;
          const wait = due - performance.now();
          if (wait > 1) await sleep(wait);
          react();
        }
        const sentMs = performance.now() - t0;
        await until(() => sentAt.size === 0 || null, { timeout: 60_000, what: "every ack" });
        clearInterval(loadTimer);
        await sleep(600); // the preload flushes every 250 ms
        const to = Date.now();
        const window = commits().filter((c) => c.at >= from && c.at <= to);
        return {
          rate, commands: total, achievedRate: Math.round((total / sentMs) * 1_000), load: summarizeLoad(loads),
          commitMs: percentiles(window.map((c) => c.commitMs)), txnMs: percentiles(window.map((c) => c.txnMs)),
          batchSize: percentiles(window.map((c) => c.size)), commits: window.length,
          ackMs: percentiles(ack.slice(ackFrom).map((a) => a.ms)),
        };
      };
      const rates = [];
      for (const rate of RATES) {
        rates.push(await phase(rate, PHASE_MS));
        console.log(JSON.stringify(rates.at(-1)));
        await sleep(1_500);
      }
      report.rates = rates;

      // Phase 2: three more bots, four replies streaming at once, typing (chat.react) at 50/s meanwhile.
      const bots = [MAIN];
      for (let i = 1; i <= 3; i++) {
        const before = ack.length;
        send(client.srv, { type: "bots.create", name: `Streamer ${i}`, job: "Streams long replies for the latency check." });
        await until(() => ack.length > before || null, { timeout: 30_000, what: "bots.create" });
      }
      const srvView = await client.req({ type: "chat.snapshot" });
      for (const bot of ((srvView as { result: { bots: Array<{ id: string }> } }).result.bots)) if (!bots.includes(bot.id)) bots.push(bot.id);
      for (const bot of bots) if (bot !== MAIN) { await client.sub(`bot:${bot}`); await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `bot:${bot}`, `snap ${bot}`); }
      const words = scriptedWords(600, "s");
      const liveFrom = live.length;
      const streamStart = performance.now();
      for (const bot of bots) send(`bot:${bot}`, { type: "chat.send", botId: bot, text: `/say ${words}` });
      await until(() => live.length > liveFrom || null, { timeout: 60_000, what: "live frames" });
      const typing = await phase(50, 10_000);
      const window = live.slice(liveFrom);
      const perConn = maxPerSecond(window.map((f) => f.at));
      const perStream: Record<string, number> = {};
      for (const bot of bots) perStream[bot.slice(0, 8)] = maxPerSecond(window.filter((f) => f.stream === `bot:${bot}`).map((f) => f.at));
      const sends = groupSends(window.map((f) => f.at));
      const streams = new Set(window.map((f) => f.stream)).size;
      report.streaming = {
        bots: bots.length, streamsSeenLive: streams, frames: window.length, seconds: +((window.at(-1)!.at - window[0].at) / 1000).toFixed(1),
        maxFramesPerSecondOnConnection: perConn, maxSendsPerSecondOnConnection: maxPerSecond(sends), maxFramesPerSecondPerStream: perStream,
        typingWhileStreaming: typing, msUntilFirstFrame: Math.round(window[0].at - streamStart),
      };
      console.log(JSON.stringify(report.streaming));
      client.close();
      report.serverDbBytes = statSync(join(dataDir, "server.db")).size;
      expect((await daemon.stop()).code).toBe(0);
      report.bareFlushAfter = bareFlush(join(root, "bare-after.db"));
      console.log(JSON.stringify({ bareFlushAfter: report.bareFlushAfter }));
    } finally {
      if (daemon?.alive) await daemon.stop("SIGKILL");
      report.uptimeAfter = spawnSync("uptime", { encoding: "utf8" }).stdout.trim().replace(/^.*load/, "load");
      console.log(`report: ${writeReport(`latency-${runtimeOf()}`, report)}`);
      removeTree(root);
      expect(existsSync(root)).toBe(false);
    }
    for (const rate of report.rates as Array<{ commitMs: { p99: number } }>) expect(rate.commitMs.p99).toBeLessThanOrEqual(20);
    expect((report.streaming as { maxFramesPerSecondOnConnection: number }).maxFramesPerSecondOnConnection).toBeLessThanOrEqual(10);
  });
});

/**
 * The disk's own cost, beside botlingd: 600 single-row commits (300–3000 B, like an entry) on a plain node:sqlite file
 * in the same folder with server.db's writer PRAGMAs (src/server/store/connection.ts WRITER_PRAGMAS), one after another.
 */
function bareFlush(file: string): Record<string, unknown> {
  const db = new DatabaseSync(file);
  for (const pragma of WRITER_PRAGMAS) db.exec(`PRAGMA ${pragma}`);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
  const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
  const times: number[] = [];
  const load = loadavg()[0];
  for (let i = 0; i < 650; i++) {
    db.exec("BEGIN IMMEDIATE");
    insert.run("x".repeat(300 + Math.floor(Math.random() * 2_700)));
    const t0 = performance.now();
    db.exec("COMMIT");
    if (i >= 50) times.push(performance.now() - t0);
  }
  db.close();
  return { commitMs: percentiles(times), load: Math.round(load * 100) / 100 };
}

/** The most timestamps (ms) in any 1 s window. */
function maxPerSecond(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < sorted.length; i++) {
    while (sorted[i] - sorted[j] >= 1_000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** Frames that arrived within 2 ms of each other count as one send (a segment split over consecutive frames). */
function groupSends(times: number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) if (!out.length || t - out[out.length - 1] > 2) out.push(t);
  return out;
}
