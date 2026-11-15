// Botling 3 Settings › Phone, server side: the window's `mobile.*` requests are answered by botlingd's own pairing
// (src/server/pairing/phone-desk.ts over the v3 PairingService) and its relay setting, never by the 2.x core inside it.
// - the routes: the six phone commands are `local` (a req on this machine's socket, never a slot: a pairing link is a
//   secret and must never reach a log entry), the window adapter sends them as reads, a device is refused;
// - PhoneDesk: the first pairing makes the cluster (recovery code shown once, typed back), offers become the link the
//   QR shows, a `pair.code` event shows the 6-digit code to compare, the window accepts or rejects once, devices list
//   and revoke, the relay address is kept and switched;
// - botlingd itself (in process, a local relay): Settings › Phone turns the relay on live, pairs at the relay's page,
//   refuses the phone commands sent as slots, and turns the relay off again.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command, ContractError, type CommandType } from "../../src/contract";
import { READ_COMMANDS } from "../../src/main-v3/renderer-adapter";
import { commandScope, parsePairLink, type AdminEvent, type AdminOp, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { remoteReadRefusal } from "../../src/server/session/remote-reads";
import { servedAsReq } from "../../src/server/session/session-core";
import { COMMAND_ROUTES } from "../../src/server/intents";
import { Botlingd } from "../../src/server/botlingd";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { changeRelaySetting, RELAY_SETTING_FILE, RelaySettingError } from "../../src/server/net/relay-setting";
import { PairingService } from "../../src/server/pairing";
import { PHONE_COMMANDS, PhoneDesk, type PhonePairing, type PhoneRelay } from "../../src/server/pairing/phone-desk";
import { RosterStore } from "../../src/server/roster";
import { openServerStore } from "../../src/server/store";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { LocalRelay } from "../support/local-relay";

const roots: string[] = [];
const root = (name: string) => { const dir = testRoot(name); roots.push(dir); return dir; };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const PHONE: CommandType[] = ["mobile.view", "mobile.pair", "mobile.revoke", "mobile.relay", "mobile.cluster", "mobile.confirm"];
const PAGE = "https://relay.example/v3/";
const DEVICE = "p".repeat(26);

function fakeRelay(): PhoneRelay & { sets: Array<string | null> } {
  const state = { url: null as string | null };
  const sets: Array<string | null> = [];
  return {
    sets,
    view: () => ({ url: state.url, state: state.url ? "online" : "off", fixed: false }),
    set: async (url) => {
      if (url === "wss://bad.example/nope") throw new RelaySettingError("Use a wss:// relay address ending in /ws.");
      sets.push(url); state.url = url;
    },
  };
}

/** The real pairing service on a temp server.db, with its events replaceable by the test's. */
async function realPairing() {
  const dir = root("phone-desk");
  const store = await openServerStore(dir);
  cleanups.push(() => store.close());
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, {});
  const service = new PairingService({
    roster, cluster: new ClusterSetup(roster), identity, serverName: "Mac", addresses: () => ({ relay: { url: "wss://relay.example/ws", room: "R".repeat(43) } }),
    pageUrl: () => PAGE,
  });
  cleanups.push(() => service.close());
  const listeners = new Set<(event: AdminEvent) => void>();
  const pairing: PhonePairing = { admin: (op) => service.admin(op), onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  return { service, pairing, emit: (event: AdminEvent) => { for (const listener of listeners) listener(event); } };
}

/** A pairing port that only records what it was asked. */
function fakePairing() {
  const ops: AdminOp[] = [];
  const listeners = new Set<(event: AdminEvent) => void>();
  let n = 0;
  const pairing: PhonePairing = {
    admin: async (op) => {
      ops.push(op);
      switch (op.op) {
        case "cluster.status": return { clusterId: "C".repeat(43), pending: null, note: null };
        case "pair.offer": n++; return { offer: `offer-${n}`.padEnd(22, "x"), link: `${PAGE}#pair=secret${n}`, expiresAt: Date.now() + 300_000, clusterId: "C".repeat(43) };
        case "pair.confirm": return { ok: true, deviceId: DEVICE, addId: "A".repeat(43) };
        case "devices.list": return { devices: [
          { id: DEVICE, name: "iPhone", scope: ["read", "reply"], valid: true, revoked: false, addedAt: 5, addedBy: "S" },
          { id: "E".repeat(43), name: "Old phone", scope: ["read"], valid: false, revoked: true, addedAt: 1, addedBy: "S" },
        ] };
        case "device.revoke": return { revokeId: "V".repeat(43), already: false };
        default: throw new Error(`unexpected ${op.op}`);
      }
    },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { ops, pairing, emit: (event: AdminEvent) => { for (const listener of listeners) listener(event); } };
}

const run = (desk: PhoneDesk, cmd: unknown) => desk.run(Command.parse(cmd));

describe("the phone commands' routes in Botling 3", () => {
  it("are local reqs (never a slot), sent by the window adapter as reads, admin only, refused for a device", () => {
    for (const type of PHONE) {
      expect(COMMAND_ROUTES[type].kind, type).toBe("local");
      expect(servedAsReq(type), type).toBe(true);
      expect(READ_COMMANDS.has(type), type).toBe(true);
      expect(PHONE_COMMANDS.has(type), type).toBe(true);
      const cmd = Command.parse(type === "mobile.revoke" ? { type, deviceId: DEVICE } : type === "mobile.relay" ? { type, url: null }
        : type === "mobile.confirm" ? { type, offer: "o".repeat(22), accept: true } : { type });
      expect(commandScope(cmd), type).toBe("admin");
      expect(remoteReadRefusal(cmd, ["read", "reply", "approve", "manage"]), type).toBeTruthy();
    }
    expect(PHONE_COMMANDS.size).toBe(PHONE.length);
  });
});

describe("PhoneDesk: Settings › Phone over the v3 pairing", () => {
  it("makes the cluster first (recovery code shown once, typed back), then an offer whose link the QR shows; no secret in the view", async () => {
    const { pairing } = await realPairing();
    const relay = fakeRelay();
    const desk = new PhoneDesk({ pairing, relay });
    cleanups.push(() => desk.close());
    const first = await run(desk, { type: "mobile.view" }) as any;
    expect(first).toMatchObject({ enabled: false, routes: [], devices: [], relay: { url: null, state: "off" }, v3: { cluster: "none", relayFixed: false, offers: [], devices: [] } });
    await expect(run(desk, { type: "mobile.pair" })).rejects.toThrow(/cluster/);
    const made = await run(desk, { type: "mobile.cluster" }) as { ok: boolean; code: string; expiresAt: number };
    expect(made.ok).toBe(true);
    expect(made.code.replace(/[\s-]/g, "")).toMatch(/^[A-Z2-7]{26}$/);
    expect((await run(desk, { type: "mobile.view" }) as any).v3.cluster).toBe("confirming");
    expect(await run(desk, { type: "mobile.cluster", code: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA" })).toMatchObject({ ok: false, reason: "wrong-code" });
    expect(await run(desk, { type: "mobile.cluster", code: made.code.toLowerCase() })).toEqual({ ok: true });
    const ready = await run(desk, { type: "mobile.view" }) as any;
    expect(ready.v3.cluster).toBe("ready");
    expect(JSON.stringify(ready)).not.toContain(made.code);

    const offer = await run(desk, { type: "mobile.pair" }) as { url: string; expiresAt: number; offer: string; route: { kind: string; origin: string } };
    expect(offer.url.startsWith(`${PAGE}#pair=`)).toBe(true);
    const parsed = parsePairLink(offer.url)!;
    expect(parsed.offer).toBe(offer.offer);
    expect(offer.route).toEqual({ kind: "relay", origin: "https://relay.example" });
    const view = await run(desk, { type: "mobile.view" }) as any;
    expect(view.v3.offers).toEqual([{ offer: offer.offer, state: "waiting", expiresAt: offer.expiresAt }]);
    expect(JSON.stringify(view)).not.toContain(parsed.secret);
    // Botling 3 phones get every bot: a bot list cannot be honoured, so it is refused, not ignored.
    await expect(run(desk, { type: "mobile.pair", botIds: ["main"] })).rejects.toThrow(ContractError);
  });

  it("shows the 6-digit code of a pair.code event for its own offers only, and confirms only an offer waiting for that check", async () => {
    const { pairing, emit } = await realPairing();
    const desk = new PhoneDesk({ pairing, relay: fakeRelay() });
    cleanups.push(() => desk.close());
    const made = await run(desk, { type: "mobile.cluster" }) as { code: string };
    await run(desk, { type: "mobile.cluster", code: made.code });
    const { offer } = await run(desk, { type: "mobile.pair" }) as { offer: string };
    await expect(run(desk, { type: "mobile.confirm", offer, accept: true })).rejects.toThrow(/not waiting/);
    emit({ kind: "pair.code", offer, code: "042917", deviceId: DEVICE, deviceName: "iPhone" });
    emit({ kind: "pair.code", offer: "c".repeat(22), code: "111111", deviceId: DEVICE, deviceName: "CLI's phone" }); // `botlingd pair`'s offer
    const view = await run(desk, { type: "mobile.view" }) as any;
    expect(view.v3.offers).toEqual([{ offer, state: "compare", code: "042917", device: "iPhone", expiresAt: expect.any(Number) }]);
    await expect(run(desk, { type: "mobile.confirm", offer: "c".repeat(22), accept: true })).rejects.toThrow(/not waiting/);
  });

  it("accepts once (a double tap sends one pair.confirm), follows done / ack lost / declined, lists valid devices and revokes", async () => {
    const { ops, pairing, emit } = fakePairing();
    const desk = new PhoneDesk({ pairing, relay: fakeRelay() });
    cleanups.push(() => desk.close());
    const { offer } = await run(desk, { type: "mobile.pair" }) as { offer: string };
    emit({ kind: "pair.code", offer, code: "123456", deviceId: DEVICE, deviceName: "iPhone" });
    const twice = await Promise.allSettled([run(desk, { type: "mobile.confirm", offer, accept: true }), run(desk, { type: "mobile.confirm", offer, accept: true })]);
    expect(twice.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(ops.filter((op) => op.op === "pair.confirm")).toEqual([{ op: "pair.confirm", offer, accept: true }]);
    expect((await run(desk, { type: "mobile.view" }) as any).v3.offers[0]).toMatchObject({ offer, state: "adding" });
    // The device's ack was lost: the offer is open again, the phone retries with the same link and a new code.
    emit({ kind: "pair.declined", offer, reason: "ack lost" });
    expect((await run(desk, { type: "mobile.view" }) as any).v3.offers[0]).toEqual({ offer, state: "waiting", expiresAt: expect.any(Number) });
    emit({ kind: "pair.code", offer, code: "654321", deviceId: DEVICE, deviceName: "iPhone" });
    await run(desk, { type: "mobile.confirm", offer, accept: true });
    emit({ kind: "pair.done", offer, deviceId: DEVICE, addId: "A".repeat(43) });
    const done = await run(desk, { type: "mobile.view" }) as any;
    expect(done.v3.offers[0]).toMatchObject({ offer, state: "paired", device: "iPhone" });
    expect(done.v3.offers[0].code).toBeUndefined();
    expect(done.v3.devices).toEqual([{ id: DEVICE, name: "iPhone", addedAt: 5, scope: ["read", "reply"] }]); // the revoked one is not listed
    await expect(run(desk, { type: "mobile.confirm", offer, accept: true })).rejects.toThrow(/not waiting/);

    const second = (await run(desk, { type: "mobile.pair" }) as { offer: string }).offer;
    emit({ kind: "pair.code", offer: second, code: "000001", deviceId: DEVICE, deviceName: "Stranger" });
    await run(desk, { type: "mobile.confirm", offer: second, accept: false });
    expect(ops.filter((op) => op.op === "pair.confirm").at(-1)).toEqual({ op: "pair.confirm", offer: second, accept: false });
    emit({ kind: "pair.declined", offer: second, reason: "code" });
    expect((await run(desk, { type: "mobile.view" }) as any).v3.offers.find((o: any) => o.offer === second)).toMatchObject({ state: "declined", reason: "code" });

    await expect(run(desk, { type: "mobile.revoke", deviceId: "../x" })).rejects.toThrow(ContractError);
    expect(ops.some((op) => op.op === "device.revoke")).toBe(false);
    await run(desk, { type: "mobile.revoke", deviceId: DEVICE });
    expect(ops.filter((op) => op.op === "device.revoke")).toEqual([{ op: "device.revoke", deviceId: DEVICE }]);
  });

  it("keeps the relay address through the relay port and says what to fix for a bad one", async () => {
    const { pairing } = fakePairing();
    const relay = fakeRelay();
    const desk = new PhoneDesk({ pairing, relay });
    cleanups.push(() => desk.close());
    const on = await run(desk, { type: "mobile.relay", url: "wss://relay.example/ws" }) as any;
    expect(relay.sets).toEqual(["wss://relay.example/ws"]);
    expect(on.relay).toEqual({ url: "wss://relay.example/ws", state: "online" });
    await expect(run(desk, { type: "mobile.relay", url: "wss://bad.example/nope" })).rejects.toThrow(/wss:\/\//);
    const off = await run(desk, { type: "mobile.relay", url: null }) as any;
    expect(off.relay).toEqual({ url: null, state: "off" });
  });
});

describe("changeRelaySetting: the window's relay address", () => {
  it("writes relay.json and applies the clean address; null removes it; nothing is written for a bad one or while the variable wins", async () => {
    const dir = root("relay-change");
    const applied: Array<string | null> = [];
    const apply = async (url: string | null) => { applied.push(url); };
    expect(await changeRelaySetting({ env: {}, dataDir: dir, url: " wss://relay.example ", apply })).toBe("wss://relay.example/ws");
    expect(JSON.parse(readFileSync(join(dir, RELAY_SETTING_FILE), "utf8"))).toEqual({ url: "wss://relay.example/ws" });
    await expect(changeRelaySetting({ env: {}, dataDir: dir, url: "http://relay.example/ws", apply })).rejects.toThrow(RelaySettingError);
    await expect(changeRelaySetting({ env: { BOTLING_SERVER_RELAY_URL: "wss://env.example/ws" }, dataDir: dir, url: null, apply })).rejects.toThrow(/BOTLING_SERVER_RELAY_URL/);
    expect(existsSync(join(dir, RELAY_SETTING_FILE))).toBe(true);
    expect(await changeRelaySetting({ env: {}, dataDir: dir, url: null, apply })).toBeNull();
    expect(existsSync(join(dir, RELAY_SETTING_FILE))).toBe(false);
    expect(applied).toEqual(["wss://relay.example/ws", null]);
  });
});

describe("botlingd answers Settings › Phone (in process, a local relay)", () => {
  const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
    m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

  it("turns the relay on live, makes the cluster, pairs at the relay's page, refuses phone commands as slots, turns the relay off", async () => {
    const relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());
    const dataDir = root("phone-botlingd");
    const daemon = await Botlingd.start({ env: botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0", BOTLING_SERVER_RELAY_BACKOFF_MS: "50,200" }), outDir: join(desktop, "out") });
    cleanups.push(() => daemon.stop());
    const client = new ScriptClient("desktop");
    cleanups.push(() => client.close());
    await client.connect(daemon.paths.socket, daemon.token);
    const req = async (cmd: unknown) => {
      const res = await client.req(cmd);
      if (!res.ok) throw new Error(`${(cmd as { type: string }).type}: ${res.error.message}`);
      return res.result as any;
    };

    const first = await req({ type: "mobile.view" });
    expect(first.v3).toMatchObject({ cluster: "none", relayFixed: false });
    expect(first.relay).toEqual({ url: null, state: "off" });

    // The relay goes on from the window, without a restart.
    await req({ type: "mobile.relay", url: relay.url });
    expect(JSON.parse(readFileSync(join(dataDir, RELAY_SETTING_FILE), "utf8"))).toEqual({ url: relay.url });
    await until(async () => (await req({ type: "mobile.view" })).relay.state === "online", { timeout: 15_000, what: "the relay online" });

    const made = await req({ type: "mobile.cluster" });
    expect(await req({ type: "mobile.cluster", code: made.code })).toEqual({ ok: true });
    const offer = await req({ type: "mobile.pair" });
    expect(offer.url.startsWith(`http://127.0.0.1:${relay.port}/v3/#pair=`)).toBe(true);
    const parsed = parsePairLink(offer.url)!;
    expect(parsed.addresses.relay?.url).toBe(relay.url);
    expect(offer.note).toBeUndefined();

    // Sent as a slot (an old window), a phone command is refused and its result never stored: no link in server.db.
    await client.sub(client.srv);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const slot: Slot = { origin: "desktop", originEpoch: client.originEpoch, target: client.srv, n: 1 };
    client.cmd(slot, { type: "mobile.pair" }, snap.logId);
    const refused = await client.wait(isResult(slot), "mobile.pair as a slot");
    expect(refused.outcome.kind).toBe("refused");
    const dbText = ["server.db", "server.db-wal"].map((name) => { try { return readFileSync(join(dataDir, name)).toString("latin1"); } catch { return ""; } }).join("");
    expect(dbText).not.toContain("#pair=");
    expect(dbText).not.toContain(parsed.secret);

    // Off again, live.
    await req({ type: "mobile.relay", url: null });
    expect(existsSync(join(dataDir, RELAY_SETTING_FILE))).toBe(false);
    expect((await req({ type: "mobile.view" })).relay).toEqual({ url: null, state: "off" });
    expect(daemon.relay).toBeNull();
  }, 90_000);
});
