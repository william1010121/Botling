// Botling 3 M5-03b: call-ins under faults. Two real botlingd processes (A the host, B the guest), the fake agent behind
// both, and a fault proxy in front of each (test/support/fault-proxy), so every ask, cancel and reply travels the real
// path: ServerOrigin → forward queue → peer session (D58: one lost frame ends it) → owner's slot engine → effect row →
// guest turn → `callin.reply` back the same way. No fake `ServerOrigin`.
//
// A run is one call-in: the test sends `/mention Gus<k> <token>` to a fresh host bot on A, whose fake head answers with a
// bot's `@Gus<k> <token>`, so A's `Conversations` calls the guest in (a bot asked, so a wake is possible). Runs go in
// waves (a run's kind comes from the seed; faults are seeded per wave):
//   clean   no fault.
//   net     the proxies drop, duplicate and delay frames at random (seeded PRNG), cut every connection and partition at a
//           seeded moment, then heal.
//   killA   "after commit, before send" on A: the proxies cut and partition, so the asks sit committed in A's forward queue
//           with no session to send them; A is SIGKILLed there, restarted, and the proxies heal. A's waits are lost.
//   killB   "after commit, before send" on B: the proxies cut and partition once B holds the asks; B's guest turns finish
//           and their replies are committed in B's forward queue with no session; B is SIGKILLed there, restarted, healed.
//   killBmid  B is SIGKILLed while a guest turn runs (its row `started`), restarted, and killed again soon after: an
//           interrupted row is never run again and gets one failed answer.
//   down    B is SIGKILLed before the asks and stays down until A gave up on each (the host's stale window is 2.5 s here)
//           and queued the cancel; then B restarts and gets the ask, then the cancel, in order.
//   gaveUpCrash  A dies after it wrote the `callin:gaveup` record and before `callin.cancel` was submitted (M5-03a review,
//           crash point 1). That window is a few microtasks wide, so the state is built, not timed: after A gave up and
//           queued the cancel, A is SIGKILLed and, while it is stopped, the cancel's forward-queue row is deleted and the
//           target's slot counter stepped back (exactly what a crash before the submit's transaction leaves). B then gets
//           the ask alone, finishes its turn and replies: A posts it once, marked late, and wakes nobody more.
//   lateKill  B has the asks and runs its turns, then the network is cut both ways: B's replies wait in its queue, A gives up
//           (record written, cancel queued); on heal the replies and the cancels cross. A kills ITSELF (the test hook
//           BOTLING_SERVER_CALLIN_CRASH, armed by the test) the moment the first late reply's transaction committed: the
//           record is used up and the late line is staged in the same transaction, nothing is posted yet (crash point 2).
//           After the restart the staged line is posted from A's outbox (`callin:late:` row): every call-in B answered has
//           its late line, exactly once (fu-callin-outbox; before it a line could be lost), and nobody is woken for it.
//   guestCrash  B kills ITSELF the moment the first guest answer's transaction committed (the row marked answered and the answer
//           queued together, nothing pumped; the old two-step code lost the answer here, and A waited for its cap). B is
//           restarted: that answer still reaches A (a receipt at A, a line in H), and no row of B is marked answered without one.
// Properties, per call-in (token), read from the servers' own tables and the fake CLI's input files:
//   every call-in B marked answered has exactly one reply applied at A (a receipt), and no call-in has two;
//   ≤ 1 guest turn at B (and ≤ 1 `callin` row there); ≤ 1 guest line in H, late or not; the asker woken ≤ 1 time (and
//   exactly once while A was not killed); a late line adds no wake; a call-in B cancelled before it started posts nothing;
//   no line without a turn. Every wave ends with both forward queues empty.
// The seed is printed (CALLIN_FAULT_SEED sets it) and is in every failure message. Requires `npm run build`.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageOf, Slot } from "../../src/protocol";
import { until } from "../helpers";
import { testRoot, type ScriptClient } from "../botlingd-harness";
import { seededRandom, type FaultProxy } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const SEED = Number(process.env.CALLIN_FAULT_SEED ?? 20261115);
const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const TIMERS_ENV = Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",");
const STALE_MS = 2_500;
/** The host's cap: a wait whose answer B lost (a kill between B's mark and its queue) ends here, with B live. */
const CAP_MS = 10_000;
const GUESTS = 8;
const WAKE_MARK = "whom you called in with @";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Kind = "clean" | "net" | "killA" | "killB" | "killBmid" | "down" | "gaveUpCrash" | "lateKill" | "guestCrash";
/** The waves, in order: 80 call-ins, every kind of fault in it; the runs of a wave go at once. */
const PLAN: Array<[Kind, number]> = [
  ["clean", 10], ["net", 10], ["killA", 8], ["net", 10], ["killB", 8], ["killBmid", 8], ["down", 8], ["gaveUpCrash", 6], ["lateKill", 6], ["guestCrash", 6],
];

const scratch = testRoot("callin-faults");
const aInput = join(scratch, "a-input.jsonl");
const bInput = join(scratch, "b-input.jsonl");
/** The crash hooks (BOTLING_SERVER_CALLIN_CRASH): a server kills itself right after a call-in step committed while its file holds `armed`, and leaves `hit:<callId>` there. */
const aCrash = join(scratch, "a-crash.txt");
const bCrash = join(scratch, "b-crash.txt");
let cluster: TestCluster;
let a: TestServer, b: TestServer;
let pa: FaultProxy, pb: FaultProxy;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let guests: Array<{ id: string; name: string }> = [];

// ---------------------------------------------------------------------------------------------
// Reading the servers (WAL: a second read-only connection sees committed state) and the fake CLI's input logs

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const count = (server: TestServer, table: string) => withDb(server, (db) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));
const inputLines = (file: string): string[] => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => String((JSON.parse(line) as { text?: unknown }).text ?? "")); } catch { return []; } };

interface CallInRow { state: string; replied: boolean; asked: string; callId: string }
/** B's `callin` effect rows. */
const callInRows = (): CallInRow[] => withDb(b, (db) => (db.prepare("SELECT state, payload FROM effects WHERE kind = 'callin'").all() as Array<{ state: string; payload: string }>)
  .map((row) => { const payload = JSON.parse(row.payload) as { asked: string; replied: boolean; callId: string }; return { state: row.state, replied: payload.replied, asked: payload.asked, callId: payload.callId }; }));
/** The `callin:gaveup:` rows in A's `meta` (M5-03a: one per call-in A gave up on, used up by its late reply). */
const gaveUpRows = (): number => withDb(a, (db) => Number((db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'callin:gaveup:%'").get() as { n: number }).n));
/** The `callin:late:` rows in A's `meta` (fu-callin-outbox: a late line staged with its reply, deleted once posted). */
const lateRows = (): number => withDb(a, (db) => Number((db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'callin:late:%'").get() as { n: number }).n));
/** The `callin.reply` commands A applied from B for a host bot (A's receipts): one per answer B queued. */
const receiptsFor = (hostId: string): number => withDb(a, (db) => Number((db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE origin = ? AND target = ?").get(kb.memberId, `bot:${hostId}`) as { n: number }).n));
/** Arms a crash hook (the next call-in step that reaches it kills its server) and waits for it to fire; returns the callId it hit. */
const arm = (file: string) => writeFileSync(file, "armed");
const hitOf = (file: string): string | null => { try { const text = readFileSync(file, "utf8"); return text.startsWith("hit:") ? text.slice(4) : null; } catch { return null; } };
/** A's stopped data folder: drops the queued `callin.cancel` rows (queue row, pending key) and steps each target's slot counter back: what a crash before the submit's transaction leaves. */
function dropQueuedCancels(): number {
  const db = new DatabaseSync(join(a.dataDir, "server.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("BEGIN IMMEDIATE");
    const rows = db.prepare("SELECT origin, originEpoch, target, n FROM forwardq WHERE envelope LIKE '%callin.cancel%'").all() as Array<{ origin: string; originEpoch: string; target: string; n: number }>;
    for (const row of rows) {
      const mine = db.prepare("SELECT nextN FROM myorigins WHERE target = ? AND originEpoch = ?").get(row.target, row.originEpoch) as { nextN: number } | undefined;
      // Only the newest slot of its target can be taken back without a gap (every run of this wave has a guest of its own).
      if (!mine || Number(mine.nextN) !== Number(row.n) + 1) throw new Error(`the cancel ${row.target}#${row.n} is not the newest slot of its target (nextN ${mine?.nextN})`);
      db.prepare("DELETE FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").run(row.origin, row.originEpoch, row.target, row.n);
      // `ServerOrigin.submit` commits the queue row, the slot counter and this pending key in one transaction; a crash before it leaves none.
      db.prepare("DELETE FROM meta WHERE key = ?").run(`serverOrigin:${row.originEpoch}:${row.target}:${row.n}`);
      db.prepare("UPDATE myorigins SET nextN = ? WHERE target = ? AND originEpoch = ?").run(row.n, row.target, row.originEpoch);
    }
    db.exec("COMMIT");
    return rows.length;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* none open */ }
    throw error;
  } finally { db.close(); }
}
/** The text and source of every line of a bot's chat on A. */
const chatOf = (botId: string): Array<{ text: string; sourceId: string | null }> => withDb(a, (db) => (db.prepare("SELECT body FROM messages WHERE botId = ?").all(botId) as Array<{ body: string }>)
  .map((row) => { const line = JSON.parse(row.body) as { text?: string; sourceId?: string }; return { text: String(line.text ?? ""), sourceId: line.sourceId ?? null }; }));

// ---------------------------------------------------------------------------------------------
// A scripted front end: bots.create and chat.send on a server's own socket

async function front(server: TestServer): Promise<{ client: ScriptClient; inc: string }> {
  const client = await server.client("script");
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  return { client, inc: snap.logId };
}
let created = 0;
async function createBots(server: TestServer, names: string[]): Promise<string[]> {
  const { client, inc } = await front(server);
  try {
    const ids: string[] = [];
    for (const name of names) {
      const slot = { origin: "script", originEpoch: client.originEpoch, target: client.srv, n: ++created } as Slot;
      client.cmd(slot, { type: "bots.create", name, job: "call-in fault test" }, inc);
      const done = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n && m.slot.target === slot.target, `bots.create ${name}`);
      ids.push((done.outcome as { result: { botId: string } }).result.botId);
    }
    return ids;
  } finally { client.close(); }
}
/** `chat.send` of each text to its bot, all in flight at once; resolves when every one was applied. */
async function sendAll(server: TestServer, sends: Array<{ botId: string; text: string }>): Promise<void> {
  const { client, inc } = await front(server);
  try {
    const slots = sends.map(({ botId, text }) => {
      const slot = { origin: "script", originEpoch: client.originEpoch, target: `bot:${botId}`, n: 1 } as Slot;
      client.cmd(slot, { type: "chat.send", botId, text }, inc);
      return slot;
    });
    await Promise.all(slots.map((slot) => client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === slot.target, `chat.send ${slot.target}`)));
  } finally { client.close(); }
}

// ---------------------------------------------------------------------------------------------

interface Run { token: string; hostId: string; guest: { id: string; name: string } }

class SeedFailure extends Error {
  constructor(seed: string, message: string) { super(`seed ${seed}: ${message}`); }
}

/** Both proxies' faults at once (the session goes through whichever server dialled). */
const proxies = () => [pa, pb];
const heal = () => { for (const proxy of proxies()) { proxy.schedule(null); proxy.heal(); } };
const isolate = () => { for (const proxy of proxies()) { proxy.partition(); proxy.cut(); } };

/**
 * Waits until the call-ins are over: both forward queues empty, every `callin` row of B ended, every asker woken while A kept
 * its waits (a lost answer ends A's wait only at the cap), and nothing changed for a while.
 */
async function converge(runs: Run[], what: string, aKilled: boolean): Promise<void> {
  const snapshot = () => JSON.stringify([
    runs.map((run) => chatOf(run.hostId).length), inputLines(aInput).length, inputLines(bInput).length,
    count(a, "forwardq"), count(a, "fwdcancels"), count(b, "forwardq"), count(b, "fwdcancels"), callInRows().map((row) => row.state),
  ]);
  const quiet = () => count(a, "forwardq") === 0 && count(a, "fwdcancels") === 0 && count(b, "forwardq") === 0 && count(b, "fwdcancels") === 0
    && callInRows().every((row) => row.state !== "queued" && row.state !== "started")
    && runs.every((run) => callInRows().some((row) => row.asked.includes(run.token)))
    && (aKilled || runs.every((run) => inputLines(aInput).some((text) => text.includes(run.token) && text.includes(WAKE_MARK))));
  let last = "";
  let since = Date.now();
  const why = () => JSON.stringify({
    forwardq: [count(a, "forwardq"), count(b, "forwardq")], fwdcancels: [count(a, "fwdcancels"), count(b, "fwdcancels")],
    callin: callInRows().map((row) => row.state), missing: runs.filter((run) => !callInRows().some((row) => row.asked.includes(run.token))).map((run) => run.token),
    aAlive: a.alive, bAlive: b.alive, aLog: a.log.slice(-1_200), bLog: b.log.slice(-1_200),
  });
  try {
    await until(() => {
      const now = snapshot();
      if (now !== last) { last = now; since = Date.now(); return false; }
      return quiet() && Date.now() - since >= 1_800;
    }, { timeout: 45_000, every: 100, what: `${what}: the call-ins to end` });
  } catch (error) { throw new Error(`${(error as Error).message}: ${why()}`); }
}

/** The properties of one call-in. `aKilled`: A lost its waits, so no wake is owed. */
function check(seed: string, run: Run, aKilled: boolean): { line: number; wake: number; turns: number } {
  const fail = (message: string): never => { throw new SeedFailure(seed, `${run.token}: ${message}`); };
  const rows = callInRows().filter((row) => row.asked.includes(run.token));
  const turns = inputLines(bInput).filter((text) => text.includes(run.token) && text.includes("called you in")).length;
  const lines = chatOf(run.hostId);
  const line = lines.filter((entry) => entry.sourceId === run.guest.id).length;
  const late = lines.filter((entry) => entry.text.startsWith("Late answer from ")).length;
  const wake = inputLines(aInput).filter((text) => text.includes(run.token)).reduce((sum, text) => sum + text.split(WAKE_MARK).length - 1, 0);
  const receipts = receiptsFor(run.hostId);
  if (rows.length !== 1) fail(`${rows.length} callin rows at B (want exactly 1: the ask is applied once)`);
  // B marks a call-in answered only together with queueing its answer, and the queue sends it until A applied it: no answer lost, none doubled.
  if (receipts > 1) fail(`${receipts} replies applied at A (want ≤ 1)`);
  if (rows[0]!.replied && receipts !== 1) fail(`B marked the call-in answered (${rows[0]!.state}) but A applied ${receipts} replies (want 1: the answer must not be lost between the mark and the queue)`);
  if (turns > 1) fail(`${turns} guest turns at B (want ≤ 1)`);
  if (line > 1) fail(`${line} guest lines in H (want ≤ 1)`);
  if (late > 1) fail(`${late} late notices in H (want ≤ 1)`);
  if (line > turns) fail(`a guest line in H without a guest turn at B`);
  if (late > line) fail(`a late notice without its line`);
  if (wake > 1) fail(`the asker was woken ${wake} times (want ≤ 1)`);
  if (rows[0]!.state === "cancelled" && (turns !== 0 || line !== 0)) fail(`a call-in B cancelled before it started has ${turns} turns and ${line} lines`);
  if (!aKilled && wake !== 1) fail(`the asker was woken ${wake} times while A kept its waits (want exactly 1: the answer, or "did not answer")`);
  return { line, wake, turns };
}

async function wave(index: number, kind: Kind, size: number, totals: Record<string, number>): Promise<void> {
  const seed = `${SEED}/w${index}/${kind}`;
  const random = seededRandom(SEED + index * 7_919);
  const pick = (low: number, high: number) => Math.floor(low + random() * (high - low + 1));
  const hosts = await createBots(a, Array.from({ length: size }, (_, i) => `Host${index}x${i}`));
  // The crash kinds give each run a guest of its own (their slot counters are edited or watched one by one).
  const own = kind === "gaveUpCrash" || kind === "lateKill";
  const runs: Run[] = hosts.map((hostId, i) => ({ token: `Q${String(index * 10 + i).padStart(3, "0")}Z`, hostId, guest: guests[own ? i : pick(0, GUESTS - 1)]! }));
  // B checks the host bot against its copy of A's table (`admit`): wait until that copy names every host bot, so a kill of B
  // below cannot leave an ask to be refused only because the replica was a moment behind.
  await until(() => hosts.every((hostId) => withDb(b, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${ka.memberId}`, `bot:${hostId}`))), { timeout: 60_000, every: 50, what: `${seed}: B's copy names the host bots` });
  const sends = runs.map((run) => ({ botId: run.hostId, text: `/mention ${run.guest.name} ${run.token}` }));
  let aKilled = false;
  let hit: string | null = null;
  const gaveUpBefore = gaveUpRows();
  try {
    if (kind === "net") {
      for (const proxy of proxies()) proxy.schedule({ drop: pick(2, 8) / 100, duplicate: pick(2, 6) / 100, delay: { p: 0.1, ms: pick(50, 250) } });
      await sendAll(a, sends);
      await sleep(pick(100, 900));
      if (random() < 0.7) for (const proxy of proxies()) proxy.cut();
      if (random() < 0.5) { for (const proxy of proxies()) proxy.partition(); await sleep(pick(200, 1_500)); }
      heal();
      totals.faults += proxies().reduce((sum, proxy) => sum + proxy.count("drop") + proxy.count("duplicate") + proxy.count("delay") + proxy.count("cut"), 0) - totals.seen;
      totals.seen = proxies().reduce((sum, proxy) => sum + proxy.count("drop") + proxy.count("duplicate") + proxy.count("delay") + proxy.count("cut"), 0);
    } else if (kind === "killA") {
      isolate();
      await sendAll(a, sends);
      // The asks are committed in A's forward queue and there is no session to send them on.
      await until(() => count(a, "forwardq") >= size, { timeout: 60_000, every: 50, what: `${seed}: the asks in A's forward queue` });
      await a.kill();
      aKilled = true;
      totals.kills++;
      await a.start();
      await sleep(pick(0, 600));
      heal();
    } else if (kind === "killB") {
      await sendAll(a, sends);
      await until(() => runs.every((run) => callInRows().some((row) => row.asked.includes(run.token))), { timeout: 60_000, every: 25, what: `${seed}: the asks at B` });
      isolate();
      // The guest turns finish and their replies are committed in B's forward queue; none can be sent.
      const mine = () => callInRows().filter((row) => runs.some((run) => row.asked.includes(run.token)));
      await until(() => mine().every((row) => row.state !== "queued" && row.state !== "started"), { timeout: 30_000, every: 25, what: `${seed}: B's replies committed (${JSON.stringify(mine().map((row) => row.state))})` }).catch((error) => { throw new Error(`${(error as Error).message} now ${JSON.stringify(mine().map((row) => [row.state, row.replied]))} B log ${b.log.slice(-800)}`); });
      totals.heldReplies += count(b, "forwardq");
      await b.kill();
      totals.kills++;
      await b.start();
      await sleep(pick(0, 1_500));
      heal();
    } else if (kind === "killBmid") {
      // B dies while a guest turn runs: its started row becomes `interrupted`, is never run again, and is answered once
      // (failed "its machine restarted"); B dies a second time soon after, while that answer may be committed and unsent.
      await sendAll(a, sends);
      const running = () => runs.some((run) => inputLines(bInput).some((text) => text.includes(run.token) && text.includes("called you in"))
        && callInRows().some((row) => row.asked.includes(run.token) && row.state === "started"));
      await until(running, { timeout: 60_000, every: 5, what: `${seed}: a guest turn running at B` });
      await b.kill();
      await b.start();
      await sleep(pick(0, 300));
      await b.kill();
      totals.kills += 2;
      await b.start();
    } else if (kind === "down") {
      await b.kill();
      totals.kills++;
      await sendAll(a, sends);
      // A gives up on each (it wakes the asker once) and queues a cancel behind the ask.
      await until(() => runs.every((run) => inputLines(aInput).some((text) => text.includes(run.token) && text.includes(WAKE_MARK))), { timeout: 60_000, every: 50, what: `${seed}: A to give up` });
      await until(() => count(a, "fwdcancels") + count(a, "forwardq") >= size * 2, { timeout: 30_000, every: 50, what: `${seed}: the cancels queued` }).catch(() => undefined);
      await sleep(pick(0, 1_000));
      await b.start();
    } else if (kind === "gaveUpCrash") {
      const base = gaveUpRows();
      await b.kill();
      totals.kills++;
      await sendAll(a, sends);
      // A gives up on each: the record is written, the asker woken once, the cancel queued behind the ask.
      await until(() => runs.every((run) => inputLines(aInput).some((text) => text.includes(run.token) && text.includes(WAKE_MARK))), { timeout: 60_000, every: 50, what: `${seed}: A to give up` });
      await until(() => gaveUpRows() >= base + size && count(a, "forwardq") >= size * 2, { timeout: 30_000, every: 25, what: `${seed}: the records written and the cancels queued` });
      await a.kill();
      aKilled = true;
      totals.kills++;
      expect(dropQueuedCancels(), `seed ${seed}: cancels taken back`).toBe(size);
      await a.start();
      // Nothing puts a cancel back while B is still down: A's queue holds the asks alone.
      await sleep(1_500);
      const kinds = withDb(a, (db) => (db.prepare("SELECT envelope FROM forwardq").all() as Array<{ envelope: string }>).map((row) => (/callin\.(ask|cancel)/.exec(row.envelope) ?? ["other"])[0]));
      expect(kinds, `seed ${seed}: A's forward queue after the restart`).toEqual(Array(size).fill("callin.ask"));
      await b.start();
    } else if (kind === "lateKill") {
      const base = gaveUpRows();
      await sendAll(a, sends);
      await until(() => runs.every((run) => callInRows().some((row) => row.asked.includes(run.token))), { timeout: 60_000, every: 5, what: `${seed}: the asks at B` });
      // B has the asks (and is running its guest turns); from here nothing crosses, so its replies wait in its queue while A gives up.
      isolate();
      await until(() => gaveUpRows() >= base + size, { timeout: 30_000, every: 25, what: `${seed}: the records written` }).catch(() => undefined);
      // Armed before the heal, so no late reply can pass the hook unarmed: the first one that commits kills A (the hook), after
      // the record is used up and the late line is staged, before anything is posted (crash point 2). The hit is exact, never timed.
      rmSync(aCrash, { force: true });
      arm(aCrash);
      heal();
      // B's held replies and A's cancels cross now.
      await until(() => hitOf(aCrash) !== null, { timeout: 30_000, every: 5, what: `${seed}: a late reply to commit` });
      totals.lateKills++;
      await a.kill();
      aKilled = true;
      totals.kills++;
      await a.start();
    } else if (kind === "guestCrash") {
      // B kills itself the moment the first guest answer committed: the row marked answered and the answer queued together.
      rmSync(bCrash, { force: true });
      arm(bCrash);
      await sendAll(a, sends);
      await until(() => hitOf(bCrash) !== null, { timeout: 60_000, every: 5, what: `${seed}: B's first answer to commit` });
      hit = hitOf(bCrash);
      await b.kill();
      totals.kills++;
      totals.guestHits++;
      await b.start();
    } else {
      await sendAll(a, sends);
    }
    await converge(runs, seed, aKilled);
  } catch (error) {
    if (error instanceof SeedFailure) throw error;
    throw new SeedFailure(seed, error instanceof Error ? error.message : String(error));
  }
  for (const run of runs) {
    const got = check(`${seed}`, run, aKilled);
    if (kind === "gaveUpCrash") {
      // Crash point 1: B finished its turn, A posts it once as late, and the one wake is the give-up's.
      expect({ turns: got.turns, line: got.line, wake: got.wake }, `seed ${seed}: ${run.token} rows ${JSON.stringify(callInRows().filter((row) => row.asked.includes(run.token)).map((row) => [row.state, row.replied]))} chat ${JSON.stringify(chatOf(run.hostId).map((entry) => entry.text.slice(0, 80)))} B log ${b.log.slice(-600)}`).toEqual({ turns: 1, line: 1, wake: 1 });
      expect(chatOf(run.hostId).filter((entry) => entry.text.startsWith("Late answer from ")).length, `seed ${seed}: ${run.token}: late notice`).toBe(1);
    }
    // Crash point 2 (fu-callin-outbox): every call-in B answered has its late line; the staged line was posted after the restart.
    if (kind === "lateKill" && got.turns === 1 && got.line === 0) totals.lostLate++;
    if (kind === "lateKill") expect({ turns: got.turns, line: got.line }, `seed ${seed}: ${run.token} late line lost (A killed after the reply committed)`).toEqual({ turns: 1, line: 1 });
    // B's crash point (fu-callin-outbox): the answer that was committed when B died reached A: replied at B, one reply applied, its line in H.
    if (kind === "guestCrash" && callInRows().some((row) => row.asked.includes(run.token) && row.callId === hit)) {
      expect({ rows: callInRows().filter((row) => row.callId === hit).map((row) => [row.state, row.replied]), receipts: receiptsFor(run.hostId), line: got.line }, `seed ${seed}: ${run.token} the answer B had committed when it died`).toEqual({ rows: [["finished", true]], receipts: 1, line: 1 });
      totals.guestAnswersKept++;
    }
    // B's one answer for an interrupted row reached a wait (else A gave up while B was down, or a kill between B's mark and its
    // queue lost the answer and A's wait ended at the cap).
    const restartAnswered = inputLines(aInput).some((text) => text.includes(run.token) && text.includes(WAKE_MARK) && text.includes("restarted during the answer"));
    if (kind === "killBmid" && restartAnswered) totals.restartAnswers++;
    if (kind === "killBmid" && got.turns === 1 && callInRows().some((row) => row.asked.includes(run.token) && row.state === "interrupted")) {
      totals.interruptedTurns++;
      // The answer B owes for an interrupted turn reached A (the receipt, checked above) and the asker was told it: either B's
      // "restarted during the answer", or A had given up while B was down ("not reachable"). The cap (a lost answer) shows up as
      // "not reachable" too, which is why the receipt check and this count both stand.
      const woken = inputLines(aInput).filter((text) => text.includes(run.token) && text.includes(WAKE_MARK));
      if (!restartAnswered && !woken.some((text) => text.includes("is not reachable"))) throw new SeedFailure(seed, `${run.token}: an interrupted guest turn whose asker heard neither B's restart answer nor a give-up`);
      if (!restartAnswered) totals.interruptedGaveUp++;
    }
    totals.runs++;
    totals.lines += got.line;
    totals.wakes += got.wake;
    totals.turns += got.turns;
  }
  // The crash kinds: every call-in A gave up on was answered by B, and each answer used its record up (M5-03a: a record left
  // behind would make a second reply for the same call-in late again).
  if (kind === "gaveUpCrash" || kind === "lateKill") expect(gaveUpRows(), `seed ${seed}: callin:gaveup records left after the wave`).toBe(gaveUpBefore);
  // Every staged late line was posted and its row deleted (a row left behind would post again at the next start).
  if (kind === "gaveUpCrash" || kind === "lateKill") expect(lateRows(), `seed ${seed}: callin:late rows left after the wave`).toBe(0);
  // B never drops an answer it marked sent: the roster does not change here, so every answer can be queued (only a crash
  // between the mark and the queue loses one, and that leaves no log line).
  expect(b.log.split("\n").filter((line) => /callin: (even )?the (short )?answer to .* was not sent/.test(line)), `seed ${seed}: answers B could not queue`).toEqual([]);
  // Every call-in of the wave is over: nothing is left in either forward queue (also `converge`'s quiet condition).
  expect({ a: [count(a, "forwardq"), count(a, "fwdcancels")], b: [count(b, "forwardq"), count(b, "fwdcancels")] }, `seed ${seed}: forward queues`).toEqual({ a: [0, 0], b: [0, 0] });
  if (kind === "down") totals.down += runs.length;
  if (kind === "killB") totals.killB += runs.length;
  if (kind === "killA") totals.killA += runs.length;
}

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(aInput, "");
  writeFileSync(bInput, "");
  cluster = await startServers({
    name: "callin-faults", count: 2,
    env: {
      A: { BOTLING_SERVER_PEER_TIMERS: TIMERS_ENV, BOTLING_SERVER_CALLIN_TIMERS: `stale=${STALE_MS},cap=${CAP_MS},tick=200`, BOTLING_SERVER_CALLIN_CRASH: `host=${aCrash}`, FAKE_CLAUDE_INPUT: aInput },
      B: { BOTLING_SERVER_PEER_TIMERS: TIMERS_ENV, BOTLING_SERVER_CALLIN_CRASH: `guest=${bCrash}`, FAKE_CLAUDE_INPUT: bInput, FAKE_CLAUDE_GUEST_MS: "250" },
    },
  });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", SEED);
  pb = await cluster.proxy(b, "websocket", SEED + 1);
  const made = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);
  const names = Array.from({ length: GUESTS }, (_, i) => `Gus${i + 1}`);
  const ids = await createBots(b, names);
  guests = ids.map((id, i) => ({ id, name: names[i]! }));
  // A's copy of B's table names every guest, so A can call them in with @.
  await until(() => guests.every((guest) => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${guest.id}`))), { timeout: 60_000, every: 100, what: "A's copy names B's guests" });
}, 180_000);

afterAll(async () => {
  await cluster?.cleanup();
  rmSync(scratch, { recursive: true, force: true });
}, 60_000);

describe("M5-03b: call-ins under faults (real processes, fault proxies)", () => {
  it(`${PLAN.reduce((sum, [, n]) => sum + n, 0)} seeded call-ins: never two guest turns, never two lines, never two wakes (seed ${SEED})`, async () => {
    console.log(`callin-faults: seed ${SEED} (CALLIN_FAULT_SEED); ${PLAN.length} waves`);
    const totals: Record<string, number> = { runs: 0, lines: 0, wakes: 0, turns: 0, kills: 0, faults: 0, seen: 0, heldReplies: 0, down: 0, killA: 0, killB: 0, lostLate: 0, lateKills: 0, guestHits: 0, guestAnswersKept: 0, interruptedTurns: 0, interruptedGaveUp: 0, restartAnswers: 0 };
    for (let index = 0; index < PLAN.length; index++) await wave(index, PLAN[index]![0], PLAN[index]![1], totals);
    console.log(`callin-faults: ${JSON.stringify(totals)}`);
    expect(totals.runs, `seed ${SEED}: runs`).toBeGreaterThanOrEqual(50);
    // Not vacuous: calls were answered, guests ran, servers were killed, and the network faulted.
    expect(totals.turns, `seed ${SEED}: guest turns`).toBeGreaterThan(30);
    expect(totals.lines, `seed ${SEED}: guest lines in H`).toBeGreaterThan(20);
    expect(totals.kills, `seed ${SEED}: kills`).toBeGreaterThanOrEqual(6);
    expect(totals.faults, `seed ${SEED}: network faults`).toBeGreaterThan(0);
    expect(totals.lateKills, `seed ${SEED}: A killed right after a late reply committed`).toBeGreaterThan(0);
    expect(totals.lostLate, `seed ${SEED}: late lines lost`).toBe(0);
    expect(totals.guestHits, `seed ${SEED}: B killed right after an answer committed`).toBeGreaterThan(0);
    expect(totals.guestAnswersKept, `seed ${SEED}: the answers B had committed when it died, all kept`).toBe(totals.guestHits);
    expect(totals.interruptedTurns, `seed ${SEED}: guest turns B was killed in`).toBeGreaterThan(0);
    // B's restart answer reached an asker's wait at least once (the rest were given up on while B was down; each one's receipt is checked per run).
    expect(totals.restartAnswers, `seed ${SEED}: restart answers that reached a wait`).toBeGreaterThan(0);
  }, 600_000);
});
