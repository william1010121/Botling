// Property tests of roster validity (src/server/roster/validity.ts, protocol v1 §4.2, §4.8, D46, D48). They stand in
// for the TLA `Roster` gate (device pairing), which is skipped in M2 (the user waived TLA; .bot/artifacts/v3-m2/gates.md).
//
// Random statement sets over 4 servers (the evaluating one first), 5 devices, the cluster's recovery key and a foreign
// one: Roots of gens 1–3 (forks of one gen, foreign-key and device-key Roots), server and device Adds, Endorses, and
// Revokes with random signers, gens and cascades, some signed by devices, a few naming a device id as a server.
// Seeded (mulberry32), so a failure names the seed. Properties:
//  P1 validity is the same for any order of the same set, duplicates included;
//  P2 a revoked device is never valid as a device again, along every prefix of a random order; never valid at all
//     while its id is not named as a server;
//  P3 a Root signed by another recovery key (or a device key) changes nothing: dropping every such Root gives the same view;
//  P4 the current root is the chain from gen 1 where each gen picks the smallest id (same-gen Roots);
//  P5 devices' signatures never count for Add / Endorse / Revoke / Root: dropping every statement a device signed gives
//     the same view;
//  P6 single revocation root: a server is revoked only by a revoke from the current root at its gen, or one in keep
//     (directly, or by its computed cascade over joining Adds when `cascade: true`, D60/D61); the root itself is never revoked;
//  P7 with real Ed25519 signatures, verify + validity gives exactly the view of the same set computed from what each
//     statement's signer was; a tampered signature never counts.
import { describe, expect, it } from "vitest";
import { clusterIdFromRecoveryKey, memberIdFromKey, statementId, toBase64Url, type SignedStatement, type StatementBody } from "../../src/protocol";
import { newRecoveryCode, recoveryKeyFromCode } from "../../src/server/identity";
import { computeRoster, signStatement, signWith, validDevice, verifyStatements, type RosterView, type VerifiedStatement } from "../../src/server/roster";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Actor { id: string; pub: string; dh: string; sign: (bytes: Uint8Array) => Promise<Uint8Array> }
interface RecoveryActor { pub: string; cluster: string; sign: (bytes: Uint8Array) => Promise<Uint8Array> }

async function actor(): Promise<Actor> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const dh = new Uint8Array(32);
  crypto.getRandomValues(dh);
  return { id: await memberIdFromKey(raw), pub: toBase64Url(raw), dh: toBase64Url(dh), sign: signWith(pair.privateKey) };
}

async function recoveryActor(): Promise<RecoveryActor> {
  const key = await recoveryKeyFromCode(newRecoveryCode());
  return { pub: key.recoveryPub, cluster: await clusterIdFromRecoveryKey(key.publicKey), sign: signWith(key.privateKey) };
}

interface World { servers: Actor[]; devices: Actor[]; recovery: RecoveryActor; foreign: RecoveryActor }

let worldPromise: Promise<World> | null = null;
function world(): Promise<World> {
  worldPromise ??= (async () => ({
    servers: await Promise.all([0, 1, 2, 3].map(actor)),
    devices: await Promise.all([0, 1, 2, 3, 4].map(actor)),
    recovery: await recoveryActor(),
    foreign: await recoveryActor(),
  }))();
  return worldPromise;
}

/** One generated statement: its body, id and who signed it (a member, or a key used as the recovery key). */
interface Item { id: string; body: StatementBody; signer: Actor | null; recoverySigner: { pub: string; cluster: string; sign: Actor["sign"] } | null }

async function generate(seed: number, w: World): Promise<Item[]> {
  const random = mulberry32(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const chance = (p: number) => random() < p;
  const subset = <T,>(items: readonly T[], p: number) => items.filter(() => chance(p));
  const cluster = w.recovery.cluster;
  const members = [...w.servers, ...w.devices];
  const items: Item[] = [];
  const push = async (body: StatementBody, signer: Actor | null, recoverySigner: Item["recoverySigner"] = null) => {
    items.push({ id: await statementId(body), body, signer, recoverySigner });
  };
  const signerFor = (honest: number) => (chance(honest) ? pick(w.servers) : pick(w.devices));
  let at = 1;

  // Adds: servers adding servers and devices (mostly by servers, some by devices), a few naming a device id as server.
  for (let i = 0, count = 3 + Math.floor(random() * 8); i < count; i++) {
    const signer = signerFor(0.8);
    const target = chance(0.4) ? pick(w.servers.slice(1)) : pick(w.devices);
    const asServer = w.servers.includes(target) || chance(0.08);
    if (target.id === signer.id) continue;
    await push(asServer
      ? { type: "add", cluster, member: target.id, kind: "server", keys: { sign: target.pub, dh: target.dh }, name: "S", by: signer.id, at: at++, joined: chance(0.7) }
      : { type: "add", cluster, member: target.id, kind: "device", keys: { sign: target.pub, dh: target.dh }, name: "D", scope: ["read"], by: signer.id, at: at++ }, signer);
  }
  // Endorses of some of those Adds.
  for (const add of subset(items.filter((item) => item.body.type === "add"), 0.3)) {
    const signer = signerFor(0.8);
    await push({ type: "endorse", cluster, member: (add.body as { member: string }).member, addId: add.id, by: signer.id }, signer);
  }
  // Revokes: devices and servers, random signers, gens and cascades.
  for (let i = 0, count = Math.floor(random() * 6); i < count; i++) {
    const signer = signerFor(0.75);
    const member = pick(members.filter((m) => m.id !== signer.id));
    const cascade: boolean | [] = w.servers.includes(member) ? chance(0.5) : chance(0.5) ? false : [];
    await push({ type: "revoke", cluster, member: member.id, reason: "", by: signer.id, gen: 1 + Math.floor(random() * 3), cascade }, signer);
  }
  const revokeIds = items.filter((item) => item.body.type === "revoke").map((item) => item.id);
  // Roots: gen 1 by the cluster's key (sometimes two, a fork), a foreign gen 1, then gens 2–3 on random earlier
  // roots, some signed by the foreign key or a device key.
  const recovery = { pub: w.recovery.pub, cluster: w.recovery.cluster, sign: w.recovery.sign };
  const foreign = { pub: w.foreign.pub, cluster: w.foreign.cluster, sign: w.foreign.sign };
  const roots: Item[] = [];
  const pushRoot = async (body: StatementBody, by: Item["recoverySigner"]) => { await push(body, null, by); roots.push(items[items.length - 1]); };
  if (chance(0.9)) await pushRoot({ type: "root", cluster, gen: 1, root: w.servers[0].id, recoveryPub: recovery.pub, keep: [], prev: null }, recovery);
  if (chance(0.3)) await pushRoot({ type: "root", cluster, gen: 1, root: pick(w.servers).id, recoveryPub: recovery.pub, keep: [], prev: null }, recovery);
  if (chance(0.4)) await pushRoot({ type: "root", cluster, gen: 1, root: pick(w.servers).id, recoveryPub: foreign.pub, keep: [], prev: null }, foreign);
  for (let i = 0, count = Math.floor(random() * 4); i < count && roots.length; i++) {
    const prev = pick(roots);
    const gen = (prev.body as { gen: number }).gen + 1;
    if (gen > 3) continue;
    const kind = random();
    const device = pick(w.devices);
    const by = kind < 0.7 ? recovery : kind < 0.85 ? foreign : { pub: device.pub, cluster: "", sign: device.sign };
    await pushRoot({ type: "root", cluster, gen, root: pick(w.servers).id, recoveryPub: chance(0.8) ? recovery.pub : by.pub, keep: subset(revokeIds, 0.4).sort(), prev: prev.id }, by);
  }
  return items;
}

/**
 * Cascade(m) (D60, D61), written apart from validity.ts: every member reached from m along joining Adds (`joined` not
 * false) whose signer is a known server, never the current root.
 */
function joinCascade(verified: VerifiedStatement[], view: RosterView, member: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>([member]);
  const queue = [member];
  while (queue.length) {
    const by = queue.shift()!;
    for (const s of verified) {
      if (s.body.type !== "add" || s.body.by !== by || !view.servers.has(by) || s.body.joined === false) continue;
      const m = s.body.member;
      if (seen.has(m) || m === view.root?.root) continue;
      seen.add(m);
      out.add(m);
      queue.push(m);
    }
  }
  return out;
}

/**
 * The verified set as verify.ts must make it, from who signed each item: a member-signed statement verifies when its
 * signer's key is known (the evaluating server, or an Add naming it); a Root when its signing key is a recoveryPub some
 * Root of the set names.
 */
function verifiedFrom(items: Item[], self: string): VerifiedStatement[] {
  const named = new Set(items.flatMap((item) => (item.body.type === "add" ? [item.body.member] : [])));
  const rootPubs = new Set(items.flatMap((item) => (item.body.type === "root" ? [item.body.recoveryPub] : [])));
  return items.flatMap((item): VerifiedStatement[] => {
    if (item.body.type === "root") {
      const by = item.recoverySigner!;
      return rootPubs.has(by.pub) ? [{ id: item.id, body: item.body, signer: "recovery", recoveryKey: by.pub, recoveryKeyCluster: by.cluster }] : [];
    }
    const signer = item.signer!;
    return signer.id === self || named.has(signer.id) ? [{ id: item.id, body: item.body, signer: signer.id }] : [];
  });
}

/** A view as plain sorted data, for equality. */
function plain(view: RosterView) {
  const sorted = (set: ReadonlySet<string>) => [...set].sort();
  return {
    root: view.root ? { ...view.root, keep: sorted(view.root.keep) } : null,
    servers: sorted(view.servers), revoked: sorted(view.revoked), valid: sorted(view.valid),
    members: [...view.members.values()].sort((a, b) => (a.member < b.member ? -1 : 1)),
    countingRevokes: [...view.countingRevokes].sort(),
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 500 by default (well under a second); `ROSTER_RUNS=20000` for a long sweep. */
const RUNS = Number(process.env.ROSTER_RUNS) || 500;

describe("roster validity properties (stand-in for the skipped TLA Roster gate)", () => {
  it(`P1–P6 over ${RUNS} random statement sets`, async () => {
    const w = await world();
    const self = w.servers[0].id;
    const cluster = w.recovery.cluster;
    const deviceIds = new Set(w.devices.map((d) => d.id));
    const tally = { roots: 0, forks: 0, revokedDevices: 0, revokedServers: 0, validDevices: 0, dual: 0 };
    for (let seed = 1; seed <= RUNS; seed++) {
      const items = await generate(seed, w);
      const random = mulberry32(seed * 7919);
      const verified = verifiedFrom(items, self);
      const view = computeRoster(self, cluster, verified);
      const at = `seed ${seed}`;

      // P1: any order, duplicates collapse.
      for (let k = 0; k < 3; k++) {
        const again = computeRoster(self, cluster, shuffle([...verified, ...verified.slice(0, 3)], random));
        expect(plain(again), at).toEqual(plain(view));
      }

      // P2: along every prefix of a random order.
      const order = shuffle(items, random);
      const deviceRevokedAt = new Map<string, number>();
      for (let k = 1; k <= order.length; k++) {
        const prefix = verifiedFrom(order.slice(0, k), self);
        const step = computeRoster(self, cluster, prefix);
        for (const s of prefix) {
          if (s.body.type === "revoke" && step.servers.has(s.body.by) && deviceIds.has(s.body.member) && !deviceRevokedAt.has(s.body.member)) deviceRevokedAt.set(s.body.member, k);
        }
        for (const [device, since] of deviceRevokedAt) {
          if (since > k) continue;
          expect(validDevice(step, device), `${at}: device revoked at ${since} valid as a device at ${k}`).toBeNull();
          if (!step.servers.has(device)) expect(step.valid.has(device), `${at}: device revoked at ${since} valid at ${k}`).toBe(false);
        }
      }

      // P3: Roots not signed by the chain's key change nothing.
      // (Dropped copy by copy: one Root body may also come signed by the chain's key, and that copy stays.)
      const foreign = (s: VerifiedStatement) => s.body.type === "root" && s.recoveryKey !== w.recovery.pub;
      expect(plain(computeRoster(self, cluster, verified.filter((s) => !foreign(s)))), at).toEqual(plain(view));

      // P4: the chain, smallest id per gen.
      const roots = verified.filter((s) => s.body.type === "root") as Array<VerifiedStatement & { body: Extract<StatementBody, { type: "root" }> }>;
      let expected = roots.filter((s) => s.body.gen === 1 && s.recoveryKey === s.body.recoveryPub && s.recoveryKeyCluster === cluster).map((s) => s).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
      if (roots.filter((s) => s.body.gen === 1 && s.recoveryKey === w.recovery.pub).length > 1) tally.forks++;
      const chainRoots = new Map<number, string>();
      if (expected) chainRoots.set(1, expected.body.root);
      while (expected) {
        const head: typeof expected = expected;
        const next = roots.filter((s) => s.body.gen === head.body.gen + 1 && s.body.prev === head.id && s.recoveryKey === head.body.recoveryPub).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
        if (!next) break;
        expected = next;
        chainRoots.set(next.body.gen, next.body.root);
      }
      expect(view.root?.id ?? null, at).toBe(expected?.id ?? null);
      if (view.root) { tally.roots++; expect(view.root.recoveryPub === w.recovery.pub || roots.some((s) => s.body.recoveryPub === view.root!.recoveryPub), at).toBe(true); }

      // P5: devices' signatures never count.
      const bySigner = verified.filter((s) => !(s.signer !== "recovery" && deviceIds.has(s.signer) && !view.servers.has(s.signer)));
      expect(plain(computeRoster(self, cluster, bySigner)), at).toEqual(plain(view));
      for (const device of deviceIds) if (view.servers.has(device)) tally.dual++;

      // P6: single revocation root.
      for (const server of view.servers) {
        if (!view.revoked.has(server)) continue;
        tally.revokedServers++;
        expect(view.root, at).not.toBeNull();
        expect(server, at).not.toBe(view.root!.root);
        const sanctioned = verified.some((s) => s.body.type === "revoke"
          && (s.body.member === server || (view.servers.has(s.body.member) && s.body.cascade === true && joinCascade(verified, view, s.body.member).has(server)))
          && view.servers.has(s.body.member) && s.body.member !== view.root!.root
          && ((s.body.by === view.root!.root && s.body.gen === view.root!.gen) || (view.root!.keep.has(s.id) && s.body.gen < view.root!.gen && chainRoots.get(s.body.gen) === s.body.by)));
        expect(sanctioned, `${at}: server ${server} revoked without the root`).toBe(true);
      }
      for (const device of deviceIds) {
        if (view.revoked.has(device)) tally.revokedDevices++;
        if (validDevice(view, device)) tally.validDevices++;
      }
    }
    // The generator reaches the interesting cases.
    expect(tally.roots).toBeGreaterThan(RUNS / 2);
    expect(tally.forks).toBeGreaterThan(10);
    expect(tally.revokedDevices).toBeGreaterThan(20);
    expect(tally.revokedServers).toBeGreaterThan(5);
    expect(tally.validDevices).toBeGreaterThan(20);
    expect(tally.dual).toBeGreaterThan(0);
  }, 60_000);

  it("P7: with real signatures, verify + validity gives the same view; a tampered signature never counts", async () => {
    const w = await world();
    const self = w.servers[0];
    for (let seed = 1001; seed <= 1012; seed++) {
      const items = await generate(seed, w);
      const stored: Array<{ id: string; statement: SignedStatement }> = [];
      for (const item of items) {
        const signed = item.body.type === "root"
          ? await signStatement(item.body, "recovery", item.recoverySigner!.sign)
          : await signStatement(item.body, item.signer!.id, item.signer!.sign);
        expect(signed.id).toBe(item.id);
        stored.push(signed);
      }
      const real = await verifyStatements(stored, { memberId: self.id, signPub: self.pub });
      const expected = computeRoster(self.id, w.recovery.cluster, verifiedFrom(items, self.id));
      expect(plain(computeRoster(self.id, w.recovery.cluster, real)), `seed ${seed}`).toEqual(plain(expected));
      // Tamper every signature: nothing counts but the evaluating server itself.
      const tampered = stored.map(({ id, statement }) => ({ id, statement: { ...statement, sig: statement.sig.startsWith("A") ? `B${statement.sig.slice(1)}` : `A${statement.sig.slice(1)}` } }));
      const none = computeRoster(self.id, w.recovery.cluster, await verifyStatements(tampered, { memberId: self.id, signPub: self.pub }));
      expect(none.root, `seed ${seed}`).toBeNull();
      expect([...none.valid], `seed ${seed}`).toEqual([self.id]);
    }
  }, 60_000);
});
