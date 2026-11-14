// Botling 3 M3 step 4 security review (step-4-join.md, "Review"): server pairing in one process, two real
// RosterStores and two ServerJoins joined by an in-memory transport (no listener, no window).
// - J1: a join offer's 5 minutes hold for a session that is already open: a code or a welcome that arrives after the
//   offer expired is declined, and the offer (secret and code) is forgotten when its time is up, busy or not.
// - J2: the link can come on stdin, so its one-time secret need not be on botlingd's command line (process list).
// - J3: two first server pairings at once make one cluster VAPID key, not two.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { JOIN_OFFER_TTL_MS, type AdminEvent, type AdminOp } from "../../src/protocol";
import { bindServerIdentity, ClusterSetup, ensureVapidKeys, loadOrCreateServerIdentity, readVapidKeys } from "../../src/server/identity";
import { addMachineCommand, ServerJoin, type AdminClient } from "../../src/server/pairing";
import type { PeerConnection, PeerConnector } from "../../src/server/peer/connector";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import type { SessionTransport } from "../../src/session";
import { testRoot } from "../botlingd-harness";
import { until } from "../helpers";

const root = testRoot("join-review");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const open: ServerStore[] = [];
const joins: ServerJoin[] = [];
afterEach(async () => {
  for (const j of joins.splice(0)) j.close();
  for (const store of open.splice(0)) await store.close();
});
let n = 0;

async function server(withCluster: boolean) {
  const dir = join(root, `d${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  open.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity);
  if (withCluster) {
    const setup = new ClusterSetup(roster);
    const started = await setup.begin();
    expect((await setup.confirm(started.code)).ok).toBe(true);
  }
  return { dir, identity, roster };
}

/** S dials N in memory: frames are handed over on a later tick, as a socket would. */
function memoryConnector(n: ServerJoin): PeerConnector {
  return {
    async connect(): Promise<PeerConnection> {
      let toS: { frame(frame: Uint8Array): void; closed(): void } | null = null;
      const early: Uint8Array[] = [];
      let closed = false;
      let acceptor: ReturnType<ServerJoin["accept"]> | null = null;
      const shut = () => {
        if (closed) return;
        closed = true;
        setImmediate(() => { acceptor?.transportClosed(); toS?.closed(); });
      };
      const nSide: SessionTransport = {
        send: (frame) => { if (!closed) setImmediate(() => { if (toS) toS.frame(frame); else early.push(frame); }); },
        close: shut,
      };
      return {
        send: (frame) => {
          if (closed) return;
          setImmediate(() => { acceptor ??= n.accept(nSide); acceptor.receive(frame); });
        },
        close: shut,
        bind: (events) => { toS = events; for (const frame of early.splice(0)) events.frame(frame); },
      };
    },
  };
}

async function pairUp(nNow: () => number, sNow?: () => number) {
  const s = await server(true);
  const nn = await server(false);
  const nJoin = new ServerJoin({
    roster: nn.roster, identity: nn.identity, serverName: "N", version: "3.0.0", dataDir: nn.dir, now: nNow,
    ownAddresses: () => null, joinAddresses: () => ["ws://127.0.0.1:9/v3/ws"],
  });
  const sJoin = new ServerJoin({
    roster: s.roster, identity: s.identity, serverName: "S", version: "3.0.0", dataDir: s.dir, ...(sNow ? { now: sNow } : {}),
    ownAddresses: () => null, joinAddresses: () => [], connector: memoryConnector(nJoin), replyTimeoutMs: 5_000,
  });
  joins.push(nJoin, sJoin);
  return { s, nn, nJoin, sJoin };
}

describe("J1: a join offer's time holds for an open session", () => {
  it("a right code typed after the offer expired is declined, and N joins nothing", async () => {
    let clock = Date.now();
    const { nn, nJoin, sJoin } = await pairUp(() => clock);
    const offer = nJoin.createOffer();
    const added = await sJoin.addMachine(offer.link);
    expect(added.server).toBe(nn.identity.memberId);
    clock = offer.expiresAt + 1;
    const result = await sJoin.code(added.attempt, offer.code);
    expect(result).toMatchObject({ ok: false, reason: "expired" });
    expect(nn.roster.clusterId).toBeNull();
    expect(nJoin.isOffer(offer.offer)).toBe(false);
  });

  it("a wrong code after the offer expired costs nothing and ends the offer", async () => {
    let clock = Date.now();
    const { nJoin, sJoin } = await pairUp(() => clock);
    const events: AdminEvent[] = [];
    nJoin.onEvent((event) => events.push(event));
    const offer = nJoin.createOffer();
    const added = await sJoin.addMachine(offer.link);
    clock = offer.expiresAt + 1;
    const result = await sJoin.code(added.attempt, offer.code === "0000-0000" ? "1111-1111" : "0000-0000");
    expect(result).toMatchObject({ ok: false, reason: "expired" });
    expect(events.some((event) => event.kind === "join.wrong")).toBe(false);
    expect(events.find((event) => event.kind === "join.declined")).toMatchObject({ reason: "expired" });
  });

  it("an offer held by an open session is still forgotten when its time is up", async () => {
    // Only setTimeout is faked (and moves with real time), so the offer's expiry timer can be jumped to. S's clock lies
    // far back, so its own attempt timer (which would close the session) does not fire: the session stays open, as an
    // intruder holding the link's secret would keep it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      let shift = 0;
      const { nJoin, sJoin } = await pairUp(() => Date.now() + shift, () => Date.now() - 10 * JOIN_OFFER_TTL_MS);
      const offer = nJoin.createOffer();
      await sJoin.addMachine(offer.link);
      expect(nJoin.isOffer(offer.offer)).toBe(true);
      shift = JOIN_OFFER_TTL_MS + 100;
      vi.advanceTimersByTime(JOIN_OFFER_TTL_MS + 100);
      await until(() => !nJoin.isOffer(offer.offer), { timeout: 3_000, what: "the busy offer to be forgotten at its time" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("J2: the join link need not be on the command line", () => {
  it("add-machine with no link argument reads the link from stdin", async () => {
    const asked: string[] = [];
    const requests: AdminOp[] = [];
    const answers = ["botling-join:the-link", null];
    const client = {
      closed: false,
      request: async (op: AdminOp) => {
        requests.push(op);
        if (op.op === "cluster.status") return { clusterId: "c".repeat(32) };
        if (op.op === "machine.add") throw new Error("bad-link: test");
        return null;
      },
      nextEvent: async () => null,
    } as unknown as AdminClient;
    const io = { out: () => undefined, ask: async (prompt: string) => { asked.push(prompt); return answers.shift() ?? null; } };
    const code = await addMachineCommand(client, io, undefined);
    expect(code).toBe(1);
    expect(asked[0]).toMatch(/link/i);
    expect(requests.find((op) => op.op === "machine.add")).toMatchObject({ link: "botling-join:the-link" });
  });
});

describe("J3: one cluster VAPID key", () => {
  it("two first pairings at once make the same key pair", async () => {
    const dir = join(root, `v${++n}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const [a, b] = await Promise.all([ensureVapidKeys(dir), ensureVapidKeys(dir)]);
    expect(a.keys).toEqual(b.keys);
    expect(readVapidKeys(dir)).toEqual(a.keys);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });
});
