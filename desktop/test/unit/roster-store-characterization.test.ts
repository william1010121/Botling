// M7-S89: characterization tests for `src/server/roster/store.ts` (`RosterStore`), written BEFORE the file is cut (M7-S90).
// They pin what the store does today: open, createCluster, addDevice, revokeDevice, addServer, joinCluster, revokeServer
// (with and without cascade), reroot, recovery-code replacement, merge / mergeRevocations / mergeGossip (each in both
// orders), profiles, dropped revocations, the audit rows, the listener calls and the rows left in server.db. The
// `Roster` TLA+ model checks the protocol; this file pins the store. Product code is not changed by this card.
//
// How it stays stable:
// - Every key is fixed (a seed per member, a recovery code per cluster) and the clock is a number the test sets, so a run
//   is byte-for-byte repeatable. Signed statements are still compared by CONTENT (body, signer, kind, receivedAt), never
//   by signature bytes, and ids / keys are shown by name (`add:phone@A`, `A.sign`, `root:g2`).
// - A golden is the name-scrubbed JSON of what a call returned, what is stored in `roster`, the `srv:` audit rows and the
//   listener calls. Next to the goldens, every test states the behaviour that matters in plain `expect`s.
// - To regenerate a golden: delete its entry in GOLDEN (bottom of this file), run the file once; the missing ones are
//   printed as `@@GOLDEN <name> <json>` lines and the run fails until they are pasted back in. Read the diff.
// Real WebCrypto, real server.db files in a temp folder, no network, no window.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { clusterIdFromRecoveryKey, memberIdFromKey, rosterDigest, toBase64Url, type SignedStatement, type StatementBody } from "../../src/protocol";
import { bindServerIdentity } from "../../src/server/identity";
import { formatRecoveryCode, newRecoveryCode, recoveryKeyFromCode } from "../../src/server/identity/recovery";
import {
  gossipKeeps, MAX_GOSSIP_SET, readAudits, RECOVERY_REPLACE_TTL_MS, RosterError, RosterStore,
  type RosterChange, type RosterRefusal,
} from "../../src/server/roster/store";
import type { RosterView, VerifiedStatement } from "../../src/server/roster/validity";
import { parseStored, signStatement, signWith, storedBytes, type StoredStatement } from "../../src/server/roster/verify";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

// `replaceRecovery` draws a random code; the tests choose it (everything else about the code is the real thing).
vi.mock("../../src/server/identity/recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/identity/recovery")>();
  return { ...actual, newRecoveryCode: vi.fn(actual.newRecoveryCode) };
});

const root = testRoot("roster-store-char");
const stores: ServerStore[] = [];
const missingGoldens: string[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (missingGoldens.length) throw new Error(`no golden for: ${missingGoldens.join(", ")} (see the @@GOLDEN lines above)`);
});
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

let folderCount = 0;
function folder(): string {
  const dir = join(root, `d${++folderCount}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const CODE1 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE2 = "ZYXWVUTSRQPONMLKJIHGFEDCBA";
const CODE3 = "23456723456723456723456723";

// ---------------------------------------------------------------------------------------------------------------------
// Fixed members (an Ed25519 seed each), nodes (a member with a real server.db and a RosterStore) and name scrubbing.
// ---------------------------------------------------------------------------------------------------------------------

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

interface Member {
  readonly memberId: string;
  readonly keys: { readonly sign: string; readonly dh: string };
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

async function member(seed: number): Promise<Member> {
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.fill(seed, PKCS8_PREFIX.length);
  const spki = createPublicKey(createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  const signPub = new Uint8Array(spki.subarray(12));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return {
    memberId: await memberIdFromKey(signPub),
    keys: { sign: toBase64Url(signPub), dh: toBase64Url(new Uint8Array(32).fill(0x80 + seed)) },
    sign: signWith(key),
  };
}

interface Node {
  readonly name: string;
  readonly store: ServerStore;
  readonly identity: Member;
  roster: RosterStore;
  readonly log: string[];
  readonly changes: Array<{ invalidated: string[]; valid: string[]; rootGen: number | null; dropped: number }>;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

class Names {
  private readonly map = new Map<string, string>();
  readonly nodes: Node[] = [];
  set(value: string, label: string): void { if (!this.map.has(value)) this.map.set(value, label); }
  member(who: Member, label: string): void {
    this.set(who.memberId, label);
    this.set(who.keys.sign, `${label}.sign`);
    this.set(who.keys.dh, `${label}.dh`);
  }
  get(value: string): string { return this.map.get(value) ?? value; }
  private label(body: StatementBody): string {
    const n = (id: string) => this.get(id);
    switch (body.type) {
      case "add": return `add:${n(body.member)}@${n(body.by)}`;
      case "endorse": return `endorse:${n(body.member)}@${n(body.by)}`;
      case "revoke": return `revoke:${n(body.member)}@${n(body.by)}:g${body.gen}${body.cascade === true ? ":cascade" : ""}`;
      case "root": return `root:g${body.gen}`;
      case "profile": return `profile:${n(body.member)}.${body.field}@${body.hlc.ms}.${body.hlc.c}`;
    }
  }
  learn(items: readonly StoredStatement[]): void {
    for (const item of [...items].sort(byId)) {
      if (this.map.has(item.id)) continue;
      const base = this.label(item.statement.body);
      let label = base;
      for (let copy = 2; [...this.map.values()].includes(label); copy++) label = `${base}~${copy}`;
      this.map.set(item.id, label);
      this.map.set(item.id.slice(0, 56), `${label}[:56]`);
    }
  }
  scrub(value: unknown): unknown {
    for (const node of this.nodes) this.learn(node.roster.statements());
    const keys = [...this.map.keys()].sort((a, b) => b.length - a.length).map((key) => key.replace(/[-_.*+?^${}()|[\]\\]/g, "\\$&"));
    let text = JSON.stringify(value) ?? "null";
    if (keys.length) {
      const pattern = new RegExp(keys.join("|"), "g");
      text = text.replace(pattern, (hit) => this.map.get(hit) ?? hit);
    }
    // Long free text (a 600-character reason, a 2,500-character value) is shown by its length.
    return JSON.parse(text, (_key, item: unknown) => (typeof item === "string" && item.length > 200 ? `<${item.length} chars>` : item));
  }
}

interface Harness {
  clock: { now: number };
  names: Names;
  node(name: string, seed: number): Promise<Node>;
  reopen(node: Node): Promise<RosterStore>;
  show(value: unknown): unknown;
  nm(id: string): string;
  lab(ids: Iterable<string>): string[];
  raw(node: Node): { roster: Array<{ id: string; kind: string; member: string; receivedAt: number; statement: SignedStatement | null }>; audit: Array<{ key: string; rev: number; body: unknown }>; meta: Array<{ key: string; value: string }> };
  stored(node: Node): Record<string, unknown>;
  audits(node: Node): unknown;
  viewOf(node: Node): unknown;
  trace(node: Node): string;
  changesOf(node: Node): Node["changes"];
  dump(node: Node, parts?: Array<"stored" | "audit" | "meta" | "changes" | "view">): unknown;
  golden(name: string, actual: unknown): void;
  tick(ms?: number): void;
}

function harness(): Harness {
  const clock = { now: 1_000_000 };
  const names = new Names();
  const attach = (node: Node, roster: RosterStore) => {
    roster.onChange((change: RosterChange) => {
      node.changes.push({ invalidated: [...change.invalidated], valid: [...change.view.valid].sort(), rootGen: change.view.root?.gen ?? null, dropped: change.view.dropped.length });
    });
    node.roster = roster;
  };
  const h: Harness = {
    clock,
    names,
    async node(name, seed) {
      const store = await openServerStore(folder());
      stores.push(store);
      const identity = await member(seed);
      names.member(identity, name);
      await store.submit((tx) => bindServerIdentity(tx, identity));
      const log: string[] = [];
      const node: Node = { name, store, identity, roster: undefined as unknown as RosterStore, log, changes: [] };
      attach(node, await RosterStore.open(store, identity, { now: () => clock.now, log: (line) => log.push(line) }));
      names.nodes.push(node);
      return node;
    },
    async reopen(node) {
      const roster = await RosterStore.open(node.store, node.identity, { now: () => clock.now, log: (line) => node.log.push(line) });
      attach(node, roster);
      return roster;
    },
    show: (value) => names.scrub(value),
    nm: (id) => { names.scrub(null); return names.get(id); },
    lab: (ids) => { names.scrub(null); return [...ids].map((id) => names.get(id)).sort(); },
    raw(node) {
      const reader = node.store.openReader();
      try {
        const roster = reader.prepare("SELECT id, kind, member, bytes, receivedAt FROM roster ORDER BY id").all().map((row) => ({
          id: String(row.id), kind: String(row.kind), member: String(row.member), receivedAt: Number(row.receivedAt), statement: parseStored(row.bytes as Uint8Array),
        }));
        const serverId = reader.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
        const audit = serverId
          ? reader.prepare("SELECT key, rev, body FROM rows WHERE stream = ? ORDER BY rev").all(`srv:${String(serverId.value)}`).map((row) => ({ key: String(row.key), rev: Number(row.rev), body: JSON.parse(String(row.body)) as unknown }))
          : [];
        const meta = reader.prepare("SELECT key, value FROM meta WHERE key = 'clusterId' OR key LIKE 'dropped.dismissed:%' ORDER BY key").all().map((row) => ({ key: String(row.key), value: String(row.value) }));
        return { roster, audit, meta };
      } finally {
        reader.close();
      }
    },
    stored(node) {
      const rows = h.raw(node).roster.map((row) => ({ label: h.nm(row.id), row }));
      rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      return Object.fromEntries(rows.map(({ label, row }) => [label, {
        kind: row.kind, member: row.member, receivedAt: row.receivedAt, signer: row.statement?.signer ?? null, body: row.statement?.body ?? null,
      }]));
    },
    audits(node) { return h.raw(node).audit; },
    viewOf(node) {
      const view = node.roster.view;
      return {
        cluster: view.cluster,
        root: view.root ? { id: view.root.id, gen: view.root.gen, root: view.root.root, recoveryPub: view.root.recoveryPub, keep: h.lab(view.root.keep) } : null,
        servers: h.lab(view.servers),
        valid: h.lab(view.valid),
        revoked: h.lab(view.revoked),
        members: [...view.members.values()].map(({ keys: _keys, ...info }) => info).sort((a, b) => (h.nm(a.member) < h.nm(b.member) ? -1 : 1)),
        countingRevokes: h.lab(view.countingRevokes),
        dropped: view.dropped.map((row) => ({ ...row })),
      };
    },
    trace(node) {
      return JSON.stringify([h.raw(node), node.changes.length, node.roster.clusterId, node.roster.statements().map((item) => item.id)]);
    },
    changesOf(node) {
      return node.changes.map((change) => ({ ...change, invalidated: h.lab(change.invalidated), valid: h.lab(change.valid) }));
    },
    dump(node, parts = ["stored", "audit", "meta", "changes", "view"]) {
      const all: Record<string, () => unknown> = {
        stored: () => h.stored(node), audit: () => h.audits(node), meta: () => h.raw(node).meta, changes: () => h.changesOf(node), view: () => h.viewOf(node),
      };
      return Object.fromEntries(parts.map((part) => [part, all[part]()]));
    },
    golden(name, actual) { pin(name, h.show(actual)); },
    tick(ms = 1_000) { clock.now += ms; },
  };
  return h;
}

/** Compares an already name-scrubbed value with its golden (or prints it when the golden is missing). */
function pin(name: string, shown: unknown): void {
  const want = GOLDEN[name];
  if (want === undefined) {
    missingGoldens.push(name);
    console.log(`@@GOLDEN ${name} ${JSON.stringify(shown)}`);
    return;
  }
  expect(shown, `golden ${name}`).toEqual(want);
}

/** What a refused act says: the reason and the message. */
async function refuses(p: Promise<unknown>, reason: RosterRefusal): Promise<{ reason: string; message: string }> {
  const error = await p.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(RosterError);
  expect((error as RosterError).name).toBe("RosterError");
  expect((error as RosterError).reason).toBe(reason);
  return { reason: (error as RosterError).reason, message: (error as RosterError).message };
}

/** A refused act leaves no trace: no row, no audit, no listener call, same cluster and statements. */
async function refusesClean(h: Harness, node: Node, p: () => Promise<unknown>, reason: RosterRefusal) {
  const before = h.trace(node);
  const said = await refuses(p(), reason);
  expect(h.trace(node), `a refused ${reason} changed the store`).toBe(before);
  return said;
}

async function genesis(h: Harness, A: Node, code = CODE1, tag = "R1") {
  const key = await recoveryKeyFromCode(code);
  const clusterId = await clusterIdFromRecoveryKey(key.publicKey);
  h.names.set(key.recoveryPub, `${tag}.pub`);
  h.names.set(clusterId, "cluster");
  const rootStatement = await signStatement(
    { type: "root", cluster: clusterId, gen: 1, root: A.identity.memberId, recoveryPub: key.recoveryPub, keep: [], prev: null },
    "recovery",
    signWith(key.privateKey),
  );
  return { root: rootStatement, clusterId, key };
}

async function startCluster(h: Harness, name = "A", seed = 1) {
  const A = await h.node(name, seed);
  const made = await genesis(h, A);
  await A.roster.createCluster(made.root, made.clusterId);
  return { A, ...made };
}

/** The audit rows (newest first) through a reader that is closed again. */
function auditRows(node: Node, limit?: number) {
  const reader = node.store.openReader();
  try { return readAudits(reader, limit); } finally { reader.close(); }
}

const statementOf = (node: Node, id: string): SignedStatement => node.roster.statements().find((item) => item.id === id)!.statement;
const allStatements = (node: Node): SignedStatement[] => node.roster.statements().map((item) => item.statement);

/** `sponsor` adds a new server; the new server joins through it. */
async function joinServer(h: Harness, sponsor: Node, name: string, seed: number): Promise<Node> {
  const N = await h.node(name, seed);
  const added = await sponsor.roster.addServer({ keys: N.identity.keys, name: `Server ${name}` });
  await N.roster.joinCluster({
    add: statementOf(sponsor, added.addId),
    roster: allStatements(sponsor),
    sponsor: { member: sponsor.identity.memberId, keys: sponsor.identity.keys, name: `Server ${sponsor.name}` },
  });
  return N;
}

/** Every node merges every node's statements, twice (the second round carries the endorsements the first one made). */
async function sync(...nodes: Node[]): Promise<void> {
  for (let round = 0; round < 2; round++) {
    const all = nodes.flatMap(allStatements);
    for (const node of nodes) await node.roster.merge(all);
  }
}

/** A root, B joined through A, C joined through B, and a phone added by B; all synced. */
async function threeServers(h: Harness) {
  const { A, root, clusterId, key } = await startCluster(h);
  h.tick();
  const B = await joinServer(h, A, "B", 2);
  h.tick();
  const C = await joinServer(h, B, "C", 3);
  h.tick();
  const phone = await member(10);
  h.names.member(phone, "phone");
  await B.roster.addDevice({ keys: phone.keys, name: "Phone" });
  h.tick();
  await sync(A, B, C);
  return { A, B, C, phone, root, clusterId, key };
}

const idsOf = (statements: Array<{ id: string }>) => statements.map((item) => item.id);

// ---------------------------------------------------------------------------------------------------------------------

describe("RosterStore characterization (M7-S89)", () => {
  it("a store with no cluster: an empty view and digest, every act refuses with no-cluster, nothing is written", async () => {
    const h = harness();
    const N = await h.node("N", 1);
    const roster = N.roster;
    expect(roster.clusterId).toBeNull();
    expect(roster.memberId).toBe(N.identity.memberId);
    expect(roster.view.cluster).toBeNull();
    expect(roster.view.root).toBeNull();
    // With no cluster the view holds this server alone, valid.
    expect([...roster.view.valid]).toEqual([N.identity.memberId]);
    expect(roster.statements()).toEqual([]);
    expect(roster.isValid(N.identity.memberId)).toBe(true);
    expect(roster.isValid("someone else")).toBe(false);
    expect(roster.device("x")).toBeNull();
    expect(await roster.digest()).toBe(await rosterDigest([]));
    expect(roster.keepCandidates()).toEqual([]);
    expect(roster.dropped()).toEqual([]);
    expect(roster.revocations()).toEqual([]);
    expect(roster.gossipStatements()).toEqual([]);
    expect(roster.statementsById(["nope"])).toEqual([]);
    expect(roster.cascadePreview("anyone")).toEqual([]);
    expect(roster.profile("anyone", "name")).toBeNull();
    expect(roster.pushSubscription("anyone")).toBeNull();
    expect(roster.pushSubscriptions()).toEqual([]);
    await roster.idle();

    const dev = await member(10);
    const said: Record<string, unknown> = {};
    const trial = async (name: string, act: () => Promise<unknown>) => { said[name] = await refusesClean(h, N, act, "no-cluster"); };
    await trial("addDevice", () => roster.addDevice({ keys: dev.keys, name: "d" }));
    await trial("addServer", () => roster.addServer({ keys: dev.keys, name: "s" }));
    await trial("revokeDevice", () => roster.revokeDevice("d"));
    await trial("revokeServer", () => roster.revokeServer("s", false));
    await trial("merge", () => roster.merge([]));
    await trial("writeProfile", () => roster.writeProfile(N.identity.memberId, "name", "x"));
    await trial("dismissDropped", () => roster.dismissDropped("r"));
    await trial("reroot", () => roster.reroot({ code: CODE1, oldRootLost: false, keep: [] }));
    await trial("replaceRecovery", () => roster.replaceRecovery(CODE1));
    const before = h.trace(N);
    expect(await roster.confirmRecovery(CODE1)).toEqual({ ok: false, reason: "no-cluster" });
    expect(await roster.mergeRevocations([{ nonsense: true }])).toEqual([]);
    expect(await roster.mergeGossip([{ nonsense: true }])).toEqual({ fresh: [], refused: [] });
    expect(h.trace(N)).toBe(before);
    h.golden("empty.refusals", said);
  });

  it("createCluster: refuses a Root that is not gen 1 / this server / this cluster / signed by the recovery key; makes the cluster once", async () => {
    const h = harness();
    const A = await h.node("A", 1);
    const made = await genesis(h, A);
    const other = await recoveryKeyFromCode(CODE2);
    h.names.set(other.recoveryPub, "R2.pub");
    const body = { type: "root" as const, cluster: made.clusterId, gen: 1, root: A.identity.memberId, recoveryPub: made.key.recoveryPub, keep: [] as string[], prev: null };
    const said: Record<string, unknown> = {};
    const gen2 = await signStatement({ ...body, gen: 2, prev: "a".repeat(64) }, "recovery", signWith(made.key.privateKey));
    said.gen2 = await refusesClean(h, A, () => A.roster.createCluster(gen2, made.clusterId), "bad-root");
    const notMe = await signStatement({ ...body, root: (await member(77)).memberId }, "recovery", signWith(made.key.privateKey));
    said.notThisServer = await refusesClean(h, A, () => A.roster.createCluster(notMe, made.clusterId), "bad-root");
    said.otherClusterId = await refusesClean(h, A, () => A.roster.createCluster(made.root, "f".repeat(32)), "bad-root");
    const forged = await signStatement(body, "recovery", signWith(other.privateKey));
    said.signedByAnotherKey = await refusesClean(h, A, () => A.roster.createCluster(forged, made.clusterId), "bad-root");
    expect(A.roster.clusterId).toBeNull();

    h.tick();
    const view = await A.roster.createCluster(made.root, made.clusterId);
    expect(view).toBe(A.roster.view);
    expect(A.roster.clusterId).toBe(made.clusterId);
    expect(view.root?.id).toBe(made.root.id);
    expect(view.root?.gen).toBe(1);
    expect(view.root?.root).toBe(A.identity.memberId);
    expect([...view.valid]).toEqual([A.identity.memberId]);
    expect(A.changes).toHaveLength(1);
    expect(A.changes[0].invalidated).toEqual([]);
    said.again = await refusesClean(h, A, () => A.roster.createCluster(made.root, made.clusterId), "cluster-exists");

    // The same store opened again gives the same view and the same digest.
    const digest = await A.roster.digest();
    const rootId = A.roster.view.root!.id;
    const second = await h.reopen(A);
    expect(second.clusterId).toBe(made.clusterId);
    expect(second.view.root?.id).toBe(rootId);
    expect(await second.digest()).toBe(digest);
    expect(idsOf(second.statements())).toEqual([made.root.id]);
    h.golden("create.refusals", said);
    h.golden("create.dump", h.dump(A));
  });

  it("createCluster inside the transaction: a second store instance on the same file loses the race with cluster-exists and rolls back", async () => {
    const h = harness();
    const A = await h.node("A", 1);
    const made = await genesis(h, A);
    const late = await h.reopen(A); // a second view of the same server.db; A.roster is now `late`, keep the first one too
    const first = await RosterStore.open(A.store, A.identity, { now: () => h.clock.now });
    await first.createCluster(made.root, made.clusterId);
    // `late` still believes there is no cluster; the transaction finds meta.clusterId and refuses.
    expect(late.clusterId).toBeNull();
    const second = await genesis(h, A, CODE2, "R2");
    const said = await refuses(late.createCluster(second.root, second.clusterId), "cluster-exists");
    expect(late.clusterId).toBeNull();
    expect(late.statements()).toEqual([]);
    const rows = h.raw(A);
    expect(rows.roster.map((row) => row.id)).toEqual([made.root.id]);
    expect(rows.meta).toEqual([{ key: "clusterId", value: made.clusterId }]);
    expect(rows.audit).toHaveLength(1);
    A.roster = first;
    h.golden("create.race", { said, rows: h.stored(A), audit: rows.audit });
  });

  it("a failed commit rolls back: with no serverId the audit write throws, the cluster is not made, the queue still works", async () => {
    const h = harness();
    const A = await h.node("A", 1);
    const made = await genesis(h, A);
    await A.store.submit((tx) => { tx.prepare("DELETE FROM meta WHERE key = 'serverId'").run(); });
    const error = await A.roster.createCluster(made.root, made.clusterId).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("server.db has no serverId");
    expect(A.roster.clusterId).toBeNull();
    expect(A.roster.statements()).toEqual([]);
    expect(A.changes).toEqual([]);
    expect(h.raw(A).roster).toEqual([]);
    expect(h.raw(A).meta).toEqual([]);
    // readAudits reads nothing without a serverId
    expect(auditRows(A)).toEqual([]);
    // The queue is not stuck: a refusal still comes back.
    await refuses(A.roster.revokeDevice("x"), "no-cluster");
  });

  it("addDevice: refuses bad keys, a server's key and a revoked key; trims and defaults the name; keeps the scope; idempotent for the same keys", async () => {
    const h = harness();
    const { A } = await startCluster(h);
    h.tick();
    const phone = await member(10);
    h.names.member(phone, "phone");
    const said: Record<string, unknown> = {};
    said.badKeys = await refusesClean(h, A, () => A.roster.addDevice({ keys: { sign: "short", dh: phone.keys.dh }, name: "x" }), "bad-keys");
    said.extraKeyPart = await refusesClean(h, A, () => A.roster.addDevice({ keys: { ...phone.keys, extra: "x" } as { sign: string; dh: string }, name: "x" }), "bad-keys");
    said.itself = await refusesClean(h, A, () => A.roster.addDevice({ keys: A.identity.keys, name: "me" }), "not-a-device");

    const changesBefore = A.changes.length;
    const first = await A.roster.addDevice({ keys: phone.keys, name: "  Phone One  ", scope: ["manage", "read", "manage"] });
    expect(first.created).toBe(true);
    expect(first.member).toBe(phone.memberId);
    expect(A.roster.isValid(phone.memberId)).toBe(true);
    const info = A.roster.device(phone.memberId)!;
    expect(info.name).toBe("Phone One");
    expect(info.scope).toEqual(["manage", "read"]);
    expect(info.kind).toBe("device");
    expect(info.by).toBe(A.identity.memberId);
    expect(info.at).toBe(h.clock.now);
    expect(A.changes).toHaveLength(changesBefore + 1);
    expect(A.changes.at(-1)!.invalidated).toEqual([]);

    h.tick();
    const again = await A.roster.addDevice({ keys: phone.keys, name: "Other name" });
    expect(again).toEqual({ member: phone.memberId, addId: first.addId, created: false });
    expect(A.changes).toHaveLength(changesBefore + 1);

    // Same signing key, other DH key: a new Add (the id is the same member's), the newest counting Add speaks.
    const rekeyed = await A.roster.addDevice({ keys: { sign: phone.keys.sign, dh: toBase64Url(new Uint8Array(32).fill(7)) }, name: "" });
    expect(rekeyed.created).toBe(true);
    expect(rekeyed.addId).not.toBe(first.addId);
    expect(A.roster.device(phone.memberId)!.name).toBe("Device");
    expect(A.roster.device(phone.memberId)!.scope).toEqual(["read", "reply", "approve"]);

    const long = await member(11);
    h.names.member(long, "long");
    await A.roster.addDevice({ keys: long.keys, name: "n".repeat(300) });
    expect(A.roster.device(long.memberId)!.name).toHaveLength(100);

    const spare = await member(12);
    h.names.member(spare, "spare");
    await expect(A.roster.addDevice({ keys: spare.keys, name: "s", scope: ["nope" as never] })).rejects.toThrow();
    expect(A.roster.isValid(spare.memberId)).toBe(false);

    // A revoked device is refused when it asks again; pairing again makes a new key, hence a new id.
    h.tick();
    await A.roster.revokeDevice(phone.memberId);
    said.revoked = await refusesClean(h, A, () => A.roster.addDevice({ keys: phone.keys, name: "back" }), "revoked");
    h.golden("addDevice.refusals", said);
    h.golden("addDevice.dump", h.dump(A));
  });

  it("revokeDevice: root-only for servers, unknown ids refused, reason cut to 500, idempotent, the device stops being valid and the listener hears it", async () => {
    const h = harness();
    const { A } = await startCluster(h);
    const B = await joinServer(h, A, "B", 2);
    await sync(A, B);
    const phone = await member(10);
    h.names.member(phone, "phone");
    h.tick();
    await A.roster.addDevice({ keys: phone.keys, name: "Phone" });
    const said: Record<string, unknown> = {};
    said.aServer = await refusesClean(h, A, () => A.roster.revokeDevice(B.identity.memberId), "server-revoke-root-only");
    said.unknown = await refusesClean(h, A, () => A.roster.revokeDevice("nobody"), "not-a-device");
    const changesBefore = A.changes.length;
    h.tick();
    const revoked = await A.roster.revokeDevice(phone.memberId, "r".repeat(600));
    expect(revoked.already).toBe(false);
    expect(A.roster.isValid(phone.memberId)).toBe(false);
    expect(A.roster.device(phone.memberId)).toBeNull();
    expect(A.roster.view.revoked.has(phone.memberId)).toBe(true);
    expect(A.changes).toHaveLength(changesBefore + 1);
    expect(A.changes.at(-1)!.invalidated).toEqual([phone.memberId]);
    const body = statementOf(A, revoked.revokeId).body;
    expect(body).toMatchObject({ type: "revoke", member: phone.memberId, by: A.identity.memberId, gen: 1, cascade: false });
    expect((body as { reason: string }).reason).toHaveLength(500);
    expect("seen" in body).toBe(false);
    const audits = auditRows(A);
    expect(audits[0]).toMatchObject({ act: "device.revoke", statement: revoked.revokeId, member: phone.memberId, name: "Phone" });
    expect(audits[0].reason).toHaveLength(500);

    h.tick();
    const second = await A.roster.revokeDevice(phone.memberId, "different reason");
    expect(second).toEqual({ revokeId: revoked.revokeId, already: true });
    expect(A.changes).toHaveLength(changesBefore + 1);
    h.golden("revokeDevice.refusals", said);
    h.golden("revokeDevice.dump", h.dump(A));
  });

  it("addServer: refuses bad keys, itself and a removed server; idempotent for the same keys; a new DH key makes a new Add; blank name becomes Server", async () => {
    const h = harness();
    const { A } = await startCluster(h);
    const said: Record<string, unknown> = {};
    const other = await member(2);
    h.names.member(other, "B");
    said.badKeys = await refusesClean(h, A, () => A.roster.addServer({ keys: { sign: "x", dh: "y" }, name: "x" }), "bad-keys");
    said.itself = await refusesClean(h, A, () => A.roster.addServer({ keys: A.identity.keys, name: "me" }), "bad-keys");
    h.tick();
    const first = await A.roster.addServer({ keys: other.keys, name: "   " });
    expect(first.created).toBe(true);
    expect(A.roster.view.members.get(other.memberId)!.name).toBe("Server");
    expect(A.roster.view.servers.has(other.memberId)).toBe(true);
    const body = statementOf(A, first.addId).body;
    expect(body).toMatchObject({ type: "add", kind: "server", joined: true, by: A.identity.memberId });
    expect("scope" in body).toBe(false);
    const again = await A.roster.addServer({ keys: other.keys, name: "Renamed" });
    expect(again).toEqual({ member: other.memberId, addId: first.addId, created: false });
    h.tick();
    const rekeyed = await A.roster.addServer({ keys: { sign: other.keys.sign, dh: toBase64Url(new Uint8Array(32).fill(9)) }, name: "Renamed" });
    expect(rekeyed.created).toBe(true);
    expect(rekeyed.addId).not.toBe(first.addId);
    await A.roster.revokeServer(other.memberId, false);
    said.removed = await refusesClean(h, A, () => A.roster.addServer({ keys: other.keys, name: "again" }), "revoked");
    h.golden("addServer.refusals", said);
    h.golden("addServer.dump", h.dump(A));
  });

  it("joinCluster: refuses a welcome without an Add, an Add for another server, a wrong sponsor, bad sponsor keys and a set with no root; success stores, signs, endorses", async () => {
    const h = harness();
    const { A, root } = await startCluster(h);
    const phone = await member(10);
    h.names.member(phone, "phone");
    h.tick();
    await A.roster.addDevice({ keys: phone.keys, name: "Phone" });
    const B = await h.node("B", 2);
    const C = await h.node("C", 3);
    h.tick();
    const addB = await A.roster.addServer({ keys: B.identity.keys, name: "Server B" });
    const addC = await A.roster.addServer({ keys: C.identity.keys, name: "Server C" });
    const welcome = allStatements(A);
    const sponsor = { member: A.identity.memberId, keys: A.identity.keys, name: "Server A" };
    const said: Record<string, unknown> = {};
    said.noAdd = await refusesClean(h, B, () => B.roster.joinCluster({ add: root.statement, roster: welcome, sponsor }), "bad-join");
    said.garbageAdd = await refusesClean(h, B, () => B.roster.joinCluster({ add: { nonsense: true } as unknown as SignedStatement, roster: welcome, sponsor }), "bad-join");
    said.otherServersAdd = await refusesClean(h, B, () => B.roster.joinCluster({ add: statementOf(A, addC.addId), roster: welcome, sponsor }), "bad-join");
    said.wrongSponsor = await refusesClean(h, B, () => B.roster.joinCluster({ add: statementOf(A, addB.addId), roster: welcome, sponsor: { ...sponsor, member: phone.memberId } }), "bad-join");
    said.badSponsorKeys = await refusesClean(h, B, () => B.roster.joinCluster({ add: statementOf(A, addB.addId), roster: welcome, sponsor: { ...sponsor, keys: { sign: "x", dh: "y" } } }), "bad-keys");
    said.noRoot = await refusesClean(h, B, () => B.roster.joinCluster({ add: statementOf(A, addB.addId), roster: [], sponsor }), "bad-join");
    said.foreignClusterRoster = await refusesClean(h, B, () => B.roster.joinCluster({
      add: statementOf(A, addB.addId),
      roster: welcome.filter((statement) => statement.body.type === "root").map((statement) => ({ ...statement, body: { ...statement.body, cluster: "e".repeat(32) } }) as SignedStatement),
      sponsor,
    }), "bad-join");

    h.tick();
    const result = await B.roster.joinCluster({
      add: statementOf(A, addB.addId),
      roster: welcome,
      sponsor,
      extra: (cluster) => [{ type: "profile", cluster, member: B.identity.memberId, field: "addresses", value: "https://b.example:7443", hlc: { ms: h.clock.now, c: 0 } }],
    });
    expect(result.clusterId).toBe(A.roster.clusterId);
    expect(B.roster.clusterId).toBe(A.roster.clusterId);
    expect(result.add).toEqual(statementOf(B, result.addId));
    expect(statementOf(B, result.addId).body).toMatchObject({ type: "add", member: A.identity.memberId, kind: "server", by: B.identity.memberId, joined: false });
    expect(B.roster.isValid(B.identity.memberId)).toBe(true);
    expect(B.roster.isValid(A.identity.memberId)).toBe(true);
    expect(B.roster.isValid(phone.memberId)).toBe(true);
    expect(B.roster.profile(B.identity.memberId, "addresses")).toBe("https://b.example:7443");
    // B endorses the valid members only A vouched for (the phone, and C whom A added); not A (B's own Add vouches for it).
    const endorsements = h.lab(B.roster.statements().filter((item) => item.statement.body.type === "endorse").map((item) => item.id));
    expect(endorsements).toEqual(["endorse:C@B", "endorse:phone@B"]);
    expect(B.changes).toHaveLength(2);
    said.alreadyMember = await refusesClean(h, B, () => B.roster.joinCluster({ add: statementOf(A, addB.addId), roster: welcome, sponsor }), "cluster-exists");

    h.golden("join.refusals", said);
    h.golden("join.dump", h.dump(B));
    h.golden("join.result", { clusterId: result.clusterId, addId: result.addId });
  });

  it("joinCluster inside the transaction: a stale instance refuses with cluster-exists and rolls everything back", async () => {
    const h = harness();
    const { A } = await startCluster(h);
    const B = await h.node("B", 2);
    const stale = await RosterStore.open(B.store, B.identity, { now: () => h.clock.now });
    const added = await A.roster.addServer({ keys: B.identity.keys, name: "Server B" });
    const input = { add: statementOf(A, added.addId), roster: allStatements(A), sponsor: { member: A.identity.memberId, keys: A.identity.keys, name: "Server A" } };
    await B.roster.joinCluster(input);
    const before = JSON.stringify(h.raw(B));
    await refuses(stale.joinCluster(input), "cluster-exists");
    expect(stale.clusterId).toBeNull();
    expect(JSON.stringify(h.raw(B))).toBe(before);
  });

  it("revokeServer: only the revocation root, never itself, only a known server; K8 `seen`; non-cascade keeps what the root endorsed, cascade takes it", async () => {
    const results: Record<string, unknown> = {};
    for (const cascade of [false, true]) {
      const h = harness();
      const { A, B, C, phone } = await threeServers(h);
      const key = cascade ? "cascade" : "plain";
      // Everyone has the same set: A (root) endorsed what B brought in.
      expect(h.lab(A.roster.view.valid)).toEqual(["A", "B", "C", "phone"]);
      expect(h.lab(A.roster.statements().filter((item) => item.statement.body.type === "endorse").map((item) => item.id))).toEqual(["endorse:A@C", "endorse:C@A", "endorse:phone@A", "endorse:phone@C"]);
      expect(h.lab(A.roster.cascadePreview(B.identity.memberId))).toEqual(["C", "phone"]);
      expect(A.roster.cascadePreview(A.identity.memberId)).toEqual([]);
      expect(A.roster.cascadePreview(phone.memberId)).toEqual([]);
      expect(A.roster.cascadePreview("nobody")).toEqual([]);
      expect(B.roster.cascadePreview(C.identity.memberId)).toEqual([]); // B is not the root

      const said: Record<string, unknown> = {};
      said.notRoot = await refusesClean(h, B, () => B.roster.revokeServer(C.identity.memberId, false), "server-revoke-root-only");
      said.root = await refusesClean(h, A, () => A.roster.revokeServer(A.identity.memberId, false), "cannot-revoke-root");
      said.aDevice = await refusesClean(h, A, () => A.roster.revokeServer(phone.memberId, false), "not-a-server");
      said.unknown = await refusesClean(h, A, () => A.roster.revokeServer("nobody", true), "not-a-server");

      h.tick();
      const changes = A.changes.length;
      const first = await A.roster.revokeServer(B.identity.memberId, cascade, "gone ".repeat(200));
      expect(first.already).toBe(false);
      const body = statementOf(A, first.revokeId).body as Extract<StatementBody, { type: "revoke" }>;
      expect(body).toMatchObject({ member: B.identity.memberId, by: A.identity.memberId, gen: 1, cascade });
      expect(body.reason).toHaveLength(500);
      // K8: every joining Add signed by B that the root holds, sorted by id (device Adds count as joining).
      expect(h.lab(body.seen!)).toEqual(["add:C@B", "add:phone@B"]);
      expect(body.seen).toEqual([...body.seen!].sort());
      expect(A.roster.isValid(B.identity.memberId)).toBe(false);
      expect(A.roster.isValid(C.identity.memberId)).toBe(!cascade);
      expect(A.roster.isValid(phone.memberId)).toBe(!cascade);
      expect(A.changes).toHaveLength(changes + 1);
      expect(h.lab(A.changes.at(-1)!.invalidated)).toEqual(cascade ? ["B", "C", "phone"] : ["B"]);

      // Idempotent for the same cascade; a cascading revoke also answers a plain request; a plain one does not answer a cascading one.
      h.tick();
      const same = await A.roster.revokeServer(B.identity.memberId, cascade);
      expect(same).toEqual({ revokeId: first.revokeId, already: true });
      if (cascade) {
        expect(await A.roster.revokeServer(B.identity.memberId, false)).toEqual({ revokeId: first.revokeId, already: true });
      } else {
        const upgraded = await A.roster.revokeServer(B.identity.memberId, true);
        expect(upgraded.already).toBe(false);
        expect(upgraded.revokeId).not.toBe(first.revokeId);
        expect(A.roster.isValid(C.identity.memberId)).toBe(false);
        expect(A.roster.isValid(phone.memberId)).toBe(false);
      }
      results[key] = { said, dump: h.dump(A) };
      h.golden(`revokeServer.${key}`, results[key]);
    }
  });

  it("a removed server learns it from the revoke: its acts refuse with self-revoked, gossip is ignored, revocations still merge", async () => {
    const h = harness();
    const { A, B } = await threeServers(h);
    h.tick();
    const revoked = await A.roster.revokeServer(B.identity.memberId, false);
    const set = A.roster.revocations();
    expect(h.lab(idsOf(set))).toEqual(["revoke:B@A:g1", "root:g1"]);
    expect(await B.roster.mergeRevocations(set.map((item) => item.statement))).toEqual([revoked.revokeId]);
    expect(B.roster.isValid(B.identity.memberId)).toBe(false);
    expect(B.changes.at(-1)!.invalidated).toContain(B.identity.memberId);
    h.golden("revokedServer.changes", { changes: h.changesOf(B).slice(-1), valid: h.lab(B.roster.view.valid) });
    const phone2 = await member(20);
    const said: Record<string, unknown> = {};
    said.addDevice = await refusesClean(h, B, () => B.roster.addDevice({ keys: phone2.keys, name: "x" }), "self-revoked");
    said.addServer = await refusesClean(h, B, () => B.roster.addServer({ keys: phone2.keys, name: "x" }), "self-revoked");
    said.revokeDevice = await refusesClean(h, B, () => B.roster.revokeDevice("x"), "self-revoked");
    said.merge = await refusesClean(h, B, () => B.roster.merge([]), "self-revoked");
    said.writeProfile = await refusesClean(h, B, () => B.roster.writeProfile(B.identity.memberId, "name", "x"), "self-revoked");
    said.replaceRecovery = await refusesClean(h, B, () => B.roster.replaceRecovery(CODE1), "self-revoked");
    const before = h.trace(B);
    expect(await B.roster.mergeGossip(allStatements(A))).toEqual({ fresh: [], refused: [] });
    expect(h.trace(B)).toBe(before);
    h.golden("revokedServer", said);
  });

  it("reroot: refuses a wrong or malformed code, a root, keep that is not pending or over 1000; signs Root g+1 (and the old root's Revoke when it is lost)", async () => {
    const out: Record<string, unknown> = {};
    for (const lost of [true, false]) {
      const h = harness();
      const { A, B, C, root } = await threeServers(h);
      const said: Record<string, unknown> = {};
      said.badCode = await refusesClean(h, B, () => B.roster.reroot({ code: CODE2, oldRootLost: lost, keep: [] }), "bad-code");
      said.malformed = await refusesClean(h, B, () => B.roster.reroot({ code: "ABC", oldRootLost: lost, keep: [] }), "bad-code");
      said.alreadyRoot = await refusesClean(h, A, () => A.roster.reroot({ code: CODE1, oldRootLost: lost, keep: [] }), "already-root");
      said.keepNotPending = await refusesClean(h, B, () => B.roster.reroot({ code: CODE1, oldRootLost: lost, keep: [root.id] }), "bad-keep");
      said.keepTooMany = await refusesClean(h, B, () => B.roster.reroot({ code: CODE1, oldRootLost: lost, keep: Array.from({ length: 1001 }, (_, index) => `k${index}`) }), "bad-keep");

      h.tick();
      const changes = B.changes.length;
      const done = await B.roster.reroot({ code: formatRecoveryCode(CODE1).toLowerCase(), oldRootLost: lost, keep: [] });
      expect(done.gen).toBe(2);
      expect(B.roster.view.root?.id).toBe(done.rootId);
      expect(B.roster.view.root?.root).toBe(B.identity.memberId);
      expect(B.roster.view.root?.gen).toBe(2);
      const rootBody = statementOf(B, done.rootId).body;
      expect(rootBody).toMatchObject({ type: "root", gen: 2, root: B.identity.memberId, keep: [], prev: root.id });
      expect(statementOf(B, done.rootId).signer).toBe("recovery");
      expect((rootBody as { recoveryPub: string }).recoveryPub).toBe(A.roster.view.root!.recoveryPub);
      expect(B.roster.isValid(A.identity.memberId)).toBe(!lost);
      expect(done.revokeId === null).toBe(!lost);
      expect(B.changes).toHaveLength(changes + 1);
      if (lost) {
        const revoke = statementOf(B, done.revokeId!).body;
        expect(revoke).toMatchObject({ type: "revoke", member: A.identity.memberId, by: B.identity.memberId, gen: 2, cascade: false });
        expect(h.lab((revoke as { seen: string[] }).seen)).toEqual(["add:B@A"]);
        expect(h.lab(B.changes.at(-1)!.invalidated)).toEqual(["A"]);
      } else {
        expect(B.changes.at(-1)!.invalidated).toEqual([]);
      }
      const audits = auditRows(B).slice(0, lost ? 2 : 1).map((audit) => audit.act);
      expect(audits).toEqual(lost ? ["server.revoke", "root.change"] : ["root.change"]);
      // C (not told yet) takes it from B's revocations; the removed old root, when it hears, is out.
      expect(h.lab(await C.roster.mergeRevocations(B.roster.revocations().map((item) => item.statement)))).toEqual(lost ? ["revoke:A@B:g2", "root:g2"] : ["root:g2"]);
      expect(C.roster.view.root?.gen).toBe(2);
      out[lost ? "lost" : "kept"] = { said, dump: h.dump(B) };
      h.golden(`reroot.${lost ? "lost" : "kept"}`, out[lost ? "lost" : "kept"]);
    }
  });

  it("reroot with `keep`, dropped revocations and dismiss: a kept revoke still counts, a left-out one is dropped; dismissing is local and survives a reopen", async () => {
    const out: Record<string, unknown> = {};
    for (const keepIt of [true, false]) {
      const h = harness();
      const { A, B, C } = await threeServers(h);
      h.tick();
      const revC = await A.roster.revokeServer(C.identity.memberId, false);
      await B.roster.mergeRevocations(A.roster.revocations().map((item) => item.statement));
      expect(B.roster.isValid(C.identity.memberId)).toBe(false);
      const candidates = B.roster.keepCandidates();
      expect(candidates).toEqual([{ revokeId: revC.revokeId, member: C.identity.memberId, signer: A.identity.memberId, gen: 1, receivedAt: h.clock.now }]);
      expect(A.roster.keepCandidates()).toHaveLength(1); // the root itself lists it too (it signed it)

      h.tick();
      const done = await B.roster.reroot({ code: CODE1, oldRootLost: false, keep: keepIt ? [revC.revokeId] : [] });
      const rootBody = statementOf(B, done.rootId).body as Extract<StatementBody, { type: "root" }>;
      expect(rootBody.keep).toEqual(keepIt ? [revC.revokeId] : []);
      expect(B.roster.isValid(C.identity.memberId)).toBe(!keepIt);
      expect(B.roster.dropped().map((row) => row.revokeId)).toEqual(keepIt ? [] : [revC.revokeId]);
      const said: Record<string, unknown> = {};
      if (!keepIt) {
        expect(B.roster.dropped()[0]).toMatchObject({ member: C.identity.memberId, signer: A.identity.memberId, gen: 1, why: "left-out" });
        said.notDropped = await refusesClean(h, B, () => B.roster.dismissDropped("nope"), "not-dropped");
        const audits = auditRows(B);
        expect(audits.filter((audit) => audit.act === "server.revoke.dropped")).toEqual([
          { act: "server.revoke.dropped", at: h.clock.now, statement: revC.revokeId, by: A.identity.memberId, member: C.identity.memberId, name: "Server C", reason: "gen 1: left-out" },
        ]);
        h.tick();
        const dismissedAt = h.clock.now;
        expect(await B.roster.dismissDropped(revC.revokeId)).toEqual({ already: false });
        expect(await B.roster.dismissDropped(revC.revokeId)).toEqual({ already: true });
        expect(B.roster.dropped()).toEqual([]);
        expect(B.roster.view.dropped).toHaveLength(1); // validity does not change
        expect(B.roster.isValid(C.identity.memberId)).toBe(true);
        expect(h.raw(B).meta.filter((row) => row.key.startsWith("dropped.dismissed:"))).toEqual([{ key: `dropped.dismissed:${revC.revokeId}`, value: String(dismissedAt) }]);

        // Reopen: the dismissal is read back and no second audit row is written for the same drop.
        const reopened = await h.reopen(B);
        expect(reopened.dropped()).toEqual([]);
        expect(reopened.view.dropped).toHaveLength(1);
        expect(h.raw(B).audit.filter((row) => row.key.startsWith("audit:dropped:"))).toHaveLength(1);
        // Delete the audit row: the next open writes it again (at the time of that open).
        await B.store.submit((tx) => { tx.prepare("DELETE FROM rows WHERE key LIKE 'audit:dropped:%'").run(); });
        h.tick();
        await h.reopen(B);
        const back = h.raw(B).audit.filter((row) => row.key.startsWith("audit:dropped:"));
        expect(back).toHaveLength(1);
        expect(back[0].body).toMatchObject({ act: "server.revoke.dropped", statement: revC.revokeId, at: h.clock.now });
      }
      out[keepIt ? "kept" : "dropped"] = { said, dump: h.dump(B) };
      h.golden(`reroot.keep.${keepIt ? "kept" : "dropped"}`, out[keepIt ? "kept" : "dropped"]);
    }
  });

  it("recovery-code replacement: refuses the wrong place and code; confirm checks the typed code and the time; Root g+1 under the new key; one use", async () => {
    const h = harness();
    const { A, B, clusterId } = await (async () => {
      const made = await startCluster(h);
      h.tick();
      const B = await joinServer(h, made.A, "B", 2);
      await sync(made.A, B);
      return { A: made.A, B, clusterId: made.clusterId };
    })();
    const said: Record<string, unknown> = {};
    said.notRoot = await refusesClean(h, B, () => B.roster.replaceRecovery(CODE1), "not-root");
    said.malformed = await refusesClean(h, A, () => A.roster.replaceRecovery("short"), "bad-code");
    said.wrongCode = await refusesClean(h, A, () => A.roster.replaceRecovery(CODE2), "bad-code");
    expect(await A.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "no-setup" });
    expect(await B.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "not-root" });

    vi.mocked(newRecoveryCode).mockReturnValueOnce(CODE2);
    h.tick();
    const started = await A.roster.replaceRecovery(formatRecoveryCode(CODE1));
    expect(started).toEqual({ code: formatRecoveryCode(CODE2), clusterId, expiresAt: h.clock.now + RECOVERY_REPLACE_TTL_MS });
    expect(RECOVERY_REPLACE_TTL_MS).toBe(600_000);
    const afterStart = h.trace(A);
    expect(await A.roster.confirmRecovery("short")).toEqual({ ok: false, reason: "malformed" });
    expect(await A.roster.confirmRecovery(CODE3)).toEqual({ ok: false, reason: "wrong-code" });
    expect(h.trace(A)).toBe(afterStart);

    // Too late: the setup is dropped, a second confirm finds none.
    h.tick(RECOVERY_REPLACE_TTL_MS);
    expect(await A.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "expired" });
    expect(await A.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "no-setup" });

    // Start again, cancel, confirm finds none; start again and confirm.
    vi.mocked(newRecoveryCode).mockReturnValueOnce(CODE2);
    await A.roster.replaceRecovery(CODE1);
    A.roster.cancelRecoveryReplace();
    expect(await A.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "no-setup" });
    vi.mocked(newRecoveryCode).mockReturnValueOnce(CODE2);
    await A.roster.replaceRecovery(CODE1);
    h.tick();
    const changes = A.changes.length;
    const done = await A.roster.confirmRecovery(`${CODE2.slice(0, 4).toLowerCase()}-${CODE2.slice(4)}`);
    expect(done).toEqual({ ok: true, clusterId, rootId: A.roster.view.root!.id, gen: 2 });
    const newKey = await recoveryKeyFromCode(CODE2);
    h.names.set(newKey.recoveryPub, "R2.pub");
    const rootBody = statementOf(A, (done as { rootId: string }).rootId).body;
    expect(rootBody).toMatchObject({ type: "root", gen: 2, root: A.identity.memberId, recoveryPub: newKey.recoveryPub, keep: [] });
    expect(A.changes).toHaveLength(changes + 1);
    expect(A.changes.at(-1)!.rootGen).toBe(2);
    expect(auditRows(A)[0]).toMatchObject({ act: "root.change", by: "recovery", member: A.identity.memberId });
    expect(await A.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "no-setup" });
    // The old code no longer opens anything; the new one does.
    await refuses(A.roster.replaceRecovery(CODE1), "bad-code");
    vi.mocked(newRecoveryCode).mockReturnValueOnce(CODE3);
    const next = await A.roster.replaceRecovery(CODE2);
    expect(next.code).toBe(formatRecoveryCode(CODE3));
    h.golden("recovery.refusals", said);
    h.golden("recovery.dump", h.dump(A));
  });

  it("recovery-code replacement carries every counting server revocation in `keep`; a new code equal to the old is drawn again", async () => {
    const h = harness();
    const { A, B, C } = await threeServers(h);
    h.tick();
    const revC = await A.roster.revokeServer(C.identity.memberId, false);
    // The first draw is the current code (CODE1): it is thrown away and the next one is used.
    vi.mocked(newRecoveryCode).mockReturnValueOnce(CODE1).mockReturnValueOnce(CODE2);
    const started = await A.roster.replaceRecovery(CODE1);
    expect(started.code).toBe(formatRecoveryCode(CODE2));
    h.tick();
    const done = await A.roster.confirmRecovery(CODE2);
    expect(done.ok).toBe(true);
    const rootBody = statementOf(A, (done as { rootId: string }).rootId).body as Extract<StatementBody, { type: "root" }>;
    expect(rootBody.keep).toEqual([revC.revokeId]);
    expect(A.roster.isValid(C.identity.memberId)).toBe(false);
    expect(A.roster.dropped()).toEqual([]);
    expect(h.lab(A.roster.view.root!.keep)).toEqual(["revoke:C@A:g1"]);
    expect(B.roster.view.root?.gen).toBe(1);
  });

  it("a pending replacement is dropped when the root changes under it", async () => {
    const h = harness();
    const { A, B } = await threeServers(h);
    vi.mocked(newRecoveryCode).mockReturnValueOnce(CODE2);
    await A.roster.replaceRecovery(CODE1);
    // B reroots onto itself; A hears it: A is no longer the root, its pending replacement is gone.
    h.tick();
    await B.roster.reroot({ code: CODE1, oldRootLost: false, keep: [] });
    await A.roster.mergeRevocations(B.roster.revocations().map((item) => item.statement));
    expect(A.roster.view.root?.root).toBe(B.identity.memberId);
    expect(await A.roster.confirmRecovery(CODE2)).toEqual({ ok: false, reason: "not-root" });
    await refuses(A.roster.replaceRecovery(CODE1), "not-root");
  });

  it("merge: keeps well-formed statements of this cluster once, in input order; a copy that does not verify gives way to one that does, never the other way", async () => {
    const h = harness();
    const { A, root } = await startCluster(h);
    const phone = await member(10);
    const spare = await member(11);
    h.names.member(phone, "phone");
    h.names.member(spare, "spare");
    h.tick();
    // Statements made elsewhere (here: signed with A's own key, as a peer that holds A's Adds would send them).
    const make = async (who: Member, keys: Member, name: string) => signStatement(
      { type: "add", cluster: A.roster.clusterId!, member: keys.memberId, kind: "device", keys: keys.keys, name, scope: ["read"], by: who.memberId, at: h.clock.now },
      who.memberId,
      (bytes) => who.sign(bytes),
    );
    const addPhone = await make(A.identity, phone, "Phone");
    const addSpare = await make(A.identity, spare, "Spare");
    const foreign = await signStatement(
      { type: "add", cluster: "d".repeat(32), member: phone.memberId, kind: "device", keys: phone.keys, name: "Foreign", scope: ["read"], by: A.identity.memberId, at: 1 },
      A.identity.memberId,
      (bytes) => A.identity.sign(bytes),
    );
    h.names.set(foreign.id, "foreign-add");
    const badSig: SignedStatement = { ...addSpare.statement, sig: addPhone.statement.sig };
    const said: Record<string, unknown> = {};
    // Garbage, a foreign cluster and a duplicate are skipped; a bad-signature copy is STORED (merge does not verify) but does not count.
    const fresh = await A.roster.merge([addPhone.statement, { nonsense: 1 } as unknown as SignedStatement, foreign.statement, addPhone.statement, badSig]);
    said.fresh = fresh;
    expect(fresh).toEqual([addPhone.id, addSpare.id]);
    expect(A.roster.isValid(phone.memberId)).toBe(true);
    expect(A.roster.isValid(spare.memberId)).toBe(false);
    expect(A.roster.statements().map((item) => item.id)).toContain(addSpare.id);
    expect(h.raw(A).roster.find((row) => row.id === addSpare.id)!.statement!.sig).toBe(addPhone.statement.sig);
    expect(A.roster.statementsById([addSpare.id, addSpare.id, "unknown", root.id]).map((item) => item.id)).toEqual([addSpare.id, root.id]);
    expect(A.changes.at(-1)!.invalidated).toEqual([]);
    // The same bad copy again, and the same good copy that is already stored: nothing new.
    expect(await A.roster.merge([badSig, addPhone.statement])).toEqual([]);
    // The good copy replaces the bad one (same id, other bytes): reported as changed, the row is rewritten, the device is valid.
    h.tick();
    expect(await A.roster.merge([addSpare.statement])).toEqual([addSpare.id]);
    expect(A.roster.isValid(spare.memberId)).toBe(true);
    expect(h.raw(A).roster.find((row) => row.id === addSpare.id)!.statement!.sig).toBe(addSpare.statement.sig);
    expect(h.raw(A).roster.find((row) => row.id === addSpare.id)!.receivedAt).toBe(h.clock.now);
    // Never the other way: a bad copy does not replace a verified one.
    expect(await A.roster.merge([badSig])).toEqual([]);
    expect(h.raw(A).roster.find((row) => row.id === addSpare.id)!.statement!.sig).toBe(addSpare.statement.sig);
    h.golden("merge.single", { said, dump: h.dump(A) });
  });

  it("merge, merge of revocations and gossip converge in both orders: the same statements, the same digest, the same ids reported", async () => {
    const run = async (order: "AB" | "BA") => {
      const h = harness();
      const { A, root } = await startCluster(h);
      h.tick();
      const B = await joinServer(h, A, "B", 2);
      await sync(A, B);
      h.tick();
      const p1 = await member(10);
      const p2 = await member(11);
      h.names.member(p1, "p1");
      h.names.member(p2, "p2");
      await A.roster.addDevice({ keys: p1.keys, name: "P1" });
      await B.roster.addDevice({ keys: p2.keys, name: "P2" });
      h.tick();
      const fromA = A.roster.gossipStatements().map((item) => item.statement);
      const fromB = B.roster.gossipStatements().map((item) => item.statement);
      const reported: Record<string, unknown> = {};
      const aToB = async () => { reported.toB = await B.roster.mergeGossip(fromA); };
      const bToA = async () => { reported.toA = await A.roster.mergeGossip(fromB); };
      if (order === "AB") { await aToB(); await bToA(); } else { await bToA(); await aToB(); }
      // A second round carries the endorsements the first one made.
      await B.roster.mergeGossip(A.roster.gossipStatements().map((item) => item.statement));
      await A.roster.mergeGossip(B.roster.gossipStatements().map((item) => item.statement));
      await B.roster.mergeGossip(A.roster.gossipStatements().map((item) => item.statement));
      expect(await A.roster.digest()).toBe(await B.roster.digest());
      const labels = h.lab(idsOf(A.roster.statements()));
      expect(h.lab(idsOf(B.roster.statements()))).toEqual(labels);
      expect(h.lab(A.roster.view.valid)).toEqual(["A", "B", "p1", "p2"]);
      expect(root.id).toBe(A.roster.view.root!.id);
      return { labels, reported: h.show(reported), digest: await A.roster.digest(), changes: { A: A.changes.length, B: B.changes.length } };
    };
    const ab = await run("AB");
    const ba = await run("BA");
    expect(ba.labels).toEqual(ab.labels);
    expect(ba.digest).toBe(ab.digest); // the ids are content-addressed and the keys are fixed
    pin("converge.AB", ab);
    pin("converge.BA", ba);
  });

  it("mergeRevocations: only Revoke and Root, only what counts, only Roots of this chain; a new root's Revoke counts next to its Root", async () => {
    const h = harness();
    const { A, B, C, root, clusterId } = await threeServers(h);
    h.tick();
    const revC = await A.roster.revokeServer(C.identity.memberId, false);
    const key3 = await recoveryKeyFromCode(CODE3);
    h.names.set(key3.recoveryPub, "R3.pub");
    const foreignRoot = await signStatement(
      { type: "root", cluster: clusterId, gen: 2, root: B.identity.memberId, recoveryPub: key3.recoveryPub, keep: [], prev: root.id },
      "recovery",
      signWith(key3.privateKey),
    );
    h.names.set(foreignRoot.id, "foreign-root");
    // A Revoke of the root by a server that is not the root does not count.
    const notCounting = await signStatement(
      { type: "revoke", cluster: clusterId, member: A.identity.memberId, reason: "", by: B.identity.memberId, gen: 1, cascade: false },
      B.identity.memberId,
      (bytes) => B.identity.sign(bytes),
    );
    h.names.set(notCounting.id, "revoke-of-root-by-B");
    const anAdd = A.roster.statements().find((item) => item.statement.body.type === "add")!.statement;
    const offered: unknown[] = [...A.roster.revocations().map((item) => item.statement), anAdd, { nonsense: true }, foreignRoot.statement, notCounting.statement, revC.revokeId];
    const before = h.trace(A);
    expect(await A.roster.mergeRevocations([foreignRoot.statement, notCounting.statement, anAdd, "x", null])).toEqual([]);
    expect(h.trace(A)).toBe(before);
    expect(await B.roster.mergeRevocations(offered)).toEqual([revC.revokeId]); // B was synced before A revoked C
    expect(h.lab(idsOf(B.roster.statements())).filter((label) => label.startsWith("revoke:") || label === "foreign-root")).toEqual(["revoke:C@A:g1"]);
    expect(B.roster.isValid(C.identity.memberId)).toBe(false);
    expect(await B.roster.mergeRevocations(offered)).toEqual([]); // again: nothing new
    h.golden("mergeRevocations.single", { dump: h.dump(B, ["stored", "changes"]) });

    const sequences: Record<string, unknown> = {};
    for (const mode of ["revoke-first", "root-first", "revoke-alone", "root-then-revoke"] as const) {
      const g = harness();
      const s = await threeServers(g);
      g.tick();
      const done = await s.B.roster.reroot({ code: CODE1, oldRootLost: true, keep: [] });
      const revoke = statementOf(s.B, done.revokeId!);
      const newRoot = statementOf(s.B, done.rootId);
      const fresh: string[][] = [];
      const offer = async (list: SignedStatement[]) => { fresh.push(g.lab(await s.C.roster.mergeRevocations(list))); };
      if (mode === "revoke-first") await offer([revoke, newRoot]);
      if (mode === "root-first") await offer([newRoot, revoke]);
      if (mode === "revoke-alone") await offer([revoke]);
      if (mode === "root-then-revoke") { await offer([newRoot]); await offer([revoke]); }
      sequences[mode] = { fresh, rootGen: s.C.roster.view.root?.gen, aValid: s.C.roster.isValid(s.A.identity.memberId), statements: g.lab(idsOf(s.C.roster.statements())) };
    }
    const shown = h.show(sequences) as Record<string, { fresh: string[][]; rootGen: number; aValid: boolean }>;
    // Either order inside one call gives the same answer; a revoke of a root the set does not hold yet is not stored.
    expect(shown["root-first"]).toEqual(shown["revoke-first"]);
    expect(shown["revoke-alone"].fresh).toEqual([[]]);
    expect(shown["revoke-alone"].rootGen).toBe(1);
    expect(shown["revoke-alone"].aValid).toBe(true);
    expect(shown["root-then-revoke"].fresh).toEqual([["root:g2"], ["revoke:A@B:g2"]]);
    expect(shown["root-then-revoke"].aValid).toBe(false);
    pin("mergeRevocations.sequences", shown);
  });

  it("mergeGossip: stores only what verifies and what a party this set knows signed; refused ids come back; ignores other clusters; honours the limit", async () => {
    const h = harness();
    const { A, clusterId, root } = await startCluster(h);
    h.tick();
    const B = await joinServer(h, A, "B", 2);
    await sync(A, B);
    h.tick();
    const [phone, phone2, outsider, phone3, phone4, phone5] = await Promise.all([10, 11, 30, 12, 13, 14].map((seed) => member(seed)));
    h.names.member(phone, "phone");
    h.names.member(phone2, "phone2");
    h.names.member(outsider, "Z");
    h.names.member(phone3, "phone3");
    h.names.member(phone4, "phone4");
    h.names.member(phone5, "phone5");
    const addPhone = await A.roster.addDevice({ keys: phone.keys, name: "Phone" });
    const addPhone2 = await A.roster.addDevice({ keys: phone2.keys, name: "Phone2" });
    const good = statementOf(A, addPhone.addId);
    const goodTwo = statementOf(A, addPhone2.addId);
    const badSig: SignedStatement = { ...goodTwo, sig: good.sig };
    const key3 = await recoveryKeyFromCode(CODE3);
    h.names.set(key3.recoveryPub, "R3.pub");
    const foreignRoot = await signStatement({ type: "root", cluster: clusterId, gen: 2, root: B.identity.memberId, recoveryPub: key3.recoveryPub, keep: [], prev: root.id }, "recovery", signWith(key3.privateKey));
    h.names.set(foreignRoot.id, "foreign-root");
    const addByDevice = await signStatement({ type: "add", cluster: clusterId, member: outsider.memberId, kind: "device", keys: outsider.keys, name: "Z", scope: ["read"], by: phone.memberId, at: 5 }, phone.memberId, (bytes) => phone.sign(bytes));
    const profileAboutA = await signStatement({ type: "profile", cluster: clusterId, member: A.identity.memberId, field: "name", value: "hijack", hlc: { ms: 1, c: 0 } }, phone.memberId, (bytes) => phone.sign(bytes));
    const profileSelf = await signStatement({ type: "profile", cluster: clusterId, member: phone.memberId, field: "name", value: "mine", hlc: { ms: 1, c: 0 } }, phone.memberId, (bytes) => phone.sign(bytes));
    const otherCluster = await signStatement({ type: "add", cluster: "c".repeat(32), member: phone.memberId, kind: "device", keys: phone.keys, name: "x", scope: ["read"], by: A.identity.memberId, at: 1 }, A.identity.memberId, (bytes) => A.identity.sign(bytes));
    for (const [item, label] of [[addByDevice, "add-by-device"], [profileAboutA, "profile-about-A-by-phone"], [profileSelf, "profile-self-by-phone"], [otherCluster, "other-cluster-add"]] as const) h.names.set(item.id, label);

    expect(MAX_GOSSIP_SET).toBe(20_000);
    h.tick();
    const result = await B.roster.mergeGossip([otherCluster.statement, { nonsense: 1 }, good, badSig, foreignRoot.statement, addByDevice.statement, profileAboutA.statement, profileSelf.statement, good]);
    // Input order; the Add of phone and the phone's own Profile are kept; the rest is refused (bad signature, foreign Root,
    // an Add by a device, a Profile about another member by a device); other clusters and garbage are ignored.
    expect(h.show(result)).toEqual({
      fresh: ["add:phone@A", "profile-self-by-phone"],
      refused: ["add:phone2@A", "foreign-root", "add-by-device", "profile-about-A-by-phone"],
    });
    expect(B.roster.isValid(phone.memberId)).toBe(true);
    expect(B.roster.profile(phone.memberId, "name")).toBe("mine");
    expect(B.roster.profile(A.identity.memberId, "name")).toBeNull();
    expect(h.lab(idsOf(B.roster.statements())).filter((label) => label.startsWith("endorse:"))).toEqual(["endorse:phone@B"]);
    expect(B.roster.isValid(phone2.memberId)).toBe(false);
    // The refused bad copy was not stored; the good copy of the same id is taken next time.
    expect(h.show(await B.roster.mergeGossip([goodTwo]))).toEqual({ fresh: ["add:phone2@A"], refused: [] });

    // The limit counts input statements: only the first is looked at, the rest is neither kept nor refused.
    const adds = await Promise.all([phone3, phone4, phone5].map((who, index) => A.roster.addDevice({ keys: who.keys, name: `P${index + 3}` })));
    const three = adds.map((added) => statementOf(A, added.addId));
    expect(h.show(await B.roster.mergeGossip(three, 1))).toEqual({ fresh: ["add:phone3@A"], refused: [] });
    expect(h.show(await B.roster.mergeGossip(three, 0))).toEqual({ fresh: [], refused: [] });
    expect(h.show(await B.roster.mergeGossip(three))).toEqual({ fresh: ["add:phone4@A", "add:phone5@A"], refused: [] });
    // And back: A takes B's Endorses.
    const back = await A.roster.mergeGossip(B.roster.gossipStatements().map((item) => item.statement));
    expect(h.lab(back.fresh)).toEqual(["endorse:phone2@B", "endorse:phone3@B", "endorse:phone4@B", "endorse:phone5@B", "endorse:phone@B", "profile-self-by-phone"].sort());
    expect(back.refused).toEqual([]);
    h.golden("mergeGossip.dump", { B: h.dump(B, ["stored", "changes"]), A: h.dump(A, ["changes"]) });
  });

  it("gossipKeeps: which statements gossip stores, as a table", () => {
    const view = { self: "me", servers: new Set(["srv"]), members: new Map([["dev", {}]]) } as unknown as RosterView;
    const item = (body: Record<string, unknown>, signer: string) => ({ id: "x", body, signer }) as unknown as VerifiedStatement;
    const table: Array<[string, VerifiedStatement, boolean]> = [
      ["a Root", item({ type: "root" }, "recovery"), true],
      ["an Add by a known server, signed by it", item({ type: "add", by: "srv" }, "srv"), true],
      ["an Add by a known server, signed by someone else", item({ type: "add", by: "srv" }, "other"), false],
      ["an Add by a device", item({ type: "add", by: "dev" }, "dev"), false],
      ["an Endorse by a known server", item({ type: "endorse", by: "srv" }, "srv"), true],
      ["an Endorse by an unknown party", item({ type: "endorse", by: "nobody" }, "nobody"), false],
      ["a Revoke by a known server", item({ type: "revoke", by: "srv" }, "srv"), true],
      ["a Revoke by an unknown party", item({ type: "revoke", by: "nobody" }, "nobody"), false],
      ["a Profile signed by a known server (about anyone)", item({ type: "profile", member: "anyone" }, "srv"), true],
      ["a Profile of a member signed by that member", item({ type: "profile", member: "dev" }, "dev"), true],
      ["a Profile of this server signed by it", item({ type: "profile", member: "me" }, "me"), true],
      ["a Profile about another member signed by a device", item({ type: "profile", member: "me" }, "dev"), false],
      ["a Profile of an unknown member signed by itself", item({ type: "profile", member: "ghost" }, "ghost"), false],
      ["a statement of a kind it does not know", item({ type: "mystery" }, "srv"), false],
    ];
    expect(table.map(([label, statement]) => [label, gossipKeeps(statement, view)])).toEqual(table.map(([label, , keeps]) => [label, keeps]));
  });

  it("gossipStatements is cached per view and leaves out what gossip would not take; digest() counts everything stored; statementsById and revocations", async () => {
    const h = harness();
    const { A, B, root, clusterId } = await (async () => {
      const made = await startCluster(h);
      h.tick();
      const B = await joinServer(h, made.A, "B", 2);
      await sync(made.A, B);
      return { ...made, B };
    })();
    const first = A.roster.gossipStatements();
    expect(A.roster.gossipStatements()).toBe(first);
    expect(h.lab(idsOf(first))).toEqual(["add:A@B", "add:B@A", "root:g1"]);
    expect(first.map((item) => item.id)).toEqual([...first.map((item) => item.id)].sort());
    const phone = await member(10);
    h.names.member(phone, "phone");
    h.tick();
    await A.roster.addDevice({ keys: phone.keys, name: "Phone" });
    expect(A.roster.gossipStatements()).not.toBe(first);

    // A Root of this cluster signed by a key that is not the chain's: merge() stores it, gossip does not carry it.
    const key3 = await recoveryKeyFromCode(CODE3);
    h.names.set(key3.recoveryPub, "R3.pub");
    const foreign = await signStatement({ type: "root", cluster: clusterId, gen: 2, root: B.identity.memberId, recoveryPub: key3.recoveryPub, keep: [], prev: root.id }, "recovery", signWith(key3.privateKey));
    h.names.set(foreign.id, "foreign-root");
    const carried = A.roster.gossipStatements().map((item) => item.id);
    expect(await A.roster.merge([foreign.statement])).toEqual([foreign.id]);
    expect(A.roster.view.root?.id).toBe(root.id);
    expect(A.roster.statements().map((item) => item.id)).toContain(foreign.id);
    expect(A.roster.gossipStatements().map((item) => item.id)).not.toContain(foreign.id);
    expect(A.roster.gossipStatements().map((item) => item.id)).toEqual(carried);
    // digest() is over every stored id; the gossip digest (gossip.ts) is over gossipStatements().
    expect(await A.roster.digest()).toBe(await rosterDigest(A.roster.statements().map((item) => item.id)));
    expect(await A.roster.digest()).not.toBe(await rosterDigest(carried));
    expect(A.roster.statementsById([foreign.id, foreign.id, "unknown", root.id]).map((item) => item.id)).toEqual([foreign.id, root.id]);
    expect(h.lab(idsOf(A.roster.revocations()))).toEqual(["foreign-root", "root:g1"]); // every Root and Revoke it holds, the foreign Root included
    h.golden("gossipStatements.dump", { carried: h.lab(carried), stored: h.lab(idsOf(A.roster.statements())) });
  });

  it("profiles: the hlc is above every earlier Profile of the field; an unchanged value writes nothing; the newest valid writer wins; push is for valid devices", async () => {
    const h = harness();
    const { A } = await startCluster(h);
    h.tick();
    const B = await joinServer(h, A, "B", 2);
    await sync(A, B);
    const phone = await member(10);
    h.names.member(phone, "phone");
    h.tick();
    await A.roster.addDevice({ keys: phone.keys, name: "Phone" });
    await sync(A, B);
    h.tick();
    const hlcOf = (statement: SignedStatement | null) => (statement?.body as { hlc?: unknown } | undefined)?.hlc;
    const start = h.clock.now;
    const first = await A.roster.writeProfile(A.identity.memberId, "addresses", "https://a.example:1");
    expect(hlcOf(first)).toEqual({ ms: start, c: 0 });
    expect(A.roster.profile(A.identity.memberId, "addresses")).toBe("https://a.example:1");
    expect(await A.roster.writeProfile(A.identity.memberId, "addresses", "https://a.example:1")).toBeNull();
    expect(hlcOf(await A.roster.writeProfile(A.identity.memberId, "addresses", "https://a.example:2"))).toEqual({ ms: start, c: 1 });
    h.clock.now = start - 5_000; // the clock went back: the hlc follows the newest Profile of the field
    expect(hlcOf(await A.roster.writeProfile(A.identity.memberId, "addresses", "https://a.example:3"))).toEqual({ ms: start, c: 2 });
    h.clock.now = start + 10_000;
    expect(hlcOf(await A.roster.writeProfile(A.identity.memberId, "addresses", "https://a.example:4"))).toEqual({ ms: start + 10_000, c: 0 });
    expect(hlcOf(await A.roster.writeProfile(A.identity.memberId, "name", "Server A"))).toEqual({ ms: start + 10_000, c: 0 }); // another field starts at 0
    expect(A.roster.profile(A.identity.memberId, "addresses")).toBe("https://a.example:4");
    // The value is cut to 2,000 characters when signed. (Current behaviour: the unchanged-value check happens before the cut,
    // so a longer value is written again every time.)
    const long = "x".repeat(2_500);
    const cut = await A.roster.writeProfile(A.identity.memberId, "icon", long);
    expect((cut!.body as { value: string }).value).toHaveLength(2_000);
    expect(await A.roster.writeProfile(A.identity.memberId, "icon", long)).not.toBeNull();

    // Two servers write the same field of the same member at the same hlc: the smaller statement id wins everywhere.
    h.tick();
    const fromA = await A.roster.writeProfile(A.identity.memberId, "name", "named by A");
    const fromB = await B.roster.writeProfile(A.identity.memberId, "name", "named by B");
    expect(hlcOf(fromA)).toEqual(hlcOf(fromB));
    await sync(A, B);
    const idA = (await signStatement(fromA!.body, A.identity.memberId, (bytes) => A.identity.sign(bytes))).id;
    const idB = (await signStatement(fromB!.body, B.identity.memberId, (bytes) => B.identity.sign(bytes))).id;
    const winner = idA < idB ? "named by A" : "named by B";
    expect(A.roster.profile(A.identity.memberId, "name")).toBe(winner);
    expect(B.roster.profile(A.identity.memberId, "name")).toBe(winner);

    // A device's own Profile counts (merged in); its Profile about another member does not.
    const own = await signStatement({ type: "profile", cluster: A.roster.clusterId!, member: phone.memberId, field: "name", value: "My phone", hlc: { ms: 1, c: 0 } }, phone.memberId, (bytes) => phone.sign(bytes));
    const aboutA = await signStatement({ type: "profile", cluster: A.roster.clusterId!, member: A.identity.memberId, field: "icon", value: "hijack", hlc: { ms: 9_999_999_999_999, c: 0 } }, phone.memberId, (bytes) => phone.sign(bytes));
    await A.roster.merge([own.statement, aboutA.statement]);
    expect(A.roster.profile(phone.memberId, "name")).toBe("My phone");
    expect(A.roster.profile(A.identity.memberId, "icon")).toBe("x".repeat(2_000));

    // Push subscriptions: valid devices only, canonical JSON, a revoked device's is never used.
    const sub = { endpoint: "https://push.example.com/send/abc", keys: { p256dh: toBase64Url(Uint8Array.from([4, ...new Array<number>(64).fill(5)])), auth: toBase64Url(new Uint8Array(16).fill(6)) } };
    const said: Record<string, unknown> = {};
    said.notADevice = await refusesClean(h, A, () => A.roster.writeProfile(B.identity.memberId, "push", JSON.stringify(sub)), "not-a-device");
    said.unknown = await refusesClean(h, A, () => A.roster.writeProfile("nobody", "push", JSON.stringify(sub)), "not-a-device");
    said.malformed = await refusesClean(h, A, () => A.roster.writeProfile(phone.memberId, "push", "{\"endpoint\":\"http://x\"}"), "bad-profile");
    const written = await A.roster.writeProfile(phone.memberId, "push", JSON.stringify({ keys: sub.keys, endpoint: sub.endpoint }));
    expect((written!.body as { value: string }).value).toBe(JSON.stringify({ endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } }));
    expect(A.roster.pushSubscription(phone.memberId)).toEqual(sub);
    expect(A.roster.pushSubscriptions()).toEqual([{ device: phone.memberId, subscription: sub }]);
    expect(A.roster.pushSubscription(B.identity.memberId)).toBeNull();
    expect(await A.roster.writeProfile(phone.memberId, "push", JSON.stringify(sub))).toBeNull();
    await A.roster.revokeDevice(phone.memberId);
    expect(A.roster.profile(phone.memberId, "push")).toBeNull();
    expect(A.roster.pushSubscriptions()).toEqual([]);
    said.revoked = await refusesClean(h, A, () => A.roster.writeProfile(phone.memberId, "push", JSON.stringify(sub)), "revoked");
    h.golden("profile.refusals", said);
    h.golden("profile.stored", h.stored(A));
  });

  it("acts run one at a time in call order; a refused act does not block the next; a listener can unsubscribe and a throwing one is logged and skipped", async () => {
    const h = harness();
    const { A } = await startCluster(h);
    const [p1, p2, p3, p4] = await Promise.all([10, 11, 12, 13].map((seed) => member(seed)));
    h.names.member(p1, "p1");
    h.names.member(p2, "p2");
    h.names.member(p3, "p3");
    h.names.member(p4, "p4");
    h.tick();
    const outcomes = await Promise.allSettled([
      A.roster.addDevice({ keys: p1.keys, name: "P1" }),
      A.roster.addDevice({ keys: p1.keys, name: "P1 again" }),
      A.roster.revokeDevice("nobody"),
      A.roster.addDevice({ keys: p2.keys, name: "P2" }),
      A.roster.revokeDevice(p1.memberId),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect((outcomes[0] as PromiseFulfilledResult<{ created: boolean }>).value.created).toBe(true);
    expect((outcomes[1] as PromiseFulfilledResult<{ created: boolean }>).value.created).toBe(false); // it saw the first act's view
    expect(((outcomes[2] as PromiseRejectedResult).reason as RosterError).reason).toBe("not-a-device");
    expect(A.roster.isValid(p1.memberId)).toBe(false);
    expect(A.roster.isValid(p2.memberId)).toBe(true);
    await A.roster.idle();
    h.golden("serial.changes", { changes: h.changesOf(A), audit: auditRows(A).map((audit) => audit.act).reverse() });

    const calls: string[] = [];
    const off = A.roster.onChange(() => calls.push("first"));
    await A.roster.addDevice({ keys: p3.keys, name: "P3" });
    expect(calls).toEqual(["first"]);
    off();
    await A.roster.revokeDevice(p3.memberId);
    expect(calls).toEqual(["first"]);
    // A listener that throws is logged; the acts and the other listeners are not affected.
    A.roster.onChange(() => { throw new Error("boom"); });
    A.roster.onChange(() => calls.push("after the thrower"));
    await A.roster.addDevice({ keys: p4.keys, name: "P4" });
    expect(A.log).toContain("roster: a change listener failed: boom");
    expect(calls).toEqual(["first", "after the thrower"]);
    expect(A.roster.isValid(p4.memberId)).toBe(true);
  });

  it("open: malformed or mismatched rows are skipped and logged; statements, receipt times and the view come back; readAudits reads newest first", async () => {
    const h = harness();
    const { A, B } = await threeServers(h);
    const view = JSON.stringify(h.viewOf(A));
    const statements = A.roster.statements();
    const real = h.raw(A).roster[0];
    await A.store.submit((tx) => {
      const put = tx.prepare("INSERT INTO roster (id, kind, member, bytes, receivedAt) VALUES (?, ?, ?, ?, ?)");
      put.run("a".repeat(64), "add", "x", new TextEncoder().encode("not json"), 1);
      put.run("b".repeat(64), real.kind, real.member, storedBytes(real.statement!), 2); // valid bytes under another id
    });
    const reopened = await h.reopen(A);
    expect(A.log).toEqual(["roster: 2 stored statements are malformed and were skipped"]);
    expect(reopened.statements().map((item) => [item.id, item.receivedAt])).toEqual(statements.map((item) => [item.id, item.receivedAt]));
    expect(JSON.stringify(h.viewOf(A))).toBe(view);
    expect(reopened.clusterId).toBe(B.roster.clusterId);
    expect(await reopened.digest()).toBe(await rosterDigest(statements.map((item) => item.id)));

    const reader = A.store.openReader();
    try {
      const all = readAudits(reader);
      const rows = h.raw(A).audit;
      expect(all.map((audit) => audit.statement)).toEqual([...rows].reverse().map((row) => (row.body as { statement: string }).statement));
      expect(readAudits(reader, 2)).toEqual(all.slice(0, 2));
      expect(readAudits(reader, 0)).toEqual([]);
    } finally {
      reader.close();
    }
    h.golden("open.audits", h.audits(A));
  });
});

// ---------------------------------------------------------------------------------------------------------------------

// <golden>
const GOLDEN: Record<string, unknown> = {
  "addDevice.dump": {
    "stored": {
      "add:long@A": {
        "kind": "add",
        "member": "long",
        "receivedAt": 1002000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "long", "kind": "device", "keys": {"sign": "long.sign", "dh": "long.dh"}, "name": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn", "scope": ["read", "reply", "approve"], "by": "A", "at": 1002000},
      },
      "add:phone@A": {
        "kind": "add",
        "member": "phone",
        "receivedAt": 1001000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone One", "scope": ["manage", "read"], "by": "A", "at": 1001000},
      },
      "add:phone@A~2": {
        "kind": "add",
        "member": "phone",
        "receivedAt": 1002000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"}, "name": "Device", "scope": ["read", "reply", "approve"], "by": "A", "at": 1002000},
      },
      "revoke:phone@A:g1": {
        "kind": "revoke",
        "member": "phone",
        "receivedAt": 1003000,
        "signer": "A",
        "body": {"type": "revoke", "cluster": "cluster", "member": "phone", "reason": "", "by": "A", "gen": 1, "cascade": false},
      },
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1000000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
    },
    "audit": [
      {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
      {
        "key": "audit:add:phone@A",
        "rev": 2,
        "body": {"act": "device.add", "statement": "add:phone@A", "by": "A", "member": "phone", "name": "Phone One", "at": 1001000},
      },
      {
        "key": "audit:add:phone@A~2",
        "rev": 3,
        "body": {"act": "device.add", "statement": "add:phone@A~2", "by": "A", "member": "phone", "name": "Device", "at": 1002000},
      },
      {
        "key": "audit:add:long@A",
        "rev": 4,
        "body": {"act": "device.add", "statement": "add:long@A", "by": "A", "member": "long", "name": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn", "at": 1002000},
      },
      {
        "key": "audit:revoke:phone@A:g1",
        "rev": 5,
        "body": {"act": "device.revoke", "statement": "revoke:phone@A:g1", "by": "A", "member": "phone", "name": "Device", "at": 1003000},
      },
    ],
    "meta": [{"key": "clusterId", "value": "cluster"}],
    "changes": [
      {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "phone"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "phone"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "long", "phone"], "rootGen": 1, "dropped": 0},
      {"invalidated": ["phone"], "valid": ["A", "long"], "rootGen": 1, "dropped": 0},
    ],
    "view": {
      "cluster": "cluster",
      "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
      "servers": ["A"],
      "valid": ["A", "long"],
      "revoked": ["phone"],
      "members": [
        {
          "member": "long",
          "kind": "device",
          "name": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
          "addId": "add:long@A",
          "by": "A",
          "at": 1002000,
          "scope": ["read", "reply", "approve"],
        },
        {
          "member": "phone",
          "kind": "device",
          "name": "Device",
          "addId": "add:phone@A~2",
          "by": "A",
          "at": 1002000,
          "scope": ["read", "reply", "approve"],
        },
      ],
      "countingRevokes": ["revoke:phone@A:g1"],
      "dropped": [],
    },
  },
  "addDevice.refusals": {
    "badKeys": {"reason": "bad-keys", "message": "a device's keys are two 32-byte public keys"},
    "extraKeyPart": {"reason": "bad-keys", "message": "a device's keys are two 32-byte public keys"},
    "itself": {"reason": "not-a-device", "message": "that key is a server's"},
    "revoked": {"reason": "revoked", "message": "this device was revoked; pair it again with a new key"},
  },
  "addServer.dump": {
    "stored": {
      "add:B@A": {
        "kind": "add",
        "member": "B",
        "receivedAt": 1002000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"}, "name": "Renamed", "by": "A", "at": 1002000, "joined": true},
      },
      "add:B@A~2": {
        "kind": "add",
        "member": "B",
        "receivedAt": 1001000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server", "by": "A", "at": 1001000, "joined": true},
      },
      "revoke:B@A:g1": {
        "kind": "revoke",
        "member": "B",
        "receivedAt": 1002000,
        "signer": "A",
        "body": {"type": "revoke", "cluster": "cluster", "member": "B", "reason": "", "by": "A", "gen": 1, "cascade": false, "seen": []},
      },
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1000000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
    },
    "audit": [
      {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
      {
        "key": "audit:add:B@A~2",
        "rev": 2,
        "body": {"act": "server.add", "statement": "add:B@A~2", "by": "A", "member": "B", "name": "Server", "at": 1001000},
      },
      {
        "key": "audit:add:B@A",
        "rev": 3,
        "body": {"act": "server.add", "statement": "add:B@A", "by": "A", "member": "B", "name": "Renamed", "at": 1002000},
      },
      {
        "key": "audit:revoke:B@A:g1",
        "rev": 4,
        "body": {"act": "server.revoke", "statement": "revoke:B@A:g1", "by": "A", "member": "B", "name": "Renamed", "at": 1002000},
      },
    ],
    "meta": [{"key": "clusterId", "value": "cluster"}],
    "changes": [
      {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
      {"invalidated": ["B"], "valid": ["A"], "rootGen": 1, "dropped": 0},
    ],
    "view": {
      "cluster": "cluster",
      "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
      "servers": ["A", "B"],
      "valid": ["A"],
      "revoked": ["B"],
      "members": [{"member": "B", "kind": "server", "name": "Renamed", "addId": "add:B@A", "by": "A", "at": 1002000}],
      "countingRevokes": ["revoke:B@A:g1"],
      "dropped": [],
    },
  },
  "addServer.refusals": {
    "badKeys": {"reason": "bad-keys", "message": "a server's keys are two 32-byte public keys"},
    "itself": {"reason": "bad-keys", "message": "a server does not add itself"},
    "removed": {"reason": "revoked", "message": "that server was removed from the cluster"},
  },
  "converge.AB": {
    "labels": ["add:A@B", "add:B@A", "add:p1@A", "add:p2@B", "endorse:p1@B", "endorse:p2@A", "root:g1"],
    "reported": {"toB": {"fresh": ["add:p1@A"], "refused": []}, "toA": {"fresh": ["add:p2@B"], "refused": []}},
    "digest": "c1c3515668f8ea8cdc038183d20c26986d8982c162ede18b5a0baa4d21763f62",
    "changes": {"A": 7, "B": 5},
  },
  "converge.BA": {
    "labels": ["add:A@B", "add:B@A", "add:p1@A", "add:p2@B", "endorse:p1@B", "endorse:p2@A", "root:g1"],
    "reported": {"toA": {"fresh": ["add:p2@B"], "refused": []}, "toB": {"fresh": ["add:p1@A"], "refused": []}},
    "digest": "c1c3515668f8ea8cdc038183d20c26986d8982c162ede18b5a0baa4d21763f62",
    "changes": {"A": 7, "B": 5},
  },
  "create.dump": {
    "stored": {
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1001000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
    },
    "audit": [{"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1001000}}],
    "meta": [{"key": "clusterId", "value": "cluster"}],
    "changes": [{"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0}],
    "view": {
      "cluster": "cluster",
      "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
      "servers": ["A"],
      "valid": ["A"],
      "revoked": [],
      "members": [],
      "countingRevokes": [],
      "dropped": [],
    },
  },
  "create.race": {
    "said": {"reason": "cluster-exists", "message": "this server already belongs to a cluster"},
    "rows": {
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1000000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
    },
    "audit": [{"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}}],
  },
  "create.refusals": {
    "gen2": {"reason": "bad-root", "message": "the first Root names gen 1, this cluster and this server"},
    "notThisServer": {"reason": "bad-root", "message": "the first Root names gen 1, this cluster and this server"},
    "otherClusterId": {"reason": "bad-root", "message": "the first Root names gen 1, this cluster and this server"},
    "signedByAnotherKey": {"reason": "bad-root", "message": "the Root does not verify for this cluster"},
    "again": {"reason": "cluster-exists", "message": "this server already belongs to a cluster"},
  },
  "empty.refusals": {
    "addDevice": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "addServer": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "revokeDevice": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "revokeServer": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "merge": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "writeProfile": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "dismissDropped": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "reroot": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
    "replaceRecovery": {"reason": "no-cluster", "message": "there is no cluster yet (it is made at the first pairing)"},
  },
  "gossipStatements.dump": {"carried": ["add:A@B", "add:B@A", "add:phone@A", "root:g1"], "stored": ["add:A@B", "add:B@A", "add:phone@A", "foreign-root", "root:g1"]},
  "join.dump": {
    "stored": {
      "add:A@B": {
        "kind": "add",
        "member": "A",
        "receivedAt": 1003000,
        "signer": "B",
        "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1003000, "joined": false},
      },
      "add:B@A": {
        "kind": "add",
        "member": "B",
        "receivedAt": 1003000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1002000, "joined": true},
      },
      "add:C@A": {
        "kind": "add",
        "member": "C",
        "receivedAt": 1003000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "A", "at": 1002000, "joined": true},
      },
      "add:phone@A": {
        "kind": "add",
        "member": "phone",
        "receivedAt": 1003000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "A", "at": 1001000},
      },
      "endorse:C@B": {
        "kind": "endorse",
        "member": "C",
        "receivedAt": 1003000,
        "signer": "B",
        "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@A", "by": "B"},
      },
      "endorse:phone@B": {
        "kind": "endorse",
        "member": "phone",
        "receivedAt": 1003000,
        "signer": "B",
        "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@A", "by": "B"},
      },
      "profile:B.addresses@1003000.0": {
        "kind": "profile",
        "member": "B",
        "receivedAt": 1003000,
        "signer": "B",
        "body": {"type": "profile", "cluster": "cluster", "member": "B", "field": "addresses", "value": "https://b.example:7443", "hlc": {"ms": 1003000, "c": 0}},
      },
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1003000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
    },
    "audit": [
      {"key": "audit:add:B@A", "rev": 1, "body": {"act": "cluster.join", "statement": "add:B@A", "by": "A", "member": "B", "at": 1003000}},
      {
        "key": "audit:add:A@B",
        "rev": 2,
        "body": {"act": "server.add", "statement": "add:A@B", "by": "B", "member": "A", "name": "Server A", "at": 1003000},
      },
      {
        "key": "audit:endorse:phone@B",
        "rev": 3,
        "body": {"act": "member.endorse", "statement": "endorse:phone@B", "by": "B", "member": "phone", "at": 1003000},
      },
      {"key": "audit:endorse:C@B", "rev": 4, "body": {"act": "member.endorse", "statement": "endorse:C@B", "by": "B", "member": "C", "at": 1003000}},
    ],
    "meta": [{"key": "clusterId", "value": "cluster"}],
    "changes": [
      {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
    ],
    "view": {
      "cluster": "cluster",
      "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
      "servers": ["A", "B", "C"],
      "valid": ["A", "B", "C", "phone"],
      "revoked": [],
      "members": [
        {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1003000},
        {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@A", "by": "A", "at": 1002000},
        {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@A", "by": "A", "at": 1002000},
        {
          "member": "phone",
          "kind": "device",
          "name": "Phone",
          "addId": "add:phone@A",
          "by": "A",
          "at": 1001000,
          "scope": ["read", "reply", "approve"],
        },
      ],
      "countingRevokes": [],
      "dropped": [],
    },
  },
  "join.refusals": {
    "noAdd": {"reason": "bad-join", "message": "the welcome carries no Add"},
    "garbageAdd": {"reason": "bad-join", "message": "the welcome carries no Add"},
    "otherServersAdd": {"reason": "bad-join", "message": "the Add does not name this server with its keys"},
    "wrongSponsor": {"reason": "bad-join", "message": "the Add is not signed by the server this pairing ran with"},
    "badSponsorKeys": {"reason": "bad-keys", "message": "the sponsor's keys are malformed"},
    "noRoot": {"reason": "bad-join", "message": "the statements give no root for that cluster"},
    "foreignClusterRoster": {"reason": "bad-join", "message": "the statements give no root for that cluster"},
    "alreadyMember": {"reason": "cluster-exists", "message": "this server already belongs to a cluster"},
  },
  "join.result": {"clusterId": "cluster", "addId": "add:A@B"},
  "merge.single": {
    "said": {"fresh": ["add:phone@A", "add:spare@A"]},
    "dump": {
      "stored": {
        "add:phone@A": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read"], "by": "A", "at": 1001000},
        },
        "add:spare@A": {
          "kind": "add",
          "member": "spare",
          "receivedAt": 1002000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "spare", "kind": "device", "keys": {"sign": "spare.sign", "dh": "spare.dh"}, "name": "Spare", "scope": ["read"], "by": "A", "at": 1001000},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1000000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
      },
      "audit": [
        {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
        {
          "key": "audit:add:phone@A",
          "rev": 2,
          "body": {"act": "statement.merge", "statement": "add:phone@A", "by": "A", "member": "phone", "at": 1001000},
        },
        {
          "key": "audit:add:spare@A",
          "rev": 3,
          "body": {"act": "statement.merge", "statement": "add:spare@A", "by": "A", "member": "spare", "at": 1001000},
        },
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}],
      "changes": [
        {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "phone", "spare"], "rootGen": 1, "dropped": 0},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
        "servers": ["A"],
        "valid": ["A", "phone", "spare"],
        "revoked": [],
        "members": [
          {"member": "phone", "kind": "device", "name": "Phone", "addId": "add:phone@A", "by": "A", "at": 1001000, "scope": ["read"]},
          {"member": "spare", "kind": "device", "name": "Spare", "addId": "add:spare@A", "by": "A", "at": 1001000, "scope": ["read"]},
        ],
        "countingRevokes": [],
        "dropped": [],
      },
    },
  },
  "mergeGossip.dump": {
    "B": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:phone2@A": {
          "kind": "add",
          "member": "phone2",
          "receivedAt": 1003000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "phone2", "kind": "device", "keys": {"sign": "phone2.sign", "dh": "phone2.dh"}, "name": "Phone2", "scope": ["read", "reply", "approve"], "by": "A", "at": 1002000},
        },
        "add:phone3@A": {
          "kind": "add",
          "member": "phone3",
          "receivedAt": 1003000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "phone3", "kind": "device", "keys": {"sign": "phone3.sign", "dh": "phone3.dh"}, "name": "P3", "scope": ["read", "reply", "approve"], "by": "A", "at": 1003000},
        },
        "add:phone4@A": {
          "kind": "add",
          "member": "phone4",
          "receivedAt": 1003000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "phone4", "kind": "device", "keys": {"sign": "phone4.sign", "dh": "phone4.dh"}, "name": "P4", "scope": ["read", "reply", "approve"], "by": "A", "at": 1003000},
        },
        "add:phone5@A": {
          "kind": "add",
          "member": "phone5",
          "receivedAt": 1003000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "phone5", "kind": "device", "keys": {"sign": "phone5.sign", "dh": "phone5.dh"}, "name": "P5", "scope": ["read", "reply", "approve"], "by": "A", "at": 1003000},
        },
        "add:phone@A": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "A", "at": 1002000},
        },
        "endorse:phone2@B": {
          "kind": "endorse",
          "member": "phone2",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone2", "addId": "add:phone2@A", "by": "B"},
        },
        "endorse:phone3@B": {
          "kind": "endorse",
          "member": "phone3",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone3", "addId": "add:phone3@A", "by": "B"},
        },
        "endorse:phone4@B": {
          "kind": "endorse",
          "member": "phone4",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone4", "addId": "add:phone4@A", "by": "B"},
        },
        "endorse:phone5@B": {
          "kind": "endorse",
          "member": "phone5",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone5", "addId": "add:phone5@A", "by": "B"},
        },
        "endorse:phone@B": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@A", "by": "B"},
        },
        "profile-self-by-phone": {
          "kind": "profile",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "phone",
          "body": {"type": "profile", "cluster": "cluster", "member": "phone", "field": "name", "value": "mine", "hlc": {"ms": 1, "c": 0}},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
      },
      "changes": [
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3", "phone4", "phone5"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3", "phone4", "phone5"], "rootGen": 1, "dropped": 0},
      ],
    },
    "A": {
      "changes": [
        {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3", "phone4"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3", "phone4", "phone5"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone", "phone2", "phone3", "phone4", "phone5"], "rootGen": 1, "dropped": 0},
      ],
    },
  },
  "mergeRevocations.sequences": {
    "revoke-first": {
      "fresh": [["revoke:A@B:g2", "root:g2"]],
      "rootGen": 2,
      "aValid": false,
      "statements": [
        "add:A@B",
        "add:B@A",
        "add:B@C",
        "add:C@B",
        "add:phone@B",
        "endorse:A@C",
        "endorse:C@A",
        "endorse:phone@A",
        "endorse:phone@C",
        "revoke:A@B:g2",
        "root:g1",
        "root:g2",
      ],
    },
    "root-first": {
      "fresh": [["revoke:A@B:g2", "root:g2"]],
      "rootGen": 2,
      "aValid": false,
      "statements": [
        "add:A@B",
        "add:B@A",
        "add:B@C",
        "add:C@B",
        "add:phone@B",
        "endorse:A@C",
        "endorse:C@A",
        "endorse:phone@A",
        "endorse:phone@C",
        "revoke:A@B:g2",
        "root:g1",
        "root:g2",
      ],
    },
    "revoke-alone": {
      "fresh": [[]],
      "rootGen": 1,
      "aValid": true,
      "statements": ["add:A@B", "add:B@A", "add:B@C", "add:C@B", "add:phone@B", "endorse:A@C", "endorse:C@A", "endorse:phone@A", "endorse:phone@C", "root:g1"],
    },
    "root-then-revoke": {
      "fresh": [["root:g2"], ["revoke:A@B:g2"]],
      "rootGen": 2,
      "aValid": false,
      "statements": [
        "add:A@B",
        "add:B@A",
        "add:B@C",
        "add:C@B",
        "add:phone@B",
        "endorse:A@C",
        "endorse:C@A",
        "endorse:phone@A",
        "endorse:phone@C",
        "revoke:A@B:g2",
        "root:g1",
        "root:g2",
      ],
    },
  },
  "mergeRevocations.single": {
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1002000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "revoke:C@A:g1": {
          "kind": "revoke",
          "member": "C",
          "receivedAt": 1005000,
          "signer": "A",
          "body": {"type": "revoke", "cluster": "cluster", "member": "C", "reason": "", "by": "A", "gen": 1, "cascade": false, "seen": []},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
      },
      "changes": [
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["C"], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
      ],
    },
  },
  "open.audits": [
    {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
    {
      "key": "audit:add:B@A",
      "rev": 2,
      "body": {"act": "server.add", "statement": "add:B@A", "by": "A", "member": "B", "name": "Server B", "at": 1001000},
    },
    {"key": "audit:add:C@B", "rev": 3, "body": {"act": "statement.merge", "statement": "add:C@B", "by": "B", "member": "C", "at": 1004000}},
    {"key": "audit:add:A@B", "rev": 4, "body": {"act": "statement.merge", "statement": "add:A@B", "by": "B", "member": "A", "at": 1004000}},
    {
      "key": "audit:add:phone@B",
      "rev": 5,
      "body": {"act": "statement.merge", "statement": "add:phone@B", "by": "B", "member": "phone", "at": 1004000},
    },
    {"key": "audit:endorse:A@C", "rev": 6, "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000}},
    {"key": "audit:add:B@C", "rev": 7, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
    {
      "key": "audit:endorse:phone@A",
      "rev": 8,
      "body": {"act": "member.endorse", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
    },
    {"key": "audit:endorse:C@A", "rev": 9, "body": {"act": "member.endorse", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000}},
    {
      "key": "audit:endorse:phone@C",
      "rev": 10,
      "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
    },
  ],
  "profile.refusals": {
    "notADevice": {"reason": "not-a-device", "message": "push subscriptions belong only to valid devices"},
    "unknown": {"reason": "not-a-device", "message": "push subscriptions belong only to valid devices"},
    "malformed": {"reason": "bad-profile", "message": "push subscription is malformed"},
    "revoked": {"reason": "revoked", "message": "cannot store a push subscription for a revoked device"},
  },
  "profile.stored": {
    "add:A@B": {
      "kind": "add",
      "member": "A",
      "receivedAt": 1001000,
      "signer": "B",
      "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
    },
    "add:B@A": {
      "kind": "add",
      "member": "B",
      "receivedAt": 1001000,
      "signer": "A",
      "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
    },
    "add:phone@A": {
      "kind": "add",
      "member": "phone",
      "receivedAt": 1002000,
      "signer": "A",
      "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "A", "at": 1002000},
    },
    "endorse:phone@B": {
      "kind": "endorse",
      "member": "phone",
      "receivedAt": 1002000,
      "signer": "B",
      "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@A", "by": "B"},
    },
    "profile:A.addresses@1003000.0": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1003000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "addresses", "value": "https://a.example:1", "hlc": {"ms": 1003000, "c": 0}},
    },
    "profile:A.addresses@1003000.1": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1003000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "addresses", "value": "https://a.example:2", "hlc": {"ms": 1003000, "c": 1}},
    },
    "profile:A.addresses@1003000.2": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 998000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "addresses", "value": "https://a.example:3", "hlc": {"ms": 1003000, "c": 2}},
    },
    "profile:A.addresses@1013000.0": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1013000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "addresses", "value": "https://a.example:4", "hlc": {"ms": 1013000, "c": 0}},
    },
    "profile:A.icon@1013000.0": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1013000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "icon", "value": "<2000 chars>", "hlc": {"ms": 1013000, "c": 0}},
    },
    "profile:A.icon@1013000.1": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1013000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "icon", "value": "<2000 chars>", "hlc": {"ms": 1013000, "c": 1}},
    },
    "profile:A.icon@9999999999999.0": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1014000,
      "signer": "phone",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "icon", "value": "hijack", "hlc": {"ms": 9999999999999, "c": 0}},
    },
    "profile:A.name@1013000.0": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1013000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "name", "value": "Server A", "hlc": {"ms": 1013000, "c": 0}},
    },
    "profile:A.name@1014000.0": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1014000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "name", "value": "named by A", "hlc": {"ms": 1014000, "c": 0}},
    },
    "profile:A.name@1014000.0~2": {
      "kind": "profile",
      "member": "A",
      "receivedAt": 1014000,
      "signer": "B",
      "body": {"type": "profile", "cluster": "cluster", "member": "A", "field": "name", "value": "named by B", "hlc": {"ms": 1014000, "c": 0}},
    },
    "profile:phone.name@1.0": {
      "kind": "profile",
      "member": "phone",
      "receivedAt": 1014000,
      "signer": "phone",
      "body": {"type": "profile", "cluster": "cluster", "member": "phone", "field": "name", "value": "My phone", "hlc": {"ms": 1, "c": 0}},
    },
    "profile:phone.push@1014000.0": {
      "kind": "profile",
      "member": "phone",
      "receivedAt": 1014000,
      "signer": "A",
      "body": {"type": "profile", "cluster": "cluster", "member": "phone", "field": "push", "value": "{\"endpoint\":\"https://push.example.com/send/abc\",\"keys\":{\"auth\":\"BgYGBgYGBgYGBgYGBgYGBg\",\"p256dh\":\"BAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU\"}}", "hlc": {"ms": 1014000, "c": 0}},
    },
    "revoke:phone@A:g1": {
      "kind": "revoke",
      "member": "phone",
      "receivedAt": 1014000,
      "signer": "A",
      "body": {"type": "revoke", "cluster": "cluster", "member": "phone", "reason": "", "by": "A", "gen": 1, "cascade": false},
    },
    "root:g1": {
      "kind": "root",
      "member": "A",
      "receivedAt": 1000000,
      "signer": "recovery",
      "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
    },
  },
  "recovery.dump": {
    "stored": {
      "add:A@B": {
        "kind": "add",
        "member": "A",
        "receivedAt": 1001000,
        "signer": "B",
        "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
      },
      "add:B@A": {
        "kind": "add",
        "member": "B",
        "receivedAt": 1001000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
      },
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1000000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
      "root:g2": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1603000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 2, "root": "A", "recoveryPub": "R2.pub", "keep": [], "prev": "root:g1"},
      },
    },
    "audit": [
      {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
      {
        "key": "audit:add:B@A",
        "rev": 2,
        "body": {"act": "server.add", "statement": "add:B@A", "by": "A", "member": "B", "name": "Server B", "at": 1001000},
      },
      {"key": "audit:add:A@B", "rev": 3, "body": {"act": "statement.merge", "statement": "add:A@B", "by": "B", "member": "A", "at": 1001000}},
      {"key": "audit:root:g2", "rev": 4, "body": {"act": "root.change", "statement": "root:g2", "by": "recovery", "member": "A", "at": 1603000}},
    ],
    "meta": [{"key": "clusterId", "value": "cluster"}],
    "changes": [
      {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 2, "dropped": 0},
    ],
    "view": {
      "cluster": "cluster",
      "root": {"id": "root:g2", "gen": 2, "root": "A", "recoveryPub": "R2.pub", "keep": []},
      "servers": ["A", "B"],
      "valid": ["A", "B"],
      "revoked": [],
      "members": [
        {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
        {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@A", "by": "A", "at": 1001000},
      ],
      "countingRevokes": [],
      "dropped": [],
    },
  },
  "recovery.refusals": {
    "notRoot": {"reason": "not-root", "message": "only the revocation root can replace the recovery code"},
    "malformed": {"reason": "bad-code", "message": "the recovery code is malformed"},
    "wrongCode": {"reason": "bad-code", "message": "the recovery code does not match this cluster"},
  },
  "reroot.keep.dropped": {
    "said": {"notDropped": {"reason": "not-dropped", "message": "no such dropped revocation"}},
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1002000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "revoke:C@A:g1": {
          "kind": "revoke",
          "member": "C",
          "receivedAt": 1005000,
          "signer": "A",
          "body": {"type": "revoke", "cluster": "cluster", "member": "C", "reason": "", "by": "A", "gen": 1, "cascade": false, "seen": []},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
        "root:g2": {
          "kind": "root",
          "member": "B",
          "receivedAt": 1006000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": [], "prev": "root:g1"},
        },
      },
      "audit": [
        {"key": "audit:add:B@A", "rev": 1, "body": {"act": "cluster.join", "statement": "add:B@A", "by": "A", "member": "B", "at": 1001000}},
        {
          "key": "audit:add:A@B",
          "rev": 2,
          "body": {"act": "server.add", "statement": "add:A@B", "by": "B", "member": "A", "name": "Server A", "at": 1001000},
        },
        {
          "key": "audit:add:C@B",
          "rev": 3,
          "body": {"act": "server.add", "statement": "add:C@B", "by": "B", "member": "C", "name": "Server C", "at": 1002000},
        },
        {
          "key": "audit:add:phone@B",
          "rev": 4,
          "body": {"act": "device.add", "statement": "add:phone@B", "by": "B", "member": "phone", "name": "Phone", "at": 1003000},
        },
        {
          "key": "audit:endorse:A@C",
          "rev": 5,
          "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000},
        },
        {"key": "audit:add:B@C", "rev": 6, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
        {
          "key": "audit:endorse:phone@A",
          "rev": 7,
          "body": {"act": "statement.merge", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:endorse:C@A",
          "rev": 8,
          "body": {"act": "statement.merge", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000},
        },
        {
          "key": "audit:endorse:phone@C",
          "rev": 9,
          "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:revoke:C@A:g1",
          "rev": 10,
          "body": {"act": "statement.merge", "statement": "revoke:C@A:g1", "by": "A", "member": "C", "at": 1005000},
        },
        {"key": "audit:root:g2", "rev": 11, "body": {"act": "root.change", "statement": "root:g2", "by": "recovery", "member": "B", "at": 1006000}},
        {
          "key": "audit:dropped:revoke:C@A:g1[:56]",
          "rev": 12,
          "body": {"act": "server.revoke.dropped", "statement": "revoke:C@A:g1", "by": "A", "member": "C", "name": "Server C", "reason": "gen 1: left-out", "at": 1008000},
        },
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}, {"key": "dropped.dismissed:revoke:C@A:g1", "value": "1007000"}],
      "changes": [
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["C"], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 2, "dropped": 1},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g2", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": []},
        "servers": ["A", "B", "C"],
        "valid": ["A", "B", "C", "phone"],
        "revoked": [],
        "members": [
          {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
          {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@C", "by": "C", "at": 1002000},
          {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@B", "by": "B", "at": 1002000},
          {
            "member": "phone",
            "kind": "device",
            "name": "Phone",
            "addId": "add:phone@B",
            "by": "B",
            "at": 1003000,
            "scope": ["read", "reply", "approve"],
          },
        ],
        "countingRevokes": [],
        "dropped": [{"revokeId": "revoke:C@A:g1", "member": "C", "signer": "A", "gen": 1, "receivedAt": 1005000, "why": "left-out"}],
      },
    },
  },
  "reroot.keep.kept": {
    "said": {},
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1002000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "revoke:C@A:g1": {
          "kind": "revoke",
          "member": "C",
          "receivedAt": 1005000,
          "signer": "A",
          "body": {"type": "revoke", "cluster": "cluster", "member": "C", "reason": "", "by": "A", "gen": 1, "cascade": false, "seen": []},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
        "root:g2": {
          "kind": "root",
          "member": "B",
          "receivedAt": 1006000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": ["revoke:C@A:g1"], "prev": "root:g1"},
        },
      },
      "audit": [
        {"key": "audit:add:B@A", "rev": 1, "body": {"act": "cluster.join", "statement": "add:B@A", "by": "A", "member": "B", "at": 1001000}},
        {
          "key": "audit:add:A@B",
          "rev": 2,
          "body": {"act": "server.add", "statement": "add:A@B", "by": "B", "member": "A", "name": "Server A", "at": 1001000},
        },
        {
          "key": "audit:add:C@B",
          "rev": 3,
          "body": {"act": "server.add", "statement": "add:C@B", "by": "B", "member": "C", "name": "Server C", "at": 1002000},
        },
        {
          "key": "audit:add:phone@B",
          "rev": 4,
          "body": {"act": "device.add", "statement": "add:phone@B", "by": "B", "member": "phone", "name": "Phone", "at": 1003000},
        },
        {
          "key": "audit:endorse:A@C",
          "rev": 5,
          "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000},
        },
        {"key": "audit:add:B@C", "rev": 6, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
        {
          "key": "audit:endorse:phone@A",
          "rev": 7,
          "body": {"act": "statement.merge", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:endorse:C@A",
          "rev": 8,
          "body": {"act": "statement.merge", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000},
        },
        {
          "key": "audit:endorse:phone@C",
          "rev": 9,
          "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:revoke:C@A:g1",
          "rev": 10,
          "body": {"act": "statement.merge", "statement": "revoke:C@A:g1", "by": "A", "member": "C", "at": 1005000},
        },
        {"key": "audit:root:g2", "rev": 11, "body": {"act": "root.change", "statement": "root:g2", "by": "recovery", "member": "B", "at": 1006000}},
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}],
      "changes": [
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["C"], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "phone"], "rootGen": 2, "dropped": 0},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g2", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": ["revoke:C@A:g1"]},
        "servers": ["A", "B", "C"],
        "valid": ["A", "B", "phone"],
        "revoked": ["C"],
        "members": [
          {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
          {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@A", "by": "A", "at": 1001000},
          {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@B", "by": "B", "at": 1002000},
          {
            "member": "phone",
            "kind": "device",
            "name": "Phone",
            "addId": "add:phone@B",
            "by": "B",
            "at": 1003000,
            "scope": ["read", "reply", "approve"],
          },
        ],
        "countingRevokes": ["revoke:C@A:g1"],
        "dropped": [],
      },
    },
  },
  "reroot.kept": {
    "said": {
      "badCode": {"reason": "bad-code", "message": "the recovery code does not match this cluster"},
      "malformed": {"reason": "bad-code", "message": "the recovery code is malformed"},
      "alreadyRoot": {"reason": "already-root", "message": "this server is already the revocation root"},
      "keepNotPending": {"reason": "bad-keep", "message": "keep may list only pending server revocations this server holds"},
      "keepTooMany": {"reason": "bad-keep", "message": "keep exceeds the maximum of 1000 revocations"},
    },
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1002000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
        "root:g2": {
          "kind": "root",
          "member": "B",
          "receivedAt": 1005000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": [], "prev": "root:g1"},
        },
      },
      "audit": [
        {"key": "audit:add:B@A", "rev": 1, "body": {"act": "cluster.join", "statement": "add:B@A", "by": "A", "member": "B", "at": 1001000}},
        {
          "key": "audit:add:A@B",
          "rev": 2,
          "body": {"act": "server.add", "statement": "add:A@B", "by": "B", "member": "A", "name": "Server A", "at": 1001000},
        },
        {
          "key": "audit:add:C@B",
          "rev": 3,
          "body": {"act": "server.add", "statement": "add:C@B", "by": "B", "member": "C", "name": "Server C", "at": 1002000},
        },
        {
          "key": "audit:add:phone@B",
          "rev": 4,
          "body": {"act": "device.add", "statement": "add:phone@B", "by": "B", "member": "phone", "name": "Phone", "at": 1003000},
        },
        {
          "key": "audit:endorse:A@C",
          "rev": 5,
          "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000},
        },
        {"key": "audit:add:B@C", "rev": 6, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
        {
          "key": "audit:endorse:phone@A",
          "rev": 7,
          "body": {"act": "statement.merge", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:endorse:C@A",
          "rev": 8,
          "body": {"act": "statement.merge", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000},
        },
        {
          "key": "audit:endorse:phone@C",
          "rev": 9,
          "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
        },
        {"key": "audit:root:g2", "rev": 10, "body": {"act": "root.change", "statement": "root:g2", "by": "recovery", "member": "B", "at": 1005000}},
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}],
      "changes": [
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 2, "dropped": 0},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g2", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": []},
        "servers": ["A", "B", "C"],
        "valid": ["A", "B", "C", "phone"],
        "revoked": [],
        "members": [
          {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
          {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@C", "by": "C", "at": 1002000},
          {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@B", "by": "B", "at": 1002000},
          {
            "member": "phone",
            "kind": "device",
            "name": "Phone",
            "addId": "add:phone@B",
            "by": "B",
            "at": 1003000,
            "scope": ["read", "reply", "approve"],
          },
        ],
        "countingRevokes": [],
        "dropped": [],
      },
    },
  },
  "reroot.lost": {
    "said": {
      "badCode": {"reason": "bad-code", "message": "the recovery code does not match this cluster"},
      "malformed": {"reason": "bad-code", "message": "the recovery code is malformed"},
      "alreadyRoot": {"reason": "already-root", "message": "this server is already the revocation root"},
      "keepNotPending": {"reason": "bad-keep", "message": "keep may list only pending server revocations this server holds"},
      "keepTooMany": {"reason": "bad-keep", "message": "keep exceeds the maximum of 1000 revocations"},
    },
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1002000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1003000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "revoke:A@B:g2": {
          "kind": "revoke",
          "member": "A",
          "receivedAt": 1005000,
          "signer": "B",
          "body": {"type": "revoke", "cluster": "cluster", "member": "A", "reason": "", "by": "B", "gen": 2, "cascade": false, "seen": ["add:B@A"]},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1001000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
        "root:g2": {
          "kind": "root",
          "member": "B",
          "receivedAt": 1005000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": [], "prev": "root:g1"},
        },
      },
      "audit": [
        {"key": "audit:add:B@A", "rev": 1, "body": {"act": "cluster.join", "statement": "add:B@A", "by": "A", "member": "B", "at": 1001000}},
        {
          "key": "audit:add:A@B",
          "rev": 2,
          "body": {"act": "server.add", "statement": "add:A@B", "by": "B", "member": "A", "name": "Server A", "at": 1001000},
        },
        {
          "key": "audit:add:C@B",
          "rev": 3,
          "body": {"act": "server.add", "statement": "add:C@B", "by": "B", "member": "C", "name": "Server C", "at": 1002000},
        },
        {
          "key": "audit:add:phone@B",
          "rev": 4,
          "body": {"act": "device.add", "statement": "add:phone@B", "by": "B", "member": "phone", "name": "Phone", "at": 1003000},
        },
        {
          "key": "audit:endorse:A@C",
          "rev": 5,
          "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000},
        },
        {"key": "audit:add:B@C", "rev": 6, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
        {
          "key": "audit:endorse:phone@A",
          "rev": 7,
          "body": {"act": "statement.merge", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:endorse:C@A",
          "rev": 8,
          "body": {"act": "statement.merge", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000},
        },
        {
          "key": "audit:endorse:phone@C",
          "rev": 9,
          "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
        },
        {"key": "audit:root:g2", "rev": 10, "body": {"act": "root.change", "statement": "root:g2", "by": "recovery", "member": "B", "at": 1005000}},
        {
          "key": "audit:revoke:A@B:g2",
          "rev": 11,
          "body": {"act": "server.revoke", "statement": "revoke:A@B:g2", "by": "B", "member": "A", "name": "Server A", "at": 1005000},
        },
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}],
      "changes": [
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["A"], "valid": ["B", "C", "phone"], "rootGen": 2, "dropped": 0},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g2", "gen": 2, "root": "B", "recoveryPub": "R1.pub", "keep": []},
        "servers": ["A", "B", "C"],
        "valid": ["B", "C", "phone"],
        "revoked": ["A"],
        "members": [
          {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
          {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@C", "by": "C", "at": 1002000},
          {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@B", "by": "B", "at": 1002000},
          {
            "member": "phone",
            "kind": "device",
            "name": "Phone",
            "addId": "add:phone@B",
            "by": "B",
            "at": 1003000,
            "scope": ["read", "reply", "approve"],
          },
        ],
        "countingRevokes": ["revoke:A@B:g2"],
        "dropped": [],
      },
    },
  },
  "revokeDevice.dump": {
    "stored": {
      "add:A@B": {
        "kind": "add",
        "member": "A",
        "receivedAt": 1000000,
        "signer": "B",
        "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1000000, "joined": false},
      },
      "add:B@A": {
        "kind": "add",
        "member": "B",
        "receivedAt": 1000000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1000000, "joined": true},
      },
      "add:phone@A": {
        "kind": "add",
        "member": "phone",
        "receivedAt": 1001000,
        "signer": "A",
        "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "A", "at": 1001000},
      },
      "revoke:phone@A:g1": {
        "kind": "revoke",
        "member": "phone",
        "receivedAt": 1002000,
        "signer": "A",
        "body": {"type": "revoke", "cluster": "cluster", "member": "phone", "reason": "<500 chars>", "by": "A", "gen": 1, "cascade": false},
      },
      "root:g1": {
        "kind": "root",
        "member": "A",
        "receivedAt": 1000000,
        "signer": "recovery",
        "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
      },
    },
    "audit": [
      {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
      {
        "key": "audit:add:B@A",
        "rev": 2,
        "body": {"act": "server.add", "statement": "add:B@A", "by": "A", "member": "B", "name": "Server B", "at": 1000000},
      },
      {"key": "audit:add:A@B", "rev": 3, "body": {"act": "statement.merge", "statement": "add:A@B", "by": "B", "member": "A", "at": 1000000}},
      {
        "key": "audit:add:phone@A",
        "rev": 4,
        "body": {"act": "device.add", "statement": "add:phone@A", "by": "A", "member": "phone", "name": "Phone", "at": 1001000},
      },
      {
        "key": "audit:revoke:phone@A:g1",
        "rev": 5,
        "body": {"act": "device.revoke", "statement": "revoke:phone@A:g1", "by": "A", "member": "phone", "name": "Phone", "reason": "<500 chars>", "at": 1002000},
      },
    ],
    "meta": [{"key": "clusterId", "value": "cluster"}],
    "changes": [
      {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "B", "phone"], "rootGen": 1, "dropped": 0},
      {"invalidated": ["phone"], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
    ],
    "view": {
      "cluster": "cluster",
      "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
      "servers": ["A", "B"],
      "valid": ["A", "B"],
      "revoked": ["phone"],
      "members": [
        {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1000000},
        {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@A", "by": "A", "at": 1000000},
        {
          "member": "phone",
          "kind": "device",
          "name": "Phone",
          "addId": "add:phone@A",
          "by": "A",
          "at": 1001000,
          "scope": ["read", "reply", "approve"],
        },
      ],
      "countingRevokes": ["revoke:phone@A:g1"],
      "dropped": [],
    },
  },
  "revokeDevice.refusals": {
    "aServer": {"reason": "server-revoke-root-only", "message": "a server is revoked only by the revocation root (use revokeServer)"},
    "unknown": {"reason": "not-a-device", "message": "no such device in this roster"},
  },
  "revokeServer.cascade": {
    "said": {
      "notRoot": {"reason": "server-revoke-root-only", "message": "only the revocation root can remove a server"},
      "root": {"reason": "cannot-revoke-root", "message": "the revocation root cannot remove itself"},
      "aDevice": {"reason": "not-a-server", "message": "no such server in this roster"},
      "unknown": {"reason": "not-a-server", "message": "no such server in this roster"},
    },
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "revoke:B@A:g1:cascade": {
          "kind": "revoke",
          "member": "B",
          "receivedAt": 1005000,
          "signer": "A",
          "body": {"type": "revoke", "cluster": "cluster", "member": "B", "reason": "<500 chars>", "by": "A", "gen": 1, "cascade": true, "seen": ["add:C@B", "add:phone@B"]},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1000000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
      },
      "audit": [
        {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
        {
          "key": "audit:add:B@A",
          "rev": 2,
          "body": {"act": "server.add", "statement": "add:B@A", "by": "A", "member": "B", "name": "Server B", "at": 1001000},
        },
        {"key": "audit:add:C@B", "rev": 3, "body": {"act": "statement.merge", "statement": "add:C@B", "by": "B", "member": "C", "at": 1004000}},
        {"key": "audit:add:A@B", "rev": 4, "body": {"act": "statement.merge", "statement": "add:A@B", "by": "B", "member": "A", "at": 1004000}},
        {
          "key": "audit:add:phone@B",
          "rev": 5,
          "body": {"act": "statement.merge", "statement": "add:phone@B", "by": "B", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:endorse:A@C",
          "rev": 6,
          "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000},
        },
        {"key": "audit:add:B@C", "rev": 7, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
        {
          "key": "audit:endorse:phone@A",
          "rev": 8,
          "body": {"act": "member.endorse", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
        },
        {"key": "audit:endorse:C@A", "rev": 9, "body": {"act": "member.endorse", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000}},
        {
          "key": "audit:endorse:phone@C",
          "rev": 10,
          "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:revoke:B@A:g1:cascade",
          "rev": 11,
          "body": {"act": "server.revoke", "statement": "revoke:B@A:g1:cascade", "by": "A", "member": "B", "name": "Server B", "reason": "<500 chars>", "at": 1005000},
        },
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}],
      "changes": [
        {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["B", "C", "phone"], "valid": ["A"], "rootGen": 1, "dropped": 0},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
        "servers": ["A", "B", "C"],
        "valid": ["A"],
        "revoked": ["B", "C", "phone"],
        "members": [
          {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
          {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@A", "by": "A", "at": 1001000},
          {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@B", "by": "B", "at": 1002000},
          {
            "member": "phone",
            "kind": "device",
            "name": "Phone",
            "addId": "add:phone@B",
            "by": "B",
            "at": 1003000,
            "scope": ["read", "reply", "approve"],
          },
        ],
        "countingRevokes": ["revoke:B@A:g1:cascade"],
        "dropped": [],
      },
    },
  },
  "revokeServer.plain": {
    "said": {
      "notRoot": {"reason": "server-revoke-root-only", "message": "only the revocation root can remove a server"},
      "root": {"reason": "cannot-revoke-root", "message": "the revocation root cannot remove itself"},
      "aDevice": {"reason": "not-a-server", "message": "no such server in this roster"},
      "unknown": {"reason": "not-a-server", "message": "no such server in this roster"},
    },
    "dump": {
      "stored": {
        "add:A@B": {
          "kind": "add",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "A", "kind": "server", "keys": {"sign": "A.sign", "dh": "A.dh"}, "name": "Server A", "by": "B", "at": 1001000, "joined": false},
        },
        "add:B@A": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1001000,
          "signer": "A",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "A", "at": 1001000, "joined": true},
        },
        "add:B@C": {
          "kind": "add",
          "member": "B",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "add", "cluster": "cluster", "member": "B", "kind": "server", "keys": {"sign": "B.sign", "dh": "B.dh"}, "name": "Server B", "by": "C", "at": 1002000, "joined": false},
        },
        "add:C@B": {
          "kind": "add",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "C", "kind": "server", "keys": {"sign": "C.sign", "dh": "C.dh"}, "name": "Server C", "by": "B", "at": 1002000, "joined": true},
        },
        "add:phone@B": {
          "kind": "add",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "B",
          "body": {"type": "add", "cluster": "cluster", "member": "phone", "kind": "device", "keys": {"sign": "phone.sign", "dh": "phone.dh"}, "name": "Phone", "scope": ["read", "reply", "approve"], "by": "B", "at": 1003000},
        },
        "endorse:A@C": {
          "kind": "endorse",
          "member": "A",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "A", "addId": "add:A@B", "by": "C"},
        },
        "endorse:C@A": {
          "kind": "endorse",
          "member": "C",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "C", "addId": "add:C@B", "by": "A"},
        },
        "endorse:phone@A": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "A",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "A"},
        },
        "endorse:phone@C": {
          "kind": "endorse",
          "member": "phone",
          "receivedAt": 1004000,
          "signer": "C",
          "body": {"type": "endorse", "cluster": "cluster", "member": "phone", "addId": "add:phone@B", "by": "C"},
        },
        "revoke:B@A:g1": {
          "kind": "revoke",
          "member": "B",
          "receivedAt": 1005000,
          "signer": "A",
          "body": {"type": "revoke", "cluster": "cluster", "member": "B", "reason": "<500 chars>", "by": "A", "gen": 1, "cascade": false, "seen": ["add:C@B", "add:phone@B"]},
        },
        "revoke:B@A:g1:cascade": {
          "kind": "revoke",
          "member": "B",
          "receivedAt": 1006000,
          "signer": "A",
          "body": {"type": "revoke", "cluster": "cluster", "member": "B", "reason": "", "by": "A", "gen": 1, "cascade": true, "seen": ["add:C@B", "add:phone@B"]},
        },
        "root:g1": {
          "kind": "root",
          "member": "A",
          "receivedAt": 1000000,
          "signer": "recovery",
          "body": {"type": "root", "cluster": "cluster", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": [], "prev": null},
        },
      },
      "audit": [
        {"key": "audit:root:g1", "rev": 1, "body": {"act": "cluster.create", "statement": "root:g1", "by": "recovery", "member": "A", "at": 1000000}},
        {
          "key": "audit:add:B@A",
          "rev": 2,
          "body": {"act": "server.add", "statement": "add:B@A", "by": "A", "member": "B", "name": "Server B", "at": 1001000},
        },
        {"key": "audit:add:C@B", "rev": 3, "body": {"act": "statement.merge", "statement": "add:C@B", "by": "B", "member": "C", "at": 1004000}},
        {"key": "audit:add:A@B", "rev": 4, "body": {"act": "statement.merge", "statement": "add:A@B", "by": "B", "member": "A", "at": 1004000}},
        {
          "key": "audit:add:phone@B",
          "rev": 5,
          "body": {"act": "statement.merge", "statement": "add:phone@B", "by": "B", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:endorse:A@C",
          "rev": 6,
          "body": {"act": "statement.merge", "statement": "endorse:A@C", "by": "C", "member": "A", "at": 1004000},
        },
        {"key": "audit:add:B@C", "rev": 7, "body": {"act": "statement.merge", "statement": "add:B@C", "by": "C", "member": "B", "at": 1004000}},
        {
          "key": "audit:endorse:phone@A",
          "rev": 8,
          "body": {"act": "member.endorse", "statement": "endorse:phone@A", "by": "A", "member": "phone", "at": 1004000},
        },
        {"key": "audit:endorse:C@A", "rev": 9, "body": {"act": "member.endorse", "statement": "endorse:C@A", "by": "A", "member": "C", "at": 1004000}},
        {
          "key": "audit:endorse:phone@C",
          "rev": 10,
          "body": {"act": "statement.merge", "statement": "endorse:phone@C", "by": "C", "member": "phone", "at": 1004000},
        },
        {
          "key": "audit:revoke:B@A:g1",
          "rev": 11,
          "body": {"act": "server.revoke", "statement": "revoke:B@A:g1", "by": "A", "member": "B", "name": "Server B", "reason": "<500 chars>", "at": 1005000},
        },
        {
          "key": "audit:revoke:B@A:g1:cascade",
          "rev": 12,
          "body": {"act": "server.revoke", "statement": "revoke:B@A:g1:cascade", "by": "A", "member": "B", "name": "Server B", "at": 1006000},
        },
      ],
      "meta": [{"key": "clusterId", "value": "cluster"}],
      "changes": [
        {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": [], "valid": ["A", "B", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["B"], "valid": ["A", "C", "phone"], "rootGen": 1, "dropped": 0},
        {"invalidated": ["C", "phone"], "valid": ["A"], "rootGen": 1, "dropped": 0},
      ],
      "view": {
        "cluster": "cluster",
        "root": {"id": "root:g1", "gen": 1, "root": "A", "recoveryPub": "R1.pub", "keep": []},
        "servers": ["A", "B", "C"],
        "valid": ["A"],
        "revoked": ["B", "C", "phone"],
        "members": [
          {"member": "A", "kind": "server", "name": "Server A", "addId": "add:A@B", "by": "B", "at": 1001000},
          {"member": "B", "kind": "server", "name": "Server B", "addId": "add:B@A", "by": "A", "at": 1001000},
          {"member": "C", "kind": "server", "name": "Server C", "addId": "add:C@B", "by": "B", "at": 1002000},
          {
            "member": "phone",
            "kind": "device",
            "name": "Phone",
            "addId": "add:phone@B",
            "by": "B",
            "at": 1003000,
            "scope": ["read", "reply", "approve"],
          },
        ],
        "countingRevokes": ["revoke:B@A:g1", "revoke:B@A:g1:cascade"],
        "dropped": [],
      },
    },
  },
  "revokedServer": {
    "addDevice": {"reason": "self-revoked", "message": "this server was removed from the cluster"},
    "addServer": {"reason": "self-revoked", "message": "this server was removed from the cluster"},
    "revokeDevice": {"reason": "self-revoked", "message": "this server was removed from the cluster"},
    "merge": {"reason": "self-revoked", "message": "this server was removed from the cluster"},
    "writeProfile": {"reason": "self-revoked", "message": "this server was removed from the cluster"},
    "replaceRecovery": {"reason": "self-revoked", "message": "this server was removed from the cluster"},
  },
  "revokedServer.changes": {"changes": [{"invalidated": ["A", "B", "C", "phone"], "valid": [], "rootGen": 1, "dropped": 0}], "valid": []},
  "serial.changes": {
    "changes": [
      {"invalidated": [], "valid": ["A"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "p1"], "rootGen": 1, "dropped": 0},
      {"invalidated": [], "valid": ["A", "p1", "p2"], "rootGen": 1, "dropped": 0},
      {"invalidated": ["p1"], "valid": ["A", "p2"], "rootGen": 1, "dropped": 0},
    ],
    "audit": ["cluster.create", "device.add", "device.add", "device.revoke"],
  },
};
// </golden>
