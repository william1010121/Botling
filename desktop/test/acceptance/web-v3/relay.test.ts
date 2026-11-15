// M2 step 13 (m2-brief §4 row 13): the relay transport against the unchanged relay started locally (relay/src/main.ts
// on 127.0.0.1, ALLOWED_ORIGINS = the test page's origin, set through its environment only; never the online relay).
// botlingd keeps its own room there (BOTLING_SERVER_RELAY_URL) and every device session rides inside `d` frames. A
// meter (test/support/local-relay.ts) sits between both sides and the relay and records when each of botlingd's
// messages arrived, so the test checks the relay's view of botlingd's rate.
//
// Node part (one botlingd, the fake engine):
//  1. pair two devices through the relay (pair mode, the offer's secret; the code confirmed over the local socket);
//  2. device 1 is the real front-end link (src/fe-link, SQLite outbox) on wsDial + RelaySocket: it subscribes to three
//     bots and sends; the reply comes back through the relay;
//  3. load: three fake turns running at once (one per bot, live text to device 1) and one content read by device 2
//     (`content.get` of a 200-page PDF (≈ 8 MB) over its relay session, 128 KiB chunks, 1 MiB window): the relay never counts
//     more than 45 frames/s from botlingd (its token bucket at 45/s, burst 150, refuses none), its own 50/200 limit
//     never closes botlingd, and the bytes' SHA-256 is the reference's id;
//  4. reconnect and resume: the relay is killed during a turn and started again on the same port; a message sent
//     while it is down is delivered once when both sides are back, the stream resumes without a gap or a repeat.
// Browser part (headless Chromium and WebKit, the built page web-v3/dist): pairs from the link with `?via=relay`, sends
// and gets the reply, reports `via relay`, and never opens the server's own `/v3/ws`.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/relay.test.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type BrowserType } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { FeLink, RelaySocket, relaySocketImpl, systemClock, wsDial, type RelayTarget } from "../../../src/fe-link";
import { SqliteFeStorage } from "../../../src/fe-link/sqlite-storage";
import { decodeFrame, encodeFrame, fromBase64Url, parsePairLink, statementId, toBase64Url, type Entry, type Message, type MessageOf, type PairOffer, type Slot } from "../../../src/protocol";
import { relayDeviceToken, relayPairToken, SessionLink, signPairProof, type SessionTransport } from "../../../src/session";
import { ScriptClient } from "../../botlingd-harness";
import { desktop, until } from "../../helpers";
import { bucketRefusals, LocalRelay, maxInWindow, RelayMeter, type MeteredConnection } from "../../support/local-relay";
import { admin, deviceKeys, type DeviceKeys } from "../../support/ws-device";
import { makeTextPdf } from "../../support/make-pdf";
import { writeReport } from "../m1-accept";
import { chatOf, freePort, MAIN, PairCli, phone, say, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const MiB = 1 << 20;
const encoder = new TextEncoder();
const REMOTE = { local: false } as const;
const PAIRING = { local: false, pairing: true } as const;
const report: Record<string, unknown> = {};
afterAll(() => { writeReport("step-13-relay", report); });

const words = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag}${String(i + 1).padStart(4, "0")}`).join(" ");

/** One relay connection as the session code's transport: open once joined, frames in and out. */
async function relayConnection(target: RelayTarget): Promise<SessionTransport & { bind(h: { frame(f: Uint8Array): void; closed(): void }): void; socket: RelaySocket }> {
  const socket = new RelaySocket(target);
  let handlers: { frame(f: Uint8Array): void; closed(): void } | null = null;
  const early: Uint8Array[] = [];
  let closed = false;
  socket.onmessage = (event) => { const frame = new Uint8Array(event.data as ArrayBuffer); if (handlers) handlers.frame(frame); else early.push(frame); };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onclose = (event) => { closed = true; handlers?.closed(); reject(new Error(`the relay join failed: ${socket.refusal ?? event.code}`)); };
  });
  return {
    socket,
    send: (frame) => socket.send(frame),
    close: () => socket.close(),
    bind(h) { handlers = h; for (const frame of early.splice(0)) h.frame(frame); if (closed) h.closed(); },
  };
}

/** Pairs a device through the relay (as test/support/ws-device.ts pairPhone, on the relay path). */
async function pairViaRelay(client: ScriptClient, name: string): Promise<{ keys: DeviceKeys; offer: PairOffer; ms: number }> {
  const t0 = performance.now();
  const keys = await deviceKeys();
  const offered = await admin(client, { op: "pair.offer", name: "relay test" }) as { offer: string; link: string };
  const offer = parsePairLink(offered.link);
  if (!offer?.addresses.relay) throw new Error("the offer names no relay room");
  const relay = offer.addresses.relay;
  const from = client.received.length;
  const connection = await relayConnection({ url: relay.url, room: relay.room, token: relayPairToken(offer.offer, fromBase64Url(offer.secret)!) });
  let added: string | null = null;
  const link: SessionLink = SessionLink.initiate(connection, {
    mode: "pair", transport: "relay", cluster: offer.cluster,
    self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
    responder: { memberId: offer.server, dhPub: fromBase64Url(offer.keys.dh)! },
    pair: { offer: offer.offer, secret: fromBase64Url(offer.secret)! },
  }, {
    onFrame: async (bytes) => {
      const decoded = decodeFrame(bytes, "server", PAIRING);
      if (!decoded.ok || decoded.message.t !== "pair.added") return;
      added = await statementId(decoded.message.add.body);
      const ack = encodeFrame({ t: "pair.ack", addId: added } as Message, "fe", PAIRING);
      if (ack.ok) link.send("control", encoder.encode(ack.text));
    },
    onEnd: () => undefined,
  });
  connection.bind({ frame: (frame) => link.receive(frame), closed: () => link.transportClosed() });
  const info = await link.established;
  const proof = await signPairProof(keys.sign.privateKey, info.transcriptHash);
  const hello = encodeFrame({ t: "pair.hello", name, sign: keys.keys.sign, proof: toBase64Url(proof), feVersion: "3.0.0", protocol: 1 } as Message, "fe", PAIRING);
  if (!hello.ok) throw new Error(hello.detail);
  link.send("control", encoder.encode(hello.text));
  const event = (kind: string) => client.wait((m): m is MessageOf<"admin.event"> => m.t === "admin.event" && m.event.kind === kind && (m.event as { offer?: string }).offer === offer.offer, `admin event ${kind}`, { from });
  await event("pair.code");
  await admin(client, { op: "pair.confirm", offer: offer.offer, accept: true });
  await event("pair.done");
  await until(() => added, { what: "pair.added at the device" });
  link.close();
  return { keys, offer, ms: Math.round(performance.now() - t0) };
}

/** A device's raw session through the relay (the content reader). */
class RelayDevice {
  readonly got: Message[] = [];
  link!: SessionLink;
  static async open(keys: DeviceKeys, offer: PairOffer): Promise<RelayDevice> {
    const device = new RelayDevice();
    const relay = offer.addresses.relay!;
    const serverDh = fromBase64Url(offer.keys.dh)!;
    const connection = await relayConnection({ url: relay.url, room: relay.room, token: relayDeviceToken(keys.member, keys.dh.privateKey, serverDh) });
    device.link = SessionLink.initiate(connection, {
      mode: "ik", transport: "relay", cluster: offer.cluster,
      self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: offer.server, dhPub: serverDh },
    }, {
      onFrame: (bytes) => { const decoded = decodeFrame(bytes, "server", REMOTE); if (decoded.ok) device.got.push(decoded.message); },
      onEnd: () => undefined,
    });
    connection.bind({ frame: (frame) => device.link.receive(frame), closed: () => device.link.transportClosed() });
    await device.link.established;
    device.send({ t: "hello", deviceId: keys.member, feVersion: "3.0.0", protocol: 1, originEpoch: "f".repeat(32), cursors: {}, outbox: [], want: [] } as Message);
    await until(() => device.got.some((m) => m.t === "welcome"), { what: "welcome over the relay" });
    return device;
  }
  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.link.send("control", encoder.encode(encoded.text));
  }
  close(): void { this.link.close(); }
}

/** botlingd's connections through the meter (the ones that opened a room). */
const deskConnections = (meter: RelayMeter): MeteredConnection[] => meter.connections.filter((c) => c.kinds[0] === "desk");

function rate(times: number[]) {
  return {
    messages: times.length,
    maxIn1s: maxInWindow(times, 1_000),
    maxIn100ms: maxInWindow(times, 100),
    maxIn5sPerSecond: Number((maxInWindow(times, 5_000) / 5).toFixed(1)),
    relay45x150: bucketRefusals(times, 45, 150),
    relay50x200: bucketRefusals(times, 50, 200),
  };
}

function lineOf(dataDir: string, botId: string, includes: string): string | null {
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const rows = db.prepare("SELECT msgId, body FROM messages WHERE botId = ? ORDER BY seq").all(botId) as Array<{ msgId: string; body: string }>;
    return rows.find((row) => { const m = JSON.parse(row.body) as { role?: string; text?: string }; return m.role !== "user" && String(m.text ?? "").includes(includes); })?.msgId ?? null;
  } finally { db.close(); }
}

async function startAll(root: string, origin: string, port: number) {
  const relayPort = await freePort();
  const relayEnv = { ALLOWED_ORIGINS: origin };
  const box = { relay: await new LocalRelay(relayEnv, relayPort).ready() };
  const meter = await new RelayMeter(() => box.relay.url).start();
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const server = new Server(dataDir, port, { BOTLING_SERVER_RELAY_URL: meter.url, BOTLING_SERVER_RELAY_BACKOFF_MS: "100,1000" });
  await server.ready();
  await until(() => server.daemon.log.includes("relay: room open"), { timeout: 20_000, what: "botlingd's room on the relay" });
  return {
    box, meter, server, dataDir,
    async restartRelay() { box.relay = await new LocalRelay(relayEnv, relayPort).ready(); },
    async stop() {
      await server.stop().catch(() => undefined);
      await meter.stop().catch(() => undefined);
      await box.relay.stop().catch(() => undefined);
    },
  };
}

describe("M2 step 13: the relay transport (local relay)", () => {
  it("node: pair and send through the relay; 3 turns + a content read stay under the relay's limit; reconnect and resume", async () => {
    const root = mkdtempSync(join(TMP, "relay-node-"));
    const port = await freePort();
    const result: Record<string, unknown> = {};
    report.node = result;
    const all = await startAll(root, `http://127.0.0.1:${port}`, port);
    const { meter, server, dataDir } = all;
    let script: ScriptClient | null = null;
    let fe: FeLink | null = null;
    let reader: RelayDevice | null = null;
    try {
      script = new ScriptClient("relay-test", "d".repeat(32));
      await script.connect(server.daemon.socket, server.daemon.token);

      // 1. Two devices pair through the relay (the cluster first, as `botlingd pair` does on a first pairing).
      // cluster.create makes it at once (the recovery code is shown once, never typed back).
      await admin(script, { op: "cluster.create" });
      const one = await pairViaRelay(script, "Phone one");
      const two = await pairViaRelay(script, "Phone two");
      result.pairMs = [one.ms, two.ms];
      expect(one.offer.addresses.relay!.url).toBe(meter.url);

      // Two more bots (three turns at once), made over the local socket.
      await script.sub(script.srv);
      const srvSnap = await script.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === script!.srv, "srv snap");
      const bots = [MAIN];
      for (let n = 1; n <= 2; n++) {
        script.cmd({ origin: script.deviceId, originEpoch: script.originEpoch, target: script.srv, n } as Slot, { type: "bots.create", name: `Relay bot ${n}`, job: "relay test" }, srvSnap.logId);
        const created = await script.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === n && m.slot.target === script!.srv, "bots.create");
        bots.push((created.outcome as { result: { botId: string } }).result.botId);
      }

      // 2. Device 1: the front-end link through the relay; subscribe to the three bots, send, get the reply.
      const offer = one.offer;
      const relay = offer.addresses.relay!;
      const serverDh = fromBase64Url(offer.keys.dh)!;
      let token: Promise<string> | null = null;
      const ends: string[] = [];
      const dial = wsDial({
        url: () => `ws://127.0.0.1:${port}/v3/ws`,
        transport: "relay",
        WebSocketImpl: relaySocketImpl(() => ({ url: relay.url, room: relay.room, token: (token ??= relayDeviceToken(one.keys.member, one.keys.dh.privateKey, serverDh)) })),
        identity: { cluster: offer.cluster, memberId: one.keys.member, dh: one.keys.dh, server: { memberId: offer.server, dhPub: serverDh } },
        onEnd: (end) => ends.push(`${end.reason}: ${end.detail}`),
      });
      fe = await FeLink.open({ storage: new SqliteFeStorage(join(root, "fe.db")), dial, deviceId: one.keys.member, feVersion: "3.0.0-m2", local: false, clock: systemClock, offlineAfterMs: 45_000, reconnectMinMs: 100, reconnectMaxMs: 1_000 });
      const states: string[] = [];
      const stateTimes: string[] = [];
      const seqs: Record<string, number[]> = {};
      const liveAt: Record<string, number[]> = {};
      fe.on((event) => {
        if (event.type === "state" && states[states.length - 1] !== event.status.state) { states.push(event.status.state); stateTimes.push(`${event.status.state}@${Math.round(performance.now())}`); }
        if (event.type === "entries") for (const entry of event.entries as Entry[]) (seqs[entry.stream] ??= []).push(entry.seq);
        if (event.type === "live" && event.view && !event.stale) (liveAt[event.stream] ??= []).push(performance.now());
      });
      fe.start();
      for (const bot of bots) fe.subscribe(`bot:${bot}`);
      await until(() => states.includes("live"), { timeout: 20_000, what: "device 1 live through the relay" });
      const outcome = async (n: number) => {
        await until(() => fe!.pending().every((item) => item.slot.n !== n) || null, { timeout: 30_000, what: `the outcome of item ${n}` });
      };
      const tSend = performance.now();
      const first = await fe.submit(`bot:${MAIN}`, { type: "chat.send", botId: MAIN, text: "/say relay hello" });
      await outcome(first.slot.n);
      await until(() => lineOf(dataDir, MAIN, "relay hello"), { timeout: 30_000, what: "the reply" });
      result.send = { sendToReplyMs: Math.round(performance.now() - tSend) };

      // One turn alone through the relay (the live text's baseline: ≤ 10 frames/s per turn at the server's gate).
      const baseFrom = liveAt[`bot:${MAIN}`]?.length ?? 0;
      await fe.submit(`bot:${MAIN}`, { type: "chat.send", botId: MAIN, text: `/say ${words(150, "b")}` });
      await until(() => lineOf(dataDir, MAIN, "b0150"), { timeout: 30_000, what: "the baseline turn" });
      const baseLive = (liveAt[`bot:${MAIN}`] ?? []).slice(baseFrom);
      result.baselineTurn = { words: 150, liveFrames: baseLive.length, spanMs: Math.round((baseLive.at(-1) ?? 0) - (baseLive[0] ?? 0)), maxIn1s: maxInWindow(baseLive, 1_000) };

      // 3. Load: a 200-page PDF on a bot line, three turns at once, device 2 reads the file over its relay session.
      const file = join(root, "big.pdf");
      makeTextPdf(file, 200);
      const bytes = readFileSync(file);
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      await fe.submit(`bot:${MAIN}`, { type: "chat.send", botId: MAIN, text: `/say The file: ![big](${pathToFileURL(file).href})` });
      const line = await until(() => lineOf(dataDir, MAIN, "![big]"), { timeout: 30_000, what: "the file's line" });
      reader = await RelayDevice.open(two.keys, two.offer);
      const locate = async () => {
        const req = `loc${Date.now()}`;
        reader!.send({ t: "content.locate", req, botId: MAIN, line, url: pathToFileURL(file).href } as Message);
        return until(() => reader!.got.find((m): m is MessageOf<"content.located"> => m.t === "content.located" && m.req === req) ?? null, { timeout: 15_000, what: "content.located" });
      };
      let located = await locate();
      for (let i = 0; i < 40 && located.ref?.state !== "ready"; i++) { await new Promise((r) => setTimeout(r, 250)); located = await locate(); }
      expect(located.ref?.state).toBe("ready");
      const ref = located.ref!;
      expect(ref.id).toBe(`sha256:${fileHash}`);
      await new Promise((r) => setTimeout(r, 1_500));

      const desk = deskConnections(meter);
      expect(desk).toHaveLength(1);
      const conn = desk[0]!;
      const loadFrom = conn.times.length;
      const tLoad = performance.now();
      const turnWords = 300;
      for (let i = 0; i < bots.length; i++) {
        await fe.submit(`bot:${bots[i]}`, { type: "chat.send", botId: bots[i]!, text: `/say ${words(turnWords, `t${i}w`)}` });
      }
      // The content read starts once the turns stream.
      await until(() => bots.every((bot) => (liveAt[`bot:${bot}`]?.length ?? 0) > 0) || null, { timeout: 20_000, what: "three turns streaming" });
      const req = "get1";
      const got: Buffer[] = [];
      let have = 0, chunks = 0, maxChunk = 0;
      const tGet = performance.now();
      reader.send({ t: "content.get", req, owner: ref.owner, id: ref.id, variant: "original", offset: 0, length: bytes.length, entry: ref.entry } as Message);
      let read = 0;
      await until(() => {
        for (; read < reader!.got.length; read++) {
          const m = reader!.got[read]!;
          if (m.t === "content.gone" && (m as { req: string }).req === req) throw new Error(`content.gone ${JSON.stringify(m)}`);
          if (m.t !== "content.chunk" || m.req !== req) continue;
          got.push(Buffer.from(m.bytes));
          have += m.bytes.length;
          chunks++;
          maxChunk = Math.max(maxChunk, m.bytes.length);
          reader!.send({ t: "content.credit", req, bytes: m.bytes.length } as Message);
        }
        return have >= bytes.length || null;
      }, { timeout: 120_000, every: 5, what: "the content read" });
      const getMs = performance.now() - tGet;
      const readHash = createHash("sha256").update(Buffer.concat(got)).digest("hex");
      expect(readHash).toBe(fileHash);
      expect(maxChunk).toBe(128 * 1024);
      const meta = reader.got.find((m): m is MessageOf<"content.meta"> => m.t === "content.meta" && m.req === req);
      expect(meta?.size).toBe(bytes.length);

      // The three turns finish; every word arrived.
      for (let i = 0; i < bots.length; i++) {
        await until(() => lineOf(dataDir, bots[i]!, `t${i}w${String(turnWords).padStart(4, "0")}`), { timeout: 60_000, what: `turn ${i} committed` });
      }
      await until(() => bots.every((bot) => fe!.pending(`bot:${bot}`).length === 0) || null, { timeout: 30_000, what: "the turns' outcomes at device 1" });
      const loadMs = performance.now() - tLoad;
      await new Promise((r) => setTimeout(r, 500));
      const loadTimes = conn.times.slice(loadFrom);
      const loadRate = rate(loadTimes);
      const toKinds = conn.kinds.slice(loadFrom).filter((k) => k === "to").length;
      result.load = {
        turns: bots.length, wordsPerTurn: turnWords, loadMs: Math.round(loadMs),
        content: { bytes: bytes.length, chunks, maxChunk, ms: Math.round(getMs), mibPerSecond: Number((bytes.length / MiB / (getMs / 1000)).toFixed(2)), chunksPerSecond: Number((chunks / (getMs / 1000)).toFixed(1)) },
        liveFramesAtDevice1: Object.fromEntries(bots.map((bot, i) => [`turn${i}`, liveAt[`bot:${bot}`]?.length ?? 0])),
        liveMaxIn1sAtDevice1: Object.fromEntries(bots.map((bot, i) => [`turn${i}`, maxInWindow(liveAt[`bot:${bot}`] ?? [], 1_000)])),
        // botlingd's per-connection gate (live-gate.ts): ≤ 10 live frames/s on one session, whatever the number of turns.
        liveAllTurnsMaxIn1sAtDevice1: maxInWindow(bots.flatMap((bot) => liveAt[`bot:${bot}`] ?? []).sort((x, y) => x - y), 1_000),
        botlingdToRelay: { ...loadRate, toFrames: toKinds },
        relayClosedBotlingd: conn.relayClosed,
      };
      // The relay's view: no 45/s-burst-150 refusal, at most 45·1 + 150 in any second, its own limit never reached.
      expect(loadRate.relay50x200.refused).toBe(0);
      expect(loadRate.relay45x150.refused).toBe(0);
      expect(loadRate.maxIn1s).toBeLessThanOrEqual(195);
      expect(loadRate.maxIn5sPerSecond).toBeLessThanOrEqual(45 + 150 / 5);
      expect(conn.relayClosed).toBeNull();
      reader.close();
      reader = null;

      // 4. Reconnect and resume: kill the relay during a turn; send while it is down; start it again on the same port.
      const beforeKill = { ...Object.fromEntries(Object.entries(seqs).map(([k, v]) => [k, v.length])) };
      // The killed turn runs on the main bot; the message sent while the relay is down goes to another bot.
      const liveBefore = liveAt[`bot:${MAIN}`]?.length ?? 0;
      await fe.submit(`bot:${MAIN}`, { type: "chat.send", botId: MAIN, text: `/say ${words(200, "k")}` });
      await until(() => (liveAt[`bot:${MAIN}`]?.length ?? 0) > liveBefore + 3 || null, { timeout: 20_000, what: "the turn streaming before the kill" });
      // The turn after the load streams (a lapsed grant used to leave a stream's live dropped for good, live-gate.ts).
      const killTurnLive = (liveAt[`bot:${MAIN}`]?.length ?? 0) - liveBefore;
      const tKill = performance.now();
      all.box.relay.child.kill("SIGKILL");
      await until(() => states[states.length - 1] !== "live" || null, { timeout: 20_000, what: "device 1 sees the loss" });
      const whileDown = await fe.submit(`bot:${bots[2]}`, { type: "chat.send", botId: bots[2]!, text: "/say sent while the relay was down" });
      expect(fe.pending().find((item) => item.slot.n === whileDown.slot.n)?.state).toBe("waiting");
      await new Promise((r) => setTimeout(r, 1_000));
      await all.box.relay.stop();
      const tRestart = performance.now();
      await all.restartRelay();
      await until(() => server.daemon.log.split("relay: room open").length > 2 || null, { timeout: 20_000, what: "botlingd's room again" });
      const roomBackMs = Math.round(performance.now() - tRestart);
      await until(() => states[states.length - 1] === "live" || null, { timeout: 30_000, what: "device 1 live again" });
      const liveBackMs = Math.round(performance.now() - tRestart);
      await outcome(whileDown.slot.n);
      await until(() => lineOf(dataDir, bots[2]!, "sent while the relay was down"), { timeout: 30_000, what: "the reply after the restart" });
      await until(() => lineOf(dataDir, MAIN, "k0200"), { timeout: 60_000, what: "the killed turn committed" });
      await until(() => fe!.pending().length === 0 || null, { timeout: 30_000, what: "no item waiting" });
      await new Promise((r) => setTimeout(r, 1_000));
      // Delivered once: one user line with that text.
      const users = (new DatabaseSync(join(dataDir, "server.db"), { readOnly: true }));
      let sentLines = 0;
      try {
        const rows = users.prepare("SELECT body FROM messages WHERE botId = ?").all(bots[2]!) as Array<{ body: string }>;
        sentLines = rows.filter((row) => { const m = JSON.parse(row.body) as { role?: string; text?: string }; return m.role === "user" && m.text === "/say sent while the relay was down"; }).length;
      } finally { users.close(); }
      expect(sentLines).toBe(1);
      // The streams resumed from the device's cursors: seqs strictly rising by one, none repeated, none missing.
      const gaps: Record<string, number> = {};
      for (const [stream, list] of Object.entries(seqs)) {
        let bad = 0;
        for (let i = 1; i < list.length; i++) if (list[i] !== list[i - 1]! + 1) bad++;
        gaps[stream] = bad;
      }
      expect(Object.values(gaps).every((n) => n === 0), JSON.stringify(gaps)).toBe(true);
      // Its attempts while the relay was down reached the meter only; the open one now is the last.
      const desks = deskConnections(meter);
      const second = desks[desks.length - 1]!;
      expect(second.relayClosed).toBeNull();
      expect(second.counts.desk).toBe(1);
      result.reconnect = {
        relayKilledAfterMs: Math.round(tKill - tLoad), liveFramesOfTheTurnBeforeTheKill: killTurnLive, roomBackAfterRestartMs: roomBackMs, deviceLiveAfterRestartMs: liveBackMs,
        deliveredOnce: sentLines === 1, entriesBefore: beforeKill, entriesAfter: Object.fromEntries(Object.entries(seqs).map(([k, v]) => [k, v.length])), gaps,
        connStates: stateTimes, marks: { tKill: Math.round(tKill), tRestart: Math.round(tRestart), now: Math.round(performance.now()) }, deviceRelayCloses: meter.connections.filter((c) => c.kinds[0] === "join").map((c) => `${c.relayClosed?.code ?? "-"}/${c.botlingdClosed?.code ?? "-"}:${c.counts.d ?? 0}`), sessionEnds: ends.slice(-6), firstConnectionClosed: conn.relayClosed, attemptsWhileDown: desks.length - 2, secondConnection: rate(second.times),
      };
      // The intentional kill is the only close of botlingd by the relay; never for its rate.
      for (const c of deskConnections(meter)) expect(c.relayClosed?.code).not.toBe(4429);
      expect(bucketRefusals(second.times, 45, 150).refused).toBe(0);
      expect(server.daemon.log).not.toContain("closed this server's connection for its rate");
      result.botlingdRelayLog = server.daemon.log.split("\n").filter((l) => l.includes("relay:")).map((l) => l.replace(/^\S+\s+/, "")).slice(-12);

      // The relay itself was never changed.
      expect(execFileSync("git", ["diff", "main", "--", "relay/"], { cwd: join(desktop, ".."), encoding: "utf8" })).toBe("");
    } finally {
      reader?.close();
      await fe?.close().catch(() => undefined);
      script?.close();
      await all.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);

  for (const [engine, type] of ENGINES) {
    it(`${engine}: the page pairs, sends and reads replies through the relay`, () => browserRun(engine, type), 300_000);
  }
});

async function browserRun(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `relay-${engine}-`));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const all = await startAll(root, origin, port);
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    browser = await phone(type, join(root, "profile"));
    const { page } = browser;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));
    const cli = new PairCli(all.dataDir);
    const link = await cli.link();
    const t0 = Date.now();
    await page.goto(`${all.server.page}?via=relay`);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    result.pairToChatMs = Date.now() - t0;
    const tSay = Date.now();
    await say(page, "/say hello through the relay");
    await chatOf(page).locator("#messages .row").filter({ hasText: "hello through the relay" }).nth(1).waitFor({ timeout: 30_000 });
    result.sendToReplyMs = Date.now() - tSay;
    const diag = await page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: unknown }).botling3Diagnostics)) as { player: { path: string }; conn: string[] });
    expect(diag.player.path).toBe("relay");
    result.diag = { path: diag.player.path, conn: diag.conn };
    // The PDF viewer on the relay path: 256 KiB reads (step 15 keys them off the page's path).
    const pdf = join(root, "doc.pdf");
    makeTextPdf(pdf, 40);
    await say(page, `/say The doc: ![doc](${pathToFileURL(pdf).href})`);
    const opener = chatOf(page).locator("[data-botling3-open]").first();
    await opener.waitFor({ timeout: 60_000 });
    const tTap = Date.now();
    await opener.click();
    await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/pdf.html")), { timeout: 15_000 }).toBe(true);
    const viewer = page.frames().find((f) => f.url().includes("/v3/pdf.html"))!;
    const pdfDiag = () => viewer.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Pdf?: unknown }).botling3Pdf ?? null)) as { state: string; error?: string; chunk: number; firstPageMs?: number; bytesBeforeFirstPage?: number } | null);
    await expect.poll(async () => { const d = await pdfDiag(); if (d?.state === "error") throw new Error(d.error); return d?.firstPageMs ?? -1; }, { timeout: 15_000, interval: 25 }).toBeGreaterThan(0);
    const viewed = (await pdfDiag())!;
    expect(viewed.chunk).toBe(256 * 1024);
    result.pdfViewer = { chunk: viewed.chunk, tapToPage1Ms: Date.now() - tTap, bytesBeforePage1: viewed.bytesBeforeFirstPage };
    expect(await page.locator("iframe[data-testid='pdf-viewer']").getAttribute("src")).toContain("chunk=262144");

    // Every WebSocket the page opened went to the relay (through the meter), never the server's own /v3/ws.
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.filter((url) => url.includes("/v3/ws"))).toEqual([]);
    expect(sockets.every((url) => url === all.meter.url)).toBe(true);
    result.sockets = sockets.length;
    // The page's own connections passed the relay's Origin check (ALLOWED_ORIGINS = this origin).
    const phoneConns = all.meter.connections.filter((c) => c.kinds[0] === "join");
    expect(phoneConns.length).toBeGreaterThanOrEqual(2);
    // The first is the pairing connection: once the offer retires its token leaves the allow list and the relay closes
    // it (4403), by design. The device's own sessions after it are never refused.
    result.pairingConnectionClosed = phoneConns[0]!.relayClosed;
    expect(phoneConns.slice(1).some((c) => c.relayClosed?.code === 4403)).toBe(false);
    expect(phoneConns.slice(1).some((c) => (c.counts.d ?? 0) > 0)).toBe(true);
    for (const c of deskConnections(all.meter)) {
      expect(c.relayClosed).toBeNull();
      expect(bucketRefusals(c.times, 45, 150).refused).toBe(0);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    await all.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
