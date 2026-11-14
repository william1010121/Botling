// Botling 3 M3 step 4 (m3-brief §4 row 4): server pairing between two real botlingd on this machine, through the real
// CLI path (`botlingd join` on B, `botlingd add-machine <link>` on A, both with piped stdin/stdout) over loopback.
//
// - The first add-machine creates A's cluster (recovery code typed back); both fingerprints are shown on both sides;
//   three wrong codes decline the offer on both sides, and that link is then refused (burned).
// - A link past its time is refused before anything is dialled; a server that already belongs to a cluster refuses to
//   make a join offer.
// - A pairing cut mid-way (the proxy in front of B drops S's welcome, after S committed its Add of B, and cuts the
//   connection): no half cluster (B has no cluster, B's offer is given back); the retry with the same link completes.
// - Afterwards both rosters hold both Adds (A's of B `joined: true`, B's of A `joined: false`); B endorsed every valid
//   member (a device of A's); B's cluster id is A's and the Root is A's; B holds A's VAPID key (0600), kept across a
//   restart of either; the step-3 peer session comes up between them with no roster write by the test after pairing;
//   the used link is refused again (reused).
// - The join codes and the recovery code never reach either data folder or log (byte scan); loopback only.
// Requires `npm run build` (out/server/main.cjs).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { joinLink, parseJoinLink, type SignedStatement } from "../../src/protocol";
import { parseStored } from "../../src/server/roster";
import { botlingdScript } from "../botlingd-harness";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { readServerKeys, sign, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 1_000, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };

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
  /** Waits for a line matching `pattern` (after `from` characters of output); returns the match. */
  async line(pattern: RegExp, from = 0, timeout = 30_000): Promise<RegExpMatchArray> {
    return until(() => this.out.slice(from).match(pattern), { timeout, every: 20, what: `${pattern} in\n${this.out}\n${this.err}` });
  }
  /** Counts lines matching `pattern` so far. */
  count(pattern: RegExp): number { return this.out.split("\n").filter((line) => pattern.test(line)).length; }
  type(text: string): void { this.child.stdin.write(`${text}\n`); }
  async exit(timeout = 60_000): Promise<number | null> {
    const late = setTimeout(() => this.child.kill("SIGKILL"), timeout);
    try { return await this.done; } finally { clearTimeout(late); }
  }
}

interface PeerFile { peers: Array<{ member: string; state: string; sessionId?: string }> }
function peerState(server: TestServer): PeerFile["peers"][number] | null {
  try { return (JSON.parse(readFileSync(join(server.dataDir, "botlingd.peers.json"), "utf8")) as PeerFile).peers[0] ?? null; } catch { return null; }
}

/** The roster rows and cluster id of a server (read-only; the server may be running, WAL). */
function rosterOf(server: TestServer): { clusterId: string | null; statements: SignedStatement[] } {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try {
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'clusterId'").get() as { value?: string } | undefined;
    const rows = db.prepare("SELECT bytes FROM roster ORDER BY id").all() as Array<{ bytes: Uint8Array }>;
    return { clusterId: meta?.value ?? null, statements: rows.map((row) => parseStored(row.bytes)!).filter(Boolean) };
  } finally {
    db.close();
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path)); else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** A well-formed code that is not `code`. */
function wrongCode(code: string): string {
  const candidate = "0000-0000";
  return candidate.replace("-", "") === code.replace("-", "") ? "1111-1111" : candidate;
}

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pb: FaultProxy;
const secrets: string[] = []; // every join code and the recovery code, for the byte scan
let deviceMember = "";
let usedLink = "";

beforeAll(async () => {
  cluster = await startServers({ name: "join", env: { A: TIMERS_ENV, B: TIMERS_ENV } });
  ({ a, b } = cluster);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pb = await cluster.proxy(b, "websocket");
}, 120_000);

afterAll(async () => { await cluster?.cleanup(); }, 60_000);

describe("M3 step 4: server pairing between two botlingd", () => {
  it("first add-machine makes A's cluster; both fingerprints shown; three wrong codes decline on both sides; that link is then refused", async () => {
    const join1 = new CliRun(b, ["join", "--name", "B"]);
    const code = (await join1.line(/^Code:\s+(\S+)$/m))[1];
    const nFingerprint = (await join1.line(/^Fingerprint:\s+(\S.*)$/m))[1];
    const link = (await join1.line(/^(botling-join:\S+)$/m))[1];
    secrets.push(code);

    const add = new CliRun(a, ["add-machine", link]);
    const recovery = (await add.line(/^Your recovery code.*\n\n\s+(\S[^\n]*)$/m))[1].trim();
    secrets.push(recovery);
    await add.line(/^Recovery code:/m);
    add.type(recovery);
    await add.line(/^Cluster \S+ created\./m);
    const sFingerprint = (await add.line(/^This machine's fingerprint:\s+(\S.*)$/m))[1];
    expect((await add.line(/^"B" fingerprint:\s+(\S.*)$/m))[1]).toBe(nFingerprint);
    // N shows S's fingerprint once S dials.
    expect((await join1.line(/Its fingerprint: (\S.*)$/m))[1]).toBe(sFingerprint);
    expect(nFingerprint).not.toBe(sFingerprint);
    // Review R1 (interim): N's fingerprint is confirmed with "yes" before the code is asked for.
    expect((await add.line(/^Does "B" show exactly this fingerprint for itself: (\S.*)\? Type yes/m))[1]).toBe(nFingerprint);
    expect(add.out).not.toMatch(/^Code shown on "B":/m);
    add.type("yes");

    // A malformed code uses no try; three wrong ones decline.
    let mark = add.out.length;
    await add.line(/^Code shown on "B":/m, mark - 200);
    add.type("12345");
    await add.line(/That is not a code/m, mark);
    for (const left of [2, 1]) {
      mark = add.out.length;
      add.type(wrongCode(code));
      await add.line(new RegExp(`That is not the code shown there \\(${left} tr`), mark);
      await join1.line(new RegExp(`A wrong code was typed there \\(${left} tr`));
    }
    add.type(wrongCode(code));
    await add.line(/^Declined: three wrong codes/m);
    expect(await add.exit()).toBe(1);
    await join1.line(/^Declined: three wrong codes/m);
    expect(await join1.exit()).toBe(1);
    expect(rosterOf(b).clusterId).toBeNull();

    // The burned link is refused.
    const again = new CliRun(a, ["add-machine", link]);
    expect(await again.exit()).toBe(1);
    expect(again.out).not.toMatch(/^Added/m);
    expect(again.out).toMatch(/Cannot pair that machine|declined|ended/i);
    expect(rosterOf(b).clusterId).toBeNull();
  }, 90_000);

  it("a link past its time is refused before anything is dialled; a server with a cluster refuses to make an offer", async () => {
    const join2 = new CliRun(b, ["join", "--name", "B"]);
    secrets.push((await join2.line(/^Code:\s+(\S+)$/m))[1]);
    const link = (await join2.line(/^(botling-join:\S+)$/m))[1];
    const offer = parseJoinLink(link)!;
    const stale = joinLink({ ...offer, expiresAt: Date.now() - 1_000 });
    const opened = pb.count("open") + cluster.proxies.length * 0;
    const late = new CliRun(a, ["add-machine", stale]);
    expect(await late.exit()).toBe(1);
    expect(late.out).toMatch(/Cannot pair that machine: .*expired/i);
    expect(pb.count("open")).toBe(opened);
    // Review R1 (interim): --expect-fingerprint naming another server refuses before anything is dialled.
    const viaProxy = joinLink({ ...offer, addresses: [`ws://127.0.0.1:${pb.port}/v3/ws`] });
    const wrongFp = new CliRun(a, ["add-machine", viaProxy, "--expect-fingerprint", "AAAA AAAA AAAA AAAA AAAA AAAA AA"]);
    expect(await wrongFp.exit()).toBe(1);
    expect(wrongFp.out).toMatch(/not the expected one; nothing was dialled/);
    expect(pb.count("open")).toBe(opened);
    join2.child.kill("SIGTERM");
    await join2.exit();

    const onA = new CliRun(a, ["join", "--name", "A"]);
    expect(await onA.exit()).toBe(1);
    expect(onA.out).toMatch(/Cannot make a join offer: .*(cluster|member)/i);
  }, 60_000);

  it("a pairing cut after S's commit leaves no half cluster; the retry with the same link completes", async () => {
    // A device of A's, so that B has someone to endorse.
    await a.stop();
    const phone = await (await import("../support/peer-cluster")).strangerKeys();
    const clusterId = rosterOf(a).clusterId!;
    const addPhone = await sign({ type: "add", cluster: clusterId, member: phone.memberId, kind: "device", keys: { sign: phone.sign, dh: phone.dh }, name: "Phone", scope: ["read"], by: ka.memberId, at: Date.now() }, ka);
    writeStatements(a.dataDir, clusterId, [addPhone]);
    deviceMember = phone.memberId;
    await a.start();

    const join3 = new CliRun(b, ["join", "--name", "B"]);
    const code = (await join3.line(/^Code:\s+(\S+)$/m))[1];
    secrets.push(code);
    const link = (await join3.line(/^(botling-join:\S+)$/m))[1];
    const offer = parseJoinLink(link)!;
    // S reaches B through the proxy.
    usedLink = joinLink({ ...offer, addresses: [`ws://127.0.0.1:${pb.port}/v3/ws`] });

    // The welcome (the roster and the VAPID key: the one big frame S sends) is dropped; then the connection is cut.
    pb.drop("up", 1, (payload) => payload.length > 1_500);
    // Unattended form (review R1 interim): the expected fingerprint on the command line instead of "yes".
    const first = new CliRun(a, ["add-machine", usedLink, "--expect-fingerprint", (await join3.line(/^Fingerprint:\s+(\S.*)$/m))[1]]);
    await first.line(/^"B" has the expected fingerprint\./m);
    await first.line(/^Code shown on "B":/m);
    first.type(code);
    await until(() => pb.count("drop", "up") > 0, { timeout: 20_000, what: "welcome dropped" });
    pb.cut();
    expect(await first.exit()).toBe(1);
    expect(first.out).not.toMatch(/^Added/m);
    // No half cluster: B has none; S's Add of B is in A's roster (idempotent; the retry signs no second one).
    expect(rosterOf(b).clusterId).toBeNull();
    const addsOfB = () => rosterOf(a).statements.filter((s) => s.body.type === "add" && s.body.member === kb.memberId);
    expect(addsOfB()).toHaveLength(1);
    expect(join3.child.exitCode).toBeNull(); // N still waits: the offer was given back

    const retry = new CliRun(a, ["add-machine", usedLink]);
    await retry.line(/^Does "B" show exactly this fingerprint/m);
    retry.type("yes");
    await retry.line(/^Code shown on "B":/m);
    retry.type(code);
    await retry.line(/^Added "B" \(\S+\) to cluster \S+\./m, 0, 30_000);
    expect(await retry.exit()).toBe(0);
    await join3.line(/^Joined cluster \S+ through \S+\./m);
    expect(await join3.exit()).toBe(0);
    expect(addsOfB()).toHaveLength(1);
  }, 120_000);

  it("both rosters hold both Adds; B endorsed every valid member; same cluster id and Root; VAPID key handed over (0600)", async () => {
    const ra = rosterOf(a), rb = rosterOf(b);
    expect(rb.clusterId).toBe(ra.clusterId);
    const find = (statements: SignedStatement[], member: string, by: string) => statements.find((s) => s.body.type === "add" && s.body.member === member && s.body.by === by);
    for (const roster of [ra, rb]) {
      expect(find(roster.statements, kb.memberId, ka.memberId)?.body).toMatchObject({ kind: "server", joined: true });
      expect(find(roster.statements, ka.memberId, kb.memberId)?.body).toMatchObject({ kind: "server", joined: false });
    }
    const roots = (statements: SignedStatement[]) => statements.filter((s) => s.body.type === "root");
    expect(roots(rb.statements)).toEqual(roots(ra.statements));
    expect(roots(rb.statements)).toHaveLength(1);
    expect(roots(rb.statements)[0].body).toMatchObject({ root: ka.memberId });
    const endorsedByB = rb.statements.filter((s) => s.body.type === "endorse" && s.body.by === kb.memberId).map((s) => (s.body as { member: string }).member);
    expect(endorsedByB).toEqual([deviceMember]);
    // Each server wrote its own Profile{addresses}.
    for (const [roster, self] of [[ra, ka], [rb, kb]] as const) {
      expect(roster.statements.some((s) => s.body.type === "profile" && s.body.member === self.memberId && s.signer === self.memberId && s.body.field === "addresses")).toBe(true);
    }

    const vapid = (server: TestServer) => ({ text: readFileSync(join(server.dataDir, "vapid-keys.json"), "utf8"), mode: statSync(join(server.dataDir, "vapid-keys.json")).mode & 0o777 });
    const va = vapid(a), vb = vapid(b);
    expect(vb.text).toBe(va.text);
    expect(vb.mode).toBe(0o600);
    expect(va.mode).toBe(0o600);
    expect(JSON.parse(vb.text)).toMatchObject({ v: 1 });
  });

  it("the step-3 peer session comes up with no roster write by the test; restarts keep the VAPID key and the session", async () => {
    const live = () => until(() => {
      const sa = peerState(a), sb = peerState(b);
      return sa?.state === "live" && sb?.state === "live" && sa.sessionId && sa.sessionId === sb.sessionId ? sa.sessionId : null;
    }, { timeout: 30_000, every: 50, what: "both live on one session" });
    const first = await live();
    expect(peerState(a)!.member).toBe(kb.memberId);
    expect(peerState(b)!.member).toBe(ka.memberId);
    const before = readFileSync(join(a.dataDir, "vapid-keys.json"), "utf8");
    await b.restart();
    await a.restart();
    expect(readFileSync(join(b.dataDir, "vapid-keys.json"), "utf8")).toBe(before);
    expect(readFileSync(join(a.dataDir, "vapid-keys.json"), "utf8")).toBe(before);
    expect(statSync(join(b.dataDir, "vapid-keys.json")).mode & 0o777).toBe(0o600);
    expect(await live()).not.toBe(first);
    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
  }, 90_000);

  it("the used link is refused (reused); B, now a member, refuses to make an offer", async () => {
    const reuse = new CliRun(a, ["add-machine", usedLink]);
    expect(await reuse.exit()).toBe(1);
    expect(reuse.out).not.toMatch(/^Added/m);
    const onB = new CliRun(b, ["join", "--name", "B"]);
    expect(await onB.exit()).toBe(1);
    expect(onB.out).toMatch(/Cannot make a join offer/);
  }, 60_000);

  it("no join code or recovery code in either data folder or log (byte scan)", () => {
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    const needles = secrets.flatMap((secret) => [secret, secret.replace(/[-\s]/g, "")]).map((text) => Buffer.from(text));
    for (const server of [a, b]) {
      for (const file of filesUnder(server.dataDir)) {
        const bytes = readFileSync(file);
        for (const needle of needles) expect(bytes.includes(needle), `${needle} in ${file}`).toBe(false);
      }
      for (const text of [server.stdout, server.stderr, server.log]) for (const needle of needles) expect(text.includes(needle.toString())).toBe(false);
    }
  });
});
