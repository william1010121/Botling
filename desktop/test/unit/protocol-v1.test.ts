// Botling 3 wire protocol v1 (src/protocol): every message round-trips through a frame; malformed frames and
// messages outside the sender's role are refused.
import { describe, expect, it } from "vitest";
import {
  ENTRY_KINDS, FRAME_LIMIT, FrameSplitter, GENESIS_HASH, MESSAGES, ROLE_TABLE, canonicalJson, decodeFrame, encodeFrame, entryHashInput,
  outcomeOf, packFrame, queueKey, roleRefusal, slotKey, toBase64Url, type Entry, type Message, type MessageType, type Sender, type SessionKind,
} from "../../src/protocol";
import { m2Samples, type M2Type } from "./protocol-m2-samples";

const bot = "6A0B0000-0000-4000-8000-000000000002";
const stream = `bot:${bot}`;
const logA = "logAAAAAAAAA";
const logB = "logBBBBBBBBB";
const hash = (digit: string) => digit.repeat(64);
const epoch = "0123456789abcdef0123456789abcdef";
const slot = { origin: "desktop", originEpoch: epoch, target: stream, n: 3 };
const content = `sha256:${"ab".repeat(32)}`;
const hlc = { ms: 1_763_100_000_000, c: 0 };

const entry = (seq: number, kind: string, body: Record<string, unknown>, extra: Partial<Entry> = {}): Entry =>
  ({ stream, logId: logA, seq, hlc, kind, body, hash: hash(String(seq % 10)), ...extra });

const ref = { owner: "server-1", id: content, size: 1_000, type: "video/mp4", name: "clip.mp4", kind: "video", pin: "clone", state: "ready", meta: { duration: 12.5, width: 1280, height: 720 } } as const;

const entries: Entry[] = [
  entry(1, "message.added", { botId: bot, message: { id: "m1", role: "user", text: "hi", time: "2026-11-14T00:00:00.000Z" } }, { slot }),
  entry(2, "turn.queued", { botId: bot, turnId: "t1", effectId: "e1", messageId: "m1" }),
  entry(3, "cmd.applied", { slot, result: { messageId: "m1" } }),
  entry(4, "turn.started", { botId: bot, turnId: "t1", messageId: "m2" }),
  entry(5, "turn.interrupted", { botId: bot, turnId: "t1", text: "so far" }),
  entry(6, "cmd.skipped", { origin: "desktop", originEpoch: epoch, target: stream, from: 4, to: 6 }),
  entry(7, "content.ready", { botId: bot, lineId: "m2", url: "file:///clip.mp4", ref }),
  entry(8, "cmd.refused", { slot: { ...slot, n: 7 }, reason: "changed" }),
];

const cmdBody = { slot, floor: 2, inc: logA, cmd: { type: "chat.send", botId: bot, text: "hello" } };

/** One valid sample of every M1 message, with a sender and session that may send it (M2's: protocol-m2-samples.ts). */
const samples: { [T in Exclude<MessageType, M2Type>]: { message: Extract<Message, { t: T }>; sender: Sender; session?: SessionKind } } = {
  hello: { sender: "fe", message: { t: "hello", deviceId: "desktop", feVersion: "3.0.0", protocol: 1, originEpoch: epoch, cursors: { [stream]: { logId: logA, seq: 4 } }, outbox: [cmdBody], want: [stream], token: "t".repeat(32) } as never },
  welcome: { sender: "server", message: { t: "welcome", serverId: "server-1", protocol: { min: 1, max: 1 }, minFeVersion: "3.0.0", rosterDigest: null, servers: [{ id: "server-1", name: "Mac", state: "live", since: null }], next: { [stream]: 4 }, views: {} } },
  sub: { sender: "fe", message: { t: "sub", stream, cursor: { logId: logA, seq: 4 } } },
  unsub: { sender: "fe", message: { t: "unsub", stream } },
  ack: { sender: "fe", message: { t: "ack", stream, cursor: { logId: logA, seq: 8 } } },
  history: { sender: "fe", message: { t: "history", req: "h1", stream, before: "m1", bytes: 65_536 } },
  "history.page": { sender: "server", message: { t: "history.page", req: "h1", stream, logId: logA, messages: [{ id: "m0", role: "bot", text: "older", time: "2026-11-13T00:00:00.000Z" }], hasMore: false, older: 0 } },
  batch: { sender: "server", message: { t: "batch", stream, logId: logA, from: 1, to: entries.length, prevHash: GENESIS_HASH, entries, more: false } as never },
  snap: { sender: "server", message: { t: "snap", stream, logId: logA, seq: 8, hash: hash("8"), view: { messages: [], running: null } } },
  reset: { sender: "server", message: { t: "reset", stream, logId: logB, retired: [{ logId: logA, keptSeq: 5 }], reason: "restored" } },
  stale: { sender: "server", message: { t: "stale", stream, since: 1_763_100_000_000 } },
  peer: { sender: "server", message: { t: "peer", serverId: "server-2", state: "stale", since: 1_763_100_000_000 } },
  live: { sender: "server", message: { t: "live", stream, turnId: "t1", seg: 0, rev: 3, at: 12, text: " more" } },
  "live.resync": { sender: "fe", message: { t: "live.resync", stream } },
  cmd: { sender: "fe", message: { t: "cmd", ...cmdBody, basis: { logId: logA, seq: 8 } } as never },
  cancel: { sender: "fe", message: { t: "cancel", slot } },
  held: { sender: "peer", message: { t: "held", slot, at: "server-1" } },
  "cmd.result": { sender: "server", message: { t: "cmd.result", slot, outcome: { kind: "applied", result: { messageId: "m1" } }, logId: logA, seq: 3 } },
  "cmd.retry": { sender: "server", message: { t: "cmd.retry", slot, inc: logB } },
  "cancel.noted": { sender: "server", message: { t: "cancel.noted", slot } },
  req: { sender: "fe", session: { local: true }, message: { t: "req", req: "r1", cmd: { type: "routines.list", botId: bot } } as never },
  res: { sender: "server", session: { local: true }, message: { t: "res", req: "r1", ok: true, result: { routines: [] } } },
  "res.part": { sender: "server", session: { local: true }, message: { t: "res.part", req: "r1", i: 0, n: 2, text: "{\"t\":\"res\"" } },
  "content.find": { sender: "fe", session: { local: true }, message: { t: "content.find", req: "c0", botId: bot, line: "m2", url: "file:///clip.mp4" } },
  "content.found": { sender: "server", session: { local: true }, message: { t: "content.found", req: "c0", ref: { owner: "server-1", id: `pending:${"0f".repeat(16)}`, type: "video/mp4", state: "preparing", entry: { stream, seq: 7 } } } },
  "content.open": { sender: "fe", session: { local: true }, message: { t: "content.open", req: "c1", owner: "server-1", id: content, variant: "original", entry: { stream, seq: 7 } } },
  "content.file": { sender: "server", session: { local: true }, message: { t: "content.file", req: "c1", id: content, path: "/data/content/ab", type: "video/mp4", pin: "clone", sig: { size: 1_000, mtimeNs: "1763100000000000000", ino: "123456" } } },
  "content.gone": { sender: "server", message: { t: "content.gone", req: "c1", id: content, reason: "changed" } },
  "shell.screenshot": { sender: "server", session: { local: true }, message: { t: "shell.screenshot", req: "s1" } },
  "shell.browser": { sender: "server", session: { local: true }, message: { t: "shell.browser", req: "s2", args: { action: "open", url: "https://example.com" } } },
  "shell.install": { sender: "server", session: { local: true }, message: { t: "shell.install", req: "s3" } },
  "shell.quit": { sender: "server", session: { local: true }, message: { t: "shell.quit", req: "s4" } },
  "shell.seal": { sender: "server", session: { local: true }, message: { t: "shell.seal", req: "s5", text: "plain" } },
  "shell.open": { sender: "server", session: { local: true }, message: { t: "shell.open", req: "s6", sealed: "c2VhbGVk" } },
  "shell.done": { sender: "fe", session: { local: true }, message: { t: "shell.done", req: "s1", ok: true, file: "/tmp/shot.png" } },
  "push.subscribe": { sender: "fe", session: { local: false }, message: { t: "push.subscribe", endpoint: "https://push.example/sub/1", keys: { p256dh: toBase64Url(new Uint8Array(65).fill(9).map((b, i) => (i === 0 ? 4 : b))), auth: toBase64Url(new Uint8Array(16).fill(5)) } } },
  ping: { sender: "peer", message: { t: "ping", at: 1 } },
  bye: { sender: "fe", message: { t: "bye", reason: "closing" } },
};
const all = Object.entries(samples) as [keyof typeof samples, (typeof samples)[keyof typeof samples]][];
const local: SessionKind = { local: true };
const remote: SessionKind = { local: false };
const senders: Sender[] = ["fe", "server", "peer"];

function refused(frame: string | Uint8Array, sender: Sender, session: SessionKind = local) {
  const decoded = decodeFrame(frame, sender, session);
  if (decoded.ok) throw new Error(`accepted: ${typeof frame === "string" ? frame.slice(0, 200) : "bytes"}`);
  return decoded;
}
const json = (value: unknown) => JSON.stringify(value);

describe("protocol v1: round trips", () => {
  it("has a sample, a schema and a role row for every message", () => {
    expect([...Object.keys(samples), ...Object.keys(m2Samples)].sort()).toEqual(Object.keys(MESSAGES).sort());
    for (const type of Object.keys(MESSAGES)) {
      const row = ROLE_TABLE[type];
      expect(row, type).toBeDefined();
      expect(row!.fe || row!.server || row!.peer, type).toBe(true);
    }
  });

  it.each(all)("%s round-trips through a frame", (_type, { message, sender, session }) => {
    const encoded = encodeFrame(message, sender, session ?? local);
    if (!encoded.ok) throw new Error(encoded.detail);
    const decoded = decodeFrame(encoded.text, sender, session ?? local);
    if (!decoded.ok) throw new Error(decoded.detail);
    expect(decoded.message).toEqual(message);
    const bytes = decodeFrame(new TextEncoder().encode(encoded.text), sender, session ?? local);
    expect(bytes.ok && bytes.message).toEqual(message);
  });

  it("round-trips every message over a byte stream cut at random places", () => {
    const frames = all.map(([, { message, sender, session }]) => {
      const encoded = encodeFrame(message, sender, session ?? local);
      if (!encoded.ok) throw new Error(encoded.detail);
      return packFrame(encoded.text);
    });
    const stream = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
    let at = 0;
    for (const frame of frames) { stream.set(frame, at); at += frame.length; }
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 20; run++) {
      const splitter = new FrameSplitter();
      const got: Message[] = [];
      for (let offset = 0; offset < stream.length;) {
        const size = 1 + Math.floor(random() * 300);
        const pushed = splitter.push(stream.subarray(offset, offset + size));
        if (!pushed.ok) throw new Error(pushed.detail);
        for (const frame of pushed.frames) {
          const [, sample] = all[got.length]!;
          const decoded = decodeFrame(frame, sample.sender, sample.session ?? local);
          if (!decoded.ok) throw new Error(decoded.detail);
          got.push(decoded.message);
        }
        offset += size;
      }
      expect(splitter.pending).toBe(0);
      expect(got).toEqual(all.map(([, sample]) => sample.message));
    }
  });

  it("knows every entry kind of M1 and none of the live text", () => {
    for (const kind of ["message.added", "turn.started", "turn.steps", "turn.finished", "turn.queued", "turn.interrupted", "turn.cancelled", "cmd.applied", "cmd.cancelled", "cmd.refused", "cmd.skipped", "content.ready", "content.changed"]) {
      expect(ENTRY_KINDS.has(kind), kind).toBe(true);
    }
    expect(ENTRY_KINDS.has("turn.delta")).toBe(false);
  });

  it("takes outcomes from outcome entries", () => {
    expect(outcomeOf(entries[2]!)).toEqual({ kind: "applied", result: { messageId: "m1" } });
    expect(outcomeOf(entries[5]!)).toEqual({ kind: "skipped" });
    expect(outcomeOf(entries[7]!)).toEqual({ kind: "refused", reason: "changed" });
    expect(outcomeOf(entry(9, "cmd.cancelled", { slot }))).toEqual({ kind: "cancelled" });
    expect(outcomeOf(entries[0]!)).toBeNull();
  });

  it("hashes a canonical form: keys sorted, hash left out", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe('{"a":[true,null,{"d":"x"}],"b":1}');
    const one = entries[0]!;
    const shuffled = { hash: hash("f"), slot: one.slot, body: one.body, kind: one.kind, hlc: one.hlc, seq: one.seq, logId: one.logId, stream: one.stream } as Entry;
    expect(entryHashInput(GENESIS_HASH, shuffled)).toBe(entryHashInput(GENESIS_HASH, one));
    expect(entryHashInput(GENESIS_HASH, one)).not.toContain(one.hash);
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });

  it("gives slots stable keys", () => {
    expect(slotKey(slot)).toBe(slotKey({ n: 3, target: stream, originEpoch: epoch, origin: "desktop" }));
    expect(slotKey(slot)).not.toBe(slotKey({ ...slot, n: 4 }));
    expect(queueKey(slot)).toBe(queueKey({ ...slot, n: 9 } as typeof slot));
  });
});

describe("protocol v1: wrong-role messages are refused", () => {
  it.each(all)("%s is refused from every sender the role table does not allow", (type, { message }) => {
    const row = ROLE_TABLE[type]!;
    for (const sender of senders) {
      if (row[sender]) continue;
      const decoded = refused(json(message), sender);
      expect(decoded.reason).toBe("role");
      expect(decoded.bye).toMatchObject({ t: "bye", reason: "role" });
      const encoded = encodeFrame(message, sender, local);
      expect(encoded.ok).toBe(false);
    }
  });

  it("follows §5.4 for the main rows", () => {
    const may = (type: string, sender: Sender) => roleRefusal(type, sender, remote) === null;
    expect([may("hello", "fe"), may("hello", "server"), may("hello", "peer")]).toEqual([true, false, true]);
    expect([may("welcome", "fe"), may("welcome", "server")]).toEqual([false, true]);
    expect([may("cmd", "fe"), may("cmd", "server"), may("cmd", "peer")]).toEqual([true, false, true]);
    expect([may("cmd.result", "fe"), may("cmd.retry", "fe"), may("held", "fe"), may("batch", "fe"), may("reset", "fe"), may("snap", "fe")]).toEqual([false, false, false, false, false, false]);
    expect([may("live", "fe"), may("live.resync", "fe"), may("live", "server"), may("live.resync", "server")]).toEqual([false, true, true, false]);
    expect([may("sub", "server"), may("ack", "server"), may("history", "server")]).toEqual([false, false, false]);
    expect([may("peer", "server"), may("peer", "peer"), may("roster.revocations", "fe"), may("roster.revocations", "peer")]).toEqual([true, false, false, true]);
    expect([may("ping", "fe"), may("ping", "server"), may("bye", "peer")]).toEqual([true, true, true]);
  });

  it("keeps local-socket messages off other sessions", () => {
    // `req`/`res` are open to remote front ends since M2 (brief Q2; protocol-m2.test.ts).
    for (const type of ["content.find", "content.found", "content.open", "content.file", "shell.screenshot", "shell.browser", "shell.install", "shell.quit", "shell.done"] as const) {
      const { message, sender } = samples[type];
      expect(refused(json(message), sender, remote).reason, type).toBe("role");
      expect(refused(json(message), "peer", local).reason, type).toBe("role");
    }
  });

  it("refuses a scope stated by a front end, takes one from a peer", () => {
    const withScope = { ...samples.cmd.message, scope: "local" };
    expect(refused(json(withScope), "fe").reason).toBe("role");
    const peer = decodeFrame(json({ ...withScope, scope: "reply" }), "peer", remote);
    expect(peer.ok).toBe(true);
  });

  it("refuses messages without a schema as unsupported and pair.* outside a pairing session", () => {
    // M2 gave the content path a schema; prefs.* and fetch.* (M3/M5) still have none.
    const prefs = refused(json({ t: "prefs.have", digest: hash("a") }), "peer");
    expect(prefs.reason).toBe("unsupported");
    expect(prefs.bye.reason).toBe("role");
    expect(refused(json({ t: "pair.hello" }), "fe").reason).toBe("role");
    expect(refused(json({ t: "pair.join" }), "fe", { local: false, pairing: true }).reason).toBe("unsupported");
    expect(refused(json(samples.sub.message), "fe", { local: false, pairing: true }).reason).toBe("role");
    expect(decodeFrame(json(samples.ping.message), "fe", { local: false, pairing: true }).ok).toBe(true);
  });
});

describe("protocol v1: malformed frames are refused", () => {
  const bad: [string, unknown][] = [
    ["an array", [1, 2]],
    ["null", null],
    ["no t", { stream }],
    ["an empty t", { t: "" }],
    ["an unknown t", { t: "nope" }],
    ["a t from the prototype", { t: "toString" }],
    ["an extra field", { ...samples.sub.message, extra: 1 }],
    ["a missing field", { t: "ack", stream }],
    ["a stream that is not bot: or srv:", { ...samples.sub.message, stream: "x:1" }],
    ["a bad logId", { ...samples.ack.message, cursor: { logId: "short", seq: 1 } }],
    ["a negative seq", { ...samples.ack.message, cursor: { logId: logA, seq: -1 } }],
    ["a fractional seq", { ...samples.ack.message, cursor: { logId: logA, seq: 1.5 } }],
    ["slot n = 0", { ...samples.cancel.message, slot: { ...slot, n: 0 } }],
    ["a bad origin epoch", { ...samples.cancel.message, slot: { ...slot, originEpoch: "XYZ" } }],
    ["floor above n", { ...samples.cmd.message, floor: 4 }],
    ["a cmd without inc", { ...samples.cmd.message, inc: undefined }],
    ["a cmd with an unknown command", { ...samples.cmd.message, cmd: { type: "chat.nope", botId: bot } }],
    ["a cmd whose command is malformed", { ...samples.cmd.message, cmd: { type: "chat.send", botId: bot } }],
    ["a cmd.result without logId", { ...samples["cmd.result"].message, logId: undefined }],
    ["an applied cmd.result without seq", { ...samples["cmd.result"].message, seq: null }],
    ["an unknown refuse reason", { ...samples["cmd.result"].message, outcome: { kind: "refused", reason: "nope" } }],
    ["a batch with a gap", { ...samples.batch.message, to: entries.length + 1 }],
    ["a batch entry of another logId", { ...samples.batch.message, entries: [{ ...entries[0], logId: logB }, ...entries.slice(1)] }],
    ["a batch entry out of order", { ...samples.batch.message, entries: [entries[1], entries[0], ...entries.slice(2)] }],
    ["an empty batch", { ...samples.batch.message, entries: [], to: 0 }],
    ["a turn.delta entry", { ...samples.batch.message, to: 1, entries: [entry(1, "turn.delta", { botId: bot, turnId: "t", messageId: "m", text: "x" })] }],
    ["an entry of an unknown kind", { ...samples.batch.message, to: 1, entries: [entry(1, "made.up", {})] }],
    ["an entry body that does not match its kind", { ...samples.batch.message, to: 1, entries: [entry(1, "turn.queued", { botId: bot })] }],
    ["an entry body that repeats its kind", { ...samples.batch.message, to: 1, entries: [entry(1, "turn.cancelled", { type: "turn.cancelled", botId: bot, turnId: "t" })] }],
    ["an entry without hash", { ...samples.batch.message, to: 1, entries: [{ ...entries[0], hash: undefined }] }],
    ["an entry with a bad hash", { ...samples.batch.message, to: 1, entries: [{ ...entries[0], hash: "zz" }] }],
    ["a skip from above to", { ...samples.batch.message, to: 1, entries: [entry(1, "cmd.skipped", { origin: "desktop", originEpoch: epoch, target: stream, from: 5, to: 4 })] }],
    ["a reset that retires its own logId", { ...samples.reset.message, retired: [{ logId: logB, keptSeq: 1 }] }],
    ["a reset with nothing retired", { ...samples.reset.message, retired: [] }],
    ["a hello with another protocol", { ...samples.hello.message, protocol: 2 }],
    ["a welcome with min above max", { ...samples.welcome.message, protocol: { min: 2, max: 1 } }],
    ["a content.open without the entry", { ...samples["content.open"].message, entry: undefined }],
    ["a content id that is not sha256", { ...samples["content.open"].message, id: "md5:00" }],
    ["a pending id that is not 32 hex digits", { ...samples["content.open"].message, id: "pending:xyz" }],
    ["chunk hashes that are not base64", { ...samples["content.file"].message, chunkHashes: "not base64!" }],
    ["a res that is ok and has an error", { t: "res", req: "r", ok: true, error: { code: "internal", message: "x" } }],
    ["an unknown bye reason", { t: "bye", reason: "because" }],
  ];

  it.each(bad)("refuses %s", (_name, value) => {
    const sender: Sender = (value as { t?: string } | null)?.t && Object.hasOwn(samples, (value as { t: string }).t) ? (samples as Record<string, { sender: Sender }>)[(value as { t: string }).t]!.sender : "fe";
    const decoded = refused(json(value), sender);
    expect(decoded.reason).toBe("malformed");
    expect(decoded.bye).toMatchObject({ t: "bye", reason: "malformed" });
  });

  it("refuses text that is not JSON and bytes that are not UTF-8", () => {
    expect(refused("{t: 'ping'}", "fe").reason).toBe("malformed");
    expect(refused("", "fe").reason).toBe("malformed");
    expect(refused(new Uint8Array([0x7b, 0xff, 0x7d]), "fe").reason).toBe("malformed");
  });

  it("refuses a frame above 256 KiB, on decode and encode", () => {
    const big = { t: "live", stream, turnId: "t1", seg: 0, rev: 0, at: 0, text: "é".repeat(140_000) };
    expect(json(big).length).toBeLessThan(FRAME_LIMIT);
    expect(refused(json(big), "server").reason).toBe("too-large");
    expect(refused(new Uint8Array(FRAME_LIMIT + 1), "server").reason).toBe("too-large");
    expect(encodeFrame(big as Message, "server", local)).toMatchObject({ ok: false, reason: "too-large" });
    expect(() => packFrame("x".repeat(FRAME_LIMIT + 1))).toThrow(RangeError);
  });

  it("stops a byte stream for good at a length above the limit", () => {
    const splitter = new FrameSplitter();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, FRAME_LIMIT + 1, false);
    expect(splitter.push(header).ok).toBe(false);
    expect(splitter.push(packFrame(json(samples.ping.message))).ok).toBe(false);
  });

  it("refuses to encode a malformed message", () => {
    expect(encodeFrame({ ...samples.cmd.message, floor: 9 } as Message, "fe", local)).toMatchObject({ ok: false, reason: "malformed" });
  });
});
