// M7-S92: pins the reroot preview, the reroot, the recovery-code replace and the offer / pairing-session lifecycle of
// `PairingService` (desktop/src/server/pairing/service.ts) with a fake roster, before that half moves to service-recovery.ts.
// No server, no socket, no window: only the service and plain objects.
import { describe, expect, it, vi } from "vitest";
import { toBase64Url, type AdminEvent, type Message } from "../../src/protocol";
import type { SessionInfo } from "../../src/session";
import { RosterError, type RosterRefusal } from "../../src/server/roster/store";
import { PairingError, PairingService, type PairingOptions } from "../../src/server/pairing/service";

const ME = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_ROOT = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVER_C = "cccccccccccccccccccccccccc";
const DEV_D = "dddddddddddddddddddddddddd";
const DEV_E = "eeeeeeeeeeeeeeeeeeeeeeeeee";
const DEV_F = "ffffffffffffffffffffffffff";
const CLUSTER = "0123456789abcdef0123456789abcdef";
const KEY = toBase64Url(new Uint8Array(32).fill(7));

type Body = { type: string; member?: string; by?: string; kind?: "server" | "device"; name?: string; at?: number; joined?: boolean };

interface FakeRoster {
  clusterId: string | null;
  memberId: string;
  view: {
    cluster: string | null;
    root: { root: string } | null;
    members: Map<string, { member: string; kind: "server" | "device"; name: string; at: number; by: string; scope?: string[] }>;
    valid: Set<string>;
    revoked: Set<string>;
    servers: Set<string>;
  };
  names: Map<string, string>;
  bodies: Body[];
  candidates: Array<{ revokeId: string; member: string; signer: string; gen: number; receivedAt?: number }>;
  rerootImpl: (input: { code: string; oldRootLost: boolean; keep: string[] }) => Promise<{ rootId: string; revokeId: string | null; gen: number }>;
  confirmImpl: (code: string) => Promise<{ ok: true; gen: number } | { ok: false; reason: string }>;
  cancelled: number;
  keepCandidates(): FakeRoster["candidates"];
  statements(): Array<{ id: string; statement: { body: Body } }>;
  profile(member: string, field: string): string | null;
  reroot(input: { code: string; oldRootLost: boolean; keep: string[] }): Promise<{ rootId: string; revokeId: string | null; gen: number }>;
  confirmRecovery(code: string): Promise<{ ok: true; gen: number } | { ok: false; reason: string }>;
  replaceRecovery(code: string): Promise<{ clusterId: string }>;
  cancelRecoveryReplace(): void;
}

function fakeRoster(): FakeRoster {
  const roster: FakeRoster = {
    clusterId: CLUSTER,
    memberId: ME,
    view: {
      cluster: CLUSTER,
      root: { root: OLD_ROOT },
      members: new Map([
        [OLD_ROOT, { member: OLD_ROOT, kind: "server", name: "Old root", at: 1, by: OLD_ROOT }],
        [ME, { member: ME, kind: "server", name: "Me (members)", at: 2, by: OLD_ROOT }],
        [SERVER_C, { member: SERVER_C, kind: "server", name: "Server C", at: 3, by: OLD_ROOT }],
        [DEV_D, { member: DEV_D, kind: "device", name: "Phone D", at: 4, by: OLD_ROOT }],
        [DEV_E, { member: DEV_E, kind: "device", name: "Phone E", at: 5, by: OLD_ROOT }],
      ]),
      valid: new Set([OLD_ROOT, ME, SERVER_C, DEV_D, DEV_E]),
      revoked: new Set(),
      servers: new Set([OLD_ROOT, ME, SERVER_C]),
    },
    names: new Map(),
    bodies: [],
    candidates: [],
    rerootImpl: async () => ({ rootId: "root-id", revokeId: null, gen: 2 }),
    confirmImpl: async () => ({ ok: true, gen: 3 }),
    cancelled: 0,
    keepCandidates: () => roster.candidates,
    statements: () => roster.bodies.map((body, i) => ({ id: `s${i}`, statement: { body } })),
    profile: (member, field) => (field === "name" ? roster.names.get(member) ?? null : null),
    reroot: (input) => roster.rerootImpl(input),
    confirmRecovery: (code) => roster.confirmImpl(code),
    replaceRecovery: async () => ({ clusterId: CLUSTER }),
    cancelRecoveryReplace: () => { roster.cancelled += 1; },
  };
  return roster;
}

function make(roster = fakeRoster(), extra: Partial<PairingOptions> = {}) {
  const logs: string[] = [];
  let clock = 1_000_000;
  const service = new PairingService({
    roster: roster as never,
    cluster: {} as never,
    identity: { memberId: ME, keys: { sign: KEY, dh: KEY } },
    serverName: "Test server",
    addresses: () => ({ tailnet: "https://tailnet-name.invalid" }),
    pageUrl: () => "https://tailnet-name.invalid/v3/",
    log: (line) => logs.push(line),
    now: () => clock,
    ...extra,
  });
  const events: AdminEvent[] = [];
  service.onEvent((event) => events.push(event));
  return { service, roster, logs, events, advance: (ms: number) => { clock += ms; } };
}

function fakeLink() {
  const sent: Message[] = [];
  let ended = 0;
  return { link: { send: (message: Message) => { sent.push(message); return true; }, end: () => { ended += 1; } }, sent, ended: () => ended };
}

const info = (offer: string): SessionInfo => ({ offer } as unknown as SessionInfo);

describe("PairingService reroot preview", () => {
  it("refuses before a cluster exists", () => {
    const { service, roster } = make();
    roster.view.root = null;
    expect(() => service.rerootPreview()).toThrowError(expect.objectContaining({ code: "no-cluster" }));
    roster.view.root = { root: OLD_ROOT };
    roster.clusterId = null;
    expect(() => service.rerootPreview()).toThrow(PairingError);
  });

  it("says isRoot when this server already is the root", () => {
    const { service, roster } = make();
    roster.view.root = { root: ME };
    roster.names.set(ME, "Profile name");
    expect(service.rerootPreview()).toEqual({ isRoot: true, selfMember: ME, selfName: "Profile name" });
  });

  it("names the old root and sorts the keep candidates by receivedAt, then revoke id", () => {
    const { service, roster } = make();
    roster.names.set(OLD_ROOT, "Profile old root");
    roster.candidates = [
      { revokeId: "r3", member: DEV_D, signer: OLD_ROOT, gen: 1, receivedAt: 30 },
      { revokeId: "r2", member: SERVER_C, signer: OLD_ROOT, gen: 1, receivedAt: 10 },
      { revokeId: "r1", member: "zzzzzzzzzzzzzzzzzzzzzzzzzz", signer: "yyyyyyyyyyyyyyyyyyyyyyyyyy", gen: 2 },
      { revokeId: "r0", member: DEV_E, signer: OLD_ROOT, gen: 1, receivedAt: 10 },
    ];
    const preview = service.rerootPreview();
    expect(preview).toMatchObject({ isRoot: false, selfMember: ME, selfName: "Me (members)", oldRootMember: OLD_ROOT, oldRootName: "Profile old root" });
    if (preview.isRoot) throw new Error("expected a non-root preview");
    expect(preview.keepCandidates.map((c) => c.revokeId)).toEqual(["r1", "r0", "r2", "r3"]);
    expect(preview.keepCandidates[0]).toEqual({
      revokeId: "r1", member: "zzzzzzzzzzzzzzzzzzzzzzzzzz", memberName: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
      signer: "yyyyyyyyyyyyyyyyyyyyyyyyyy", signerName: "yyyyyyyyyyyyyyyyyyyyyyyyyy", gen: 2, receivedAt: undefined,
    });
    expect(preview.keepCandidates[1]).toMatchObject({ memberName: "Phone E", signerName: "Profile old root" });
  });

  it("goes through the admin op too", async () => {
    const { service, roster } = make();
    roster.view.root = { root: ME };
    await expect(service.admin({ op: "roster.rerootPreview" } as never)).resolves.toMatchObject({ isRoot: true });
  });
});

describe("PairingService reroot", () => {
  const add = (member: string, by: string, at: number, extra: Partial<Body> = {}): Body => ({ type: "add", member, by, at, kind: "device", name: `add ${member.slice(0, 1)}`, ...extra });

  it("returns the members the old root added, newest first, and logs no code", async () => {
    const { service, roster, logs } = make();
    roster.names.set(SERVER_C, "Profile C");
    roster.bodies = [
      add(DEV_D, OLD_ROOT, 10),
      add(DEV_D, OLD_ROOT, 20, { name: "ignored: info name wins" }),
      add(SERVER_C, OLD_ROOT, 15, { kind: "server" }),
      add(DEV_E, OLD_ROOT, 15),
      add(OLD_ROOT, OLD_ROOT, 1, { kind: "server" }),
      add(ME, OLD_ROOT, 2, { kind: "server" }),
      add(DEV_F, OLD_ROOT, 9),
      add("gggggggggggggggggggggggggg", "hhhhhhhhhhhhhhhhhhhhhhhhhh", 99),
      add(DEV_E, OLD_ROOT, 99, { joined: false }),
      { type: "revoke", member: DEV_D, by: OLD_ROOT, at: 50 },
    ];
    const seen: Array<{ code: string; oldRootLost: boolean; keep: string[] }> = [];
    roster.rerootImpl = async (input) => { seen.push(input); return { rootId: "rid", revokeId: "rev", gen: 4 }; };
    const result = await service.reroot("SECRET-CODE", true, ["r1", "r2"]);
    expect(seen).toEqual([{ code: "SECRET-CODE", oldRootLost: true, keep: ["r1", "r2"] }]);
    expect(result).toEqual({
      ok: true, rootId: "rid", revokeId: "rev", gen: 4,
      oldRootAdded: [
        { member: DEV_D, kind: "device", name: "Phone D", at: 20 },
        { member: SERVER_C, kind: "server", name: "Profile C", at: 15 },
        { member: DEV_E, kind: "device", name: "Phone E", at: 15 },
      ],
    });
    expect(logs).toContain("pairing: rerooted to this server (gen 4, oldRootLost=true, keep=2)");
    expect(logs.join("\n")).not.toContain("SECRET-CODE");
  });

  it("returns an empty oldRootAdded when the old root is not lost", async () => {
    const { service, roster } = make();
    roster.bodies = [add(DEV_D, OLD_ROOT, 10)];
    await expect(service.reroot("c", false, [])).resolves.toMatchObject({ ok: true, oldRootAdded: [] });
  });

  it("turns a bad code into ok:false and maps the roster's refusals", async () => {
    const { service, roster, logs } = make();
    const refuse = (reason: RosterRefusal) => { roster.rerootImpl = async () => { throw new RosterError(reason, `refused ${reason}`); }; };
    refuse("bad-code");
    await expect(service.reroot("c", true, [])).resolves.toEqual({ ok: false, reason: "bad-code" });
    expect(logs).toContain("pairing: reroot refused (bad-code)");
    for (const reason of ["no-cluster", "already-root", "bad-keep"] as const) {
      refuse(reason);
      await expect(service.reroot("c", true, [])).rejects.toMatchObject({ name: "PairingError", code: reason, message: `refused ${reason}` });
    }
    refuse("not-root");
    await expect(service.reroot("c", true, [])).rejects.toBeInstanceOf(RosterError);
    roster.rerootImpl = async () => { throw new Error("disk"); };
    await expect(service.reroot("c", true, [])).rejects.toThrow("disk");
  });
});

describe("PairingService recovery replace", () => {
  it("clears the owner on a confirmed replace, so a later admin close cancels nothing", async () => {
    const { service, roster, logs } = make();
    const session = {};
    await service.beginRecoveryReplace("old", session);
    await expect(service.confirmRecoveryReplace("new-code")).resolves.toEqual({ ok: true, gen: 3 });
    expect(logs).toContain("pairing: recovery code replaced (Root gen 3)");
    service.adminClosed(session);
    expect(roster.cancelled).toBe(0);
  });

  it("keeps the owner after a typo (malformed / wrong-code) and cancels when its session closes", async () => {
    const { service, roster, logs } = make();
    const session = {};
    await service.beginRecoveryReplace("old", session);
    for (const reason of ["malformed", "wrong-code"]) {
      roster.confirmImpl = async () => ({ ok: false, reason });
      await expect(service.confirmRecoveryReplace("x")).resolves.toEqual({ ok: false, reason });
      expect(logs).toContain(`pairing: new recovery code not confirmed (${reason})`);
    }
    service.adminClosed(session);
    expect(roster.cancelled).toBe(1);
  });

  it("drops the owner on any other refusal result", async () => {
    const { service, roster } = make();
    const session = {};
    await service.beginRecoveryReplace("old", session);
    roster.confirmImpl = async () => ({ ok: false, reason: "expired" });
    await service.confirmRecoveryReplace("x");
    service.adminClosed(session);
    expect(roster.cancelled).toBe(0);
  });

  it("maps the roster's refusals and rethrows the rest", async () => {
    const { service, roster } = make();
    for (const reason of ["bad-keep", "self-revoked"] as const) {
      roster.confirmImpl = async () => { throw new RosterError(reason, `refused ${reason}`); };
      await expect(service.confirmRecoveryReplace("x")).rejects.toMatchObject({ name: "PairingError", code: reason });
    }
    roster.confirmImpl = async () => { throw new RosterError("not-root", "nope"); };
    await expect(service.confirmRecoveryReplace("x")).rejects.toBeInstanceOf(RosterError);
  });

  it("the admin ops reach it, and recovery.cancel clears the owner", async () => {
    const { service, roster } = make();
    const session = {};
    await service.admin({ op: "recovery.replace", code: "old" } as never, session);
    await expect(service.admin({ op: "recovery.confirm", code: "new" } as never)).resolves.toEqual({ ok: true, gen: 3 });
    await service.admin({ op: "recovery.replace", code: "old" } as never, session);
    await service.admin({ op: "recovery.cancel" } as never);
    expect(roster.cancelled).toBe(1);
    service.adminClosed(session);
    expect(roster.cancelled).toBe(1);
  });

  it("close() clears the owner and cancels the pending replace", async () => {
    const { service, roster } = make();
    const session = {};
    await service.beginRecoveryReplace("old", session);
    service.close();
    expect(roster.cancelled).toBe(1);
    service.adminClosed(session);
    expect(roster.cancelled).toBe(1);
  });
});

describe("PairingService offers and pairing sessions", () => {
  it("lists a pending offer, forgets it when it expires, and keeps its secret only while it is pending", () => {
    const { service, advance } = make();
    const made = service.createOffer({ name: "Phone" });
    expect(service.pending()).toEqual([{ offer: made.offer, state: "open", expiresAt: made.expiresAt }]);
    expect(service.offerSecret(made.offer)).toBeInstanceOf(Uint8Array);
    expect(service.relayOffers()).toHaveLength(1);
    advance(10 * 60_000);
    expect(service.offerSecret(made.offer)).toBeNull();
    expect(service.pending()).toEqual([]);
  });

  it("close() burns every offer (told as cancelled) and refuses later sessions", () => {
    const { service, events } = make();
    const a = service.createOffer();
    const b = service.createOffer();
    let changed = 0;
    service.onOffersChanged(() => { changed += 1; });
    service.close();
    expect(service.pending()).toEqual([]);
    expect(events.filter((e) => e.kind === "pair.declined")).toEqual(expect.arrayContaining([
      { kind: "pair.declined", offer: a.offer, reason: "cancelled" },
      { kind: "pair.declined", offer: b.offer, reason: "cancelled" },
    ]));
    expect(changed).toBe(2);
    const late = fakeLink();
    service.open(info(a.offer), late.link);
    return Promise.resolve().then(() => { expect(late.ended()).toBe(1); });
  });

  it("an unknown offer is declined as expired", () => {
    const { service } = make();
    const first = fakeLink();
    service.open(info("nope"), first.link);
    expect(first.sent).toEqual([{ t: "pair.declined", reason: "expired" }]);
    expect(first.ended()).toBe(1);
  });

  it("a second session on a held offer is told busy", () => {
    const { service } = make();
    const made = service.createOffer();
    const a = fakeLink();
    const b = fakeLink();
    const sessionA = service.open(info(made.offer), a.link);
    service.open(info(made.offer), b.link);
    expect(b.sent).toEqual([{ t: "pair.declined", reason: "busy" }]);
    expect(service.pending()[0]!.state).toBe("hello");
    sessionA.closed();
    expect(service.pending()[0]!.state).toBe("open");
  });

  it("a message from a session without its offer drops the session; bye ends the link; a decline burns the offer", () => {
    const { service, logs, events } = make();
    const made = service.createOffer();
    const a = fakeLink();
    const session = service.open(info(made.offer), a.link);
    session.onMessage({ t: "bye" } as Message);
    expect(a.ended()).toBe(1);
    session.onMessage({ t: "ping" } as Message);
    session.onMessage({ t: "pair.declined", reason: "code" } as Message);
    expect(service.pending()).toEqual([]);
    expect(events).toContainEqual({ kind: "pair.declined", offer: made.offer, reason: "code" });
    expect(a.sent).toContainEqual({ t: "pair.declined", reason: "code" });
    session.onMessage({ t: "ping" } as Message);
    expect(logs.some((line) => line.includes("session ended (no offer)"))).toBe(true);
  });

  it("an unexpected message type ends the session", () => {
    const { service, logs } = make();
    const made = service.createOffer();
    const a = fakeLink();
    const session = service.open(info(made.offer), a.link);
    session.onMessage({ t: "hb" } as unknown as Message);
    expect(logs).toContain("pairing: session ended (hb is not part of a pairing)");
    expect(a.ended()).toBe(1);
  });

  it("a pair.ack before the Add is held drops the session; cancel() burns the offer", () => {
    const { service, logs } = make();
    const made = service.createOffer();
    const a = fakeLink();
    const session = service.open(info(made.offer), a.link);
    session.onMessage({ t: "pair.ack", addId: "x" } as unknown as Message);
    expect(logs).toContain("pairing: session ended (an ack for another Add)");
    expect(service.cancel(made.offer)).toEqual({ ok: true });
    expect(service.cancel(made.offer)).toEqual({ ok: false });
    expect(service.pending()).toEqual([]);
    const spy = vi.fn();
    service.onOffersChanged(spy);
    service.close();
    expect(spy).not.toHaveBeenCalled();
  });

  it("the hello timer ends a session that never says hello", () => {
    vi.useFakeTimers();
    try {
      const { service, logs } = make(undefined, { helloTimeoutMs: 50 });
      const made = service.createOffer();
      const a = fakeLink();
      service.open(info(made.offer), a.link);
      vi.advanceTimersByTime(60);
      expect(logs).toContain("pairing: session ended (no pair.hello in time)");
      expect(a.ended()).toBe(1);
      expect(service.pending()[0]!.state).toBe("open");
    } finally { vi.useRealTimers(); }
  });
});
