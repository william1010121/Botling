// Botling 3 M3 step 13 (m3-brief §4 row 13): `botlingd machines`, the peer part of `botlingd status` and its two Doctor
// notes, from a data folder alone (src/server/machines.ts). One server.db made by the real store; roster statements
// signed by test keys; peer states from a running-registry file (botlingd.peers.json) or from the stored copies; clock
// injected for the one-hour notes.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memberFingerprint } from "../../src/protocol";
import { FORWARD_OLD_NOTE_MS, machinesLines, PEER_STALE_NOTE_MS, PEERS_STATE_FILE, peerNotes, readForwardQueue, readMachines } from "../../src/server/machines";
import { PEERS_FILE } from "../../src/server/botlingd";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
import { tempDir } from "../helpers";
import { makeCluster, strangerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];
const open: Array<{ store: ServerStore; reader: Db }> = [];

afterEach(async () => {
  for (const { store, reader } of open.splice(0)) { reader.close(); await store.close().catch(() => undefined); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data folder whose server.db is server `self` of a cluster with `others` (Adds with names "server <4 chars>"). */
async function folder(): Promise<{ dir: string; store: ServerStore; reader: Db; self: MemberKeysInfo; b: MemberKeysInfo; c: MemberKeysInfo }> {
  const dir = tempDir("machines");
  dirs.push(dir);
  const [self, b, c] = await Promise.all([strangerKeys(), strangerKeys(), strangerKeys()]);
  const store = await openServerStore(dir);
  await store.submit((tx) => { tx.prepare("INSERT INTO meta (key, value) VALUES ('serverId', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(self.memberId); });
  const cluster = await makeCluster([self, b, c]);
  writeStatements(dir, cluster.clusterId, cluster.statements);
  const reader = store.openReader();
  open.push({ store, reader });
  return { dir, store, reader, self, b, c };
}

const nameOf = (keys: MemberKeysInfo) => `server ${keys.memberId.slice(0, 4)}`;

function peerCopy(store: ServerStore, peer: string, state: string, heardAt: number | null): Promise<void> {
  return store.submit((tx) => {
    tx.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 0, NULL, ?, ?)").run(`srv:${peer}`, peer, "a".repeat(32), state, heardAt);
  });
}

function held(store: ServerStore, owner: string, n: number, heldAt: number): Promise<void> {
  return store.submit((tx) => {
    tx.prepare("INSERT INTO forwardq (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt) VALUES ('phone', ?, ?, ?, ?, 'h', '{}', ?)").run("e".repeat(32), `bot:${owner.slice(0, 6)}`, n, owner, heldAt);
  });
}

describe("M3 step 13: machines, status and Doctor notes from a data folder", () => {
  it("lists every server an Add names (not this one) with its fingerprint; stored states when botlingd does not run", async () => {
    const { dir, store, reader, self, b, c } = await folder();
    await peerCopy(store, b.memberId, "live", NOW - 5_000); // a killed server left `live`: nothing is live while it is down
    await peerCopy(store, c.memberId, "gone", NOW - 9_000);
    const report = readMachines(dir, reader, null);
    expect(report.self).toEqual({ member: self.memberId, name: nameOf(self), fingerprint: memberFingerprint(self.memberId) });
    const expected = [
      { member: b.memberId, name: nameOf(b), fingerprint: memberFingerprint(b.memberId), state: "stale", since: NOW - 5_000, from: "stored" },
      { member: c.memberId, name: nameOf(c), fingerprint: memberFingerprint(c.memberId), state: "gone", since: NOW - 9_000, from: "stored" },
    ].sort((x, y) => (x.member < y.member ? -1 : 1));
    expect(report.peers).toEqual(expected);
    expect(PEERS_STATE_FILE).toBe(PEERS_FILE);
  });

  it("while botlingd runs, the registry file of that pid gives state and since; a file of another pid is ignored", async () => {
    const { dir, store, reader, b, c } = await folder();
    await peerCopy(store, c.memberId, "stale", NOW - 3 * HOUR);
    writeFileSync(join(dir, PEERS_STATE_FILE), JSON.stringify({ pid: 4242, peers: [
      { member: b.memberId, name: "ignored", state: "live", since: NOW - 1_000 },
      { member: c.memberId, name: "ignored", state: "stale", since: null },
    ] }));
    const running = readMachines(dir, reader, 4242);
    const byMember = new Map(running.peers.map((peer) => [peer.member, peer]));
    expect(byMember.get(b.memberId)).toMatchObject({ state: "live", since: NOW - 1_000, from: "running", name: nameOf(b) });
    // No session yet in this run (since null): when it was last heard comes from the stored copy.
    expect(byMember.get(c.memberId)).toMatchObject({ state: "stale", since: NOW - 3 * HOUR, from: "running" });
    const other = readMachines(dir, reader, 4243);
    expect(other.peers.every((peer) => peer.from === "stored")).toBe(true);
    const lines = machinesLines(running, readForwardQueue(reader));
    expect(lines[0]).toMatch(/^this machine "server \w{4}": [A-Z0-9 ]+$/);
    expect(lines.some((line) => line.includes(`"${nameOf(b)}" ${memberFingerprint(b.memberId)}: live since `))).toBe(true);
  });

  it("forward queue length and oldest row per owner; Doctor notes a peer stale over an hour and a row held over an hour", async () => {
    const { dir, store, reader, b, c } = await folder();
    await peerCopy(store, b.memberId, "stale", NOW - PEER_STALE_NOTE_MS - 1);
    await peerCopy(store, c.memberId, "stale", NOW - PEER_STALE_NOTE_MS + 60_000);
    await held(store, b.memberId, 1, NOW - FORWARD_OLD_NOTE_MS - 1);
    await held(store, b.memberId, 2, NOW - 10_000);
    await held(store, c.memberId, 1, NOW - 30_000);
    const queue = readForwardQueue(reader);
    expect(queue).toEqual({
      rows: 3, cancels: 0, oldestHeldAt: NOW - FORWARD_OLD_NOTE_MS - 1,
      owners: [{ owner: b.memberId, rows: 2, oldestHeldAt: NOW - FORWARD_OLD_NOTE_MS - 1 }, { owner: c.memberId, rows: 1, oldestHeldAt: NOW - 30_000 }].sort((x, y) => (x.owner < y.owner ? -1 : 1)),
    });
    const machines = readMachines(dir, reader, null);
    const notes = peerNotes(machines, queue, NOW);
    expect(notes.map((note) => note.id)).toEqual(["peer-stale", "forward-queue-old"]);
    expect(notes[0].text).toContain(`"${nameOf(b)}" (${memberFingerprint(b.memberId)})`);
    expect(notes[1].text).toMatch(new RegExp(`^2 commands for machine "${nameOf(b)}" have been held since `));
    // Just under the hour: no note. Gone peers and peers never heard from: no stale note.
    expect(peerNotes(machines, queue, NOW - 2)).toEqual([]);
    expect(peerNotes({ self: null, peers: [{ ...machines.peers[0], state: "gone" }, { ...machines.peers[1], since: null }] }, { rows: 0, cancels: 0, oldestHeldAt: null, owners: [] }, NOW + 10 * HOUR)).toEqual([]);
  });

  it("a lone server: no peers, an empty queue, no notes; no server.db: nothing listed", async () => {
    const dir = tempDir("machines-lone");
    dirs.push(dir);
    expect(readMachines(dir, null, null)).toEqual({ self: null, peers: [] });
    const store = await openServerStore(dir);
    const reader = store.openReader();
    open.push({ store, reader });
    const report = readMachines(dir, reader, null);
    expect(report.peers).toEqual([]);
    expect(readForwardQueue(reader)).toEqual({ rows: 0, cancels: 0, oldestHeldAt: null, owners: [] });
    expect(peerNotes(report, readForwardQueue(reader), NOW)).toEqual([]);
    expect(machinesLines(report, null).at(-1)).toMatch(/^no other machines/);
  });
});
