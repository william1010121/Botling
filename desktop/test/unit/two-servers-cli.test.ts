// Botling 3 M3 step 13 (m3-brief §4 row 13): `botlingd machines`, the peer part of `botlingd status` and its Doctor
// notes, on two real botlingd on this machine (loopback only), paired through the real CLI path (`botlingd join` on B,
// `botlingd add-machine <link>` on A).
//
// - `machines` (text and --json) on both lists the other as live, with since and the fingerprint the pairing printed;
// - `status` lists the peer and the forward-queue length (empty, then 1 held while B is down, then empty once B is
//   back and answered the forwarded command); `machines` on A shows B stale since its last frame;
// - with A stopped and its stored times aged by two hours (the CLI reads the data folder), `status` has the Doctor
//   notes "peer stale over an hour" and "forward queue row older than an hour", and `machines` still answers;
// - log scan: no server private key, VAPID private key, local token, join code or recovery code in any machines/status
//   output, in either server's log or output, or in any file of either data folder other than the one file that is
//   meant to hold it (server-keys.json, vapid-keys.json, botlingd.token).
// Requires `npm run build` (out/server/main.cjs).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromBase64Url, type MessageOf, type Slot } from "../../src/protocol";
import { botlingdScript, type ScriptClient } from "../botlingd-harness";
import { until } from "../helpers";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 1_000, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };
const HOUR = 60 * 60 * 1000;

/** A botlingd CLI command run with piped stdin and stdout, driven line by line. */
class CliRun {
  out = "";
  err = "";
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<number | null>;
  constructor(server: TestServer, args: string[]) {
    this.child = spawn(process.execPath, ["--no-warnings", botlingdScript, ...args], { env: server.environment, stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => { this.out += `${line}\n`; });
    this.child.stderr.on("data", (chunk) => { this.err += chunk; });
    this.done = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
  }
  async line(pattern: RegExp, from = 0, timeout = 30_000): Promise<RegExpMatchArray> {
    return until(() => this.out.slice(from).match(pattern), { timeout, every: 20, what: `${pattern} in\n${this.out}\n${this.err}` });
  }
  type(text: string): void { this.child.stdin.write(`${text}\n`); }
  async exit(timeout = 60_000): Promise<number | null> {
    const late = setTimeout(() => this.child.kill("SIGKILL"), timeout);
    try { return await this.done; } finally { clearTimeout(late); }
  }
}

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T, write = false): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: !write });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path)); else if (entry.isFile()) out.push(path);
  }
  return out;
}

interface MachinesJson {
  running: boolean;
  self: { member: string; fingerprint: string } | null;
  peers: Array<{ member: string; name: string; fingerprint: string; state: string; since: number | null; from: string }>;
  forwardQueue: { rows: number; oldestHeldAt: number | null } | null;
}

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let aFingerprint = "", bFingerprint = "";
let botB = "";
/** Every machines/status output, for the log scan. */
const outputs: string[] = [];
/** The join code(s) and the recovery code (they reach the terminal of `join` / `add-machine` by design, nowhere else). */
const codes: string[] = [];

function run(server: TestServer, args: string[]): string {
  const result = server.command(args);
  outputs.push(result.stdout, result.stderr);
  if (result.code !== 0) throw new Error(`botlingd ${args.join(" ")} on ${server.name} exited ${result.code}: ${result.stderr}`);
  return result.stdout;
}
const machinesJson = (server: TestServer): MachinesJson => JSON.parse(run(server, ["machines", "--json"])) as MachinesJson;
const statusJson = (server: TestServer) => JSON.parse(run(server, ["status", "--json"])) as {
  machines: MachinesJson; forwardQueue: { rows: number; oldestHeldAt: number | null }; notes: Array<{ id: string; text: string }>;
};

beforeAll(async () => {
  cluster = await startServers({ name: "cli", env: { A: TIMERS_ENV, B: TIMERS_ENV } });
  ({ a, b } = cluster);
  // Pairing through the real CLI path (step 4): join on B, add-machine on A (A's first pairing makes its cluster).
  const join1 = new CliRun(b, ["join", "--name", "B"]);
  const code = (await join1.line(/^Code:\s+(\S+)$/m))[1];
  bFingerprint = (await join1.line(/^Fingerprint:\s+(\S.*)$/m))[1].trim();
  const link = (await join1.line(/^(botling-join:\S+)$/m))[1];
  codes.push(code);
  const add = new CliRun(a, ["add-machine", link]);
  const recovery = (await add.line(/^Your recovery code.*\n\n\s+(\S[^\n]*)$/m))[1].trim();
  codes.push(recovery);
  await add.line(/^Press Enter once you have saved it/m);
  add.type("");
  aFingerprint = (await add.line(/^This machine's fingerprint:\s+(\S.*)$/m))[1].trim();
  await add.line(/^Does "B" show exactly this fingerprint/m);
  add.type("yes");
  await add.line(/^Code shown on "B":/m);
  add.type(code);
  await add.line(/^Added "B" \(\S+\) to cluster \S+\./m);
  expect(await add.exit()).toBe(0);
  expect(await join1.exit()).toBe(0);
}, 180_000);

afterAll(async () => { await cluster?.cleanup(); }, 60_000);

describe("M3 step 13: botlingd machines, status and the Doctor notes on two servers", () => {
  it("machines on both lists the other as live with since and the fingerprint the pairing printed", async () => {
    const before = Date.now();
    const onA = await until(() => { const r = machinesJson(a); return r.peers[0]?.state === "live" ? r : null; }, { timeout: 30_000, what: "A sees B live" });
    const onB = await until(() => { const r = machinesJson(b); return r.peers[0]?.state === "live" ? r : null; }, { timeout: 30_000, what: "B sees A live" });
    expect(onA.running).toBe(true);
    expect(onA.self!.fingerprint).toBe(aFingerprint);
    expect(onA.peers).toEqual([expect.objectContaining({ name: "B", fingerprint: bFingerprint, state: "live", from: "running" })]);
    expect(onB.self!.fingerprint).toBe(bFingerprint);
    expect(onB.peers).toEqual([expect.objectContaining({ fingerprint: aFingerprint, state: "live", from: "running" })]);
    for (const report of [onA, onB]) expect(report.peers[0].since).toBeGreaterThan(before - 120_000);
    const text = run(a, ["machines"]);
    expect(text).toMatch(new RegExp(`^this machine( "[^"]+")?: ${aFingerprint}$`, "m"));
    expect(text).toMatch(new RegExp(`^"B" ${bFingerprint}: live since \\d{4}-\\d\\d-\\d\\dT\\S+Z$`, "m"));
    // status: the peer and the queue length.
    const status = run(a, ["status"]);
    expect(status).toMatch(new RegExp(`^machine "B" ${bFingerprint}: live since `, "m"));
    expect(status).toMatch(/^forward queue: empty$/m);
    expect(statusJson(a).forwardQueue.rows).toBe(0);
    a.assertLoopbackOnly({ expectListener: true });
    b.assertLoopbackOnly({ expectListener: true });
  });

  it("B down: machines shows B stale since its last frame; a command for B's bot is held and counted in status; answered once B is back", async () => {
    // A bot on B (bots.create on B's own socket); A's copy of B's table names it.
    const onB: ScriptClient = await b.client("script", "d".repeat(32));
    await onB.sub(onB.srv);
    const snap = await onB.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === onB.srv, "srv snap");
    onB.cmd({ origin: "script", originEpoch: onB.originEpoch, target: onB.srv, n: 1 } as Slot, { type: "bots.create", name: "Remote helper", job: "cli test" }, snap.logId);
    const created = await onB.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
    botB = (created.outcome as { result: { botId: string } }).result.botId;
    onB.close();
    const srvB = `srv:${machinesJson(b).self!.member}`;
    await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(srvB, `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });

    await b.stop();
    const stale = await until(() => { const r = machinesJson(a); return r.peers[0]?.state === "stale" ? r : null; }, { timeout: 30_000, what: "A sees B stale" });
    expect(stale.peers[0].since).not.toBeNull();
    expect(run(a, ["machines"])).toMatch(new RegExp(`^"B" ${bFingerprint}: stale since \\S+Z$`, "m"));

    // A command from a front end on A for B's bot: held at A (row committed), counted by status.
    const inc = withDb(a, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(srvB) as { logId: string }).logId));
    const fe: ScriptClient = await a.client("phone-stand-in", "f".repeat(32));
    fe.cmd({ origin: "phone-stand-in", originEpoch: fe.originEpoch, target: `bot:${botB}`, n: 1 } as Slot, { type: "chat.send", botId: botB, text: "/say held for B" }, inc);
    const held = await fe.wait((m): m is MessageOf<"held"> => m.t === "held", "held");
    expect(held.at).toBe(machinesJson(a).self!.member);
    const status = statusJson(a);
    expect(status.forwardQueue.rows).toBe(1);
    expect(status.machines.peers[0].state).toBe("stale");
    const text = run(a, ["status"]);
    expect(text).toMatch(/^forward queue: 1 command held for other machines \(oldest since \S+Z\)$/m);
    expect(run(a, ["machines"])).toMatch(/: stale since \S+Z · 1 held for it$/m);
    // Under an hour: no Doctor note yet.
    expect(status.notes.filter((note) => note.id === "peer-stale" || note.id === "forward-queue-old")).toEqual([]);
    fe.close();

    // Doctor notes: A stopped, its stored times aged by two hours (status reads the data folder).
    await a.stop();
    withDb(a, (db) => {
      db.prepare("UPDATE forwardq SET heldAt = heldAt - ?").run(2 * HOUR);
      db.prepare("UPDATE streams SET heardAt = heardAt - ? WHERE stream = ?").run(2 * HOUR, srvB);
    }, true);
    const offline = statusJson(a);
    expect(offline.machines.peers).toEqual([expect.objectContaining({ name: "B", state: "stale", from: "stored" })]);
    const ids = offline.notes.map((note) => note.id);
    expect(ids).toContain("peer-stale");
    expect(ids).toContain("forward-queue-old");
    const offlineText = run(a, ["status"]);
    expect(offlineText).toMatch(new RegExp(`^note: Machine "B" \\(${bFingerprint}\\) has not been heard from since \\S+Z \\(over an hour\\)`, "m"));
    expect(offlineText).toMatch(/^note: 1 command for machine "B" has been held since \S+Z \(over an hour\)/m);
    expect(run(a, ["machines"])).toMatch(/^botlingd is not running: states are as last stored/m);

    // Both back: the held command is forwarded and answered by B; the queue empties; B live again; the notes go.
    await Promise.all([a.start(), b.start()]);
    // B decides it (a local-socket front end's scope is decided as `read` at the owner, step 9, so B refuses the
    // chat.send); its outcome deletes A's row either way.
    const after = await until(() => { const r = statusJson(a); return r.forwardQueue.rows === 0 && r.machines.peers[0]?.state === "live" ? r : null; }, { timeout: 60_000, what: "queue empty and B live" });
    expect(after.notes.filter((note) => note.id === "peer-stale" || note.id === "forward-queue-old")).toEqual([]);
    expect(run(a, ["status"])).toMatch(/^forward queue: empty$/m);
  }, 240_000);

  it("log scan: no private key, VAPID private key, token or code in any output, log or data file but the one meant to hold it", () => {
    const keyHolders = new Set(["server-keys.json", "vapid-keys.json", "botlingd.token"]);
    const needles: Array<{ what: string; bytes: Buffer[]; holders: Set<string> }> = [];
    for (const server of [a, b]) {
      const keys = JSON.parse(readFileSync(join(server.dataDir, "server-keys.json"), "utf8")) as { sign: { pkcs8: string }; dh: { pkcs8: string } };
      for (const [what, value] of [["sign key", keys.sign.pkcs8], ["dh key", keys.dh.pkcs8]] as const) {
        needles.push({ what: `${server.name} ${what}`, bytes: [Buffer.from(value), Buffer.from(fromBase64Url(value)!)], holders: new Set(["server-keys.json"]) });
      }
      const vapid = JSON.parse(readFileSync(join(server.dataDir, "vapid-keys.json"), "utf8")) as { privateKey: string };
      needles.push({ what: `${server.name} VAPID private key`, bytes: [Buffer.from(vapid.privateKey), Buffer.from(fromBase64Url(vapid.privateKey)!)], holders: new Set(["vapid-keys.json"]) });
      needles.push({ what: `${server.name} token`, bytes: [Buffer.from(server.token)], holders: new Set(["botlingd.token"]) });
    }
    for (const code of codes) needles.push({ what: "a pairing code", bytes: [Buffer.from(code), Buffer.from(code.replace(/[-\s]/g, ""))], holders: new Set() });
    expect(needles.length).toBe(2 * 4 + codes.length);
    expect(outputs.length).toBeGreaterThan(20);

    const texts: Array<{ where: string; bytes: Buffer }> = outputs.map((text, i) => ({ where: `CLI output ${i}`, bytes: Buffer.from(text) }));
    for (const server of [a, b]) {
      texts.push({ where: `${server.name} stdout`, bytes: Buffer.from(server.stdout) }, { where: `${server.name} stderr`, bytes: Buffer.from(server.stderr) });
      for (const file of filesUnder(server.dataDir)) texts.push({ where: `${server.name}:${basename(file)}`, bytes: readFileSync(file) });
    }
    const logs = texts.filter((t) => /\.log/.test(t.where));
    expect(logs.length).toBeGreaterThanOrEqual(2); // botlingd.log of both
    const found: string[] = [];
    for (const text of texts) {
      const file = text.where.includes(":") ? text.where.split(":")[1] : "";
      for (const needle of needles) {
        if (needle.holders.has(file)) continue;
        if (needle.bytes.some((bytes) => text.bytes.includes(bytes))) found.push(`${needle.what} in ${text.where}`);
      }
    }
    expect(found).toEqual([]);
    expect(keyHolders.size).toBe(3);
  });
});
